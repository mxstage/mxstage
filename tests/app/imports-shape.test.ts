// 取り込んだ表の形を整える（src/app/imports/shape.ts）: 帳票の読み取り（form）・fillDown・unpivot と、describe_import の手がかり。
// データはすべて架空。

import { describe, expect, it } from "vitest";
import type { CellValue } from "../../src/shared/model";
import { afterLabel, buildShapedSheet, formHint, mergeSummary, shapeImport, splitTokens, type ShapeOptions } from "../../src/app/imports/shape";
import { ImportError, type MergeRange, type RawTable } from "../../src/app/imports/table";
import { parseXlsx } from "../../src/app/imports/xlsx";
import { makeXlsx } from "./xlsx-fixture";

/** 行番号 → セルの配列（null は空）から表を作る */
function table(rows: Record<number, CellValue[]>, merges?: MergeRange[]): RawTable {
  const list = Object.entries(rows)
    .map(([row, cells]) => ({ row: Number(row), cells }))
    .sort((a, b) => a.row - b.row);
  return { name: "S", hidden: false, rows: list, columnCount: Math.max(...list.map((r) => r.cells.length)), truncatedRows: false, truncatedColumns: false, ...(merges ? { merges } : {}) };
}

const source = { kind: "excel" as const, importId: "i", fileName: "f.xlsx", sheetName: "S", headerRow: 1 };

function build(t: RawTable, opts: ShapeOptions, extra: { rename?: Record<string, string>; keyColumns?: string[] } = {}) {
  return buildShapedSheet(shapeImport(t, opts), { name: "x", source, ...extra });
}

/** 作業日報の帳票 1 枚（start 行から 12 行。行を足した帳票・列の位置が違う帳票も作れる） */
function report(start: number, o: { no: string; date: string; contract: string; lines: Array<[string, string, number | string]>; notes?: string; shift?: number }): Record<number, CellValue[]> {
  const s = o.shift ?? 0;
  const pad = (cells: CellValue[]) => [...Array<CellValue>(s).fill(null), ...cells];
  const rows: Record<number, CellValue[]> = {
    [start]: ["北部クリーンセンター", null, "作　業　日　報", null, null, "監督員", "担当"],
    [start + 1]: [`No. ${o.no}`],
    [start + 3]: ["委託契約工事名", null, o.contract],
    [start + 4]: ["受注者", null, "設備保守業者Ｃ", null, null, "作業日", o.date],
    [start + 5]: ["作業責任者", null, "佐藤", "作業員", "3 名", "作業時間", null],
    [start + 7]: pad(["No.", "作業区分", "作業内容", null, null, null, "時間"]),
  };
  // 番号を振っただけの空の行も入れる
  const n = Math.max(4, o.lines.length);
  for (let i = 0; i < n; i++) {
    const l = o.lines[i];
    rows[start + 8 + i] = pad(l ? [i + 1, l[0], l[1], null, null, null, l[2]] : [i + 1]);
  }
  rows[start + 8 + n + 1] = ["特記事項\n引継ぎ", null, o.notes ?? null];
  rows[start + 8 + n + 2] = ["使用材料", null, "ウエス"];
  return rows;
}

const FORM: ShapeOptions["form"] = {
  start: ["作業日報"],
  fields: { NO: "No.", CONTRACT: "委託契約工事名", WORKDATE: "作業日", LEAD: "作業責任者", CREW: "作業員", NOTES: "特記事項" },
  items: { header: "作業内容", until: ["特記事項"] },
};

