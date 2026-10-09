// 鍵の無い突合（日報の文と作業指示）: 置き換え・含む・日付の幅・相手の絞り込み・同じ帳票。
// 決まりは AI が作り、照合はタブ内で行う。候補が 1 件に決まる行だけを結ぶ。

import { describe, expect, it } from "vitest";
import type { MatchConditions, RuleValue } from "../../src/shared/model";
import type { SheetMeta, SheetRow } from "../../src/shared/sheet";
import { StoreError } from "../../src/app/store/errors";
import { dayOfCell } from "../../src/app/store/matcher";
import { Workspace } from "../../src/app/store/workspace";
import { TOOL_DEFS } from "../../src/shared/toolDefs";

function excelSheet(name: string, columns: string[], rows: Array<Record<string, string | null>>, key: string): [SheetMeta, SheetRow[]] {
  return [
    {
      name,
      source: { kind: "excel", importId: "imp1", fileName: `${name}.xlsx`, sheetName: "Sheet1", headerRow: 1 },
      columns: columns.map((c) => ({ name: c, type: "string" as const })),
      keyColumns: [key],
      childIdAttrs: {},
    },
    rows.map((values) => ({ rowKey: values[key] as string, parentKey: values[key] as string, childName: null, values })),
  ];
}

function maximoSheet(name: string, os: string, columns: string[], rows: Array<Record<string, string | null>>, key: string): [SheetMeta, SheetRow[]] {
  const [meta, data] = excelSheet(name, columns, rows, key);
  return [{ ...meta, source: { kind: "maximo", os, select: ["*"], where: [] } }, data];
}

// 日報（report）: 帳票番号・日付・作業内容。WONUM は空で、突合で入れる
const REPORT = excelSheet(
  "report",
  ["ID", "DOC", "DAY", "KIND", "TEXT", "WONUM"],
  [
    { ID: "r1", DOC: "D-1", DAY: "2026-05-11", KIND: "点検", TEXT: "#1 給じん装置 点検", WONUM: null },
    { ID: "r2", DOC: "D-1", DAY: "2026-05-11", KIND: "修理", TEXT: "3炉 押込送風機 異音 修理", WONUM: null },
    { ID: "r3", DOC: "D-1", DAY: "2026-05-12", KIND: "点検", TEXT: "2号炉 給じん装置 点検", WONUM: null },
    { ID: "r4", DOC: "R-7", DAY: "2026-05-13", KIND: "修理", TEXT: "1号炉 押込送風機 軸受交換", WONUM: null },
    { ID: "r5", DOC: "R-7", DAY: "2026-05-13", KIND: "修理", TEXT: "部品手配", WONUM: null },
    { ID: "r6", DOC: "D-2", DAY: "2026-05-20", KIND: "修理", TEXT: "ごみクレーン 不具合", WONUM: null },
    { ID: "r7", DOC: "D-2", DAY: "2026/5/21", KIND: "点検", TEXT: "1号炉 給じん装置 点検", WONUM: null },
    { ID: "r8", DOC: "D-2", DAY: "2026/5/21", KIND: "点検", TEXT: "同上 部品交換", WONUM: null },
  ],
  "ID",
);

const ASSETS = maximoSheet(
  "assets",
  "MXAPIASSET",
  ["ASSETNUM", "DESCRIPTION"],
  [
    { ASSETNUM: "A11", DESCRIPTION: "1号炉 給じん装置" },
    { ASSETNUM: "A12", DESCRIPTION: "1号炉 押込送風機" },
    { ASSETNUM: "A21", DESCRIPTION: "2号炉 給じん装置" },
    { ASSETNUM: "A32", DESCRIPTION: "3号炉 押込送風機" },
    { ASSETNUM: "AX", DESCRIPTION: "炉" },
  ],
  "ASSETNUM",
);

