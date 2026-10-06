// Workspace（作業タブの正本）の試験。

import { describe, expect, it } from "vitest";
import type { CellValue, ColumnSchema, RuleValue } from "../../src/shared/model";
import { makeChildRowKey, makeParentKey, type SheetMeta, type SheetRow } from "../../src/shared/sheet";
import { StoreError } from "../../src/app/store/errors";
import type { ViewKind } from "../../src/app/store/sheet";
import { Workspace, type ChangeEvent } from "../../src/app/store/workspace";

// ---------------------------------------------------------------------------
// 試験データ
// ---------------------------------------------------------------------------

const WO = "wo";
const CH = "EXT_WOPERMIT";
const NOTE = `${CH}.NOTE`;
const MULTIID = `${CH}.MULTIID`;
const APPR = `${CH}.EXT_PERMITDATE`;
const P1 = makeParentKey(["BEDFORD", "WO1"]);
const P2 = makeParentKey(["BEDFORD", "WO2"]);
const P3 = makeParentKey(["OTH", "WO3"]);
const C11 = makeChildRowKey(P1, CH, 11);
const C12 = makeChildRowKey(P1, CH, 12);
const C21 = makeChildRowKey(P2, CH, 21);

const WO_COLUMNS: ColumnSchema[] = [
  { name: "SITEID", type: "string" },
  { name: "WONUM", type: "string" },
  { name: "DESCRIPTION", type: "string", maxLength: 20 },
  { name: "QTY", type: "number" },
  { name: "CNT", type: "integer" },
  { name: "FLAG", type: "boolean" },
  { name: "DUE", type: "date" },
  { name: "STATUS", type: "string", readOnly: true },
  { name: MULTIID, type: "integer", child: CH },
  { name: APPR, type: "datetime", child: CH },
  { name: NOTE, type: "string", child: CH },
];

function woMeta(): SheetMeta {
  return {
    name: WO,
    source: { kind: "maximo", os: "MXAPIWO", select: ["*"], where: [] },
    columns: WO_COLUMNS,
    keyColumns: ["SITEID", "WONUM"],
    childIdAttrs: { [CH]: "MULTIID" },
  };
}

function woRows(): SheetRow[] {
  const p1 = { SITEID: "BEDFORD", WONUM: "WO1", DESCRIPTION: "pump", QTY: 10, CNT: 1, FLAG: false, DUE: "2024-04-01", STATUS: "WAPPR" };
  const p2 = { SITEID: "BEDFORD", WONUM: "WO2", DESCRIPTION: "valve", QTY: 3, CNT: 2, FLAG: true, DUE: null, STATUS: "APPR" };
  const p3 = { SITEID: "OTH", WONUM: "WO3", DESCRIPTION: "", QTY: null, CNT: null, FLAG: null, DUE: null, STATUS: "APPR" };
  return [
    { rowKey: C11, parentKey: P1, childName: CH, values: { ...p1, [MULTIID]: 11, [APPR]: "2024-01-01T00:00:00+09:00", [NOTE]: "a" } },
    { rowKey: C12, parentKey: P1, childName: CH, values: { ...p1, [MULTIID]: 12, [APPR]: null, [NOTE]: "b" } },
    { rowKey: C21, parentKey: P2, childName: CH, values: { ...p2, [MULTIID]: 21, [APPR]: null, [NOTE]: "c" } },
    { rowKey: P3, parentKey: P3, childName: null, values: { ...p3, [MULTIID]: null, [APPR]: null, [NOTE]: null } },
  ];
}

/** 突合用: 依頼（req）と機器（asset） */
function reqMeta(): SheetMeta {
  return {
    name: "req",
    source: { kind: "excel", importId: "imp1", fileName: "req.xlsx", sheetName: "Sheet1", headerRow: 1 },
    columns: ["ID", "SITEID", "TAG", "LOC"].map((name) => ({ name, type: "string" as const })),
    keyColumns: ["ID"],
    childIdAttrs: {},
  };
}

function reqRows(): SheetRow[] {
  const data: Array<[string, string, string, string | null]> = [
    ["r1", "BEDFORD", " p-101 ", "old-1"],
    ["r2", "BEDFORD", "P-102", null],
    ["r3", "BEDFORD", "P-999", null],
    ["r4", "BEDFORD", "", null],
    ["r5", "OTH", "P-101", null],
    ["r6", "BEDFORD", "P-500", null],
    ["r7", "", "P-500", null],
  ];
  return data.map(([ID, SITEID, TAG, LOC]) => ({ rowKey: ID, parentKey: ID, childName: null, values: { ID, SITEID, TAG, LOC } }));
}

function assetMeta(): SheetMeta {
  return {
    name: "asset",
    source: { kind: "maximo", os: "MXAPIASSET", select: ["*"], where: [] },
    columns: ["ASSETNUM", "SITEID", "TAGNO", "LOCATION"].map((name) => ({ name, type: "string" as const })),
    keyColumns: ["ASSETNUM"],
    childIdAttrs: {},
  };
}

function assetRows(): SheetRow[] {
  const data: Array<[string, string, string, string]> = [
    ["A1", "BEDFORD", "P-101", "LOC-1"],
    ["A2", "BEDFORD", "P-102", "LOC-2"],
    ["A3", "BEDFORD", "p-102", "LOC-3"],
    ["A4", "OTH", "P-101", "LOC-4"],
    ["A5", "BEDFORD", "P-500", "LOC-5"],
    ["A6", "BEDFORD", "P-600", "LOC-6"],
  ];
  return data.map(([ASSETNUM, SITEID, TAGNO, LOCATION]) => ({ rowKey: ASSETNUM, parentKey: ASSETNUM, childName: null, values: { ASSETNUM, SITEID, TAGNO, LOCATION } }));
}

function setup(): Workspace {
  const ws = new Workspace("test", { now: () => 1_700_000_000_000 });
  ws.createSheet(woMeta(), woRows());
  ws.createSheet(reqMeta(), reqRows());
  ws.createSheet(assetMeta(), assetRows());
  return ws;
}

function val(ws: Workspace, sheet: string, rowKey: string, col: string, view: ViewKind = "final"): CellValue | undefined {
  return ws.getSheet(sheet).rowValues(rowKey, view)?.[col];
}

function expectStoreError(fn: () => unknown, code: string): StoreError {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(StoreError);
  expect((err as StoreError).code).toBe(code);
  return err as StoreError;
}

const COMPOSITE_LOOKUP: RuleValue = {
  lookup: { sheet: "asset", matchCol: ["SITEID", "TAG"], targetMatchCol: ["SITEID", "TAGNO"], sourceCol: "LOCATION", normalize: ["trim", "upper"] },
};
const SINGLE_LOOKUP: RuleValue = {
  lookup: { sheet: "asset", matchCol: "TAG", targetMatchCol: "TAGNO", sourceCol: "LOCATION", normalize: ["trim", "upper"] },
};

// ---------------------------------------------------------------------------

describe("Workspace: シート・revision・通知", () => {
  it("createSheet・status・revision", () => {
    const ws = new Workspace("作業1");
    expect(ws.revision).toBe(0);
    const s = ws.createSheet(woMeta(), woRows());
    expect(s).toMatchObject({ name: WO, rowCount: 4, keyColumns: ["SITEID", "WONUM"], changedCells: 0, addedRows: 0, deletedRows: 0 });
    expect(ws.revision).toBe(1);
    expect(ws.status()).toEqual({ workspace: "作業1", revision: 1, sheets: [s] });
    expect(ws.sheets.has(WO)).toBe(true);
    expectStoreError(() => ws.getSheet("nope"), "sheet_not_found");
  });

  it("変更のたびに通知し、解除後は通知しない。通知先の例外で止まらない", () => {
    const ws = setup();
    const events: ChangeEvent[] = [];
    ws.subscribe(() => {
      throw new Error("listener");
    });
    const off = ws.subscribe((e) => events.push(e));
    const r = ws.applyEdits(WO, [{ rowKey: C11, col: NOTE, value: "x" }], { author: "user" });
    expect(r.batchId).not.toBeNull();
    expect(events).toEqual([{ revision: r.revision, sheet: WO, kind: "cells_changed", batchId: r.batchId }]);
    ws.setEditingCell(WO, C11, NOTE);
    expect(events.at(-1)).toMatchObject({ kind: "editing_changed", sheet: WO });
    off();
    ws.applyEdits(WO, [{ rowKey: C11, col: NOTE, value: "y" }], { author: "user" });
    expect(events).toHaveLength(2);
  });

  it("同名の createSheet は置き換え、以前のバッチは消える", () => {
    const ws = setup();
    const r = ws.applyEdits(WO, [{ rowKey: C11, col: NOTE, value: "x" }], { author: "user" });
    expect(ws.batches).toHaveLength(1);
    ws.createSheet(woMeta(), woRows());
    expect(val(ws, WO, C11, NOTE)).toBe("a");
    expect(ws.batches).toHaveLength(0);
    expectStoreError(() => ws.undoBatch(r.batchId as string), "batch_not_found");
  });

  it("行キー・列名の重複、キー列の欠落は invalid_args", () => {
    const ws = new Workspace("w");
    const rows = woRows();
    expectStoreError(() => ws.createSheet(woMeta(), [...rows, rows[0] as SheetRow]), "invalid_args");
    expectStoreError(() => ws.createSheet({ ...woMeta(), keyColumns: ["NOPE"] }, rows), "invalid_args");
    expectStoreError(() => ws.createSheet({ ...woMeta(), columns: [...WO_COLUMNS, { name: "QTY", type: "number" }] }, rows), "invalid_args");
  });
});

