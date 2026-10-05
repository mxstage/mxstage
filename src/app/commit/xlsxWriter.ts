// xlsx を書く（差分レポート用）。依存を足さず、ZIP は無圧縮（stored）で組み立てる。
// - 文字列はインライン文字列（共有文字列の表を作らない）。数値はそのまま数値のセルにする。
// - 書式は 4 つだけ: 既定・見出し（太字と地の色）・折り返し・表題（大きい太字）。
// - 見出しの行の固定・オートフィルタ・列の幅を付けられる。
// 表計算ソフトで式として解釈されないよう、セルはすべて値として書く（式の要素 <f> を使わない）。

export type XlsxCell = string | number | null;

export const XLSX_STYLE = { normal: 0, header: 1, wrap: 2, title: 3 } as const;
export type XlsxStyle = (typeof XLSX_STYLE)[keyof typeof XLSX_STYLE];

export interface XlsxRow {
  cells: readonly XlsxCell[];
  style?: XlsxStyle;
}

export interface XlsxSheet {
  /** シートの名前（31 文字まで。使えない文字は _ にする） */
  name: string;
  rows: readonly XlsxRow[];
  /** 列の幅（文字数） */
  widths?: readonly number[];
  /** この行（1 始まり）までを固定する */
  freezeRows?: number;
  /** この行（1 始まり）を見出しにしてオートフィルタを付ける */
  autoFilterRow?: number;
}

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// ZIP（stored）
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

export function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 無圧縮の ZIP を作る。名前は UTF-8（汎用ビット 11）。日時は 1980-01-01 に固定する（同じ中身なら同じバイト列） */
export function zipStored(files: ReadonlyArray<{ name: string; data: Uint8Array }>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = encoder.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    parts.push(local, f.data);

    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += local.length + f.data.length;
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

// ---------------------------------------------------------------------------
// SpreadsheetML
// ---------------------------------------------------------------------------

/** XML の本文に置けない制御文字を除き、特別な文字を実体参照にする */
function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 始まりの列番号 → 列記号（0 → A、26 → AA） */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Excel の 1 セルの上限（32,767 文字）を超える文字列は切る */
const MAX_CELL_CHARS = 32_767;

function cellXml(ref: string, value: XlsxCell, style: number): string {
  const s = style === 0 ? "" : ` s="${style}"`;
  if (value === null || value === "") return style === 0 ? "" : `<c r="${ref}"${s}/>`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `<c r="${ref}"${s} t="inlineStr"><is><t>${xmlText(String(value))}</t></is></c>`;
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  const text = value.length > MAX_CELL_CHARS ? value.slice(0, MAX_CELL_CHARS) : value;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
  ];
  if (sheet.freezeRows !== undefined && sheet.freezeRows > 0) {
    const top = `A${sheet.freezeRows + 1}`;
    out.push(
      `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRows}" topLeftCell="${top}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="${top}" sqref="${top}"/></sheetView></sheetViews>`,
    );
  }
  if (sheet.widths !== undefined && sheet.widths.length > 0) {
    out.push("<cols>");
    sheet.widths.forEach((w, i) => out.push(`<col min="${i + 1}" max="${i + 1}" width="${Math.max(4, Math.min(120, w))}" customWidth="1"/>`));
    out.push("</cols>");
  }
  out.push("<sheetData>");
  let maxCols = 0;
  sheet.rows.forEach((row, r) => {
    const style = row.style ?? 0;
    const cells = row.cells.map((v, c) => cellXml(`${columnLetter(c)}${r + 1}`, v, style)).join("");
    maxCols = Math.max(maxCols, row.cells.length);
    out.push(`<row r="${r + 1}">${cells}</row>`);
  });
  out.push("</sheetData>");
  if (sheet.autoFilterRow !== undefined && maxCols > 0 && sheet.rows.length >= sheet.autoFilterRow) {
    out.push(`<autoFilter ref="A${sheet.autoFilterRow}:${columnLetter(maxCols - 1)}${sheet.rows.length}"/>`);
  }
  out.push("</worksheet>");
  return out.join("");
}

/** シート名に使えない文字（: \ / ? * [ ]）を _ にし、31 文字に切り、重複には番号を付ける */
export function safeSheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    let base = raw.replace(/[:\\/?*[\]]/g, "_").replace(/^'+|'+$/g, "").trim() || "Sheet";
    base = base.slice(0, 31);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 31 - String(i).length - 1)}_${i}`;
    used.add(name.toLowerCase());
    return name;
  });
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE0E0E0"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="top"/></xf>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="top"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

/** ブックを xlsx のバイト列にする */
export function buildXlsx(sheets: readonly XlsxSheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error("A workbook needs at least one sheet");
  const names = safeSheetNames(sheets.map((s) => s.name));
  const files: Array<{ name: string; data: Uint8Array }> = [];
  const add = (name: string, xml: string) => files.push({ name, data: encoder.encode(xml) });

  add(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      "</Types>",
  );
  add(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>",
  );
  add(
    "xl/workbook.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      "<sheets>" +
      names.map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      "</sheets>" +
      (() => {
        const defs = sheets
          .map((s, i) => (s.autoFilterRow !== undefined && s.rows.length >= s.autoFilterRow ? { s, i } : null))
          .filter((x): x is { s: XlsxSheet; i: number } => x !== null)
          .map(({ s, i }) => {
            const cols = Math.max(1, ...s.rows.map((r) => r.cells.length));
            const quoted = `'${names[i]!.replace(/'/g, "''")}'`;
            return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlText(`${quoted}!$A$${s.autoFilterRow}:$${columnLetter(cols - 1)}$${s.rows.length}`)}</definedName>`;
          });
        return defs.length > 0 ? `<definedNames>${defs.join("")}</definedNames>` : "";
      })() +
      "</workbook>",
  );
  add(
    "xl/_rels/workbook.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      "</Relationships>",
  );
  add("xl/styles.xml", STYLES_XML);
  sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
  return zipStored(files);
}
