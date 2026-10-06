// ストアの部品（フィルタ・正規化・ジョブ・ページング・値の検査）の試験。

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CellValue, TypedFilter } from "../../src/shared/model";
import { StoreError } from "../../src/app/store/errors";
import { compareValues, compileFilters, inListMatcher, likeMatcher, valuesEqual } from "../../src/app/store/filters";
import { JobRegistry } from "../../src/app/store/jobs";
import { normalizeCompositeKey, normalizeKey, normalizeText } from "../../src/app/store/normalize";
import { checkLimit, decodeCursor, encodeCursor, paginate } from "../../src/app/store/paging";
import { coerceValue, parseIsoDate } from "../../src/app/store/values";

const ROWS: Array<Record<string, CellValue>> = [
  { ID: "1", NAME: "Pump-A", QTY: 10, DUE: "2024-04-01", NOTE: null, FLAG: true },
  { ID: "2", NAME: "pump b", QTY: "25", DUE: "2024-03-31T23:00:00", NOTE: "", FLAG: false },
  { ID: "3", NAME: "Valve 100%", QTY: 3.5, DUE: "2024-04-02T09:00:00+09:00", NOTE: "x", FLAG: null },
  { ID: "4", NAME: "a.b(c)", QTY: null, DUE: null, NOTE: " ", FLAG: "TRUE" },
];
const COLS = new Set(Object.keys(ROWS[0] ?? {}));

function ids(filters: TypedFilter[]): string[] {
  const p = compileFilters(filters, (c) => COLS.has(c));
  return ROWS.filter((r) => p((c) => r[c] ?? null)).map((r) => String(r["ID"]));
}

