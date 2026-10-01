// セルの編集部品（grid/editors.tsx）を描画して確かめる。Glide のオーバーレイが渡す props を試験で作って渡す。

import { GridCellKind, type GridCell, type TextCell } from "@glideapps/glide-data-grid";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CellEditorContext, DateCellEditor, ValueListCellEditor, booleanFromKey, booleanFromText, type CellEditorTarget } from "../../src/app/grid/editors";
import type { ValueListState } from "../../src/app/maximo/valueList";
import { setLocale } from "../../src/shared/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

type Movement = readonly [number, number];
interface Calls {
  changes: Array<GridCell | undefined>;
  finished: Array<{ value: GridCell | undefined; movement: Movement | undefined }>;
}

function textCell(data: string): TextCell {
  return { kind: GridCellKind.Text, data, displayData: data, allowOverlay: true };
}

async function open(component: typeof DateCellEditor, target: CellEditorTarget, data: string, opts: { forceEditMode?: boolean } = {}): Promise<Calls> {
  // 開くたびに作り直す（Glide も編集を閉じるとオーバーレイを外す）
  await act(async () => root.unmount());
  root = createRoot(container);
  const calls: Calls = { changes: [], finished: [] };
  const props = {
    value: textCell(data),
    onChange: (v: GridCell | undefined) => calls.changes.push(v),
    onFinishedEditing: (value?: GridCell, movement?: Movement) => calls.finished.push({ value, movement }),
    isHighlighted: false,
    target: { x: 0, y: 0, width: 100, height: 32 },
    forceEditMode: opts.forceEditMode ?? false,
    theme: {},
  } as unknown as Parameters<typeof DateCellEditor>[0];
  await act(async () => root.render(createElement(CellEditorContext.Provider, { value: { current: target } }, createElement(component, props))));
  return calls;
}

const input = () => container.querySelector<HTMLInputElement>(".mx-cell-editor__input")!;
const helper = () => container.querySelector(".mx-cell-editor__helper")?.textContent ?? "";
const options = () => Array.from(container.querySelectorAll('[role="option"]')).map((o) => o.textContent);

async function type(value: string): Promise<void> {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
}

const dataOf = (c: GridCell | undefined) => (c && c.kind === GridCellKind.Text ? c.data : c);

describe("日付の入力（DateCellEditor）", () => {
  const dateTarget: CellEditorTarget = { col: { name: "TARGSTARTDATE", type: "date" }, originalText: "2026-04-01" };
  const dtTarget: CellEditorTarget = { col: { name: "REPORTDATE", type: "datetime" }, originalText: "2026-04-01 09:30" };

  it("今の値を選んだ状態で開き、書き方の例を出す。変えずに Enter なら変更にしない", async () => {
    const calls = await open(DateCellEditor, dateTarget, "2026-04-01");
    expect(input().value).toBe("2026-04-01");
    expect(document.activeElement).toBe(input());
    expect(helper()).toBe("例 2026/10/01・2026-10-01");
    expect(container.querySelector('button[aria-label="カレンダーを開く"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[type="date"]')).not.toBeNull();
    await key("Enter");
    expect(calls.finished).toEqual([{ value: undefined, movement: [0, 1] }]);
  });

  it("書き慣れた形で打つと、入る形を見せ、Enter で確定して下へ動く", async () => {
    const calls = await open(DateCellEditor, dtTarget, "2026-04-01 09:30");
    expect(container.querySelector<HTMLInputElement>('input[type="datetime-local"]')).not.toBeNull();
    await type("2026/10/1 8:05");
    expect(helper()).toBe("2026-10-01 08:05 として入れます");
    expect(dataOf(calls.changes.at(-1))).toBe("2026/10/1 8:05");
    await key("Enter");
    expect(calls.finished).toHaveLength(1);
    expect(dataOf(calls.finished[0]!.value)).toBe("2026/10/1 8:05");
    expect(calls.finished[0]!.movement).toEqual([0, 1]);
  });

  it("読めない日付では Enter で閉じず、理由を出す。Esc で取り消す。元の文字に戻したら変更なし", async () => {
    const calls = await open(DateCellEditor, dateTarget, "2026-04-01");
    await type("2026/02/30");
    await key("Enter");
    expect(calls.finished).toEqual([]);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("日付として読めません");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    await type("2026-04-01");
    expect(calls.changes.at(-1)).toBeUndefined();
    await key("Escape");
    expect(calls.finished).toEqual([{ value: undefined, movement: [0, 0] }]);
  });

  it("カレンダーで選んだ日時を入力欄の形にする。今日・現在のボタンで入れる。Tab は確定して横へ", async () => {
    const calls = await open(DateCellEditor, dtTarget, "2026-04-01 09:30");
    const picker = container.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(picker, "2026-12-24T18:45");
      picker.dispatchEvent(new Event("input", { bubbles: true }));
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(input().value).toBe("2026-12-24 18:45");
    const now = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "現在")!;
    await act(async () => now.click());
    expect(input().value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    await key("Tab", { shiftKey: true });
    expect(calls.finished[0]!.movement).toEqual([-1, 0]);
  });

  it("英語の画面では英語で案内する", async () => {
    setLocale("en");
    await open(DateCellEditor, dtTarget, "");
    expect(helper()).toBe("e.g. 2026/10/01 09:30 (24-hour)");
    expect(input().placeholder).toBe("YYYY/MM/DD HH:mm");
  });
});

