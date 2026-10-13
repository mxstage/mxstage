// 作業画面の辞書（src/app/dictionaries）と、辞書を使った突き合わせの結果（src/app/match/views.ts）、そのツール。
import { describe, expect, it } from "vitest";
import { DictionaryClient, type BridgeResult, type DictionaryListing, type DictionaryState, type HistoryItem } from "../../src/app/dictionaries/client";
import { DictionaryService } from "../../src/app/dictionaries/service";
import { pendingChanges, type SaveOp } from "../../src/app/dictionaries/sheet";
import { MatchViewStore } from "../../src/app/match/views";
import type { CommitRequester, ConnectionProvider, MaximoConnection } from "../../src/app/runtime/contracts";
import { JobRegistry, Workspace } from "../../src/app/store";
import { createToolRegistry } from "../../src/app/tools/registry";
import { ObjectStructureCatalog } from "../../src/app/catalog/catalog";
import type { DictionaryEntry } from "../../src/shared/dictionary";
import { DICT_FIND, DICT_MODE, DICT_TO } from "../../src/shared/dictionarySheet";
import type { CellValue } from "../../src/shared/model";
import type { InvokeMsg } from "../../src/shared/protocol";
import { makeParentKey, type SheetRow } from "../../src/shared/sheet";
import type { ToolName } from "../../src/shared/toolDefs";

const SCOPE = "c_0123456789abcdef";
const ME = { id: "m_aaaaaaaaaaaaaaaa", name: "武藤" };

/** 橋渡しの代わり（メモリの中だけ）。保存すると版が変わり、履歴が増える */
class FakeClient extends DictionaryClient {
  dicts = new Map<string, { id: string; name: string; entries: DictionaryEntry[]; history: HistoryItem[] }>();
  version = 1;
  saves: SaveOp[][] = [];
  seq = 0;

  constructor() {
    super(async () => new Response("{}"));
  }

  add(name: string, entries: Array<[string, string, "text" | "regex"]> = []): string {
    const id = `d_${String(++this.seq).padStart(16, "0")}`;
    this.dicts.set(id, {
      id,
      name,
      entries: entries.map(([find, to, mode], i) => ({ id: `e_${String(i + 1).padStart(16, "0")}`, find, to, mode, note: "", rev: 1, updatedAt: "2026-10-08T00:00:00Z", updatedBy: "武藤" })),
      history: [],
    });
    return id;
  }

  private state(id: string): DictionaryState {
    const d = this.dicts.get(id)!;
    return { dictionary: { id, name: d.name, kind: "alias", description: "", createdAt: "", createdBy: "" }, entries: d.entries.map((e) => ({ ...e })), history: d.history, problems: [], version: String(this.version) };
  }

  private find(nameOrId: string): string | null {
    for (const d of this.dicts.values()) if (d.id === nameOrId || d.name === nameOrId) return d.id;
    return null;
  }

  override async list(): Promise<BridgeResult<DictionaryListing>> {
    return {
      ok: true,
      value: {
        folder: { path: "C:\\share", sync: "onedrive-business", reachable: true, writable: true },
        member: ME,
        dictionaries: Array.from(this.dicts.values()).map((d) => ({ id: d.id, name: d.name, kind: "alias", description: "", createdAt: "", createdBy: "", count: d.entries.length, updatedAt: null, updatedBy: null })),
        version: String(this.version),
      },
    };
  }

  override async get(_scope: string, nameOrId: string): Promise<BridgeResult<DictionaryState>> {
    const id = this.find(nameOrId);
    return id === null ? { ok: false, error: "not_found", message: "There is no dictionary", status: 404 } : { ok: true, value: this.state(id) };
  }

  override async create(_scope: string, name: string): Promise<BridgeResult<DictionaryState>> {
    if (this.find(name) !== null) return { ok: false, error: "name_taken", message: "taken", status: 409 };
    const id = this.add(name);
    this.version++;
    return { ok: true, value: this.state(id) };
  }

