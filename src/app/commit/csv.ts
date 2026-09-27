// 書き込みログの CSV（キーと結果だけ。属性値は WriteLogEntry に入っていないので出ない）。

import type { WriteLogEntry } from "../maximo/commit";

export const WRITE_LOG_CSV_HEADER = ["at", "parentKey", "transactionId", "change", "delete", "add", "attrs", "httpStatus", "reasonCode", "result"] as const;

/** 表計算ソフトで式として解釈されないよう先頭に ' を付け、区切り・引用符・改行を含む値は引用する */
function csvField(v: string | number | null): string {
  if (v === null) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeLogCsv(entries: readonly WriteLogEntry[]): string {
  const lines = [WRITE_LOG_CSV_HEADER.join(",")];
  for (const e of entries) {
    lines.push(
      [e.at, e.parentKey, e.transactionId, e.ops.change, e.ops.delete, e.ops.add, e.ops.attrs.join(" "), e.httpStatus, e.reasonCode, e.result].map(csvField).join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
