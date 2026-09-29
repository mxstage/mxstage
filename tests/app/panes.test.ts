// 関連する表を同時に出すためのペインの決め方（純ロジック）。
// 1 回の作業で見る表（工事管理・複数機器・機器台帳・ロケーション）が同時に出ることを確かめる。

import { describe, expect, it } from "vitest";
import { paneLink } from "../../src/app/pages/AppPage";
import { addPane, arrangePanes, clampSplit, EMPTY_LAYOUT, EVEN_SPLIT, MIN_PANE_PX, ownPanes, paneGridTemplate, panesFor, scopeColumns, scopeRows, splitAxes, swapPanes, togglePane, type PaneLayout } from "../../src/app/pages/panes";
import type { ColumnSchema } from "../../src/shared/model";
import type { SheetLink, SheetMeta } from "../../src/shared/sheet";

function maximoSheet(name: string, os: string, columns: ColumnSchema[], childIdAttrs: Record<string, string | null> = {}, link?: SheetLink): SheetMeta {
  const meta: SheetMeta = {
    name,
    source: { kind: "maximo", os, select: columns.map((c) => c.name), where: [] },
    columns,
    keyColumns: ["SITEID", "WONUM"],
    childIdAttrs,
  };
  if (link !== undefined) meta.link = link;
  return meta;
}

/** 工事管理（親＋子 複数機器）・機器台帳・ロケーション */
function workspaceSheets(): SheetMeta[] {
  const wo = maximoSheet(
    "工事管理",
    "MXAPIWODETAIL",
    [
      { name: "SITEID", type: "string" },
      { name: "WONUM", type: "string" },
      { name: "DESCRIPTION", type: "string" },
      { name: "MULTIASSETLOCCI.MULTIID", type: "integer", child: "MULTIASSETLOCCI" },
      { name: "MULTIASSETLOCCI.ASSETNUM", type: "string", child: "MULTIASSETLOCCI" },
    ],
    { MULTIASSETLOCCI: "MULTIID" },
  );
  const asset = maximoSheet("機器台帳", "MXAPIASSET", [{ name: "ASSETNUM", type: "string" }], {}, {
    sheet: "工事管理",
    from: "MULTIASSETLOCCI.ASSETNUM",
    to: "ASSETNUM",
  });
  const loc = maximoSheet("ロケーション", "MXAPILOCATION", [{ name: "LOCATION", type: "string" }], {}, { sheet: "工事管理", from: "LOCATION", to: "LOCATION" });
  return [wo, asset, loc];
}

describe("ペインの決め方（panesFor）", () => {
  it("親・子・参照先のマスタを 1 画面に並べる", () => {
    const panes = panesFor(workspaceSheets(), "工事管理");
    expect(panes.map((p) => [p.title, p.sheet, p.scope])).toEqual([
      ["工事管理", "工事管理", { kind: "parent" }],
      ["MULTIASSETLOCCI", "工事管理", { kind: "child", name: "MULTIASSETLOCCI" }],
      ["機器台帳", "機器台帳", { kind: "all" }],
      ["ロケーション", "ロケーション", { kind: "all" }],
    ]);
    expect(panes[1]!.subtitle).toBe("工事管理 の子");
    expect(panes[2]!.subtitle).toBe("MULTIASSETLOCCI.ASSETNUM → ASSETNUM");
  });

  it("マスタのシートを見ているときも、同じ組（参照元と子）を出す", () => {
    const panes = panesFor(workspaceSheets(), "機器台帳");
    expect(panes.map((p) => p.sheet)).toEqual(["工事管理", "工事管理", "機器台帳", "ロケーション"]);
  });

  it("子が無いシートは 1 枚。上限を超えるときも、見ているシートのペインは残す", () => {
    const plain = maximoSheet("許可申請", "EXT_WOPERMIT", [{ name: "WONUM", type: "string" }]);
    expect(panesFor([plain], "許可申請").map((p) => [p.title, p.scope.kind])).toEqual([["許可申請", "all"]]);
    const few = panesFor(workspaceSheets(), "ロケーション", 3);
    expect(few).toHaveLength(3);
    expect(few.map((p) => p.sheet)).toContain("ロケーション");
  });

  it("知らないシート名では何も出さない", () => {
    expect(panesFor(workspaceSheets(), "無い")).toEqual([]);
  });
});

