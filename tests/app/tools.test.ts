// ToolRegistry（作業タブでのツール実行）の試験。
// 例 (a)（許可申請の申請完了日だけを変更）の流れ、引数の検証、未接続・BUSY・列の候補、
// dataNotice と切り詰め、load_sheet のジョブ化と同名シートの置き換え拒否を確かめる。

import { describe, expect, it, vi } from "vitest";
import { ObjectStructureCatalog } from "../../src/app/catalog/catalog";
import { createCommitController } from "../../src/app/commit/controller";
import { MaximoClient, type FetchLike } from "../../src/app/maximo/client";
import { RelayToolError, type ToolContext } from "../../src/app/relay";
import type { CommitPanelState, CommitRequester, MaximoConnection } from "../../src/app/runtime/contracts";
import { JobRegistry, Workspace } from "../../src/app/store";
import { suggestNames } from "../../src/app/tools/errors";
import { resolveKeyColumns } from "../../src/app/tools/loadSheet";
import { createToolRegistry, loadWaitBudget, settingsUrlOf, TAB_TOOL_NAMES } from "../../src/app/tools/registry";
import { DATA_NOTICE, MAX_CELL_CHARS, MAX_RESULT_TEXT_BYTES } from "../../src/app/tools/results";
import type { CellValue, ColumnSchema } from "../../src/shared/model";
import { RelayErrorCode, type InvokeMsg } from "../../src/shared/protocol";
import { makeChildRowKey, makeParentKey, type SheetMeta, type SheetRow } from "../../src/shared/sheet";
import type { ToolName } from "../../src/shared/toolDefs";
import { createFakeMaximo, sampleSeed, withDefinitions, type FakeOsSeed, type FakeRecordSeed, type FakeSeed } from "../fakes/fake-maximo";

const APP_URL = "https://mxstage.test/app";
const SETTINGS_URL = "https://mxstage.test/settings";
const PERMIT_SHEET = "許可申請";
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
const COMP_WHERE = [{ attr: "STATUS", op: "eq" as const, value: "COMP" }];

const pk = (wonum: string) => makeParentKey(["BEDFORD", wonum]);
const ck = (wonum: string, id: CellValue) => makeChildRowKey(pk(wonum), "EXT_WOPERMIT", id);

/** 許可申請の子を持つ WO。子 ID は 1001（WO2001 消防/届出）、1002（WO2001 労基/申請）、1003（WO2002）、1004（WO2003 未完了） */
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

interface HarnessOptions {
  seed?: FakeSeed;
  connected?: boolean;
  commits?: CommitRequester;
  fetchWrap?: (f: FetchLike) => FetchLike;
  /** 作業をまたいで同じカタログを使う場合に渡す（既定は新しいカタログ） */
  catalog?: ObjectStructureCatalog;
}

function harness(opts: HarnessOptions = {}) {
  const fake = createFakeMaximo(opts.seed ?? permitSeed());
  const client = new MaximoClient({
    baseUrl: fake.baseUrl,
    apiKey: () => fake.apiKey,
    via: "direct",
    fetchImpl: opts.fetchWrap ? opts.fetchWrap(fake.fetch) : fake.fetch,
    sleep: async () => {},
  });
  const maximo: MaximoConnection = {
    info: { baseUrl: fake.baseUrl, via: "direct", connectionName: "MAXADMIN@test", userName: "MAXADMIN", connectedAt: 1_700_000_000_000 },
    client,
  };
  let current: MaximoConnection | null = opts.connected === false ? null : maximo;
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
  const commits: CommitRequester = opts.commits ?? controller;
  const catalog = opts.catalog ?? new ObjectStructureCatalog();
  const registry = createToolRegistry({ workspace, jobs, connection, commits, catalog, appVersion: "0.1.0-test", appUrl: APP_URL });
  let seq = 0;

  interface CallOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
    progress?: ToolContext["progress"];
  }

  async function invoke(tool: string, args: unknown, o: CallOptions = {}) {
    const timeoutMs = o.timeoutMs ?? 30_000;
    const msg: InvokeMsg = {
      type: "tool.invoke",
      id: `call${++seq}`,
      tool: tool as ToolName,
      args,
      deadlineAt: Date.now() + timeoutMs,
      timeoutMs,
      idempotencyKey: "",
      readOnly: false,
    };
    return registry.handler(msg, { signal: o.signal ?? new AbortController().signal, progress: o.progress ?? (() => {}) });
  }

  /** 成功したツールの structuredContent（content のテキストと同じで、revision を含む） */
  async function call(tool: string, args: unknown = {}, o: CallOptions = {}): Promise<Record<string, any>> {
    const out = await invoke(tool, args, o);
    const structured = out.result.structuredContent as Record<string, any>;
    expect(JSON.parse(out.result.content[0]!.text)).toEqual(structured);
    expect(structured.revision).toBe(out.revision);
    return structured;
  }

  async function fail(tool: string, args: unknown = {}, o: CallOptions = {}): Promise<RelayToolError> {
    try {
      await invoke(tool, args, o);
    } catch (e) {
      expect(e).toBeInstanceOf(RelayToolError);
      return e as RelayToolError;
    }
    throw new Error(`${tool} が失敗しませんでした`);
  }

  return { fake, client, workspace, jobs, connection, controller, registry, catalog, call, fail };
}

type Harness = ReturnType<typeof harness>;

const loadPermits = (h: Harness, args: Record<string, unknown> = {}) => h.call("load_sheet", { name: PERMIT_SHEET, os: "MXAPIWO", select: SELECT, where: COMP_WHERE, ...args });

function excelSheet(ws: Workspace, name: string, columns: string[], rows: Array<Record<string, CellValue>>, keyColumns: string[]): void {
  const meta: SheetMeta = {
    name,
    source: { kind: "excel", importId: "imp1", fileName: "f.xlsx", sheetName: "Sheet1", headerRow: 1 },
    columns: columns.map((n): ColumnSchema => ({ name: n, type: "string" })),
    keyColumns,
    childIdAttrs: {},
  };
  const sheetRows: SheetRow[] = rows.map((r) => {
    const key = makeParentKey(keyColumns.map((k) => r[k] ?? null));
    return { rowKey: key, parentKey: key, childName: null, values: r };
  });
  ws.createSheet(meta, sheetRows);
}

function idlePanel(sheet: string): CommitPanelState {
  return {
    sheet,
    state: "idle",
    counts: { parents: 0, changedCells: 0, addedRows: 0, deletedRows: 0 },
    blockers: [],
    needsDeleteConfirm: false,
    needsNullConfirm: false,
    awaitingCanary: null,
    results: [],
  };
}

/** isRunning だけを差し替えた反映パネル（実際に反映せず BUSY を試す） */
function stubCommits(running: Set<string>): CommitRequester {
  return {
    request: (sheet, note, by) => ({ ...idlePanel(sheet), state: "requested", note, requestedBy: by, requestedAt: 0 }),
    panel: (sheet) => idlePanel(sheet),
    isRunning: (sheet) => running.has(sheet),
  };
}

