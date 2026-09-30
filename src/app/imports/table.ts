// 取り込んだファイル（Excel のシート・CSV）の中間の形と、見出しの見当・列の組み立て・作業画面のシートへの変換。
// ファイルの形式に依らない部分をここに置く（読み取りは xlsx.ts・csv.ts）。

import type { CellValue, ColumnSchema, ColumnType, SheetSource } from "../../shared/model";
import type { SheetMeta, SheetRow } from "../../shared/sheet";

/** 1 行。cells[i] は i 列目（0 始まり。A 列 = 0）。値の無いセルは null */
export interface RawRow {
  /** 元のファイルの行番号（1 始まり。Excel の行番号、CSV のレコード番号） */
  row: number;
  cells: CellValue[];
}

export interface RawTable {
  /** Excel のシート名（CSV はファイル名） */
  name: string;
  /** Excel で非表示のシート */
  hidden: boolean;
  /** 値のある行だけ（行番号の順） */
  rows: RawRow[];
  columnCount: number;
  /** 行数の上限で打ち切った */
  truncatedRows: boolean;
  /** 列数の上限で打ち切った */
  truncatedColumns: boolean;
}

export interface ImportWorkbook {
  format: "xlsx" | "csv";
  /** CSV の文字コード（utf-8 / shift_jis / utf-16le / utf-16be） */
  encoding?: string;
  /** CSV の区切り文字 */
  delimiter?: string;
  tables: RawTable[];
}

/** 1 シートの行数の上限。超えた分は読まない（作業画面のメモリを守る） */
export const IMPORT_MAX_ROWS = 200_000;
/** 列数の上限 */
export const IMPORT_MAX_COLUMNS = 500;
/** 見出しの候補を探す範囲（先頭から、値のある行の数） */
const HEADER_SCAN_ROWS = 30;

/** 元のファイルの行番号を入れる列（rowKey も同じ番号） */
export const SOURCE_ROW_COLUMN = "SOURCE_ROW";
const SOURCE_ROW_TITLE = "元の行";

export class ImportError extends Error {}

/** 0 始まりの列番号 → Excel の列記号（0 → A、26 → AA） */
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

/** Excel の列記号 → 0 始まりの列番号（A → 0）。記号でなければ -1 */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) return -1;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function isBlank(v: CellValue | undefined): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/** 見出しのセルの文字（空白・改行をまとめて 1 つの空白にする） */
export function headerText(v: CellValue | undefined): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\s+/g, " ").trim();
}

function rowAt(t: RawTable, row: number): RawRow | undefined {
  // rows は行番号の順。見出しは先頭近くにあるので前から探す
  for (const r of t.rows) {
    if (r.row === row) return r;
    if (r.row > row) return undefined;
  }
  return undefined;
}

export interface HeaderCandidate {
  row: number;
  /** 見出しに見える（数値でない、行の中で重ならない）文字のセルの数 */
  textCells: number;
  cells: string[];
}

/**
 * 見出しの行の候補。文字のセル（数値・日付に見えず、行の中で重ならないもの）を数え、
 * 最も多い行の 8 割以上ある行を上から並べ、残りを多い順に続ける。
 * データの行も文字が多いことがあるので「最も多い行」ではなく「十分に多い最初の行」を先頭にする
 * （表題の行・2 段見出しの上の段は文字が少ないので外れる）。
 */
export function headerCandidates(t: RawTable, max = 3): HeaderCandidate[] {
  const scan = t.rows.slice(0, HEADER_SCAN_ROWS);
  const found: HeaderCandidate[] = [];
  for (let i = 0; i < scan.length; i++) {
    const r = scan[i] as RawRow;
    // 下にデータの行が無い行は見出しにならない
    if (i === t.rows.length - 1) continue;
    const seen = new Set<string>();
    let textCells = 0;
    for (const v of r.cells) {
      if (typeof v !== "string") continue;
      const s = headerText(v);
      if (s === "" || /^[-+]?[\d,]+(\.\d+)?$/.test(s) || /^\d{4}-\d{2}-\d{2}(T[\d:]+)?$/.test(s) || seen.has(s)) continue;
      seen.add(s);
      textCells++;
    }
    if (textCells === 0) continue;
    found.push({ row: r.row, textCells, cells: r.cells.map(headerText) });
  }
  const most = Math.max(0, ...found.map((c) => c.textCells));
  const enough = found.filter((c) => c.textCells >= most * 0.8);
  const rest = found.filter((c) => c.textCells < most * 0.8).sort((a, b) => b.textCells - a.textCells || a.row - b.row);
  return [...enough, ...rest].slice(0, max);
}

