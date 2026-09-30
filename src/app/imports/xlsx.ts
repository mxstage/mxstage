// Excel（.xlsx / .xlsm）を読み、シートごとの値の表にする。
// - 数式のセルは Excel が保存した計算結果（キャッシュ）を使う。
// - 日付の書式のセルは "2024-05-01"（時刻があれば "2024-05-01T10:30:00"）の文字にする。時刻だけの書式は "10:30:00"。
// - 共有文字列のふりがな（rPh）は本文に含めない。
// - .xls（Excel 97-2003）・パスワード付き・.xlsb は読めないので、理由を添えてエラーにする。

import type { CellValue } from "../../shared/model";
import { readZipDirectory, readZipEntry, ZipError, type ZipEntry } from "./zip";
import { attrsOf, decodeXml, elementRe, NS, richText } from "./xml";
import { columnIndex, IMPORT_MAX_COLUMNS, IMPORT_MAX_ROWS, ImportError, type ImportWorkbook, type RawRow, type RawTable } from "./table";

/** XML 1 つを展開したときの上限 */
export const XLSX_MAX_PART_BYTES = 160 * 1024 * 1024;

export interface XlsxLimits {
  maxRows: number;
  maxColumns: number;
  maxPartBytes: number;
}

const DEFAULT_LIMITS: XlsxLimits = { maxRows: IMPORT_MAX_ROWS, maxColumns: IMPORT_MAX_COLUMNS, maxPartBytes: XLSX_MAX_PART_BYTES };

const REL_OFFICE_DOCUMENT = "/officeDocument";
const REL_WORKSHEET = "/worksheet";
const REL_SHARED_STRINGS = "/sharedStrings";
const REL_STYLES = "/styles";

interface Relationship {
  target: string;
  type: string;
}

type DateKind = "date" | "time" | "datetime";

class Package {
  private readonly byLower = new Map<string, ZipEntry>();

  constructor(
    private readonly bytes: Uint8Array,
    private readonly entries: Map<string, ZipEntry>,
    private readonly limits: XlsxLimits,
  ) {
    for (const [name, e] of entries) this.byLower.set(name.toLowerCase(), e);
  }

  has(path: string): boolean {
    return this.entry(path) !== undefined;
  }

  private entry(path: string): ZipEntry | undefined {
    return this.entries.get(path) ?? this.byLower.get(path.toLowerCase());
  }

  async text(path: string): Promise<string | null> {
    const e = this.entry(path);
    if (e === undefined) return null;
    const data = await readZipEntry(this.bytes, e, this.limits.maxPartBytes);
    const utf16 = data.length >= 2 && data[0] === 0xff && data[1] === 0xfe;
    return new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(data);
  }
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** 関係ファイルの Target を ZIP の中のパスにする（"/xl/..." は根から、それ以外は元の部品のフォルダから） */
function resolvePath(base: string, target: string): string {
  const joined = target.startsWith("/") ? target.slice(1) : base === "" ? target : `${base}/${target}`;
  const out: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

function relsPathOf(part: string): string {
  const dir = dirOf(part);
  const file = part.slice(dir === "" ? 0 : dir.length + 1);
  return `${dir === "" ? "" : `${dir}/`}_rels/${file}.rels`;
}

async function readRels(pkg: Package, part: string): Promise<Map<string, Relationship>> {
  const xml = await pkg.text(relsPathOf(part));
  const out = new Map<string, Relationship>();
  if (xml === null) return out;
  const base = dirOf(part);
  for (const m of xml.matchAll(elementRe("Relationship"))) {
    const a = attrsOf(m[1] ?? "");
    const id = a.get("Id");
    const target = a.get("Target");
    if (id === undefined || target === undefined || a.get("TargetMode") === "External") continue;
    out.set(id, { target: resolvePath(base, target), type: a.get("Type") ?? "" });
  }
  return out;
}

function relOfType(rels: Map<string, Relationship>, suffix: string): Relationship | undefined {
  for (const r of rels.values()) if (r.type.endsWith(suffix)) return r;
  return undefined;
}

// ---------------------------------------------------------------------------
// 書式（日付かどうか）
// ---------------------------------------------------------------------------

/** 組み込みの書式番号のうち日付・時刻のもの（27〜36・50〜58 は日本語の Excel の和暦・年月日） */
function builtinDateKind(id: number): DateKind | null {
  if ((id >= 14 && id <= 17) || (id >= 27 && id <= 31) || (id >= 34 && id <= 36) || (id >= 50 && id <= 58)) return "date";
  if ((id >= 18 && id <= 21) || (id >= 32 && id <= 33) || (id >= 45 && id <= 47)) return "time";
  if (id === 22) return "datetime";
  return null;
}

/** 利用者定義の書式が日付・時刻か。引用符の文字・色や地域の指定（[Red] [$-411]）・指数（E+）を除いて y m d h s を探す */
export function formatDateKind(code: string): DateKind | null {
  // 正・負・0 の区分は最初だけを見る
  let f = (code.toLowerCase().split(";")[0] ?? "").trim();
  if (f === "general" || f === "@") return null;
  f = f
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/_./g, "")
    .replace(/\*./g, "")
    .replace(/\[(h+|m+|s+)\]/g, "$1")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/e[+-]/g, "");
  const hasDate = /[yd]/.test(f) || /(^|[^a-z])g+|(^|[^a-z])e+(?![a-z])/.test(f);
  const hasTime = /[hs]/.test(f) || /am\/pm|a\/p/.test(f);
  // m は月か分。h・s が無ければ月とみなす
  const hasMonth = /m/.test(f) && !hasTime;
  if (hasDate || hasMonth) return hasTime ? "datetime" : "date";
  if (hasTime) return "time";
  return null;
}

