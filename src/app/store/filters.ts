// TypedFilter をシートの行に対する述語にする。複数の条件は AND で結ぶ。

import type { CellValue, TypedFilter } from "../../shared/model";
import { StoreError } from "./errors";
import { compareParsedDates, isBlank, parseIsoDate, toNumber } from "./values";

export type RowGetter = (col: string) => CellValue;
export type RowPredicate = (get: RowGetter) => boolean;

/**
 * eq の比較。
 * - 条件値が null / 空文字なら「値なし」（null と空文字）に一致する。
 * - どちらかが数値なら、両方を数値として読めるときだけ数値で比べる。
 * - 真偽値は文字列にして大文字小文字を無視して比べる（true と "TRUE" は一致）。
 * - 文字列どうしは完全一致（前後の空白も区別する）。
 */
export function valuesEqual(cell: CellValue, target: CellValue): boolean {
  if (isBlank(target)) return isBlank(cell);
  if (isBlank(cell)) return false;
  if (typeof cell === "number" || typeof target === "number") {
    const a = toNumber(cell);
    const b = toNumber(target);
    return a !== null && b !== null && a === b;
  }
  if (typeof cell === "boolean" || typeof target === "boolean") {
    return String(cell).trim().toLowerCase() === String(target).trim().toLowerCase();
  }
  return cell === target;
}

/** 大小比較。数値どうし、または日付文字列どうしのときだけ比べられる。比べられなければ null */
export function compareValues(cell: CellValue, target: CellValue): number | null {
  if (isBlank(cell) || isBlank(target) || typeof cell === "boolean" || typeof target === "boolean") return null;
  const a = toNumber(cell);
  const b = toNumber(target);
  if (a !== null && b !== null) return a === b ? 0 : a < b ? -1 : 1;
  if (typeof cell === "string" && typeof target === "string") {
    const da = parseIsoDate(cell.trim());
    const db = parseIsoDate(target.trim());
    if (da && db) return compareParsedDates(da, db);
  }
  return null;
}

/** in / notin の述語。条件値ごとに valuesEqual を呼ぶと「条件値の数 × 行数」になるため、型ごとの集合で引く（結果は valuesEqual と同じ） */
export function inListMatcher(list: readonly CellValue[]): (cell: CellValue) => boolean {
  let hasBlank = false;
  const numbers = new Set<number>(); // 数値の条件値
  const numbersOfStrings = new Set<number>(); // 数値として読める文字列の条件値
  const strings = new Set<string>(); // 文字列の条件値（完全一致）
  const lowerStrings = new Set<string>(); // 文字列の条件値を trim・小文字にしたもの（真偽値のセルと比べる）
  const booleans = new Set<string>(); // 真偽値の条件値（"true" / "false"）
  for (const t of list) {
    if (isBlank(t)) {
      hasBlank = true;
    } else if (typeof t === "number") {
      const n = toNumber(t);
      if (n !== null) numbers.add(n);
    } else if (typeof t === "boolean") {
      booleans.add(String(t));
    } else if (typeof t === "string") {
      strings.add(t);
      lowerStrings.add(t.trim().toLowerCase());
      const n = toNumber(t);
      if (n !== null) numbersOfStrings.add(n);
    }
  }
  return (cell) => {
    if (cell === null || cell === "") return hasBlank;
    if (typeof cell === "number") {
      const n = toNumber(cell);
      return n !== null && (numbers.has(n) || numbersOfStrings.has(n));
    }
    if (typeof cell === "boolean") return lowerStrings.has(String(cell)) || booleans.has(String(cell));
    if (strings.has(cell)) return true;
    const n = numbers.size > 0 ? toNumber(cell) : null;
    return (n !== null && numbers.has(n)) || (booleans.size > 0 && booleans.has(cell.trim().toLowerCase()));
  };
}