describe("filters", () => {
  it("eq: 文字列は完全一致、数値は数値として比べる", () => {
    expect(ids([{ attr: "NAME", op: "eq", value: "Pump-A" }])).toEqual(["1"]);
    expect(ids([{ attr: "NAME", op: "eq", value: "pump-a" }])).toEqual([]);
    expect(ids([{ attr: "NAME", op: "eq", value: "Pump-A " }])).toEqual([]);
    expect(ids([{ attr: "QTY", op: "eq", value: 25 }])).toEqual(["2"]);
    expect(ids([{ attr: "QTY", op: "eq", value: "10" }])).toEqual(["1"]);
    // 文字列どうしは数値として読めても完全一致
    expect(valuesEqual("010", "10")).toBe(false);
    expect(valuesEqual(10, "010")).toBe(true);
  });

  it("eq: null 条件は null と空文字に一致し、真偽値は大小無視", () => {
    expect(ids([{ attr: "NOTE", op: "eq", value: null }])).toEqual(["1", "2"]);
    expect(ids([{ attr: "FLAG", op: "eq", value: true }])).toEqual(["1", "4"]);
  });

  it("ne は eq の否定", () => {
    expect(ids([{ attr: "QTY", op: "ne", value: 10 }])).toEqual(["2", "3", "4"]);
    expect(ids([{ attr: "NOTE", op: "ne", value: "" }])).toEqual(["3", "4"]);
  });

  it("gt / gte / lt / lte: 数値", () => {
    expect(ids([{ attr: "QTY", op: "gt", value: 10 }])).toEqual(["2"]);
    expect(ids([{ attr: "QTY", op: "gte", value: 10 }])).toEqual(["1", "2"]);
    expect(ids([{ attr: "QTY", op: "lt", value: "10" }])).toEqual(["3"]);
    expect(ids([{ attr: "QTY", op: "lte", value: 3.5 }])).toEqual(["3"]);
  });

  it("gt / gte / lt / lte: 日付文字列（値なしは比べない）", () => {
    expect(ids([{ attr: "DUE", op: "gte", value: "2024-04-01" }])).toEqual(["1", "3"]);
    expect(ids([{ attr: "DUE", op: "lt", value: "2024-04-01" }])).toEqual(["2"]);
    expect(ids([{ attr: "DUE", op: "lte", value: "2024-04-02T09:00:00" }])).toEqual(["1", "2", "3"]);
    // オフセットが両方にあれば UTC で比べる
    expect(compareValues("2024-04-02T09:00:00+09:00", "2024-04-02T00:00:00Z")).toBe(0);
    expect(compareValues("abc", "2024-01-01")).toBeNull();
  });

  it("in / notin", () => {
    expect(ids([{ attr: "ID", op: "in", value: ["1", "3", "9"] }])).toEqual(["1", "3"]);
    expect(ids([{ attr: "ID", op: "notin", value: ["1", "3"] }])).toEqual(["2", "4"]);
    expect(ids([{ attr: "NOTE", op: "in", value: [null, "x"] }])).toEqual(["1", "2", "3"]);
    expect(ids([{ attr: "QTY", op: "in", value: ["25", 3.5] }])).toEqual(["2", "3"]);
    expect(ids([{ attr: "FLAG", op: "in", value: [true] }])).toEqual(["1", "4"]);
  });

  it("in の集合による判定は、条件値ごとに valuesEqual で比べた結果と同じ", () => {
    const value = fc.constantFrom<CellValue>(null, "", " ", "1", "01", "1.0", " 1 ", "a", "A", "true", "TRUE", " false ", "0", 0, 1, -0, 1.5, "1.5", "1e0", true, false);
    fc.assert(
      fc.property(fc.array(value, { maxLength: 6 }), value, (list, cell) => {
        expect(inListMatcher(list)(cell)).toBe(list.some((t) => valuesEqual(cell, t)));
      }),
      { numRuns: 3000 },
    );
  });

  it("like: % は任意の文字列、大文字小文字無視、正規表現の記号はそのまま", () => {
    expect(ids([{ attr: "NAME", op: "like", value: "pump%" }])).toEqual(["1", "2"]);
    expect(ids([{ attr: "NAME", op: "like", value: "%100%" }])).toEqual(["3"]);
    expect(ids([{ attr: "NAME", op: "like", value: "a.b(c)" }])).toEqual(["4"]);
    // . \ ( [ は文字そのもの
    expect(likeMatcher("a.b")("axb")).toBe(false);
    expect(likeMatcher("a.b")("A.B")).toBe(true);
    expect(likeMatcher("[x]+?")("[X]+?")).toBe(true);
    // 全角半角・大文字小文字を無視する（半角カナの説明も全角で当たる）
    expect(likeMatcher("%スートブロワ No.2%")("3号炉 ｽｰﾄﾌﾞﾛﾜ No.2 電動機")).toBe(true);
    expect(likeMatcher("%ｽｰﾄﾌﾞﾛﾜ%")("3号炉 スートブロワ")).toBe(true);
    expect(likeMatcher("%ＩＤＦ%")("2号炉 idf 軸受")).toBe(true);
    expect(likeMatcher("%ガ%")("ｶﾞｽ")).toBe(true);
    expect(likeMatcher("%")("")).toBe(true);
    expect(likeMatcher("a\\b")("A\\B")).toBe(true);
    expect(likeMatcher("a\\b")("ab")).toBe(false);
    expect(likeMatcher("a\\d%")("a\\d1")).toBe(true);
    expect(likeMatcher("a\\k")("a\\k")).toBe(true);
    expect(likeMatcher("%a\\")("xa\\")).toBe(true);
    expect(ids([{ attr: "NAME", op: "like", value: "a\\%" }])).toEqual([]);
    // 先頭と末尾の固定部分は重ならない
    expect(likeMatcher("ab%ba")("aba")).toBe(false);
    expect(likeMatcher("ab%ba")("abba")).toBe(true);
    expect(likeMatcher("%a%a%")("a")).toBe(false);
    expect(likeMatcher("%a%a%")("xaya")).toBe(true);
    expect(likeMatcher("a%%b")("ab")).toBe(true);
  });

  it("like: % の多いパターンでも長い文字列ですぐ終わる（正規表現の後戻りを使わない）", () => {
    const started = Date.now();
    expect(likeMatcher(`${"%a".repeat(200)}b`)("a".repeat(5000))).toBe(false);
    expect(ids([{ attr: "NAME", op: "like", value: `${"%a".repeat(50)}%` }])).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("like は % だけをワイルドカードにした正規表現と同じ結果", () => {
    const text = fc.array(fc.constantFrom("a", "A", "b", ".", "\\", "-", "(", "%"), { maxLength: 8 }).map((a) => a.join(""));
    const oracle = (pattern: string, s: string): boolean =>
      new RegExp(`^${pattern.split("%").map((p) => p.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&")).join("[\\s\\S]*")}$`, "i").test(s);
    fc.assert(
      fc.property(text, text, (pattern, s) => {
        expect(likeMatcher(pattern)(s)).toBe(oracle(pattern, s));
      }),
      { numRuns: 3000 },
    );
  });

  it("isnull / notnull: null と空文字を null 扱い（空白だけは値あり）", () => {
    expect(ids([{ attr: "NOTE", op: "isnull" }])).toEqual(["1", "2"]);
    expect(ids([{ attr: "NOTE", op: "notnull" }])).toEqual(["3", "4"]);
  });

  it("複数の条件は AND", () => {
    expect(
      ids([
        { attr: "NAME", op: "like", value: "%p%" },
        { attr: "QTY", op: "gt", value: 10 },
      ]),
    ).toEqual(["2"]);
    expect(ids([])).toEqual(["1", "2", "3", "4"]);
  });

  it("存在しない列・値の形の誤りは型付きエラー", () => {
    const run = (f: TypedFilter) => () => compileFilters([f], (c) => COLS.has(c));
    expect(run({ attr: "NOPE", op: "eq", value: 1 })).toThrow(StoreError);
    try {
      run({ attr: "NOPE", op: "eq", value: 1 })();
    } catch (e) {
      expect((e as StoreError).code).toBe("column_not_found");
    }
    for (const f of [
      { attr: "ID", op: "in", value: "1" },
      { attr: "ID", op: "eq" },
      { attr: "ID", op: "eq", value: [1] },
      { attr: "QTY", op: "gt", value: true },
      { attr: "QTY", op: "gt", value: null },
      { attr: "NAME", op: "like", value: null },
    ] as TypedFilter[]) {
      try {
        run(f)();
        expect.unreachable(`${f.op} should throw`);
      } catch (e) {
        expect((e as StoreError).code).toBe("invalid_filter");
      }
    }
  });
});

describe("normalize", () => {
  it("trim は全角空白・ゼロ幅空白も除く", () => {
    expect(normalizeText("　 P-101 ​\t", ["trim"])).toBe("P-101");
  });

  it("removeSpaces は途中の全角・半角空白を除く", () => {
    expect(normalizeText("P 1　0 1", ["removeSpaces"])).toBe("P101");
  });

  it("upper / lower / nfkc", () => {
    expect(normalizeText("ｐ－１０１", ["nfkc"])).toBe("p-101");
    expect(normalizeText("ｐ－１０１", ["nfkc", "upper"])).toBe("P-101");
    expect(normalizeText("AbC", ["lower"])).toBe("abc");
  });

  it("removeHyphens はハイフン類を除き、長音符は残す", () => {
    const hyphens = ["-", "‐", "‑", "‒", "–", "—", "―", "−", "－"];
    for (const h of hyphens) expect(normalizeText(`P${h}101`, ["removeHyphens"])).toBe("P101");
    expect(normalizeText("モーター", ["removeHyphens"])).toBe("モーター");
    expect(normalizeText("ﾓｰﾀｰ", ["removeHyphens"])).toBe("ﾓｰﾀｰ");
  });

  it("適用順は指定順に左右されない", () => {
    expect(normalizeText(" ｐ－1 ", ["upper", "removeHyphens", "trim", "nfkc"])).toBe(normalizeText(" ｐ－1 ", ["nfkc", "trim", "removeHyphens", "upper"]));
    expect(normalizeText(" ｐ－1 ", ["upper", "removeHyphens", "trim", "nfkc"])).toBe("P1");
  });

  it("normalizeKey: null・空文字・正規化後に空はキーなし", () => {
    expect(normalizeKey(null, ["trim"])).toBeNull();
    expect(normalizeKey("", [])).toBeNull();
    expect(normalizeKey("　", ["trim"])).toBeNull();
    expect(normalizeKey(101, [])).toBe("101");
  });

  it("normalizeCompositeKey: 1 列でもキーなしなら id は null、表示は | で連結", () => {
    expect(normalizeCompositeKey(["bedford", " p-1 "], ["trim", "upper"])).toEqual({ id: JSON.stringify(["BEDFORD", "P-1"]), label: "BEDFORD | P-1" });
    expect(normalizeCompositeKey(["bedford", ""], ["trim"])).toEqual({ id: null, label: "bedford | " });
    expect(normalizeCompositeKey(["a"], [])).toEqual({ id: "a", label: "a" });
    // 区切り文字を含む値でも別のキーが同じ id にならない
    expect(normalizeCompositeKey(["a\u001fb", "c"], []).id).not.toBe(normalizeCompositeKey(["a", "b\u001fc"], []).id);
  });
});

describe("jobs", () => {
  it("startJob → updateJob → finishJob → getJob", () => {
    let t = 1000;
    const jobs = new JobRegistry({ now: () => t });
    const id = jobs.startJob("load_sheet", { total: 10 });
    expect(jobs.getJob(id)).toMatchObject({ jobId: id, kind: "load_sheet", state: "running", progress: 0, total: 10 });
    jobs.updateJob(id, { progress: 4, message: "4/10" });
    expect(jobs.getJob(id)).toMatchObject({ progress: 4, message: "4/10" });
    t = 2000;
    jobs.finishJob(id, { result: { rows: 10 } });
    expect(jobs.getJob(id)).toMatchObject({ state: "done", progress: 10, result: { rows: 10 } });
    // 終わった後の更新は無視
    jobs.updateJob(id, { progress: 1 });
    jobs.finishJob(id, { state: "failed" });
    expect(jobs.getJob(id)).toMatchObject({ state: "done", progress: 10 });
  });

  it("getJob の結果を書き換えても内部は変わらない", () => {
    const jobs = new JobRegistry();
    const id = jobs.startJob("apply_rule");
    jobs.finishJob(id, { state: "failed", message: "x", result: { a: 1 } });
    const s = jobs.getJob(id);
    (s.result as Record<string, unknown>)["a"] = 2;
    s.state = "running";
    expect(jobs.getJob(id)).toMatchObject({ state: "failed", result: { a: 1 } });
  });

  it("存在しないジョブは job_not_found、終わったジョブは上限を超えると古い順に消える", () => {
    let t = 0;
    const jobs = new JobRegistry({ maxFinished: 2, now: () => ++t });
    expect(() => jobs.getJob("job-x")).toThrow(StoreError);
    const a = jobs.startJob("import");
    const b = jobs.startJob("import");
    const c = jobs.startJob("import");
    const running = jobs.startJob("import");
    jobs.finishJob(a);
    jobs.finishJob(b);
    jobs.finishJob(c);
    expect(() => jobs.getJob(a)).toThrow(StoreError);
    expect(jobs.getJob(b).state).toBe("done");
    expect(jobs.getJob(running).state).toBe("running");
    expect(a).not.toBe(b);
  });
});

describe("paging and values", () => {
  it("cursor は不透明な文字列で往復し、壊れた cursor は invalid_cursor", () => {
    expect(decodeCursor(encodeCursor(123))).toBe(123);
    expect(decodeCursor(undefined)).toBe(0);
    for (const bad of ["@@@", btoa("{}"), btoa(JSON.stringify({ o: -1 })), btoa(JSON.stringify({ o: 1.5 }))]) {
      try {
        decodeCursor(bad);
        expect.unreachable();
      } catch (e) {
        expect((e as StoreError).code).toBe("invalid_cursor");
      }
    }
    expect(() => checkLimit(0, 50)).toThrow(StoreError);
    expect(checkLimit(undefined, 50)).toBe(50);
    const first = paginate([1, 2, 3, 4, 5], undefined, 2);
    expect(first.page).toEqual([1, 2]);
    const second = paginate([1, 2, 3, 4, 5], first.nextCursor ?? undefined, 2);
    expect(second.page).toEqual([3, 4]);
    const last = paginate([1, 2, 3, 4, 5], second.nextCursor ?? undefined, 2);
    expect(last).toEqual({ page: [5], nextCursor: null });
  });

  it("coerceValue: 型ごとの検査", () => {
    expect(coerceValue({ name: "N", type: "number" }, "1.5")).toEqual({ ok: true, value: 1.5 });
    expect(coerceValue({ name: "N", type: "number" }, "abc").ok).toBe(false);
    expect(coerceValue({ name: "N", type: "number" }, true).ok).toBe(false);
    expect(coerceValue({ name: "I", type: "integer" }, 1.5).ok).toBe(false);
    expect(coerceValue({ name: "I", type: "integer" }, " 7 ")).toEqual({ ok: true, value: 7 });
    expect(coerceValue({ name: "B", type: "boolean" }, "TRUE")).toEqual({ ok: true, value: true });
    expect(coerceValue({ name: "B", type: "boolean" }, "yes").ok).toBe(false);
    expect(coerceValue({ name: "D", type: "date" }, "2024-02-29")).toEqual({ ok: true, value: "2024-02-29" });
    expect(coerceValue({ name: "D", type: "date" }, "2023-02-29").ok).toBe(false);
    expect(coerceValue({ name: "D", type: "date" }, "2024/04/01")).toEqual({ ok: true, value: "2024-04-01" });
    expect(coerceValue({ name: "D", type: "date" }, "2024.04.01").ok).toBe(false);
    expect(coerceValue({ name: "D", type: "datetime" }, "2024-04-01T10:20:30.123+09:00").ok).toBe(true);
    expect(coerceValue({ name: "D", type: "datetime" }, 20240401).ok).toBe(false);
    expect(coerceValue({ name: "D", type: "datetime" }, "")).toEqual({ ok: true, value: null });
    expect(coerceValue({ name: "S", type: "string", maxLength: 3 }, "日本語")).toEqual({ ok: true, value: "日本語" });
    expect(coerceValue({ name: "S", type: "string", maxLength: 3 }, "abcd").ok).toBe(false);
    expect(coerceValue({ name: "S", type: "string" }, 12)).toEqual({ ok: true, value: "12" });
    expect(parseIsoDate("2024-04-01T24:00:00")).toBeNull();
    // 年 0〜99 を 1900 年代に読み替えない
    expect(parseIsoDate("0000-02-29")).not.toBeNull();
    expect(parseIsoDate("0100-02-29")).toBeNull();
    expect(parseIsoDate("1900-02-29")).toBeNull();
    expect(compareValues("0050-01-01T00:00:00Z", "1950-01-01T00:00:00Z")).toBe(-1);
    expect(parseIsoDate("0050-01-01T09:00:00+09:00")?.epochMs).toBe(parseIsoDate("0050-01-01T00:00:00Z")?.epochMs);
  });
});
