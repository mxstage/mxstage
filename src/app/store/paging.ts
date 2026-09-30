// 不透明な cursor（offset を base64 にした文字列）と limit の検査。

import { StoreError } from "./errors";

export function encodeCursor(offset: number): string {
  return btoa(JSON.stringify({ o: offset }));
}

export function decodeCursor(cursor: string | undefined | null): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  try {
    const v: unknown = JSON.parse(atob(cursor));
    if (typeof v === "object" && v !== null && "o" in v && typeof v.o === "number" && Number.isSafeInteger(v.o) && v.o >= 0) {
      return v.o;
    }
  } catch {
    // 下で型付きエラーにする
  }
  throw new StoreError("invalid_cursor", "Invalid cursor. Pass nextCursor from the previous result unchanged");
}

export function checkLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new StoreError("invalid_args", "limit must be an integer of 1 or more", { limit });
  }
  return limit;
}

/** offset から limit 件を切り出し、続きがあれば nextCursor を返す */
export function paginate<T>(items: readonly T[], cursor: string | undefined, limit: number): { page: T[]; nextCursor: string | null } {
  const offset = decodeCursor(cursor);
  const end = offset + limit;
  return { page: items.slice(offset, end), nextCursor: end < items.length ? encodeCursor(end) : null };
}