const slow = (ms: number) => (f: FetchLike): FetchLike =>
  async (input, init) => {
    await new Promise((r) => setTimeout(r, ms));
    return f(input, init);
  };

// ---------------------------------------------------------------------------

describe("ToolRegistry の一覧と引数", () => {
  it("tools は実装済みの 21 ツールだけ（小さな表の取り込み・出力は含めない）", () => {
    const h = harness();
    expect(h.registry.tools).toEqual([...TAB_TOOL_NAMES]);
    expect(h.registry.tools).toHaveLength(21);
    for (const n of ["import_rows", "export_sheet", "open_grid", "get_skill"]) {
      expect(h.registry.tools).not.toContain(n);
    }
  });

  it("tools に無いツールは TOOL_ERROR", async () => {
    const h = harness();
    const e = await h.fail("import_rows", { importId: "i", batchNo: 0, columns: ["A"], rows: [["a"]], last: true });
    expect(e.code).toBe(RelayErrorCode.TOOL_ERROR);
  });

  it("引数をスキーマで検証し直し、何が違うかを INVALID_ARGS で返す", async () => {
    const h = harness();
    const empty = await h.fail("load_sheet", { name: "x", os: "MXAPIWO", select: [] });
    expect(empty.code).toBe(RelayErrorCode.INVALID_ARGS);
    expect(empty.message).toContain("select");
    const limit = await h.fail("query_rows", { sheet: PERMIT_SHEET, limit: 0 });
    expect(limit.message).toContain("limit");
    const noSheet = await h.fail("aggregate", { groupBy: ["STATUS"] });
    expect(noSheet.message).toContain("sheet");
  });

  it("スキーマに無い引数（綴り違い）は黙って捨てずに INVALID_ARGS にする", async () => {
    const h = harness();
    const e = await h.fail("apply_rule", { sheet: PERMIT_SHEET, filters: [], set: { A: { const: 1 } }, baseRevision: 0, reason: "x" });
    expect(e.code).toBe(RelayErrorCode.INVALID_ARGS);
    expect(e.message).toContain("filters");
    expect(e.message).toContain("filter");
  });
});

describe("get_status と Maximo 接続", () => {
  it("接続情報・シート・ジョブ・反映の状態を返し、API キーは含めない", async () => {
    const h = harness();
    await loadPermits(h);
    const st = await h.call("get_status");
    expect(st.tabConnected).toBe(true);
    expect(st.appVersion).toBe("0.1.0-test");
    expect(st.appUrl).toBe(APP_URL);
    expect(st.workspace).toBe("作業");
    expect(st.maximo).toMatchObject({ connected: true, baseUrl: h.fake.baseUrl, via: "direct", connectionName: "MAXADMIN@test", userName: "MAXADMIN" });
    expect(JSON.stringify(st)).not.toContain(h.fake.apiKey);
    expect(st.sheets).toHaveLength(1);
    expect(st.sheets[0]).toMatchObject({ name: PERMIT_SHEET, rowCount: 3, keyColumns: ["SITEID", "WONUM"] });
    expect(st.jobs).toEqual([]);
    expect(st.commits[0]).toMatchObject({ sheet: PERMIT_SHEET, state: "idle", awaitingCanary: false });
    expect(typeof st.revision).toBe("number");
  });

  it("未接続なら connected:false と設定画面の URL を返す", async () => {
    const h = harness({ connected: false });
    const st = await h.call("get_status");
    expect(st.maximo.connected).toBe(false);
    expect(st.maximo.settingsUrl).toBe(SETTINGS_URL);
    expect(st.maximo.message).toContain(SETTINGS_URL);
  });

  it("Maximo が必要なツールは未接続なら TOOL_ERROR で設定画面を案内する", async () => {
    const h = harness({ connected: false });
    const cases: Array<[string, unknown]> = [
      ["list_object_structures", {}],
      ["describe_object_structure", { os: "MXAPIWO" }],
      ["load_sheet", { name: "x", os: "MXAPIWO", select: ["WONUM"] }],
    ];
    for (const [tool, args] of cases) {
      const e = await h.fail(tool, args);
      expect(e.code).toBe(RelayErrorCode.TOOL_ERROR);
      expect(e.message).toContain(`作業画面の設定（${SETTINGS_URL}）で Maximo に接続してください`);
    }
  });
});

const schemaRequests = (h: Harness) => h.fake.state.requests.filter((r) => r.path.includes("/jsonschemas/")).length;
const apimetaRequests = (h: Harness) => h.fake.state.requests.filter((r) => r.path.includes("/apimeta")).length;

/** 属性が多い（実機の MXAPIWO は 716 列）オブジェクト構造。日本語のラベル付き */
function bigSeed(attrCount: number): FakeSeed {
  const seed = permitSeed();
  const attrs: FakeOsSeed["attrs"] = { siteid: { type: "string", required: true, title: "サイト" }, wonum: { type: "string", required: true, title: "作業指示書" } };
  for (let i = 0; i < attrCount; i++) attrs[`ext_attr${String(i).padStart(4, "0")}`] = { type: "string", maxLength: 100, title: `拡張属性${i} 【予算計画】承認者の確認日` };
  attrs.ext_needpermit = { type: "boolean", title: "許可申請あり" };
  seed.objectStructures.MXBIGWO = { description: "Big Work Order", keyAttrs: ["siteid", "wonum"], attrs };
  return seed;
}

/** 作業画面が Maximo に接続したときに行う機械的な読み込み（試験では明示的に呼ぶ） */
const syncAll = (h: Harness) => h.catalog.syncAll(h.client, h.fake.baseUrl);

/** 業務の言葉で探す試験用: 許可申請の子とステータスに日本語のラベルを付け、同じラベルを持つ別の構造（MXAPI で始まらない）を足す */
function labeledSeed(): FakeSeed {
  const seed = permitSeed();
  const wo = seed.objectStructures.MXAPIWO!;
  wo.attrs.status = { type: "string", maxLength: 16, title: "ステータス" };
  wo.children!.ext_wopermit!.attrs.ext_permitdate = { type: "date", title: "申請完了日" };
  wo.children!.ext_wopermit!.attrs.ext_authority = { type: "string", maxLength: 40, title: "許可/法規" };
  seed.objectStructures.MHWO = {
    keyAttrs: ["siteid", "wonum"],
    attrs: { siteid: { type: "string", required: true }, wonum: { type: "string", required: true, title: "作業指示書" }, status: { type: "string", title: "ステータス" } },
  };
  return seed;
}

