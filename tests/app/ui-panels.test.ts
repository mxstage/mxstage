// 反映パネルを描画して、Maximo への書き込みが「人の確認」を通ったときだけ起き、
// 結果の見せ方が実際の結果と食い違わないことを確かめる。

import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteLogEntry } from "../../src/app/maximo/commit";
import { CommitPanel, type CommitPanelProps } from "../../src/app/pages/CommitPanel";
import type { CommitController, CommitPanelState } from "../../src/app/runtime/contracts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function panelState(sheet: string, patch: Partial<CommitPanelState> = {}): CommitPanelState {
  return {
    sheet,
    state: "idle",
    counts: { parents: 1, changedCells: 2, addedRows: 0, deletedRows: 0 },
    blockers: [],
    needsDeleteConfirm: false,
    needsNullConfirm: false,
    awaitingCanary: null,
    results: [],
    ...patch,
  };
}

const LOG_ENTRY = {
  at: "2026-09-16T01:02:03.000Z",
  parentKey: "BEDFORD|WO062041",
  transactionId: "tx-1",
  ops: { change: 1, delete: 0, add: 0, attrs: ["EXT_PERMITDATE"] },
  httpStatus: 200,
  reasonCode: null,
  result: "verified",
} as unknown as WriteLogEntry;

class FakeCommits implements CommitController {
  panels = new Map<string, CommitPanelState>();
  runCalls: Array<{ sheet: string; opts: { allowNull?: boolean; deletesConfirmed?: boolean } }> = [];
  canaryCalls: Array<{ sheet: string; proceed: boolean }> = [];
  cancelCalls: string[] = [];
  dismissed: string[] = [];
  entries: WriteLogEntry[] = [];
  /** writeLog() を呼んだ回数（本物は全件を複製するので、毎フレーム呼ばせない） */
  writeLogCalls = 0;
  /** run が返す状態。既定は 1 件成功 */
  runResult: (sheet: string) => CommitPanelState = (sheet) => panelState(sheet, { state: "done", results: [{ rowKey: "BEDFORD|WO062041", status: "verified" }] });

  set(sheet: string, patch: Partial<CommitPanelState> = {}): void {
    this.panels.set(sheet, panelState(sheet, patch));
  }

  request = (sheet: string): CommitPanelState => this.panel(sheet);
  panel = (sheet: string): CommitPanelState => this.panels.get(sheet) ?? panelState(sheet);
  isRunning = (sheet: string): boolean => this.panel(sheet).state === "running";
  run = async (sheet: string, opts: { allowNull?: boolean; deletesConfirmed?: boolean }): Promise<CommitPanelState> => {
    this.runCalls.push({ sheet, opts });
    return this.runResult(sheet);
  };
  continueCanary = (sheet: string, proceed: boolean): void => void this.canaryCalls.push({ sheet, proceed });
  cancel = (sheet: string): void => void this.cancelCalls.push(sheet);
  dismiss = (sheet: string): void => void this.dismissed.push(sheet);
  subscribe = (): (() => void) => () => undefined;
  writeLog = (): readonly WriteLogEntry[] => {
    this.writeLogCalls += 1;
    return this.entries;
  };
  writeLogCsv = (): string => "at,parentKey\r\n";
}

let container: HTMLDivElement;
let root: ReactRoot;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}

function findButton(label: string): HTMLButtonElement | undefined {
  return buttons().find((b) => (b.textContent ?? "").trim() === label);
}

