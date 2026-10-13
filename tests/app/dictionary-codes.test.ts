// 言葉 → コード（classify）と値の置き換え（replace）の辞書。当てはめの部品と、apply_rule・効いた行。
import { describe, expect, it } from "vitest";
import { MatchViewStore } from "../../src/app/match/views";
import { Workspace } from "../../src/app/store";
import { StoreError } from "../../src/app/store/errors";
import { classifyText, compileCodes, compileValues, entryProblem, normalizeRegexPattern, replaceValue } from "../../src/shared/dictionary";
import { DICT_COLUMN, DICT_FIELD, DICT_FIND, DICT_MODE, DICT_SCOPE, DICT_TO } from "../../src/shared/dictionarySheet";
import type { CellValue } from "../../src/shared/model";
import { makeChildRowKey, makeParentKey } from "../../src/shared/sheet";

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

// 日報で決めたコードを、作業指示の故障報告（子行）に写す（add_rows の from に parent）
const FR = "FAILUREREPORT";
function woSheet(ws: Workspace) {
  const cols = [
    { name: "SITEID", type: "string" as const },
    { name: "WONUM", type: "string" as const },
    { name: "DESCRIPTION", type: "string" as const },
    { name: `${FR}.FAILUREREPORTID`, type: "integer" as const, child: FR },
    { name: `${FR}.TYPE`, type: "string" as const, child: FR },
    { name: `${FR}.FAILURECODE`, type: "string" as const, child: FR },
  ];
  const p = (wonum: string) => ({ SITEID: "KITA", WONUM: wonum, DESCRIPTION: wonum });
  const pk = (wonum: string) => makeParentKey(["KITA", wonum]);
  const empty = { [`${FR}.FAILUREREPORTID`]: null, [`${FR}.TYPE`]: null, [`${FR}.FAILURECODE`]: null };
  ws.createSheet(
    { name: "作業指示", source: { kind: "maximo", os: "MXAPIWODETAIL", select: ["*"], where: [] }, columns: cols, keyColumns: ["SITEID", "WONUM"], childIdAttrs: { [FR]: "FAILUREREPORTID" } },
    [
      { rowKey: pk("100"), parentKey: pk("100"), childName: null, values: { ...p("100"), ...empty } },
      { rowKey: pk("200"), parentKey: pk("200"), childName: null, values: { ...p("200"), ...empty } },
      // 300 には問題の行がもうある（LEAK）
      { rowKey: makeChildRowKey(pk("300"), FR, 1), parentKey: pk("300"), childName: FR, values: { ...p("300"), [`${FR}.FAILUREREPORTID`]: 1, [`${FR}.TYPE`]: "PROBLEM", [`${FR}.FAILURECODE`]: "LEAK" } },
      { rowKey: pk("400"), parentKey: pk("400"), childName: null, values: { ...p("400"), ...empty } },
    ],
  );
}
function linkedReport(ws: Workspace) {
  const cols = ["ROW", "WONUM", "PROBLEM", "REMEDY"];
  const data: Array<Record<string, CellValue>> = [
    { ROW: "1", WONUM: "100", PROBLEM: "LEAK", REMEDY: "RETIGHT" },
    { ROW: "2", WONUM: "100", PROBLEM: "LEAK", REMEDY: null }, // 同じ作業指示・同じ問題は 1 行にまとめる
    { ROW: "3", WONUM: 200, PROBLEM: "NOISE", REMEDY: null }, // 数の 200 も文字の 200 と同じ
    { ROW: "4", WONUM: "200", PROBLEM: "VIBR", REMEDY: null }, // 200 は問題が分かれる
    { ROW: "5", WONUM: "300", PROBLEM: "CLOG", REMEDY: null }, // 300 は違う問題がもうある
    { ROW: "6", WONUM: "999", PROBLEM: "LEAK", REMEDY: null }, // 作業指示が無い
    { ROW: "7", WONUM: null, PROBLEM: "LEAK", REMEDY: null }, // 結べていない行
    { ROW: "8", WONUM: "400", PROBLEM: null, REMEDY: null }, // コードが決まらなかった行
  ];
  ws.createSheet(
    { name: "日報", source: { kind: "excel", importId: "i", fileName: "f.xlsx", sheetName: "5月", headerRow: 1 }, columns: cols.map((n) => ({ name: n, type: "string" as const })), keyColumns: ["ROW"], childIdAttrs: {} },
    data.map((v) => ({ rowKey: String(v.ROW), parentKey: String(v.ROW), childName: null, values: v })),
  );
}