const WOS = maximoSheet(
  "wo",
  "MXAPIWODETAIL",
  ["WONUM", "ASSETNUM", "WORKTYPE", "ACTSTART", "ACTFINISH"],
  [
    { WONUM: "W1", ASSETNUM: "A11", WORKTYPE: "PM", ACTSTART: "2026-05-11T09:00:00+09:00", ACTFINISH: "2026-05-11T12:00:00+09:00" },
    { WONUM: "W2", ASSETNUM: "A32", WORKTYPE: "CM", ACTSTART: "2026-05-10T09:00:00+09:00", ACTFINISH: "2026-05-12T17:00:00+09:00" },
    { WONUM: "W3", ASSETNUM: "A32", WORKTYPE: "PM", ACTSTART: "2026-05-11T13:00:00+09:00", ACTFINISH: null },
    { WONUM: "W4", ASSETNUM: "A21", WORKTYPE: "PM", ACTSTART: "2026-05-12T09:00:00+09:00", ACTFINISH: null },
    { WONUM: "W5", ASSETNUM: "A21", WORKTYPE: "INSP", ACTSTART: "2026-05-12T13:00:00+09:00", ACTFINISH: null },
    { WONUM: "W6", ASSETNUM: "A12", WORKTYPE: "CM", ACTSTART: "2026-05-13T08:00:00+09:00", ACTFINISH: "2026-05-14T17:00:00+09:00" },
    { WONUM: "W7", ASSETNUM: "A11", WORKTYPE: "PM", ACTSTART: "2026-05-21T09:00:00+09:00", ACTFINISH: null },
    { WONUM: "W8", ASSETNUM: "AX", WORKTYPE: "PM", ACTSTART: "2026-05-11T09:00:00+09:00", ACTFINISH: null },
  ],
  "WONUM",
);

function setup(): Workspace {
  const ws = new Workspace("test", { now: () => 1_700_000_000_000 });
  for (const [meta, rows] of [REPORT, ASSETS, WOS]) ws.createSheet(meta, rows);
  return ws;
}

const NICKNAMES: MatchConditions["rewrite"] = [
  { find: "#(\\d)", replace: "$1号炉" },
  { find: "(^|[^号\\d])(\\d)炉", replace: "$1$2号炉" },
];
const BASE: MatchConditions = {
  contains: { col: "TEXT", targetCol: "ASSETNUM", via: { sheet: "assets", matchCol: "ASSETNUM", sourceCol: "DESCRIPTION" } },
  dateWithin: { col: "DAY", targetStart: "ACTSTART", targetEnd: "ACTFINISH" },
};
const NORM = ["trim", "nfkc", "upper", "removeSpaces"] as const;

function match(ws: Workspace, extra: MatchConditions & { leftFilter?: MatchConditions["targetFilter"] }) {
  return ws.matchSheets("report", "wo", undefined, undefined, [...NORM], 20, extra);
}

