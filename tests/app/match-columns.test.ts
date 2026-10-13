// 表示だけの列の中身（src/app/match/columns.ts）: 突き合わせ先と、辞書の効いた行。
import { describe, expect, it } from "vitest";
import { hitsColumn, matchColumn, targetText } from "../../src/app/match/columns";
import { MatchViewStore } from "../../src/app/match/views";
import { Workspace } from "../../src/app/store";
import { DICT_FIND, DICT_MODE, DICT_TO } from "../../src/shared/dictionarySheet";
import type { CellValue } from "../../src/shared/model";

function sheet(ws: Workspace, name: string, kind: "excel" | "maximo", cols: string[], rows: Array<Record<string, CellValue>>, key: string) {
  ws.createSheet(
    {
      name,
      source: kind === "excel" ? { kind, importId: "i", fileName: "f.xlsx", sheetName: "5月", headerRow: 1 } : { kind, os: "MXAPIWODETAIL", select: ["*"], where: [] },
      columns: cols.map((c) => ({ name: c, type: "string" as const })),
      keyColumns: [key],
      childIdAttrs: {},
    },
    rows.map((v) => ({ rowKey: String(v[key]), parentKey: String(v[key]), childName: null, values: v })),
  );
}

function setup() {
  const ws = new Workspace("作業");
  sheet(ws, "日報", "excel", ["ID", "DAY", "TEXT"], [
    { ID: "1", DAY: "2026-05-11", TEXT: "#3 スートブロワ 異音" },
    { ID: "2", DAY: "2026-05-11", TEXT: "ポンプ 点検" },
    { ID: "3", DAY: "2026-05-11", TEXT: "巡視" },
  ], "ID");
  sheet(ws, "WO", "maximo", ["WONUM", "DESCRIPTION", "NAME", "START"], [
    { WONUM: "W1", DESCRIPTION: "3号炉 スートブロワ 異音", NAME: "3号炉 スートブロワ", START: "2026-05-11" },
    { WONUM: "W2", DESCRIPTION: "A ポンプ", NAME: "ポンプ", START: "2026-05-11" },
    { WONUM: "W3", DESCRIPTION: "B ポンプ", NAME: "ポンプ", START: "2026-05-11" },
  ], "WONUM");
  ws.createSheet(
    { name: "呼び名", source: { kind: "dictionary", dictionaryId: "d_1", dictionaryName: "呼び名", dictKind: "alias", scope: "c_0123456789abcdef" }, columns: [DICT_FIND, DICT_TO, DICT_MODE].map((n) => ({ name: n, type: "string" as const })), keyColumns: [], childIdAttrs: {} },
    [
      { rowKey: "e_1", parentKey: "e_1", childName: null, values: { [DICT_FIND]: "#(\\d)", [DICT_TO]: "$1号炉", [DICT_MODE]: "regex" } },
      { rowKey: "e_2", parentKey: "e_2", childName: null, values: { [DICT_FIND]: "(ポンプ", [DICT_TO]: "x", [DICT_MODE]: "regex" } },
      { rowKey: "e_3", parentKey: "e_3", childName: null, values: { [DICT_FIND]: "使わない", [DICT_TO]: "x", [DICT_MODE]: "text" } },
    ],
  );
  const matches = new MatchViewStore(ws);
  matches.record({ left: "日報", right: "WO", normalize: ["nfkc", "upper", "removeSpaces"], extra: { contains: { col: "TEXT", targetCol: "NAME" }, dateWithin: { col: "DAY", targetStart: "START" }, dictionaries: ["呼び名"] } });
  return { ws, matches };
}

describe("突き合わせ先の列", () => {
  it("一致は相手のキーと説明、候補が複数は件数と候補、見つからないは読み替えを足す", () => {
    const { ws, matches } = setup();
    const added: string[] = [];
    const col = matchColumn(ws, matches.get("日報")!, { onAddAlias: (row) => added.push(row.rowKey) });
    const row = (k: string) => ws.getSheet("日報").row(k)!;
    expect(col.cell(row("1"))).toMatchObject({ text: "W1 3号炉 スートブロワ 異音", tone: "ok" });
    expect(col.cell(row("1"))!.hover).toEqual(expect.arrayContaining(["読み替え「#(\\d) → $1号炉」（呼び名）"]));
    expect(col.cell(row("2"))).toMatchObject({ text: "▲ 候補 2", tone: "warn" });
    expect(col.cell(row("2"))!.hover).toEqual(expect.arrayContaining(["・W2 A ポンプ", "・W3 B ポンプ"]));
    expect(col.cell(row("3"))).toMatchObject({ text: "見つからない", tone: "none", action: "読み替えを足す ›" });
    col.onClick!(row("1"), { x: 0, y: 0, width: 0, height: 0 });
    col.onClick!(row("3"), { x: 0, y: 0, width: 0, height: 0 });
    expect(added).toEqual(["3"]);
    expect(targetText(ws, "WO", "W2")).toBe("W2 A ポンプ");
    matches.dispose();
  });

  it("辞書の効いた行: 数・使えない項目・効いていない項目", () => {
    const { ws, matches } = setup();
    const col = hitsColumn(ws, "呼び名", matches);
    const d = ws.getSheet("呼び名");
    expect(col.cell(d.row("e_1")!)).toMatchObject({ text: "1" });
    expect(col.cell(d.row("e_2")!)).toMatchObject({ tone: "error" });
    expect(col.cell(d.row("e_2")!)!.text).toMatch(/^使えません: 正規表現に誤りがあります/);
    expect(col.cell(d.row("e_3")!)).toMatchObject({ text: "0", tone: "muted" });
    // この辞書で突き合わせていなければ「—」
    expect(hitsColumn(ws, "呼び名", new MatchViewStore(ws)).cell(d.row("e_1")!)).toMatchObject({ text: "—", tone: "muted" });
    matches.dispose();
  });
});