describe("値の一覧から選ぶ入力（ValueListCellEditor）", () => {
  const items = [
    { value: "WAPPR", description: "承認待ち" },
    { value: "APPR", description: "承認済み" },
    { value: "COMP", description: "完了" },
  ];
  const masterTarget = (): CellEditorTarget => ({ col: { name: "STATUS", type: "string", title: "ステータス" }, originalText: "APPR", list: { kind: "master", sheet: "状態", items } });

  it("開くと一覧の全部を出し、今の値に印を付ける。↓ で動かし Enter で選んで確定する", async () => {
    const calls = await open(ValueListCellEditor, masterTarget(), "APPR");
    expect(options()).toEqual(["WAPPR承認待ち", "APPR承認済み", "COMP完了"]);
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe("APPR承認済み");
    expect(helper()).toBe("シート 状態 の値（3 件）");
    expect(input().getAttribute("aria-label")).toBe("ステータス の値の一覧");
    await key("ArrowDown");
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe("COMP完了");
    await key("Enter");
    expect(calls.finished).toHaveLength(1);
    expect(dataOf(calls.finished[0]!.value)).toBe("COMP");
    expect(calls.finished[0]!.movement).toEqual([0, 1]);
  });

  it("打った文字で値と説明を絞り込み、押して選ぶ。一覧に無い値は注意を出すが、そのまま入れられる", async () => {
    const calls = await open(ValueListCellEditor, masterTarget(), "APPR");
    await type("承認");
    expect(options()).toEqual(["WAPPR承認待ち", "APPR承認済み"]);
    // 一覧に無い値（絞り込みの途中）は注意を出す
    expect(helper()).toContain("一覧にない値です");
    expect(input().className).toContain("mx-cell-editor__input--warning");
    await type("zzz");
    expect(container.querySelector(".mx-cell-editor__empty")?.textContent).toContain("合う値がありません");
    await key("Enter");
    expect(dataOf(calls.finished[0]!.value)).toBe("zzz");
  });

  it("候補を押すと、その値で確定する（大文字小文字だけの違いは一覧にある値とみなす）", async () => {
    const calls = await open(ValueListCellEditor, masterTarget(), "APPR");
    await type("comp");
    expect(helper()).not.toContain("一覧にない値です");
    const item = container.querySelector<HTMLElement>('[role="option"]')!;
    await act(async () => item.click());
    expect(dataOf(calls.finished[0]!.value)).toBe("COMP");
    expect(calls.finished[0]!.movement).toEqual([0, 0]);
  });

  it("Maximo の一覧は開いてから読み、読み終わるまでは文字を打てる。一覧が無ければ普通の入力になる", async () => {
    let resolve: (s: ValueListState) => void = () => undefined;
    const target: CellEditorTarget = {
      col: { name: "STATUS", type: "string" },
      originalText: "",
      list: { kind: "maximo", initial: undefined, load: () => new Promise<ValueListState>((r) => (resolve = r)) },
    };
    const calls = await open(ValueListCellEditor, target, "W", { forceEditMode: true });
    expect(helper()).toBe("値の一覧を読み込んでいます…");
    await type("WA");
    await act(async () => resolve({ status: "ready", items }));
    expect(options()).toEqual(["WAPPR承認待ち"]);
    expect(helper()).toContain("一覧にない値です");
    await key("ArrowDown");
    await key("Tab");
    expect(dataOf(calls.finished[0]!.value)).toBe("WAPPR");
    expect(calls.finished[0]!.movement).toEqual([1, 0]);

    const none: CellEditorTarget = { col: { name: "X", type: "string" }, originalText: "", list: { kind: "maximo", initial: undefined, load: async () => ({ status: "none" }) } };
    await open(ValueListCellEditor, none, "");
    await act(async () => undefined);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelector(".mx-cell-editor__helper")).toBeNull();
  });

  it("英語の画面では英語で案内する", async () => {
    setLocale("en");
    await open(ValueListCellEditor, masterTarget(), "APPR");
    expect(helper()).toBe("3 values in sheet 状態");
    await type("X1");
    expect(helper()).toBe("Not in the list. Maximo may not accept this value.");
  });
});

describe("真偽値の列のキーと貼り付け", () => {
  it("1/t/y で入、0/f/n で切。全角も同じ。ほかの文字は何もしない", () => {
    expect(["1", "t", "Y", "１"].map(booleanFromKey)).toEqual([true, true, true, true]);
    expect(["0", "F", "n"].map(booleanFromKey)).toEqual([false, false, false]);
    expect(booleanFromKey("a")).toBeNull();
  });

  it("貼り付けは true/false・1/0・Y/N・yes/no を読み、空は値なし、読めなければ変えない", () => {
    expect(booleanFromText("TRUE")).toBe(true);
    expect(booleanFromText(" n ")).toBe(false);
    expect(booleanFromText("")).toBeNull();
    expect(booleanFromText("たぶん")).toBeUndefined();
  });
});
