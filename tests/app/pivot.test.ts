// 子の表の横持ち（src/app/grid/pivot.ts）: 形の見分け方、横持ちの作り方、値の列の選び方、既定の向き。
import { describe, expect, it } from "vitest";
import {
  addClassColumns,
  buildPivot,
  classLabelText,
  findAttrTypes,
  findClassDefs,
  findClassLabels,
  newSpecRow,
  parentClassColumn,
  pivotCell,
  pivotCellState,
  pivotSpecFor,
  preferPivot,
  type PivotClassInfo,
} from "../../src/app/grid/pivot";
import { loadOrientations, orientationKey, saveOrientations } from "../../src/app/pages/orientation";
import { specificationNote } from "../../src/app/tools/loadSheet";
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

// ---------------------------------------------------------------------------
// 段階 3: 分類による区別と、欠けのセルへの入力
// ---------------------------------------------------------------------------

const ASSET_COLUMNS: ColumnSchema[] = [
  { name: "ASSETNUM", type: "string" },
  { name: "SITEID", type: "string" },
  { name: "CLASSSTRUCTUREID", type: "string" },
  { name: "ASSETSPEC.ASSETATTRID", type: "string", child: "ASSETSPEC" },
  { name: "ASSETSPEC.ALNVALUE", type: "string", child: "ASSETSPEC" },
  { name: "ASSETSPEC.NUMVALUE", type: "number", child: "ASSETSPEC" },
  { name: "ASSETSPEC.MEASUREUNITID", type: "string", child: "ASSETSPEC" },
  { name: "ASSETSPEC.CLASSSTRUCTUREID", type: "string", child: "ASSETSPEC" },
  { name: "ASSETSPEC.ASSETSPECID", type: "integer", child: "ASSETSPEC" },
];

/** 資産（分類 ID 付き）と、分類の仕様・属性のシート */
function classifiedWorkspace(): Workspace {
  const ws = new Workspace("test");
  const assetRows: SheetRow[] = [];
  const add = (assetnum: string, cls: string, specs: Array<[string, string | null, number | null, string | null]>) => {
    const parentKey = makeParentKey([assetnum, "KITA"]);
    const base = { ASSETNUM: assetnum, SITEID: "KITA", CLASSSTRUCTUREID: cls };
    const empty = { "ASSETSPEC.ASSETATTRID": null, "ASSETSPEC.ALNVALUE": null, "ASSETSPEC.NUMVALUE": null, "ASSETSPEC.MEASUREUNITID": null, "ASSETSPEC.CLASSSTRUCTUREID": null, "ASSETSPEC.ASSETSPECID": null };
    if (specs.length === 0) assetRows.push({ rowKey: parentKey, parentKey, childName: null, values: { ...base, ...empty } });
    specs.forEach(([attr, aln, num, unit], i) => {
      const id = Number(assetnum.replace(/\D/g, "")) * 10 + i;
      assetRows.push({
        rowKey: makeChildRowKey(parentKey, "ASSETSPEC", id),
        parentKey,
        childName: "ASSETSPEC",
        values: { ...base, ...empty, "ASSETSPEC.ASSETATTRID": attr, "ASSETSPEC.ALNVALUE": aln, "ASSETSPEC.NUMVALUE": num, "ASSETSPEC.MEASUREUNITID": unit, "ASSETSPEC.CLASSSTRUCTUREID": cls, "ASSETSPEC.ASSETSPECID": id },
      });
    });
  };
  // ポンプ（PUMP）: RATED_POWER・MAKER・FLOW が分類にある。P-2 は FLOW が欠け
  add("P-1", "PUMP", [["RATED_POWER", null, 15, "KW"], ["MAKER", "荏原", null, null], ["FLOW", null, 120, "M3/H"]]);
  add("P-2", "PUMP", [["RATED_POWER", null, 22, "KW"], ["MAKER", "酉島", null, null]]);
  // 計器（INSTR）: SIGNAL・RANGE が分類にあるが、どの機器にも行が無い
  add("T-1", "INSTR", []);
  ws.createSheet(
    {
      name: "資産",
      source: { kind: "maximo", os: "MXAPIASSET", select: [], where: [] },
      columns: ASSET_COLUMNS,
      keyColumns: ["ASSETNUM", "SITEID"],
      childIdAttrs: { ASSETSPEC: "ASSETSPECID" },
    },
    assetRows,
  );

  const classRows: SheetRow[] = [];
  const cls = (id: string, attrs: Array<[string, string | null]>) => {
    const parentKey = makeParentKey([id]);
    attrs.forEach(([attr, unit], i) =>
      classRows.push({
        rowKey: makeChildRowKey(parentKey, "CLASSSPEC", `${id}-${i}`),
        parentKey,
        childName: "CLASSSPEC",
        values: { CLASSSTRUCTUREID: id, "CLASSSPEC.CLASSSPECID": `${id}-${i}`, "CLASSSPEC.ASSETATTRID": attr, "CLASSSPEC.MEASUREUNITID": unit },
      }),
    );
  };
  cls("PUMP", [["RATED_POWER", "KW"], ["MAKER", null], ["FLOW", "M3/H"]]);
  cls("INSTR", [["SIGNAL", null], ["RANGE", "KPA"]]);
  ws.createSheet(
    {
      name: "分類の仕様",
      source: { kind: "maximo", os: "MXAPICLASSSTRUCTURE", select: [], where: [] },
      columns: [
        { name: "CLASSSTRUCTUREID", type: "string" },
        { name: "CLASSSPEC.CLASSSPECID", type: "string", child: "CLASSSPEC" },
        { name: "CLASSSPEC.ASSETATTRID", type: "string", child: "CLASSSPEC" },
        { name: "CLASSSPEC.MEASUREUNITID", type: "string", child: "CLASSSPEC" },
      ],
      keyColumns: ["CLASSSTRUCTUREID"],
      childIdAttrs: { CLASSSPEC: "CLASSSPECID" },
    },
    classRows,
  );
  ws.createSheet(
    {
      name: "属性",
      source: { kind: "maximo", os: "MXAPIASSETATTRIBUTE", select: [], where: [] },
      columns: [
        { name: "ASSETATTRID", type: "string" },
        { name: "DATATYPE", type: "string" },
      ],
      keyColumns: ["ASSETATTRID"],
      childIdAttrs: {},
    },
    [
      ["SIGNAL", "ALN"],
      ["RANGE", "NUMERIC"],
      ["FLOW", "NUMERIC"],
    ].map(([a, d]) => ({ rowKey: makeParentKey([a as string]), parentKey: makeParentKey([a as string]), childName: null, values: { ASSETATTRID: a as string, DATATYPE: d as string } })),
  );
  return ws;
}

