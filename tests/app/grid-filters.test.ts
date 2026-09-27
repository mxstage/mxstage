// グリッドの列ごとの絞り込み（純ロジック）。
// 読み込んだシートの中だけを絞る。Maximo へ問い合わせ直さないので、反映の対象は変わらない。

import { describe, expect, it } from "vitest";
import { applyGridFilters, changeCounts, distinctValues, filterLabel, matchesFilter, matchRange, setFilter, type ChangeKind, type GridFilter } from "../../src/app/grid/filters";

interface Row {
  values: Record<string, string>;
}

const rows: Row[] = [
  { values: { STATUS: "作成中", ASSETNUM: "A10001", DESCRIPTION: "P-2507B動作不良の件" } },
  { values: { STATUS: "作成中", ASSETNUM: "A10002", DESCRIPTION: "FT-100指示不良の件" } },
  { values: { STATUS: "承認済み", ASSETNUM: "A10001", DESCRIPTION: "" } },
  { values: { STATUS: "工事完了", ASSETNUM: "", DESCRIPTION: "所内水銀灯更新工事" } },
];
const valueOf = (row: Row, col: string) => row.values[col] ?? "";

describe("列の絞り込み", () => {
  it("「文字を含む」で当たった位置を、元の文字列の位置で返す（セルに印を付けるため）", () => {
    expect(matchRange("P-2507B動作不良の件", "不良")).toEqual({ start: 9, end: 11 });
    // 全角・大文字小文字の違いを越えて当たり、位置は元の文字列のもの
    expect(matchRange("ＦＴ－１００指示不良", "ft-100")).toEqual({ start: 0, end: 6 });
    expect(matchRange("A10001", "a1000")).toEqual({ start: 0, end: 5 });
    // 当たらない・空の検索語は null
    expect(matchRange("所内水銀灯更新工事", "ポンプ")).toBeNull();
    expect(matchRange("所内水銀灯", "")).toBeNull();
    // サロゲートペア（𠮷）の後ろでも位置がずれない
    expect(matchRange("𠮷野家の件", "件")).toEqual({ start: 5, end: 6 });
  });

  it("文字を含む（全角半角・大文字小文字を区別しない）", () => {
    expect(matchesFilter("A10001", { col: "ASSETNUM", kind: "contains", text: "a1000" })).toBe(true);
    expect(matchesFilter("A10001", { col: "ASSETNUM", kind: "contains", text: "Ａ１０００１" })).toBe(true);
    expect(matchesFilter("A10001", { col: "ASSETNUM", kind: "contains", text: "AS9" })).toBe(false);
  });

  it("値を選ぶ・空・空でない", () => {
    expect(applyGridFilters(rows, [{ col: "STATUS", kind: "values", values: ["作成中", "工事完了"] }], valueOf)).toHaveLength(3);
    expect(applyGridFilters(rows, [{ col: "DESCRIPTION", kind: "empty" }], valueOf)).toHaveLength(1);
    expect(applyGridFilters(rows, [{ col: "ASSETNUM", kind: "notEmpty" }], valueOf)).toHaveLength(3);
    // 空白だけの値も空とみなす
    expect(matchesFilter("  ", { col: "X", kind: "empty" })).toBe(true);
  });

  it("複数の列の絞り込みは、すべてに当たる行だけを残す", () => {
    const filters: GridFilter[] = [
      { col: "STATUS", kind: "values", values: ["作成中"] },
      { col: "DESCRIPTION", kind: "contains", text: "不良" },
    ];
    expect(applyGridFilters(rows, filters, valueOf).map((r) => r.values.ASSETNUM)).toEqual(["A10001", "A10002"]);
    expect(applyGridFilters(rows, [], valueOf)).toHaveLength(4);
  });

  it("候補は多い順に返す（空も候補に入れる）", () => {
    expect(distinctValues(rows, "ASSETNUM", valueOf)).toEqual([
      { value: "A10001", count: 2 },
      { value: "", count: 1 },
      { value: "A10002", count: 1 },
    ]);
    expect(distinctValues(rows, "STATUS", valueOf, 1)).toEqual([{ value: "作成中", count: 2 }]);
  });

  it("同じ列の絞り込みは 1 つに置き換え、null で外す", () => {
    const a: GridFilter = { col: "STATUS", kind: "values", values: ["作成中"] };
    const b: GridFilter = { col: "STATUS", kind: "contains", text: "承認" };
    expect(setFilter([a], b, "STATUS")).toEqual([b]);
    expect(setFilter([a], null, "STATUS")).toEqual([]);
    expect(setFilter([a], { col: "ASSETNUM", kind: "notEmpty" }, "ASSETNUM")).toHaveLength(2);
  });

  it("変更の状態で絞る（区分はセルの色分けと同じ）。changeOf を渡さなければ、どのセルも変更なし", () => {
    // STATUS 列だけ、A10001 の行は LLM が、A10002 の行は利用者が変えた
    const byAsset: Record<string, ChangeKind> = { A10001: "llm", A10002: "user" };
    const changeOf = (row: Row, col: string): ChangeKind => (col === "STATUS" ? (byAsset[row.values.ASSETNUM ?? ""] ?? "none") : "none");
    const only = (changes: ChangeKind[], col = "STATUS") => applyGridFilters(rows, [{ col, kind: "change", changes }], valueOf, changeOf);
    expect(only(["llm"])).toHaveLength(2);
    expect(only(["llm", "user"])).toHaveLength(3);
    expect(only(["none"])).toHaveLength(1);
    expect(only(["llm"], "DESCRIPTION")).toHaveLength(0);
    expect(applyGridFilters(rows, [{ col: "STATUS", kind: "change", changes: ["none"] }], valueOf)).toHaveLength(4);
    // 値の絞り込みと重ねられる
    expect(applyGridFilters(rows, [{ col: "STATUS", kind: "change", changes: ["llm"] }, { col: "DESCRIPTION", kind: "notEmpty" }], valueOf, changeOf)).toHaveLength(1);
    expect(changeCounts(rows, "STATUS", changeOf)).toEqual([
      { kind: "llm", count: 2 },
      { kind: "user", count: 1 },
      { kind: "added", count: 0 },
      { kind: "deleted", count: 0 },
      { kind: "none", count: 1 },
    ]);
  });

  it("札の文言", () => {
    expect(filterLabel({ col: "STATUS", kind: "change", changes: ["llm", "user"] })).toBe("STATUS: LLM の変更・利用者の変更");
    expect(filterLabel({ col: "STATUS", kind: "values", values: ["作成中"] })).toBe("STATUS: 作成中");
    expect(filterLabel({ col: "STATUS", kind: "values", values: ["作成中", "承認済み"] })).toBe("STATUS: 2 個の値");
    expect(filterLabel({ col: "ASSETNUM", kind: "values", values: [""] })).toBe("ASSETNUM: （空）");
    expect(filterLabel({ col: "DESCRIPTION", kind: "contains", text: "不良" })).toBe("DESCRIPTION: 「不良」を含む");
    expect(filterLabel({ col: "DESCRIPTION", kind: "contains", text: "不良" }, "要約")).toBe("要約: 「不良」を含む");
    expect(filterLabel({ col: "ASSETNUM", kind: "empty" })).toBe("ASSETNUM: 空");
    expect(filterLabel({ col: "ASSETNUM", kind: "notEmpty" })).toBe("ASSETNUM: 空でない");
  });
});
