// Excel・CSV の取り込み: ZIP の展開、xlsx・CSV の読み取り、見出しの見当、シートへの変換、
// ツール（describe_import / apply_mapping）、作業画面へのドロップ。データはすべて架空。

import { describe, expect, it, vi } from "vitest";
import { ObjectStructureCatalog } from "../../src/app/catalog/catalog";
import { createCommitController } from "../../src/app/commit/controller";
import { parseCsv, parseDelimited } from "../../src/app/imports/csv";
import { installImportDrop } from "../../src/app/imports/drop";
import { ImportStore, parseImportFile } from "../../src/app/imports/store";
import {
  buildImportSheet,
  columnIndex,
  columnLetter,
  detectMxLoader,
  headerCandidates,
  importColumns,
  ImportError,
  SOURCE_ROW_COLUMN,
  type RawTable,
} from "../../src/app/imports/table";
import { formatDateKind, parseXlsx, serialToText } from "../../src/app/imports/xlsx";
import { readZipDirectory, readZipEntry, ZipError } from "../../src/app/imports/zip";
import { RelayToolError } from "../../src/app/relay";
import { JobRegistry, Workspace } from "../../src/app/store";
import { createToolRegistry } from "../../src/app/tools/registry";
import { DATA_NOTICE } from "../../src/app/tools/results";
import { RelayErrorCode, type InvokeMsg } from "../../src/shared/protocol";
import { makeParentKey, type SheetMeta, type SheetRow } from "../../src/shared/sheet";
import type { ToolName } from "../../src/shared/toolDefs";
import { makeXlsx, makeZip } from "./xlsx-fixture";

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// 架空の Excel（機器一覧・MXLoader 形式・非表示のシート）
// ---------------------------------------------------------------------------

const SHARED = [
  "<t>機器一覧（2024年度）</t>", // 0
  "<t>サイト</t>", // 1
  '<t xml:space="preserve">機器\n番号</t>', // 2
  '<r><rPr><b/></rPr><t>タ</t></r><r><t>グ</t></r><rPh sb="0" eb="2"><t>たぐ</t></rPh><phoneticPr fontId="1"/>', // 3
  "<t>設置日</t>", // 4
  "<t>定格</t>", // 5
  "<t>備考</t>", // 6
  "<t>BEDFORD</t>", // 7
  "<t>A5001</t>", // 8
  "<t>P-101</t>", // 9
  "<t>P-102</t>", // 10
  "<t>A5003</t>", // 11
  "<t>点検済</t>", // 12
  "<t>X</t>", // 13
];

const s = (ref: string, i: number) => `<c r="${ref}" t="s"><v>${i}</v></c>`;

const LIST_ROWS = [
  `<row r="1">${s("A1", 0)}</row>`,
  `<row r="3" spans="1:9">${s("A3", 1)}${s("B3", 2)}${s("C3", 3)}${s("D3", 4)}${s("E3", 5)}${s("F3", 6)}${s("G3", 6)}${s("I3", 12)}</row>`,
  `<row r="4">${s("A4", 7)}${s("B4", 8)}${s("C4", 9)}<c r="D4" s="1"><v>45292</v></c><c r="E4"><v>0.30000000000000004</v></c>` +
    `<c r="F4" t="inlineStr"><is><t>吸込側 &amp; 吐出側</t></is></c><c r="G4" t="inlineStr"><is><t>行1_x000D_\n行2</t></is></c>${s("H4", 13)}<c r="I4" t="b"><v>1</v></c></row>`,
  `<row r="5">${s("A5", 7)}<c r="B5"><v>5002</v></c>${s("C5", 10)}<c r="D5" s="2"><v>45292.5</v></c><c r="E5"><v>15</v></c>` +
    `<c r="F5" t="str"><f>CONCAT("計算","値")</f><v>計算値</v></c><c r="G5" s="1"/><c r="I5" t="b"><v>0</v></c></row>`,
  '<row r="6"><c r="A6" s="1"/></row>',
  `<row r="7"><c t="s"><v>7</v></c><c t="s"><v>11</v></c></row>`,
  '<row r="8"><c r="E8" t="e"><v>#N/A</v></c></row>',
].join("");

const MX_ROWS = [
  '<row r="1"><c r="A1" t="inlineStr"><is><t>MXASSET</t></is></c><c r="B1" t="inlineStr"><is><t>AddChange</t></is></c><c r="C1" t="inlineStr"><is><t>EN</t></is></c></row>',
  '<row r="2"><c r="A2" t="inlineStr"><is><t>SITEID</t></is></c><c r="B2" t="inlineStr"><is><t>ASSETNUM</t></is></c><c r="C2" t="inlineStr"><is><t>ASSETSPEC.ALNVALUE</t></is></c></row>',
  `<row r="3">${s("A3", 7)}${s("B3", 8)}<c r="C3" t="inlineStr"><is><t>100V</t></is></c></row>`,
].join("");

function workbookBytes(opts: { deflate?: boolean } = {}): Promise<Uint8Array> {
  return makeXlsx({
    sheets: [
      { name: "機器一覧", rows: LIST_ROWS },
      { name: "MX", rows: MX_ROWS },
      { name: "設定", rows: `<row r="1">${s("A1", 13)}</row>`, state: "hidden" },
    ],
    shared: SHARED,
    numFmts: [[176, "yyyy/m/d h:mm"]],
    cellXfs: [0, 14, 176],
    ...opts,
  });
}

// ---------------------------------------------------------------------------