/** MXLoader の読み書きに使う処理の名前（1 行目の 2 つ目のセル） */
const MXLOADER_ACTIONS = new Set(["SYNC", "ADDCHANGE", "CREATE", "UPDATE", "CHANGE", "REPLACE", "DELETE", "QUERY"]);

export interface MxLoaderInfo {
  objectStructure: string;
  action: string;
  headerRow: number;
}

/** MXLoader 形式（1 行目にオブジェクト構造と処理、2 行目に属性名）かどうか */
export function detectMxLoader(t: RawTable): MxLoaderInfo | null {
  const first = t.rows[0];
  if (first === undefined || first.row !== 1) return null;
  const os = headerText(first.cells[0]);
  const action = headerText(first.cells[1]);
  if (!/^[A-Z][A-Z0-9_]{2,}$/.test(os) || !MXLOADER_ACTIONS.has(action.toUpperCase())) return null;
  const header = rowAt(t, 2);
  if (header === undefined) return null;
  const names = header.cells.map(headerText).filter((s) => s !== "");
  if (names.length === 0 || !names.every((s) => /^[A-Za-z][A-Za-z0-9_.]*$/.test(s))) return null;
  return { objectStructure: os, action, headerRow: 2 };
}

/** 見出しの行の見当。MXLoader 形式なら 2 行目、それ以外は候補の先頭 */
export function suggestedHeaderRow(t: RawTable): number | null {
  const mx = detectMxLoader(t);
  if (mx !== null) return mx.headerRow;
  return headerCandidates(t, 1)[0]?.row ?? null;
}

export interface ImportColumn {
  /** 0 始まりの列番号 */
  index: number;
  letter: string;
  /** 見出しのセルの文字（空白をまとめたもの） */
  header: string;
  /** シートでの列名（見出し。空なら「列C」、重なれば「備考_F」） */
  name: string;
  type: ColumnType;
  /** 値のある行の数 */
  filled: number;
}

function inferType(values: readonly CellValue[]): ColumnType {
  let kind: ColumnType | null = null;
  let allInteger = true;
  for (const v of values) {
    let k: ColumnType;
    if (typeof v === "number") {
      k = "number";
      if (!Number.isInteger(v)) allInteger = false;
    } else if (typeof v === "boolean") k = "boolean";
    else if (/^\d{4}-\d{2}-\d{2}$/.test(v as string)) k = "date";
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v as string)) k = "datetime";
    else k = "string";
    if (kind === null) kind = k;
    else if (kind !== k) {
      // 日付と日時が混ざれば日時、それ以外が混ざれば文字
      if ((kind === "date" && k === "datetime") || (kind === "datetime" && k === "date")) kind = "datetime";
      else return "string";
    }
  }
  if (kind === null) return "string";
  if (kind === "number" && allInteger) return "integer";
  return kind;
}

/** 見出しの行より下の、値のある行 */
export function dataRows(t: RawTable, headerRow: number): RawRow[] {
  return t.rows.filter((r) => r.row > headerRow && r.cells.some((v) => !isBlank(v)));
}

/** 見出しの行から列を組み立てる。見出しも値も無い列は除く */
export function importColumns(t: RawTable, headerRow: number): ImportColumn[] {
  const header = rowAt(t, headerRow);
  const rows = dataRows(t, headerRow);
  const used = new Set<string>([SOURCE_ROW_COLUMN]);
  const out: ImportColumn[] = [];
  for (let i = 0; i < t.columnCount; i++) {
    const h = headerText(header?.cells[i]);
    const values: CellValue[] = [];
    for (const r of rows) {
      const v = r.cells[i];
      if (!isBlank(v)) values.push(v as CellValue);
    }
    if (h === "" && values.length === 0) continue;
    const letter = columnLetter(i);
    let name = h === "" ? `列${letter}` : h;
    if (name === "__proto__" || used.has(name)) name = `${name}_${letter}`;
    for (let n = 2; used.has(name); n++) name = `${h === "" ? `列${letter}` : h}_${letter}_${n}`;
    used.add(name);
    out.push({ index: i, letter, header: h, name, type: inferType(values), filled: values.length });
  }
  return out;
}