describe("ペインに出す行と列（scopeRows・scopeColumns）", () => {
  const columns = workspaceSheets()[0]!.columns;
  const rows = [
    { parentKey: "BEDFORD|WO1", childName: null },
    { parentKey: "BEDFORD|WO2", childName: "MULTIASSETLOCCI" },
    { parentKey: "BEDFORD|WO2", childName: "MULTIASSETLOCCI" },
  ];

  it("親のペインは親ごとに 1 行・親の列だけ", () => {
    expect(scopeRows(rows, { kind: "parent" })).toEqual([rows[0], rows[1]]);
    expect(scopeColumns(columns, ["SITEID", "WONUM"], { kind: "parent" }).map((c) => c.name)).toEqual(["SITEID", "WONUM", "DESCRIPTION"]);
  });

  it("子のペインはその子の行だけ・キー列とその子の列", () => {
    expect(scopeRows(rows, { kind: "child", name: "MULTIASSETLOCCI" })).toHaveLength(2);
    expect(scopeColumns(columns, ["SITEID", "WONUM"], { kind: "child", name: "MULTIASSETLOCCI" }).map((c) => c.name)).toEqual([
      "SITEID",
      "WONUM",
      "MULTIASSETLOCCI.MULTIID",
      "MULTIASSETLOCCI.ASSETNUM",
    ]);
  });

  it("範囲を分けないペインはそのまま", () => {
    expect(scopeRows(rows, { kind: "all" })).toHaveLength(3);
    expect(scopeColumns(columns, ["SITEID", "WONUM"], { kind: "all" })).toHaveLength(5);
  });
});

describe("行を選んだときの連動（paneLink）", () => {
  const panes = panesFor(workspaceSheets(), "工事管理");
  const [parentPane, childPane, assetPane, locationPane] = panes as [(typeof panes)[number], (typeof panes)[number], (typeof panes)[number], (typeof panes)[number]];
  const linked = {
    paneKey: parentPane.key,
    sheet: "工事管理",
    parentKey: "BEDFORD|WO1",
    values: { "MULTIASSETLOCCI.ASSETNUM": "A10001", LOCATION: "" },
  };

  it("選んだペインは絞らない。同じシートの他のペインは同じ親の行だけにする", () => {
    expect(paneLink(parentPane, linked)).toBeNull();
    expect(paneLink(childPane, linked)).toEqual({ kind: "parent", parentKey: "BEDFORD|WO1" });
  });

  it("参照先のマスタは、選んだ行が指している値だけにする", () => {
    expect(paneLink(assetPane, linked)).toEqual({ kind: "value", col: "ASSETNUM", value: "A10001" });
    // 値が空なら絞らない（全部隠さない）
    expect(paneLink(locationPane, linked)).toBeNull();
  });
});

