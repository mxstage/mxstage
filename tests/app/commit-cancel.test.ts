// CommitController の追加分の試験。
// 反映の中止（cancel）、実行しなかった理由（CommitPanelState.message）、
// パネル再計算の間引き時間（refreshMs）、blockers の文言、
// 行をすべて削除した親に残った親の列の変更を確かめる。

import { describe, expect, it, vi } from "vitest";
import { ObjectStructureCatalog } from "../../src/app/catalog/catalog";
import {
  ALREADY_RUNNING_MESSAGE,
  CANCELLED_MESSAGE,
  CANCELLED_ROW_NOTE,
  MAX_UNWRITABLE_BLOCKERS,
  NEEDS_DELETE_CONFIRM_MESSAGE,
  NEEDS_NULL_CONFIRM_MESSAGE,
  NOT_CONNECTED_BLOCKER,
  createCommitController,
  describePlanError,
} from "../../src/app/commit/controller";
import { MaximoClient } from "../../src/app/maximo/client";
import { CommitInvariantError } from "../../src/app/maximo/commit";
import type { ToolContext } from "../../src/app/relay";
import type { MaximoConnection } from "../../src/app/runtime/contracts";
import { JobRegistry, Workspace } from "../../src/app/store";
import { createToolRegistry } from "../../src/app/tools/registry";
import { MAX_RESULT_TEXT_BYTES } from "../../src/app/tools/results";
import type { CellValue, ColumnSchema } from "../../src/shared/model";
import type { InvokeMsg } from "../../src/shared/protocol";
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

/** 完了済みの WO を 3 件（WO2001 / WO2002 / WO2004）。それぞれ「届出」の子を 1 件以上持つ */
function threeParentSeed(extra: FakeRecordSeed[] = []): FakeSeed {
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
        attrs: { siteid: "BEDFORD", wonum: "WO2004", description: "危険物届出", status: "COMP" },
        children: { ext_wopermit: [{ ext_authority: "市", ext_permittype: "届出", ext_permitdate: "2026-07-01", ext_memo: "m4" }] },
      },
      ...extra,
    ],
  });
}

function harness(seed: FakeSeed = threeParentSeed()) {
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
  const registry = createToolRegistry({ workspace, jobs, connection, commits: controller, catalog: new ObjectStructureCatalog(), appVersion: "0.1.0-test", appUrl: APP_URL });
  let seq = 0;

  async function call(tool: string, args: unknown = {}): Promise<Record<string, any>> {
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
    const out = await registry.handler(msg, ctx);
    return out.result.structuredContent as Record<string, any>;
  }

  return { fake, workspace, jobs, connection, controller, call };
}

type Harness = ReturnType<typeof harness>;

const loadPermits = (h: Harness) =>
  h.call("load_sheet", { name: PERMIT_SHEET, os: "MXAPIWO", select: SELECT, where: [{ attr: "STATUS", op: "eq", value: "COMP" }] });

const posts = (fake: FakeMaximo) => fake.state.requests.filter((r) => r.method === "POST");
const untilCanary = (h: Harness) => vi.waitFor(() => expect(h.controller.panel(PERMIT_SHEET).awaitingCanary).not.toBeNull(), { timeout: 5_000, interval: 5 });

/** 完了済み WO の「届出」の申請完了日を変えた状態（親 3 件）にする */
async function prepared(seed?: FakeSeed): Promise<Harness> {
  const h = harness(seed ?? threeParentSeed());
  await loadPermits(h);
  const res = await h.call("apply_rule", {
    sheet: PERMIT_SHEET,
    filter: [{ attr: "EXT_WOPERMIT.EXT_PERMITTYPE", op: "eq", value: "届出" }],
    set: { "EXT_WOPERMIT.EXT_PERMITDATE": { const: NEW_DATE } },
    baseRevision: h.workspace.revision,
    reason: "完了済み許可申請の申請完了日を変更",
  });
  expect(res.applied).toBe(3);
  h.fake.state.requests.length = 0;
  return h;
}

function permitDateOf(fake: FakeMaximo, wonum: string): CellValue {
  const rec = fake.find("mxapiwo", (r) => r.attrs.wonum === wonum)!;
  return rec.children.ext_wopermit![0]!.attrs.ext_permitdate ?? null;
}

