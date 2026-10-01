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
// 日付の入力: Maximo の利用者がふだん使う書き方を受け付け、Maximo の JSON API が受け取る ISO 8601 にそろえる
//   2026-10-01 / 2026/10/01 / 2026/1/5（年・月・日の順。区切りは - か / のどちらかにそろえる）
//   時刻は T か空白で続ける: 2026/10/01 9:00 / 2026-10-01 09:00:30 / 2026-10-01T09:00:00.123+09:00
//   オフセット（Z / ±HH / ±HHMM / ±HH:MM）は時刻があるときだけ書ける
// ---------------------------------------------------------------------------

const DATE_INPUT_RE =
  /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:(?:T|\s+)(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

export interface DateParts {
  y: number;
  mo: number;
  d: number;
  hh: number;
  mi: number;
  ss: number;
  /** 秒未満の桁（書かれたまま。無ければ空） */
  frac: string;
  hasTime: boolean;
  /** オフセット（"Z" か "±HH:MM" にそろえたもの）。書かれていなければ null */
  tz: string | null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad4 = (n: number) => String(n).padStart(4, "0");

/** オフセットの表記を "Z" か "±HH:MM" にそろえる。範囲外なら null */
function normalizeOffset(tz: string): string | null {
  if (tz.toUpperCase() === "Z") return "Z";
  const sign = tz[0];
  const digits = tz.slice(1).replace(":", "");
  const oh = Number(digits.slice(0, 2));
  const om = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
  if (oh > 23 || om > 59) return null;
  return `${sign}${pad2(oh)}:${pad2(om)}`;
}

/** 利用者が書いた日付・日時を読む（上の書き方）。読めない・ありえない日付なら null */
export function parseDateInput(text: string): DateParts | null {
  const m = DATE_INPUT_RE.exec(text.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[3]);
  const d = Number(m[4]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  const hasTime = m[5] !== undefined;
  const hh = hasTime ? Number(m[5]) : 0;
  const mi = hasTime ? Number(m[6]) : 0;
  const ss = m[7] !== undefined ? Number(m[7]) : 0;
  if (hh > 23 || mi > 59 || ss > 59) return null;
  let tz: string | null = null;
  if (m[9] !== undefined) {
    tz = normalizeOffset(m[9]);
    if (tz === null) return null;
  }
  return { y, mo, d, hh, mi, ss, frac: m[8] ?? "", hasTime, tz };
}

/** その日時のブラウザのオフセット（夏時間を含めてその時点のもの）。"±HH:MM" */
export function browserOffset(p: Pick<DateParts, "y" | "mo" | "d" | "hh" | "mi">): string {
  const dt = new Date(2000, 0, 1, 0, 0, 0, 0);
  // new Date(y, ...) は年 0〜99 を 1900 年代に読み替えるので setFullYear で決める
  dt.setFullYear(p.y, p.mo - 1, p.d);
  dt.setHours(p.hh, p.mi, 0, 0);
  const off = -dt.getTimezoneOffset();
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * 時刻にオフセットが書かれていないときに付けるオフセット。
 * - 文字列: そのオフセットを付ける（セルの元の値、または同じ列の Maximo の値のオフセット。Maximo はサーバのタイムゾーンで返す）
 * - null: 付けない（参考にした値にもオフセットが無い。Excel から読んだシートなど）
 * - undefined: ブラウザのタイムゾーンのその日時のオフセットを付ける
 */
export type DateOffsetHint = string | null | undefined;

/** ISO 8601 の日付・日時の文字列にする（オフセットが無ければ hint に従って付ける） */
export function formatIsoDate(p: DateParts, hint: DateOffsetHint): string {
  const date = `${pad4(p.y)}-${pad2(p.mo)}-${pad2(p.d)}`;
  if (!p.hasTime) return date;
  const time = `${pad2(p.hh)}:${pad2(p.mi)}:${pad2(p.ss)}${p.frac !== "" ? `.${p.frac}` : ""}`;
  const tz = p.tz ?? (hint === undefined ? browserOffset(p) : hint);
  return `${date}T${time}${tz ?? ""}`;
}

/**
 * 値を Maximo に送る ISO 8601 にそろえる。読めなければ null。
 * - 日付だけ: YYYY-MM-DD（2026/1/5 → 2026-01-05）
 * - オフセット付きの ISO 8601: 書かれたまま（LLM・利用者が選んだオフセットを変えない）
 * - それ以外の日時: YYYY-MM-DDTHH:mm:ss（秒未満は書かれたとき）に、オフセットを付ける（DateOffsetHint）
 */
export function normalizeDateInput(text: string, hint: DateOffsetHint): string | null {
  const s = text.trim();
  const p = parseDateInput(s);
  if (p === null) return null;
  if (p.hasTime && p.tz !== null && parseIsoDate(s) !== null) return s;
  return formatIsoDate(p, hint);
}

/** 値のオフセット（参考にする値から、付けるオフセットを決めるため）。時刻の無い値・読めない値は undefined */
export function offsetOfValue(v: CellValue | undefined): string | null | undefined {
  if (typeof v !== "string") return undefined;
  const p = parseDateInput(v);
  if (p === null || !p.hasTime) return undefined;
  return p.tz;
}

/**
 * 画面に出す日付の形（作業画面の表示だけ。値は変えない）。オフセットは出さず、値のオフセットの壁時計の時刻で出す
 * （Maximo はサーバのタイムゾーンで返すので、Maximo の画面と同じ時刻になる）。
 * - 日付だけ、または日付の列で 0:00 のもの: 2026-10-01
 * - 日時: 2026-10-01 09:00（秒・秒未満が 0 でなければ 09:00:30 / 09:00:30.5）
 * 読めない値は文字列にして返す。
 */
export function formatDateForDisplay(type: "date" | "datetime", v: CellValue): string {
  if (v === null) return "";
  if (typeof v !== "string") return String(v);
  const p = parseDateInput(v);
  if (p === null) return v;
  const date = `${pad4(p.y)}-${pad2(p.mo)}-${pad2(p.d)}`;
  const fracZero = /^0*$/.test(p.frac);
  if (!p.hasTime || (type === "date" && p.hh === 0 && p.mi === 0 && p.ss === 0 && fracZero)) return date;
  let time = `${pad2(p.hh)}:${pad2(p.mi)}`;
  if (p.ss !== 0 || !fracZero) time += `:${pad2(p.ss)}`;
  if (!fracZero) time += `.${p.frac.replace(/0+$/, "")}`;
  return `${date} ${time}`;
}

// ---------------------------------------------------------------------------
// 列の型に合わせた値の検査と変換
// ---------------------------------------------------------------------------

export type CoerceResult = { ok: true; value: CellValue } | { ok: false; message: string };

export interface CoerceOptions {
  /** 日時にオフセットが書かれていないときに付けるオフセット（DateOffsetHint）。省略時はブラウザのタイムゾーン */
  dateOffset?: DateOffsetHint;
}

/** 日付の書き方の案内（LLM にも返すので英語だけ） */
export const DATE_FORMAT_MESSAGE = "Give dates as YYYY-MM-DD, YYYY/MM/DD or ISO 8601 (a time may follow: YYYY/MM/DD HH:mm[:ss])";

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
 * - date / datetime: YYYY-MM-DD・YYYY/MM/DD・ISO 8601（時刻は HH:mm[:ss]、T か空白で続ける）。
 *   ISO 8601 にそろえる（normalizeDateInput）。オフセット付きの ISO 8601 は書かれたまま保持する。
 *   オフセットの無い時刻には opts.dateOffset のオフセットを付ける（省略時はブラウザのタイムゾーン）。
 */
export function coerceValue(col: ColumnSchema, v: CellValue, opts: CoerceOptions = {}): CoerceResult {
  if (v === null) return { ok: true, value: null };
  switch (col.type) {
    case "unknown":
      return { ok: true, value: v };
    case "string": {
      const s = typeof v === "string" ? v : String(v);
      if (col.maxLength !== undefined && codePointLength(s) > col.maxLength) {
        return { ok: false, message: `At most ${col.maxLength} characters` };
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
      return n === null || typeof v === "boolean" ? { ok: false, message: "Not a number" } : { ok: true, value: n };
    }
    case "integer": {
      const n = toNumber(v);
      if (n === null || typeof v === "boolean" || !Number.isSafeInteger(n)) return { ok: false, message: "Not an integer" };
      return { ok: true, value: n };
    }
    case "boolean": {
      if (typeof v === "boolean") return { ok: true, value: v };
      const s = String(v).trim().toLowerCase();
      if (s === "true" || s === "1") return { ok: true, value: true };
      if (s === "false" || s === "0") return { ok: true, value: false };
      return { ok: false, message: "Not a boolean" };
    }
    case "date":
    case "datetime": {
      if (typeof v !== "string") return { ok: false, message: DATE_FORMAT_MESSAGE };
      const s = normalizeDateInput(v, opts.dateOffset);
      if (s === null) return { ok: false, message: DATE_FORMAT_MESSAGE };
      return { ok: true, value: s };
    }
  }
}