describe("メタデータのツール", () => {
  it("find_object_structures は業務の言葉（日本語のラベル・子オブジェクト名）から候補の構造と当たった属性を返す", async () => {
    const h = harness({ seed: labeledSeed() });
    await syncAll(h);
    const res = await h.call("find_object_structures", { query: "申請完了日" });
    expect(res.partial).toBe(false);
    expect(res.sync).toMatchObject({ state: "done", failedCount: 0 });
    expect(res.structuresUrl).toBe("https://mxstage.test/structures");
    const top = res.structures[0];
    expect(top.os).toBe("MXAPIWO");
    expect(top.columns).toContainEqual({ name: "EXT_WOPERMIT.EXT_PERMITDATE", title: "申請完了日", type: "date" });
    expect(top.keyColumns).toEqual(["SITEID", "WONUM"]);
    expect(top.children).toContain("EXT_WOPERMIT");
    expect(top.usedBySheets).toEqual([]);

    // 言葉をすべて含む構造を優先する（ステータスだけの MHWO は出さない）
    const both = await h.call("find_object_structures", { query: "許可 ステータス" });
    expect(both.structures.map((s: { os: string }) => s.os)).toEqual(["MXAPIWO"]);
    // 当たり方が同じなら MXAPI で始まる構造を先に並べる
    const status = await h.call("find_object_structures", { query: "ステータス" });
    expect(status.structures.map((s: { os: string }) => s.os).slice(0, 2)).toEqual(["MXAPIWO", "MHWO"]);
    // Maximo には取りに行かない（保存済みの定義を探すだけ）
    const before = schemaRequests(h);
    await h.call("find_object_structures", { query: "作業指示書" });
    expect(schemaRequests(h)).toBe(before);
  });

  it("find_object_structures は当たらなければ推測しないよう知らせ、一部の言葉だけ当たるなら partial にする", async () => {
    const h = harness({ seed: labeledSeed() });
    await syncAll(h);
    const none = await h.call("find_object_structures", { query: "存在しない言葉" });
    expect(none.totalHits).toBe(0);
    expect(none.structures).toEqual([]);
    expect(none.note).toContain("推測で別の構造を使わず");
    const partial = await h.call("find_object_structures", { query: "申請完了日 存在しない言葉" });
    expect(partial.partial).toBe(true);
    expect(partial.partialNote).toContain("一部の言葉");
    expect(partial.structures[0]).toMatchObject({ os: "MXAPIWO", matchedTerms: ["申請完了日"] });
  });

  it("同じ構造で読み込んだシートは usedBySheets に並び（複数可）、シートは読み込んだ接続先と定義の版を持つ", async () => {
    const h = harness({ seed: labeledSeed() });
    await syncAll(h);
    const first = await loadPermits(h, {});
    await h.call("load_sheet", { name: "WO一覧", os: "MXAPIWO", select: ["WONUM", "SITEID", "DESCRIPTION"] });

    const entry = h.catalog.get(h.fake.baseUrl, "MXAPIWO")!;
    expect(first.structure).toEqual({ os: "MXAPIWO", baseUrl: entry.baseUrl, definitionLoadedAt: new Date(entry.loadedAt).toISOString() });
    for (const name of [PERMIT_SHEET, "WO一覧"]) {
      expect(h.workspace.getSheet(name).meta.source).toMatchObject({ kind: "maximo", os: "MXAPIWO", baseUrl: entry.baseUrl, structureLoadedAt: entry.loadedAt });
    }
    const found = await h.call("find_object_structures", { query: "申請完了日" });
    expect(found.structures[0].usedBySheets).toEqual([PERMIT_SHEET, "WO一覧"]);
    const desc = await h.call("describe_object_structure", { os: "MXAPIWO", query: "PERMITDATE" });
    expect(desc.usedBySheets).toEqual([PERMIT_SHEET, "WO一覧"]);
    // 反映先はシートを読み込んだ構造と接続先
    const commit = await h.call("request_commit", { sheet: PERMIT_SHEET, note: "確認" });
    expect(commit.target).toEqual({ os: "MXAPIWO", baseUrl: entry.baseUrl });
    const result = await h.call("get_commit_result", { sheet: "WO一覧" });
    expect(result.target).toEqual({ os: "MXAPIWO", baseUrl: entry.baseUrl });
  });

  it("list_object_structures は名前・説明で絞り込み、作業画面に定義を保存済みかを付ける", async () => {
    const h = harness();
    const res = await h.call("list_object_structures", { query: "work" });
    const names = res.objectStructures.map((o: { name: string }) => o.name);
    expect(names).toContain("MXAPIWO");
    expect(names).not.toContain("MXASSET");
    expect(res.objectStructures.find((o: { name: string }) => o.name === "MXAPIWO").loaded).toBe(false);

    await syncAll(h);
    const after = await h.call("list_object_structures", { query: "MXAPIWO" });
    expect(after.objectStructures[0]).toMatchObject({ name: "MXAPIWO", loaded: true });
  });

  it("list_object_structures の一覧は作業画面が覚え、cursor で続きを取る", async () => {
    const h = harness();
    const first = await h.call("list_object_structures", { limit: 1 });
    expect(first.returned).toBe(1);
    expect(first.total).toBeGreaterThan(1);
    expect(typeof first.nextCursor).toBe("string");
    const second = await h.call("list_object_structures", { limit: 1, cursor: first.nextCursor });
    expect(second.objectStructures[0].name).not.toBe(first.objectStructures[0].name);
    expect(apimetaRequests(h)).toBe(1);
  });

  it("LLM が構造を読み込むツールは無い（読み込みは作業画面が機械的に行う）", () => {
    expect(TAB_TOOL_NAMES as readonly string[]).not.toContain("load_object_structures");
    expect(TAB_TOOL_NAMES as readonly string[]).toContain("find_object_structures");
  });

  it("保存したオブジェクト構造は作業を作り直しても（同じカタログなら）Maximo に取りに行かない", async () => {
    const first = harness();
    await syncAll(first);
    const second = harness({ catalog: first.catalog });
    const res = await second.call("describe_object_structure", { os: "MXAPIWO", query: "PERMITDATE" });
    expect(res.fetchedNow).toBe(false);
    expect(res.columns.map((c: ColumnSchema) => c.name)).toEqual(["EXT_WOPERMIT.EXT_PERMITDATE"]);
    expect(schemaRequests(second)).toBe(0);
    await second.call("load_sheet", { name: PERMIT_SHEET, os: "MXAPIWO", select: SELECT, where: COMP_WHERE });
    expect(schemaRequests(second)).toBe(0);
  });

  it("describe_object_structure は保存済みの構造から要約と属性を返し、読み込み前に聞かれた構造はその場で読んで保存する", async () => {
    const h = harness();
    const res = await h.call("describe_object_structure", { os: "MXAPIWO" });
    expect(res.fetchedNow).toBe(true);
    expect(res.keyColumns).toEqual(["SITEID", "WONUM"]);
    expect(res.keyColumnsSource).toBe("schema");
    expect(res.children).toEqual(expect.arrayContaining([{ name: "EXT_WOPERMIT", idAttr: "EXT_WOPERMITID", columnCount: 5 }]));
    expect(res.childIdNote).toContain("実機確認");
    expect(res.columns.map((c: ColumnSchema) => c.name)).toEqual(expect.arrayContaining(["WONUM", "EXT_WOPERMIT.EXT_PERMITDATE"]));
    expect(res.columns.find((c: ColumnSchema) => c.name === "WONUM")).toEqual({ name: "WONUM", type: "string", title: "Work Order", maxLength: 12, required: true });
    expect(h.catalog.get(h.fake.baseUrl, "MXAPIWO")).not.toBeNull();

    const before = schemaRequests(h);
    const child = await h.call("describe_object_structure", { os: "mxapiwo", child: "ext_wopermit" });
    expect(schemaRequests(h)).toBe(before);
    expect(child.child).toBe("EXT_WOPERMIT");
    expect(child.columns.every((c: ColumnSchema) => c.name.startsWith("EXT_WOPERMIT."))).toBe(true);
    expect(child.columnCount).toBe(5);
  });

  it("describe_object_structure は query（名前・日本語ラベル。全角半角・大文字小文字を区別しない）と columns で絞る", async () => {
    const h = harness({ seed: bigSeed(20) });
    const byTitle = await h.call("describe_object_structure", { os: "MXBIGWO", query: "許可申請" });
    expect(byTitle.columns.map((c: ColumnSchema) => c.name)).toEqual(["EXT_NEEDPERMIT"]);
    expect(byTitle.matchedCount).toBe(1);
    const byName = await h.call("describe_object_structure", { os: "MXBIGWO", query: "ｅｘｔ＿ａｔｔｒ０００１" });
    expect(byName.columns.map((c: ColumnSchema) => c.name)).toEqual(["EXT_ATTR0001"]);
    const exact = await h.call("describe_object_structure", { os: "MXBIGWO", columns: ["wonum", "SITEID"] });
    expect(exact.columns.map((c: ColumnSchema) => c.name)).toEqual(["WONUM", "SITEID"]);
    const missing = await h.fail("describe_object_structure", { os: "MXBIGWO", columns: ["EXT_ATTR00001"] });
    expect(missing.code).toBe(RelayErrorCode.INVALID_ARGS);
    expect(missing.message).toContain("EXT_ATTR0001");
  });

  it("属性が数百あっても結果は上限に収め、nextCursor と絞り方の案内を返す", async () => {
    const h = harness({ seed: bigSeed(800) });
    const seen = new Set<string>();
    let cursor: string | undefined;
    let calls = 0;
    let first: Record<string, any> | null = null;
    do {
      const res = await h.call("describe_object_structure", { os: "MXBIGWO", limit: 200, ...(cursor === undefined ? {} : { cursor }) });
      first ??= res;
      expect(new TextEncoder().encode(JSON.stringify(res)).length).toBeLessThanOrEqual(MAX_RESULT_TEXT_BYTES);
      for (const c of res.columns) seen.add(c.name as string);
      cursor = res.nextCursor ?? undefined;
      calls++;
    } while (cursor !== undefined && calls < 20);
    expect(first?.hint).toContain("query");
    expect(first?.columnCount).toBe(803);
    expect(seen.size).toBe(803);
    expect(schemaRequests(h)).toBe(1);
  });

  it("scope_options は構造から絞り込みの軸を機械的に選び、走査した行を作業画面のシートに入れてから軸ごとの候補値と件数を返す", async () => {
    const h = harness();
    const res = await h.call("scope_options", { os: "MXAPIWO" });
    expect(res.os).toBe("MXAPIWO");
    const names = res.axes.map((a: { name: string }) => a.name);
    expect(names).toContain("STATUS");
    expect(names).toContain("WONUM");
    const status = res.axes.find((a: { name: string }) => a.name === "STATUS");
    expect(status).toMatchObject({ kind: "value", reason: "状態" });
    expect(status.values).toEqual(expect.arrayContaining([{ value: "COMP", count: 2 }]));
    expect(res.scanned).toBe(3);
    expect(res.note).toContain("load_sheet の where");
    // Claude が読んだ行は、利用者も作業画面で同じものを見られる（キー列と軸の列だけのシート）
    expect(res).toMatchObject({ sheet: "範囲 MXAPIWO", replaced: false });
    const sheet = h.workspace.summary("範囲 MXAPIWO");
    expect(sheet.rowCount).toBe(3);
    expect(sheet.source).toMatchObject({ kind: "maximo", os: "MXAPIWO" });
    expect(sheet.columns.map((c) => c.name)).toEqual(expect.arrayContaining([...sheet.keyColumns, ...names]));
    // 数えた件数はシートの行と同じ
    const agg = await h.call("aggregate", { sheet: "範囲 MXAPIWO", groupBy: ["STATUS"] });
    expect(agg.groups).toEqual(expect.arrayContaining([{ key: { STATUS: "COMP" }, count: 2 }]));
  });

  it("scope_options: name でシート名を変えられる。未反映の変更がある同名のシートは置き換えない", async () => {
    const h = harness();
    const first = await h.call("scope_options", { os: "MXAPIWO", name: "範囲の確認" });
    expect(first.sheet).toBe("範囲の確認");
    const again = await h.call("scope_options", { os: "MXAPIWO", name: "範囲の確認", where: [{ attr: "STATUS", op: "eq", value: "COMP" }] });
    expect(again).toMatchObject({ replaced: true, scanned: 2 });
    const rowKey = (await h.call("query_rows", { sheet: "範囲の確認" })).rows[0].rowKey;
    h.workspace.applyEdits("範囲の確認", [{ rowKey, col: "STATUS", value: "WAPPR" }], { author: "user" });
    const e = await h.fail("scope_options", { os: "MXAPIWO", name: "範囲の確認" });
    expect(e.message).toContain("未反映の変更");
  });

  it("scope_options は where で絞った中の分布を返し、axes で軸を名指しできる。無い列は候補付きで断る", async () => {
    const h = harness();
    const narrowed = await h.call("scope_options", { os: "MXAPIWO", where: [{ attr: "STATUS", op: "eq", value: "COMP" }], axes: ["wonum"] });
    expect(narrowed.scanned).toBe(2);
    expect(narrowed.axes).toHaveLength(1);
    expect(narrowed.axes[0]).toMatchObject({ name: "WONUM", kind: "key", reason: "番号の規則" });
    expect(narrowed.axes[0].patterns).toEqual([{ pattern: "WO####", count: 2, example: "WO2001" }]);

    const e = await h.fail("scope_options", { os: "MXAPIWO", axes: ["STATUSS"] });
    expect(e.code).toBe(RelayErrorCode.INVALID_ARGS);
    expect(e.message).toContain("STATUS");
    const child = await h.fail("scope_options", { os: "MXAPIWO", axes: ["EXT_WOPERMIT.EXT_AUTHORITY"] });
    expect(child.message).toContain("親の属性");
  });

  it("load_master は読み込み済みのシートが参照している値だけマスタから読み、つながりと見つからなかった数を返す", async () => {
    const seed = sampleSeed();
    const asset = seed.objectStructures.MXASSET!;
    asset.attrs.ext_equiptag = { type: "string", maxLength: 30, title: "タグ番号" };
    asset.records = [
      { attrs: { siteid: "BEDFORD", assetnum: "P-100", description: "ポンプ100", ext_equiptag: "P-100" } },
      { attrs: { siteid: "BEDFORD", assetnum: "P-101", description: "ポンプ101", ext_equiptag: "P-101" } },
      // P-102 は機器台帳に無い（参照元にあってマスタに無い値）
      { attrs: { siteid: "BEDFORD", assetnum: "V-200", description: "弁200", ext_equiptag: "V-200" } },
    ];
    const h = harness({ seed });
    await h.call("load_sheet", { name: "複数機器", os: "MXAPIWO", select: ["WONUM", "SITEID", "MULTIASSETLOCCI.ASSETNUM", "MULTIASSETLOCCI.LOCATION"] });

    const master = await h.call("load_master", {
      name: "機器台帳",
      os: "MXASSET",
      select: ["ASSETNUM", "DESCRIPTION", "EXT_EQUIPTAG"],
      fromSheet: "複数機器",
      from: "multiassetlocci.assetnum",
      to: "assetnum",
    });
    expect(master).toMatchObject({
      sheet: "機器台帳",
      os: "MXASSET",
      rowCount: 3,
      requestedValues: 4,
      matchedValues: 3,
      link: { sheet: "複数機器", from: "MULTIASSETLOCCI.ASSETNUM", to: "ASSETNUM" },
    });
    expect(master.unmatchedNote).toContain("1 種類");
    // Maximo へは参照元に出てきた値だけを条件にして問い合わせる（全件を読まない）
    const query = decodeURIComponent(h.fake.state.requests.filter((r) => r.path.includes("/os/mxasset"))[0]!.path);
    expect(query).toContain('assetnum in ["P-100","P-101","P-102","V-200"]');
    // つながりはシートに残る（画面が関連シートを並べて連動させるため）
    expect(h.workspace.getSheet("機器台帳").meta.link).toEqual({ sheet: "複数機器", from: "MULTIASSETLOCCI.ASSETNUM", to: "ASSETNUM" });

    const missing = await h.fail("load_master", { name: "x", os: "MXASSET", select: ["ASSETNUM"], fromSheet: "複数機器", from: "ASSETNUMS", to: "ASSETNUM" });
    expect(missing.code).toBe(RelayErrorCode.INVALID_ARGS);
    expect(missing.message).toContain("MULTIASSETLOCCI.ASSETNUM");
    const same = await h.fail("load_master", { name: "複数機器", os: "MXASSET", select: ["ASSETNUM"], fromSheet: "複数機器", from: "WONUM", to: "ASSETNUM" });
    expect(same.message).toContain("別の名前");
  });

  it("get_status は保存済みの件数、Maximo に定義された数と API で使えない数、機械的な読み込みの進み具合を返す（数百件あるので名前は載せない）", async () => {
    const h = harness({ seed: withDefinitions(permitSeed(), [{ name: "DMMAXAPPS", usewith: "マイグレーション・マネージャー" }]) });
    // permitSeed の構造と MXAPIINTOBJECT
    const n = Object.keys(permitSeed().objectStructures).length + 1;
    await syncAll(h);
    const st = await h.call("get_status");
    expect(st.objectStructures).toEqual({
      savedCount: n,
      availableCount: n,
      definedCount: n + 1,
      notApiCount: 1,
      sync: { state: "done", done: n, total: n, failedCount: 0 },
      structuresUrl: "https://mxstage.test/structures",
    });
  });

  it("get_status は Maximo の定義の一覧を読めず apimeta の一覧だけで読み込んだとき、構造が漏れうることを知らせる", async () => {
    const h = harness();
    await syncAll(h);
    const st = await h.call("get_status");
    expect(st.objectStructures.definedCount).toBeUndefined();
    expect(st.objectStructures.listNote).toContain("MXAPIINTOBJECT");
  });

  it("apimeta に載らない構造（顧客が作った EXT_* など）も、読み込んだ後は find_object_structures と list_object_structures で見つかる", async () => {
    const seed = permitSeed();
    seed.objectStructures.EXT_WOPERMIT = {
      description: "J5データ移行（許可申請テーブル単独）",
      hiddenFromApimeta: true,
      keyAttrs: ["ext_wopermitid"],
      attrs: { ext_wopermitid: { type: "integer", required: true }, wonum: { type: "string", title: "工事管理No." }, ext_permitdate: { type: "date", title: "許可取得日" } },
    };
    const h = harness({ seed: withDefinitions(seed) });
    await syncAll(h);
    const found = await h.call("find_object_structures", { query: "許可取得日" });
    expect(found.structures.map((s: { os: string }) => s.os)).toEqual(["EXT_WOPERMIT"]);
    expect(found.structures[0].keyColumns).toEqual(["EXT_WOPERMITID"]);
    const listed = await h.call("list_object_structures", { query: "EXT_" });
    expect(listed.objectStructures).toEqual([{ name: "EXT_WOPERMIT", loaded: true, description: "J5データ移行（許可申請テーブル単独）" }]);
  });

  it("無い子オブジェクト・無いオブジェクト構造は INVALID_ARGS と候補", async () => {
    const h = harness();
    const child = await h.fail("describe_object_structure", { os: "MXAPIWO", child: "EXT_AUTHORITY" });
    expect(child.code).toBe(RelayErrorCode.INVALID_ARGS);
    expect(child.message).toContain("EXT_WOPERMIT");
    const os = await h.fail("describe_object_structure", { os: "MXNOPE" });
    expect(os.code).toBe(RelayErrorCode.INVALID_ARGS);
    expect(os.message).toContain("find_object_structures");
  });
});