/** 親 1 件・親だけの行 1 行の Maximo シート（親行の削除・親の列の変更を試す） */
function singleParentSheet(workspace: Workspace, fake: FakeMaximo): string {
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
  const record: MaximoRecord = {
    href: `${fake.baseUrl}/maximo/api/os/mxapiwo/_R1`,
    rowstamp: "1",
    attrs: { SITEID: "BEDFORD", WONUM: "WO1", DESCRIPTION: "元の値" },
    children: {},
  };
  const key = makeParentKey(["BEDFORD", "WO1"]);
  const rows: SheetRow[] = [{ rowKey: key, parentKey: key, childName: null, values: { SITEID: "BEDFORD", WONUM: "WO1", DESCRIPTION: "元の値" } }];
  workspace.createSheet(meta, rows, [record]);
  return key;
}

// ---------------------------------------------------------------------------

describe("CommitController: 反映の中止", () => {
  it("カナリアの確認待ちで中止すると、残りは送らず skipped になり isRunning が戻る", async () => {
    const h = await prepared();
    const running = h.controller.run(PERMIT_SHEET, {});
    await untilCanary(h);
    expect(h.controller.isRunning(PERMIT_SHEET)).toBe(true);

    h.controller.cancel(PERMIT_SHEET);
    const done = await running;

    expect(done.results.map((r) => r.status)).toEqual(["verified", "skipped", "skipped"]);
    expect(done.results.slice(1).map((r) => r.message)).toEqual([CANCELLED_ROW_NOTE, CANCELLED_ROW_NOTE]);
    expect(done.message).toBe(CANCELLED_MESSAGE);
    expect(done.awaitingCanary).toBeNull();
    expect(h.controller.isRunning(PERMIT_SHEET)).toBe(false);
    // 送信済みの親（カナリア）は取り消さない。残りの親は送っていない
    expect(posts(h.fake)).toHaveLength(1);
    expect(permitDateOf(h.fake, "WO2001")).toBe(NEW_DATE);
    expect(permitDateOf(h.fake, "WO2002")).toBe("2026-05-01");
    expect(permitDateOf(h.fake, "WO2004")).toBe("2026-07-01");
    // 送らなかった親の変更は作業画面に残る
    expect(h.workspace.getDiff(PERMIT_SHEET).changedCells).toBe(2);
  });

  it("カナリアの後に中止すると、送信済みの親はそのままで残りだけ skipped になる", async () => {
    const h = await prepared();
    // 2 件目の結果が届いた時点で中止する（3 件目は送らせない）
    let cancelled = false;
    const off = h.controller.subscribe(() => {
      if (!cancelled && h.controller.panel(PERMIT_SHEET).results.length === 2) {
        cancelled = true;
        h.controller.cancel(PERMIT_SHEET);
      }
    });
    const running = h.controller.run(PERMIT_SHEET, {});
    await untilCanary(h);
    h.controller.continueCanary(PERMIT_SHEET, true);
    const done = await running;
    off();

    expect(cancelled).toBe(true);
    expect(done.results.map((r) => r.status)).toEqual(["verified", "verified", "skipped"]);
    expect(done.results[2]!.message).toBe(CANCELLED_ROW_NOTE);
    expect(done.message).toBe(CANCELLED_MESSAGE);
    expect(h.controller.isRunning(PERMIT_SHEET)).toBe(false);
    expect(posts(h.fake)).toHaveLength(2);
    expect(permitDateOf(h.fake, "WO2004")).toBe("2026-07-01");
    expect(h.workspace.getDiff(PERMIT_SHEET).changedCells).toBe(1);
  });

  it("行の失敗と同時に中止しても、書き込みエンジンの内部の文言を利用者に出さない", async () => {
    const h = await prepared();
    const uid = h.fake.find("mxapiwo", (r) => r.attrs.wonum === "WO2002")!.uid;
    // 2 件目の親だけ Maximo がエラーを返す（reasonCode 付き＝error で打ち切り）
    h.fake.state.failures.push({
      method: "POST",
      pathIncludes: uid,
      kind: "status",
      status: 400,
      body: { Error: { reasonCode: "BMXAA_FAKE_TEST", message: "テスト用のエラー" } },
    });
    let cancelled = false;
    const off = h.controller.subscribe(() => {
      if (!cancelled && h.controller.panel(PERMIT_SHEET).results.length === 2) {
        cancelled = true;
        h.controller.cancel(PERMIT_SHEET);
      }
    });
    const running = h.controller.run(PERMIT_SHEET, {});
    await untilCanary(h);
    h.controller.continueCanary(PERMIT_SHEET, true);
    const done = await running;
    off();

    expect(done.results.map((r) => r.status)).toEqual(["verified", "error", "skipped"]);
    // 中止は onRow の例外で伝えているので、その内部の文言（結果の通知に失敗した）を利用者に見せない
    expect(done.results[2]!.message).toBe(CANCELLED_ROW_NOTE);
    expect(done.results.map((r) => r.message ?? "").join(" ")).not.toContain("onRow");
    // 失敗した行の結果は残り、状態は failed
    expect(done.results[1]!.reasonCode).toBe("BMXAA_FAKE_TEST");
    expect(done.state).toBe("failed");
    expect(done.message).toBe(CANCELLED_MESSAGE);
    expect(posts(h.fake)).toHaveLength(2);
  });

  it("反映中でなければ中止は何もしない", async () => {
    const h = await prepared();
    h.controller.cancel(PERMIT_SHEET);
    expect(h.controller.panel(PERMIT_SHEET).message).toBeUndefined();
    expect(h.controller.panel(PERMIT_SHEET).state).toBe("idle");

    // 中止していないので最後まで実行する
    const running = h.controller.run(PERMIT_SHEET, {});
    await untilCanary(h);
    h.controller.continueCanary(PERMIT_SHEET, true);
    const done = await running;
    expect(done.state).toBe("done");
    expect(done.results.map((r) => r.status)).toEqual(["verified", "verified", "verified"]);
    expect(done.message).toBeUndefined();
  });
});