describe("鍵の無い突合", () => {
  it("名前を含む・日付の幅: 1 件に決まる行だけ matched、通称は置き換えが無ければ一致しない", () => {
    const ws = setup();
    const plain = match(ws, BASE);
    // r1「#1」・r2「3炉」は通称のまま。r3 は W4・W5 の 2 件で ambiguous。r7 は 2026/5/21 で W7
    expect(plain.samples.matched.map((s) => [s.leftRowKey, s.rightRowKey])).toEqual([
      ["r4", "W6"],
      ["r7", "W7"],
    ]);
    expect(plain.samples.ambiguous.map((s) => [s.leftRowKey, s.candidates])).toEqual([["r3", ["W4", "W5"]]]);

    const withRules = match(ws, { ...BASE, rewrite: NICKNAMES });
    expect(withRules.samples.matched.map((s) => [s.leftRowKey, s.rightRowKey])).toEqual([
      ["r1", "W1"],
      ["r4", "W6"],
      ["r7", "W7"],
    ]);
    // r2「3号炉押込送風機」: 5/11 は W2（CM、期間内）と W3（PM）の 2 件
    expect(withRules.samples.ambiguous.map((s) => [s.leftRowKey, s.candidates])).toEqual([
      ["r2", ["W2", "W3"]],
      ["r3", ["W4", "W5"]],
    ]);
    // 1 文字の名前「炉」（AX）はどの文にも含まれるので使わない
    expect(withRules.samples.unmatchedRight.map((s) => s.rowKey)).toContain("W8");
    expect(withRules.samples.unmatchedLeft[0]).toMatchObject({ rowKey: "r5" });
  });

  it("相手の絞り込み: 修理の行は CM・EM、点検の行はそれ以外の作業指示とだけ結ぶ", () => {
    const ws = setup();
    const repair = match(ws, { ...BASE, rewrite: NICKNAMES, leftFilter: [{ attr: "KIND", op: "eq", value: "修理" }], targetFilter: [{ attr: "WORKTYPE", op: "in", value: ["CM", "EM"] }] });
    expect(repair.samples.matched.map((s) => [s.leftRowKey, s.rightRowKey])).toEqual([
      ["r2", "W2"],
      ["r4", "W6"],
    ]);
    // ごみクレーンは Maximo に無い（新しく作る修理）。結ばずに返す
    expect(repair.samples.unmatchedLeft.map((s) => s.rowKey)).toEqual(["r5", "r6"]);
    expect(repair.ambiguous).toBe(0);
  });

  it("同じ帳票: 決まった相手がそろえば帳票の全行に使い、食い違えば全行 ambiguous", () => {
    const ws = setup();
    const m = match(ws, { ...BASE, rewrite: NICKNAMES, leftFilter: [{ attr: "DOC", op: "eq", value: "R-7" }], group: "DOC" });
    expect(m.samples.matched.map((s) => [s.leftRowKey, s.rightRowKey])).toEqual([
      ["r4", "W6"],
      ["r5", "W6"],
    ]);
    expect(m.matchedByGroup).toBe(1);
    // 点検の行をまとめて 1 帳票とみなすと、r1→W1 と r7→W7 が食い違うので、どの行も結ばない
    const mixed = match(ws, { ...BASE, rewrite: NICKNAMES, leftFilter: [{ attr: "KIND", op: "eq", value: "点検" }], group: "KIND" });
    expect(mixed).toMatchObject({ matched: 0, ambiguous: 4 });
    expect(mixed.samples.ambiguous[0]).toMatchObject({ leftRowKey: "r1", candidates: ["W1", "W7"] });
  });

  it("apply_rule の lookup: 同じ条件で 1 件に決まる行だけ書き、複数は lookup_ambiguous、dryRun は書かない", () => {
    const ws = setup();
    const rule: RuleValue = { lookup: { sheet: "wo", sourceCol: "WONUM", normalize: [...NORM], rewrite: NICKNAMES, ...BASE } };
    const rev = ws.revision;
    const dry = ws.applyRule("report", [{ attr: "KIND", op: "eq", value: "点検" }], { WONUM: rule }, { author: "llm", dryRun: true, reason: "日報と作業指示の突合" });
    expect(dry).toMatchObject({ batchId: null, revision: rev, applied: 2, lookup: { WONUM: { matched: 2, unmatched: 1, ambiguous: 1 } } });
    expect(dry.conflicts).toEqual([{ rowKey: "r3", col: "WONUM", reason: "lookup_ambiguous" }]);
    expect(ws.getSheet("report").rowValues("r1", "final")?.WONUM).toBe(null);

    const res = ws.applyRule("report", [{ attr: "KIND", op: "eq", value: "点検" }], { WONUM: rule }, { author: "llm", reason: "日報と作業指示の突合" });
    expect(res.applied).toBe(2);
    const v = (k: string) => ws.getSheet("report").rowValues(k, "final")?.WONUM;
    expect([v("r1"), v("r3"), v("r7")]).toEqual(["W1", null, "W7"]);
  });

  it("同上の行: 自分で決まらず、真上の行が 1 件に決まっていれば引き継ぐ", () => {
    const ws = setup();
    const ditto = { col: "TEXT", pattern: "^(同上|〃)" };
    const m = match(ws, { ...BASE, rewrite: NICKNAMES, followsAbove: ditto, leftFilter: [{ attr: "DOC", op: "eq", value: "D-2" }] });
    expect(m.samples.matched.map((s) => [s.leftRowKey, s.rightRowKey])).toEqual([
      ["r7", "W7"],
      ["r8", "W7"],
    ]);
    expect(m.matchedByAbove).toBe(1);
    // 真上の行が対象に入っていなければ引き継がない
    const alone = match(ws, { ...BASE, rewrite: NICKNAMES, followsAbove: ditto, leftFilter: [{ attr: "ID", op: "eq", value: "r8" }] });
    expect(alone).toMatchObject({ matched: 0, unmatchedLeft: 1 });
    // 型に合わない行（r6「ごみクレーン」）は、真上が決まっていても引き継がない
    const lookup: RuleValue = { lookup: { sheet: "wo", sourceCol: "WONUM", normalize: [...NORM], rewrite: NICKNAMES, ...BASE, followsAbove: ditto } };
    ws.applyRule("report", [], { WONUM: lookup }, { author: "llm", reason: "日報と作業指示の突合" });
    const v = (k: string) => ws.getSheet("report").rowValues(k, "final")?.WONUM;
    expect([v("r5"), v("r6"), v("r8")]).toEqual([null, null, "W7"]);
    expect(() => match(ws, { ...BASE, followsAbove: { col: "TEXT", pattern: "(" } })).toThrow(StoreError);
  });

  it("lookup の group: 帳票の全行に同じ相手を書く", () => {
    const ws = setup();
    const rule: RuleValue = {
      lookup: { sheet: "wo", sourceCol: "WONUM", normalize: [...NORM], rewrite: NICKNAMES, ...BASE, targetFilter: [{ attr: "WORKTYPE", op: "in", value: ["CM", "EM"] }], group: "DOC" },
    };
    const res = ws.applyRule("report", [{ attr: "DOC", op: "eq", value: "R-7" }], { WONUM: rule }, { author: "llm", reason: "修繕報告書は 1 件の作業指示" });
    expect(res.lookup).toEqual({ WONUM: { matched: 2, unmatched: 0, ambiguous: 0 } });
    const v = (k: string) => ws.getSheet("report").rowValues(k, "final")?.WONUM;
    expect([v("r4"), v("r5")]).toEqual(["W6", "W6"]);
  });

  it("誤り: 条件が無い・片方だけの列・正規表現の誤り・無い列", () => {
    const ws = setup();
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(StoreError);
        return (e as StoreError).code;
      }
      return "no error";
    };
    expect(code(() => match(ws, {}))).toBe("invalid_args");
    expect(code(() => ws.matchSheets("report", "wo", "TEXT", undefined, [], 5))).toBe("invalid_args");
    expect(code(() => match(ws, { ...BASE, rewrite: [{ find: "(", replace: "" }] }))).toBe("invalid_args");
    expect(code(() => match(ws, { ...BASE, group: "NOPE" }))).toBe("column_not_found");
    expect(code(() => match(ws, { dateWithin: { col: "DAY", targetStart: "NOPE" } }))).toBe("column_not_found");
    expect(code(() => match(ws, { contains: { col: "TEXT", targetCol: "ASSETNUM", via: { sheet: "nope", matchCol: "A", sourceCol: "B" } } }))).toBe("sheet_not_found");
  });

  it("日付のセル: 西暦と和暦（令和・平成・昭和）を日にする", () => {
    expect(dayOfCell("2026-05-11T09:00:00+09:00")).toBe("2026-05-11");
    expect(dayOfCell("2026/5/1")).toBe("2026-05-01");
    expect(dayOfCell("2026年5月1日（金）")).toBe("2026-05-01");
    expect(dayOfCell("2026.5.1")).toBe("2026-05-01");
    // 和暦
    expect(dayOfCell("R8.5.4")).toBe("2026-05-04");
    expect(dayOfCell("r8/5/4")).toBe("2026-05-04");
    expect(dayOfCell("令和8年5月4日")).toBe("2026-05-04");
    expect(dayOfCell("令和 8 年 5 月 4 日(月)")).toBe("2026-05-04");
    expect(dayOfCell("令和元年5月1日")).toBe("2019-05-01");
    expect(dayOfCell("Ｒ８．５．４")).toBe("2026-05-04");
    expect(dayOfCell("H31.4.30")).toBe("2019-04-30");
    expect(dayOfCell("平成31年4月30日")).toBe("2019-04-30");
    expect(dayOfCell("S64.1.7")).toBe("1989-01-07");
    // 日付でないもの・無い日
    expect(dayOfCell("5月1日")).toBe(null);
    expect(dayOfCell("R8.2.30")).toBe(null);
    expect(dayOfCell("2026-13-01")).toBe(null);
    expect(dayOfCell("RX.5.4")).toBe(null);
    expect(dayOfCell(20260501)).toBe(null);
  });

  it("ツールの入力: match_sheets と apply_rule の lookup が同じ条件を受け付ける", () => {
    const conditions = { rewrite: NICKNAMES, ...BASE, targetFilter: [{ attr: "WORKTYPE", op: "in", value: ["CM", "EM"] }], group: "DOC" };
    expect(TOOL_DEFS.match_sheets.inputSchema.safeParse({ left: "report", right: "wo", leftFilter: [{ attr: "KIND", op: "eq", value: "修理" }], ...conditions }).success).toBe(true);
    const set = { WONUM: { lookup: { sheet: "wo", sourceCol: "WONUM", ...conditions } } };
    expect(TOOL_DEFS.apply_rule.inputSchema.safeParse({ sheet: "report", set, baseRevision: 0, reason: "r", dryRun: true }).success).toBe(true);
    // 知らない条件・長すぎる正規表現は受け付けない
    expect(TOOL_DEFS.match_sheets.inputSchema.safeParse({ left: "a", right: "b", near: true }).success).toBe(false);
    expect(TOOL_DEFS.match_sheets.inputSchema.safeParse({ left: "a", right: "b", rewrite: [{ find: "x".repeat(201), replace: "" }] }).success).toBe(false);
  });
});