  override async save(_scope: string, id: string, ops: readonly SaveOp[]): Promise<BridgeResult<DictionaryState & { saveId: string; ids: string[] }>> {
    const d = this.dicts.get(id)!;
    this.saves.push([...ops]);
    const ids: string[] = [];
    for (const op of ops) {
      if (op.op === "delete") {
        d.entries = d.entries.filter((e) => e.id !== op.id);
        ids.push(op.id);
        continue;
      }
      const eid = op.id ?? `e_${String(100 + d.entries.length).padStart(16, "0")}`;
      const prev = d.entries.find((e) => e.id === eid);
      const next = { id: eid, ...op.entry, rev: (prev?.rev ?? 0) + 1, updatedAt: "2026-10-13T01:00:00Z", updatedBy: ME.name };
      d.entries = prev ? d.entries.map((e) => (e.id === eid ? next : e)) : [...d.entries, next];
      ids.push(eid);
    }
    d.history = [{ saveId: `s_${String(d.history.length + 1).padStart(16, "0")}`, at: "2026-10-13T01:00:00Z", by: ME.name, byId: ME.id, added: ops.filter((o) => o.op === "put" && !o.id).length, changed: 0, deleted: 0, sample: null, revertible: true }, ...d.history];
    this.version++;
    return { ok: true, value: { ...this.state(id), saveId: d.history[0]!.saveId, ids } };
  }

  /** ほかのメンバー（田中）が保存した */
  remoteSave(id: string, find: string, to: string): void {
    const d = this.dicts.get(id)!;
    d.entries = [...d.entries, { id: `e_${String(200 + d.entries.length).padStart(16, "0")}`, find, to, mode: "text", note: "", rev: 1, updatedAt: "2026-10-13T02:00:00Z", updatedBy: "田中" }];
    d.history = [{ saveId: "s_9999999999999999", at: "2026-10-13T02:00:00Z", by: "田中", byId: "m_bbbbbbbbbbbbbbbb", added: 1, changed: 0, deleted: 0, sample: find, revertible: true }, ...d.history];
    this.version++;
  }
}

function connectionOf(): ConnectionProvider & { conn: MaximoConnection } {
  const conn = { info: { baseUrl: "https://maximo.example.com", via: "proxy", connectionName: "北部", userName: null, connectedAt: 0, savedId: SCOPE }, client: {} } as unknown as MaximoConnection;
  return { conn, current: () => conn, subscribe: () => () => undefined };
}

function excelSheet(ws: Workspace, name: string, columns: string[], rows: Array<Record<string, CellValue>>, key: string, source: "excel" | "maximo" = "excel"): void {
  const sheetRows: SheetRow[] = rows.map((r) => {
    const k = makeParentKey([r[key] ?? null]);
    return { rowKey: k, parentKey: k, childName: null, values: r };
  });
  ws.createSheet(
    {
      name,
      source: source === "excel" ? { kind: "excel", importId: "i", fileName: "f.xlsx", sheetName: "5月", headerRow: 1 } : { kind: "maximo", os: "MXAPIWODETAIL", select: ["*"], where: [] },
      columns: columns.map((n) => ({ name: n, type: "string" as const })),
      keyColumns: [key],
      childIdAttrs: {},
    },
    sheetRows,
  );
}

function setup() {
  const client = new FakeClient();
  const workspace = new Workspace("作業");
  const connection = connectionOf();
  const notes: string[] = [];
  const service = new DictionaryService({ workspace, connection, client, setInterval: () => 0, clearInterval: () => undefined });
  service.setNotifier((t) => notes.push(t));
  return { client, workspace, connection, service, notes };
}

