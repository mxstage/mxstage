// セル値の型検査・変換と、数値・日付の比較。

import type { CellValue, ColumnSchema } from "../../shared/model";

/** null と空文字（空白だけの文字列は含まない）を「値なし」とみなす */
export function isBlank(v: CellValue | undefined): boolean {
  return v === null || v === undefined || v === "";
}

/** セルの値が同じか。null と空文字は同じ「値なし」とみなす（Maximo では区別されず、差分に出さないため） */
export function sameCellValue(a: CellValue | undefined, b: CellValue | undefined): boolean {
  return a === b || (isBlank(a) && isBlank(b));
}

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** 数値、または数値として読める文字列を number にする。読めなければ null */
export function toNumber(v: CellValue | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!NUMBER_RE.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 日付: YYYY-MM-DD または ISO 8601 の日時（区切りは T のみ。オフセットは Z / ±HH / ±HHMM / ±HH:MM）
// ---------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

export interface ParsedDate {
  /** オフセットを無視した壁時計の時刻を固定長にした文字列（辞書順で比較できる） */
  wall: string;
  /** オフセット付きのときだけ UTC のミリ秒 */
  epochMs: number | null;
  hasTime: boolean;
}

// Date.UTC は年 0〜99 を 1900 年代に読み替えるので、閏年と UTC ミリ秒は自前で求める
function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function utcMillis(y: number, mo: number, d: number, hh: number, mi: number, ss: number, ms: number): number {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(hh, mi, ss, ms);
  return dt.getTime();
}

export function parseIsoDate(s: string): ParsedDate | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  const hasTime = m[4] !== undefined;
  const hh = hasTime ? Number(m[4]) : 0;
  const mi = hasTime ? Number(m[5]) : 0;
  const ss = m[6] !== undefined ? Number(m[6]) : 0;
  const frac = (m[7] ?? "").padEnd(9, "0");
  if (hh > 23 || mi > 59 || ss > 59) return null;
  const tz = m[8];
  let epochMs: number | null = null;
  if (tz !== undefined) {
    let offsetMin = 0;
    if (tz !== "Z") {
      const sign = tz.startsWith("-") ? -1 : 1;
      const digits = tz.slice(1).replace(":", "");
      const oh = Number(digits.slice(0, 2));
      const om = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
      if (oh > 23 || om > 59) return null;
      offsetMin = sign * (oh * 60 + om);
    }
    epochMs = utcMillis(y, mo, d, hh, mi, ss, Number(frac.slice(0, 3))) - offsetMin * 60_000;
  }
  const p2 = (n: number) => String(n).padStart(2, "0");
  const wall = `${m[1]}-${m[2]}-${m[3]}T${p2(hh)}:${p2(mi)}:${p2(ss)}.${frac}`;
  return { wall, epochMs, hasTime };
}

/**
 * 日付の大小。両方にオフセットがあれば UTC で比べ、そうでなければ壁時計の時刻で比べる。
 * Maximo はサーバのタイムゾーンで返すため、日付だけの条件（2024-04-01）と
 * オフセット付きの値（2024-04-01T00:00:00+09:00）を同じ日として扱えるようにする。
 */
export function compareParsedDates(a: ParsedDate, b: ParsedDate): number {
  if (a.epochMs !== null && b.epochMs !== null) {
    if (a.epochMs !== b.epochMs) return a.epochMs < b.epochMs ? -1 : 1;
    // 同じミリ秒ならミリ秒未満の桁（wall の末尾 6 桁）だけで比べる。
    // オフセットは分単位なので、オフセットが違っても秒未満の桁は同じ時刻を指す
    const sa = a.wall.slice(-6);
    const sb = b.wall.slice(-6);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  return a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 列の型に合わせた値の検査と変換
// ---------------------------------------------------------------------------

export type CoerceResult = { ok: true; value: CellValue } | { ok: false; message: string };

function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * 値を列の型に合わせる。
 * - null はどの型でも可（値を消す）。文字列以外の型では空文字・空白だけの文字列も null にする。
 * - string: 数値・真偽値は文字列にする。maxLength を超えたら不可。
 * - number / integer: 数値か数値の文字列。
 * - boolean: true/false、"true"/"false"（大小無視）、1/0、"1"/"0"。
 * - date / datetime: YYYY-MM-DD または ISO 8601。表記は変えずに保持する（タイムゾーンの解釈を持ち込まない）。
 */
export function coerceValue(col: ColumnSchema, v: CellValue): CoerceResult {
  if (v === null) return { ok: true, value: null };
  switch (col.type) {
    case "unknown":
      return { ok: true, value: v };
    case "string": {
      const s = typeof v === "string" ? v : String(v);
      if (col.maxLength !== undefined && codePointLength(s) > col.maxLength) {
        return { ok: false, message: `最大 ${col.maxLength} 文字です` };
      }
      return { ok: true, value: s };
    }
    default:
      break;
  }
  if (typeof v === "string" && v.trim() === "") return { ok: true, value: null };
  switch (col.type) {
    case "number": {
      const n = toNumber(v);
      return n === null || typeof v === "boolean" ? { ok: false, message: "数値ではありません" } : { ok: true, value: n };
    }
    case "integer": {
      const n = toNumber(v);
      if (n === null || typeof v === "boolean" || !Number.isSafeInteger(n)) return { ok: false, message: "整数ではありません" };
      return { ok: true, value: n };
    }
    case "boolean": {
      if (typeof v === "boolean") return { ok: true, value: v };
      const s = String(v).trim().toLowerCase();
      if (s === "true" || s === "1") return { ok: true, value: true };
      if (s === "false" || s === "0") return { ok: true, value: false };
      return { ok: false, message: "真偽値ではありません" };
    }
    case "date":
    case "datetime": {
      if (typeof v !== "string") return { ok: false, message: "日付は YYYY-MM-DD または ISO 8601 の文字列で指定してください" };
      const s = v.trim();
      if (parseIsoDate(s) === null) return { ok: false, message: "日付は YYYY-MM-DD または ISO 8601 の文字列で指定してください" };
      return { ok: true, value: s };
    }
  }
}