async function readStyles(pkg: Package, path: string | undefined): Promise<Array<DateKind | null>> {
  const xml = path === undefined ? null : await pkg.text(path);
  if (xml === null) return [];
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(elementRe("numFmt"))) {
    const a = attrsOf(m[1] ?? "");
    const id = Number(a.get("numFmtId"));
    const code = a.get("formatCode");
    if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
  }
  const xfs = new RegExp(`<${NS}cellXfs\\b[^>]*>([\\s\\S]*?)</${NS}cellXfs>`).exec(xml)?.[1] ?? "";
  const out: Array<DateKind | null> = [];
  for (const m of xfs.matchAll(elementRe("xf"))) {
    const id = Number(attrsOf(m[1] ?? "").get("numFmtId") ?? "0");
    const code = custom.get(id);
    out.push(code !== undefined ? formatDateKind(code) : builtinDateKind(id));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 値
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** Excel の日付の通し番号 → 文字。1900 年方式は 1900-02-29 が存在する扱い（Excel の互換）なので 60 を境に起点をずらす */
export function serialToText(serial: number, kind: DateKind, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  const base = date1904 ? Date.UTC(1904, 0, 1) : serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const ms = base + Math.round(serial * 86_400) * 1000;
  const d = new Date(ms);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (kind === "time") return time;
  if (kind === "date" && ms % DAY_MS === 0) return date;
  return `${date}T${time}`;
}

/** 浮動小数の誤差（0.30000000000000004 など）を Excel と同じ 15 桁で丸める */
function roundNumber(n: number): number {
  return Number(n.toPrecision(15));
}

function isoFromXml(s: string): string {
  // t="d" のセル（ISO 8601）。日付だけ・秒まで・ミリ秒付きを受ける
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?))?/.exec(s);
  if (m === null) return s;
  if (m[2] === undefined || /^00:00(:00)?$/.test(m[2])) return m[1] as string;
  return `${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}`;
}

const V_RE = new RegExp(`<${NS}v\\b[^>]*>([\\s\\S]*?)</${NS}v>`);
const IS_RE = new RegExp(`<${NS}is\\b[^>]*>([\\s\\S]*?)</${NS}is>`);

interface CellContext {
  shared: readonly string[];
  styles: ReadonlyArray<DateKind | null>;
  date1904: boolean;
}

function cellValue(attrs: Map<string, string>, inner: string, ctx: CellContext): CellValue {
  const t = attrs.get("t") ?? "n";
  if (t === "inlineStr") {
    const is = IS_RE.exec(inner)?.[1];
    return is === undefined ? null : richText(is);
  }
  const raw = V_RE.exec(inner)?.[1];
  if (raw === undefined) return null;
  const v = decodeXml(raw);
  switch (t) {
    case "s":
      return ctx.shared[Number(v)] ?? null;
    case "str":
    case "e":
      return v;
    case "b":
      return v === "1" || v.toLowerCase() === "true";
    case "d":
      return isoFromXml(v);
    default: {
      const n = Number(v);
      if (v.trim() === "" || !Number.isFinite(n)) return v === "" ? null : v;
      const kind = ctx.styles[Number(attrs.get("s") ?? "0")] ?? null;
      if (kind !== null) return serialToText(n, kind, ctx.date1904) ?? roundNumber(n);
      return roundNumber(n);
    }
  }
}

const SHEET_DATA_RE = new RegExp(`<${NS}sheetData\\b[^>]*?(?:/>|>([\\s\\S]*)</${NS}sheetData>)`);
const ROW_RE = elementRe("row");
const CELL_RE = elementRe("c");
const REF_RE = /^([A-Za-z]{1,3})(\d+)$/;