describe("分類による区別", () => {
  const ws = classifiedWorkspace();
  const sheet = ws.getSheet("資産");
  const spec = pivotSpecFor(sheet.meta, "ASSETSPEC")!;
  const value = (row: Parameters<typeof sheet.finalValue>[0], col: string) => sheet.finalValue(row, col);
  const others = [ws.getSheet("分類の仕様"), ws.getSheet("属性")];
  const defs = findClassDefs(others)!;
  const info: PivotClassInfo = { defs, classCol: parentClassColumn(sheet.meta)!, attrTypes: findAttrTypes(others) };

  it("分類の仕様のシートから分類ごとの項目と単位を読む。資産のシートは分類の仕様と取り違えない", () => {
    expect([...defs.keys()].sort()).toEqual(["INSTR", "PUMP"]);
    expect(defs.get("PUMP")?.get("RATED_POWER")).toMatchObject({ unit: "KW" });
    expect(findClassDefs([sheet])).toBeNull();
    expect(info.attrTypes.get("RANGE")).toBe("NUMERIC");
  });

  it("分類にあってどの機器にも行が無い項目も列にし、セルを 欠け・分類に無い・行あり に分ける", () => {
    const table = addClassColumns(buildPivot(sheet.viewRows("final"), spec, value), spec, info, value);
    const col = (attr: string) => table.columns.find((c) => c.attr === attr)!;
    expect(table.columns.map((c) => c.attr)).toEqual(expect.arrayContaining(["SIGNAL", "RANGE"]));
    // 型の分かる項目は型の列
    expect(col("RANGE").valueCol).toBe("ASSETSPEC.NUMVALUE");
    expect(col("SIGNAL").valueCol).toBe("ASSETSPEC.ALNVALUE");
    const [p1, p2, t1] = table.rows;
    expect(pivotCellState(p1!, col("FLOW"), info, value)).toBe("present");
    expect(pivotCellState(p2!, col("FLOW"), info, value)).toBe("missing");
    expect(pivotCellState(p2!, col("SIGNAL"), info, value)).toBe("notInClass");
    expect(pivotCellState(t1!, col("SIGNAL"), info, value)).toBe("missing");
    expect(pivotCellState(t1!, col("FLOW"), info, value)).toBe("notInClass");
    expect(pivotCellState(p2!, col("FLOW"), null, value)).toBe("unknown");
  });

  it("欠けに値を入れると、項目名・値・分類の単位・分類 ID の仕様の行を足す（差分・取り消しはそのまま）", () => {
    const w = classifiedWorkspace();
    const s = w.getSheet("資産");
    const v = (row: Parameters<typeof s.finalValue>[0], col: string) => s.finalValue(row, col);
    const table = addClassColumns(buildPivot(s.viewRows("final"), spec, v), spec, info, v);
    const flow = table.columns.find((c) => c.attr === "FLOW")!;
    const p2 = table.rows[1]!;
    const values = newSpecRow(p2, flow, spec, info, s.meta.columns, 95, v);
    expect(values).toEqual({ "ASSETSPEC.ASSETATTRID": "FLOW", "ASSETSPEC.NUMVALUE": 95, "ASSETSPEC.MEASUREUNITID": "M3/H", "ASSETSPEC.CLASSSTRUCTUREID": "PUMP" });
    // 分類に無い項目には足さない
    const signal = table.columns.find((c) => c.attr === "SIGNAL")!;
    expect(newSpecRow(p2, signal, spec, info, s.meta.columns, "4-20mA", v)).toBeNull();

    const res = w.addRows("資産", [values!], { author: "user", parentRowKey: p2.parent.rowKey, childName: "ASSETSPEC" });
    expect(res.conflicts).toEqual([]);
    expect(w.getDiff("資産").addedRows).toBe(1);
    const after = addClassColumns(buildPivot(s.viewRows("final"), spec, v), spec, info, v);
    const cell = pivotCell(after.rows[1]!, after.columns.find((c) => c.attr === "FLOW")!, spec, v);
    expect(cell.row !== null && v(cell.row, "ASSETSPEC.NUMVALUE")).toBe(95);
    expect(s.rowStatus(cell.row!)).toBe("added");
  });
});