describe("帳票の読み取り（form）", () => {
  const t = table({
    ...report(1, { no: "4-01", date: "令和8年4月1日（水）", contract: "令和8年度 設備保守点検業務委託", lines: [["巡視点検", "場内巡視 異常なし", 1], ["故障修理", "2号の誘引 IDF 異音 給脂", 2.5], ["〃", "同上 経過観察", "0.5h"]], notes: "特になし" }),
    // 行を足した帳票（明細が 6 行。特記事項の位置がずれる）、特記事項は空
    ...report(20, { no: "4-02", date: "R8.4.2", contract: "令和8年度 設備保守点検業務委託", lines: [["定期点検", "1号炉 押込送風機 定期点検", 1], ["修理", "汚水移送P No.2 漏れ 増締め", 0.5], ["清掃", "灰押出機まわり 清掃", 2], ["打合せ", "監督員と打合せ", 1], ["点検", "3炉 薬剤供給装置 月例点検", 1], ["巡視点検", "場内巡視", 1]] }),
    // 明細の列が 1 列右にずれた帳票（見出しの文字で合わせる）
    ...report(40, { no: "修-403-01", date: "令和8年4月3日（金）", contract: "1号炉水銀計 修繕", lines: [["準備", "準備・養生", 0.5], ["修繕", "指示不良のため部品交換", 2]], shift: 1, notes: "工事完了。" }),
  });

  it("帳票ごとに上の欄を読み、明細の 1 行を 1 行にする。番号だけの行と空の行は飛ばす", () => {
    const b = build(t, { form: FORM });
    expect(b.notes).toMatchObject({ forms: 3, missingFields: { NOTES: 1 } });
    expect(b.rows.map((r) => r.values.BLOCK)).toEqual([1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3]);
    expect(b.rows[0]!.values).toMatchObject({ SOURCE_ROW: 9, NO: "4-01", CONTRACT: "令和8年度 設備保守点検業務委託", WORKDATE: "令和8年4月1日（水）", LEAD: "佐藤", CREW: "3 名", NOTES: "特になし", 作業区分: "巡視点検", 作業内容: "場内巡視 異常なし" });
    // 2 枚目: 特記事項が空なら、ラベルの 2 行目（引継ぎ）を値にしない
    expect(b.rows[3]!.values).toMatchObject({ NO: "4-02", WORKDATE: "R8.4.2", NOTES: null });
    // 3 枚目: 列がずれていても見出しの文字で合う。「No. 修-403-01」は同じセルの続きが値
    expect(b.rows[9]!.values).toMatchObject({ NO: "修-403-01", CONTRACT: "1号炉水銀計 修繕", 作業内容: "準備・養生", 時間: "0.5" });
    // 列: SOURCE_ROW・BLOCK・上の欄・明細の列。上の欄の列の見出しの 2 段目はラベル
    expect(b.meta.columns.map((c) => c.name)).toEqual(["SOURCE_ROW", "BLOCK", "NO", "CONTRACT", "WORKDATE", "LEAD", "CREW", "NOTES", "No.", "作業区分", "作業内容", "時間"]);
    expect(b.meta.columns.find((c) => c.name === "CONTRACT")?.title).toBe("委託契約工事名");
    expect(b.meta.keyColumns).toEqual(["SOURCE_ROW"]);
  });

  it("上の欄のラベルは明細の表の外で探す（明細の見出しの「No.」と取り違えない）", () => {
    const b = build(t, { form: FORM });
    expect(new Set(b.rows.map((r) => r.values.NO))).toEqual(new Set(["4-01", "4-02", "修-403-01"]));
  });

  it("fillDown の「〃」は帳票をまたがない", () => {
    const b = build(t, { form: FORM, fillDown: { columns: ["作業区分"], mode: "blank", ditto: true } });
    expect(b.rows[2]!.values.作業区分).toBe("故障修理");
    expect(b.notes).toMatchObject({ filledDown: { 作業区分: 1 } });
  });

  it("明細を指定しなければ 1 帳票 1 行。値の右がほかのラベルなら空にする", () => {
    const one = table({
      1: ["作業日報"],
      2: ["受注者", null, "作業日", "R8.4.1"],
      5: ["作業日報"],
      6: ["受注者", "設備保守業者Ｃ", "作業日", "R8.4.2"],
    });
    const b = build(one, { form: { start: ["作業日報"], fields: { VENDOR: "受注者", WORKDATE: "作業日" } } });
    expect(b.rows.map((r) => [r.values.SOURCE_ROW, r.values.VENDOR, r.values.WORKDATE])).toEqual([
      [1, null, "R8.4.1"],
      [5, "設備保守業者Ｃ", "R8.4.2"],
    ]);
  });

  it("値がラベルの下にある帳票（below）", () => {
    const v = table({ 1: ["点検報告書"], 2: ["点検日", "設備"], 3: ["2026-05-01", "押込送風機"], 6: ["点検報告書"], 7: ["点検日", "設備"], 8: ["2026-06-01", "誘引送風機"] });
    const b = build(v, { form: { start: ["点検報告書"], fields: { DATE: { label: "点検日", below: true }, EQUIP: { label: "設備", below: true } } } });
    expect(b.rows.map((r) => [r.values.DATE, r.values.EQUIP])).toEqual([
      ["2026-05-01", "押込送風機"],
      ["2026-06-01", "誘引送風機"],
    ]);
  });

  it("始まりの文字が無い・指定が足りないときは理由を添えて断る", () => {
    expect(() => shapeImport(t, { form: { ...FORM, start: ["点検報告書"] } })).toThrow(ImportError);
    expect(() => shapeImport(t, { form: { start: ["作業日報"], fields: {} } })).toThrow(/fields or items/);
    expect(() => shapeImport(t, { form: FORM, unpivot: { columns: ["A"], labelColumn: "P", valueColumn: "V", keepEmpty: false } })).toThrow(/together/);
  });
});

