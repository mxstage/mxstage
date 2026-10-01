// 直接編集・取り消しの結果を利用者向けの文言にする（純関数）。

import type { ConflictInfo } from "../../shared/model";
import { isStoreError } from "../store";
import { gridMessages } from "./messages";

/** 変更できなかった理由の文言（今の言語。知らない理由はそのまま） */
export function conflictLabel(reason: ConflictInfo["reason"]): string {
  const labels: Readonly<Record<string, string>> = gridMessages().conflictReason;
  return labels[reason] ?? reason;
}

/** 変更できなかったセルの要約。無ければ null。action は直接編集（change）か取り消し（undo）か */
export function conflictSummary(conflicts: readonly ConflictInfo[], action: "change" | "undo" = "change"): string | null {
  if (conflicts.length === 0) return null;
  const t = gridMessages().conflict;
  const counts = new Map<string, number>();
  for (const c of conflicts) {
    const label = conflictLabel(c.reason);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = Array.from(counts, ([label, n]) => t.part(label, n)).join(t.separator);
  return action === "undo" ? t.summaryUndo(conflicts.length, parts) : t.summaryChange(conflicts.length, parts);
}

export function storeErrorMessage(e: unknown, fallback: string = gridMessages().conflict.changeFailed): string {
  return isStoreError(e) ? e.message : fallback;
}
