// 呼び名の辞書の検査と当てはめ（src/shared/dictionary.ts）。
import { describe, expect, it } from "vitest";
import { applyAliases, compileAliases, entryProblem, parseEntryMode } from "../../src/shared/dictionary";

const e = (id: string, find: string, to: string, mode: "text" | "regex" = "text") => ({ id, find, to, mode });

describe("呼び名の当てはめ", () => {
  it("正しい名前がすでに書かれている所は読み替えない（ごみクレ → ごみクレーン）", () => {
    const { rules } = compileAliases([e("a", "ごみクレ", "ごみクレーン"), e("b", "B号", "B号機")]);
    expect(applyAliases(rules, "ごみクレ A号機 異音").text).toBe("ごみクレーン A号機 異音");
    expect(applyAliases(rules, "ごみクレーン A号機 異音").text).toBe("ごみクレーン A号機 異音");
    expect(applyAliases(rules, "温水循環ポンプB号 漏れ").text).toBe("温水循環ポンプB号機 漏れ");
    expect(applyAliases(rules, "温水循環ポンプB号機 漏れ")).toEqual({ text: "温水循環ポンプB号機 漏れ", applied: [] });
  });

  it("全角・半角と空白の有無、英字の大小を気にしない。長い書き方を先に当てる", () => {
    const { rules } = compileAliases([e("short", "ポンプA", "ポンプ A号機"), e("long", "温水循環ポンプ A", "温水循環ポンプ A号機")]);
    const r = applyAliases(rules, "温水循環ポンプＡ 漏れ");
    expect(r).toEqual({ text: "温水循環ポンプ A号機 漏れ", applied: ["long"] });
    const no = compileAliases([e("n", "no.3 hcl計", "3号炉 HCL計")]).rules;
    expect(applyAliases(no, "ＮＯ．３ ＨＣＬ計 指示異常").text).toBe("3号炉 HCL計 指示異常");
  });

  it("正規表現は $1 で置き換え、そのままの項目のあとに当てる", () => {
    const { rules } = compileAliases([e("re", "#(\\d)", "$1号炉", "regex"), e("t", "スートブロワ", "スートブロワ")]);
    expect(applyAliases(rules, "#3 スートブロワ No.6").text).toBe("3号炉 スートブロワ No.6");
    expect(applyAliases(rules, "＃３ スートブロワ").applied).toEqual(["re"]);
  });

  it("使えない項目は当てはめずに返す", () => {
    const { rules, problems } = compileAliases([e("ok", "a", "b"), e("bad", "(ポンプ", "x", "regex"), e("slow", "(a+)+", "x", "regex"), e("empty", "x*", "y", "regex"), e("blank", " ", "x")]);
    expect(rules.map((r) => r.id)).toEqual(["ok"]);
    expect(problems.map((p) => [p.id, p.problem.code])).toEqual([
      ["bad", "regex_invalid"],
      ["slow", "regex_slow"],
      ["empty", "regex_empty_match"],
      ["blank", "find_empty"],
    ]);
  });

  it("合わせ方の書き方と、項目の検査", () => {
    expect(parseEntryMode("そのまま")).toBe("text");
    expect(parseEntryMode("正規表現")).toBe("regex");
    expect(parseEntryMode("REGEX")).toBe("regex");
    expect(parseEntryMode(null)).toBe("text");
    expect(parseEntryMode("あいまい")).toBe(null);
    expect(entryProblem({ find: "x".repeat(201), to: "", mode: "text" })).toEqual({ code: "find_too_long" });
    expect(entryProblem({ find: "x", to: "", mode: "あいまい" })).toEqual({ code: "mode_invalid" });
    expect(entryProblem({ find: "共通", to: "", mode: "text" })).toBe(null);
  });
});
