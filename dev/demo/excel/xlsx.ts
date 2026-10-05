// 小さな xlsx の書き出し（外部の部品を使わない）。デモの Excel（現場の台帳・発注リスト・星取表・作業日報）を作るためのもの。
// できること: 複数のシート、共有文字列、数値・真偽値、日付（シリアル値と表示形式）、セルの結合、列幅、行の高さ、見出しの固定、
// 太字・塗り・罫線・折り返し・桁区切りの書式、帳票の書式（黒の細い罫線）、印刷の設定（A4 縦・改ページ・印刷範囲・フッタ）。
// 同じ入力からは同じバイト列になる（ZIP の日時を固定する）。帳票の書式と印刷の設定は、使うシートがあるときだけ書く（ほかのファイルのバイト列は変えない）。

import { deflateRawSync } from "node:zlib";

/** セルの書式（f で始まるものは帳票: 黒の細い罫線・10pt） */
export type Style =
  | "plain" | "title" | "head" | "cell" | "date" | "money" | "wrap" | "total" | "note" | "num1" | "center"
  | "fTitle" | "fLabel" | "fCell" | "fWrap" | "fCenter" | "fHead" | "fSmall" | "fNum";

export interface CellSpec {
  v: string | number | boolean | null;
  s?: Style;
  /** 日付（v はシリアル値ではなく日本時間の ms） */
  date?: boolean;
}

export type CellInput = string | number | boolean | null | undefined | CellSpec;

export interface SheetSpec {
  name: string;
  rows: CellInput[][];
  /** 結合（"A1:C1"） */
  merges?: string[];
  /** 列幅（文字数） */
  cols?: number[];
  /** この行・列より上・左を固定（1 始まり。例 {row: 4} は 1〜3 行目を固定） */
  freeze?: { row?: number; col?: number };
  /** 行の高さ（1 始まりの行 → ポイント） */
  rowHeights?: Record<number, number>;
  /** 印刷の設定（A4 縦・横幅を 1 ページに合わせる・印刷範囲は使った範囲） */
  print?: {
    /** この行（1 始まり）の後で改ページする */
    breaks?: number[];
    /** フッタ（&A はシート名、&P はページ、&N はページ数） */
    footer?: string;
    /** 余白（インチ） */
    margins?: { left: number; right: number; top: number; bottom: number };
  };
}

const STYLE_INDEX: Record<Style, number> = {
  plain: 0, title: 1, head: 2, cell: 3, date: 4, money: 5, wrap: 6, total: 7, note: 8, num1: 9, center: 10,
  fTitle: 11, fLabel: 12, fCell: 13, fWrap: 14, fCenter: 15, fHead: 16, fSmall: 17, fNum: 18,
};
const FORM_STYLES = new Set<Style>(["fTitle", "fLabel", "fCell", "fWrap", "fCenter", "fHead", "fSmall", "fNum"]);

const DAY = 86_400_000;
const JST = 9 * 3_600_000;

/** 日本時間の ms → Excel のシリアル値（日付だけ） */
export function excelDate(ms: number): number {
  return Math.floor((ms + JST) / DAY) + 25569;
}

export function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function esc(s: string): string {
  // XML に使えない制御文字を除き、特別な文字を逃がす
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sheetNameOk(name: string): string {
  const clean = name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31);
  if (!clean.trim()) throw new Error(`bad sheet name ${name}`);
  return clean;
}