describe("applyEdits: compare-and-set と検査", () => {
  it("changed_since_read: 読んだ後に変わったセルは変更しない", () => {
    const ws = setup();
    const r0 = ws.revision;
    ws.applyEdits(WO, [{ rowKey: C11, col: NOTE, value: "user" }], { author: "user" });
    const res = ws.applyEdits(
      WO,
      [
        { rowKey: C11, col: NOTE, value: "llm" },
        { rowKey: C12, col: NOTE, value: "llm2" },
      ],
      { author: "llm", reason: "r", baseRevision: r0 },
    );
    expect(res.conflicts).toEqual([{ rowKey: C11, col: NOTE, reason: "changed_since_read" }]);
    expect(res.applied).toBe(1);
    expect(val(ws, WO, C11, NOTE)).toBe("user");
    expect(val(ws, WO, C12, NOTE)).toBe("llm2");
    // 読み直せば通る
    expect(ws.applyEdits(WO, [{ rowKey: C11, col: NOTE, value: "llm" }], { author: "llm", baseRevision: ws.revision }).applied).toBe(1);
    // シートを作る前の revision で読んだ値はすべて古い
    const old = ws.applyEdits("asset", [{ rowKey: "A1", col: "LOCATION", value: "X" }], { author: "llm", baseRevision: 0 });
    expect(old.conflicts).toEqual([{ rowKey: "A1", col: "LOCATION", reason: "changed_since_read" }]);
    expect(old.batchId).toBeNull();
  });

  it("user_editing: 利用者が編集中のセルは LLM の変更を衝突にする", () => {
    const ws = setup();
    ws.setEditingCell(WO, C11, NOTE);
    expect(ws.getEditingCell()).toEqual({ sheet: WO, rowKey: C11, col: NOTE });
    const res = ws.applyEdits(
      WO,
      [
        { rowKey: C11, col: NOTE, value: "llm" },
        { rowKey: C12, col: NOTE, value: "ok" },
      ],
      { author: "llm", reason: "r", baseRevision: ws.revision },
    );
    expect(res.conflicts).toEqual([{ rowKey: C11, col: NOTE, reason: "user_editing" }]);
    expect(res.applied).toBe(1);
    // 利用者自身の変更は通る
    expect(ws.applyEdits(WO, [{ rowKey: C11, col: NOTE, value: "typed" }], { author: "user" }).applied).toBe(1);
    // 親の列は同じ親の別の行を編集中でも衝突
    ws.setEditingCell(WO, C12, "DESCRIPTION");
    expect(ws.applyEdits(WO, [{ rowKey: C11, col: "DESCRIPTION", value: "x" }], { author: "llm" }).conflicts).toEqual([
      { rowKey: C11, col: "DESCRIPTION", reason: "user_editing" },
    ]);
    // 行の削除も衝突
    expect(ws.deleteRows(WO, [C12], { author: "llm" }).conflicts).toEqual([{ rowKey: C12, col: "DESCRIPTION", reason: "user_editing" }]);
    ws.setEditingCell(WO, null, null);
    expect(ws.getEditingCell()).toBeNull();
    expect(ws.applyEdits(WO, [{ rowKey: C11, col: "DESCRIPTION", value: "x" }], { author: "llm" }).applied).toBe(2);
  });

  it("read_only_column: readOnly・キー列・子の ID 列", () => {
    const ws = setup();
    const res = ws.applyEdits(
      WO,
      [
        { rowKey: C11, col: "STATUS", value: "APPR" },
        { rowKey: C11, col: "SITEID", value: "X" },
        { rowKey: C11, col: "WONUM", value: "X" },
        { rowKey: C11, col: MULTIID, value: 99 },
      ],
      { author: "user" },
    );
    expect(res.conflicts.map((c) => [c.col, c.reason])).toEqual([
      ["STATUS", "read_only_column"],
      ["SITEID", "read_only_column"],
      ["WONUM", "read_only_column"],
      [MULTIID, "read_only_column"],
    ]);
    expect(res).toMatchObject({ batchId: null, applied: 0 });
  });

  it("row_not_found・column_not_found", () => {
    const ws = setup();
    const res = ws.applyEdits(
      WO,
      [
        { rowKey: "nope", col: NOTE, value: "x" },
        { rowKey: C11, col: "NOPE", value: "x" },
      ],
      { author: "llm" },
    );
    expect(res.conflicts).toEqual([
      { rowKey: "nope", col: NOTE, reason: "row_not_found" },
      { rowKey: C11, col: "NOPE", reason: "column_not_found" },
    ]);
  });

  it("invalid_value: 列の型に合わない値", () => {
    const ws = setup();
    const bad: Array<[string, CellValue]> = [
      ["QTY", "abc"],
      ["QTY", true],
      ["CNT", 1.5],
      ["FLAG", "yes"],
      ["DUE", "2024.04.01"],
      ["DUE", "2024-02-30"],
      [APPR, "yesterday"],
      ["DESCRIPTION", "123456789012345678901"],
    ];
    const res = ws.applyEdits(
      WO,
      bad.map(([col, value]) => ({ rowKey: C11, col, value })),
      { author: "llm" },
    );
    expect(res.conflicts).toEqual(bad.map(([col]) => ({ rowKey: C11, col, reason: "invalid_value" })));
    expect(res.batchId).toBeNull();

    const ok = ws.applyEdits(
      WO,
      [
        { rowKey: C11, col: "QTY", value: "12.5" },
        { rowKey: C11, col: "CNT", value: "7" },
        { rowKey: C11, col: "FLAG", value: "TRUE" },
        { rowKey: C11, col: "DUE", value: "2024-02-29" },
        { rowKey: C11, col: APPR, value: "2024-04-01T10:20:30+09:00" },
        { rowKey: C12, col: APPR, value: "2024-04-01" },
      ],
      { author: "llm" },
    );
    expect(ok.conflicts).toEqual([]);
    expect(val(ws, WO, C11, "QTY")).toBe(12.5);
    expect(val(ws, WO, C11, "CNT")).toBe(7);
    expect(val(ws, WO, C11, "FLAG")).toBe(true);
    expect(val(ws, WO, C11, APPR)).toBe("2024-04-01T10:20:30+09:00");
  });

  it("同じ値・null と空文字の入れ替えは変更にしない", () => {
    const ws = setup();
    const rev = ws.revision;
    const res = ws.applyEdits(
      WO,
      [
        { rowKey: C11, col: NOTE, value: "a" },
        { rowKey: P3, col: "DESCRIPTION", value: null },
        { rowKey: C21, col: "QTY", value: "3" },
      ],
      { author: "llm", baseRevision: 0 },
    );
    expect(res).toEqual({ batchId: null, applied: 0, conflicts: [], revision: rev });
    expect(ws.revision).toBe(rev);
  });

  it("author・baseRevision の誤りは invalid_args", () => {
    const ws = setup();
    expectStoreError(() => ws.applyEdits(WO, [], { author: "bot" as "llm" }), "invalid_args");
    expectStoreError(() => ws.applyEdits(WO, [], { author: "llm", baseRevision: -1 }), "invalid_args");
  });
});