describe("CommitController: 実行しなかった理由（message）", () => {
  it("未接続・確認不足・実行中のときに理由を日本語で返し、実行したら消す", async () => {
    const h = await prepared();

    h.connection.set(false);
    const notConnected = await h.controller.run(PERMIT_SHEET, {});
    expect(notConnected.state).toBe("idle");
    expect(notConnected.message).toContain(NOT_CONNECTED_BLOCKER);

    h.connection.set(true);
    // 空にする変更は確認が要る
    h.workspace.applyEdits(PERMIT_SHEET, [{ rowKey: ck("WO2001", 1001), col: "EXT_WOPERMIT.EXT_MEMO", value: null }], { author: "user" });
    const needsNull = await h.controller.run(PERMIT_SHEET, {});
    expect(needsNull.state).toBe("idle");
    expect(needsNull.message).toBe(NEEDS_NULL_CONFIRM_MESSAGE);

    // 実行中に呼ぶと「反映中」だと返す
    const running = h.controller.run(PERMIT_SHEET, { allowNull: true });
    await untilCanary(h);
    const busy = await h.controller.run(PERMIT_SHEET, { allowNull: true });
    expect(busy.state).toBe("running");
    expect(busy.message).toBe(ALREADY_RUNNING_MESSAGE);
    h.controller.continueCanary(PERMIT_SHEET, true);
    const done = await running;
    // 実行したので前の理由は残さない
    expect(done.message).toBeUndefined();
    expect(h.controller.panel(PERMIT_SHEET).message).toBeUndefined();
  });

  it("削除の確認が無いときは確認を促す文言を返す", async () => {
    const many: FakeRecordSeed = {
      attrs: { siteid: "BEDFORD", wonum: "WO3001", description: "申請が多い WO", status: "COMP" },
      children: {
        ext_wopermit: Array.from({ length: 12 }, (_, i) => ({ ext_authority: `許可${i}`, ext_permittype: "届出", ext_permitdate: "2026-04-01" })),
      },
    };
    const h = harness(threeParentSeed([many]));
    await loadPermits(h);
    const rowKeys = h.workspace
      .getSheet(PERMIT_SHEET)
      .rowKeys("final")
      .filter((k) => k.startsWith(`${pk("WO3001")}#`))
      .slice(0, 11);
    h.workspace.deleteRows(PERMIT_SHEET, rowKeys, { author: "user" });
    const res = await h.controller.run(PERMIT_SHEET, {});
    expect(res.state).toBe("idle");
    expect(res.message).toBe(NEEDS_DELETE_CONFIRM_MESSAGE);
    expect(h.fake.writeCount()).toBe(0);
  });
});

