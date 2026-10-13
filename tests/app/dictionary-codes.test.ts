// 言葉 → コード（classify）と値の置き換え（replace）の辞書。当てはめの部品と、apply_rule・効いた行。
import { describe, expect, it } from "vitest";
import { MatchViewStore } from "../../src/app/match/views";
import { Workspace } from "../../src/app/store";
import { StoreError } from "../../src/app/store/errors";
import { classifyText, compileCodes, compileValues, entryProblem, replaceValue } from "../../src/shared/dictionary";
import { DICT_COLUMN, DICT_FIELD, DICT_FIND, DICT_MODE, DICT_SCOPE, DICT_TO } from "../../src/shared/dictionarySheet";
import type { CellValue } from "../../src/shared/model";

const code = (id: string, find: string, field: string, to: string, scope?: string, mode: "text" | "regex" = "text") => ({ id, find, field, to, mode, ...(scope ? { scope } : {}) });

describe("言葉 → コード", () => {
  const { rules } = compileCodes([
    code("leak", "漏れ", "PROBLEM", "LEAK"),
    code("noise", "異音", "PROBLEM", "NOISE"),
    code("gland", "グランド部より漏れ", "PROBLEM", "GLANDLEAK", "PUMP"),
    code("loose", "増締め", "REMEDY", "RETIGHT"),
    code("loose-c", "緩み", "CAUSE", "LOOSE", "LEAK, MALFUNC"),
    code("brg", "軸受(の)?(損傷|摩耗)", "CAUSE", "BRGDMG", undefined, "regex"),
  ]);

  it("1 つに決まればそのコード。長い言葉の中の短い言葉は数えない", () => {
    expect(classifyText(rules, "共通 ポンプ 異音", "PROBLEM", null)).toEqual({ kind: "code", code: "NOISE", applied: ["noise"] });
    // 「グランド部より漏れ」（PUMP だけ）が当たると、その中の「漏れ」は数えない
    expect(classifyText(rules, "温水循環ポンプB号 グランド部より漏れ", "PROBLEM", "PUMP")).toEqual({ kind: "code", code: "GLANDLEAK", applied: ["gland"] });
    // PUMP でない行では「グランド部より漏れ」は使わないので「漏れ」になる
    expect(classifyText(rules, "グランド部より漏れ", "PROBLEM", "VALVE")).toMatchObject({ kind: "code", code: "LEAK" });
  });

  it("2 つ以上のコードに分かれたら入れない。項目と絞り込みが合う項目だけを見る", () => {
    expect(classifyText(rules, "漏れ と 異音", "PROBLEM", null)).toEqual({ kind: "ambiguous", codes: ["LEAK", "NOISE"], applied: ["leak", "noise"] });
    expect(classifyText(rules, "パッキン 緩み 増締め", "REMEDY", null)).toMatchObject({ kind: "code", code: "RETIGHT" });
    expect(classifyText(rules, "パッキン 緩み", "CAUSE", "LEAK")).toMatchObject({ kind: "code", code: "LOOSE" });
    expect(classifyText(rules, "パッキン 緩み", "CAUSE", "NOISE")).toEqual({ kind: "none", applied: [] });
    expect(classifyText(rules, "部品交換（軸受の損傷）", "cause", null)).toMatchObject({ kind: "code", code: "BRGDMG" });
  });

  it("言葉 → コードの項目は、項目とコードが要る", () => {
    expect(entryProblem({ find: "漏れ", to: "LEAK", mode: "text" }, "code")).toEqual({ code: "field_empty" });
    expect(entryProblem({ find: "漏れ", to: "", mode: "text", field: "PROBLEM" }, "code")).toEqual({ code: "code_empty" });
    expect(entryProblem({ find: "漏れ", to: "LEAK", mode: "text", field: "PROBLEM" }, "code")).toBe(null);
  });
});

describe("値の置き換え", () => {
  const { rules } = compileValues([
    { id: "m1", find: "三菱電機(株)", to: "三菱電機", mode: "text", column: "MANUFACTURER" },
    { id: "m2", find: "三菱電機株式会社", to: "三菱電機", mode: "text" },
    { id: "k1", find: "kw", to: "kW", mode: "text" },
    { id: "k2", find: "KW", to: "キロワット", mode: "text", column: "UNIT" },
    { id: "r1", find: "\\s*\\(株\\)$", to: "", mode: "regex", column: "VENDOR" },
  ]);

  it("値全体が同じなら正しい値に。列を絞った項目はその列だけ", () => {
    expect(replaceValue(rules, "MANUFACTURER", "三菱電機（株）")).toEqual({ kind: "value", value: "三菱電機", applied: ["m1"] });
    expect(replaceValue(rules, "VENDOR", "三菱電機(株)")).toEqual({ kind: "value", value: "三菱電機", applied: ["r1"] });
    expect(replaceValue(rules, "OTHER", "三菱電機 株式会社")).toEqual({ kind: "none" });
    expect(replaceValue(rules, "OTHER", "三菱電機株式会社")).toMatchObject({ kind: "value", value: "三菱電機" });
    expect(replaceValue(rules, "MANUFACTURER", "三菱電機")).toEqual({ kind: "none" });
  });

  it("違う正しい値の項目が 2 つ当たれば変えない", () => {
    expect(replaceValue(rules, "UNIT", "Kw")).toEqual({ kind: "ambiguous", values: ["kW", "キロワット"], applied: ["k1", "k2"] });
    expect(replaceValue(rules, "POWER", "Kw")).toMatchObject({ kind: "value", value: "kW" });
  });
});