describe("親の列の変更は同じ親の全行に反映する", () => {
  it("子行で親の列を変えると兄弟の子行も変わり、子の列はその行だけ", () => {
    const ws = setup();
    const r = ws.applyEdits(
      WO,
      [
        { rowKey: C11, col: "DESCRIPTION", value: "PUMP-A" },
        { rowKey: C11, col: NOTE, value: "only" },
      ],
      { author: "llm", reason: "batch" },
    );
    expect(r.applied).toBe(3);
    expect(val(ws, WO, C12, "DESCRIPTION")).toBe("PUMP-A");
    expect(val(ws, WO, C21, "DESCRIPTION")).toBe("valve");
    expect(val(ws, WO, C12, NOTE)).toBe("b");
    const d = ws.getDiff(WO);
    expect(d.changedCells).toBe(3);
    expect(d.entries.map((e) => [e.kind, e.rowKey, e.col, e.before, e.after, e.author, e.batchId])).toEqual([
      ["change", C11, "DESCRIPTION", "pump", "PUMP-A", "llm", r.batchId],
      ["change", C11, NOTE, "a", "only", "llm", r.batchId],
      ["change", C12, "DESCRIPTION", "pump", "PUMP-A", "llm", r.batchId],
    ]);
    expect(ws.summary(WO).changedCells).toBe(3);
  });

  it("削除の印が付いた同じ親の行にも反映し、削除を取り消すと一致している", () => {
    const ws = setup();
    const del = ws.deleteRows(WO, [C12], { author: "user" });
    ws.applyEdits(WO, [{ rowKey: C11, col: "DESCRIPTION", value: "PUMP-B" }], { author: "user" });
    ws.undoBatch(del.batchId as string);
    expect(val(ws, WO, C12, "DESCRIPTION")).toBe("PUMP-B");
  });
});

describe("セルごとの根拠（CellEdit.reason）", () => {
  it("overlay に保持し、cell と getDiff で返す。無ければバッチの reason", () => {
    const ws = setup();
    const r = ws.applyEdits(
      WO,
      [
        { rowKey: C11, col: "DESCRIPTION", value: "P-101 pump", reason: "台帳の TAGNO と一致" },
        { rowKey: C21, col: NOTE, value: "n" },
      ],
      { author: "llm", reason: "まとめて修正" },
    );
    expect(ws.cell(WO, C11, "DESCRIPTION")).toMatchObject({ value: "P-101 pump", base: "pump", changed: true, author: "llm", batchId: r.batchId, reason: "台帳の TAGNO と一致" });
    // 親の列を反映した行にも同じ根拠
    expect(ws.cell(WO, C12, "DESCRIPTION")?.reason).toBe("台帳の TAGNO と一致");
    expect(ws.cell(WO, C21, NOTE)?.reason).toBe("まとめて修正");
    expect(ws.getSheet(WO).cell(C21, NOTE)?.reason).toBeNull();
    expect(ws.cell(WO, P3, "DESCRIPTION")).toMatchObject({ reason: null, batchId: null, author: null, changed: false });
    expect(ws.cell(WO, C11, "NOPE")).toBeNull();

    const d = ws.getDiff(WO);
    expect(d.entries.map((e) => [e.rowKey, e.col, e.reason])).toEqual([
      [C11, "DESCRIPTION", "台帳の TAGNO と一致"],
      [C12, "DESCRIPTION", "台帳の TAGNO と一致"],
      [C21, NOTE, "まとめて修正"],
    ]);

    // 後の変更で上書きし、取り消すと前の根拠に戻る
    const r2 = ws.applyEdits(WO, [{ rowKey: C11, col: "DESCRIPTION", value: "again", reason: "やり直し" }], { author: "user" });
    expect(ws.cell(WO, C11, "DESCRIPTION")).toMatchObject({ author: "user", reason: "やり直し" });
    ws.undoBatch(r2.batchId as string);
    expect(ws.cell(WO, C11, "DESCRIPTION")).toMatchObject({ value: "P-101 pump", author: "llm", reason: "台帳の TAGNO と一致" });
  });

  it("根拠の無いバッチは reason を付けない。追加・削除はバッチの reason", () => {
    const ws = setup();
    ws.applyEdits(WO, [{ rowKey: C11, col: NOTE, value: "x" }], { author: "user" });
    ws.addRows(WO, [{ SITEID: "BEDFORD", WONUM: "WO9" }], { author: "llm", reason: "追加の根拠" });
    ws.deleteRows(WO, [C21], { author: "llm", reason: "削除の根拠" });
    const entries = ws.getDiff(WO).entries;
    expect(entries.find((e) => e.kind === "change")).not.toHaveProperty("reason");
    expect(entries.find((e) => e.kind === "add")?.reason).toBe("追加の根拠");
    expect(entries.find((e) => e.kind === "delete")?.reason).toBe("削除の根拠");
    expect(ws.cell(WO, makeParentKey(["BEDFORD", "WO9"]), "WONUM")?.reason).toBe("追加の根拠");
  });
});

