// CommitController（Maximo への反映）の試験。
// 例 (a) を最後まで（依頼 → 実行 → カナリア → verified → 差分が消える）、カナリア中止、
// 読み込み後に Maximo 側が変わったときの conflict、I3 / I10 の確認、run 中の BUSY、書き込みログを確かめる。

import { describe, expect, it, vi } from "vitest";
import { ObjectStructureCatalog } from "../../src/app/catalog/catalog";
import { diffReportSheets } from "../../src/app/commit/diffReport";
import { createCommitController, noChangesBlocker, notConnectedBlocker, notMaximoSheetBlocker, PANEL_REFRESH_MS } from "../../src/app/commit/controller";
import { MaximoClient } from "../../src/app/maximo/client";
import type { StatusPrefs } from "../../src/app/maximo/statusPrefs";
import { RelayToolError, type ToolContext } from "../../src/app/relay";
import type { MaximoConnection } from "../../src/app/runtime/contracts";
import { JobRegistry, Workspace } from "../../src/app/store";
import { createToolRegistry } from "../../src/app/tools/registry";
import type { CellValue, ColumnSchema } from "../../src/shared/model";
import { RelayErrorCode, type InvokeMsg } from "../../src/shared/protocol";
import { makeChildRowKey, makeParentKey, type MaximoRecord, type SheetMeta, type SheetRow } from "../../src/shared/sheet";
import type { ToolName } from "../../src/shared/toolDefs";
import { createFakeMaximo, sampleSeed, type FakeMaximo, type FakeRecordSeed, type FakeSeed } from "../fakes/fake-maximo";

const APP_URL = "https://mxstage.test/app";
const PERMIT_SHEET = "許可申請";
const NEW_DATE = "2027-03-31";
const SELECT = [
  "WONUM",
  "SITEID",
  "STATUS",
  "DESCRIPTION",
  "EXT_WOPERMIT.EXT_AUTHORITY",
  "EXT_WOPERMIT.EXT_PERMITTYPE",
  "EXT_WOPERMIT.EXT_PERMITDATE",
  "EXT_WOPERMIT.EXT_MEMO",
];

const pk = (wonum: string) => makeParentKey(["BEDFORD", wonum]);
const ck = (wonum: string, id: CellValue) => makeChildRowKey(pk(wonum), "EXT_WOPERMIT", id);

/** 子 ID: 1001（WO2001 消防/届出）、1002（WO2001 労基/申請）、1003（WO2002 県/届出）、1004（WO2003 未完了） */
function permitSeed(extra: FakeRecordSeed[] = []): FakeSeed {
  return sampleSeed({
    woRecords: [
      {
        attrs: { siteid: "BEDFORD", wonum: "WO2001", description: "消防設備点検", status: "COMP" },
        children: {
          ext_wopermit: [
            { ext_authority: "消防", ext_permittype: "届出", ext_permitdate: "2026-04-01", ext_memo: "m1" },
            { ext_authority: "労基", ext_permittype: "申請", ext_permitdate: "2026-04-02", ext_memo: "m2" },
          ],
        },
      },
      {
        attrs: { siteid: "BEDFORD", wonum: "WO2002", description: "高圧ガス保安", status: "COMP" },
        children: { ext_wopermit: [{ ext_authority: "県", ext_permittype: "届出", ext_permitdate: "2026-05-01", ext_memo: "m3" }] },
      },
      {
        attrs: { siteid: "BEDFORD", wonum: "WO2003", description: "未完了の申請", status: "WAPPR" },
        children: { ext_wopermit: [{ ext_authority: "消防", ext_permittype: "届出", ext_permitdate: "2026-06-01" }] },
      },
      ...extra,
    ],
  });
}

function harness(seed: FakeSeed = permitSeed(), opts: { statusPrefs?: StatusPrefs } = {}) {
  const fake = createFakeMaximo(seed);
  const client = new MaximoClient({ baseUrl: fake.baseUrl, apiKey: () => fake.apiKey, via: "direct", fetchImpl: fake.fetch, sleep: async () => {} });
  const maximo: MaximoConnection = {
    info: { baseUrl: fake.baseUrl, via: "direct", connectionName: "MAXADMIN@test", userName: "MAXADMIN", connectedAt: 1_700_000_000_000 },
    client,
  };
  let current: MaximoConnection | null = maximo;
  const listeners = new Set<() => void>();
  const connection = {
    current: () => current,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set(on: boolean) {
      current = on ? maximo : null;
      for (const l of Array.from(listeners)) l();
    },
  };
  const workspace = new Workspace("作業");
  const jobs = new JobRegistry();
  const controller = createCommitController({ workspace, connection });
  const registry = createToolRegistry({ workspace, jobs, connection, commits: controller, catalog: new ObjectStructureCatalog(), appVersion: "0.1.0-test", appUrl: APP_URL, ...opts });
  let seq = 0;

  async function invoke(tool: string, args: unknown) {
    const msg: InvokeMsg = {
      type: "tool.invoke",
      id: `call${++seq}`,
      tool: tool as ToolName,
      args,
      deadlineAt: Date.now() + 30_000,
      timeoutMs: 30_000,
      idempotencyKey: "",
      readOnly: false,
    };
    const ctx: ToolContext = { signal: new AbortController().signal, progress: () => {} };
    return registry.handler(msg, ctx);
  }

  async function call(tool: string, args: unknown = {}): Promise<Record<string, any>> {
    const out = await invoke(tool, args);
    return out.result.structuredContent as Record<string, any>;
  }

  async function fail(tool: string, args: unknown = {}): Promise<RelayToolError> {
    try {
      await invoke(tool, args);
    } catch (e) {
      expect(e).toBeInstanceOf(RelayToolError);
      return e as RelayToolError;
    }
    throw new Error(`${tool} が失敗しませんでした`);
  }

  return { fake, workspace, jobs, connection, controller, call, fail };
}