describe("ZIP の展開", () => {
  it("無圧縮と deflate のどちらも同じ中身を返す", async () => {
    for (const deflate of [false, true]) {
      const zip = await makeZip({ "a.txt": "こんにちは", "dir/b.xml": "<x/>".repeat(1000) }, { deflate });
      const dir = readZipDirectory(zip);
      expect([...dir.keys()]).toEqual(["a.txt", "dir/b.xml"]);
      expect(new TextDecoder().decode(await readZipEntry(zip, dir.get("a.txt")!, 1_000_000))).toBe("こんにちは");
      expect((await readZipEntry(zip, dir.get("dir/b.xml")!, 1_000_000)).length).toBe(4000);
    }
  });

  it("展開後の上限を超えるものは読まない（zip bomb で画面を固めない）", async () => {
    const zip = await makeZip({ "big.xml": "a".repeat(100_000) });
    const e = readZipDirectory(zip).get("big.xml")!;
    await expect(readZipEntry(zip, e, 1_000)).rejects.toThrow(ZipError);
    // 目次の大きさを偽っていても、展開しながら数えて止める
    await expect(readZipEntry(zip, { ...e, size: 10 }, 1_000)).rejects.toThrow(ZipError);
  });

  it("ZIP でなければ理由を添えてエラー", () => {
    expect(() => readZipDirectory(enc.encode("not a zip file at all, just some text"))).toThrow(ZipError);
  });
});

