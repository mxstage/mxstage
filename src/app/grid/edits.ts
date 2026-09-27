// 直接編集・取り消しの結果を利用者向けの文言にする（純関数）。

import type { ConflictInfo } from "../../shared/model";
import { isStoreError } from "../store";

export const CONFLICT_LABEL: Record<ConflictInfo["reason"], string> = {
  changed_since_read: "他の変更と重なった",
  user_editing: "編集中",
  read_only_column: "読み取り専用の列",
  row_not_found: "行が見つからない",
  column_not_found: "列が見つからない",
  invalid_value: "値が列の型に合わない",
  lookup_ambiguous: "候補が複数ある",
};

/** 変更できなかったセルの要約。無ければ null */
export function conflictSummary(conflicts: readonly ConflictInfo[], verb = "変更"): string | null {
  if (conflicts.length === 0) return null;
  const counts = new Map<string, number>();
  for (const c of conflicts) {
    const label = CONFLICT_LABEL[c.reason] ?? c.reason;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = Array.from(counts, ([label, n]) => `${label} ${n} 件`).join("、");
  return `${conflicts.length} 件のセルは${verb}できませんでした（${parts}）。`;
}

export function storeErrorMessage(e: unknown, fallback = "変更できませんでした。"): string {
  return isStoreError(e) ? e.message : fallback;
}