describe("fillDown", () => {
  const t = table(
    {
      1: ["日付", "機器", "内容"],
      2: ["2026-04-01", "IDF", "異音"],
      3: [null, "〃", "給脂"],
      4: [null, "BFP", "漏れ"],
      5: ["2026-04-02", null, "清掃"],
    },
    [{ r1: 2, c1: 0, r2: 4, c2: 0 }],
  );

  it("blank は空のセルを、ditto は「〃」を上の値で埋める", () => {
    const b = build(t, { headerRow: 1, fillDown: { columns: ["日付", "B"], mode: "blank", ditto: true } });
    expect(b.rows.map((r) => [r.values.日付, r.values.機器])).toEqual([
      ["2026-04-01", "IDF"],
      ["2026-04-01", "IDF"],
      ["2026-04-01", "BFP"],
      ["2026-04-02", "BFP"],
    ]);
  });

  it("merged は結合の 2 行目以降だけを埋める（結合していない空のセルはそのまま）", () => {
    const b = build(t, { headerRow: 1, fillDown: { columns: ["日付", "機器"], mode: "merged", ditto: false } });
    expect(b.rows.map((r) => [r.values.日付, r.values.機器])).toEqual([
      ["2026-04-01", "IDF"],
      ["2026-04-01", "〃"],
      ["2026-04-01", "BFP"],
      ["2026-04-02", null],
    ]);
  });

  it("無い列は列の一覧を添えて断る", () => {
    expect(() => shapeImport(t, { headerRow: 1, fillDown: { columns: ["担当"], mode: "blank", ditto: true } })).toThrow(/担当 is not a column/);
  });
});

describe("unpivot", () => {
  // 星取表: 見出しの行（4）・和暦（5）・西暦（6）、予定と実績の 2 行
  const t = table({
    4: ["No.", "機器名称", "数量", "区分", "年度", null, null, "備考"],
    5: [null, null, null, null, "H18", "H19", "H20"],
    6: [null, null, null, null, 2006, 2007, 2008],
    7: [1, "ごみクレーン", 2, "予定", "★", "★", "★"],
    8: [null, null, null, "実績", "★△", null, "★◎(5月)"],
    9: [2, "押込送風機", 1, "予定", "○", "○", "○"],
    10: [null, null, null, "実績", "○", "?", null, "A号機のみ"],
  });
  const opts: ShapeOptions = {
    headerRow: 4,
    fillDown: { columns: ["No.", "機器名称", "数量"], mode: "blank", ditto: false },
    unpivot: { columns: ["E:G"], labelRow: 6, labelColumn: "FY", valueColumn: "MARK", keepEmpty: false, tokens: ["○", "◎", "●", "△", "★"], repeat: { countColumn: "数量", labels: ["A", "B"], column: "UNIT" } },
  };

  it("年度の列を行にする。年度の段は行にせず、列の名前は西暦の行から取る", () => {
    const b = build(t, opts);
    const actual = b.rows.filter((r) => r.values.区分 === "実績");
    expect(actual.map((r) => [r.values.機器名称, r.values.FY, r.values.MARK, r.values.MARK_NOTE, r.values.UNIT, r.values.SOURCE_CELL])).toEqual([
      ["ごみクレーン", 2006, "★", null, "A", "E8"],
      ["ごみクレーン", 2006, "★", null, "B", "E8"],
      ["ごみクレーン", 2006, "△", null, "A", "E8"],
      ["ごみクレーン", 2006, "△", null, "B", "E8"],
      ["ごみクレーン", 2008, "★", null, "A", "G8"],
      ["ごみクレーン", 2008, "★", null, "B", "G8"],
      ["ごみクレーン", 2008, "◎", "(5月)", "A", "G8"],
      ["ごみクレーン", 2008, "◎", "(5月)", "B", "G8"],
      ["押込送風機", 2006, "○", null, null, "E10"],
      // 凡例に無い印はそのまま残す（利用者に見せる）
      ["押込送風機", 2007, "?", null, null, "F10"],
    ]);
    expect(new Set(b.rows.map((r) => r.rowKey)).size).toBe(b.rows.length);
    expect(b.meta.keyColumns).toEqual(["SOURCE_CELL", "MARK", "UNIT"]);
    expect(b.meta.columns.find((c) => c.name === "FY")?.type).toBe("integer");
    expect(b.notes).toMatchObject({ unpivot: { columns: ["E", "F", "G"], skippedEmptyCells: 2 } });
  });

  it("keepEmpty は空のセルも行にする。列名が重なれば断る", () => {
    const b = build(t, { headerRow: 4, unpivot: { columns: ["E", "F", "G"], labelRow: 6, labelColumn: "FY", valueColumn: "MARK", keepEmpty: true } });
    expect(b.rows.length).toBe(4 * 3);
    expect(() => shapeImport(t, { headerRow: 4, unpivot: { columns: ["E:G"], labelColumn: "区分", valueColumn: "MARK", keepEmpty: false } })).toThrow(/already used/);
  });

  it("数量が号機の名前より多ければ、名前の数まで分けて結果で知らせる", () => {
    const b = build(t, { ...opts, unpivot: { ...opts.unpivot!, repeat: { countColumn: "数量", labels: ["A"], column: "UNIT" } } });
    expect(b.notes).toMatchObject({ unpivot: { repeatNote: expect.stringContaining("Give more labels") } });
  });

  it("印の分け方: 印の後ろの文字はその印の注記、印が無ければそのまま", () => {
    expect(splitTokens("○◎(5月)", ["○", "◎"])).toEqual([
      { value: "○", note: null },
      { value: "◎", note: "(5月)" },
    ]);
    expect(splitTokens("済", ["○"])).toEqual([{ value: "済", note: null }]);
  });
});

