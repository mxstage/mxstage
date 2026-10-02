// 子の表の横持ち（src/app/grid/pivot.ts）: 形の見分け方、横持ちの作り方、値の列の選び方、既定の向き。
import { describe, expect, it } from "vitest";
import { buildPivot, pivotCell, pivotSpecFor, preferPivot } from "../../src/app/grid/pivot";
import { loadOrientations, orientationKey, saveOrientations } from "../../src/app/pages/orientation";
import { Workspace } from "../../src/app/store/workspace";
import type { ColumnSchema } from "../../src/shared/model";
import { makeChildRowKey, makeParentKey, type SheetMeta, type SheetRow } from "../../src/shared/sheet";

const SPEC_COLUMNS: ColumnSchema[] = [
  { name: "ASSETNUM", type: "string" },
  { name: "SITEID", type: "string" },
  { name: "DESCRIPTION", type: "string" },
  { name: "ASSETSPEC.ASSETATTRID", type: "string", child: "ASSETSPEC" },
  { name: "ASSETSPEC.ALNVALUE", type: "string", child: "ASSETSPEC" },
  { name: "ASSETSPEC.NUMVALUE", type: "number", child: "ASSETSPEC" },
  { name: "ASSETSPEC.MEASUREUNITID", type: "string", child: "ASSETSPEC" },
  { name: "ASSETSPEC.ASSETSPECID", type: "integer", child: "ASSETSPEC" },
];

type Spec = [attr: string, aln: string | null, num: number | null, unit: string | null];

/** 資産と仕様のシート（親ごとに仕様の行。仕様の無い親は親の行だけ） */
function specWorkspace(assets: Record<string, Spec[]>): Workspace {
  const ws = new Workspace("test");
  const meta: SheetMeta = {
    name: "資産",
    source: { kind: "maximo", os: "MXAPIASSET", select: [], where: [], baseUrl: "https://maximo.example.com" },
    columns: SPEC_COLUMNS,
    keyColumns: ["ASSETNUM", "SITEID"],
    childIdAttrs: { ASSETSPEC: "ASSETSPECID" },
  };
  const rows: SheetRow[] = [];
  let id = 1;
  for (const [assetnum, specs] of Object.entries(assets)) {
    const parentKey = makeParentKey([assetnum, "KITA"]);
    const base = { ASSETNUM: assetnum, SITEID: "KITA", DESCRIPTION: `${assetnum} の説明` };
    if (specs.length === 0) {
      rows.push({ rowKey: parentKey, parentKey, childName: null, values: { ...base, "ASSETSPEC.ASSETATTRID": null, "ASSETSPEC.ALNVALUE": null, "ASSETSPEC.NUMVALUE": null, "ASSETSPEC.MEASUREUNITID": null, "ASSETSPEC.ASSETSPECID": null } });
      continue;
    }
    for (const [attr, aln, num, unit] of specs) {
      const specId = id++;
      rows.push({
        rowKey: makeChildRowKey(parentKey, "ASSETSPEC", specId),
        parentKey,
        childName: "ASSETSPEC",
        values: { ...base, "ASSETSPEC.ASSETATTRID": attr, "ASSETSPEC.ALNVALUE": aln, "ASSETSPEC.NUMVALUE": num, "ASSETSPEC.MEASUREUNITID": unit, "ASSETSPEC.ASSETSPECID": specId },
      });
    }
  }
  ws.createSheet(meta, rows);
  return ws;
}

const PUMPS: Record<string, Spec[]> = {
  "P-1": [
    ["RATED_POWER", null, 15, "KW"],
    ["MAKER", "荏原", null, null],
    ["FLOW", null, 120, "M3/H"],
  ],
  "P-2": [
    ["RATED_POWER", null, 22, "KW"],
    ["MAKER", "酉島", null, null],
    // 数値の項目が文字で入っている
    ["FLOW", "90", null, "L/MIN"],
  ],
  "P-3": [],
};

describe("形の見分け方", () => {
  it("項目名（〜ATTRID）と値の列がある子の表だけ横持ちにできる", () => {
    const ws = specWorkspace(PUMPS);
    const spec = pivotSpecFor(ws.getSheet("資産").meta, "ASSETSPEC");
    expect(spec).toEqual({
      child: "ASSETSPEC",
      nameCol: "ASSETSPEC.ASSETATTRID",
      valueCols: ["ASSETSPEC.ALNVALUE", "ASSETSPEC.NUMVALUE"],
      unitCol: "ASSETSPEC.MEASUREUNITID",
      sectionCol: null,
    });
    const tasks: ColumnSchema[] = [
      { name: "WONUM", type: "string" },
      { name: "WOACTIVITY.TASKID", type: "integer", child: "WOACTIVITY" },
      { name: "WOACTIVITY.DESCRIPTION", type: "string", child: "WOACTIVITY" },
    ];
    expect(pivotSpecFor({ columns: tasks }, "WOACTIVITY")).toBeNull();
  });
});