describe("load_sheet", () => {
  it("親と子を読み込み、キー列と子の ID 列を足してシートにする", async () => {
    const h = harness();
    const progress: number[] = [];
    const res = await loadPermits(h, {});
    expect(res.rowCount).toBe(3);
    expect(res.parentCount).toBe(2);
    expect(res.replaced).toBe(false);
    expect(res.keyColumns).toEqual(["SITEID", "WONUM"]);
    expect(res.keyColumnsSource).toBe("schema");
    expect(res.childIdAttrs).toEqual({ EXT_WOPERMIT: "EXT_WOPERMITID" });
    expect(res.addedColumns).toEqual(["EXT_WOPERMIT.EXT_WOPERMITID"]);
    expect(res.truncatedByMaxRows).toBe(false);
    expect(res.columns).toEqual([
      "SITEID",
      "WONUM",
      "STATUS",
      "DESCRIPTION",
      "EXT_WOPERMIT.EXT_WOPERMITID",
      "EXT_WOPERMIT.EXT_AUTHORITY",
      "EXT_WOPERMIT.EXT_PERMITTYPE",
      "EXT_WOPERMIT.EXT_PERMITDATE",
      "EXT_WOPERMIT.EXT_MEMO",
    ]);
    expect(h.workspace.getSheet(PERMIT_SHEET).rowKeys("final")).toEqual([ck("WO2001", 1001), ck("WO2001", 1002), ck("WO2002", 1003)]);
    const get = h.fake.state.requests.find((r) => r.path.startsWith("/maximo/api/os/mxapiwo?"))!;
    expect(new URL(get.url).searchParams.get("oslc.where")).toBe('status="COMP"');

    // 進捗はツールの ctx へ送る
    const h2 = harness();
    await h2.call("load_sheet", { name: PERMIT_SHEET, os: "MXAPIWO", select: SELECT }, { progress: (p) => progress.push(p) });
    expect(progress.length).toBeGreaterThan(0);
  });

  it("子の属性の条件は Maximo へ送らず作業画面で絞り込む", async () => {
    const h = harness();
    const res = await h.call("load_sheet", {
      name: "届出",
      os: "MXAPIWO",
      select: SELECT,
      where: [{ attr: "EXT_WOPERMIT.EXT_PERMITTYPE", op: "eq", value: "届出" }],
    });
    expect(res.rowCount).toBe(3);
    expect(res.parentCount).toBe(3);
    expect(res.childFilterNote).toContain("作業画面で絞り込みました");
    const get = h.fake.state.requests.find((r) => r.path.startsWith("/maximo/api/os/mxapiwo?"))!;
    expect(new URL(get.url).searchParams.has("oslc.where")).toBe(false);
  });

  it("子の属性の条件の値が不正なら、Maximo を読み始める前に INVALID_ARGS にする", async () => {
    const h = harness();
    const e = await h.fail("load_sheet", {
      name: PERMIT_SHEET,
      os: "MXAPIWO",
      select: SELECT,
      where: [{ attr: "EXT_WOPERMIT.EXT_PERMITDATE", op: "gt", value: true }],
    });
    expect(e.code).toBe(RelayErrorCode.INVALID_ARGS);
    expect(e.message).toContain("EXT_WOPERMIT.EXT_PERMITDATE");
    // 全ページを読み終えてから引数の誤りで失敗させない（コレクションの GET は 1 回も出ていない）
    expect(h.fake.state.requests.filter((r) => r.path.startsWith("/maximo/api/os/mxapiwo?"))).toHaveLength(0);
    expect(h.workspace.hasSheet(PERMIT_SHEET)).toBe(false);
  });

  it("オブジェクト構造に無い列は INVALID_ARGS と近い列名", async () => {
    const h = harness();
    const select = await h.fail("load_sheet", { name: "x", os: "MXAPIWO", select: ["WONUM", "EXT_PERMITDATE"] });
    expect(select.code).toBe(RelayErrorCode.INVALID_ARGS);
    expect(select.message).toContain("EXT_WOPERMIT.EXT_PERMITDATE");
    const where = await h.fail("load_sheet", { name: "x", os: "MXAPIWO", select: ["WONUM"], where: [{ attr: "STATU", op: "eq", value: "COMP" }] });
    expect(where.message).toContain("STATUS");
  });

  it("同名シートに未反映の変更があれば置き換えず TOOL_ERROR", async () => {
    const h = harness();
    await loadPermits(h);
    const again = await loadPermits(h);
    expect(again.replaced).toBe(true);
    await h.call("patch_cells", {
      sheet: PERMIT_SHEET,
      edits: [{ rowKey: ck("WO2001", 1001), col: "EXT_WOPERMIT.EXT_MEMO", value: "編集中" }],
      baseRevision: h.workspace.revision,
      reason: "テスト",
    });
    const e = await h.fail("load_sheet", { name: PERMIT_SHEET, os: "MXAPIWO", select: SELECT, where: COMP_WHERE });
    expect(e.code).toBe(RelayErrorCode.TOOL_ERROR);
    expect(e.message).toContain("別のシート名");
    expect(h.workspace.getSheet(PERMIT_SHEET).counts().changedCells).toBe(1);
  });

  it("締切までに終わらなければジョブにし、get_job で結果の要約を返す", async () => {
    const h = harness({ fetchWrap: slow(40) });
    const res = await h.call("load_sheet", { name: PERMIT_SHEET, os: "MXAPIWO", select: SELECT }, { timeoutMs: 60 });
    expect(res.state).toBe("running");
    expect(typeof res.jobId).toBe("string");
    expect(res.message).toContain("get_job");
    const job = await vi.waitFor(
      () => {
        const j = h.jobs.getJob(res.jobId);
        expect(j.state).toBe("done");
        return j;
      },
      { timeout: 5_000, interval: 10 },
    );
    expect((job.result as Record<string, unknown>).rowCount).toBe(4);
    const viaTool = await h.call("get_job", { jobId: res.jobId });
    expect(viaTool.state).toBe("done");
    expect(h.workspace.hasSheet(PERMIT_SHEET)).toBe(true);
  });

  it("ジョブにする前に取り消されたら読み込みを止める", async () => {
    const h = harness();
    const ac = new AbortController();
    ac.abort();
    const e = await h.fail("load_sheet", { name: PERMIT_SHEET, os: "MXAPIWO", select: SELECT }, { signal: ac.signal });
    expect(e.message).toContain("中断");
    expect(h.workspace.hasSheet(PERMIT_SHEET)).toBe(false);
  });

  it("無い jobId は INVALID_ARGS", async () => {
    const h = harness();
    const e = await h.fail("get_job", { jobId: "job999-abcdef" });
    expect(e.code).toBe(RelayErrorCode.INVALID_ARGS);
  });
});