describe("applyRule", () => {
  it("const: 条件に合う行だけ、既に同じ値の行は数えない", () => {
    const ws = setup();
    const r = ws.applyRule(WO, [{ attr: "QTY", op: "gte", value: 3 }], { FLAG: { const: true } }, { author: "llm", reason: "r", baseRevision: ws.revision });
    expect(r).toMatchObject({ matched: 3, applied: 2, conflicts: [] });
    expect(r).not.toHaveProperty("lookup");
    expect(val(ws, WO, C11, "FLAG")).toBe(true);
    expect(val(ws, WO, P3, "FLAG")).toBeNull();
    expect(ws.listBatches(WO)).toMatchObject([{ batchId: r.batchId, author: "llm", reason: "r", opCount: 2, undone: false }]);
  });

  it("条件は最終ビューで評価する", () => {
    const ws = setup();
    ws.applyEdits(WO, [{ rowKey: C21, col: "QTY", value: 1 }], { author: "user" });
    const r = ws.applyRule(WO, [{ attr: "QTY", op: "gte", value: 3 }], { [NOTE]: { const: "big" } }, { author: "llm" });
    expect(r.matched).toBe(2);
    expect(val(ws, WO, C21, NOTE)).toBe("c");
  });

  it("copyFrom: 同じ行の列から写す", () => {
    const ws = setup();
    const r = ws.applyRule(WO, [{ attr: MULTIID, op: "notnull" }], { [NOTE]: { copyFrom: "WONUM" } }, { author: "llm" });
    expect(r).toMatchObject({ matched: 3, applied: 3 });
    expect([C11, C12, C21].map((k) => val(ws, WO, k, NOTE))).toEqual(["WO1", "WO1", "WO2"]);
  });

  it("値はすべて適用前の状態から求める（列の入れ替え）", () => {
    const ws = setup();
    ws.applyRule("req", [{ attr: "ID", op: "eq", value: "r1" }], { TAG: { copyFrom: "LOC" }, LOC: { copyFrom: "TAG" } }, { author: "llm" });
    expect(ws.getSheet("req").rowValues("r1")).toEqual({ ID: "r1", SITEID: "BEDFORD", TAG: "old-1", LOC: " p-101 " });
  });

  it("dryRun は変更せず件数と lookup の件数だけ返す", () => {
    const ws = setup();
    const events: ChangeEvent[] = [];
    ws.subscribe((e) => events.push(e));
    const rev = ws.revision;
    const r = ws.applyRule("req", [], { LOC: COMPOSITE_LOOKUP, TAG: { const: "T" } }, { author: "llm", dryRun: true, baseRevision: rev });
    expect(r).toMatchObject({ batchId: null, revision: rev, matched: 7, applied: 3 + 7, lookup: { LOC: { matched: 3, unmatched: 3, ambiguous: 1 } } });
    expect(ws.revision).toBe(rev);
    expect(events).toEqual([]);
    expect(val(ws, "req", "r1", "LOC")).toBe("old-1");
    expect(ws.getDiff("req").total).toBe(0);
  });

  it("lookup（単一列）: 一致しない行はスキップ、複数一致は lookup_ambiguous", () => {
    const ws = setup();
    const r = ws.applyRule("req", [], { LOC: SINGLE_LOOKUP }, { author: "llm", baseRevision: ws.revision });
    expect(r.lookup).toEqual({ LOC: { matched: 2, unmatched: 2, ambiguous: 3 } });
    expect(r.conflicts).toEqual(["r1", "r2", "r5"].map((rowKey) => ({ rowKey, col: "LOC", reason: "lookup_ambiguous" })));
    expect(r.applied).toBe(2);
    expect(["r1", "r2", "r3", "r4", "r5", "r6", "r7"].map((k) => val(ws, "req", k, "LOC"))).toEqual(["old-1", null, null, null, null, "LOC-5", "LOC-5"]);
  });

  it("lookup（複合キー）: 同じ順の列で突合し、どれか 1 列でも空なら unmatched", () => {
    const ws = setup();
    const r = ws.applyRule("req", [], { LOC: COMPOSITE_LOOKUP }, { author: "llm", baseRevision: ws.revision });
    expect(r.lookup).toEqual({ LOC: { matched: 3, unmatched: 3, ambiguous: 1 } });
    expect(r.conflicts).toEqual([{ rowKey: "r2", col: "LOC", reason: "lookup_ambiguous" }]);
    expect(r.applied).toBe(3);
    expect(["r1", "r2", "r3", "r4", "r5", "r6", "r7"].map((k) => val(ws, "req", k, "LOC"))).toEqual(["LOC-1", null, null, null, "LOC-4", "LOC-5", null]);
  });

  it("lookup は参照先の最終ビューを使う", () => {
    const ws = setup();
    ws.applyEdits("asset", [{ rowKey: "A3", col: "TAGNO", value: "P-103" }], { author: "user" });
    ws.deleteRows("asset", ["A4"], { author: "user" });
    const r = ws.applyRule("req", [], { LOC: COMPOSITE_LOOKUP }, { author: "llm", dryRun: true });
    expect(r.lookup).toEqual({ LOC: { matched: 3, unmatched: 4, ambiguous: 0 } });
    expect(r.conflicts).toEqual([]);
  });

  it("lookup の列の誤りは型付きエラー", () => {
    const ws = setup();
    const lk = (patch: Record<string, unknown>): RuleValue => ({ lookup: { ...(COMPOSITE_LOOKUP as { lookup: object }).lookup, ...patch } }) as RuleValue;
    const opts = { author: "llm" as const };
    expectStoreError(() => ws.applyRule("req", [], { LOC: lk({ targetMatchCol: "TAGNO" }) }, opts), "invalid_args");
    expectStoreError(() => ws.applyRule("req", [], { LOC: lk({ matchCol: [], targetMatchCol: [] }) }, opts), "invalid_args");
    expectStoreError(() => ws.applyRule("req", [], { LOC: lk({ matchCol: ["SITEID", "NOPE"] }) }, opts), "column_not_found");
    expectStoreError(() => ws.applyRule("req", [], { LOC: lk({ targetMatchCol: ["SITEID", "NOPE"] }) }, opts), "column_not_found");
    expectStoreError(() => ws.applyRule("req", [], { LOC: lk({ sourceCol: "NOPE" }) }, opts), "column_not_found");
    expectStoreError(() => ws.applyRule("req", [], { LOC: lk({ sheet: "nope" }) }, opts), "sheet_not_found");
  });

  it("規則の誤り: 変更できない列・存在しない列・空の set・条件の列", () => {
    const ws = setup();
    const opts = { author: "llm" as const };
    expectStoreError(() => ws.applyRule(WO, [], { STATUS: { const: "X" } }, opts), "read_only_column");
    expectStoreError(() => ws.applyRule(WO, [], { WONUM: { const: "X" } }, opts), "read_only_column");
    expectStoreError(() => ws.applyRule(WO, [], { NOPE: { const: "X" } }, opts), "column_not_found");
    expectStoreError(() => ws.applyRule(WO, [], { NOTE: { copyFrom: "NOPE" } }, opts), "column_not_found");
    expectStoreError(() => ws.applyRule(WO, [], {}, opts), "invalid_args");
    expectStoreError(() => ws.applyRule(WO, [{ attr: "NOPE", op: "isnull" }], { [NOTE]: { const: "x" } }, opts), "column_not_found");
  });

  it("型に合わない値は行ごとの invalid_value", () => {
    const ws = setup();
    const r = ws.applyRule(WO, [{ attr: "WONUM", op: "eq", value: "WO2" }], { QTY: { const: "abc" } }, { author: "llm" });
    expect(r).toMatchObject({ batchId: null, applied: 0, matched: 1, conflicts: [{ rowKey: C21, col: "QTY", reason: "invalid_value" }] });
  });

  it("親の列に同じ親の行から違う値が出たら、その親は invalid_value にして変更しない", () => {
    const ws = setup();
    const r = ws.applyRule(WO, [{ attr: "SITEID", op: "eq", value: "BEDFORD" }], { DESCRIPTION: { copyFrom: NOTE } }, { author: "llm" });
    expect(r.conflicts).toEqual([
      { rowKey: C11, col: "DESCRIPTION", reason: "invalid_value" },
      { rowKey: C12, col: "DESCRIPTION", reason: "invalid_value" },
    ]);
    expect(r.applied).toBe(1);
    expect(val(ws, WO, C11, "DESCRIPTION")).toBe("pump");
    expect(val(ws, WO, C21, "DESCRIPTION")).toBe("c");
  });

  it("CAS は applyEdits と同じ（changed_since_read・user_editing）", () => {
    const ws = setup();
    const rev = ws.revision;
    ws.applyEdits(WO, [{ rowKey: C11, col: NOTE, value: "u" }], { author: "user" });
    ws.setEditingCell(WO, C21, NOTE);
    const r = ws.applyRule(WO, [{ attr: MULTIID, op: "notnull" }], { [NOTE]: { const: "rule" } }, { author: "llm", baseRevision: rev });
    expect(r.conflicts).toEqual([
      { rowKey: C11, col: NOTE, reason: "changed_since_read" },
      { rowKey: C21, col: NOTE, reason: "user_editing" },
    ]);
    expect(r.applied).toBe(1);
  });
});