describe("CommitController: パネル再計算の間引き時間", () => {
  it("refreshMs で間引き時間を変えられる", () => {
    vi.useFakeTimers();
    try {
      const workspace = new Workspace("作業");
      const controller = createCommitController({ workspace, connection: { current: () => null, subscribe: () => () => {} }, refreshMs: 50 });
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
      workspace.applyEdits("メモ", [{ rowKey: key, col: "TEXT", value: "b" }], { author: "user" });
      vi.advanceTimersByTime(49);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(seen).toEqual(["メモ"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CommitController: blockers の文言", () => {
  it("書き込みエンジンの内部コードだけでなく、次にできることを書く", async () => {
    const h = await prepared();
    const key = singleParentSheet(h.workspace, h.fake);
    h.workspace.deleteRows("WO", [key], { author: "user" });
    const blockers = h.controller.panel("WO").blockers;
    expect(blockers).toHaveLength(1);
    const text = blockers[0]!;
    expect(text.startsWith("[INPUT]")).toBe(false);
    expect(text).toContain("親（Maximo のレコード）の削除は反映できません");
    expect(text).toContain("削除を取り消してください");
    // 内部コードは括弧に残す
    expect(text).toContain("（INPUT: 親行の削除は未対応）");
  });

  it("describePlanError は不変条件ごとに対処を書く", () => {
    const i5 = describePlanError(new CommitInvariantError("I5", "列 STATUS は読み取り専用"));
    expect(i5).toContain("変更できない列");
    expect(i5).toContain("（I5: 列 STATUS は読み取り専用）");
    const other = describePlanError(new Error("想定外"));
    expect(other).toContain("想定外");
  });
});

describe("CommitController: 行をすべて削除した親の列の変更", () => {
  it("子の行をすべて削除した親に残った親の列の変更は、黙って捨てずに blockers に出す", async () => {
    const h = await prepared();
    // WO2002 は子が 1 行だけ。親の列（DESCRIPTION）を変えてからその行を削除する
    h.workspace.applyEdits(PERMIT_SHEET, [{ rowKey: ck("WO2002", 1003), col: "DESCRIPTION", value: "親の説明を変更" }], { author: "user" });
    h.workspace.deleteRows(PERMIT_SHEET, [ck("WO2002", 1003)], { author: "user" });

    const blockers = h.controller.panel(PERMIT_SHEET).blockers;
    const lost = blockers.find((b) => b.includes("行をすべて削除"));
    expect(lost).toBeDefined();
    expect(lost).toContain(pk("WO2002"));
    expect(lost).toContain("DESCRIPTION");
    expect(lost).toContain("親行の削除は未対応");
    // blockers がある間は実行しない
    const res = await h.controller.run(PERMIT_SHEET, {});
    expect(res.state).toBe("idle");
    expect(h.fake.writeCount()).toBe(0);
  });

  it("同じ親に行が残っていれば、削除した行の親の列の変更も反映する", async () => {
    const h = await prepared();
    // WO2001 は子が 2 行。親の列を変えてから 1 行だけ削除する
    h.workspace.applyEdits(PERMIT_SHEET, [{ rowKey: ck("WO2001", 1001), col: "DESCRIPTION", value: "消防設備点検（変更）" }], { author: "user" });
    h.workspace.deleteRows(PERMIT_SHEET, [ck("WO2001", 1002)], { author: "user" });
    expect(h.controller.panel(PERMIT_SHEET).blockers).toEqual([]);

    const running = h.controller.run(PERMIT_SHEET, {});
    await untilCanary(h);
    h.controller.continueCanary(PERMIT_SHEET, true);
    const done = await running;
    expect(done.results[0]).toMatchObject({ rowKey: pk("WO2001"), status: "verified" });
    expect(h.fake.find("mxapiwo", (r) => r.attrs.wonum === "WO2001")!.attrs.description).toBe("消防設備点検（変更）");
  });
});

describe("CommitController: blockers が際限なく増えないこと", () => {
  it("行をすべて削除した親が多いときは、先頭だけ並べて残りは件数で知らせる", async () => {
    // 親 11 件（それぞれ子 1 行）。全行に親の列の変更を入れてから全行を削除する
    const extra: FakeRecordSeed[] = Array.from({ length: 8 }, (_, i) => ({
      attrs: { siteid: "BEDFORD", wonum: `WO40${String(i).padStart(2, "0")}`, description: `点検${i}`, status: "COMP" },
      children: { ext_wopermit: [{ ext_authority: "市", ext_permittype: "届出", ext_permitdate: "2026-08-01" }] },
    }));
    const h = harness(threeParentSeed(extra));
    await loadPermits(h);
    const parents = new Set(h.workspace.getSheet(PERMIT_SHEET).rowKeys("final").map((k) => k.split("#")[0]!));
    expect(parents.size).toBe(11);

    const applied = await h.call("apply_rule", {
      sheet: PERMIT_SHEET,
      set: { DESCRIPTION: { const: "まとめて変更" } },
      baseRevision: h.workspace.revision,
      reason: "親の列をまとめて変更",
    });
    expect(applied.applied).toBeGreaterThan(0);
    h.workspace.deleteRows(PERMIT_SHEET, h.workspace.getSheet(PERMIT_SHEET).rowKeys("final"), { author: "user" });

    const blockers = h.controller.panel(PERMIT_SHEET).blockers;
    // 親 11 件分を並べず、先頭 MAX_UNWRITABLE_BLOCKERS 件 + 残りの件数の 1 件にする
    expect(blockers).toHaveLength(MAX_UNWRITABLE_BLOCKERS + 1);
    expect(blockers[MAX_UNWRITABLE_BLOCKERS]).toContain(`ほかに ${11 - MAX_UNWRITABLE_BLOCKERS} 件の親`);
    // ツールの結果も上限に収まる
    const res = await h.call("request_commit", { sheet: PERMIT_SHEET, note: "確認" });
    expect(res.blockers).toHaveLength(MAX_UNWRITABLE_BLOCKERS + 1);
    expect(new TextEncoder().encode(JSON.stringify(res)).length).toBeLessThanOrEqual(MAX_RESULT_TEXT_BYTES);
  });
});

describe("CommitController: 親の子をすべて入れ替えたとき", () => {
  it("残った行が追加行だけでも、親の列の変更を Maximo に反映する", async () => {
    const h = harness();
    await loadPermits(h);
    const row = ck("WO2002", 1003); // 子が 1 行だけの親
    h.workspace.applyEdits(PERMIT_SHEET, [{ rowKey: row, col: "DESCRIPTION", value: "高圧ガス保安（変更）" }], { author: "user" });
    const added = h.workspace.addRows(
      PERMIT_SHEET,
      [{ "EXT_WOPERMIT.EXT_AUTHORITY": "県", "EXT_WOPERMIT.EXT_PERMITTYPE": "申請", "EXT_WOPERMIT.EXT_PERMITDATE": "2027-01-01" }],
      { author: "user", parentRowKey: row },
    );
    expect(added.applied).toBe(1);
    h.workspace.deleteRows(PERMIT_SHEET, [row], { author: "user" });
    expect(h.controller.panel(PERMIT_SHEET).blockers).toEqual([]);

    const done = await h.controller.run(PERMIT_SHEET, {});
    expect(done.results.map((r) => r.status)).toEqual(["verified"]);
    const rec = h.fake.find("mxapiwo", (r) => r.attrs.wonum === "WO2002")!;
    // 親の列の変更（削除した行に残っていた分）も、子の入れ替えも反映されている
    expect(rec.attrs.description).toBe("高圧ガス保安（変更）");
    expect(rec.children.ext_wopermit!.map((c) => c.attrs.ext_permittype)).toEqual(["申請"]);
  });
});