describe("参照のツール", () => {
  it("query_rows は rows と dataNotice を返し、長いセルを切り詰める", async () => {
    const h = harness();
    excelSheet(h.workspace, "メモ", ["ID", "TEXT"], [{ ID: "r1", TEXT: "あ".repeat(1_500) }, { ID: "r2", TEXT: "短い" }], ["ID"]);
    const res = await h.call("query_rows", { sheet: "メモ", columns: ["ID", "TEXT"] });
    expect(res.dataNotice).toBe(DATA_NOTICE);
    expect(res.total).toBe(2);
    expect([...(res.rows[0].values.TEXT as string)]).toHaveLength(MAX_CELL_CHARS);
    expect(res.rows[0].truncated).toEqual(["TEXT"]);
    expect(res.truncatedNote).toContain(String(MAX_CELL_CHARS));
    expect(res.rows[1].truncated).toBeUndefined();
  });

  it("結果が上限（MAX_RESULT_TEXT_BYTES）を超えたら件数を減らし、nextCursor で続きを返す", async () => {
    const h = harness();
    const rows = Array.from({ length: 200 }, (_, i) => ({ ID: `r${i}`, TEXT: "x".repeat(900) }));
    excelSheet(h.workspace, "大きい", ["ID", "TEXT"], rows, ["ID"]);
    const seen = new Set<string>();
    let cursor: string | undefined;
    let calls = 0;
    do {
      const res = await h.call("query_rows", { sheet: "大きい", limit: 200, ...(cursor === undefined ? {} : { cursor }) });
      expect(new TextEncoder().encode(JSON.stringify(res)).length).toBeLessThanOrEqual(MAX_RESULT_TEXT_BYTES);
      expect(res.returned).toBeGreaterThan(0);
      for (const r of res.rows) seen.add(r.rowKey as string);
      cursor = res.nextCursor ?? undefined;
      calls++;
    } while (cursor !== undefined && calls < 20);
    expect(calls).toBeGreaterThan(1);
    expect(seen.size).toBe(200);
  });

  it("aggregate と match_sheets は件数とサンプルを返す", async () => {
    const h = harness();
    await loadPermits(h);
    const agg = await h.call("aggregate", { sheet: PERMIT_SHEET, groupBy: ["EXT_WOPERMIT.EXT_PERMITTYPE"] });
    expect(agg.groups).toEqual([
      { key: { "EXT_WOPERMIT.EXT_PERMITTYPE": "届出" }, count: 2 },
      { key: { "EXT_WOPERMIT.EXT_PERMITTYPE": "申請" }, count: 1 },
    ]);
    expect(agg.dataNotice).toBe(DATA_NOTICE);

    excelSheet(h.workspace, "参照", ["AUTHORITY"], [{ AUTHORITY: "消防" }, { AUTHORITY: "県" }, { AUTHORITY: "国" }], ["AUTHORITY"]);
    const match = await h.call("match_sheets", { left: PERMIT_SHEET, right: "参照", leftCol: "EXT_WOPERMIT.EXT_AUTHORITY", rightCol: "AUTHORITY" });
    expect(match).toMatchObject({ matched: 2, unmatchedLeft: 1, unmatchedRight: 1, ambiguous: 0 });
    expect(match.samples.unmatchedLeft[0].key).toBe("労基");
    expect(match.dataNotice).toBe(DATA_NOTICE);
  });

  it("無い列・無いシートは INVALID_ARGS と近い名前", async () => {
    const h = harness();
    await loadPermits(h);
    const col = await h.fail("query_rows", { sheet: PERMIT_SHEET, columns: ["DESCRIPTON"] });
    expect(col.code).toBe(RelayErrorCode.INVALID_ARGS);
    expect(col.message).toContain("DESCRIPTION");
    const group = await h.fail("aggregate", { sheet: PERMIT_SHEET, groupBy: ["status"] });
    expect(group.message).toContain("STATUS");
    const sheet = await h.fail("query_rows", { sheet: "許可" });
    expect(sheet.code).toBe(RelayErrorCode.INVALID_ARGS);
    expect(sheet.message).toContain(PERMIT_SHEET);
  });
});

