// Workspace.changes（Maximo への反映に渡す差分）と Sheet.record（親キー → 親レコード）の試験。
// 削除した行に残った親の列の変更を捨てないこと、行が 1 つも残らない親は知らせることを確かめる。

import { describe, expect, it } from "vitest";
import type { ColumnSchema } from "../../src/shared/model";
import { makeChildRowKey, makeParentKey, type MaximoRecord, type SheetMeta, type SheetRow } from "../../src/shared/sheet";
import { Workspace } from "../../src/app/store/workspace";

const WO = "wo";
const CH = "EXT_WOPERMIT";
const MULTIID = `${CH}.MULTIID`;
const NOTE = `${CH}.NOTE`;
const P1 = makeParentKey(["BEDFORD", "WO1"]);
const P2 = makeParentKey(["BEDFORD", "WO2"]);
const C11 = makeChildRowKey(P1, CH, 11);
const C12 = makeChildRowKey(P1, CH, 12);
const C21 = makeChildRowKey(P2, CH, 21);

const COLUMNS: ColumnSchema[] = [
  { name: "SITEID", type: "string" },
  { name: "WONUM", type: "string" },
  { name: "DESCRIPTION", type: "string" },
  { name: MULTIID, type: "integer", child: CH },
  { name: NOTE, type: "string", child: CH },
];

function meta(name = WO, keyColumns = ["SITEID", "WONUM"]): SheetMeta {
  return {
    name,
    source: { kind: "maximo", os: "MXAPIWO", select: ["*"], where: [] },
    columns: COLUMNS,
    keyColumns,
    childIdAttrs: { [CH]: "MULTIID" },
  };
}

function rows(): SheetRow[] {
  const p1 = { SITEID: "BEDFORD", WONUM: "WO1", DESCRIPTION: "pump" };
  const p2 = { SITEID: "BEDFORD", WONUM: "WO2", DESCRIPTION: "valve" };
  return [
    { rowKey: C11, parentKey: P1, childName: CH, values: { ...p1, [MULTIID]: 11, [NOTE]: "a" } },
    { rowKey: C12, parentKey: P1, childName: CH, values: { ...p1, [MULTIID]: 12, [NOTE]: "b" } },
    { rowKey: C21, parentKey: P2, childName: CH, values: { ...p2, [MULTIID]: 21, [NOTE]: "c" } },
  ];
}

function newWorkspace(): Workspace {
  const ws = new Workspace("作業");
  ws.createSheet(meta(), rows());
  return ws;
}

/** 親の列 DESCRIPTION の変更（親キーごとに 1 件だけのはず） */
const descCells = (ws: Workspace) => ws.changes(WO).cells.filter((c) => c.col === "DESCRIPTION");

describe("Workspace.changes: 削除した行に残った親の列の変更", () => {
  it("同じ親に行が残っていれば、残っている行に付け替えて反映対象にする", () => {
    const ws = newWorkspace();
    ws.applyEdits(WO, [{ rowKey: C11, col: "DESCRIPTION", value: "新しい説明" }], { author: "user" });
    ws.deleteRows(WO, [C11], { author: "user" });

    const changes = ws.changes(WO);
    expect(changes.deletedRows).toEqual([C11]);
    expect(changes.unwritableParentEdits).toEqual([]);
    // 同じ親の列を二重に出さない（親の列は同じ親のどの行から出しても同じ 1 件）
    expect(descCells(ws)).toEqual([{ rowKey: C12, col: "DESCRIPTION", value: "新しい説明" }]);
    // 反映パネル・差分の件数と食い違わない
    expect(changes.cells).toHaveLength(1);
    expect(ws.summary(WO).changedCells).toBe(1);
    expect(ws.getDiff(WO).changedCells).toBe(1);
  });

  it("残っている行が追加行だけでも、親の列の変更を捨てない", () => {
    const ws = newWorkspace();
    ws.applyEdits(WO, [{ rowKey: C11, col: "DESCRIPTION", value: "新しい説明" }], { author: "user" });
    // 追加行は親の列の最終値を base に持つ（overlay は持たない）
    const added = ws.addRows(WO, [{ [NOTE]: "new" }], { author: "user", parentRowKey: C11 });
    expect(added.applied).toBe(1);
    ws.deleteRows(WO, [C11, C12], { author: "user" });

    const changes = ws.changes(WO);
    const addedRowKey = changes.addedRows[0]!.rowKey;
    expect(changes.unwritableParentEdits).toEqual([]);
    expect(descCells(ws)).toEqual([{ rowKey: addedRowKey, col: "DESCRIPTION", value: "新しい説明" }]);
  });

  it("親の行がすべて削除されたら、反映できない親の列の変更として知らせる", () => {
    const ws = newWorkspace();
    // WO2 は行が 1 つだけ。親の列を変えてからその行を削除する
    ws.applyEdits(WO, [{ rowKey: C21, col: "DESCRIPTION", value: "消える説明" }], { author: "user" });
    ws.deleteRows(WO, [C21], { author: "user" });

    const changes = ws.changes(WO);
    expect(changes.deletedRows).toEqual([C21]);
    expect(descCells(ws)).toEqual([]);
    expect(changes.unwritableParentEdits).toEqual([{ parentKey: P2, columns: ["DESCRIPTION"] }]);
  });

  it("親の列の変更が無ければ、行をすべて削除しても知らせない（子の削除は反映できる）", () => {
    const ws = newWorkspace();
    ws.applyEdits(WO, [{ rowKey: C21, col: NOTE, value: "変更" }], { author: "user" });
    ws.deleteRows(WO, [C21], { author: "user" });

    const changes = ws.changes(WO);
    expect(changes.unwritableParentEdits).toEqual([]);
    // 削除する行のセルの変更は送らない（従来どおり）
    expect(changes.cells).toEqual([]);
    expect(changes.deletedRows).toEqual([C21]);
  });

  it("子の列だけを変えた行を削除しても、親の列として拾わない", () => {
    const ws = newWorkspace();
    ws.applyEdits(
      WO,
      [
        { rowKey: C11, col: NOTE, value: "子だけ変更" },
        { rowKey: C12, col: NOTE, value: "残る行" },
      ],
      { author: "user" },
    );
    ws.deleteRows(WO, [C11], { author: "user" });

    const changes = ws.changes(WO);
    expect(changes.unwritableParentEdits).toEqual([]);
    expect(changes.cells).toEqual([{ rowKey: C12, col: NOTE, value: "残る行" }]);
  });
});