async function click(label: string): Promise<void> {
  const button = findButton(label);
  if (!button) throw new Error(`ボタン「${label}」がありません（あるもの: ${buttons().map((b) => b.textContent).join(" / ")}）`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** チェックボックスは click で切り替える（React の onChange は click から出る） */
async function check(box: HTMLInputElement): Promise<void> {
  await act(async () => {
    box.click();
  });
}

async function render(props: CommitPanelProps): Promise<void> {
  await act(async () => {
    root.render(createElement(CommitPanel, props));
  });
}

function props(commits: FakeCommits, sheet: string, patch: Partial<CommitPanelProps> = {}): CommitPanelProps {
  return { commits, sheet, version: 1, connected: true, locked: false, onMessage: vi.fn(), ...patch };
}

describe("反映パネル", () => {
  it("確認ダイアログを出してからでないと反映しない", async () => {
    const commits = new FakeCommits();
    commits.set("許可申請");
    const onMessage = vi.fn();
    await render(props(commits, "許可申請", { onMessage }));

    expect(commits.runCalls).toEqual([]);
    await click("Maximo に反映");
    expect(container.textContent).toContain("Maximo に反映しますか？");
    expect(commits.runCalls).toEqual([]);

    await click("反映する");
    expect(commits.runCalls).toEqual([{ sheet: "許可申請", opts: { allowNull: false, deletesConfirmed: false } }]);
    expect(onMessage).toHaveBeenCalledWith("反映が終わりました（反映済み 1 件）。", "info");
  });

  it("確認の途中でシートを切り替えたら確認をやり直す", async () => {
    const commits = new FakeCommits();
    commits.set("許可申請");
    commits.set("ASSET");
    await render(props(commits, "許可申請"));
    await click("Maximo に反映");
    expect(container.textContent).toContain("シート: 許可申請");

    // 別のシートに切り替える（前のシートの件数で確認したまま反映しない）
    await render(props(commits, "ASSET"));
    expect(container.textContent).not.toContain("Maximo に反映しますか？");
    expect(commits.runCalls).toEqual([]);
  });

  it("削除・空への変更はチェックを入れるまで反映できない", async () => {
    const commits = new FakeCommits();
    commits.set("許可申請", { needsDeleteConfirm: true, needsNullConfirm: true, counts: { parents: 2, changedCells: 1, addedRows: 0, deletedRows: 12 } });
    await render(props(commits, "許可申請"));
    await click("Maximo に反映");

    expect(findButton("反映する")?.disabled).toBe(true);
    const checks = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    expect(checks).toHaveLength(2);
    for (const box of checks) {
      await check(box);
      expect(box.checked).toBe(true);
    }
    expect(findButton("反映する")?.disabled).toBe(false);
    await click("反映する");
    expect(commits.runCalls).toEqual([{ sheet: "許可申請", opts: { allowNull: true, deletesConfirmed: true } }]);
  });

  it("反映しなかったときに「終わりました」と言わない", async () => {
    const commits = new FakeCommits();
    commits.set("許可申請");
    // 押した後に接続が切れた・blockers が増えた場合、run は何もせず状態を返す
    commits.runResult = (sheet) => panelState(sheet, { state: "idle", results: [], blockers: ["href がありません"] });
    const onMessage = vi.fn();
    await render(props(commits, "許可申請", { onMessage }));
    await click("Maximo に反映");
    await click("反映する");

    expect(commits.runCalls).toHaveLength(1);
    const [text, tone] = onMessage.mock.calls[0] ?? [];
    expect(String(text)).toContain("反映しませんでした");
    expect(tone).toBe("error");
  });

  it("未接続・ロック中は押せない", async () => {
    const commits = new FakeCommits();
    commits.set("許可申請");
    await render(props(commits, "許可申請", { connected: false, locked: true }));
    expect(findButton("Maximo に反映")?.disabled).toBe(true);
    expect(container.textContent).toContain("ロック");
  });

  it("カナリアの結果を見てから続行を選ぶ", async () => {
    const commits = new FakeCommits();
    commits.set("許可申請", { state: "running", awaitingCanary: { rowKey: "BEDFORD|WO062041", status: "verified" } });
    await render(props(commits, "許可申請"));
    expect(container.textContent).toContain("最初の 1 件の結果");
    await click("続行");
    expect(commits.canaryCalls).toEqual([{ sheet: "許可申請", proceed: true }]);
  });

  it("LLM の依頼を強調し、閉じられる", async () => {
    const commits = new FakeCommits();
    commits.set("許可申請", { state: "requested", note: "申請完了日だけ直しました" });
    await render(props(commits, "許可申請"));
    expect(container.querySelector(".commit-panel.requested")).not.toBeNull();
    expect(container.textContent).toContain("申請完了日だけ直しました");
    await click("依頼を閉じる");
    expect(commits.dismissed).toEqual(["許可申請"]);
  });

  it("書き込みログの CSV は反映中に出さない", async () => {
    const commits = new FakeCommits();
    commits.entries = [LOG_ENTRY];
    commits.set("許可申請", { state: "done", results: [{ rowKey: "BEDFORD|WO062041", status: "verified" }] });
    await render(props(commits, "許可申請"));
    expect(findButton("書き込みログ（CSV）")).toBeDefined();

    commits.set("許可申請", { state: "running" });
    await render(props(commits, "許可申請", { version: 2 }));
    expect(findButton("書き込みログ（CSV）")).toBeUndefined();
  });

  it("別のシートを反映して書き込みログが増えたら CSV ボタンを出す", async () => {
    const commits = new FakeCommits();
    commits.set("許可申請", { state: "idle" });
    await render(props(commits, "許可申請"));
    expect(findButton("書き込みログ（CSV）")).toBeUndefined();

    // 反映したのは別のシートなので、このシートのパネルの状態は変わらない
    commits.entries = [LOG_ENTRY];
    await render(props(commits, "許可申請", { version: 2 }));
    expect(findButton("書き込みログ（CSV）")).toBeDefined();
  });

  it("書き込みログの有無を毎フレーム数え直さない（writeLog は全件を複製する）", async () => {
    const commits = new FakeCommits();
    commits.entries = [LOG_ENTRY];
    commits.set("許可申請", { state: "done", results: [{ rowKey: "BEDFORD|WO062041", status: "verified" }] });
    await render(props(commits, "許可申請"));
    expect(findButton("書き込みログ（CSV）")).toBeDefined();
    const calls = commits.writeLogCalls;
    expect(calls).toBeGreaterThan(0);

    // LLM の変更で version だけが毎フレーム増える（パネルの状態は変わらない）
    for (let v = 2; v <= 6; v++) await render(props(commits, "許可申請", { version: v }));
    expect(findButton("書き込みログ（CSV）")).toBeDefined();
    expect(commits.writeLogCalls).toBe(calls);
  });

  it("反映中は [反映を中止] を出して cancel を呼ぶ", async () => {
    const commits = new FakeCommits();
    commits.set("許可申請", { state: "running", results: [{ rowKey: "BEDFORD|WO062041", status: "verified" }] });
    const onMessage = vi.fn();
    await render(props(commits, "許可申請", { onMessage }));

    expect(findButton("Maximo に反映")?.disabled).toBe(true);
    await click("反映を中止");
    expect(commits.cancelCalls).toEqual(["許可申請"]);
    // 送信済みの分は取り消せないことを伝える
    expect(String(onMessage.mock.calls[0]?.[0])).toContain("送信済み");
  });

  it("反映していないときは [反映を中止] を出さない", async () => {
    const commits = new FakeCommits();
    commits.set("許可申請", { state: "done", results: [{ rowKey: "BEDFORD|WO062041", status: "verified" }] });
    await render(props(commits, "許可申請"));
    expect(findButton("反映を中止")).toBeUndefined();
  });

  it("カナリアの確認待ちの [中止] は cancel を呼ぶ（残りを送らない）", async () => {
    const commits = new FakeCommits();
    commits.set("許可申請", { state: "running", awaitingCanary: { rowKey: "BEDFORD|WO062041", status: "conflict", httpStatus: 409 } });
    await render(props(commits, "許可申請"));
    expect(container.textContent).toContain("最初の 1 件の結果");
    await click("中止");
    expect(commits.cancelCalls).toEqual(["許可申請"]);
    expect(commits.canaryCalls).toEqual([]);
  });

  it("反映しなかった理由は controller の message をそのまま見せる", async () => {
    const commits = new FakeCommits();
    commits.set("許可申請");
    commits.runResult = (sheet) => panelState(sheet, { state: "idle", results: [], message: "利用者が中止したため送りませんでした" });
    const onMessage = vi.fn();
    await render(props(commits, "許可申請", { onMessage }));
    await click("Maximo に反映");
    await click("反映する");

    expect(onMessage).toHaveBeenCalledWith("反映しませんでした: 利用者が中止したため送りませんでした", "error");
  });

  it("パネルにも理由を残す（トーストが消えても分かる）", async () => {
    const commits = new FakeCommits();
    commits.set("許可申請", { state: "failed", message: "反映を中止しました。残り 3 件は送っていません" });
    await render(props(commits, "許可申請"));
    expect(container.querySelector(".commit-message")?.textContent).toBe("反映を中止しました。残り 3 件は送っていません");
  });
});
