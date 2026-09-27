// 行の詳細（選んだ 1 行の全列を縦に並べる）。長文・改行と空の列の出方を確かめる。
// グリッド本体は canvas なので、詳細は DOM で出している（RowDetail.tsx）。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TONE_STYLE } from "../../src/app/grid/cellStyle";
import { RowDetail } from "../../src/app/grid/RowDetail";
import { rowDetailItems } from "../../src/app/grid/detailItems";
import type { ColumnSchema } from "../../src/shared/model";

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

const col = (name: string, title?: string): ColumnSchema => (title === undefined ? { name, type: "string" } : { name, title, type: "string" });
const COLUMNS = [col("WONUM"), col("DESCRIPTION", "説明"), col("EXT_WORKDETAIL", "作業内容（詳細）"), col("EXT_NOTES", "備考")];
const VALUES: Record<string, string> = {
  WONUM: "WO101001",
  DESCRIPTION: "P-2501B 動作不良の件",
  EXT_WORKDETAIL: "分解点検を行う。\n復旧後に試運転を行う",
  EXT_NOTES: "",
};

async function render(changed: Partial<Record<string, "llm" | "user">> = {}): Promise<void> {
  const items = rowDetailItems(COLUMNS, (c) => {
    const author = changed[c];
    return author === undefined ? { value: VALUES[c] ?? "", changed: false } : { value: VALUES[c] ?? "", changed: true, author };
  });
  await act(async () => root.render(createElement(RowDetail, { title: "BEDFORD / WO101001", items })));
}

describe("RowDetail", () => {
  it("ラベルを出し、属性名はマウスを置いたときに出す", async () => {
    await render();
    const labels = Array.from(container.querySelectorAll(".item dt .label")).map((e) => e.textContent);
    const attrs = Array.from(container.querySelectorAll(".item dt")).map((e) => e.getAttribute("title"));
    expect(labels).toContain("作業内容（詳細）");
    expect(attrs).toContain("EXT_WORKDETAIL");
    // ラベルの無い列は属性名を見出しにし、属性名を重ねて出さない
    expect(labels).toContain("WONUM");
    expect(attrs).not.toContain("WONUM");
  });

  it("改行を含む長文をそのまま出し、幅いっぱいの扱いにする", async () => {
    await render();
    const long = container.querySelector(".item.long dd");
    expect(long?.textContent).toBe("分解点検を行う。\n復旧後に試運転を行う");
  });

  it("空の列は（空）と出して後ろにまとめる", async () => {
    await render();
    const names = Array.from(container.querySelectorAll(".item dt .label")).map((e) => e.textContent);
    expect(names[names.length - 1]).toBe("備考");
    expect(container.querySelector(".item.blank dd")?.textContent).toBe("（空）");
  });

  it("値の入っている列数を出す", async () => {
    await render();
    expect(container.textContent).toContain("3 / 4 列に値");
  });

  it("閉じるボタンは置かない（ペインの見出しのボタンで開け閉めする）", async () => {
    await render();
    expect(container.querySelector("button")).toBeNull();
  });

  it("変更したセルは背景を塗らず、文字を作者の色で出す", async () => {
    await render({ DESCRIPTION: "llm", EXT_WORKDETAIL: "user" });
    const dd = (name: string) =>
      Array.from(container.querySelectorAll<HTMLElement>(".item")).find((i) => i.querySelector(".label")?.textContent === name)?.querySelector<HTMLElement>("dd");
    expect(dd("説明")?.style.color).toBe(colorOf(TONE_STYLE.llm.fg));
    expect(dd("作業内容（詳細）")?.style.color).toBe(colorOf(TONE_STYLE.user.fg));
    expect(dd("WONUM")?.style.color).toBe("");
  });
});

/** style.color に入れた色が読み戻される形（happy-dom は #rrggbb のまま、ブラウザは rgb() になる） */
function colorOf(hex: string): string {
  const probe = document.createElement("span");
  probe.style.color = hex;
  return probe.style.color;
}