/**
 * like（% が 0 文字以上の任意の文字列、大文字小文字無視）の述語。
 * 正規表現にすると % の多いパターンで指数的な後戻りが起きてタブが固まるため、
 * 先頭・末尾の固定部分の一致と、途中の固定部分の左から順の indexOf で判定する（文字列長 × パターン長で終わる）。
 * パターン中の記号（. \ ( [ など）はすべて文字そのものとして扱う。
 */
export function likeMatcher(pattern: string): (text: string) => boolean {
  const parts = pattern.toLowerCase().split("%");
  if (parts.length === 1) {
    const exact = parts[0] ?? "";
    return (text) => text.toLowerCase() === exact;
  }
  const head = parts[0] ?? "";
  const tail = parts[parts.length - 1] ?? "";
  const middle = parts.slice(1, -1).filter((p) => p !== "");
  return (raw) => {
    const text = raw.toLowerCase();
    if (text.length < head.length + tail.length || !text.startsWith(head) || !text.endsWith(tail)) return false;
    let pos = head.length;
    const end = text.length - tail.length;
    for (const p of middle) {
      const i = text.indexOf(p, pos);
      if (i < 0 || i + p.length > end) return false;
      pos = i + p.length;
    }
    return true;
  };
}

function describe(f: TypedFilter): string {
  return `${f.attr} ${f.op}`;
}

function scalarValue(f: TypedFilter): CellValue {
  if (f.value === undefined || Array.isArray(f.value)) {
    throw new StoreError("invalid_filter", `Give exactly one value for the condition ${describe(f)}`, { attr: f.attr, op: f.op });
  }
  return f.value;
}

function compileOne(f: TypedFilter): RowPredicate {
  const col = f.attr;
  switch (f.op) {
    case "eq": {
      const v = scalarValue(f);
      return (get) => valuesEqual(get(col), v);
    }
    case "ne": {
      const v = scalarValue(f);
      return (get) => !valuesEqual(get(col), v);
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const v = scalarValue(f);
      if (isBlank(v) || typeof v === "boolean") {
        throw new StoreError("invalid_filter", `The value of the condition ${describe(f)} must be a number or a date`, { attr: f.attr, op: f.op });
      }
      const op = f.op;
      return (get) => {
        const c = compareValues(get(col), v);
        if (c === null) return false;
        switch (op) {
          case "gt":
            return c > 0;
          case "gte":
            return c >= 0;
          case "lt":
            return c < 0;
          default:
            return c <= 0;
        }
      };
    }
    case "in":
    case "notin": {
      if (!Array.isArray(f.value)) {
        throw new StoreError("invalid_filter", `The value of the condition ${describe(f)} must be an array`, { attr: f.attr, op: f.op });
      }
      const hit = inListMatcher(f.value);
      const negate = f.op === "notin";
      return (get) => (negate ? !hit(get(col)) : hit(get(col)));
    }
    case "like": {
      const v = scalarValue(f);
      if (v === null || typeof v === "boolean") {
        throw new StoreError("invalid_filter", `The value of the condition ${describe(f)} must be a string`, { attr: f.attr, op: f.op });
      }
      const match = likeMatcher(String(v));
      return (get) => {
        const cell = get(col);
        return match(cell === null ? "" : String(cell));
      };
    }
    case "isnull":
      return (get) => isBlank(get(col));
    case "notnull":
      return (get) => !isBlank(get(col));
    default: {
      const op: never = f.op;
      throw new StoreError("invalid_filter", `Unsupported operator: ${String(op)}`);
    }
  }
}

/**
 * 条件を述語にする。存在しない列は StoreError(column_not_found)、値の形が合わなければ StoreError(invalid_filter)。
 * 行ごとではなく呼び出し時に検査するので、行が 0 件でも誤りを返せる。
 */
export function compileFilters(filters: readonly TypedFilter[], hasColumn: (col: string) => boolean): RowPredicate {
  const preds = filters.map((f) => {
    if (!hasColumn(f.attr)) {
      throw new StoreError("column_not_found", `Column ${f.attr} is not in this sheet`, { column: f.attr });
    }
    return compileOne(f);
  });
  if (preds.length === 0) return () => true;
  return (get) => preds.every((p) => p(get));
}