function stylesXml(font: string, charset: string, dateFormat: string, form: boolean): string {
  // 帳票の書式（form）: 10pt の文字、18pt の表題、9pt の灰色の注記、黒の細い罫線
  const formFonts = form
    ? `
<font><sz val="10"/><name val="${font}"/><family val="2"/>${charset}</font>
<font><b/><sz val="18"/><name val="${font}"/><family val="2"/>${charset}</font>
<font><sz val="9"/><color rgb="FF595959"/><name val="${font}"/><family val="2"/>${charset}</font>
<font><b/><sz val="10"/><name val="${font}"/><family val="2"/>${charset}</font>`
    : "";
  const formBorder = form
    ? `
<border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border>`
    : "";
  const formXfs = form
    ? `
<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="7" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="165" fontId="4" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="${dateFormat}"/><numFmt numFmtId="165" formatCode="#,##0.0"/></numFmts>
<fonts count="${form ? 8 : 4}">
<font><sz val="11"/><name val="${font}"/><family val="2"/>${charset}</font>
<font><b/><sz val="14"/><name val="${font}"/><family val="2"/>${charset}</font>
<font><b/><sz val="11"/><name val="${font}"/><family val="2"/>${charset}</font>
<font><i/><sz val="10"/><color rgb="FF595959"/><name val="${font}"/><family val="2"/>${charset}</font>${formFonts}
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="${form ? 3 : 2}">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFA6A6A6"/></left><right style="thin"><color rgb="FFA6A6A6"/></right><top style="thin"><color rgb="FFA6A6A6"/></top><bottom style="thin"><color rgb="FFA6A6A6"/></bottom><diagonal/></border>${formBorder}
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${form ? 19 : 11}">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="3" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>${formXfs}
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

/** xlsx のバイト列を作る */
export function writeXlsx(sheets: SheetSpec[], meta: { title: string; creator: string; lang: "ja" | "en" }): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  let sharedCount = 0;
  const si = (s: string): number => {
    sharedCount++;
    let i = sharedIndex.get(s);
    if (i === undefined) {
      i = shared.length;
      shared.push(s);
      sharedIndex.set(s, i);
    }
    return i;
  };
  const names = sheets.map((s) => sheetNameOk(s.name));
  if (new Set(names).size !== names.length) throw new Error("duplicate sheet names");
  const usesForm = sheets.some((s) => s.rows.some((row) => row.some((c) => c !== null && typeof c === "object" && c.s !== undefined && FORM_STYLES.has(c.s))));
  /** 印刷範囲（シートの番号 → 範囲） */
  const printAreas: Array<{ index: number; ref: string }> = [];

  const sheetXml = sheets.map((sheet) => {
    const rows: string[] = [];
    let maxCol = 0;
    const heights = sheet.rowHeights ?? {};
    const rowOpen = (r: number): string => {
      const h = heights[r + 1];
      return h === undefined ? `<row r="${r + 1}">` : `<row r="${r + 1}" ht="${h}" customHeight="1">`;
    };
    sheet.rows.forEach((row, r) => {
      const cells: string[] = [];
      row.forEach((input, c) => {
        if (input === undefined) return;
        const spec: CellSpec = input !== null && typeof input === "object" ? input : { v: input };
        const ref = `${colName(c)}${r + 1}`;
        const style = STYLE_INDEX[spec.s ?? (spec.date ? "date" : "plain")];
        const sAttr = style > 0 ? ` s="${style}"` : "";
        if (spec.v === null || spec.v === "") {
          if (style > 0) cells.push(`<c r="${ref}"${sAttr}/>`);
          return;
        }
        maxCol = Math.max(maxCol, c + 1);
        if (spec.date && typeof spec.v === "number") cells.push(`<c r="${ref}"${sAttr}><v>${excelDate(spec.v)}</v></c>`);
        else if (typeof spec.v === "number") cells.push(`<c r="${ref}"${sAttr}><v>${spec.v}</v></c>`);
        else if (typeof spec.v === "boolean") cells.push(`<c r="${ref}"${sAttr} t="b"><v>${spec.v ? 1 : 0}</v></c>`);
        else cells.push(`<c r="${ref}"${sAttr} t="s"><v>${si(spec.v)}</v></c>`);
      });
      if (cells.length > 0) rows.push(`${rowOpen(r)}${cells.join("")}</row>`);
      else if (heights[r + 1] !== undefined) rows.push(`${rowOpen(r)}</row>`);
    });
    const dim = `A1:${colName(Math.max(0, maxCol - 1))}${Math.max(1, sheet.rows.length)}`;
    const fr = sheet.freeze;
    let views = `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
    if (fr && ((fr.row ?? 1) > 1 || (fr.col ?? 1) > 1)) {
      const row = fr.row ?? 1;
      const col = fr.col ?? 1;
      const top = `${colName(col - 1)}${row}`;
      const attrs = [col > 1 ? `xSplit="${col - 1}"` : "", row > 1 ? `ySplit="${row - 1}"` : "", `topLeftCell="${top}"`, `activePane="${row > 1 && col > 1 ? "bottomRight" : row > 1 ? "bottomLeft" : "topRight"}"`, `state="frozen"`].filter(Boolean).join(" ");
      views = `<sheetViews><sheetView workbookViewId="0"><pane ${attrs}/></sheetView></sheetViews>`;
    }
    const cols = sheet.cols && sheet.cols.length > 0 ? `<cols>${sheet.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    const merges = sheet.merges && sheet.merges.length > 0 ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
    const pr = sheet.print;
    if (!pr) {
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="${dim}"/>${views}<sheetFormatPr defaultRowHeight="18"/>${cols}<sheetData>${rows.join("")}</sheetData>${merges}<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
    }
    // 印刷: A4 縦（paperSize 9）、横幅を 1 ページに合わせ、縦は改ページのとおり。範囲は A1 から使った範囲まで
    const lastCol = Math.max(maxCol, sheet.cols?.length ?? 0);
    printAreas.push({ index: sheets.indexOf(sheet), ref: `$A$1:$${colName(Math.max(0, lastCol - 1))}$${Math.max(1, sheet.rows.length)}` });
    const mg = pr.margins ?? { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6 };
    const footer = pr.footer ? `<headerFooter><oddFooter>${esc(pr.footer)}</oddFooter></headerFooter>` : "";
    const breaks = pr.breaks ?? [];
    const rowBreaks = breaks.length > 0 ? `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.map((b) => `<brk id="${b}" max="16383" man="1"/>`).join("")}</rowBreaks>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="${dim}"/>${views}<sheetFormatPr defaultRowHeight="18"/>${cols}<sheetData>${rows.join("")}</sheetData>${merges}<printOptions horizontalCentered="1"/><pageMargins left="${mg.left}" right="${mg.right}" top="${mg.top}" bottom="${mg.bottom}" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>${footer}${rowBreaks}</worksheet>`;
  });

  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedCount}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`;

  // 印刷範囲は名前の定義（_xlnm.Print_Area）で持つ
  const definedNames =
    printAreas.length > 0
      ? `<definedNames>${printAreas.map((p) => `<definedName name="_xlnm.Print_Area" localSheetId="${p.index}">${esc(`'${names[p.index]!.replace(/'/g, "''")}'!${p.ref}`)}</definedName>`).join("")}</definedNames>`
      : "";
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15000"/></bookViews><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${definedNames}</workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${names.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(meta.title)}</dc:title><dc:creator>${esc(meta.creator)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-09-30T08:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-09-30T08:00:00Z</dcterms:modified></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>`;

  const files: Array<[string, string]> = [
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rootRels],
    ["docProps/core.xml", core],
    ["docProps/app.xml", app],
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", wbRels],
    ["xl/styles.xml", meta.lang === "ja" ? stylesXml("Meiryo UI", '<charset val="128"/>', "yyyy/m/d", usesForm) : stylesXml("Calibri", "", "yyyy-mm-dd", usesForm)],
    ["xl/sharedStrings.xml", sst],
    ...sheetXml.map((x, i) => [`xl/worksheets/sheet${i + 1}.xml`, x] as [string, string]),
  ];
  return zip(files.map(([name, text]) => [name, new TextEncoder().encode(text)]));
}

// ---- ZIP（deflate。CRC32 は表で計算する。日時は 2026-09-30 12:00 に固定） ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = (12 << 11) | (0 << 5) | 0;
const DOS_DATE = ((2026 - 1980) << 9) | (9 << 5) | 30;

export function zip(files: Array<[string, Uint8Array]>): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, raw] of files) {
    const nameBytes = enc.encode(name);
    const data = new Uint8Array(deflateRawSync(raw, { level: 9 }));
    const crc = crc32(raw);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 の名前
    lv.setUint16(8, 8, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, data);
    const cent = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cent.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cent.set(nameBytes, 46);
    central.push(cent);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