type Harness = ReturnType<typeof harness>;

const loadPermits = (h: Harness) =>
  h.call("load_sheet", { name: PERMIT_SHEET, os: "MXAPIWO", select: SELECT, where: [{ attr: "STATUS", op: "eq", value: "COMP" }] });

/** 例 (a): 完了済み WO の「届出」の申請完了日だけを変更した状態にする */
async function prepared(seed?: FakeSeed): Promise<Harness> {
  const h = harness(seed ?? permitSeed());
  await loadPermits(h);
  const res = await h.call("apply_rule", {
    sheet: PERMIT_SHEET,
    filter: [{ attr: "EXT_WOPERMIT.EXT_PERMITTYPE", op: "eq", value: "届出" }],
    set: { "EXT_WOPERMIT.EXT_PERMITDATE": { const: NEW_DATE } },
    baseRevision: h.workspace.revision,
    reason: "完了済み許可申請の申請完了日を変更",
  });
  expect(res.applied).toBe(2);
  h.fake.state.requests.length = 0;
  return h;
}

function childAttrs(fake: FakeMaximo): Record<string, Record<string, CellValue>> {
  const out: Record<string, Record<string, CellValue>> = {};
  for (const r of fake.records("mxapiwo")) {
    for (const c of r.children.ext_wopermit ?? []) out[String(c.attrs.ext_wopermitid)] = { ...c.attrs };
  }
  return out;
}

const parentAttrs = (fake: FakeMaximo) => fake.records("mxapiwo").map((r) => ({ ...r.attrs }));
const uidOf = (fake: FakeMaximo, wonum: string) => fake.find("mxapiwo", (r) => r.attrs.wonum === wonum)!.uid;
const posts = (fake: FakeMaximo) => fake.state.requests.filter((r) => r.method === "POST");
const untilCanary = (h: Harness) => vi.waitFor(() => expect(h.controller.panel(PERMIT_SHEET).awaitingCanary).not.toBeNull(), { timeout: 5_000, interval: 5 });

// ---------------------------------------------------------------------------