describe("Sheet.record: 親キーの作り方", () => {
  const recordOf = (href: string, attrs: Record<string, string>): MaximoRecord => ({ href, rowstamp: "1", attrs, children: {} });

  it("キー列があればキー値から引き当てる", () => {
    const ws = new Workspace("作業");
    const recs = [recordOf("https://maximo.test/maximo/api/os/mxapiwo/_R1", { SITEID: "BEDFORD", WONUM: "WO1" })];
    ws.createSheet(meta(), rows().slice(0, 2), recs);
    expect(ws.getSheet(WO).record(P1)).toBe(recs[0]);
    expect(ws.getSheet(WO).record(P2)).toBeUndefined();
  });

  it("キー列が決まらなかったシートは href を親キーにする（maximo/load の parentKeyOf と同じ）", () => {
    const ws = new Workspace("作業");
    const href = "https://maximo.test/maximo/api/os/mxapiwo/_R9";
    const recs = [recordOf(href, { SITEID: "BEDFORD", WONUM: "WO9" })];
    const m: SheetMeta = { ...meta("href行"), keyColumns: [] };
    const sheetRows: SheetRow[] = [{ rowKey: href, parentKey: href, childName: null, values: { SITEID: "BEDFORD", WONUM: "WO9", DESCRIPTION: "x" } }];
    ws.createSheet(m, sheetRows, recs);
    expect(ws.getSheet("href行").record(href)).toBe(recs[0]);
  });
});

describe("Workspace.replaceParents: 親キーの作り方", () => {
  it("キー列の綴りが小文字でも、読み直した親レコードを引き当てて置き換える", () => {
    // Maximo から読んだ属性名は常に大文字。キー列の綴りに関わらず parentKeyOf と同じ規則で引く
    const ws = new Workspace("作業");
    const m: SheetMeta = {
      name: "小文字キー",
      source: { kind: "maximo", os: "MXAPIWO", select: ["*"], where: [] },
      columns: [
        { name: "siteid", type: "string" },
        { name: "wonum", type: "string" },
        { name: "description", type: "string" },
      ],
      keyColumns: ["siteid", "wonum"],
      childIdAttrs: {},
    };
    const key = makeParentKey(["BEDFORD", "WO1"]);
    const href = "https://maximo.test/maximo/api/os/mxapiwo/_R1";
    const before: MaximoRecord = { href, rowstamp: "1", attrs: { SITEID: "BEDFORD", WONUM: "WO1", DESCRIPTION: "元の値" }, children: {} };
    ws.createSheet(m, [{ rowKey: key, parentKey: key, childName: null, values: { siteid: "BEDFORD", wonum: "WO1", description: "元の値" } }], [before]);
    // 親レコードの引き当ても同じ規則
    expect(ws.getSheet("小文字キー").record(key)).toBe(before);

    const after: MaximoRecord = { href, rowstamp: "2", attrs: { SITEID: "BEDFORD", WONUM: "WO1", DESCRIPTION: "反映後" }, children: {} };
    const res = ws.replaceParents("小文字キー", [
      { parentKey: key, record: after, rows: [{ rowKey: key, parentKey: key, childName: null, values: { siteid: "BEDFORD", wonum: "WO1", description: "反映後" } }] },
    ]);

    expect(res.skipped).toEqual([]);
    expect(res.replaced).toEqual([key]);
    expect(ws.getSheet("小文字キー").rowValues(key)!.description).toBe("反映後");
  });
});
