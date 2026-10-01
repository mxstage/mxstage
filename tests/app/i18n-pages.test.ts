// 作業画面（上部バー・ペイン・グリッド・オブジェクト構造の画面・骨組み）の英語の文言。
// 英語が正なので、英語の文言に漢字・かなが混じっていないことと、主な文言が英語で出ることを確かめる。

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { setLocale } from "../../src/shared/i18n";
import { gridMessages } from "../../src/app/grid/messages";
import { filterLabel, rowCountLabel } from "../../src/app/grid/filters";
import { conflictSummary } from "../../src/app/grid/edits";
import { hoverLines } from "../../src/app/grid/cellStyle";
import { pagesMessages } from "../../src/app/pages/messages";
import { maximoBadge, relayBadge } from "../../src/app/pages/status";
import { tooManyPanes } from "../../src/app/pages/panes";
import { structuresMessages } from "../../src/app/structures/messages";
import { loadErrorMessage } from "../../src/app/structures/logic";
import { uiMessages } from "../../src/app/ui/messages";
import { offlineText } from "../../src/app/pwa/cacheRules";
import { updateReadyMessage } from "../../src/app/pwa/register";
import { defaultWorkspaceName } from "../../src/app/boot/runtime";
import { ColumnFilterBar } from "../../src/app/grid/ColumnFilterBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** 関数の文言に渡す見本の引数（引数の型は数・文字列・真偽・配列・null のどれか。どれを渡しても文字列が返る） */
const SAMPLES: readonly unknown[][] = [
  [],
  [1, 2, 3],
  [2, 3, 4],
  ["WO", "ASSET", "x"],
  ["WO", 2, "x"],
  [true, 2, 3],
  [false, 1, 1],
  ["WO", ["A", "B"]],
  ["WO", null],
  [0, "x"],
];

/** 英語の文言の木をたどり、すべての文字列（関数は見本の引数で呼んだ結果）を集める */
function collect(tree: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof tree === "string") {
    out.push([path, tree]);
    return;
  }
  if (typeof tree === "function") {
    for (const args of SAMPLES) {
      let value: unknown;
      try {
        value = (tree as (...a: unknown[]) => unknown)(...args);
      } catch {
        continue;
      }
      if (typeof value === "string") out.push([`${path}(${args.map(String).join(", ")})`, value]);
    }
    return;
  }
  if (tree !== null && typeof tree === "object") {
    for (const [key, value] of Object.entries(tree)) collect(value, path ? `${path}.${key}` : key, out);
  }
}

describe("作業画面の英語の文言", () => {
  it.each([
    ["pages", pagesMessages],
    ["grid", gridMessages],
    ["structures", structuresMessages],
    ["ui", uiMessages],
  ])("%s の英語の文言に漢字・かなが無い", (_name, messages) => {
    setLocale("en");
    const strings: Array<[string, string]> = [];
    collect(messages(), "", strings);
    expect(strings.length).toBeGreaterThan(5);
    const japanese = strings.filter(([, s]) => JAPANESE.test(s));
    expect(japanese).toEqual([]);
    // たどり方が正しいことの確かめ: 日本語の木では漢字・かなが見つかる
    setLocale("ja");
    const ja: Array<[string, string]> = [];
    collect(messages(), "", ja);
    expect(ja.some(([, s]) => JAPANESE.test(s))).toBe(true);
  });

  it("主な文言が英語で出る（上部バー・空の作業画面・列の絞り込み・オブジェクト構造の画面）", () => {
    setLocale("en");
    expect(pagesMessages().topBar.settings).toBe("Settings");
    expect(pagesMessages().topBar.structures).toBe("Object structures");
    expect(pagesMessages().app.emptyTitle).toBe("No sheets yet.");
    expect(filterLabel({ col: "STATUS", kind: "notEmpty" })).toBe("STATUS: not empty");
    expect(filterLabel({ col: "STATUS", kind: "change", changes: ["llm", "user"] })).toBe("STATUS: Changed by LLM, Changed by you");
    expect(filterLabel({ col: "DESCRIPTION", kind: "contains", text: "leak" })).toBe('DESCRIPTION: contains "leak"');
    expect(rowCountLabel({ shown: 1, total: 1, narrowed: false })).toBe("1 row");
    expect(rowCountLabel({ shown: 120, total: 120, narrowed: false })).toBe("120 rows");
    expect(structuresMessages().title).toBe("Object structures");
    expect(relayBadge(null).text).toBe("Relay: not connected");
    expect(maximoBadge({ kind: "disconnected" })).toEqual({ text: "Maximo: not connected", tone: "muted", settingsLink: "Connect in Settings" });
    expect(tooManyPanes(4)).toBe("Up to 4 tables can be shown at once. Hide another table first.");
    expect(hoverLines({ tone: "user", author: "user", reason: null, before: null, after: "X" })).toEqual(["Author: You", "(empty) → X"]);
    expect(conflictSummary([{ rowKey: "a", col: "X", reason: "user_editing" }], "undo")).toBe("1 cell could not be undone (being edited: 1).");
    expect(loadErrorMessage("MXAPIWO", new Error("boom"))).toBe("Could not load MXAPIWO: boom.");
    expect(updateReadyMessage()).toBe("A new version is ready. Close this tab and open it again to switch to it.");
    expect(defaultWorkspaceName(new Date(2026, 8, 16, 10, 30))).toBe("Session 2026-09-16 10:30");
  });

  it("日本語に切り替えると同じ関数が日本語を返す（呼んだときの言語）", () => {
    setLocale("en");
    expect(rowCountLabel({ shown: 3, total: 3, narrowed: false })).toBe("3 rows");
    setLocale("ja");
    expect(rowCountLabel({ shown: 3, total: 3, narrowed: false })).toBe("3 行");
  });

  it("列の絞り込みの帯が英語で出る", () => {
    setLocale("en");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(ColumnFilterBar, { filters: [{ col: "STATUS", kind: "empty" }], shown: 1200, total: 3400, onRemove: () => undefined, onClearAll: () => undefined }));
    });
    expect(container.querySelector(".filter-count")?.textContent).toBe("Filtered: 1,200 / 3,400 rows");
    expect(container.textContent).toContain("STATUS: empty");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Clear all")).toBe(true);
    expect(JAPANESE.test(container.innerHTML)).toBe(false);
    act(() => root.unmount());
    container.remove();
  });

  it("オフラインの文は要求の言語で選ぶ（Service Worker は画面で選んだ言語を読めない）", () => {
    expect(offlineText("ja,en-US;q=0.9")).toContain("オフライン");
    expect(offlineText("en-US,ja;q=0.5")).toBe("You are offline. Connect to the network and open the page again.");
    expect(offlineText(null)).toBe("You are offline. Connect to the network and open the page again.");
  });
});