// ---------------------------------------------------------------------------
// 分類の階層パス（横持ちの先頭の「分類」の列）と、読み込みの結果で LLM に知らせる文
// ---------------------------------------------------------------------------

describe("分類の階層パス", () => {
  /** 分類のシート（HIERARCHYPATH・DESCRIPTION・CLASSSPEC） */
  function classSheetWith(path: boolean): Workspace {
    const ws = new Workspace("test");
    const rows: SheetRow[] = [
      ["1003", "設備 \\ 回転機械 \\ ポンプ", "ポンプ"],
      ["1016", "設備 \\ 熱設備 \\ ボイラ", "ボイラ"],
    ].map(([id, p, d]) => ({
      rowKey: makeChildRowKey(makeParentKey([id as string]), "CLASSSPEC", `${id}-0`),
      parentKey: makeParentKey([id as string]),
      childName: "CLASSSPEC",
      values: { CLASSSTRUCTUREID: id as string, ...(path ? { HIERARCHYPATH: p as string } : {}), DESCRIPTION: d as string, "CLASSSPEC.CLASSSPECID": `${id}-0`, "CLASSSPEC.ASSETATTRID": "MODEL" },
    }));
    ws.createSheet(
      {
        name: "分類",
        source: { kind: "maximo", os: "MXAPICLASSSTRUCTURE", select: [], where: [] },
        columns: [
          { name: "CLASSSTRUCTUREID", type: "string" },
          ...(path ? [{ name: "HIERARCHYPATH", type: "string" as const }] : []),
          { name: "DESCRIPTION", type: "string" },
          { name: "CLASSSPEC.CLASSSPECID", type: "string", child: "CLASSSPEC" },
          { name: "CLASSSPEC.ASSETATTRID", type: "string", child: "CLASSSPEC" },
        ],
        keyColumns: ["CLASSSTRUCTUREID"],
        childIdAttrs: { CLASSSPEC: "CLASSSPECID" },
      },
      rows,
    );
    return ws;
  }

  it("分類のシートから階層パスを取り、無ければ説明、それも無ければ分類 ID を出す", () => {
    const labels = findClassLabels([classSheetWith(true).getSheet("分類")]);
    // 階層パスの終わりが説明と同じなら添えない。分類コードの階層パスには説明を添える
    expect(classLabelText("1003", labels)).toBe("設備 \\ 回転機械 \\ ポンプ");
    const coded = new Map([["1003", { path: "MECH \\ ROT \\ PUMP", description: "ポンプ" }]]);
    expect(classLabelText("1003", coded)).toBe("MECH \\ ROT \\ PUMP（ポンプ）");
    expect(classLabelText("9999", labels)).toBe("9999");
    expect(classLabelText(null, labels)).toBe("");
    const noPath = findClassLabels([classSheetWith(false).getSheet("分類")]);
    expect(classLabelText("1016", noPath)).toBe("ボイラ");
  });

  it("資産のシートの説明は分類の見出しに使わない", () => {
    const ws = classifiedWorkspace();
    expect(findClassLabels([ws.getSheet("資産")]).size).toBe(0);
  });

  it("仕様の表を読み込んだとき、分類 ID・分類のシートが足りなければ LLM に知らせる", () => {
    const ws = classifiedWorkspace();
    const assets = ws.getSheet("資産").meta;
    // 分類 ID はあるが、分類のシートに階層パスが無い
    expect(specificationNote(assets, [ws.getSheet("分類の仕様")])).toMatch(/HIERARCHYPATH/);
    // 階層パスつきの分類のシートがあれば何も言わない
    expect(specificationNote(assets, [classSheetWith(true).getSheet("分類")])).toBeNull();
    // 分類 ID を読み込んでいない
    const noClass = { ...assets, columns: assets.columns.filter((c) => c.name !== "CLASSSTRUCTUREID") };
    expect(specificationNote(noClass, [])).toMatch(/Add CLASSSTRUCTUREID/);
    // 仕様の表でなければ何も言わない
    expect(specificationNote({ columns: [{ name: "WONUM", type: "string" }], childIdAttrs: {} }, [])).toBeNull();
  });
});