describe("addRows / deleteRows と差分", () => {
  it("親行を追加し、差分に追加行として出る", () => {
    const ws = setup();
    const r = ws.addRows(WO, [{ SITEID: "BEDFORD", WONUM: "WO9", DESCRIPTION: "new", QTY: "5" }], { author: "llm", reason: "追加" });
    const key = makeParentKey(["BEDFORD", "WO9"]);
    expect(r).toMatchObject({ applied: 1, conflicts: [] });
    expect(ws.getSheet(WO).rowValues(key)).toMatchObject({ SITEID: "BEDFORD", WONUM: "WO9", DESCRIPTION: "new", QTY: 5, STATUS: null });
    const d = ws.getDiff(WO);
    expect(d).toMatchObject({ addedRows: 1, changedCells: 0, deletedRows: 0, total: 1 });
    expect(d.entries[0]).toEqual({
      kind: "add",
      rowKey: key,
      col: "*",
      before: null,
      after: null,
      author: "llm",
      batchId: r.batchId,
      values: { SITEID: "BEDFORD", WONUM: "WO9", DESCRIPTION: "new", QTY: 5 },
      reason: "追加",
    });
    expect(ws.summary(WO)).toMatchObject({ rowCount: 5, addedRows: 1 });
    expect(ws.getSheet(WO).rowKeys("final").at(-1)).toBe(key);
  });

  it("親行の追加の誤り: キーの重複・キーの欠落・子の列・存在しない列・読み取り専用", () => {
    const ws = setup();
    const r = ws.addRows(
      WO,
      [
        { SITEID: "BEDFORD", WONUM: "WO1" },
        { SITEID: "BEDFORD" },
        { SITEID: "BEDFORD", WONUM: "WO8", NOPE: 1 },
        { SITEID: "BEDFORD", WONUM: "WO8", [NOTE]: "x" },
        { SITEID: "BEDFORD", WONUM: "WO8", STATUS: "APPR" },
        { SITEID: "BEDFORD", WONUM: "WO8" },
        { SITEID: "BEDFORD", WONUM: "WO8" },
      ],
      { author: "llm" },
    );
    expect(r.conflicts).toEqual([
      { rowKey: P1, col: "SITEID", reason: "invalid_value" },
      { rowKey: "#1", col: "WONUM", reason: "invalid_value" },
      { rowKey: "#2", col: "NOPE", reason: "column_not_found" },
      { rowKey: "#3", col: NOTE, reason: "invalid_value" },
      { rowKey: "#4", col: "STATUS", reason: "read_only_column" },
      { rowKey: makeParentKey(["BEDFORD", "WO8"]), col: "SITEID", reason: "invalid_value" },
    ]);
    expect(r.applied).toBe(1);
  });

  it("子行を追加すると new~n の行キーで親の後ろに並び、親の列を写す", () => {
    const ws = setup();
    const r = ws.addRows(WO, [{ [NOTE]: "new" }], { author: "llm", parentRowKey: C11, reason: "子を追加" });
    const key = makeChildRowKey(P1, CH, "new~1");
    expect(r).toMatchObject({ applied: 1, conflicts: [] });
    expect(ws.getSheet(WO).rowKeys("final")).toEqual([C11, C12, key, C21, P3]);
    expect(ws.getSheet(WO).rowValues(key)).toMatchObject({ SITEID: "BEDFORD", WONUM: "WO1", DESCRIPTION: "pump", QTY: 10, [NOTE]: "new", [MULTIID]: null });
    expect(ws.getSheet(WO).rowInfo(key)).toEqual({ rowKey: key, parentKey: P1, childName: CH, status: "added" });

    // 親だけの行にも子を追加できる（子の種類が 1 つなら自動で決まる）
    const r2 = ws.addRows(WO, [{ [NOTE]: "n3", WONUM: "WO3" }], { author: "llm", parentRowKey: P3 });
    expect(r2.conflicts).toEqual([]);
    expect(ws.getSheet(WO).row(makeChildRowKey(P3, CH, "new~2"))).toBeDefined();
  });

  it("子行の追加の誤り: 親と違う親の列・子の ID 列・親が無い・子の無いシート", () => {
    const ws = setup();
    const r = ws.addRows(WO, [{ DESCRIPTION: "other" }, { [MULTIID]: 5 }, { [NOTE]: "ok", DESCRIPTION: "pump" }], { author: "llm", parentRowKey: C11 });
    expect(r.conflicts).toEqual([
      { rowKey: "#0", col: "DESCRIPTION", reason: "invalid_value" },
      { rowKey: "#1", col: MULTIID, reason: "read_only_column" },
    ]);
    expect(r.applied).toBe(1);
    expect(ws.addRows(WO, [{ [NOTE]: "x" }], { author: "llm", parentRowKey: "nope" }).conflicts).toEqual([{ rowKey: "nope", col: "", reason: "row_not_found" }]);
    expectStoreError(() => ws.addRows("req", [{ ID: "x" }], { author: "llm", parentRowKey: "r1" }), "invalid_args");
    expectStoreError(() => ws.addRows(WO, [{ [NOTE]: "x" }], { author: "llm", parentRowKey: C11, childName: "NOPE" }), "invalid_args");
  });

  it("addChildRows: 複数の親の子行を 1 つのバッチで足し、1 回の取り消しで消える。誤りは通し番号の #N", () => {
    const ws = setup();
    const r = ws.addChildRows(
      WO,
      [
        { parentRowKey: C11, rows: [{ [NOTE]: "a1" }, { [NOTE]: "a2" }] },
        { parentRowKey: "nope", rows: [{ [NOTE]: "x" }] },
        { parentRowKey: P3, rows: [{ [NOTE]: "b1", DESCRIPTION: "other" }, { [NOTE]: "b2" }] },
      ],
      { author: "llm", reason: "故障報告の行を足す", baseRevision: ws.revision },
    );
    expect(r.applied).toBe(3);
    expect(r.conflicts).toEqual([
      { rowKey: "nope", col: "", reason: "row_not_found" },
      { rowKey: "#3", col: "DESCRIPTION", reason: "invalid_value" },
    ]);
    const sheet = ws.getSheet(WO);
    expect(sheet.rowKeys("final").filter((k) => k.includes("new~")).map((k) => sheet.rowValues(k)![NOTE])).toEqual(["a1", "a2", "b2"]);
    expect(ws.batches.filter((b) => !b.undone)).toHaveLength(1);
    ws.undoBatch(r.batchId as string);
    expect(ws.getSheet(WO).rowKeys("final").some((k) => k.includes("new~"))).toBe(false);
  });

  it("行を削除すると最終ビューから消え、差分に削除行として出る", () => {
    const ws = setup();
    const r = ws.deleteRows(WO, [C21, C21, "nope"], { author: "llm", reason: "不要" });
    expect(r).toMatchObject({ applied: 1, conflicts: [{ rowKey: "nope", col: "", reason: "row_not_found" }] });
    const sheet = ws.getSheet(WO);
    expect(sheet.rowKeys("final")).toEqual([C11, C12, P3]);
    expect(sheet.rowKeys("base")).toEqual([C11, C12, C21, P3]);
    const d = ws.getDiff(WO);
    expect(d).toMatchObject({ deletedRows: 1, changedCells: 0, addedRows: 0 });
    expect(d.entries).toEqual([
      { kind: "delete", rowKey: C21, col: "*", before: null, after: null, author: "llm", batchId: r.batchId, values: { SITEID: "BEDFORD", WONUM: "WO2", [MULTIID]: 21 }, reason: "不要" },
    ]);
    // 削除済みの行は変更・再削除できない
    expect(ws.deleteRows(WO, [C21], { author: "llm" }).conflicts).toEqual([{ rowKey: C21, col: "", reason: "row_not_found" }]);
    expect(ws.applyEdits(WO, [{ rowKey: C21, col: NOTE, value: "x" }], { author: "llm" }).conflicts[0]?.reason).toBe("row_not_found");
    expect(ws.summary(WO)).toMatchObject({ rowCount: 3, deletedRows: 1 });
  });

  it("deleteRows の changed_since_read", () => {
    const ws = setup();
    const rev = ws.revision;
    ws.applyEdits(WO, [{ rowKey: C12, col: NOTE, value: "u" }], { author: "user" });
    const r = ws.deleteRows(WO, [C12, C21], { author: "llm", baseRevision: rev });
    expect(r.conflicts).toEqual([{ rowKey: C12, col: "", reason: "changed_since_read" }]);
    expect(r.applied).toBe(1);
  });

  it("追加した行を削除すると差分に出ない", () => {
    const ws = setup();
    ws.addRows(WO, [{ SITEID: "BEDFORD", WONUM: "WO9" }], { author: "llm" });
    ws.deleteRows(WO, [makeParentKey(["BEDFORD", "WO9"])], { author: "llm" });
    expect(ws.getDiff(WO)).toMatchObject({ addedRows: 0, deletedRows: 0, total: 0, entries: [] });
    expect(ws.summary(WO)).toMatchObject({ rowCount: 4, addedRows: 0, deletedRows: 0 });
  });

  it("getDiff のページング", () => {
    const ws = setup();
    ws.applyRule("asset", [], { LOCATION: { const: "Z" } }, { author: "llm" });
    const first = ws.getDiff("asset", { limit: 4 });
    expect(first).toMatchObject({ changedCells: 6, total: 6 });
    expect(first.entries).toHaveLength(4);
    const next = ws.getDiff("asset", { limit: 4, cursor: first.nextCursor as string });
    expect(next.entries.map((e) => e.rowKey)).toEqual(["A5", "A6"]);
    expect(next.nextCursor).toBeNull();
  });
});