describe("xlsx の読み取り", () => {
  it("シート名・非表示・値のある行だけを、行番号付きで返す", async () => {
    const wb = await parseXlsx(await workbookBytes());
    expect(wb.format).toBe("xlsx");
    expect(wb.tables.map((t) => [t.name, t.hidden])).toEqual([
      ["機器一覧", false],
      ["MX", false],
      ["設定", true],
    ]);
    const list = wb.tables[0]!;
    expect(list.rows.map((r) => r.row)).toEqual([1, 3, 4, 5, 7, 8]);
    expect(list.columnCount).toBe(9);
  });

  it("共有文字列（書式付き・ふりがな除き）・インライン文字列・数値・日付・真偽値・数式の結果・エラー値", async () => {
    const list = (await parseXlsx(await workbookBytes())).tables[0]!;
    const row = (n: number) => list.rows.find((r) => r.row === n)!.cells;
    expect(row(3)).toEqual(["サイト", "機器\n番号", "タグ", "設置日", "定格", "備考", "備考", null, "点検済"]);
    expect(row(4)).toEqual(["BEDFORD", "A5001", "P-101", "2024-01-01", 0.3, "吸込側 & 吐出側", "行1\r\n行2", "X", true]);
    expect(row(5)).toEqual(["BEDFORD", 5002, "P-102", "2024-01-01T12:00:00", 15, "計算値", null, null, false]);
    // r の無いセルは左から順に並べる
    expect(row(7)).toEqual(["BEDFORD", "A5003"]);
    expect(row(8)).toEqual([null, null, null, null, "#N/A"]);
  });

  it("日付の書式と通し番号（1900 年方式・1904 年方式・時刻だけ）", () => {
    expect(formatDateKind("yyyy/m/d")).toBe("date");
    expect(formatDateKind('[$-411]ggge"年"m"月"d"日"')).toBe("date");
    expect(formatDateKind("yyyy/m/d h:mm")).toBe("datetime");
    expect(formatDateKind("h:mm:ss")).toBe("time");
    expect(formatDateKind("[h]:mm")).toBe("time");
    expect(formatDateKind("mm:ss")).toBe("time");
    expect(formatDateKind("m/d")).toBe("date");
    for (const code of ["General", "0.00", "#,##0;[Red]-#,##0", "0.00E+00", '#,##0"個"', "@", '[$¥-411]#,##0']) expect(formatDateKind(code)).toBeNull();
    expect(serialToText(45292, "date", false)).toBe("2024-01-01");
    expect(serialToText(1, "date", false)).toBe("1900-01-01");
    expect(serialToText(61, "date", false)).toBe("1900-03-01");
    expect(serialToText(0, "date", true)).toBe("1904-01-01");
    expect(serialToText(0.5, "time", false)).toBe("12:00:00");
    expect(serialToText(45292.25, "date", false)).toBe("2024-01-01T06:00:00");
  });

  it("1904 年方式のブックは起点をずらす", async () => {
    const wb = await parseXlsx(
      await makeXlsx({ sheets: [{ name: "S", rows: '<row r="1"><c r="A1" s="1"><v>0</v></c></row><row r="2"><c r="A2"><v>1</v></c></row>' }], cellXfs: [0, 14], date1904: true }),
    );
    expect(wb.tables[0]!.rows[0]!.cells).toEqual(["1904-01-01"]);
  });

  it("行数・列数の上限で打ち切り、打ち切ったことを返す", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c><c r="Z${i + 1}"><v>9</v></c></row>`).join("");
    const t = (await parseXlsx(await makeXlsx({ sheets: [{ name: "S", rows }] }), { maxRows: 3, maxColumns: 10 })).tables[0]!;
    expect(t.rows).toHaveLength(3);
    expect(t.truncatedRows).toBe(true);
    expect(t.truncatedColumns).toBe(true);
    expect(t.columnCount).toBe(1);
  });

  it(".xls・パスワード付き（OLE）・.xlsb・壊れたファイルは、直し方を添えてエラー", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    await expect(parseImportFile("台帳.xls", ole)).rejects.toThrow(/Save it as \.xlsx/);
    const xlsb = await makeZip({ "xl/workbook.bin": "x" });
    await expect(parseImportFile("台帳.xlsb", xlsb)).rejects.toThrow(/xlsb/);
    await expect(parseImportFile("台帳.xlsx", enc.encode("PK\u0003\u0004 broken"))).rejects.toThrow(ImportError);
    await expect(parseImportFile("台帳.xlsx", enc.encode("a,b\n1,2"))).rejects.toThrow(/not in Excel format/);
  });
});

describe("CSV の読み取り", () => {
  it("Shift_JIS の CSV（日本語の Excel が保存するもの）を読み、先頭の 0 を残す", () => {
    // "機器番号,名称\r\n0012,ポンプ\r\n" の Shift_JIS
    const sjis = new Uint8Array([
      0x8b, 0x40, 0x8a, 0xed, 0x94, 0xd4, 0x8d, 0x86, 0x2c, 0x96, 0xbc, 0x8f, 0xcc, 0x0d, 0x0a, 0x30, 0x30, 0x31, 0x32, 0x2c, 0x83, 0x7c, 0x83, 0x93, 0x83, 0x76,
      0x0d, 0x0a,
    ]);
    const wb = parseCsv(sjis, "点検.csv");
    expect(wb.encoding).toBe("shift_jis");
    expect(wb.delimiter).toBe("comma");
    expect(wb.tables[0]!.name).toBe("点検.csv");
    expect(wb.tables[0]!.rows).toEqual([
      { row: 1, cells: ["機器番号", "名称"] },
      { row: 2, cells: ["0012", "ポンプ"] },
    ]);
  });

  it("引用符の中の区切り・改行・二重の引用符、BOM、空の行、改行で終わらない最後の行", () => {
    const text = '﻿a,b,c\n"x,1","line1\nline2","say ""hi"""\n\n,,\nlast,,';
    const wb = parseCsv(enc.encode(text), "t.csv");
    expect(wb.encoding).toBe("utf-8");
    expect(wb.tables[0]!.rows).toEqual([
      { row: 1, cells: ["a", "b", "c"] },
      { row: 2, cells: ["x,1", "line1\nline2", 'say "hi"'] },
      { row: 5, cells: ["last"] },
    ]);
  });

  it("タブ区切りは拡張子か 1 行目で見分ける", () => {
    expect(parseCsv(enc.encode("a\tb\n1\t2"), "x.txt").delimiter).toBe("tab");
    expect(parseCsv(enc.encode("a,b\n1,2"), "x.tsv").delimiter).toBe("tab");
    expect(parseCsv(enc.encode("a\tb,c\n1,2"), "x.csv").delimiter).toBe("comma");
  });

  it("行数の上限で打ち切る・テキストでなければエラー", () => {
    const t = parseDelimited("a\n1\n2\n3\n", ",", { maxRows: 2, maxColumns: 10 });
    expect(t.rows.map((r) => r.cells[0])).toEqual(["a", "1"]);
    expect(t.truncatedRows).toBe(true);
    expect(() => parseCsv(new Uint8Array([0x41, 0x00, 0x42]), "x.csv")).toThrow(ImportError);
  });
});

describe("見出しの見当とシートへの変換", () => {
  it("列記号", () => {
    expect([0, 25, 26, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
    expect(["A", "Z", "AA", "ZZ", "AAA", "a"].map(columnIndex)).toEqual([0, 25, 26, 701, 702, 0]);
  });

  it("表題の行ではなく、文字の多い最初の行を見出しの候補の先頭にする", async () => {
    const list = (await parseXlsx(await workbookBytes())).tables[0]!;
    const c = headerCandidates(list);
    expect(c[0]!.row).toBe(3);
    expect(c.map((x) => x.row)).not.toContain(8);
  });

  it("MXLoader 形式は 2 行目が見出し", async () => {
    const wb = await parseXlsx(await workbookBytes());
    expect(detectMxLoader(wb.tables[1]!)).toEqual({ objectStructure: "MXASSET", action: "AddChange", headerRow: 2 });
    expect(detectMxLoader(wb.tables[0]!)).toBeNull();
  });

  it("列名: 見出しの空白はまとめ、空の見出しは列記号、重なる見出しは列記号を添える。型は値から決める", async () => {
    const list = (await parseXlsx(await workbookBytes())).tables[0]!;
    const cols = importColumns(list, 3);
    expect(cols.map((c) => [c.name, c.letter, c.type, c.filled])).toEqual([
      ["サイト", "A", "string", 3],
      ["機器 番号", "B", "string", 3],
      ["タグ", "C", "string", 2],
      ["設置日", "D", "datetime", 2],
      ["定格", "E", "string", 3],
      ["備考", "F", "string", 2],
      ["備考_G", "G", "string", 1],
      ["Column H", "H", "string", 1],
      ["点検済", "I", "boolean", 2],
    ]);
  });

  it("rowKey と SOURCE_ROW は元の行番号。rename した列は元の見出しを画面表示名に残す。文字の列の数値は文字にそろえる", async () => {
    const list = (await parseXlsx(await workbookBytes())).tables[0]!;
    const built = buildImportSheet(list, {
      name: "台帳",
      headerRow: 3,
      rename: { "機器 番号": "ASSETNUM" },
      source: { kind: "excel", importId: "i1", fileName: "機器一覧.xlsx", sheetName: "機器一覧", headerRow: 3 },
    });
    expect(built.meta.keyColumns).toEqual([SOURCE_ROW_COLUMN]);
    expect(built.meta.columns[0]).toMatchObject({ name: SOURCE_ROW_COLUMN, title: "Source row", readOnly: true });
    expect(built.meta.columns.find((c) => c.name === "ASSETNUM")).toEqual({ name: "ASSETNUM", type: "string", title: "機器 番号" });
    expect(built.rows.map((r) => r.rowKey)).toEqual(["4", "5", "7", "8"]);
    const r5 = built.rows[1]!.values;
    expect(r5).toMatchObject({ SOURCE_ROW: 5, ASSETNUM: "5002", 定格: "15", 点検済: false, 設置日: "2024-01-01T12:00:00" });
    expect(built.rows[0]!.values.定格).toBe("0.3");
  });

  it("rename の誤り・重なり・キー列の誤りはエラー", () => {
    const t: RawTable = {
      name: "S",
      hidden: false,
      rows: [
        { row: 1, cells: ["A", "B"] },
        { row: 2, cells: ["1", "2"] },
      ],
      columnCount: 2,
      truncatedRows: false,
      truncatedColumns: false,
    };
    const source = { kind: "excel" as const, importId: "i", fileName: "f", sheetName: "S", headerRow: 1 };
    expect(() => buildImportSheet(t, { name: "x", headerRow: 1, rename: { C: "X" }, source })).toThrow(/in rename is not a column/);
    expect(() => buildImportSheet(t, { name: "x", headerRow: 1, rename: { A: "B" }, source })).toThrow(/is used twice/);
    expect(() => buildImportSheet(t, { name: "x", headerRow: 1, keyColumns: ["Z"], source })).toThrow(/Key column Z is not a column/);
    expect(() => buildImportSheet(t, { name: "x", headerRow: 9, source })).toThrow(/Row 9 has no values/);
  });
});

// ---------------------------------------------------------------------------
// ツール
// ---------------------------------------------------------------------------

function harness() {
  const connection = { current: () => null, subscribe: () => () => {} };
  const workspace = new Workspace("作業");
  const jobs = new JobRegistry();
  const commits = createCommitController({ workspace, connection });
  const imports = new ImportStore(() => 1_700_000_000_000);
  const registry = createToolRegistry({
    workspace,
    jobs,
    connection,
    commits,
    catalog: new ObjectStructureCatalog(),
    imports,
    appVersion: "0.1.0-test",
    appUrl: "http://127.0.0.1:8788/app",
  });
  let seq = 0;
  async function invoke(tool: string, args: unknown) {
    const msg: InvokeMsg = {
      type: "tool.invoke",
      id: `c${++seq}`,
      tool: tool as ToolName,
      args,
      deadlineAt: Date.now() + 30_000,
      timeoutMs: 30_000,
      idempotencyKey: "",
      readOnly: false,
    };
    return registry.handler(msg, { signal: new AbortController().signal, progress: () => {} });
  }
  async function call(tool: string, args: unknown = {}): Promise<Record<string, any>> {
    return (await invoke(tool, args)).result.structuredContent as Record<string, any>;
  }
  async function fail(tool: string, args: unknown): Promise<RelayToolError> {
    try {
      await invoke(tool, args);
    } catch (e) {
      expect(e).toBeInstanceOf(RelayToolError);
      return e as RelayToolError;
    }
    throw new Error(`${tool} が成功してしまいました`);
  }
  return { workspace, imports, registry, call, fail };
}

/** Maximo から読んだことにした資産のシート（反映の対象） */
function maximoAssets(workspace: Workspace): void {
  const meta: SheetMeta = {
    name: "資産",
    source: { kind: "maximo", os: "MXASSET", select: ["SITEID", "ASSETNUM", "DESCRIPTION"], where: [] },
    columns: [
      { name: "SITEID", type: "string", readOnly: true },
      { name: "ASSETNUM", type: "string", readOnly: true },
      { name: "DESCRIPTION", type: "string" },
    ],
    keyColumns: ["SITEID", "ASSETNUM"],
    childIdAttrs: {},
  };
  const rows: SheetRow[] = [
    ["BEDFORD", "A5001", "ポンプ"],
    ["BEDFORD", "5002", "ポンプ"],
    ["BEDFORD", "A5009", "ファン"],
  ].map(([site, asset, desc]) => {
    const rowKey = makeParentKey([site!, asset!]);
    return { rowKey, parentKey: rowKey, childName: null, values: { SITEID: site!, ASSETNUM: asset!, DESCRIPTION: desc! } };
  });
  workspace.createSheet(meta, rows);
}

describe("describe_import / apply_mapping", () => {
  it("作業画面にあるのは実装済みのツール（取り込みの 2 本を含む）", () => {
    const h = harness();
    expect(h.registry.tools).toContain("describe_import");
    expect(h.registry.tools).toContain("apply_mapping");
    expect(h.registry.tools).not.toContain("import_rows");
    expect(h.registry.tools).not.toContain("export_sheet");
  });

  it("届いたファイルは get_status の imports に出る（無ければ出さない）", async () => {
    const h = harness();
    expect((await h.call("get_status")).imports).toBeUndefined();
    h.imports.add({ importId: "i1", fileName: "機器一覧.xlsx", contentType: "application/octet-stream", bytes: await workbookBytes(), sha256: "ab" });
    expect((await h.call("get_status")).imports).toEqual([{ importId: "i1", fileName: "機器一覧.xlsx", bytes: expect.any(Number), receivedAt: "2023-11-14T22:13:20.000Z", dropped: false }]);
  });

  it("describe_import: シートごとの見出しの見当・列・サンプル行・MXLoader 形式・非表示", async () => {
    const h = harness();
    h.imports.add({ importId: "i1", fileName: "機器一覧.xlsx", contentType: "", bytes: await workbookBytes(), sha256: "" });
    const r = await h.call("describe_import", { importId: "i1" });
    expect(r).toMatchObject({ importId: "i1", fileName: "機器一覧.xlsx", format: "xlsx", sheetCount: 3, dataNotice: DATA_NOTICE });
    const [list, mx, hidden] = r.sheets;
    expect(list).toMatchObject({ name: "機器一覧", rowCount: 6, headerRow: 3, dataRowCount: 4, columnCount: 9 });
    expect(list.columns[1]).toEqual({ name: "機器 番号", letter: "B", type: "string", filled: 3 });
    expect(list.sampleRows[0]).toEqual({
      row: 4,
      values: { サイト: "BEDFORD", "機器 番号": "A5001", タグ: "P-101", 設置日: "2024-01-01", 定格: 0.3, 備考: "吸込側 & 吐出側", 備考_G: "行1\r\n行2", "Column H": "X", 点検済: true },
    });
    expect(list.headerCandidates[0]).toMatchObject({ row: 3 });
    expect(mx).toMatchObject({ name: "MX", headerRow: 2, mxloader: { objectStructure: "MXASSET", action: "AddChange", headerRow: 2 } });
    expect(hidden).toMatchObject({ name: "設定", hidden: true });
  });

  it("describe_import: sheet と headerRow で見出しを組み直す。sampleRows: 0 は行を返さない", async () => {
    const h = harness();
    h.imports.add({ importId: "i1", fileName: "機器一覧.xlsx", contentType: "", bytes: await workbookBytes(), sha256: "" });
    const r = await h.call("describe_import", { importId: "i1", sheet: "機器一覧", headerRow: 4, sampleRows: 0 });
    expect(r.sheets).toHaveLength(1);
    expect(r.sheets[0]).toMatchObject({ headerRow: 4, dataRowCount: 3, sampleRows: [] });
    expect(r.sheets[0].columns[0].name).toBe("BEDFORD");
    const e = await h.fail("describe_import", { importId: "i1", headerRow: 4 });
    expect(e.code).toBe(RelayErrorCode.INVALID_ARGS);
    const e2 = await h.fail("describe_import", { importId: "i1", sheet: "機器一欄" });
    expect(e2.message).toContain("機器一覧");
  });

  it("届いていない importId は、届いているファイルを添えて TOOL_ERROR。読めないファイルも理由を返す", async () => {
    const h = harness();
    h.imports.add({ importId: "i1", fileName: "機器一覧.xlsx", contentType: "", bytes: await workbookBytes(), sha256: "" });
    const e = await h.fail("describe_import", { importId: "nope" });
    expect(e.code).toBe(RelayErrorCode.TOOL_ERROR);
    expect(e.message).toContain("i1 (機器一覧.xlsx)");
    h.imports.add({ importId: "old", fileName: "古い.xls", contentType: "", bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), sha256: "" });
    const e2 = await h.fail("describe_import", { importId: "old" });
    expect(e2.message).toMatch(/Could not read 古い\.xls: .*Save it as \.xlsx/);
  });

  it("apply_mapping: シートにして、Maximo のシートと突き合わせ・値を移せる。取り込んだシートは反映できない", async () => {
    const h = harness();
    maximoAssets(h.workspace);
    h.imports.add({ importId: "i1", fileName: "機器一覧.xlsx", contentType: "", bytes: await workbookBytes(), sha256: "" });
    // 改行の入った見出しをそのまま書いても当たる
    const r = await h.call("apply_mapping", { importId: "i1", sourceSheet: "機器一覧", headerRow: 3, name: "台帳", rename: { "機器\n番号": "ASSETNUM", サイト: "SITEID" } });
    expect(r).toMatchObject({
      sheet: "台帳",
      replaced: false,
      source: { importId: "i1", fileName: "機器一覧.xlsx", sheetName: "機器一覧", headerRow: 3 },
      rowCount: 4,
      keyColumns: [SOURCE_ROW_COLUMN],
      renamed: { "機器 番号": "ASSETNUM", サイト: "SITEID" },
      columnTitles: { SOURCE_ROW: "Source row", SITEID: "サイト", ASSETNUM: "機器 番号" },
    });
    expect(r.columns.slice(0, 4)).toEqual([SOURCE_ROW_COLUMN, "SITEID", "ASSETNUM", "タグ"]);
    expect(r.note).toContain("cannot be committed to Maximo");

    const q = await h.call("query_rows", { sheet: "台帳", columns: ["ASSETNUM"] });
    expect(q.rows.map((x: any) => [x.rowKey, x.values.ASSETNUM])).toEqual([
      ["4", "A5001"],
      ["5", "5002"],
      ["7", "A5003"],
      ["8", null],
    ]);

    const m = await h.call("match_sheets", { left: "資産", right: "台帳", leftCol: ["SITEID", "ASSETNUM"], rightCol: ["SITEID", "ASSETNUM"] });
    // 右の不一致は A5003 と、キーの空いた 8 行目
    expect(m).toMatchObject({ matched: 2, unmatchedLeft: 1, unmatchedRight: 2 });

    const a = await h.call("apply_rule", {
      sheet: "資産",
      filter: [],
      set: { DESCRIPTION: { lookup: { sheet: "台帳", matchCol: ["SITEID", "ASSETNUM"], targetMatchCol: ["SITEID", "ASSETNUM"], sourceCol: "タグ" } } },
      reason: "機器一覧のタグを移す",
      baseRevision: r.revision,
    });
    expect(a).toMatchObject({ applied: 2, lookup: { DESCRIPTION: { matched: 2, unmatched: 1, ambiguous: 0 } } });

    const c = await h.call("request_commit", { sheet: "台帳", note: "x" });
    expect(c.blockers.length).toBeGreaterThan(0);
  });

  it("add_rows の from: 取り込んだシートの行から、作業画面の中で新しいレコードの行を作る（値は引数を通らない）", async () => {
    const h = harness();
    maximoAssets(h.workspace);
    h.imports.add({ importId: "i1", fileName: "機器一覧.xlsx", contentType: "", bytes: await workbookBytes(), sha256: "" });
    const r = await h.call("apply_mapping", { importId: "i1", sourceSheet: "機器一覧", headerRow: 3, name: "台帳", rename: { "機器\n番号": "ASSETNUM", サイト: "SITEID" } });
    const columns = { SITEID: "SITEID", ASSETNUM: "ASSETNUM", DESCRIPTION: "タグ" };
    const add = await h.call("add_rows", {
      sheet: "資産",
      from: { sheet: "台帳", columns, filter: [{ attr: "ASSETNUM", op: "eq", value: "A5003" }] },
      baseRevision: r.revision,
      reason: "機器一覧にだけある機器を登録",
    });
    expect(add).toMatchObject({ applied: 1, rowKeys: [makeParentKey(["BEDFORD", "A5003"])] });
    const q = await h.call("query_rows", { sheet: "資産", filter: [{ attr: "ASSETNUM", op: "eq", value: "A5003" }], columns: ["SITEID", "ASSETNUM", "DESCRIPTION"] });
    const src = await h.call("query_rows", { sheet: "台帳", filter: [{ attr: "ASSETNUM", op: "eq", value: "A5003" }], columns: ["タグ"] });
    expect(q.rows[0].values).toEqual({ SITEID: "BEDFORD", ASSETNUM: "A5003", DESCRIPTION: src.rows[0].values["タグ"] });

    // もうある機器（A5001）とキーの空いた行は衝突として返し、足さない
    const again = await h.call("add_rows", { sheet: "資産", from: { sheet: "台帳", columns }, baseRevision: add.revision, reason: "全部" });
    expect(again.applied).toBe(0);
    expect(again.conflicts.length).toBeGreaterThan(0);

    const both = await h.fail("add_rows", { sheet: "資産", rows: [{ SITEID: "BEDFORD", ASSETNUM: "X1" }], from: { sheet: "台帳", columns }, baseRevision: add.revision, reason: "x" });
    expect(both.code).toBe(RelayErrorCode.INVALID_ARGS);
    const neither = await h.fail("add_rows", { sheet: "資産", baseRevision: add.revision, reason: "x" });
    expect(neither.code).toBe(RelayErrorCode.INVALID_ARGS);
  });

  it("apply_mapping: 列名・キー列の誤りは近い名前を添えて INVALID_ARGS。空の見出しの行は候補を添える", async () => {
    const h = harness();
    h.imports.add({ importId: "i1", fileName: "機器一覧.xlsx", contentType: "", bytes: await workbookBytes(), sha256: "" });
    const base = { importId: "i1", sourceSheet: "機器一覧", headerRow: 3, name: "台帳" };
    const e1 = await h.fail("apply_mapping", { ...base, rename: { 機器番号: "ASSETNUM" } });
    expect(e1.code).toBe(RelayErrorCode.INVALID_ARGS);
    expect(e1.message).toContain("機器 番号");
    const e2 = await h.fail("apply_mapping", { ...base, keyColumns: ["ASSETNUM"] });
    expect(e2.message).toContain("use the names after rename");
    const e3 = await h.fail("apply_mapping", { ...base, headerRow: 2 });
    expect(e3.message).toMatch(/Row 2 of .* has no values\. Likely header rows: 3/);
  });

  it("apply_mapping: 未反映の変更がある同名のシートは置き換えない", async () => {
    const h = harness();
    maximoAssets(h.workspace);
    h.workspace.applyEdits("資産", [{ rowKey: makeParentKey(["BEDFORD", "A5001"]), col: "DESCRIPTION", value: "変更" }], { author: "user" });
    h.imports.add({ importId: "i1", fileName: "機器一覧.xlsx", contentType: "", bytes: await workbookBytes(), sha256: "" });
    const e = await h.fail("apply_mapping", { importId: "i1", sourceSheet: "機器一覧", headerRow: 3, name: "資産" });
    expect(e.message).toContain("changes not yet committed to Maximo");
  });

  it("CSV もシートにできる（sourceSheet はファイル名）", async () => {
    const h = harness();
    h.imports.add({ importId: "c1", fileName: "点検.csv", contentType: "text/csv", bytes: enc.encode("機器番号,結果\nA5001,良\nA5002,否\n"), sha256: "" });
    const d = await h.call("describe_import", { importId: "c1" });
    expect(d).toMatchObject({ format: "csv", encoding: "utf-8", delimiter: "comma", sheets: [{ name: "点検.csv", headerRow: 1, dataRowCount: 2 }] });
    const r = await h.call("apply_mapping", { importId: "c1", sourceSheet: "点検.csv", headerRow: 1, name: "点検", keyColumns: ["機器番号"] });
    expect(r).toMatchObject({ rowCount: 2, keyColumns: ["機器番号"] });
  });
});

// ---------------------------------------------------------------------------
// 帳票の読み取り・fillDown・unpivot（ツール）
// ---------------------------------------------------------------------------

/** 行番号 → 値の配列から sheetData を作る（文字はインラインの文字列） */
function sheetRows(rows: Record<number, Array<string | number | null>>): string {
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return Object.entries(rows)
    .map(([r, cells]) => {
      const cs = cells
        .map((v, i) => {
          if (v === null) return "";
          const ref = `${columnLetter(i)}${r}`;
          return typeof v === "number" ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r}">${cs}</row>`;
    })
    .join("");
}

