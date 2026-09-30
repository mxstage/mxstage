// CSV・TSV を読む。
// - 文字コードは BOM を見て、無ければ UTF-8 として読めるか試し、読めなければ Shift_JIS（日本語の Excel が保存する CSV）にする。
// - 区切りはカンマ。拡張子が .tsv か、1 行目にタブがありカンマが無ければタブ。
// - 値は文字のまま（先頭の 0 や桁の多い番号を数値にして崩さない）。空は null。

import type { CellValue } from "../../shared/model";
import { IMPORT_MAX_COLUMNS, IMPORT_MAX_ROWS, ImportError, type ImportWorkbook, type RawRow, type RawTable } from "./table";

export interface DecodedText {
  text: string;
  encoding: "utf-8" | "shift_jis" | "utf-16le" | "utf-16be";
}

export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("shift_jis").decode(bytes), encoding: "shift_jis" };
  }
}

/** テキストでないファイル（先頭に NUL を含む）か */
export function looksBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 4096);
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return false;
  return head.includes(0);
}

export function pickDelimiter(text: string, fileName: string): "," | "\t" {
  if (/\.tsv$/i.test(fileName)) return "\t";
  const nl = text.search(/\r|\n/);
  const first = nl < 0 ? text : text.slice(0, nl);
  return first.includes("\t") && !first.includes(",") ? "\t" : ",";
}

export interface CsvLimits {
  maxRows: number;
  maxColumns: number;
}

/** RFC 4180 の CSV（引用符の中の区切り・改行、"" は " 1 つ）。レコードごとに値の配列を返す */
export function parseDelimited(text: string, delimiter: string, limits: CsvLimits = { maxRows: IMPORT_MAX_ROWS, maxColumns: IMPORT_MAX_COLUMNS }): RawTable {
  const table: RawTable = { name: "", hidden: false, rows: [], columnCount: 0, truncatedRows: false, truncatedColumns: false };
  let record = 0;
  let cells: CellValue[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    if (cells.length >= limits.maxColumns) table.truncatedColumns = true;
    else cells.push(field === "" ? null : field);
    field = "";
  };
  // 戻り値 false で読むのをやめる
  const endRecord = (): boolean => {
    endField();
    record++;
    const any = cells.some((v) => v !== null);
    if (any) {
      if (table.rows.length >= limits.maxRows) {
        table.truncatedRows = true;
        return false;
      }
      while (cells.length > 0 && cells[cells.length - 1] === null) cells.pop();
      const row: RawRow = { row: record, cells };
      table.rows.push(row);
      table.columnCount = Math.max(table.columnCount, cells.length);
    }
    cells = [];
    return true;
  };

  const delimCode = delimiter.charCodeAt(0);
  while (i < n) {
    if (quoted) {
      // 次の " までをまとめて足す（"" は " 1 つ、それ以外の " で引用が終わる）
      const q = text.indexOf('"', i);
      if (q < 0) {
        field += text.slice(i);
        i = n;
        continue;
      }
      field += text.slice(i, q);
      if (text[q + 1] === '"') {
        field += '"';
        i = q + 2;
      } else {
        quoted = false;
        i = q + 1;
      }
      continue;
    }
    const ch = text[i] as string;
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
    } else if (ch === delimiter) {
      endField();
      i++;
    } else if (ch === "\r" || ch === "\n") {
      if (!endRecord()) return table;
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      // 区切りか改行までをまとめて足す
      let j = i + 1;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c === delimCode || c === 13 || c === 10) break;
        j++;
      }
      field += text.slice(i, j);
      i = j;
    }
  }
  // 最後の行（改行で終わらないファイル）
  if (field !== "" || cells.length > 0) endRecord();
  return table;
}

export function parseCsv(bytes: Uint8Array, fileName: string, limits?: CsvLimits): ImportWorkbook {
  if (looksBinary(bytes)) throw new ImportError("This is not a text file. Provide an Excel (.xlsx) or CSV file.");
  const { text, encoding } = decodeText(bytes);
  const delimiter = pickDelimiter(text, fileName);
  const table = parseDelimited(text, delimiter, limits);
  table.name = fileName;
  if (table.rows.length === 0) throw new ImportError("The file has no values.");
  return { format: "csv", encoding, delimiter: delimiter === "\t" ? "tab" : "comma", tables: [table] };
}