describe("undoBatch", () => {
  it("成功: 値を戻し、revision を進め、取り消し済みにする", () => {
    const ws = setup();
    const events: ChangeEvent[] = [];
    ws.subscribe((e) => events.push(e));
    const r = ws.applyEdits(
      WO,
      [
        { rowKey: C11, col: "DESCRIPTION", value: "X" },
        { rowKey: C21, col: NOTE, value: "Y" },
      ],
      { author: "llm", reason: "r" },
    );
    const u = ws.undoBatch(r.batchId as string);
    expect(u).toEqual({ batchId: r.batchId, applied: 3, conflicts: [], revision: r.revision + 1 });
    expect([val(ws, WO, C11, "DESCRIPTION"), val(ws, WO, C12, "DESCRIPTION"), val(ws, WO, C21, NOTE)]).toEqual(["pump", "pump", "c"]);
    expect(ws.getDiff(WO).total).toBe(0);
    expect(ws.listBatches(WO)[0]?.undone).toBe(true);
    expect(events.at(-1)).toEqual({ revision: u.revision, sheet: WO, kind: "batch_undone", batchId: r.batchId });
    expectStoreError(() => ws.undoBatch(r.batchId as string), "batch_already_undone");
    expectStoreError(() => ws.undoBatch("b999-000000"), "batch_not_found");
  });

  it("取り消しも変更として数え、古い revision で読んだ LLM の変更は衝突にする", () => {
    const ws = setup();
    const r = ws.applyEdits(WO, [{ rowKey: C21, col: NOTE, value: "Y" }], { author: "user" });
    const read = ws.revision;
    ws.undoBatch(r.batchId as string);
    expect(ws.applyEdits(WO, [{ rowKey: C21, col: NOTE, value: "Z" }], { author: "llm", baseRevision: read }).conflicts).toEqual([
      { rowKey: C21, col: NOTE, reason: "changed_since_read" },
    ]);
  });

  it("衝突: 後のバッチが変えたセルは取り消さず、他は取り消す。後のバッチを取り消せば残りを取り消せる", () => {
    const ws = setup();
    const b1 = ws.applyEdits(
      WO,
      [
        { rowKey: C11, col: NOTE, value: "1" },
        { rowKey: C21, col: NOTE, value: "1" },
      ],
      { author: "llm" },
    );
    const b2 = ws.applyEdits(WO, [{ rowKey: C11, col: NOTE, value: "2" }], { author: "user" });
    const u1 = ws.undoBatch(b1.batchId as string);
    expect(u1.conflicts).toEqual([{ rowKey: C11, col: NOTE, reason: "changed_since_read" }]);
    expect(u1.applied).toBe(1);
    expect(val(ws, WO, C11, NOTE)).toBe("2");
    expect(val(ws, WO, C21, NOTE)).toBe("c");
    expect(ws.listBatches(WO)[0]?.undone).toBe(false);

    ws.undoBatch(b2.batchId as string);
    expect(val(ws, WO, C11, NOTE)).toBe("1");
    const again = ws.undoBatch(b1.batchId as string);
    expect(again).toMatchObject({ applied: 1, conflicts: [] });
    expect(val(ws, WO, C11, NOTE)).toBe("a");
    expect(ws.listBatches(WO).map((b) => b.undone)).toEqual([true, true]);
  });

  it("衝突: 後で子を追加した親行・後で削除した追加行は取り消さない", () => {
    const ws = setup();
    const add = ws.addRows(WO, [{ SITEID: "BEDFORD", WONUM: "WO9" }], { author: "llm" });
    const key = makeParentKey(["BEDFORD", "WO9"]);
    const child = ws.addRows(WO, [{ [NOTE]: "n" }], { author: "llm", parentRowKey: key });
    expect(ws.undoBatch(add.batchId as string).conflicts).toEqual([{ rowKey: key, col: "", reason: "changed_since_read" }]);
    ws.undoBatch(child.batchId as string);
    expect(ws.undoBatch(add.batchId as string)).toMatchObject({ applied: 1, conflicts: [] });
    expect(ws.getSheet(WO).row(key)).toBeUndefined();

    const add2 = ws.addRows(WO, [{ SITEID: "BEDFORD", WONUM: "WO7" }], { author: "llm" });
    const k2 = makeParentKey(["BEDFORD", "WO7"]);
    const del = ws.deleteRows(WO, [k2], { author: "user" });
    expect(ws.undoBatch(add2.batchId as string).conflicts).toEqual([{ rowKey: k2, col: "", reason: "changed_since_read" }]);
    ws.undoBatch(del.batchId as string);
    expect(ws.undoBatch(add2.batchId as string).conflicts).toEqual([]);
  });
});

describe("queryRows", () => {
  it("ビュー: final は変更後、base は元の値、diff は変わった行だけ", () => {
    const ws = setup();
    ws.applyEdits(WO, [{ rowKey: C11, col: NOTE, value: "new" }], { author: "llm" });
    ws.deleteRows(WO, [C21], { author: "llm" });
    const cols = ["WONUM", NOTE];
    const final = ws.queryRows(WO, { columns: cols });
    expect(final.rows.map((r) => [r.rowKey, r.values[NOTE]])).toEqual([
      [C11, "new"],
      [C12, "b"],
      [P3, null],
    ]);
    expect(final).toMatchObject({ total: 3, nextCursor: null, revision: ws.revision });
    const base = ws.queryRows(WO, { columns: cols, view: "base" });
    expect(base.rows.map((r) => [r.rowKey, r.values[NOTE]])).toEqual([
      [C11, "a"],
      [C12, "b"],
      [C21, "c"],
      [P3, null],
    ]);
    const diff = ws.queryRows(WO, { columns: cols, view: "diff" });
    expect(diff.rows).toEqual([
      { rowKey: C11, values: { WONUM: "WO1", [NOTE]: "new" }, status: "changed", changedColumns: [NOTE] },
      { rowKey: C21, values: { WONUM: "WO2", [NOTE]: "c" }, status: "deleted" },
    ]);
    // 条件もビューの値で評価する
    expect(ws.queryRows(WO, { filter: [{ attr: NOTE, op: "eq", value: "new" }] }).rows.map((r) => r.rowKey)).toEqual([C11]);
    expect(ws.queryRows(WO, { filter: [{ attr: NOTE, op: "eq", value: "new" }], view: "base" }).total).toBe(0);
  });

  it("ページング: limit と nextCursor", () => {
    const ws = setup();
    const p1 = ws.queryRows(WO, { limit: 3 });
    expect(p1.rows.map((r) => r.rowKey)).toEqual([C11, C12, C21]);
    expect(p1.total).toBe(4);
    expect(typeof p1.nextCursor).toBe("string");
    const p2 = ws.queryRows(WO, { limit: 3, cursor: p1.nextCursor as string });
    expect(p2.rows.map((r) => r.rowKey)).toEqual([P3]);
    expect(p2.nextCursor).toBeNull();
    expectStoreError(() => ws.queryRows(WO, { cursor: "not-a-cursor" }), "invalid_cursor");
    expectStoreError(() => ws.queryRows(WO, { limit: 0 }), "invalid_args");
  });

  it("columns 省略時はキー列と先頭 10 列。誤った列・ビューは型付きエラー", () => {
    const ws = new Workspace("w");
    const names = ["C1", "K", ...Array.from({ length: 12 }, (_, i) => `X${i + 1}`)];
    ws.createSheet(
      { name: "wide", source: { kind: "maximo", os: "OS", select: [], where: [] }, columns: names.map((name) => ({ name, type: "string" })), keyColumns: ["K"], childIdAttrs: {} },
      [{ rowKey: "k", parentKey: "k", childName: null, values: Object.fromEntries(names.map((n) => [n, n.toLowerCase()])) }],
    );
    const r = ws.queryRows("wide");
    expect(Object.keys(r.rows[0]?.values ?? {})).toEqual(["K", "C1", "X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9"]);
    expectStoreError(() => ws.queryRows("wide", { columns: ["NOPE"] }), "column_not_found");
    expectStoreError(() => ws.queryRows("wide", { view: "other" as ViewKind }), "invalid_args");
  });
});

describe("aggregate", () => {
  it("最終ビューを列の値で数える。null と空文字は同じグループ", () => {
    const ws = setup();
    expect(ws.aggregate(WO, { groupBy: ["SITEID"] })).toEqual({
      groups: [
        { key: { SITEID: "BEDFORD" }, count: 3 },
        { key: { SITEID: "OTH" }, count: 1 },
      ],
      totalGroups: 2,
      revision: ws.revision,
    });
    ws.applyEdits(WO, [{ rowKey: C21, col: "DESCRIPTION", value: null }], { author: "user" });
    const g = ws.aggregate(WO, { groupBy: ["DESCRIPTION"] });
    expect(g.groups).toEqual([
      { key: { DESCRIPTION: "pump" }, count: 2 },
      { key: { DESCRIPTION: null }, count: 2 },
    ]);
    const filtered = ws.aggregate(WO, { groupBy: ["SITEID", "WONUM"], filter: [{ attr: "SITEID", op: "eq", value: "BEDFORD" }], limit: 1 });
    expect(filtered).toMatchObject({ groups: [{ key: { SITEID: "BEDFORD", WONUM: "WO1" }, count: 2 }], totalGroups: 2 });
    // 削除した行は数えない。件数が同じグループはキーの順
    ws.deleteRows(WO, [C11], { author: "user" });
    expect(ws.aggregate(WO, { groupBy: ["WONUM"] }).groups).toEqual([
      { key: { WONUM: "WO1" }, count: 1 },
      { key: { WONUM: "WO2" }, count: 1 },
      { key: { WONUM: "WO3" }, count: 1 },
    ]);
    expectStoreError(() => ws.aggregate(WO, { groupBy: [] }), "invalid_args");
    expectStoreError(() => ws.aggregate(WO, { groupBy: ["NOPE"] }), "column_not_found");
  });
});