/** 作業日報が 3 枚並んだシート（帳票の表題・上の欄・明細・特記事項） */
function dailyReportRows(): Record<number, Array<string | number | null>> {
  const rows: Record<number, Array<string | number | null>> = {};
  const lines = [
    [["巡視点検", "場内巡視 異常なし", 1], ["故障修理", "2号の誘引 IDF 異音 給脂", 2.5], ["〃", "同上 経過観察", 0.5]],
    [["定期点検", "1号炉 押込送風機 定期点検", 1]],
    [["修理", "汚水移送P No.2 漏れ 増締め", 0.5], ["清掃", "灰押出機まわり 清掃", 2]],
  ] as const;
  lines.forEach((ls, k) => {
    const b = 1 + k * 20;
    rows[b] = ["北部クリーンセンター", null, "作　業　日　報"];
    rows[b + 1] = [`No. 4-0${k + 1}`];
    rows[b + 3] = ["委託契約工事名", null, "令和8年度 設備保守点検業務委託"];
    rows[b + 4] = ["受注者", null, "設備保守業者Ｃ", null, null, "作業日", `R8.4.${k + 1}`];
    rows[b + 6] = ["No.", "作業区分", "作業内容", null, null, null, "時間"];
    for (let i = 0; i < 6; i++) {
      const l = ls[i];
      rows[b + 7 + i] = l ? [i + 1, l[0], l[1], null, null, null, l[2]] : [i + 1];
    }
    rows[b + 14] = ["特記事項", null, k === 1 ? null : "特になし"];
  });
  return rows;
}

