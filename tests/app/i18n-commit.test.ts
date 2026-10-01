// Maximo への反映（書き込みエンジン・CommitController・反映パネル）の英語の文言を確かめる。
// 英語が正。英語の文言に日本語が混ざっていないこと、主な文言が英語で出ることを見る。

import { describe, expect, it } from "vitest";
import { notConnectedBlocker, describePlanError, structureChangedBlocker } from "../../src/app/commit/controller";
import { commitEngineMessages, commitMessages } from "../../src/app/commit/messages";
import { CommitInvariantError } from "../../src/app/maximo/commit";
import { commitButtonState, commitStateLabel, confirmLines, resultStatusLabel, resultSummary, runOutcomeMessage } from "../../src/app/pages/commitLogic";
import type { CommitPanelState } from "../../src/app/runtime/contracts";
import { setLocale } from "../../src/shared/i18n";

const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** 文言の木をたどり、すべての文言を文字列にする（関数は見本の引数で呼ぶ。配列は文字列・数としても使える） */
function allTexts(tree: unknown, path = ""): Array<{ path: string; text: string }> {
  if (typeof tree === "string") return [{ path, text: tree }];
  if (typeof tree === "function") {
    const args = Array.from({ length: Math.max(tree.length, 3) }, () => ["2"]);
    return [{ path, text: String((tree as (...a: unknown[]) => unknown)(...args)) }];
  }
  if (tree !== null && typeof tree === "object") {
    return Object.entries(tree).flatMap(([k, v]) => allTexts(v, path === "" ? k : `${path}.${k}`));
  }
  throw new Error(`文言ではない値: ${path}`);
}

function panel(patch: Partial<CommitPanelState> = {}): CommitPanelState {
  return {
    sheet: "WO",
    state: "idle",
    counts: { parents: 1, changedCells: 2, addedRows: 0, deletedRows: 1 },
    blockers: [],
    needsDeleteConfirm: false,
    needsNullConfirm: false,
    awaitingCanary: null,
    results: [],
    ...patch,
  };
}

describe("反映の英語の文言", () => {
  it("英語の文言に日本語が混ざっていない", () => {
    setLocale("en");
    const texts = [...allTexts(commitMessages()), ...allTexts(commitEngineMessages())];
    expect(texts.length).toBeGreaterThan(100);
    for (const { path, text } of texts) {
      expect(text, path).not.toBe("");
      expect(text, path).not.toMatch(JAPANESE);
    }
  });

  it("日本語の文言は日本語のまま（試験の既定）", () => {
    expect(commitMessages().panel.commitButton).toBe("Maximo に反映");
    expect(notConnectedBlocker()).toBe("Maximo に接続していません。作業画面の設定で接続してください");
  });

  it("反映のボタン・状態・確認の件数", () => {
    setLocale("en");
    expect(commitMessages().panel.commitButton).toBe("Commit to Maximo");
    expect(commitStateLabel("failed")).toBe("Some rows failed");
    expect(resultStatusLabel("unknown")).toBe("Unknown (check in Maximo)");
    expect(confirmLines(panel())).toEqual(["Sheet: WO", "Parent records: 1", "Cells to change: 2", "Rows to add: 0", "Rows to delete: 1"]);
    expect(commitButtonState(panel(), { connected: false })).toEqual({ enabled: false, reason: "Not connected to Maximo. Connect in Settings." });
  });

  it("blockers と計画を作れない理由", () => {
    setLocale("en");
    expect(notConnectedBlocker()).toBe("Not connected to Maximo. Connect in Settings on the work screen.");
    expect(structureChangedBlocker("MXAPIWO", ["a", "b", "c", "d", "e"])).toContain("(a; b; c; and 2 more)");
    const err = new CommitInvariantError("INPUT", commitEngineMessages().invariant.parentDeleteUnsupported, "parentDelete");
    expect(describePlanError(err)).toBe(
      "Deleting parents (Maximo records) cannot be committed. Undo the deletion. (INPUT: Deleting parent rows is not supported)",
    );
  });

  it("結果の要約と、run の後の文", () => {
    setLocale("en");
    const results: CommitPanelState["results"] = [
      { rowKey: "A", status: "verified" },
      { rowKey: "B", status: "error" },
      { rowKey: "C", status: "error" },
    ];
    expect(resultSummary(results)).toBe("1 committed, 2 errors");
    expect(runOutcomeMessage(panel({ state: "failed", results }), { connected: true })).toEqual({
      text: "Commit finished (1 committed, 2 errors).",
      tone: "error",
    });
    expect(runOutcomeMessage(panel({ results: [], message: "Cancelled." }), { connected: true }).text).toBe("Not committed: Cancelled.");
  });
});
