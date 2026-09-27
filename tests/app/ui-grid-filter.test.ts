// 列の絞り込みの操作（札の一覧と列ごとのメニュー）を描画して確かめる。
// グリッド本体は canvas なので、操作の DOM はグリッドの外に出してある（ColumnFilterBar.tsx）。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ColumnFilterBar, ColumnFilterMenu } from "../../src/app/grid/ColumnFilterBar";
import type { GridFilter } from "../../src/app/grid/filters";

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

const q = <T extends Element>(s: string) => container.querySelector<T>(s);
const qa = <T extends Element>(s: string) => Array.from(container.querySelectorAll<T>(s));
const text = () => container.textContent ?? "";

async function render(el: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => root.render(el));
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error("クリックする要素がありません");
  await act(async () => (el as HTMLElement).click());
}

function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("絞り込みの札（ColumnFilterBar）", () => {
  it("絞り込みが無ければ帯を出さない（行数はペインの見出しに出る）", async () => {
    await render(createElement(ColumnFilterBar, { filters: [], onRemove: () => {}, onClearAll: () => {} }));
    expect(q(".filter-bar")).toBeNull();
    expect(text()).toBe("");
  });

  it("絞り込み中は札を出し、1 つずつ外せる", async () => {
    const removed: string[] = [];
    let cleared = 0;
    const filters: GridFilter[] = [
      { col: "STATUS", kind: "values", values: ["作成中"] },
      { col: "DESCRIPTION", kind: "contains", text: "不良" },
    ];
    const titles: Record<string, string> = { STATUS: "ステータス", DESCRIPTION: "要約" };
    await render(
      createElement(ColumnFilterBar, { filters, shown: 12, total: 2494, titleOf: (c) => titles[c] ?? c, onRemove: (c) => removed.push(c), onClearAll: () => cleared++ }),
    );
    // 先頭に残りの行数、札は画面表示名で出す
    expect(q(".filter-count")?.textContent).toBe("絞り込み中 12 / 2,494 行");
    expect(qa(".chip").map((c) => c.textContent)).toEqual(["ステータス: 作成中×", "要約: 「不良」を含む×"]);
    await click(q('button[aria-label="STATUS の絞り込みを外す"]'));
    expect(removed).toEqual(["STATUS"]);
    await click(qa<HTMLButtonElement>("button").find((b) => b.textContent === "すべて外す") ?? null);
    expect(cleared).toBe(1);
  });
});

describe("列ごとの絞り込みメニュー（ColumnFilterMenu）", () => {
  const options = [
    { value: "作成中", count: 80 },
    { value: "承認済み", count: 30 },
    { value: "", count: 10 },
  ];

  /** 画面ではメニューを閉じると消えるので、開き直しは作り直しにする */
  async function open(onApply: (f: GridFilter | null) => void, current: GridFilter | null = null) {
    await act(async () => root.render(null));
    await render(createElement(ColumnFilterMenu, { col: "STATUS", options, current, position: { x: 10, y: 20 }, onApply, onClose: () => {} }));
  }

  it("候補を件数付きで出し、選んで絞り込む（空は「（空）」と出す）", async () => {
    let applied: GridFilter | null | undefined;
    await open((f) => (applied = f));
    expect(qa(".values label").map((l) => l.textContent)).toEqual(["作成中80", "承認済み30", "（空）10"]);
    await click(qa<HTMLInputElement>('.values input[type="checkbox"]')[1] ?? null);
    await click(qa<HTMLButtonElement>(".actions button").find((b) => b.textContent === "絞り込む") ?? null);
    expect(applied).toEqual({ col: "STATUS", kind: "values", values: ["承認済み"] });
  });

  it("文字を含むで絞り込む。選択が無く文字も空なら絞り込みを外す", async () => {
    let applied: GridFilter | null | undefined;
    await open((f) => (applied = f));
    await act(async () => setValue(q<HTMLInputElement>('input[aria-label="文字を含む"]')!, "承認"));
    await click(qa<HTMLButtonElement>(".actions button").find((b) => b.textContent === "絞り込む") ?? null);
    expect(applied).toEqual({ col: "STATUS", kind: "contains", text: "承認" });

    applied = undefined;
    await open((f) => (applied = f));
    await click(qa<HTMLButtonElement>(".actions button").find((b) => b.textContent === "絞り込む") ?? null);
    expect(applied).toBeNull();
  });

  it("空・空でない・外すのボタン", async () => {
    const applied: Array<GridFilter | null> = [];
    await open((f) => applied.push(f));
    for (const label of ["空でない", "空", "外す"]) {
      await click(qa<HTMLButtonElement>(".actions button").find((b) => b.textContent === label) ?? null);
    }
    expect(applied).toEqual([{ col: "STATUS", kind: "notEmpty" }, { col: "STATUS", kind: "empty" }, null]);
  });

  it("変更のある列は、変更の状態（色見本付き）で絞り込める。変更の無い列には出さない", async () => {
    const changes = [
      { kind: "llm" as const, count: 3 },
      { kind: "user" as const, count: 0 },
      { kind: "added" as const, count: 1 },
      { kind: "deleted" as const, count: 0 },
      { kind: "none" as const, count: 116 },
    ];
    const show = async (onApply: (f: GridFilter | null) => void, list: typeof changes, current: GridFilter | null = null) => {
      await act(async () => root.render(null));
      await render(createElement(ColumnFilterMenu, { col: "STATUS", options, changes: list, current, position: { x: 10, y: 20 }, onApply, onClose: () => {} }));
    };
    let applied: GridFilter | null | undefined;
    await show((f) => (applied = f), changes);
    // 件数が 0 の区分は出さない
    expect(qa(".changes label").map((l) => l.textContent)).toEqual(["LLM の変更3", "追加行1", "変更なし116"]);
    expect(qa(".changes .swatch")).toHaveLength(2);
    await click(qa<HTMLInputElement>('.changes input[type="checkbox"]')[0] ?? null);
    // 値も選んであっても、変更の状態を選んでいればそちらで絞る（1 つの列に 1 つ）
    await click(qa<HTMLInputElement>('.values input[type="checkbox"]').at(-1) ?? null);
    await click(qa<HTMLButtonElement>(".actions button").find((b) => b.textContent === "絞り込む") ?? null);
    expect(applied).toEqual({ col: "STATUS", kind: "change", changes: ["llm"] });

    await show(() => {}, changes, { col: "STATUS", kind: "change", changes: ["added"] });
    expect(qa<HTMLInputElement>('.changes input[type="checkbox"]').map((c) => c.checked)).toEqual([false, true, false]);

    await show(() => {}, [{ kind: "none", count: 120 }] as unknown as typeof changes);
    expect(q(".changes")).toBeNull();
  });

  it("いまの絞り込みを開き直したら、その内容が入っている", async () => {
    await open(() => {}, { col: "STATUS", kind: "contains", text: "承認" });
    expect(q<HTMLInputElement>('input[aria-label="文字を含む"]')!.value).toBe("承認");
    await open(() => {}, { col: "STATUS", kind: "values", values: ["作成中"] });
    expect(qa<HTMLInputElement>('.values input[type="checkbox"]').map((c) => c.checked)).toEqual([true, false, false]);
  });
});