describe("帳票の読み取り・fillDown・unpivot（ツール）", () => {
  it("describe_import: 帳票が並んだシートは formHint で知らせ、結合したセルも出す", async () => {
    const h = harness();
    const bytes = await makeXlsx({ sheets: [{ name: "4月", rows: sheetRows(dailyReportRows()), merges: ["C1:E1", "C21:E21", "C41:E41"] }] });
    h.imports.add({ importId: "d1", fileName: "作業日報.xlsx", contentType: "", bytes, sha256: "" });
    const d = await h.call("describe_import", { importId: "d1" });
    expect(d.sheets[0]).toMatchObject({ formHint: { forms: 3, firstRows: [1, 21, 41] }, merges: { count: 3, first: ["C1:E1", "C21:E21", "C41:E41"] } });
    expect(d.sheets[0].formNote).toContain("form in apply_mapping");
    expect(d.next).toContain("form");
  });

  it("apply_mapping の form: 1 明細 1 行のシートにし、帳票の上の欄を各行に付ける", async () => {
    const h = harness();
    const bytes = await makeXlsx({ sheets: [{ name: "4月", rows: sheetRows(dailyReportRows()) }] });
    h.imports.add({ importId: "d1", fileName: "作業日報.xlsx", contentType: "", bytes, sha256: "" });
    const r = await h.call("apply_mapping", {
      importId: "d1",
      sourceSheet: "4月",
      name: "作業日報 4月",
      form: { start: ["作業日報"], fields: { NO: "No.", CONTRACT: "委託契約工事名", WORKDATE: "作業日", NOTES: "特記事項" }, items: { header: "作業内容", until: ["特記事項"] } },
      fillDown: { columns: ["作業区分"] },
      rename: { 作業内容: "DESCRIPTION" },
    });
    expect(r).toMatchObject({ sheet: "作業日報 4月", rowCount: 6, forms: 3, missingFields: { NOTES: 1 }, filledDown: { 作業区分: 1 }, keyColumns: ["SOURCE_ROW"] });
    expect(r.columns).toEqual(["SOURCE_ROW", "BLOCK", "NO", "CONTRACT", "WORKDATE", "NOTES", "No.", "作業区分", "DESCRIPTION", "時間"]);
    expect(r.formNote).toContain("BLOCK");
    const rows = await h.call("query_rows", { sheet: "作業日報 4月", columns: ["BLOCK", "NO", "WORKDATE", "作業区分", "DESCRIPTION"] });
    expect(rows.rows.map((x: { values: Record<string, unknown> }) => x.values)).toEqual([
      { BLOCK: 1, NO: "4-01", WORKDATE: "R8.4.1", 作業区分: "巡視点検", DESCRIPTION: "場内巡視 異常なし" },
      { BLOCK: 1, NO: "4-01", WORKDATE: "R8.4.1", 作業区分: "故障修理", DESCRIPTION: "2号の誘引 IDF 異音 給脂" },
      { BLOCK: 1, NO: "4-01", WORKDATE: "R8.4.1", 作業区分: "故障修理", DESCRIPTION: "同上 経過観察" },
      { BLOCK: 2, NO: "4-02", WORKDATE: "R8.4.2", 作業区分: "定期点検", DESCRIPTION: "1号炉 押込送風機 定期点検" },
      { BLOCK: 3, NO: "4-03", WORKDATE: "R8.4.3", 作業区分: "修理", DESCRIPTION: "汚水移送P No.2 漏れ 増締め" },
      { BLOCK: 3, NO: "4-03", WORKDATE: "R8.4.3", 作業区分: "清掃", DESCRIPTION: "灰押出機まわり 清掃" },
    ]);
  });

  it("apply_mapping の unpivot: 年度の列を行にし、SOURCE_CELL を付ける", async () => {
    const h = harness();
    const rows = { 1: ["機器名称", "区分", "年度"], 2: [null, null, 2006, 2007], 3: ["押込送風機", "実績", "○", "○◎"], 4: ["誘引送風機", "実績", null, "△"] };
    h.imports.add({ importId: "s1", fileName: "星取表.xlsx", contentType: "", bytes: await makeXlsx({ sheets: [{ name: "通風", rows: sheetRows(rows) }] }), sha256: "" });
    const r = await h.call("apply_mapping", { importId: "s1", sourceSheet: "通風", headerRow: 1, name: "星取表", unpivot: { columns: ["C:D"], labelRow: 2, labelColumn: "FY", valueColumn: "MARK", tokens: ["○", "◎", "△"] } });
    expect(r).toMatchObject({ rowCount: 4, keyColumns: ["SOURCE_CELL", "MARK"], unpivot: { columns: ["C", "D"], rows: 4, skippedEmptyCells: 1 } });
    expect(r.rowKeyNote).toContain("SOURCE_CELL");
    const q = await h.call("query_rows", { sheet: "星取表", columns: ["機器名称", "FY", "MARK", "SOURCE_CELL"] });
    expect(q.rows.map((x: { values: Record<string, unknown> }) => Object.values(x.values))).toEqual([
      ["押込送風機", 2006, "○", "C3"],
      ["押込送風機", 2007, "○", "D3"],
      ["押込送風機", 2007, "◎", "D3"],
      ["誘引送風機", 2007, "△", "D4"],
    ]);
  });

  it("headerRow も form も無い・指定の誤りは INVALID_ARGS で理由を添える", async () => {
    const h = harness();
    h.imports.add({ importId: "d1", fileName: "作業日報.xlsx", contentType: "", bytes: await makeXlsx({ sheets: [{ name: "4月", rows: sheetRows(dailyReportRows()) }] }), sha256: "" });
    const e1 = await h.fail("apply_mapping", { importId: "d1", sourceSheet: "4月", name: "x" });
    expect(e1.code).toBe(RelayErrorCode.INVALID_ARGS);
    expect(e1.message).toContain("form");
    const e2 = await h.fail("apply_mapping", { importId: "d1", sourceSheet: "4月", name: "x", form: { start: ["点検報告書"], fields: { D: "作業日" } } });
    expect(e2.message).toContain("form.start");
    const e3 = await h.fail("apply_mapping", { importId: "d1", sourceSheet: "4月", name: "x", form: { start: ["作業日報"], fields: { D: "作業日" } }, rename: { 日付: "X" } });
    expect(e3.message).toContain("is not a column of the shaped sheet");
    // 見立ての枚数（3）と違えば知らせる
    const r = await h.call("apply_mapping", { importId: "d1", sourceSheet: "4月", name: "x", form: { start: ["作業日報"], fields: { D: "作業日" } } });
    expect(r.formCountNote).toBeUndefined();
    const r2 = await h.call("apply_mapping", { importId: "d1", sourceSheet: "4月", name: "y", form: { start: ["委託契約工事名", "作業日報"], fields: { D: "作業日" } } });
    expect(r2.forms).toBe(6);
    expect(r2.formCountNote).toContain("describe_import saw 3 forms");
  });
});