/** 型が文字の列に混ざった数値・真偽値は文字にそろえる（突合と絞り込みで型の違いに悩まない） */
function cellFor(v: CellValue | undefined, type: ColumnType): CellValue {
  if (isBlank(v)) return null;
  if (type === "string" && typeof v !== "string") return typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
  return v as CellValue;
}

export interface BuildImportOptions {
  name: string;
  headerRow: number;
  source: Extract<SheetSource, { kind: "excel" }>;
  /** 列名 → 新しい列名 */
  rename?: Readonly<Record<string, string>>;
  keyColumns?: readonly string[];
}

export interface BuiltImport {
  meta: SheetMeta;
  rows: SheetRow[];
  columns: ImportColumn[];
  /** 見出しより下で、値の無かった行の数（シートに入れていない） */
  skippedEmptyRows: number;
}

/** 取り込んだ表を作業画面のシートにする。rowKey は元の行番号（SOURCE_ROW 列にも入れる） */
export function buildImportSheet(t: RawTable, opts: BuildImportOptions): BuiltImport {
  const header = rowAt(t, opts.headerRow);
  if (header === undefined) {
    const candidates = headerCandidates(t).map((c) => c.row);
    throw new ImportError(`Row ${opts.headerRow} has no values. Likely header rows: ${candidates.join(", ") || "none"}`);
  }
  const columns = importColumns(t, opts.headerRow);
  if (columns.length === 0) throw new ImportError(`There are no columns under row ${opts.headerRow}`);

  const rename = opts.rename ?? {};
  const byName = new Map(columns.map((c) => [c.name, c]));
  for (const from of Object.keys(rename)) {
    if (!byName.has(from)) throw new ImportError(`${from} in rename is not a column`);
  }
  const finalName = (c: ImportColumn): string => {
    const to = rename[c.name];
    return to === undefined ? c.name : to.trim();
  };
  const names = new Set<string>([SOURCE_ROW_COLUMN]);
  const schema: ColumnSchema[] = [{ name: SOURCE_ROW_COLUMN, title: SOURCE_ROW_TITLE, type: "integer", readOnly: true }];
  for (const c of columns) {
    const name = finalName(c);
    if (name === "" || name === "__proto__") throw new ImportError(`${c.name} → ${JSON.stringify(name)} in rename cannot be used as a column name`);
    if (names.has(name)) throw new ImportError(`Column name ${name} is used twice (check rename)`);
    names.add(name);
    const col: ColumnSchema = { name, type: c.type };
    // 名前を変えた列は、元の見出しを画面表示名に残す（作業画面の見出しは 2 段で両方を出す）
    if (name !== c.name && c.header !== "") col.title = c.header;
    schema.push(col);
  }
  const keyColumns = opts.keyColumns !== undefined && opts.keyColumns.length > 0 ? [...opts.keyColumns] : [SOURCE_ROW_COLUMN];
  for (const k of keyColumns) {
    if (!names.has(k)) throw new ImportError(`Key column ${k} is not a column (use the names after rename)`);
  }

  const rows: SheetRow[] = [];
  let skippedEmptyRows = 0;
  for (const r of t.rows) {
    if (r.row <= opts.headerRow) continue;
    const values: Record<string, CellValue> = { [SOURCE_ROW_COLUMN]: r.row };
    let any = false;
    columns.forEach((c, i) => {
      const v = cellFor(r.cells[c.index], c.type);
      if (v !== null) any = true;
      values[(schema[i + 1] as ColumnSchema).name] = v;
    });
    if (!any) {
      skippedEmptyRows++;
      continue;
    }
    const rowKey = String(r.row);
    rows.push({ rowKey, parentKey: rowKey, childName: null, values });
  }
  const meta: SheetMeta = { name: opts.name, source: opts.source, columns: schema, keyColumns, childIdAttrs: {} };
  return { meta, rows, columns, skippedEmptyRows };
}