describe("describe_import の手がかり", () => {
  it("同じラベルが同じ回数ずつ出てくれば帳票が並んでいると見る。普通の表では出さない", () => {
    const forms = table({ ...report(1, { no: "1", date: "R8.4.1", contract: "委託", lines: [["巡視点検", "巡視", 1]] }), ...report(20, { no: "2", date: "R8.4.2", contract: "委託", lines: [["清掃", "清掃", 1]] }), ...report(40, { no: "3", date: "R8.4.3", contract: "委託", lines: [["点検", "点検", 1]] }) });
    expect(formHint(forms)).toMatchObject({ forms: 3, firstRows: [1, 20, 40] });
    expect(formHint(forms)?.labels).toEqual(expect.arrayContaining(["委託契約工事名", "作業日", "作業内容"]));
    const plain = table({ 1: ["機器番号", "状態"], 2: ["P-1", "稼働"], 3: ["P-2", "稼働"], 4: ["P-3", "停止"], 5: ["P-4", "稼働"] });
    expect(formHint(plain)).toBeNull();
  });

  it("ラベルの続きの読み方", () => {
    expect(afterLabel("No. 4-04", "No.")).toBe("4-04");
    expect(afterLabel("作業日：R8.4.1", "作業日")).toBe("R8.4.1");
    expect(afterLabel("特記事項\n引継ぎ", "特記事項")).toBe("");
  });

  it("xlsx の結合したセルを読む", async () => {
    const bytes = await makeXlsx({
      shared: ["<t>日付</t>", "<t>内容</t>", "<t>異音</t>", "<t>給脂</t>"],
      sheets: [{ name: "4月", rows: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>46113</v></c><c r="B2" t="s"><v>2</v></c></row><row r="3"><c r="B3" t="s"><v>3</v></c></row>', merges: ["A2:A3"] }],
    });
    const wb = await parseXlsx(bytes);
    const t = wb.tables[0]!;
    expect(t.merges).toEqual([{ r1: 2, c1: 0, r2: 3, c2: 0 }]);
    expect(mergeSummary(t)).toEqual({ count: 1, first: ["A2:A3"] });
    const b = build(t, { headerRow: 1, fillDown: { columns: ["日付"], mode: "merged", ditto: false } });
    expect(b.rows.map((r) => r.values.日付)).toEqual([46113, 46113]);
  });
});