describe("辞書のシート", () => {
  it("開くとシートになり、直した分だけを保存し、保存後は色の無いシートに作り直す", async () => {
    const { client, workspace, service } = setup();
    const id = client.add("設備の呼び名", [
      ["ごみクレ", "ごみクレーン", "text"],
      ["#(\\d)", "$1号炉", "regex"],
    ]);
    await service.refresh();
    const opened = await service.openDictionary("設備の呼び名");
    expect(opened.ok).toBe(true);
    const sheet = workspace.getSheet("設備の呼び名");
    expect(sheet.meta.source).toMatchObject({ kind: "dictionary", dictionaryId: id, scope: SCOPE });
    expect(sheet.viewRows("final").map((r) => sheet.finalValue(r, DICT_FIND))).toEqual(["ごみクレ", "#(\\d)"]);
    // 人が 1 件を直し、AI が 1 件を足し、使えない 1 件を足した
    const crane = sheet.viewRows("final")[0]!.rowKey;
    workspace.applyEdits("設備の呼び名", [{ rowKey: crane, col: DICT_TO, value: "ごみクレーン（1・2号）" }], { author: "user" });
    workspace.addRows("設備の呼び名", [{ [DICT_FIND]: "B号", [DICT_TO]: "B号機", [DICT_MODE]: "text" }], { author: "llm", reason: "日報の書き方" });
    workspace.addRows("設備の呼び名", [{ [DICT_FIND]: "(ポンプ", [DICT_TO]: "x", [DICT_MODE]: "regex" }], { author: "llm" });
    const p = pendingChanges(workspace.getSheet("設備の呼び名"));
    expect([p.added, p.changed, p.problems.length]).toEqual([1, 1, 1]);
    const refused = await service.save("設備の呼び名");
    expect(refused).toMatchObject({ ok: false, problems: 1 });
    // 使えない行を消してから保存する（追加した行の削除は、追加の取り消し）
    const bad = workspace.getSheet("設備の呼び名").viewRows("final").at(-1)!.rowKey;
    workspace.deleteRows("設備の呼び名", [bad], { author: "user" });
    const saved = await service.save("設備の呼び名");
    expect(saved).toEqual({ ok: true, saved: 2 });
    expect(client.saves.at(-1)!.map((o) => o.op + (o.op === "put" && o.id ? ":change" : ""))).toEqual(["put:change", "put"]);
    const after = workspace.summary("設備の呼び名");
    expect(after.changedCells + after.addedRows + after.deletedRows).toBe(0);
    expect(after.rowCount).toBe(3);
    expect(service.openOf("設備の呼び名")?.history).toHaveLength(1);
  });

  it("ほかのメンバーの保存を取り込む。保存前の変更があれば作り直さず知らせる", async () => {
    const { client, workspace, service, notes } = setup();
    const id = client.add("呼び名", [["ごみクレ", "ごみクレーン", "text"]]);
    await service.refresh();
    await service.openDictionary("呼び名");
    client.remoteSave(id, "#3", "3号炉");
    await service.refresh();
    expect(workspace.summary("呼び名").rowCount).toBe(2);
    expect(notes).toEqual(["田中 さんが辞書「呼び名」を保存しました。"]);
    // 保存前の変更があるとき
    workspace.addRows("呼び名", [{ [DICT_FIND]: "B号", [DICT_TO]: "B号機", [DICT_MODE]: "text" }], { author: "user" });
    client.remoteSave(id, "ごみクレ2", "x");
    await service.refresh();
    expect(workspace.summary("呼び名").rowCount).toBe(3);
    expect(service.openOf("呼び名")?.newerBy).toBe("田中");
  });

  it("閉じたシートは開いている辞書から外す", async () => {
    const { client, workspace, service } = setup();
    client.add("呼び名");
    service.start();
    await service.refresh();
    await service.openDictionary("呼び名");
    workspace.removeSheet("呼び名");
    expect(service.openOf("呼び名")).toBe(null);
    service.dispose();
  });
});