function dictionarySheet(ws: Workspace, name: string, kind: "alias" | "code" | "value", rows: Array<Record<string, CellValue>>) {
  const cols = [DICT_FIND, DICT_TO, DICT_MODE, DICT_FIELD, DICT_SCOPE, DICT_COLUMN];
  ws.createSheet(
    { name, source: { kind: "dictionary", dictionaryId: `d_${name}`, dictionaryName: name, dictKind: kind, scope: "c_0123456789abcdef" }, columns: cols.map((n) => ({ name: n, type: "string" as const })), keyColumns: [], childIdAttrs: {} },
    rows.map((v, i) => ({ rowKey: `e_${i + 1}`, parentKey: `e_${i + 1}`, childName: null, values: { [DICT_MODE]: "text", ...v } })),
  );
}

function reportSheet(ws: Workspace) {
  const cols = ["ID", "TEXT", "CLASS", "PROBLEM", "REMEDY", "MAKER"];
  const data: Array<Record<string, CellValue>> = [
    { ID: "1", TEXT: "ポンプ グランド部より漏れ 増締め", CLASS: "PUMP", PROBLEM: null, REMEDY: null, MAKER: "三菱電機(株)" },
    { ID: "2", TEXT: "送風機 異音", CLASS: "FAN", PROBLEM: null, REMEDY: null, MAKER: "日立" },
    { ID: "3", TEXT: "漏れ と 異音", CLASS: "PUMP", PROBLEM: null, REMEDY: null, MAKER: null },
    { ID: "4", TEXT: "巡視", CLASS: "", PROBLEM: null, REMEDY: null, MAKER: "三菱電機株式会社" },
  ];
  ws.createSheet(
    { name: "日報", source: { kind: "excel", importId: "i", fileName: "f.xlsx", sheetName: "5月", headerRow: 1 }, columns: cols.map((n) => ({ name: n, type: "string" as const })), keyColumns: ["ID"], childIdAttrs: {} },
    data.map((v) => ({ rowKey: String(v.ID), parentKey: String(v.ID), childName: null, values: v })),
  );
}

describe("apply_rule の classify と replace", () => {
  it("1 つに決まる行だけに入れ、2 つ以上は lookup_ambiguous。効いた行も数える", () => {
    const ws = new Workspace("作業");
    reportSheet(ws);
    dictionarySheet(ws, "故障の言葉", "code", [
      { [DICT_FIND]: "漏れ", [DICT_FIELD]: "PROBLEM", [DICT_TO]: "LEAK" },
      { [DICT_FIND]: "異音", [DICT_FIELD]: "PROBLEM", [DICT_TO]: "NOISE" },
      { [DICT_FIND]: "増締め", [DICT_FIELD]: "REMEDY", [DICT_TO]: "RETIGHT" },
    ]);
    dictionarySheet(ws, "メーカー名", "value", [{ [DICT_FIND]: "三菱電機(株)", [DICT_TO]: "三菱電機" }, { [DICT_FIND]: "三菱電機株式会社", [DICT_TO]: "三菱電機" }]);
    const res = ws.applyRule(
      "日報",
      [],
      {
        PROBLEM: { classify: { dictionary: "故障の言葉", textCol: "TEXT", field: "PROBLEM" } },
        REMEDY: { classify: { dictionary: "故障の言葉", textCol: ["TEXT"], field: "REMEDY" } },
        MAKER: { replace: { dictionary: "メーカー名" } },
      },
      { author: "llm", reason: "辞書で決める" },
    );
    expect(res.dictionary).toEqual({
      PROBLEM: { matched: 2, unmatched: 1, ambiguous: 1 },
      REMEDY: { matched: 1, unmatched: 3, ambiguous: 0 },
      MAKER: { matched: 2, unmatched: 2, ambiguous: 0 },
    });
    expect(res.conflicts).toEqual([{ rowKey: "3", col: "PROBLEM", reason: "lookup_ambiguous" }]);
    const v = (k: string, c: string) => ws.getSheet("日報").finalValue(ws.getSheet("日報").row(k)!, c);
    expect([v("1", "PROBLEM"), v("2", "PROBLEM"), v("3", "PROBLEM"), v("1", "REMEDY"), v("1", "MAKER"), v("4", "MAKER")]).toEqual(["LEAK", "NOISE", null, "RETIGHT", "三菱電機", "三菱電機"]);
    // 効いた行（最後に使ったシートの今の値から数える）
    const matches = new MatchViewStore(ws);
    matches.recordUse({ kind: "code", dictionary: "故障の言葉", sheet: "日報", col: "PROBLEM", textCols: ["TEXT"], field: "PROBLEM" });
    matches.recordUse({ kind: "value", dictionary: "メーカー名", sheet: "日報", col: "MAKER", fromCol: "MAKER" });
    expect(matches.hitsFor("故障の言葉").hits.get("e_1")).toEqual({ hits: 2, ambiguous: 1 });
    expect(matches.hitsFor("メーカー名")).toMatchObject({ used: true });
    matches.dispose();
  });

  it("種類の違う辞書は使えない", () => {
    const ws = new Workspace("作業");
    reportSheet(ws);
    dictionarySheet(ws, "呼び名", "alias", [{ [DICT_FIND]: "#3", [DICT_TO]: "3号炉" }]);
    let err: unknown;
    try {
      ws.applyRule("日報", [], { PROBLEM: { classify: { dictionary: "呼び名", textCol: "TEXT", field: "PROBLEM" } } }, { author: "llm" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).message).toContain("alias dictionary");
  });
});