describe("ImportStore", () => {
  it("新しい順に 5 つまで持ち、読み取りは 1 回だけ", async () => {
    const store = new ImportStore();
    for (let i = 1; i <= 6; i++) store.add({ importId: `i${i}`, fileName: `${i}.csv`, contentType: "", bytes: enc.encode("a\n1"), sha256: "" });
    expect(store.list().map((e) => e.importId)).toEqual(["i6", "i5", "i4", "i3", "i2"]);
    expect(store.get("i1")).toBeNull();
    const a = store.workbook("i6");
    expect(store.workbook("i6")).toBe(a);
    await expect(store.workbook("i1")).rejects.toThrow(ImportError);
    store.clear();
    expect(store.list()).toEqual([]);
  });
});

describe("作業画面へのドロップ", () => {
  function fakeWindow() {
    const target = new EventTarget();
    return target as unknown as Window;
  }
  function dropEvent(types: string[], files: Array<{ name: string; size: number; type: string; text: string }>): Event {
    const ev = new Event("drop", { cancelable: true });
    Object.defineProperty(ev, "dataTransfer", {
      value: { types, files: files.map((f) => ({ ...f, arrayBuffer: async () => enc.encode(f.text).buffer })) },
    });
    return ev;
  }

  it("ファイルを受け取り、ブラウザがファイルを開かないよう止める", async () => {
    const win = fakeWindow();
    const store = new ImportStore();
    const notify = vi.fn();
    let n = 0;
    const stop = installImportDrop({ win, store, notify, newId: () => `drop-${++n}`, digest: async () => new Uint8Array([0xab]).buffer });
    const ev = dropEvent(["Files"], [{ name: "点検.csv", size: 7, type: "text/csv", text: "a,b\n1,2" }]);
    win.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(store.get("drop-1")).not.toBeNull());
    expect(store.get("drop-1")).toMatchObject({ fileName: "点検.csv", sha256: "ab", dropped: true });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("点検.csv を受け取りました"));
    stop();
  });

  it("大きすぎるファイルは受け取らない。ファイルでないドラッグは止めない", async () => {
    const win = fakeWindow();
    const store = new ImportStore();
    const notify = vi.fn();
    installImportDrop({ win, store, notify, newId: () => "drop-x", maxBytes: 3 });
    win.dispatchEvent(dropEvent(["Files"], [{ name: "big.csv", size: 10, type: "", text: "0123456789" }]));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("大きすぎます"), "error"));
    expect(store.list()).toEqual([]);
    const text = dropEvent(["text/plain"], []);
    win.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
  });
});