describe("変更のツール", () => {
  it("patch_cells は author llm・セルごとの reason で変更し、conflicts に列の候補を添える", async () => {
    const h = harness();
    await loadPermits(h);
    const baseRevision = h.workspace.revision;
    const res = await h.call("patch_cells", {
      sheet: PERMIT_SHEET,
      baseRevision,
      reason: "バッチの根拠",
      edits: [
        { rowKey: ck("WO2001", 1002), col: "EXT_WOPERMIT.EXT_MEMO", value: "確認済み", reason: "行ごとの根拠" },
        { rowKey: ck("WO2001", 1002), col: "EXT_WOPERMIT.EXT_MEM", value: "x" },
      ],
    });
    expect(res.applied).toBe(1);
    expect(res.conflicts).toEqual([{ rowKey: ck("WO2001", 1002), col: "EXT_WOPERMIT.EXT_MEM", reason: "column_not_found" }]);
    expect(res.columnSuggestions["EXT_WOPERMIT.EXT_MEM"]).toContain("EXT_WOPERMIT.EXT_MEMO");
    expect(h.workspace.cell(PERMIT_SHEET, ck("WO2001", 1002), "EXT_WOPERMIT.EXT_MEMO")).toMatchObject({ value: "確認済み", author: "llm", reason: "行ごとの根拠" });

    const stale = await h.call("patch_cells", {
      sheet: PERMIT_SHEET,
      baseRevision,
      reason: "もう一度",
      edits: [{ rowKey: ck("WO2001", 1002), col: "EXT_WOPERMIT.EXT_MEMO", value: "上書き" }],
    });
    expect(stale.applied).toBe(0);
    expect(stale.conflicts[0].reason).toBe("changed_since_read");
  });

  it("get_diff の changedColumns は列名が constructor でも件数を返す", async () => {
    const h = harness();
    excelSheet(h.workspace, "行", ["ID", "constructor"], [{ ID: "r1", constructor: "a" }], ["ID"]);
    const key = makeParentKey(["r1"]);
    await h.call("patch_cells", {
      sheet: "行",
      edits: [{ rowKey: key, col: "constructor", value: "b" }],
      baseRevision: h.workspace.revision,
      reason: "テスト",
    });
    const diff = await h.call("get_diff", { sheet: "行" });
    expect(diff.changedCells).toBe(1);
    expect(Object.entries(diff.changedColumns)).toEqual([["constructor", 1]]);
  });

  it("例 (a): apply_rule で申請完了日を変更すると、get_diff にその列だけが出て request_commit が件数を返す", async () => {
    const h = harness();
    await loadPermits(h);
    const rule = {
      sheet: PERMIT_SHEET,
      filter: [{ attr: "EXT_WOPERMIT.EXT_PERMITTYPE", op: "eq", value: "届出" }],
      set: { "EXT_WOPERMIT.EXT_PERMITDATE": { const: "2027-03-31" } },
      baseRevision: h.workspace.revision,
      reason: "利用者の依頼により、完了済み許可申請の申請完了日を変更",
    };
    const dry = await h.call("apply_rule", { ...rule, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, matched: 2, applied: 2, batchId: null });

    const applied = await h.call("apply_rule", rule);
    expect(applied.applied).toBe(2);
    expect(typeof applied.batchId).toBe("string");

    const diff = await h.call("get_diff", { sheet: PERMIT_SHEET });
    expect(diff).toMatchObject({ changedCells: 2, addedRows: 0, deletedRows: 0 });
    expect(diff.changedColumns).toEqual({ "EXT_WOPERMIT.EXT_PERMITDATE": 2 });
    expect(diff.rows.map((r: { col: string }) => r.col)).toEqual(["EXT_WOPERMIT.EXT_PERMITDATE", "EXT_WOPERMIT.EXT_PERMITDATE"]);
    expect(diff.rows[0]).toMatchObject({ kind: "change", author: "llm", before: "2026-04-01", after: "2027-03-31" });
    expect(diff.dataNotice).toBe(DATA_NOTICE);

    const req = await h.call("request_commit", { sheet: PERMIT_SHEET, note: "完了済み許可申請 2 件の申請完了日を 2027-03-31 に変更" });
    expect(req).toMatchObject({ state: "requested", blockers: [], counts: { parents: 2, changedCells: 2, addedRows: 0, deletedRows: 0 } });
    expect(req.message).toContain("[Maximo に反映]");
    expect(req.message).toContain("get_commit_result");

    const result = await h.call("get_commit_result", { sheet: PERMIT_SHEET });
    expect(result).toMatchObject({ sheet: PERMIT_SHEET, state: "requested", results: [] });
    expect(result.note).toContain("申請完了日");
  });

  it("add_rows / delete_rows / undo_batch（author llm）", async () => {
    const h = harness();
    await loadPermits(h);
    const add = await h.call("add_rows", {
      sheet: PERMIT_SHEET,
      parentRowKey: ck("WO2002", 1003),
      rows: [{ "EXT_WOPERMIT.EXT_AUTHORITY": "市", "EXT_WOPERMIT.EXT_PERMITTYPE": "届出" }],
      baseRevision: h.workspace.revision,
      reason: "申請を追加",
    });
    expect(add.applied).toBe(1);
    expect(add.rowKeys).toHaveLength(1);

    const del = await h.call("delete_rows", { sheet: PERMIT_SHEET, rowKeys: [ck("WO2001", 1002)], baseRevision: h.workspace.revision, reason: "取り下げ" });
    expect(del.applied).toBe(1);
    expect(await h.call("get_diff", { sheet: PERMIT_SHEET })).toMatchObject({ addedRows: 1, deletedRows: 1 });

    const undo = await h.call("undo_batch", { batchId: add.batchId });
    expect(undo).toMatchObject({ sheet: PERMIT_SHEET, applied: 1, undone: true });
    expect((await h.call("get_diff", { sheet: PERMIT_SHEET })).addedRows).toBe(0);
    expect(h.workspace.listBatches().every((b) => b.author === "llm")).toBe(true);

    expect((await h.fail("undo_batch", { batchId: add.batchId })).code).toBe(RelayErrorCode.TOOL_ERROR);
    expect((await h.fail("undo_batch", { batchId: "b999-abcdef" })).code).toBe(RelayErrorCode.INVALID_ARGS);
  });

  it("反映中のシートへの編集系ツールは BUSY（読み取りは通る）", async () => {
    const running = new Set<string>();
    const h = harness({ commits: stubCommits(running) });
    await loadPermits(h);
    const patch = await h.call("patch_cells", {
      sheet: PERMIT_SHEET,
      edits: [{ rowKey: ck("WO2001", 1001), col: "EXT_WOPERMIT.EXT_MEMO", value: "先に変更" }],
      baseRevision: h.workspace.revision,
      reason: "準備",
    });
    running.add(PERMIT_SHEET);

    const cases: Array<[string, unknown]> = [
      ["patch_cells", { sheet: PERMIT_SHEET, edits: [{ rowKey: ck("WO2001", 1001), col: "EXT_WOPERMIT.EXT_MEMO", value: "x" }], baseRevision: h.workspace.revision, reason: "x" }],
      ["apply_rule", { sheet: PERMIT_SHEET, set: { "EXT_WOPERMIT.EXT_MEMO": { const: "x" } }, baseRevision: h.workspace.revision, reason: "x" }],
      ["add_rows", { sheet: PERMIT_SHEET, rows: [{ SITEID: "BEDFORD", WONUM: "WO9999" }], baseRevision: h.workspace.revision, reason: "x" }],
      ["delete_rows", { sheet: PERMIT_SHEET, rowKeys: [ck("WO2001", 1001)], baseRevision: h.workspace.revision, reason: "x" }],
      ["undo_batch", { batchId: patch.batchId }],
      ["request_commit", { sheet: PERMIT_SHEET, note: "x" }],
      ["load_sheet", { name: PERMIT_SHEET, os: "MXAPIWO", select: SELECT }],
    ];
    for (const [tool, args] of cases) {
      const e = await h.fail(tool, args);
      expect(e.code, tool).toBe(RelayErrorCode.BUSY);
    }
    expect((await h.call("query_rows", { sheet: PERMIT_SHEET })).total).toBe(3);
  });
});

