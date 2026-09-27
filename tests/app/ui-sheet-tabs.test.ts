// 上部バーのシートタブ: 選ぶ・閉じる。閉じるときは、反映中なら閉じず、未反映の変更があれば確かめる。

import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSheet, SheetTabs } from "../../src/app/pages/SheetTabs";
import { Workspace } from "../../src/app/store";
import { makeParentKey, type SheetMeta, type SheetRow } from "../../src/shared/sheet";

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

function assets(workspace: Workspace, name = "資産"): void {
  const meta: SheetMeta = {
    name,
    source: { kind: "maximo", os: "MXASSET", select: ["SITEID", "ASSETNUM", "DESCRIPTION"], where: [] },
    columns: [
      { name: "SITEID", type: "string", readOnly: true },
      { name: "ASSETNUM", type: "string", readOnly: true },
      { name: "DESCRIPTION", type: "string" },
    ],
    keyColumns: ["SITEID", "ASSETNUM"],
    childIdAttrs: {},
  };
  const rows: SheetRow[] = ["A5001", "A5002"].map((a) => {
    const rowKey = makeParentKey(["BEDFORD", a]);
    return { rowKey, parentKey: rowKey, childName: null, values: { SITEID: "BEDFORD", ASSETNUM: a, DESCRIPTION: "ポンプ" } };
  });
  workspace.createSheet(meta, rows);
}

describe("シートタブ（SheetTabs）", () => {
  it("タブを押すと選び、× を押すとそのシートを閉じる。変更の件数を出す", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        createElement(SheetTabs, {
          tabs: [
            { name: "資産", changes: 3, origin: "MXASSET から読み込み" },
            { name: "範囲 MXASSET", changes: 0 },
          ],
          current: "資産",
          onSelect,
          onClose,
        }),
      ),
    );
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(["資産3", "範囲 MXASSET"]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    await act(async () => tabs[1]!.click());
    expect(onSelect).toHaveBeenCalledWith("範囲 MXASSET");
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="シート 範囲 MXASSET を閉じる"]');
    await act(async () => close!.click());
    expect(onClose).toHaveBeenCalledWith("範囲 MXASSET");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("シートを閉じる（closeSheet）", () => {
  it("変更の無いシートは確かめずに閉じる", () => {
    const workspace = new Workspace("作業");
    assets(workspace);
    const confirm = vi.fn(() => true);
    expect(closeSheet("資産", { workspace, isRunning: () => false, confirm, notify: vi.fn() })).toBe(true);
    expect(workspace.hasSheet("資産")).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("未反映の変更があれば件数を示して確かめ、断られたら閉じない", () => {
    const workspace = new Workspace("作業");
    assets(workspace);
    workspace.applyEdits("資産", [{ rowKey: makeParentKey(["BEDFORD", "A5001"]), col: "DESCRIPTION", value: "ファン" }], { author: "user" });
    const no = vi.fn(() => false);
    expect(closeSheet("資産", { workspace, isRunning: () => false, confirm: no, notify: vi.fn() })).toBe(false);
    expect(no).toHaveBeenCalledWith(expect.stringContaining("未反映の変更が 1 件"));
    expect(workspace.hasSheet("資産")).toBe(true);
    expect(closeSheet("資産", { workspace, isRunning: () => false, confirm: () => true, notify: vi.fn() })).toBe(true);
    expect(workspace.hasSheet("資産")).toBe(false);
  });

  it("反映中のシートは閉じない", () => {
    const workspace = new Workspace("作業");
    assets(workspace);
    const notify = vi.fn();
    expect(closeSheet("資産", { workspace, isRunning: () => true, confirm: () => true, notify })).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("反映中"), "error");
    expect(workspace.hasSheet("資産")).toBe(true);
  });
});