describe("横持ちの作り方", () => {
  const ws = specWorkspace(PUMPS);
  const sheet = ws.getSheet("資産");
  const spec = pivotSpecFor(sheet.meta, "ASSETSPEC")!;
  const value = (row: Parameters<typeof sheet.finalValue>[0], col: string) => sheet.finalValue(row, col);
  const table = buildPivot(sheet.viewRows("final"), spec, value);

  it("1 行 ＝ 1 親（仕様の無い親も出す）、1 列 ＝ 1 項目", () => {
    expect(table.rows.map((r) => r.parent.base.ASSETNUM)).toEqual(["P-1", "P-2", "P-3"]);
    expect(table.columns.map((c) => c.attr).sort()).toEqual(["FLOW", "MAKER", "RATED_POWER"]);
  });

  it("項目ごとに、値の多く入っている列を値の列にする。単位が混ざっていれば両方を持つ", () => {
    const byAttr = new Map(table.columns.map((c) => [c.attr, c]));
    expect(byAttr.get("RATED_POWER")).toMatchObject({ valueCol: "ASSETSPEC.NUMVALUE", units: ["KW"], count: 2 });
    expect(byAttr.get("MAKER")).toMatchObject({ valueCol: "ASSETSPEC.ALNVALUE" });
    expect(byAttr.get("FLOW")?.units).toEqual(["L/MIN", "M3/H"]);
  });

  it("セル: 行が無ければ欠け、主の列が空でほかの列に値があればその列", () => {
    const flow = table.columns.find((c) => c.attr === "FLOW")!;
    const power = table.columns.find((c) => c.attr === "RATED_POWER")!;
    const [p1, p2, p3] = table.rows;
    expect(pivotCell(p1!, power, spec, value)).toMatchObject({ valueCol: "ASSETSPEC.NUMVALUE", otherColumn: false, count: 1 });
    // FLOW は NUMVALUE と ALNVALUE が 1 件ずつ。並びの先の ALNVALUE が値の列になり、P-1 は NUMVALUE に入っている
    const cell1 = pivotCell(p1!, flow, spec, value);
    const cell2 = pivotCell(p2!, flow, spec, value);
    expect([cell1.valueCol, cell2.valueCol].sort()).toEqual(["ASSETSPEC.ALNVALUE", "ASSETSPEC.NUMVALUE"]);
    expect(cell1.otherColumn !== cell2.otherColumn).toBe(true);
    expect(pivotCell(p3!, power, spec, value)).toMatchObject({ row: null, count: 0 });
  });

  it("横持ちのセルを直すと、縦持ちの行の値の列が変わる（差分・取り消しはそのまま）", () => {
    const w = specWorkspace(PUMPS);
    const s = w.getSheet("資産");
    const sp = pivotSpecFor(s.meta, "ASSETSPEC")!;
    const v = (row: Parameters<typeof s.finalValue>[0], col: string) => s.finalValue(row, col);
    const t = buildPivot(s.viewRows("final"), sp, v);
    const power = t.columns.find((c) => c.attr === "RATED_POWER")!;
    const cell = pivotCell(t.rows[0]!, power, sp, v);
    const res = w.applyEdits("資産", [{ rowKey: cell.row!.rowKey, col: cell.valueCol, value: 18.5 }], { author: "user" });
    expect(res.conflicts).toEqual([]);
    const after = buildPivot(s.viewRows("final"), sp, v);
    expect(v(pivotCell(after.rows[0]!, power, sp, v).row!, "ASSETSPEC.NUMVALUE")).toBe(18.5);
    expect(w.getDiff("資産").changedCells).toBe(1);
  });
});

describe("既定の向き", () => {
  it("仕様のように項目が繰り返される表は横持ち", () => {
    const ws = specWorkspace(PUMPS);
    const sheet = ws.getSheet("資産");
    const spec = pivotSpecFor(sheet.meta, "ASSETSPEC")!;
    expect(preferPivot(sheet.viewRows("final"), spec, (r, c) => sheet.finalValue(r, c))).toBe(true);
  });

  it("項目名が行ごとに違う（繰り返さない）表は縦持ち", () => {
    const unique: Record<string, Spec[]> = {};
    for (let i = 0; i < 5; i++) unique[`A-${i}`] = [[`X${i}A`, "a", null, null], [`X${i}B`, "b", null, null]];
    const ws = specWorkspace(unique);
    const sheet = ws.getSheet("資産");
    const spec = pivotSpecFor(sheet.meta, "ASSETSPEC")!;
    expect(preferPivot(sheet.viewRows("final"), spec, (r, c) => sheet.finalValue(r, c))).toBe(false);
  });
});

describe("向きを覚える", () => {
  it("構造と子ごとに覚え、読めない値は捨てる", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const key = orientationKey({ name: "資産", source: { kind: "maximo", os: "MXAPIASSET", select: [], where: [] } }, "ASSETSPEC");
    expect(key).toBe("MXAPIASSET/ASSETSPEC");
    saveOrientations(storage, { [key]: "vertical" });
    expect(loadOrientations(storage)).toEqual({ [key]: "vertical" });
    data.set("mxstage.grid.orientations", JSON.stringify({ a: "sideways", b: "horizontal" }));
    expect(loadOrientations(storage)).toEqual({ b: "horizontal" });
  });
});