describe("add_rows の from に parent: 別のシートの行から子行を作る", () => {
  it("親ごとにまとめ、1 つに決まる親だけに足す。もうある行・分かれた親・違う値がある親は足さずに数える", () => {
    const ws = new Workspace("作業");
    woSheet(ws);
    linkedReport(ws);
    const spec = { sheet: "日報", parent: { WONUM: "WONUM" }, columns: { [`${FR}.FAILURECODE`]: "PROBLEM" }, values: { [`${FR}.TYPE`]: "PROBLEM" }, onePerParent: true };
    const { groups, stats } = ws.childRowsFrom("作業指示", spec);
    expect(stats).toMatchObject({ sourceRows: 8, noValue: 1, noParent: 1, parentNotFound: 1, parents: 3, added: 1, split: 1, differs: 1, alreadyThere: 0 });
    expect(stats.parentNotFoundSamples).toEqual(["999"]);
    expect(groups).toEqual([{ parentRowKey: makeParentKey(["KITA", "100"]), rows: [{ [`${FR}.FAILURECODE`]: "LEAK", [`${FR}.TYPE`]: "PROBLEM" }] }]);
    const res = ws.addChildRows("作業指示", groups, { author: "llm", reason: "問題コード" });
    expect(res.applied).toBe(1);
    // 2 回目は、もうあるので足さない
    expect(ws.childRowsFrom("作業指示", spec).stats).toMatchObject({ added: 0, alreadyThere: 1 });
    // onePerParent が無ければ、分かれた値も 1 行ずつ足す（同じ値はまとめる）
    const each = ws.childRowsFrom("作業指示", { ...spec, onePerParent: false });
    expect(each.stats).toMatchObject({ added: 3, alreadyThere: 1 });
  });

  it("親の列・子の列の取り違えは invalid_args", () => {
    const ws = new Workspace("作業");
    woSheet(ws);
    linkedReport(ws);
    expect(() => ws.childRowsFrom("作業指示", { sheet: "日報", parent: { WONUM: "WONUM" }, columns: { DESCRIPTION: "PROBLEM" } })).toThrow(/child columns/);
    expect(() => ws.childRowsFrom("作業指示", { sheet: "日報", parent: { [`${FR}.TYPE`]: "WONUM" }, columns: { [`${FR}.FAILURECODE`]: "PROBLEM" } })).toThrow(/parent columns/);
    expect(() => ws.childRowsFrom("作業指示", { sheet: "日報", parent: { WONUM: "WONUM" }, columns: { [`${FR}.FAILURECODE`]: "なし" } })).toThrow(StoreError);
  });
});

describe("lookup: 候補が複数でも、写す値が 1 つなら決まる", () => {
  it("同じ作業指示の日報の行がどれも同じコードなら入れ、分かれたら入れない（空の行は数えない）", () => {
    const ws = new Workspace("作業");
    woSheet(ws);
    linkedReport(ws);
    const res = ws.applyRule("作業指示", [], { DESCRIPTION: { lookup: { sheet: "日報", matchCol: "WONUM", targetMatchCol: "WONUM", sourceCol: "PROBLEM" } } }, { author: "llm", reason: "問題コードを写す" });
    const wo = ws.getSheet("作業指示");
    const v = (wonum: string) => wo.finalValue(wo.group(makeParentKey(["KITA", wonum]))[0]!, "DESCRIPTION");
    expect([v("100"), v("200"), v("300")]).toEqual(["LEAK", "200", "CLOG"]);
    expect(v("400")).toBe("400"); // 相手の値が空なら変えない
    expect(res.lookup).toEqual({ DESCRIPTION: { matched: 2, unmatched: 1, ambiguous: 1 } });
  });
});

describe("正規表現の項目の全角の記号", () => {
  it("全角の「（」は文字のまま（半角にしてもグループの始まりにしない）", () => {
    expect(normalizeRegexPattern("^(\\d{1,2})/(\\d{1,2})（")).toBe("^(\\d{1,2})/(\\d{1,2})\\(");
    expect(normalizeRegexPattern("Ｎｏ．(\\d)")).toBe("No\\.(\\d)");
    expect(entryProblem({ find: "^(\\d{1,2})/(\\d{1,2})（", to: "令和8年$1月$2日（", mode: "regex" }, "value")).toBe(null);
    const { rules } = compileValues([{ id: "d", find: "^(\\d{1,2})/(\\d{1,2})（", to: "令和8年$1月$2日（", mode: "regex", column: "WORKDATE" }]);
    expect(replaceValue(rules, "WORKDATE", "5/22（金）")).toEqual({ kind: "value", value: "令和8年5月22日(金)", applied: ["d"] });
  });

  it("使えない項目は dictionaryProblems で分かる", () => {
    const ws = new Workspace("作業");
    dictionarySheet(ws, "日付", "value", [
      { [DICT_FIND]: "(a+)+", [DICT_MODE]: "regex", [DICT_TO]: "x" },
      { [DICT_FIND]: "5/22", [DICT_TO]: "2026-05-22" },
    ]);
    expect(ws.dictionaryProblems("日付")).toEqual([{ rowKey: "e_1", find: "(a+)+", problem: "regex_slow" }]);
    expect(ws.dictionaryProblems("無い辞書")).toEqual([]);
  });
});

