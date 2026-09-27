// 列の見出しに出す文字列（日本語ラベル＋属性名）と、行の詳細に並べる項目、狭い画面での固定列。

import { describe, expect, it } from "vitest";
import { columnLabel, columnTitleMap, headerLines } from "../../src/shared/columnLabel";
import { HOVER_MAX_CHARS, HOVER_MAX_LINES, isLongValue, longCellLines, rowDetailItems, sortDetailItems, LONG_VALUE_CHARS } from "../../src/app/grid/detailItems";
import { freezeCountForWidth, headerHeightFor, MEDIUM_WIDTH, NARROW_WIDTH } from "../../src/app/grid/layout";
import type { ColumnSchema } from "../../src/shared/model";

const col = (name: string, title?: string): ColumnSchema => (title === undefined ? { name, type: "string" } : { name, title, type: "string" });

describe("headerLines", () => {
  it("ラベルを上、属性名を下に出す", () => {
    expect(headerLines(col("EXT_WORKDETAIL", "作業内容（詳細）"))).toEqual({ main: "作業内容（詳細）", sub: "EXT_WORKDETAIL" });
  });

  it("ラベルが無ければ属性名だけ", () => {
    expect(headerLines(col("WONUM"))).toEqual({ main: "WONUM", sub: null });
  });

  it("ラベルが属性名と同じ・空白だけなら 1 段にする", () => {
    expect(headerLines(col("SITEID", "SITEID")).sub).toBeNull();
    expect(headerLines(col("SITEID", "   ")).sub).toBeNull();
  });

  it("子の列は属性名に子オブジェクト名を残す", () => {
    expect(headerLines(col("MULTIASSETLOCCI.ASSETNUM", "資産"))).toEqual({ main: "資産", sub: "MULTIASSETLOCCI.ASSETNUM" });
  });

  it("1 行で書くときは括弧で添える", () => {
    expect(columnLabel(col("PERSONGROUP", "工事担当部署"))).toBe("工事担当部署（PERSONGROUP）");
    expect(columnLabel(col("WONUM"))).toBe("WONUM");
  });

  it("対応表はラベルのある列だけ", () => {
    expect(columnTitleMap([col("WONUM"), col("PERSONGROUP", "工事担当部署")])).toEqual({ PERSONGROUP: "工事担当部署" });
  });
});

describe("行の詳細", () => {
  const columns = [col("WONUM"), col("DESCRIPTION", "説明"), col("EXT_WORKDETAIL", "作業内容（詳細）")];
  const values: Record<string, string> = { WONUM: "WO101001", DESCRIPTION: "", EXT_WORKDETAIL: "分解点検を行う。\n復旧後に試運転を行う" };

  it("列の順のまま、ラベル・属性名・値・空かどうかを並べる", () => {
    const items = rowDetailItems(columns, (c) => ({ value: values[c] ?? "", changed: c === "EXT_WORKDETAIL" }));
    expect(items.map((i) => i.name)).toEqual(["WONUM", "DESCRIPTION", "EXT_WORKDETAIL"]);
    expect(items[0]).toMatchObject({ label: "WONUM", attr: null, value: "WO101001", empty: false, long: false });
    expect(items[1]).toMatchObject({ label: "説明", attr: "DESCRIPTION", empty: true });
    expect(items[2]).toMatchObject({ label: "作業内容（詳細）", attr: "EXT_WORKDETAIL", changed: true, long: true });
  });

  it("改行を含む値と長い値は長文として扱う", () => {
    expect(isLongValue("あ\nい")).toBe(true);
    expect(isLongValue("あ".repeat(LONG_VALUE_CHARS + 1))).toBe(true);
    expect(isLongValue("あ".repeat(LONG_VALUE_CHARS))).toBe(false);
    expect(isLongValue("")).toBe(false);
  });

  it("空の列は後ろにまとめる（値の入っている列から読める）", () => {
    const items = rowDetailItems(columns, (c) => ({ value: values[c] ?? "", changed: false }));
    expect(sortDetailItems(items).map((i) => i.name)).toEqual(["WONUM", "EXT_WORKDETAIL", "DESCRIPTION"]);
  });
});

describe("狭い画面での固定列", () => {
  it("狭いときは固定しない（固定列だけで埋まって中身が読めなくなるため）", () => {
    expect(freezeCountForWidth(NARROW_WIDTH - 1, 2)).toBe(0);
  });

  it("中くらいの幅では 1 本", () => {
    expect(freezeCountForWidth(NARROW_WIDTH, 2)).toBe(1);
    expect(freezeCountForWidth(MEDIUM_WIDTH - 1, 2)).toBe(1);
  });

  it("広ければキー列を 2 本まで固定する", () => {
    expect(freezeCountForWidth(MEDIUM_WIDTH, 2)).toBe(2);
    expect(freezeCountForWidth(1600, 1)).toBe(1);
  });

  it("キー列が無ければ固定しない。幅が未測定（0）なら広いものとして扱う", () => {
    expect(freezeCountForWidth(1600, 0)).toBe(0);
    expect(freezeCountForWidth(0, 2)).toBe(2);
  });

  it("2 段見出しがある表は見出しを高くする", () => {
    expect(headerHeightFor([col("WONUM"), col("PERSONGROUP", "工事担当部署")])).toBeGreaterThan(headerHeightFor([col("WONUM")]));
  });
});

describe("長文のセルにマウスを置いたとき", () => {
  it("短い値では吹き出しを出さない", () => {
    expect(longCellLines("WO101001")).toBeNull();
    expect(longCellLines("")).toBeNull();
  });

  it("改行を行に分けて返す", () => {
    expect(longCellLines("あ\nい\nう")).toEqual(["あ", "い", "う"]);
  });

  it("長すぎる値は文字数と行数で打ち切る", () => {
    const long = longCellLines("あ".repeat(HOVER_MAX_CHARS + 50));
    expect(long).not.toBeNull();
    expect((long as string[])[0]?.endsWith("…")).toBe(true);
    const many = longCellLines(Array.from({ length: HOVER_MAX_LINES + 5 }, (_, i) => `行${i}`).join("\n"));
    expect(many).toHaveLength(HOVER_MAX_LINES + 1);
    expect((many as string[])[HOVER_MAX_LINES]).toBe("…");
  });
});