describe("補助関数", () => {
  it("settingsUrlOf は appUrl のオリジンから設定画面の URL を作る", () => {
    expect(settingsUrlOf(APP_URL)).toBe(SETTINGS_URL);
    expect(settingsUrlOf("https://example.test/app/")).toBe("https://example.test/settings");
  });

  it("loadWaitBudget は締切の手前で打ち切り、20 秒を超えない", () => {
    expect(loadWaitBudget(1_000_000 + 45_000, 1_000_000)).toBe(20_000);
    expect(loadWaitBudget(1_000_000 + 5_000, 1_000_000)).toBe(4_500);
    expect(loadWaitBudget(1_000_000 + 100, 1_000_000)).toBe(90);
    expect(loadWaitBudget(1_000_000, 1_000_000)).toBe(0);
  });

  it("キー列はスキーマの主キーから決め、無ければ推定して実機確認が要ることを示す", () => {
    const col = (name: string, required = false): ColumnSchema => ({ name, type: "string", ...(required ? { required: true } : {}) });
    expect(resolveKeyColumns({ keyColumns: ["SITEID", "WONUM"], columns: [col("SITEID"), col("WONUM")] })).toEqual({ keyColumns: ["SITEID", "WONUM"], source: "schema" });

    const inferred = resolveKeyColumns({ keyColumns: [], columns: [col("SITEID", true), col("WONUM", true), col("DESCRIPTION")] });
    expect(inferred.keyColumns).toEqual(["SITEID", "WONUM"]);
    expect(inferred.source).toBe("inferred");
    expect(inferred.note).toContain("実機確認");

    const href = resolveKeyColumns({ keyColumns: [], columns: [col("ANUM", true), col("BNUM", true)] });
    expect(href.keyColumns).toEqual([]);
    expect(href.source).toBe("href");
    expect(href.note).toContain("実機確認");
  });

  it("suggestNames は大文字小文字・子の接頭辞・綴りの近さで候補を出す", () => {
    const cols = ["SITEID", "WONUM", "DESCRIPTION", "EXT_WOPERMIT.EXT_PERMITDATE", "EXT_WOPERMIT.EXT_MEMO"];
    expect(suggestNames("description", cols)[0]).toBe("DESCRIPTION");
    expect(suggestNames("EXT_PERMITDATE", cols)[0]).toBe("EXT_WOPERMIT.EXT_PERMITDATE");
    expect(suggestNames("EXT_WOPERMIT.EXT_MEM", cols)[0]).toBe("EXT_WOPERMIT.EXT_MEMO");
    expect(suggestNames("まったく違う名前", cols)).toEqual([]);
  });
});
