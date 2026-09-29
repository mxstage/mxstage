// 表示する表の帯（出す・隠す・表を足す）と、ペインの見出しの隠す・つかむ所。

import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneBar } from "../../src/app/pages/PaneBar";
import { PANE_DRAG_TYPE, PaneHeader } from "../../src/app/pages/PaneHeader";
import { PaneSplitters } from "../../src/app/pages/PaneSplitters";
import type { ArrangedPane, PaneSpec } from "../../src/app/pages/panes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReactRoot;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const q = <T extends Element>(sel: string) => container.querySelector<T>(sel);
const qa = <T extends Element>(sel: string) => Array.from(container.querySelectorAll<T>(sel));

function pane(key: string, title: string, shown: boolean, extra = false): ArrangedPane {
  return { key, title, subtitle: `${title} の説明`, sheet: title, scope: { kind: "all" }, shown, extra };
}

describe("表示する表の帯（PaneBar）", () => {
  it("組の表と足した表を並べ、押すと出す・隠す。「表を足す」から組に無い表を選べる", async () => {
    const onToggle = vi.fn();
    const onAdd = vi.fn();
    const addable: PaneSpec[] = [{ key: "点検結果::all", title: "点検結果", subtitle: "点検.xlsx", sheet: "点検結果", scope: { kind: "all" } }];
    await act(async () =>
      root.render(
        createElement(PaneBar, {
          panes: [pane("工事管理::parent", "工事管理", true), pane("ロケーション::all", "ロケーション", false), pane("範囲::all", "範囲", true, true)],
          addable,
          onToggle,
          onAdd,
        }),
      ),
    );
    const chips = qa<HTMLButtonElement>(".pane-chip");
    expect(chips.map((c) => [c.textContent, c.getAttribute("aria-pressed")])).toEqual([
      ["工事管理", "true"],
      ["ロケーション", "false"],
      ["範囲", "true"],
    ]);
    expect(chips[2]!.classList.contains("extra")).toBe(true);
    await act(async () => chips[1]!.click());
    expect(onToggle).toHaveBeenCalledWith("ロケーション::all");

    // メニュー（Carbon の Menu）は body に出るので、document から探す
    const menu = () => document.querySelector('[role="menu"]');
    expect(menu()).toBeNull();
    await act(async () => q<HTMLButtonElement>('.pane-add > button[aria-haspopup="true"]')!.click());
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.map((i) => i.textContent)).toEqual(["点検結果点検.xlsx"]);
    await act(async () => items[0]!.click());
    expect(onAdd).toHaveBeenCalledWith("点検結果::all");
    expect(menu()).toBeNull();
  });

  it("足せる表が無ければ「表を足す」を出さない", async () => {
    await act(async () => root.render(createElement(PaneBar, { panes: [pane("a::all", "A", true), pane("b::all", "B", true)], addable: [], onToggle: () => {}, onAdd: () => {} })));
    expect(q(".pane-add")).toBeNull();
  });
});

describe("ペインの見出しの隠す・つかむ所（PaneHeader）", () => {
  const base = { title: "工事管理", subtitle: "MXAPIWO", current: true, rowCount: "10 行", rowCountTitle: "", detailOpen: false, onToggleDetail: () => {} };

  it("隠すを押すと onHide を呼び、見出しの選択（onSelect）は呼ばない。つかむ所はペインのキーを渡す", async () => {
    const onHide = vi.fn();
    const onSelect = vi.fn();
    await act(async () => root.render(createElement(PaneHeader, { ...base, onSelect, onHide, dragKey: "工事管理::parent" })));
    await act(async () => q<HTMLButtonElement>('button[aria-label="隠す"]')!.click());
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();

    const grip = q<HTMLElement>(".pane-grip")!;
    expect(grip.getAttribute("draggable")).toBe("true");
    const data = new Map<string, string>();
    const ev = new Event("dragstart", { bubbles: true }) as Event & { dataTransfer: unknown };
    Object.defineProperty(ev, "dataTransfer", { value: { setData: (t: string, v: string) => data.set(t, v), effectAllowed: "" } });
    await act(async () => grip.dispatchEvent(ev));
    expect(data.get(PANE_DRAG_TYPE)).toBe("工事管理::parent");
  });

  it("ペインが 1 つだけのとき（dragKey・onHide を省く）は、つかむ所も隠すも出さない", async () => {
    await act(async () => root.render(createElement(PaneHeader, { ...base, onSelect: () => {} })));
    expect(q(".pane-grip")).toBeNull();
    expect(q('button[aria-label="隠す"]')).toBeNull();
  });
});

describe("窓の間の境目（PaneSplitters）", () => {
  const split = { col: 0.5, row: 0.5 };

  it("枚数に応じて境目を出す（1 枚は無し、2 枚は左右、3・4 枚は左右と上下）", async () => {
    const count = async (n: number) => {
      await act(async () => root.render(createElement(PaneSplitters, { count: n, split, onChange: () => {} })));
      return qa('[role="separator"]').map((e) => e.getAttribute("aria-orientation"));
    };
    expect(await count(1)).toEqual([]);
    expect(await count(2)).toEqual(["vertical"]);
    expect(await count(4)).toEqual(["horizontal", "vertical"]);
  });

  it("矢印キーで動かし、ダブルクリックで半分ずつに戻す", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(createElement(PaneSplitters, { count: 4, split: { col: 0.3, row: 0.5 }, onChange })));
    const col = q<HTMLElement>('[aria-orientation="vertical"]')!;
    expect(col.getAttribute("aria-valuenow")).toBe("30");
    await act(async () => col.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(onChange.mock.calls[0]?.[0].col).toBeCloseTo(0.35);
    expect(onChange.mock.calls[0]?.[0].row).toBe(0.5);
    const row = q<HTMLElement>('[aria-orientation="horizontal"]')!;
    await act(async () => row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(onChange.mock.calls[1]?.[0].row).toBeCloseTo(0.45);
    await act(async () => col.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(onChange.mock.calls[2]?.[0]).toEqual({ col: 0.5, row: 0.5 });
  });
});