describe("辞書を使った突き合わせ", () => {
  function data(ws: Workspace) {
    excelSheet(ws, "日報", ["ID", "DAY", "TEXT"], [
      { ID: "r1", DAY: "2026-05-11", TEXT: "ごみクレ A 異音" },
      { ID: "r2", DAY: "2026-05-12", TEXT: "温水循環ポンプB号 漏れ" },
      { ID: "r3", DAY: "2026-05-12", TEXT: "ポンプB号 点検" },
    ], "ID");
    excelSheet(ws, "WO", ["WONUM", "NAME", "START"], [
      { WONUM: "W1", NAME: "ごみクレーン A号機", START: "2026-05-11" },
      { WONUM: "W2", NAME: "温水循環ポンプ B号機", START: "2026-05-12" },
      { WONUM: "W3", NAME: "ポンプ B号機", START: "2026-05-12" },
    ], "WONUM", "maximo");
  }
  const ARGS = { left: "日報", right: "WO", normalize: ["trim", "nfkc", "upper", "removeSpaces"] as const, extra: { contains: { col: "TEXT", targetCol: "NAME" }, dateWithin: { col: "DAY", targetStart: "START" } } };

  it("match_sheets の dictionaries で辞書を開いて当て、結果を作業画面に覚える。辞書を直すと突き合わせ直す", async () => {
    const { client, workspace, connection, service } = setup();
    client.add("呼び名", [["ごみクレ A", "ごみクレーン A号機", "text"]]);
    data(workspace);
    await service.refresh();
    const matches = new MatchViewStore(workspace);
    const idle = (sheet: string) => ({ sheet, state: "idle", counts: { parents: 0, changedCells: 0, addedRows: 0, deletedRows: 0 }, blockers: [], needsDeleteConfirm: false, needsNullConfirm: false, awaitingCanary: null, results: [] });
    const commits = { request: () => ({}) as never, panel: idle, isRunning: () => false } as unknown as CommitRequester;
    const registry = createToolRegistry({ workspace, jobs: new JobRegistry(), connection, commits, catalog: new ObjectStructureCatalog(), appVersion: "t", appUrl: "http://127.0.0.1/app", dictionaries: service, matches });
    const call = async (tool: string, args: unknown) => {
      const msg: InvokeMsg = { type: "tool.invoke", id: "c", tool: tool as ToolName, args, deadlineAt: Date.now() + 30_000, timeoutMs: 30_000, idempotencyKey: "", readOnly: false };
      const out = await registry.handler(msg, { signal: new AbortController().signal, progress: () => {} });
      return out.result.structuredContent as Record<string, any>;
    };
    const res = await call("match_sheets", { left: ARGS.left, right: ARGS.right, normalize: [...ARGS.normalize], ...ARGS.extra, dictionaries: ["呼び名"] });
    expect(res).toMatchObject({ matched: 1, unmatchedLeft: 2 });
    expect(workspace.dictionarySheet("呼び名")).not.toBe(null);
    const view = matches.get("日報")!;
    expect(view.counts).toMatchObject({ matched: 1, unmatched: 2 });
    const entryKey = workspace.getSheet("呼び名").viewRows("final")[0]!.rowKey;
    expect(view.rows.get("r1")).toMatchObject({ kind: "matched", targets: ["W1"], aliases: [entryKey] });
    expect(matches.hitsFor("呼び名").hits.get(entryKey)).toEqual({ hits: 1, ambiguous: 0 });
    // 広すぎる項目（B号 → B号機）を足すと、r2 は「温水循環ポンプ B号機」と「ポンプ B号機」の 2 件が候補になる。少し待つと突き合わせ直す
    workspace.addRows("呼び名", [{ [DICT_FIND]: "B号", [DICT_TO]: "B号機", [DICT_MODE]: "text" }], { author: "user" });
    await new Promise((r) => setTimeout(r, 500));
    const again = matches.get("日報")!;
    expect(again.rows.get("r2")).toMatchObject({ kind: "ambiguous", targets: ["W2", "W3"] });
    expect(again.rows.get("r3")).toMatchObject({ kind: "matched", targets: ["W3"] });
    const wide = workspace.getSheet("呼び名").viewRows("final")[1]!.rowKey;
    expect(matches.hitsFor("呼び名").hits.get(wide)).toEqual({ hits: 2, ambiguous: 1 });
    // 辞書のシートは Maximo に反映できない
    const msg: InvokeMsg = { type: "tool.invoke", id: "c", tool: "request_commit", args: { sheet: "呼び名", note: "x" }, deadlineAt: Date.now() + 1000, timeoutMs: 1000, idempotencyKey: "", readOnly: false };
    await expect(registry.handler(msg, { signal: new AbortController().signal, progress: () => {} })).rejects.toThrow(/customer dictionary/);
    // get_status に辞書の一覧が載る
    const st = await call("get_status", {});
    expect(st.dictionaries).toMatchObject({ sharing: "shared folder (project members)", list: [{ name: "呼び名", entries: 1, sheet: "呼び名", unsavedChanges: 1 }] });
    matches.dispose();
  });

  it("辞書を使っていなかった突き合わせに、辞書を足して突き合わせ直せる", () => {
    const { workspace } = setup();
    data(workspace);
    workspace.createSheet(
      { name: "呼び名", source: { kind: "dictionary", dictionaryId: "d_1", dictionaryName: "呼び名", dictKind: "alias", scope: SCOPE }, columns: [DICT_FIND, DICT_TO, DICT_MODE].map((n) => ({ name: n, type: "string" as const })), keyColumns: [], childIdAttrs: {} },
      [{ rowKey: "e_1", parentKey: "e_1", childName: null, values: { [DICT_FIND]: "ごみクレ A", [DICT_TO]: "ごみクレーン A号機", [DICT_MODE]: "text" } }],
    );
    const matches = new MatchViewStore(workspace);
    matches.record({ ...ARGS, normalize: [...ARGS.normalize] });
    expect(matches.get("日報")!.counts.matched).toBe(0);
    const v = matches.rerunWithDictionary("日報", "呼び名")!;
    expect(v.counts.matched).toBe(1);
    expect(v.args.extra.dictionaries).toEqual(["呼び名"]);
    matches.dispose();
  });
});