describe("別のシートから写す日付は、台帳の書き方（和暦・年月だけ）でも読む", () => {
  function sheets(ws: Workspace) {
    ws.createSheet(
      { name: "資産", source: { kind: "maximo", os: "MXAPIASSET", select: ["*"], where: [] }, columns: [{ name: "ASSETNUM", type: "string" }, { name: "INSTALLDATE", type: "date" }], keyColumns: ["ASSETNUM"], childIdAttrs: {} },
      ["A1", "A2", "A3"].map((a) => ({ rowKey: a, parentKey: a, childName: null, values: { ASSETNUM: a, INSTALLDATE: null } })),
    );
    ws.createSheet(
      { name: "台帳", source: { kind: "excel", importId: "i", fileName: "f.xlsx", sheetName: "北部", headerRow: 1 }, columns: [{ name: "ASSETNUM", type: "string" }, { name: "設置年月", type: "string" }], keyColumns: ["ASSETNUM"], childIdAttrs: {} },
      [
        { rowKey: "1", parentKey: "1", childName: null, values: { ASSETNUM: "A1", 設置年月: "H17.11" } },
        { rowKey: "2", parentKey: "2", childName: null, values: { ASSETNUM: "A2", 設置年月: "平成18年2月" } },
        { rowKey: "3", parentKey: "3", childName: null, values: { ASSETNUM: "A3", 設置年月: "2005/11" } },
      ],
    );
  }

  it("lookup で写すと YYYY-MM-DD（日が無ければ 1 日）。AI が直接書く値は今までどおりの書き方だけ", () => {
    const ws = new Workspace("作業");
    sheets(ws);
    const res = ws.applyRule("資産", [], { INSTALLDATE: { lookup: { sheet: "台帳", matchCol: "ASSETNUM", targetMatchCol: "ASSETNUM", sourceCol: "設置年月" } } }, { author: "llm" });
    expect(res.conflicts).toEqual([]);
    const a = ws.getSheet("資産");
    expect(["A1", "A2", "A3"].map((k) => a.finalValue(a.row(k)!, "INSTALLDATE"))).toEqual(["2005-11-01", "2006-02-01", "2005-11-01"]);
    const direct = ws.applyEdits("資産", [{ rowKey: "A1", col: "INSTALLDATE", value: "H17.12" }], { author: "llm" });
    expect(direct.conflicts).toEqual([{ rowKey: "A1", col: "INSTALLDATE", reason: "invalid_value" }]);
  });
});

describe("別のシートから写す金額・有無は、帳票の書き方でも読む", () => {
  it("lookup で写すと ¥・カンマ・千円・万円を数に、○・× を真偽に。AI が直接書く値は今までどおり", () => {
    const ws = new Workspace("作業");
    ws.createSheet(
      { name: "作業指示", source: { kind: "maximo", os: "MXAPIWO", select: ["*"], where: [] }, columns: [{ name: "WONUM", type: "string" }, { name: "EXT_ORDERAMT", type: "number" }, { name: "EXT_LEGAL", type: "boolean" }], keyColumns: ["WONUM"], childIdAttrs: {} },
      ["W1", "W2", "W3"].map((w) => ({ rowKey: w, parentKey: w, childName: null, values: { WONUM: w, EXT_ORDERAMT: null, EXT_LEGAL: null } })),
    );
    ws.createSheet(
      { name: "発注一覧", source: { kind: "excel", importId: "i", fileName: "f.xlsx", sheetName: "s", headerRow: 1 }, columns: ["WONUM", "発注額", "法規"].map((n) => ({ name: n, type: "string" as const })), keyColumns: ["WONUM"], childIdAttrs: {} },
      [
        { rowKey: "1", parentKey: "1", childName: null, values: { WONUM: "W1", 発注額: "137.0万円", 法規: "○" } },
        { rowKey: "2", parentKey: "2", childName: null, values: { WONUM: "W2", 発注額: "¥220,000", 法規: "×" } },
        { rowKey: "3", parentKey: "3", childName: null, values: { WONUM: "W3", 発注額: "180千円", 法規: "-" } },
      ],
    );
    const lk = (sourceCol: string) => ({ lookup: { sheet: "発注一覧", matchCol: "WONUM", targetMatchCol: "WONUM", sourceCol } });
    const res = ws.applyRule("作業指示", [], { EXT_ORDERAMT: lk("発注額"), EXT_LEGAL: lk("法規") }, { author: "llm" });
    const s = ws.getSheet("作業指示");
    const v = (w: string, c: string) => s.finalValue(s.row(w)!, c);
    expect([v("W1", "EXT_ORDERAMT"), v("W2", "EXT_ORDERAMT"), v("W3", "EXT_ORDERAMT")]).toEqual([1370000, 220000, 180000]);
    expect([v("W1", "EXT_LEGAL"), v("W2", "EXT_LEGAL")]).toEqual([true, false]);
    // 「-」は有無として読めない
    expect(res.conflicts).toEqual([{ rowKey: "W3", col: "EXT_LEGAL", reason: "invalid_value" }]);
    expect(ws.applyEdits("作業指示", [{ rowKey: "W1", col: "EXT_ORDERAMT", value: "12万円" }], { author: "llm" }).conflicts).toHaveLength(1);
  });
});