describe("並べ方（隠す・戻す・入れ替える・組に無い表を足す）", () => {
  /** 工事管理の組（4 枚）と、組に無い取り込みのシート */
  function setup() {
    const imported: SheetMeta = {
      name: "点検結果",
      source: { kind: "excel", importId: "i1", fileName: "点検.xlsx", sheetName: "点検結果", headerRow: 1 },
      columns: [{ name: "SOURCE_ROW", type: "integer" }],
      keyColumns: ["SOURCE_ROW"],
      childIdAttrs: {},
    };
    const metas = [...workspaceSheets(), imported];
    const group = panesFor(metas, "工事管理", Number.POSITIVE_INFINITY);
    const candidates = new Map(metas.flatMap(ownPanes).map((p) => [p.key, p] as const));
    return { group, candidates };
  }
  const keysOf = (panes: Array<{ key: string }>) => panes.map((p) => p.key);

  it("並べ方が無ければ組の順に 4 枚まで出す", () => {
    const { group, candidates } = setup();
    const a = arrangePanes(group, candidates, EMPTY_LAYOUT);
    expect(keysOf(a.shown)).toEqual(["工事管理::parent", "工事管理::child:MULTIASSETLOCCI", "機器台帳::all", "ロケーション::all"]);
    expect(a.all.every((p) => p.shown && !p.extra)).toBe(true);
  });

  it("隠すと窓から外れて帯に残り、押すと戻る", () => {
    const { group, candidates } = setup();
    const a = arrangePanes(group, candidates, EMPTY_LAYOUT);
    const hid = togglePane(EMPTY_LAYOUT, a, "ロケーション::all");
    if (!("layout" in hid)) throw new Error(hid.error);
    const b = arrangePanes(group, candidates, hid.layout);
    expect(keysOf(b.shown)).not.toContain("ロケーション::all");
    expect(b.all.find((p) => p.key === "ロケーション::all")?.shown).toBe(false);
    const back = togglePane(hid.layout, b, "ロケーション::all");
    if (!("layout" in back)) throw new Error(back.error);
    expect(keysOf(arrangePanes(group, candidates, back.layout).shown)).toContain("ロケーション::all");
  });

  it("組に無い表を足せる。窓が 4 枚埋まっていれば断り、空いていれば後ろに出す", () => {
    const { group, candidates } = setup();
    const a = arrangePanes(group, candidates, EMPTY_LAYOUT);
    expect(addPane(EMPTY_LAYOUT, a, "点検結果::all")).toEqual({ error: expect.stringContaining("4 枚まで") });
    const hid = togglePane(EMPTY_LAYOUT, a, "ロケーション::all") as { layout: PaneLayout };
    const b = arrangePanes(group, candidates, hid.layout);
    const added = addPane(hid.layout, b, "点検結果::all") as { layout: PaneLayout };
    const c = arrangePanes(group, candidates, added.layout);
    expect(keysOf(c.shown)).toEqual(["工事管理::parent", "工事管理::child:MULTIASSETLOCCI", "機器台帳::all", "点検結果::all"]);
    expect(c.all.find((p) => p.key === "点検結果::all")?.extra).toBe(true);
    // 足した表を隠すと、帯からも外れる（「表を足す」で戻せる）
    const removed = togglePane(added.layout, c, "点検結果::all") as { layout: PaneLayout };
    expect(arrangePanes(group, candidates, removed.layout).all.some((p) => p.key === "点検結果::all")).toBe(false);
  });

  it("2 つのペインを入れ替える。閉じたシートの足した表は消える", () => {
    const { group, candidates } = setup();
    const a = arrangePanes(group, candidates, EMPTY_LAYOUT);
    const swapped = swapPanes(EMPTY_LAYOUT, a, "工事管理::parent", "機器台帳::all");
    expect(keysOf(arrangePanes(group, candidates, swapped).shown)).toEqual(["機器台帳::all", "工事管理::child:MULTIASSETLOCCI", "工事管理::parent", "ロケーション::all"]);
    const layout: PaneLayout = { order: [], hidden: ["ロケーション::all"], extras: ["点検結果::all"] };
    const without = new Map(Array.from(candidates).filter(([k]) => k !== "点検結果::all"));
    expect(arrangePanes(group, without, layout).all.some((p) => p.key === "点検結果::all")).toBe(false);
  });
});

describe("窓の大きさ（境目をつかんで動かす）", () => {
  it("2 枚は列の境目だけ、3・4 枚は列と段の境目。1 枚なら境目は無い", () => {
    expect(splitAxes(1)).toEqual({ col: false, row: false });
    expect(splitAxes(2)).toEqual({ col: true, row: false });
    expect(splitAxes(3)).toEqual({ col: true, row: true });
    expect(splitAxes(4)).toEqual({ col: true, row: true });
  });

  it("割合を grid の fr の比にする（合計 100 で、余白を残さない）", () => {
    expect(paneGridTemplate(1, EVEN_SPLIT)).toEqual({});
    expect(paneGridTemplate(2, { col: 0.3, row: 0.5 })).toEqual({ columns: "minmax(0, 30.00fr) minmax(0, 70.00fr)" });
    expect(paneGridTemplate(4, { col: 0.5, row: 0.25 })).toEqual({ columns: "minmax(0, 50.00fr) minmax(0, 50.00fr)", rows: "minmax(0, 25.00fr) minmax(0, 75.00fr)" });
  });

  it("両側が MIN_PANE_PX 以上残るように収める", () => {
    expect(clampSplit(0.02, 1000)).toBeCloseTo(MIN_PANE_PX / 1000);
    expect(clampSplit(0.99, 1000)).toBeCloseTo(1 - MIN_PANE_PX / 1000);
    expect(clampSplit(0.4, 1000)).toBe(0.4);
    // 枠が狭くても半分より先へは寄せない。大きさが分からなければ 1 割〜9 割
    expect(clampSplit(0.1, 200)).toBe(0.5);
    expect(clampSplit(0.01, 0)).toBe(0.1);
    expect(clampSplit(Number.NaN, 1000)).toBe(0.5);
  });
});