describe("matchSheets", () => {
  it("単一列: 右側で同じ正規化キーが複数あれば ambiguous", () => {
    const ws = setup();
    const m = ws.matchSheets("req", "asset", "TAG", "TAGNO", ["trim", "upper"], 10);
    expect(m).toMatchObject({ matched: 2, unmatchedLeft: 2, unmatchedRight: 1, ambiguous: 3 });
    expect(m.samples.matched).toEqual([
      { leftRowKey: "r6", rightRowKey: "A5", key: "P-500" },
      { leftRowKey: "r7", rightRowKey: "A5", key: "P-500" },
    ]);
    expect(m.samples.ambiguous[0]).toEqual({ leftRowKey: "r1", key: "P-101", candidates: ["A1", "A4"] });
    expect(m.samples.unmatchedLeft).toEqual([
      { rowKey: "r3", key: "P-999" },
      { rowKey: "r4", key: "" },
    ]);
    expect(m.samples.unmatchedRight).toEqual([{ rowKey: "A6", key: "P-600" }]);
    // サンプル数の上限
    const small = ws.matchSheets("req", "asset", "TAG", "TAGNO", ["trim", "upper"], 1);
    expect(small.ambiguous).toBe(3);
    expect(small.samples.ambiguous).toHaveLength(1);
    // 正規化しなければ " p-101 " は一致しない
    expect(ws.matchSheets("req", "asset", "TAG", "TAGNO", [], 0).ambiguous).toBe(1);
  });

  it("複合キー: 列の組で突合し、key は | で連結、どれか空なら unmatched", () => {
    const ws = setup();
    const m = ws.matchSheets("req", "asset", ["SITEID", "TAG"], ["SITEID", "TAGNO"], ["trim", "upper"], 10);
    expect(m).toMatchObject({ matched: 3, unmatchedLeft: 3, unmatchedRight: 1, ambiguous: 1 });
    expect(m.samples.matched[0]).toEqual({ leftRowKey: "r1", rightRowKey: "A1", key: "BEDFORD | P-101" });
    expect(m.samples.ambiguous).toEqual([{ leftRowKey: "r2", key: "BEDFORD | P-102", candidates: ["A2", "A3"] }]);
    expect(m.samples.unmatchedLeft).toEqual([
      { rowKey: "r3", key: "BEDFORD | P-999" },
      { rowKey: "r4", key: "BEDFORD | " },
      { rowKey: "r7", key: " | P-500" },
    ]);
    expectStoreError(() => ws.matchSheets("req", "asset", ["SITEID", "TAG"], "TAGNO", [], 10), "invalid_args");
    expectStoreError(() => ws.matchSheets("req", "asset", "NOPE", "TAGNO", [], 10), "column_not_found");
    expectStoreError(() => ws.matchSheets("req", "asset", "TAG", "TAGNO", [], -1), "invalid_args");
  });

  it("突合列がすべて親の列なら同じ親の子行は 1 件、子の列を含めば行ごと", () => {
    const ws = setup();
    expect(ws.matchSheets(WO, WO, "WONUM", "WONUM", [], 0)).toMatchObject({ matched: 3, ambiguous: 0, unmatchedLeft: 0, unmatchedRight: 0 });
    expect(ws.matchSheets(WO, WO, ["WONUM", NOTE], ["WONUM", NOTE], [], 0)).toMatchObject({ matched: 3, ambiguous: 0, unmatchedLeft: 1, unmatchedRight: 1 });
  });
});

describe("toJSON / fromJSON", () => {
  it("JSON を通して往復でき、復元後も取り消し・変更を続けられる", () => {
    const ws = setup();
    ws.applyEdits(WO, [{ rowKey: C11, col: "DESCRIPTION", value: "X", reason: "セルの根拠" }], { author: "llm", reason: "r1" });
    const add = ws.addRows(WO, [{ [NOTE]: "child" }], { author: "llm", parentRowKey: C21, reason: "r2" });
    ws.deleteRows(WO, [P3], { author: "user" });
    const undone = ws.applyRule("req", [], { LOC: COMPOSITE_LOOKUP }, { author: "llm", reason: "r3" });
    ws.undoBatch(undone.batchId as string);
    ws.applyEdits("asset", [{ rowKey: "A1", col: "LOCATION", value: "L" }], { author: "user" });

    const json = JSON.parse(JSON.stringify(ws.toJSON()));
    const restored = Workspace.fromJSON(json, { now: () => 1_700_000_000_000 });
    expect(restored.toJSON()).toEqual(ws.toJSON());
    expect(restored.status()).toEqual(ws.status());
    expect(restored.listBatches()).toEqual(ws.listBatches());
    for (const name of [WO, "req", "asset"]) {
      for (const view of ["final", "base", "diff"] as const) {
        expect(restored.queryRows(name, { view, limit: 100 })).toEqual(ws.queryRows(name, { view, limit: 100 }));
      }
      expect(restored.getDiff(name)).toEqual(ws.getDiff(name));
    }
    expect(restored.cell(WO, C12, "DESCRIPTION")).toEqual(ws.cell(WO, C12, "DESCRIPTION"));

    // 復元後も同じように取り消せる
    for (const w of [ws, restored]) {
      const u = w.undoBatch(add.batchId as string);
      expect(u.conflicts).toEqual([]);
    }
    expect(restored.queryRows(WO, { limit: 100 })).toEqual(ws.queryRows(WO, { limit: 100 }));
    // 復元後の新しいバッチ ID は既存と重ならない
    const next = restored.applyEdits(WO, [{ rowKey: C11, col: NOTE, value: "z" }], { author: "user" });
    expect(restored.listBatches().filter((b) => b.batchId === next.batchId)).toHaveLength(1);
    expect(next.revision).toBe(ws.revision + 1);
  });

  it("形式の違うデータは invalid_args", () => {
    expectStoreError(() => Workspace.fromJSON({ format: "other" } as never), "invalid_args");
  });

  it("toJSON の結果や batches を書き換えようとしても内部状態は壊れない", () => {
    const ws = setup();
    const r = ws.applyEdits(WO, [{ rowKey: C11, col: NOTE, value: "x" }], { author: "llm" });
    const entry = ws.toJSON().sheets[0]?.rowMarks[0]?.cells?.[0]?.[1];
    expect(entry).toMatchObject({ value: "x", batchId: r.batchId });
    expect(() => {
      (entry as { value: CellValue }).value = "tampered";
    }).toThrow(TypeError);
    expect(() => (ws.batches[0]?.ops as unknown[]).push({})).toThrow(TypeError);
    const copy = ws.batches[0];
    if (copy) copy.undone = true;
    expect(ws.listBatches(WO)[0]?.undone).toBe(false);
    expect(val(ws, WO, C11, NOTE)).toBe("x");
    expect(ws.undoBatch(r.batchId as string)).toMatchObject({ applied: 1, conflicts: [] });
  });
});