describe("CommitController: 例 (a) を最後まで", () => {
  it("依頼 → 実行 → カナリア続行 → verified で、申請完了日だけが変わり差分が消える", async () => {
    const h = await prepared();
    const beforeChildren = childAttrs(h.fake);
    const beforeParents = parentAttrs(h.fake);
    const wo2003Rowstamp = h.fake.find("mxapiwo", (r) => r.attrs.wonum === "WO2003")!.rowstamp;

    const req = h.controller.request(PERMIT_SHEET, "完了済み許可申請 2 件の申請完了日を変更", "llm");
    expect(req).toMatchObject({ state: "requested", blockers: [], needsDeleteConfirm: false, needsNullConfirm: false, requestedBy: "llm" });
    expect(req.counts).toEqual({ parents: 2, changedCells: 2, addedRows: 0, deletedRows: 0, newRecords: 0 });

    const running = h.controller.run(PERMIT_SHEET, {});
    await untilCanary(h);
    const mid = h.controller.panel(PERMIT_SHEET);
    expect(mid.state).toBe("running");
    expect(h.controller.isRunning(PERMIT_SHEET)).toBe(true);
    expect(mid.awaitingCanary).toMatchObject({ rowKey: pk("WO2001"), status: "verified" });
    expect(mid.results).toHaveLength(1);
    expect(posts(h.fake)).toHaveLength(1);

    h.controller.continueCanary(PERMIT_SHEET, true);
    const done = await running;
    expect(done.state).toBe("done");
    expect(done.results.map((r) => r.status)).toEqual(["verified", "verified"]);
    expect(done.awaitingCanary).toBeNull();
    expect(done.finishedAt).toBeGreaterThanOrEqual(done.startedAt!);
    expect(h.controller.isRunning(PERMIT_SHEET)).toBe(false);

    // 反映済みの変更は作業画面から消え、base が Maximo の新しい値になる
    expect(h.workspace.getDiff(PERMIT_SHEET).changedCells).toBe(0);
    expect(h.controller.panel(PERMIT_SHEET).blockers).toContain(noChangesBlocker());
    const sheet = h.workspace.getSheet(PERMIT_SHEET);
    expect(sheet.rowKeys("final")).toEqual([ck("WO2001", 1001), ck("WO2001", 1002), ck("WO2002", 1003)]);
    expect(sheet.rowValues(ck("WO2001", 1001), "base")!["EXT_WOPERMIT.EXT_PERMITDATE"]).toBe(NEW_DATE);
    expect(sheet.rowValues(ck("WO2002", 1003), "base")!["EXT_WOPERMIT.EXT_PERMITDATE"]).toBe(NEW_DATE);
    expect(sheet.rowValues(ck("WO2001", 1002), "base")!["EXT_WOPERMIT.EXT_PERMITDATE"]).toBe("2026-04-02");

    // Maximo 側は申請完了日だけが変わる（他の属性・他の子・他の WO は不変）
    expect(childAttrs(h.fake)).toEqual({
      ...beforeChildren,
      "1001": { ...beforeChildren["1001"], ext_permitdate: NEW_DATE },
      "1003": { ...beforeChildren["1003"], ext_permitdate: NEW_DATE },
    });
    expect(parentAttrs(h.fake)).toEqual(beforeParents);
    expect(h.fake.find("mxapiwo", (r) => r.attrs.wonum === "WO2003")!.rowstamp).toBe(wo2003Rowstamp);

    // PATCH + MERGE で、変えた属性だけを送る
    const sent = posts(h.fake);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers["x-method-override"]).toBe("PATCH");
    expect(sent[0]!.headers.patchtype).toBe("MERGE");
    expect(sent.map((p) => p.body)).toEqual([
      { ext_wopermit: [{ ext_wopermitid: 1001, ext_permitdate: NEW_DATE, _action: "Change" }] },
      { ext_wopermit: [{ ext_wopermitid: 1003, ext_permitdate: NEW_DATE, _action: "Change" }] },
    ]);

    // 書き込みログはキーと結果だけ（属性値を含めない）
    const log = h.controller.writeLog();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ parentKey: pk("WO2001"), result: "verified", ops: { change: 1, delete: 0, add: 0, attrs: ["EXT_WOPERMIT.EXT_PERMITDATE"] } });
    const csv = h.controller.writeLogCsv();
    expect(csv.split("\r\n")[0]).toBe("at,parentKey,transactionId,change,delete,add,attrs,httpStatus,reasonCode,result");
    for (const value of [NEW_DATE, "2026-04-01", "消防", "m1", "届出"]) expect(csv).not.toContain(value);
  });

  it("差分レポート用に、反映した回の差分の写しとその回の書き込みログが残る（反映の後に差分が消えても）", async () => {
    const h = await prepared();
    expect(h.controller.lastRun(PERMIT_SHEET)).toBeNull();
    h.controller.request(PERMIT_SHEET, "申請完了日を変更", "llm");
    const running = h.controller.run(PERMIT_SHEET, {});
    await untilCanary(h);
    // 実行中は終わっていない（endRevision が null）
    expect(h.controller.lastRun(PERMIT_SHEET)!.endRevision).toBeNull();
    h.controller.continueCanary(PERMIT_SHEET, true);
    await running;

    expect(h.workspace.getDiff(PERMIT_SHEET).changedCells).toBe(0);
    const last = h.controller.lastRun(PERMIT_SHEET)!;
    expect(last.endRevision).toBe(h.workspace.revision);
    expect(last.snapshot.changedCells).toBe(2);
    expect(last.snapshot.entries.map((e) => e.after)).toEqual([NEW_DATE, NEW_DATE]);
    expect(last.snapshot.panel).toMatchObject({ note: "申請完了日を変更", requestedBy: "llm", counts: { parents: 2, changedCells: 2 } });
    expect(last.log.map((e) => [e.parentKey, e.result])).toEqual([
      [pk("WO2001"), "verified"],
      [pk("WO2002"), "verified"],
    ]);
    const sheets = diffReportSheets({ snapshot: last.snapshot, writeLog: last.log });
    expect(sheets.map((x) => x.rows.length)).toEqual([expect.any(Number), 3, 3]);

    // 次の反映は前の回を置き換え、ログも混ざらない
    const edits = [
      { rowKey: ck("WO2001", 1002), col: "EXT_WOPERMIT.EXT_PERMITDATE", value: NEW_DATE },
      { rowKey: ck("WO2002", 1003), col: "EXT_WOPERMIT.EXT_MEMO", value: "m3 (2)" },
    ];
    h.workspace.applyEdits(PERMIT_SHEET, edits, { author: "user" });
    const second = h.controller.run(PERMIT_SHEET, {});
    await untilCanary(h);
    h.controller.continueCanary(PERMIT_SHEET, true);
    await second;
    const again = h.controller.lastRun(PERMIT_SHEET)!;
    expect(again.snapshot.changedCells).toBe(2);
    expect(again.log.map((e) => e.parentKey)).toEqual([pk("WO2001"), pk("WO2002")]);
    expect(h.controller.writeLog()).toHaveLength(4);
  });

  it("カナリアで続行しなければ残りは skipped になり、その親の変更は作業画面に残る", async () => {
    const h = await prepared();
    const running = h.controller.run(PERMIT_SHEET, {});
    await untilCanary(h);
    h.controller.continueCanary(PERMIT_SHEET, false);
    const done = await running;
    expect(done.results.map((r) => r.status)).toEqual(["verified", "skipped"]);
    expect(posts(h.fake)).toHaveLength(1);
    expect(childAttrs(h.fake)["1003"]!.ext_permitdate).toBe("2026-05-01");
    const diff = h.workspace.getDiff(PERMIT_SHEET);
    expect(diff.changedCells).toBe(1);
    expect(diff.entries[0]!.rowKey).toBe(ck("WO2002", 1003));
    expect(h.controller.panel(PERMIT_SHEET).counts.parents).toBe(1);
  });

  it("反映中はそのシートの編集系ツールが BUSY になる", async () => {
    const h = await prepared();
    const running = h.controller.run(PERMIT_SHEET, {});
    await untilCanary(h);
    const patch = await h.fail("patch_cells", {
      sheet: PERMIT_SHEET,
      edits: [{ rowKey: ck("WO2001", 1001), col: "EXT_WOPERMIT.EXT_MEMO", value: "x" }],
      baseRevision: h.workspace.revision,
      reason: "x",
    });
    expect(patch.code).toBe(RelayErrorCode.BUSY);
    expect((await h.fail("request_commit", { sheet: PERMIT_SHEET, note: "x" })).code).toBe(RelayErrorCode.BUSY);
    h.controller.continueCanary(PERMIT_SHEET, true);
    await running;
    const result = await h.call("get_commit_result", { sheet: PERMIT_SHEET });
    expect(result.state).toBe("done");
    expect(result.resultCounts).toEqual({ verified: 2 });
    expect(result.results).toHaveLength(2);
  });
});