function parseSheet(name: string, hidden: boolean, xml: string, ctx: CellContext, limits: XlsxLimits): RawTable {
  const table: RawTable = { name, hidden, rows: [], columnCount: 0, truncatedRows: false, truncatedColumns: false };
  const data = SHEET_DATA_RE.exec(xml)?.[1];
  if (data === undefined) return table;
  let prevRow = 0;
  for (const rm of data.matchAll(ROW_RE)) {
    const ra = attrsOf(rm[1] ?? "");
    const rowNo = Number(ra.get("r") ?? prevRow + 1);
    prevRow = Number.isInteger(rowNo) && rowNo > 0 ? rowNo : prevRow + 1;
    const content = rm[2];
    if (content === undefined || content === "") continue;
    const cells: CellValue[] = [];
    let prevCol = -1;
    let any = false;
    for (const cm of content.matchAll(CELL_RE)) {
      const ca = attrsOf(cm[1] ?? "");
      const ref = REF_RE.exec(ca.get("r") ?? "");
      const col = ref === null ? prevCol + 1 : columnIndex(ref[1] as string);
      prevCol = col;
      if (col < 0) continue;
      const v = cellValue(ca, cm[2] ?? "", ctx);
      if (v === null || v === "") continue;
      if (col >= limits.maxColumns) {
        table.truncatedColumns = true;
        continue;
      }
      while (cells.length < col) cells.push(null);
      cells[col] = v;
      any = true;
    }
    if (!any) continue;
    if (table.rows.length >= limits.maxRows) {
      table.truncatedRows = true;
      break;
    }
    const row: RawRow = { row: prevRow, cells };
    table.rows.push(row);
    table.columnCount = Math.max(table.columnCount, cells.length);
  }
  // 行の順（r が前後するファイルに備える）
  table.rows.sort((a, b) => a.row - b.row);
  return table;
}

// ---------------------------------------------------------------------------
// 全体
// ---------------------------------------------------------------------------

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0];

export function isOleFile(bytes: Uint8Array): boolean {
  return OLE_SIGNATURE.every((b, i) => bytes[i] === b);
}

export function isZipFile(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05) && (bytes[3] === 0x04 || bytes[3] === 0x06);
}

export async function parseXlsx(bytes: Uint8Array, limits: Partial<XlsxLimits> = {}): Promise<ImportWorkbook> {
  const lim: XlsxLimits = { ...DEFAULT_LIMITS, ...limits };
  if (isOleFile(bytes)) {
    throw new ImportError("This is an Excel 97-2003 (.xls) or password-protected file. Save it as .xlsx in Excel or remove the password, then provide it again.");
  }
  let pkg: Package;
  try {
    pkg = new Package(bytes, readZipDirectory(bytes), lim);
  } catch (e) {
    throw new ImportError(e instanceof ZipError ? `Cannot read it as an Excel file: ${e.message}` : "Cannot read it as an Excel file");
  }
  try {
    const rootRels = await readRels(pkg, "");
    const workbookPath = relOfType(rootRels, REL_OFFICE_DOCUMENT)?.target ?? "xl/workbook.xml";
    if (/\.bin$/i.test(workbookPath) || pkg.has("xl/workbook.bin")) {
      throw new ImportError("Excel binary files (.xlsb) cannot be read. Save it as .xlsx in Excel, then provide it again.");
    }
    const workbook = await pkg.text(workbookPath);
    if (workbook === null) throw new ImportError("The Excel workbook definition (workbook.xml) is missing. Check that it is an .xlsx file.");
    const rels = await readRels(pkg, workbookPath);
    const date1904 = /<(?:[A-Za-z_][\w.-]*:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](1|true)["']/.test(workbook);
    const sharedPath = relOfType(rels, REL_SHARED_STRINGS)?.target;
    const sharedXml = sharedPath === undefined ? null : await pkg.text(sharedPath);
    const shared: string[] = [];
    if (sharedXml !== null) for (const m of sharedXml.matchAll(elementRe("si"))) shared.push(richText(m[2] ?? ""));
    const styles = await readStyles(pkg, relOfType(rels, REL_STYLES)?.target);
    const ctx: CellContext = { shared, styles, date1904 };

    const tables: RawTable[] = [];
    for (const m of workbook.matchAll(elementRe("sheet"))) {
      const a = attrsOf(m[1] ?? "");
      const name = a.get("name") ?? `Sheet${tables.length + 1}`;
      const rel = rels.get(a.get("id") ?? "");
      // グラフだけのシート・ダイアログのシートなどは値の表ではないので読まない
      if (rel === undefined || !rel.type.endsWith(REL_WORKSHEET)) continue;
      const xml = await pkg.text(rel.target);
      if (xml === null) continue;
      const state = a.get("state");
      tables.push(parseSheet(name, state === "hidden" || state === "veryHidden", xml, ctx, lim));
    }
    if (tables.length === 0) throw new ImportError("The Excel file has no sheet with values.");
    return { format: "xlsx", tables };
  } catch (e) {
    if (e instanceof ImportError) throw e;
    if (e instanceof ZipError) throw new ImportError(`Cannot read it as an Excel file: ${e.message}`);
    throw e;
  }
}
