// 反映パネルの純ロジック: ボタンの有効条件、確認の要否、結果の文言、ログのファイル名。

import type { CommitRowResult, CommitState } from "../../shared/model";
import { parseRowKey } from "../../shared/sheet";
import type { CommitCounts, CommitPanelState } from "../runtime/contracts";
import { commitMessages as m } from "../commit/messages";

/** 行キーを人が読める形にする（例 "BEDFORD / WO062041 #EXT_WOPERMIT:12"） */
export function displayRowKey(rowKey: string): string {
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const p = parseRowKey(rowKey);
  const parent = p.parentKey.split("|").map(dec).join(" / ");
  return p.childName === null ? parent : `${parent} #${p.childName}:${p.childId ?? ""}`;
}

export function totalChanges(c: CommitCounts): number {
  return c.changedCells + c.addedRows + c.deletedRows;
}

export interface CommitButtonState {
  enabled: boolean;
  /** 押せない理由（押せるときは null） */
  reason: string | null;
}

/** [Maximo に反映] は、未接続・blockers あり・実行中・カナリアの判断待ち・変更なしのとき押せない */
export function commitButtonState(panel: CommitPanelState | null, opts: { connected: boolean; locked?: boolean }): CommitButtonState {
  const t = m().button;
  if (panel === null) return { enabled: false, reason: t.noSheet };
  if (panel.state === "running") return { enabled: false, reason: t.running };
  if (panel.awaitingCanary !== null) return { enabled: false, reason: t.awaitingCanary };
  if (!opts.connected) {
    return { enabled: false, reason: opts.locked ? t.locked : t.notConnected };
  }
  if (panel.blockers.length > 0) return { enabled: false, reason: t.blocked };
  if (totalChanges(panel.counts) === 0) return { enabled: false, reason: t.noChanges };
  return { enabled: true, reason: null };
}

/**
 * [反映を中止] を出すか。反映の実行中と、カナリア（最初の 1 件）の確認待ちのときだけ出す。
 * 送信済みの分は取り消せないので、それ以外の状態では出さない。
 */
export function canCancelCommit(panel: CommitPanelState | null): boolean {
  if (panel === null) return false;
  return panel.state === "running" || panel.awaitingCanary !== null;
}

export interface ConfirmChecks {
  deletes: boolean;
  nulls: boolean;
}

/** 確認ダイアログの [反映する] を押せるか（必要な確認のチェックがすべて入っている） */
export function canConfirmCommit(panel: CommitPanelState, checks: ConfirmChecks): boolean {
  return (!panel.needsDeleteConfirm || checks.deletes) && (!panel.needsNullConfirm || checks.nulls);
}

export function confirmLines(panel: CommitPanelState): string[] {
  const c = panel.counts;
  const t = m().confirmLine;
  const lines = [t.sheet(panel.sheet), t.parents(c.parents), t.changedCells(c.changedCells), t.addedRows(c.addedRows), t.deletedRows(c.deletedRows)];
  // 新しく作るレコードは取り消せない（Maximo の削除が要る）ので、あるときは別の行で示す
  if ((c.newRecords ?? 0) > 0) lines.splice(2, 0, t.newRecords(c.newRecords ?? 0));
  return lines;
}

/** 反映パネルの状態の表示名（今の言語） */
export function commitStateLabel(state: CommitState): string {
  return m().state[state];
}

/** 行ごとの結果の表示名（今の言語） */
export function resultStatusLabel(status: CommitRowResult["status"]): string {
  return m().resultStatus[status];
}

const RESULT_ORDER: Array<CommitRowResult["status"]> = ["verified", "conflict", "error", "unknown", "skipped"];

export function countResults(results: readonly CommitRowResult[]): Record<CommitRowResult["status"], number> {
  const out: Record<CommitRowResult["status"], number> = { verified: 0, conflict: 0, error: 0, unknown: 0, skipped: 0 };
  for (const r of results) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

/** 例「反映済み 3 件、エラー 1 件」。結果が無ければ空文字 */
export function resultSummary(results: readonly CommitRowResult[]): string {
  const counts = countResults(results);
  const t = m();
  return RESULT_ORDER.filter((s) => counts[s] > 0)
    .map((s) => t.resultCount[s](counts[s]))
    .join(t.resultSeparator);
}

export interface RunOutcome {
  text: string;
  tone: "info" | "error";
}

/**
 * run() の後に利用者へ見せる文言。
 * controller が「反映しなかった理由」（CommitPanelState.message）を返していればそれをそのまま見せる。
 * 無ければ、これまでどおりボタンの条件から理由を推測する。
 */
export function runOutcomeMessage(result: CommitPanelState, opts: { connected: boolean; locked?: boolean }): RunOutcome {
  const t = m().outcome;
  const message = result.message !== undefined && result.message !== "" ? result.message : null;
  // run は実行できないとき（未接続・blockers・確認不足・実行中）に何もせず状態を返す。終わったように見せない
  if (result.state === "running") {
    return { text: message ?? t.alreadyRunning, tone: "error" };
  }
  if (result.results.length === 0) {
    const why = message ?? commitButtonState(result, opts).reason;
    return { text: why ? t.notCommittedBecause(why) : t.notCommitted, tone: "error" };
  }
  const summary = resultSummary(result.results);
  const done = summary ? t.finishedWith(summary) : t.finished;
  return { text: message ? t.withMessage(done, message) : done, tone: result.state === "failed" ? "error" : "info" };
}

export function writeLogFileName(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `mxstage-writelog-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.csv`;
}

/** Excel で文字化けしないよう先頭に BOM を付ける（既に付いていれば付けない） */
export function withBom(csv: string): string {
  const bom = String.fromCharCode(0xfeff);
  return csv.startsWith(bom) ? csv : bom + csv;
}