describe("CommitController: 読み込み後に Maximo 側が変わった場合", () => {
  it("親の _rowstamp が変わっていれば送らずに conflict にし、その親の変更を残す", async () => {
    const h = await prepared();
    h.fake.update("mxapiwo", uidOf(h.fake, "WO2001"), (r) => {
      r.attrs.description = "他の人の更新";
    });
    const done = await h.controller.run(PERMIT_SHEET, {});
    expect(done.results.map((r) => r.status)).toEqual(["conflict", "verified"]);
    expect(done.state).toBe("failed");
    expect(done.results[0]!.message).toContain("_rowstamp");
    expect(childAttrs(h.fake)["1001"]!.ext_permitdate).toBe("2026-04-01");
    expect(childAttrs(h.fake)["1003"]!.ext_permitdate).toBe(NEW_DATE);
    const diff = h.workspace.getDiff(PERMIT_SHEET);
    expect(diff.changedCells).toBe(1);
    expect(diff.entries[0]!.rowKey).toBe(ck("WO2001", 1001));
  });

  it("子だけが更新された（親の _rowstamp は同じ）場合も conflict にする", async () => {
    const h = await prepared();
    h.fake.update(
      "mxapiwo",
      uidOf(h.fake, "WO2001"),
      (r) => {
        const child = r.children.ext_wopermit![0]!;
        child.attrs.ext_memo = "他の人のメモ";
        child.rowstamp = 999_999;
      },
      { bumpRowstamp: false },
    );
    const done = await h.controller.run(PERMIT_SHEET, {});
    expect(done.results[0]).toMatchObject({ rowKey: pk("WO2001"), status: "conflict" });
    expect(done.results[0]!.message).toContain("子");
    expect(childAttrs(h.fake)["1001"]!.ext_permitdate).toBe("2026-04-01");
  });

  it("反映中に作業画面で変更された親は、verified でも作業画面の値を置き換えない", async () => {
    const h = await prepared();
    const running = h.controller.run(PERMIT_SHEET, {});
    await untilCanary(h);
    // 利用者がグリッドで直接編集した
    h.workspace.applyEdits(PERMIT_SHEET, [{ rowKey: ck("WO2001", 1001), col: "EXT_WOPERMIT.EXT_MEMO", value: "手入力" }], { author: "user" });
    h.controller.continueCanary(PERMIT_SHEET, true);
    const done = await running;
    expect(done.results[0]).toMatchObject({ rowKey: pk("WO2001"), status: "verified" });
    expect(done.results[0]!.message).toContain("反映中に作業画面で変更された");
    expect(h.workspace.cell(PERMIT_SHEET, ck("WO2001", 1001), "EXT_WOPERMIT.EXT_MEMO")!.value).toBe("手入力");
    // 変更されなかった親は置き換わる
    expect(h.workspace.getSheet(PERMIT_SHEET).rowValues(ck("WO2002", 1003), "base")!["EXT_WOPERMIT.EXT_PERMITDATE"]).toBe(NEW_DATE);
  });
});