describe("入力の検査", () => {
  it("現在より新しい baseRevision は invalid_args（開き直した後の古い revision で compare-and-set をすり抜けない）", () => {
    const ws = setup();
    const future = ws.revision + 1;
    expectStoreError(() => ws.applyEdits(WO, [{ rowKey: C11, col: NOTE, value: "x" }], { author: "llm", baseRevision: future }), "invalid_args");
    expectStoreError(() => ws.applyRule(WO, [], { [NOTE]: { const: "x" } }, { author: "llm", baseRevision: future, dryRun: true }), "invalid_args");
    expectStoreError(() => ws.addRows(WO, [{ SITEID: "BEDFORD", WONUM: "WO9" }], { author: "llm", baseRevision: future }), "invalid_args");
    expectStoreError(() => ws.deleteRows(WO, [C11], { author: "llm", baseRevision: future }), "invalid_args");
    expect(val(ws, WO, C11, NOTE)).toBe("a");
    expect(ws.applyEdits(WO, [{ rowKey: C11, col: NOTE, value: "x" }], { author: "llm", baseRevision: ws.revision }).applied).toBe(1);
  });

  it("createSheet: 行キーと親キーの形の誤り・列名 __proto__ は invalid_args（親の列の反映が別の行に及ばないように）", () => {
    const ws = new Workspace("w");
    const [c11, , , p3] = woRows() as [SheetRow, SheetRow, SheetRow, SheetRow];
    expectStoreError(() => ws.createSheet(woMeta(), [{ ...p3, parentKey: "other" }]), "invalid_args");
    expectStoreError(() => ws.createSheet(woMeta(), [{ ...c11, parentKey: P2 }]), "invalid_args");
    expectStoreError(() => ws.createSheet(woMeta(), [{ ...c11, childName: null }]), "invalid_args");
    expectStoreError(() => ws.createSheet(woMeta(), [{ ...c11, childName: "OTHER" }]), "invalid_args");
    expectStoreError(() => ws.createSheet({ ...woMeta(), columns: [...WO_COLUMNS, { name: "__proto__", type: "string" }] }, woRows()), "invalid_args");
    expect(ws.sheets.size).toBe(0);
    expect(ws.revision).toBe(0);
  });

  it("列名が Object.prototype のプロパティ名でも、値の無いセルは null", () => {
    const ws = new Workspace("w");
    ws.createSheet(
      {
        name: "x",
        source: { kind: "excel", importId: "i", fileName: "f.xlsx", sheetName: "S", headerRow: 1 },
        columns: ["ID", "constructor", "toString"].map((name) => ({ name, type: "string" as const })),
        keyColumns: ["ID"],
        childIdAttrs: {},
      },
      [{ rowKey: "1", parentKey: "1", childName: null, values: { ID: "1" } }],
    );
    expect(ws.getSheet("x").rowValues("1")).toEqual({ ID: "1", constructor: null, toString: null });
    expect(ws.queryRows("x", { filter: [{ attr: "constructor", op: "isnull" }] }).total).toBe(1);
    expect(ws.addRows("x", [{ ID: "2" }], { author: "llm" }).applied).toBe(1);
    expect(ws.getDiff("x").entries[0]?.values).toEqual({ ID: "2" });
  });

  it("createSheet の後に呼び出し元が meta を書き換えてもシートは変わらず、返した列の定義も書き換えられない", () => {
    const ws = new Workspace("w");
    const meta = { ...woMeta(), columns: [...WO_COLUMNS] };
    ws.createSheet(meta, woRows());
    meta.columns.push({ name: "EXTRA", type: "string" });
    meta.keyColumns.push("DESCRIPTION");
    expect(ws.summary(WO).columns.map((c) => c.name)).not.toContain("EXTRA");
    expect(ws.summary(WO).keyColumns).toEqual(["SITEID", "WONUM"]);
    expect(() => (ws.summary(WO).columns as ColumnSchema[]).push({ name: "X", type: "string" })).toThrow(TypeError);
  });
});

describe("undoBatch: 親の列の組と編集中のセル", () => {
  it("後から追加した子行が親の列の変更後の値を写していれば、その親の組は取り消さず、他の組は取り消す", () => {
    const ws = setup();
    const b1 = ws.applyEdits(
      WO,
      [
        { rowKey: C11, col: "DESCRIPTION", value: "X" },
        { rowKey: C21, col: "DESCRIPTION", value: "Y" },
        { rowKey: C11, col: NOTE, value: "n1" },
      ],
      { author: "llm" },
    );
    const add = ws.addRows(WO, [{ [NOTE]: "n" }], { author: "user", parentRowKey: C11 });
    const child = makeChildRowKey(P1, CH, "new~1");
    expect(val(ws, WO, child, "DESCRIPTION")).toBe("X");

    const u = ws.undoBatch(b1.batchId as string);
    expect(u).toMatchObject({ batchId: b1.batchId, applied: 2 });
    expect(u.conflicts).toEqual([
      { rowKey: C12, col: "DESCRIPTION", reason: "changed_since_read" },
      { rowKey: C11, col: "DESCRIPTION", reason: "changed_since_read" },
    ]);
    // 同じ親の行で親の列の値が食い違わない
    expect([C11, C12, child].map((k) => val(ws, WO, k, "DESCRIPTION"))).toEqual(["X", "X", "X"]);
    expect([val(ws, WO, C21, "DESCRIPTION"), val(ws, WO, C11, NOTE)]).toEqual(["valve", "a"]);
    expect(ws.listBatches(WO)[0]?.undone).toBe(false);

    // 子の追加を取り消せば残りを取り消せる
    ws.undoBatch(add.batchId as string);
    expect(ws.undoBatch(b1.batchId as string)).toMatchObject({ applied: 2, conflicts: [] });
    expect([C11, C12].map((k) => val(ws, WO, k, "DESCRIPTION"))).toEqual(["pump", "pump"]);
    expect(ws.listBatches(WO)[0]?.undone).toBe(true);
  });

  it("llm の取り消しは利用者が編集中のセル・行を user_editing にして残す（親の列は同じ親の組ごと残す）", () => {
    const ws = setup();
    const b1 = ws.applyEdits(
      WO,
      [
        { rowKey: C11, col: "DESCRIPTION", value: "X" },
        { rowKey: C21, col: NOTE, value: "Y" },
      ],
      { author: "llm" },
    );
    ws.setEditingCell(WO, C12, "DESCRIPTION");
    const u = ws.undoBatch(b1.batchId as string, { author: "llm" });
    expect(u.applied).toBe(1);
    expect(u.conflicts).toEqual([
      { rowKey: C12, col: "DESCRIPTION", reason: "user_editing" },
      { rowKey: C11, col: "DESCRIPTION", reason: "user_editing" },
    ]);
    expect([val(ws, WO, C11, "DESCRIPTION"), val(ws, WO, C12, "DESCRIPTION"), val(ws, WO, C21, NOTE)]).toEqual(["X", "X", "c"]);
    // 利用者の取り消し（author 省略）は編集中でも取り消す
    expect(ws.undoBatch(b1.batchId as string)).toMatchObject({ applied: 2, conflicts: [] });

    const add = ws.addRows(WO, [{ SITEID: "BEDFORD", WONUM: "WO9", DESCRIPTION: "new" }], { author: "llm" });
    const key = makeParentKey(["BEDFORD", "WO9"]);
    ws.setEditingCell(WO, key, "DESCRIPTION");
    expect(ws.undoBatch(add.batchId as string, { author: "llm" }).conflicts).toEqual([{ rowKey: key, col: "DESCRIPTION", reason: "user_editing" }]);
    expectStoreError(() => ws.undoBatch(add.batchId as string, { author: "bot" as "llm" }), "invalid_args");
  });
});

describe("addRows の compare-and-set と親の削除", () => {
  it("読んだ後に同じ親の行が増減した・シートを読み込み直したら changed_since_read", () => {
    const ws = setup();
    const read = ws.revision;
    ws.addRows(WO, [{ [NOTE]: "user" }], { author: "user", parentRowKey: C11 });
    expect(ws.addRows(WO, [{ [NOTE]: "llm" }], { author: "llm", parentRowKey: C12, baseRevision: read })).toMatchObject({
      batchId: null,
      applied: 0,
      conflicts: [{ rowKey: C12, col: "", reason: "changed_since_read" }],
    });
    // 別の親、読み直した後は通る
    expect(ws.addRows(WO, [{ [NOTE]: "llm" }], { author: "llm", parentRowKey: C21, baseRevision: read }).applied).toBe(1);
    expect(ws.addRows(WO, [{ [NOTE]: "llm" }], { author: "llm", parentRowKey: C12, baseRevision: ws.revision }).applied).toBe(1);

    // 削除とその取り消しも同じ親の変更として数える
    const r2 = ws.revision;
    const del = ws.deleteRows(WO, [C21], { author: "user" });
    ws.undoBatch(del.batchId as string);
    expect(ws.addRows(WO, [{ [NOTE]: "x" }], { author: "llm", parentRowKey: C21, baseRevision: r2 }).conflicts).toEqual([
      { rowKey: C21, col: "", reason: "changed_since_read" },
    ]);

    // 親行の追加: シートを読み込み直す前の読み取りは衝突
    const before = ws.revision;
    ws.createSheet(woMeta(), woRows());
    const key = makeParentKey(["BEDFORD", "WO9"]);
    expect(ws.addRows(WO, [{ SITEID: "BEDFORD", WONUM: "WO9" }], { author: "llm", baseRevision: before }).conflicts).toEqual([
      { rowKey: key, col: "", reason: "changed_since_read" },
    ]);
    expect(ws.addRows(WO, [{ SITEID: "BEDFORD", WONUM: "WO9" }], { author: "llm", baseRevision: ws.revision }).applied).toBe(1);
  });

  it("親だけの行に削除の印が付いた親には、後から足した子行を指定しても子を追加しない", () => {
    const ws = setup();
    expect(ws.addRows(WO, [{ [NOTE]: "n" }], { author: "llm", parentRowKey: P3 }).applied).toBe(1);
    const child = makeChildRowKey(P3, CH, "new~1");
    ws.deleteRows(WO, [P3], { author: "user" });
    expect(ws.addRows(WO, [{ [NOTE]: "m" }], { author: "llm", parentRowKey: child }).conflicts).toEqual([{ rowKey: child, col: "", reason: "row_not_found" }]);
  });
});