describe("CommitController: 人の確認と blockers", () => {
  it("削除が上限を超えると needsDeleteConfirm になり、確認付きのときだけ実行する（I3）", async () => {
    const many: FakeRecordSeed = {
      attrs: { siteid: "BEDFORD", wonum: "WO3001", description: "申請が多い WO", status: "COMP" },
      children: {
        ext_wopermit: Array.from({ length: 12 }, (_, i) => ({ ext_authority: `許可${i}`, ext_permittype: "届出", ext_permitdate: "2026-04-01" })),
      },
    };
    const h = harness(permitSeed([many]));
    await loadPermits(h);
    const rowKeys = h.workspace
      .getSheet(PERMIT_SHEET)
      .rowKeys("final")
      .filter((k) => k.startsWith(`${pk("WO3001")}#`))
      .slice(0, 11);
    expect(rowKeys).toHaveLength(11);
    const del = await h.call("delete_rows", { sheet: PERMIT_SHEET, rowKeys, baseRevision: h.workspace.revision, reason: "重複した申請を削除" });
    expect(del.applied).toBe(11);

    const panel = h.controller.panel(PERMIT_SHEET);
    expect(panel.needsDeleteConfirm).toBe(true);
    expect(panel.blockers).toEqual([]);
    expect((await h.controller.run(PERMIT_SHEET, {})).state).toBe("idle");
    expect(h.fake.writeCount()).toBe(0);

    const done = await h.controller.run(PERMIT_SHEET, { deletesConfirmed: true });
    expect(done.state).toBe("done");
    expect(done.results.map((r) => r.status)).toEqual(["verified"]);
    expect(h.fake.find("mxapiwo", (r) => r.attrs.wonum === "WO3001")!.children.ext_wopermit).toHaveLength(1);
    expect(h.workspace.getDiff(PERMIT_SHEET).deletedRows).toBe(0);
    expect(h.controller.writeLog()[0]).toMatchObject({ parentKey: pk("WO3001"), ops: { change: 0, delete: 11, add: 0 }, result: "verified" });
  });

  it("null への変更は needsNullConfirm になり、allowNull のときだけ実行する（I10）", async () => {
    const h = harness();
    await loadPermits(h);
    await h.call("patch_cells", {
      sheet: PERMIT_SHEET,
      edits: [{ rowKey: ck("WO2001", 1001), col: "EXT_WOPERMIT.EXT_MEMO", value: null }],
      baseRevision: h.workspace.revision,
      reason: "メモを消す",
    });
    const panel = h.controller.panel(PERMIT_SHEET);
    expect(panel.needsNullConfirm).toBe(true);
    expect(panel.blockers).toEqual([]);
    expect((await h.controller.run(PERMIT_SHEET, {})).state).toBe("idle");
    expect(h.fake.writeCount()).toBe(0);

    const done = await h.controller.run(PERMIT_SHEET, { allowNull: true });
    expect(done.results.map((r) => r.status)).toEqual(["verified"]);
    expect(childAttrs(h.fake)["1001"]!.ext_memo).toBeNull();
    expect(childAttrs(h.fake)["1002"]!.ext_memo).toBe("m2");
    expect(h.workspace.getDiff(PERMIT_SHEET).changedCells).toBe(0);
  });

  it("未接続・変更なし・Excel シートは blockers になり、run しても書き込まない", async () => {
    const h = await prepared();
    h.connection.set(false);
    const panel = h.controller.panel(PERMIT_SHEET);
    expect(panel.blockers).toContain(notConnectedBlocker());
    expect((await h.controller.run(PERMIT_SHEET, {})).state).toBe("idle");
    expect(h.fake.writeCount()).toBe(0);

    h.connection.set(true);
    const meta: SheetMeta = {
      name: "参照",
      source: { kind: "excel", importId: "imp1", fileName: "f.xlsx", sheetName: "Sheet1", headerRow: 1 },
      columns: [{ name: "TAG", type: "string" } satisfies ColumnSchema],
      keyColumns: ["TAG"],
      childIdAttrs: {},
    };
    const rows: SheetRow[] = [{ rowKey: makeParentKey(["T1"]), parentKey: makeParentKey(["T1"]), childName: null, values: { TAG: "T1" } }];
    h.workspace.createSheet(meta, rows);
    expect(h.controller.panel("参照").blockers).toContain(notMaximoSheetBlocker());
    expect((await h.controller.run("参照", {})).state).toBe("idle");

    // 変更をすべて元の値に戻すと、反映する変更が無くなる
    h.workspace.applyEdits(
      PERMIT_SHEET,
      [
        { rowKey: ck("WO2001", 1001), col: "EXT_WOPERMIT.EXT_PERMITDATE", value: "2026-04-01" },
        { rowKey: ck("WO2002", 1003), col: "EXT_WOPERMIT.EXT_PERMITDATE", value: "2026-05-01" },
      ],
      { author: "user" },
    );
    expect(h.workspace.getDiff(PERMIT_SHEET).changedCells).toBe(0);
    expect(h.controller.panel(PERMIT_SHEET).blockers).toContain(noChangesBlocker());
  });

  it("作業内容の変更は間引いて通知し、依頼はすぐ通知する", () => {
    vi.useFakeTimers();
    try {
      const workspace = new Workspace("作業");
      const controller = createCommitController({ workspace, connection: { current: () => null, subscribe: () => () => {} } });
      const meta: SheetMeta = {
        name: "メモ",
        source: { kind: "excel", importId: "imp1", fileName: "f.xlsx", sheetName: "Sheet1", headerRow: 1 },
        columns: [
          { name: "ID", type: "string" },
          { name: "TEXT", type: "string" },
        ],
        keyColumns: ["ID"],
        childIdAttrs: {},
      };
      const key = makeParentKey(["r1"]);
      workspace.createSheet(meta, [{ rowKey: key, parentKey: key, childName: null, values: { ID: "r1", TEXT: "a" } }]);
      const seen: string[] = [];
      controller.subscribe((sheet) => seen.push(sheet));
      for (const v of ["1", "2", "3"]) workspace.applyEdits("メモ", [{ rowKey: key, col: "TEXT", value: v }], { author: "user" });
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(PANEL_REFRESH_MS);
      expect(seen).toEqual(["メモ"]);
      controller.request("メモ", "反映してください", "user");
      expect(seen).toEqual(["メモ", "メモ"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CommitController: 送信前の検査で止まった場合", () => {
  it("1 件も書き込めなかったときは done にせず failed にする", async () => {
    const fake = createFakeMaximo(permitSeed());
    const client = new MaximoClient({ baseUrl: fake.baseUrl, apiKey: () => fake.apiKey, via: "direct", fetchImpl: fake.fetch, sleep: async () => {} });
    const conn: MaximoConnection = {
      info: { baseUrl: fake.baseUrl, via: "direct", connectionName: "MAXADMIN@test", userName: "MAXADMIN", connectedAt: 1_700_000_000_000 },
      client,
    };
    const workspace = new Workspace("作業");
    const controller = createCommitController({ workspace, connection: { current: () => conn, subscribe: () => () => {} } });
    const meta: SheetMeta = {
      name: "WO",
      source: { kind: "maximo", os: "MXAPIWO", select: ["SITEID", "WONUM", "DESCRIPTION"], where: [] },
      columns: [
        { name: "SITEID", type: "string" },
        { name: "WONUM", type: "string" },
        { name: "DESCRIPTION", type: "string" },
      ] satisfies ColumnSchema[],
      keyColumns: ["SITEID", "WONUM"],
      childIdAttrs: {},
    };
    // Maximo が返した href が送信先にできない形（パスパラメータ付き）。計画は作れるが送信前の検査で止まる
    const record: MaximoRecord = {
      href: `${fake.baseUrl}/maximo/api/os/mxapiwo/_R1;jsessionid=abc`,
      rowstamp: "1",
      attrs: { SITEID: "BEDFORD", WONUM: "WO1", DESCRIPTION: "元の値" },
      children: {},
    };
    const key = makeParentKey(["BEDFORD", "WO1"]);
    const rows: SheetRow[] = [{ rowKey: key, parentKey: key, childName: null, values: { SITEID: "BEDFORD", WONUM: "WO1", DESCRIPTION: "元の値" } }];
    workspace.createSheet(meta, rows, [record]);
    workspace.applyEdits("WO", [{ rowKey: key, col: "DESCRIPTION", value: "変更" }], { author: "llm" });
    expect(controller.panel("WO").blockers).toEqual([]);

    const done = await controller.run("WO", {});
    expect(fake.writeCount()).toBe(0);
    expect(done.results.map((r) => r.status)).toEqual(["skipped"]);
    expect(done.results[0]!.message).toContain("送らなかった");
    // 1 件も書き込めていないので「完了」に見せない
    expect(done.state).toBe("failed");
    // 変更は作業画面に残る
    expect(workspace.getDiff("WO").changedCells).toBe(1);
  });
});

describe("CommitController: 新規作成", () => {
  it("add_rows で足した親と子を作り、作ったレコードを Maximo から読み直してシートの base にする", async () => {
    const h = harness();
    await loadPermits(h);
    const parent = await h.call("add_rows", {
      sheet: PERMIT_SHEET,
      rows: [{ SITEID: "BEDFORD", WONUM: "WO2100", DESCRIPTION: "新しい許可申請" }],
      baseRevision: h.workspace.revision,
      reason: "新しい作業指示を登録",
    });
    expect(parent.applied).toBe(1);
    const child = await h.call("add_rows", {
      sheet: PERMIT_SHEET,
      parentRowKey: pk("WO2100"),
      rows: [{ "EXT_WOPERMIT.EXT_AUTHORITY": "消防", "EXT_WOPERMIT.EXT_PERMITTYPE": "届出" }],
      baseRevision: h.workspace.revision,
      reason: "許可申請を足す",
    });
    expect(child.applied).toBe(1);
    h.fake.state.requests.length = 0;

    const req = h.controller.request(PERMIT_SHEET, "新しい作業指示 1 件", "llm");
    expect(req.blockers).toEqual([]);
    expect(req.counts).toMatchObject({ parents: 1, newRecords: 1, addedRows: 2 });
    const done = await h.controller.run(PERMIT_SHEET, {});
    expect(done.state).toBe("done");
    expect(done.results).toMatchObject([{ rowKey: pk("WO2100"), status: "verified" }]);

    const rec = h.fake.find("mxapiwo", (r) => r.attrs.wonum === "WO2100")!;
    expect(rec.attrs).toMatchObject({ siteid: "BEDFORD", description: "新しい許可申請" });
    expect(rec.children.ext_wopermit?.map((c) => c.attrs.ext_authority)).toEqual(["消防"]);
    const [post] = posts(h.fake);
    expect(post!.path).toBe("/maximo/api/os/mxapiwo?lean=1");

    // 作ったレコードは Maximo の値（子の ID も）で base になり、差分が消える
    expect(h.workspace.getDiff(PERMIT_SHEET)).toMatchObject({ changedCells: 0, addedRows: 0, deletedRows: 0 });
    const sheet = h.workspace.getSheet(PERMIT_SHEET);
    const id = rec.children.ext_wopermit![0]!.attrs.ext_wopermitid as number;
    expect(sheet.rowValues(ck("WO2100", id), "base")).toMatchObject({ WONUM: "WO2100", "EXT_WOPERMIT.EXT_AUTHORITY": "消防" });
    expect(h.controller.writeLog()[0]).toMatchObject({ parentKey: pk("WO2100"), result: "verified", ops: { add: 1 } });
  });

  it("add_rows の children: 複数の親に子行を 1 回で足し、反映すると親ごとに子が増える", async () => {
    const h = harness();
    await loadPermits(h);
    const res = await h.call("add_rows", {
      sheet: PERMIT_SHEET,
      children: [
        { parentRowKey: ck("WO2001", 1001), rows: [{ "EXT_WOPERMIT.EXT_AUTHORITY": "県", "EXT_WOPERMIT.EXT_PERMITTYPE": "届出" }] },
        { parentRowKey: ck("WO2002", 1003), rows: [{ "EXT_WOPERMIT.EXT_AUTHORITY": "市", "EXT_WOPERMIT.EXT_PERMITTYPE": "許可" }, { "EXT_WOPERMIT.EXT_AUTHORITY": "国", "EXT_WOPERMIT.EXT_PERMITTYPE": "届出" }] },
      ],
      baseRevision: h.workspace.revision,
      reason: "許可申請を足す",
    });
    expect(res).toMatchObject({ applied: 3, conflictCount: 0 });
    expect(res.rowKeys).toHaveLength(3);
    expect(h.workspace.batches.filter((b) => !b.undone)).toHaveLength(1);
    const e = await h.fail("add_rows", { sheet: PERMIT_SHEET, rows: [{ WONUM: "X" }], children: [{ parentRowKey: pk("WO2001"), rows: [{}] }], baseRevision: h.workspace.revision, reason: "x" });
    expect(e.code).toBe(RelayErrorCode.INVALID_ARGS);

    h.fake.state.requests.length = 0;
    const running = h.controller.run(PERMIT_SHEET, {});
    await untilCanary(h);
    h.controller.continueCanary(PERMIT_SHEET, true);
    const done = await running;
    expect(done.results.map((r) => r.status)).toEqual(["verified", "verified"]);
    expect(h.fake.find("mxapiwo", (r) => r.attrs.wonum === "WO2002")!.children.ext_wopermit!.map((c) => c.attrs.ext_authority)).toEqual(["県", "市", "国"]);
  });

  it("同じキーの作業指示が Maximo にもうあれば作らずに conflict にし、足した行は作業画面に残す", async () => {
    const h = harness();
    await loadPermits(h);
    await h.call("add_rows", { sheet: PERMIT_SHEET, rows: [{ SITEID: "BEDFORD", WONUM: "WO2100", DESCRIPTION: "新規" }], baseRevision: h.workspace.revision, reason: "登録" });
    h.fake.state.os.mxapiwo!.records.push({ uid: "_Z", rowstamp: 1, attrs: { siteid: "BEDFORD", wonum: "WO2100" }, children: {} });
    h.fake.state.requests.length = 0;
    h.controller.request(PERMIT_SHEET, "新規 1 件", "llm");
    const done = await h.controller.run(PERMIT_SHEET, {});
    expect(done.state).toBe("failed");
    expect(done.results).toMatchObject([{ status: "conflict" }]);
    expect(posts(h.fake)).toHaveLength(0);
    expect(h.workspace.getDiff(PERMIT_SHEET).addedRows).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("CommitController: ステータスの変更", () => {
  const WO_SHEET = "作業指示";
  const loadWos = (h: Harness) =>
    h.call("load_sheet", { name: WO_SHEET, os: "MXAPIWO", select: ["WONUM", "SITEID", "STATUS", "DESCRIPTION"], where: [{ attr: "SITEID", op: "eq", value: "BEDFORD" }] });
  const statusOf = (fake: FakeMaximo, wonum: string) => fake.find("mxapiwo", (r) => r.attrs.wonum === wonum)!.attrs.status;
  const runConfirmed = async (h: Harness, opts: { irreversibleConfirmed?: boolean } = {}) => {
    const running = h.controller.run(WO_SHEET, opts);
    // 2 件以上ならカナリア（最初の 1 件）の後で続ける
    await Promise.race([running, vi.waitFor(() => expect(h.controller.panel(WO_SHEET).awaitingCanary).not.toBeNull(), { timeout: 5_000, interval: 5 }).catch(() => {})]);
    if (h.controller.panel(WO_SHEET).awaitingCanary) h.controller.continueCanary(WO_SHEET, true);
    return running;
  };

  it("戻せないステータス（CLOSE）があると needsIrreversibleConfirm になり、確認付きのときだけ反映する（I11）", async () => {
    const h = harness();
    await loadWos(h);
    await h.call("patch_cells", {
      sheet: WO_SHEET,
      edits: [
        { rowKey: pk("WO2001"), col: "STATUS", value: "CLOSE" },
        { rowKey: pk("WO2003"), col: "STATUS", value: "INPRG" },
      ],
      baseRevision: h.workspace.revision,
      reason: "ステータスを進める",
    });
    const req = await h.call("request_commit", { sheet: WO_SHEET, note: "ステータス 2 件" });
    expect(req.needsIrreversibleConfirm).toBe(true);
    const panel = h.controller.panel(WO_SHEET);
    expect(panel.needsIrreversibleConfirm).toBe(true);
    expect(panel.blockers).toEqual([]);
    expect(panel.counts).toMatchObject({ parents: 2, statusChanges: 2, statusTargets: { CLOSE: 1, INPRG: 1 }, irreversible: 1 });

    expect((await h.controller.run(WO_SHEET, {})).state).toBe("requested");
    expect(h.fake.writeCount()).toBe(0);

    const done = await runConfirmed(h, { irreversibleConfirmed: true });
    expect(done.state).toBe("done");
    expect(done.results.map((r) => r.status)).toEqual(["verified", "verified"]);
    expect(statusOf(h.fake, "WO2001")).toBe("CLOSE");
    expect(statusOf(h.fake, "WO2003")).toBe("INPRG");
    // 属性としては送らない
    for (const p of posts(h.fake)) expect(p.path).toContain("action=wsmethod:changeStatus");
    expect(h.workspace.getDiff(WO_SHEET).changedCells).toBe(0);
    expect(h.workspace.getSheet(WO_SHEET).rowValues(pk("WO2001"), "base")!.STATUS).toBe("CLOSE");
    expect(h.controller.writeLog().map((e) => e.ops.status)).toEqual(["CLOSE", "INPRG"]);
  });

  it("COMP への変更は確認が要らない。移れないステータス（COMP → INPRG）は送らずに skipped で、変更は作業画面に残る", async () => {
    const h = harness();
    await loadWos(h);
    await h.call("patch_cells", {
      sheet: WO_SHEET,
      edits: [
        { rowKey: pk("WO2002"), col: "STATUS", value: "INPRG" },
        { rowKey: pk("WO2003"), col: "STATUS", value: "COMP" },
      ],
      baseRevision: h.workspace.revision,
      reason: "ステータスを直す",
    });
    expect(h.controller.panel(WO_SHEET).needsIrreversibleConfirm).toBe(false);
    const done = await runConfirmed(h);
    expect(done.results.map((r) => [r.rowKey, r.status, r.reasonCode ?? null])).toEqual([
      [pk("WO2002"), "skipped", "MXSTAGE_STATUS_TRANSITION"],
      [pk("WO2003"), "verified", null],
    ]);
    expect(statusOf(h.fake, "WO2002")).toBe("COMP");
    expect(statusOf(h.fake, "WO2003")).toBe("COMP");
    expect(h.workspace.getDiff(WO_SHEET).changedCells).toBe(1);
  });

  it("新しい作業指示を COMP で作る: 作ってから COMP に変え、読み直して base にする", async () => {
    const h = harness();
    await loadWos(h);
    await h.call("add_rows", { sheet: WO_SHEET, rows: [{ SITEID: "BEDFORD", WONUM: "WO2100", DESCRIPTION: "過去の点検", STATUS: "COMP" }], baseRevision: h.workspace.revision, reason: "履歴を登録" });
    h.fake.state.requests.length = 0;
    expect(h.controller.panel(WO_SHEET).counts).toMatchObject({ newRecords: 1, statusChanges: 1, statusTargets: { COMP: 1 } });
    const done = await runConfirmed(h);
    expect(done.results).toMatchObject([{ rowKey: pk("WO2100"), status: "verified" }]);
    expect(statusOf(h.fake, "WO2100")).toBe("COMP");
    expect(posts(h.fake).map((p) => p.path.includes("changeStatus"))).toEqual([false, true]);
    expect(h.workspace.getDiff(WO_SHEET)).toMatchObject({ changedCells: 0, addedRows: 0 });
    expect(h.workspace.getSheet(WO_SHEET).rowValues(pk("WO2100"), "base")).toMatchObject({ STATUS: "COMP", DESCRIPTION: "過去の点検" });
  });

  it("apply_rule の phase: past を省くと接続先の設定（既定 COMP、選べば CLOSE）を使い、そう伝える", async () => {
    const cases: Array<[StatusPrefs | undefined, string]> = [
      [undefined, "COMP"],
      [{ pastStatusOf: () => "CLOSE" }, "CLOSE"],
    ];
    for (const [statusPrefs, want] of cases) {
      const h = harness(permitSeed(), statusPrefs ? { statusPrefs } : {});
      await h.call("load_sheet", {
        name: WO_SHEET,
        os: "MXAPIWO",
        select: ["WONUM", "SITEID", "STATUS", "DESCRIPTION", "TARGSTARTDATE"],
        where: [{ attr: "SITEID", op: "eq", value: "BEDFORD" }],
      });
      await h.call("add_rows", { sheet: WO_SHEET, rows: [{ SITEID: "BEDFORD", WONUM: "WO2100", DESCRIPTION: "過去の点検", TARGSTARTDATE: "2020-04-15" }], baseRevision: h.workspace.revision, reason: "履歴を登録" });
      const r = await h.call("apply_rule", {
        sheet: WO_SHEET,
        set: { STATUS: { phase: { finish: "TARGSTARTDATE", inProgress: "INPRG", future: "WAPPR" } } },
        baseRevision: h.workspace.revision,
        reason: "時期でステータスを決める",
      });
      expect(r.phase.STATUS).toMatchObject({ past: 1, existing: 3 });
      expect(r.phaseNote).toContain(want);
      expect(h.workspace.getSheet(WO_SHEET).rowValues(pk("WO2100"), "final")!.STATUS).toBe(want);
      // past を書けば、設定ではなくその値
      const again = await h.call("apply_rule", {
        sheet: WO_SHEET,
        set: { STATUS: { phase: { finish: "TARGSTARTDATE", past: "COMP", inProgress: "INPRG", future: "WAPPR" } } },
        baseRevision: h.workspace.revision,
        reason: "完了にする",
      });
      expect(again).not.toHaveProperty("phaseNote");
      expect(h.workspace.getSheet(WO_SHEET).rowValues(pk("WO2100"), "final")!.STATUS).toBe("COMP");
    }
  });

  it("作った後にステータスだけ失敗しても、作ったレコードで行を付け替え、ステータスの変更だけを作業画面に残す", async () => {
    const h = harness();
    await loadWos(h);
    await h.call("add_rows", { sheet: WO_SHEET, rows: [{ SITEID: "BEDFORD", WONUM: "WO2101", DESCRIPTION: "過去の点検", STATUS: "COMP" }], baseRevision: h.workspace.revision, reason: "履歴を登録" });
    // ステータスの変更だけを Maximo に断らせる
    h.fake.state.failures.push({ method: "POST", phase: "before", kind: "status", status: 400, body: { Error: { reasonCode: "BMXAA4590E", message: "status cannot change" } }, pathIncludes: "/mxapiwo/" });
    const done = await runConfirmed(h);
    expect(done.results).toMatchObject([{ rowKey: pk("WO2101"), status: "error" }]);
    expect(statusOf(h.fake, "WO2101")).toBe("WAPPR");
    const diff = h.workspace.getDiff(WO_SHEET);
    expect(diff).toMatchObject({ addedRows: 0, changedCells: 1 });
    expect(h.workspace.getSheet(WO_SHEET).rowValues(pk("WO2101"), "base")).toMatchObject({ STATUS: "WAPPR" });
    expect(h.workspace.getSheet(WO_SHEET).rowValues(pk("WO2101"), "final")).toMatchObject({ STATUS: "COMP" });

    // もう一度反映すると、ステータスの変更だけを送る
    h.fake.state.requests.length = 0;
    const again = await runConfirmed(h);
    expect(again.results).toMatchObject([{ rowKey: pk("WO2101"), status: "verified" }]);
    expect(posts(h.fake).map((p) => p.path.includes("changeStatus"))).toEqual([true]);
    expect(statusOf(h.fake, "WO2101")).toBe("COMP");
  });
});
