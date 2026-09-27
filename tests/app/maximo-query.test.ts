import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TypedFilter } from "../../src/shared/model";
import { buildOrderBy, buildSelect, buildWhere, MAX_IN_VALUES, QueryBuildError, splitColumnName } from "../../src/app/maximo/query";

const known = new Set([
  "SITEID",
  "WONUM",
  "DESCRIPTION",
  "STATUS",
  "ESTDUR",
  "WOPRIORITY",
  "EXT_FLAG",
  "REPORTDATE",
  "MULTIASSETLOCCI.ASSETNUM",
  "MULTIASSETLOCCI.ISPRIMARY",
  "EXT_WOPERMIT.EXT_PERMITDATE",
]);

describe("splitColumnName", () => {
  it("子の列を大文字の子オブジェクト名と属性名に分ける", () => {
    expect(splitColumnName("ext_wopermit.ext_permitdate")).toEqual({ child: "EXT_WOPERMIT", attr: "EXT_PERMITDATE" });
    expect(splitColumnName("wonum")).toEqual({ child: null, attr: "WONUM" });
  });

  it("孫オブジェクトと使えない文字を拒否する", () => {
    expect(() => splitColumnName("A.B.C")).toThrow(QueryBuildError);
    expect(() => splitColumnName("wonum desc")).toThrow(QueryBuildError);
    expect(() => splitColumnName("wonum,description")).toThrow(QueryBuildError);
    expect(() => splitColumnName("child{a}")).toThrow(QueryBuildError);
    expect(() => splitColumnName("")).toThrow(QueryBuildError);
  });
});

describe("buildSelect", () => {
  it("親の _rowstamp と、子の ID・_rowstamp を必ず含め、小文字にする", () => {
    expect(buildSelect(["WONUM", "description", "MULTIASSETLOCCI.ASSETNUM", "multiassetlocci.isprimary"], { multiassetlocci: "MULTIID" }, known)).toBe(
      "_rowstamp,wonum,description,multiassetlocci{multiid,_rowstamp,assetnum,isprimary}",
    );
  });

  it("ID の分からない子は _rowstamp だけを足す", () => {
    expect(buildSelect(["EXT_WOPERMIT.EXT_PERMITDATE"], { EXT_WOPERMIT: null })).toBe("_rowstamp,ext_wopermit{_rowstamp,ext_permitdate}");
  });

  it("重複と _rowstamp の指定はまとめる", () => {
    expect(buildSelect(["WONUM", "wonum", "_rowstamp"], {}, known)).toBe("_rowstamp,wonum");
  });

  it("スキーマに無い列・不正な列名・不正な子 ID 属性名を拒否する", () => {
    expect(() => buildSelect(["NOSUCH"], {}, known)).toThrow(QueryBuildError);
    expect(() => buildSelect(["MULTIASSETLOCCI.NOSUCH"], {}, known)).toThrow(QueryBuildError);
    expect(() => buildSelect(["WONUM;DROP"], {})).toThrow(QueryBuildError);
    expect(() => buildSelect(["A.B.C"], {})).toThrow(QueryBuildError);
    expect(() => buildSelect(["MULTIASSETLOCCI.ASSETNUM"], { MULTIASSETLOCCI: "MULTI ID" })).toThrow(QueryBuildError);
  });
});

describe("buildWhere", () => {
  const cases: Array<[TypedFilter, string]> = [
    [{ attr: "STATUS", op: "eq", value: "WAPPR" }, 'status="WAPPR"'],
    [{ attr: "status", op: "ne", value: "COMP" }, 'status!="COMP"'],
    [{ attr: "WOPRIORITY", op: "gt", value: 2 }, "wopriority>2"],
    [{ attr: "WOPRIORITY", op: "gte", value: 2 }, "wopriority>=2"],
    [{ attr: "REPORTDATE", op: "lt", value: "2026-01-01T00:00:00+09:00" }, 'reportdate<"2026-01-01T00:00:00+09:00"'],
    [{ attr: "ESTDUR", op: "lte", value: 1.5 }, "estdur<=1.5"],
    [{ attr: "EXT_FLAG", op: "eq", value: true }, "ext_flag=true"],
    [{ attr: "EXT_FLAG", op: "ne", value: false }, "ext_flag!=false"],
    [{ attr: "STATUS", op: "in", value: ["WAPPR", "APPR"] }, 'status in ["WAPPR","APPR"]'],
    [{ attr: "WOPRIORITY", op: "in", value: [1, 2] }, "wopriority in [1,2]"],
    [{ attr: "DESCRIPTION", op: "like", value: "ポンプ" }, 'description="%ポンプ%"'],
    [{ attr: "DESCRIPTION", op: "isnull" }, 'description!="*"'],
    [{ attr: "DESCRIPTION", op: "notnull", value: null }, 'description="*"'],
    // スペース・ハイフン・日本語は値としてそのまま通す
    [{ attr: "DESCRIPTION", op: "eq", value: "P-100 A 点検" }, 'description="P-100 A 点検"'],
  ];

  it.each(cases)("%j → %s", (filter, expected) => {
    expect(buildWhere([filter], known)).toEqual({ where: expected, postFilters: [] });
  });

  it("複数条件は and でつなぎ、条件が無ければ空文字", () => {
    expect(
      buildWhere(
        [
          { attr: "STATUS", op: "eq", value: "WAPPR" },
          { attr: "WOPRIORITY", op: "gte", value: 2 },
        ],
        known,
      ).where,
    ).toBe('status="WAPPR" and wopriority>=2');
    expect(buildWhere([], known)).toEqual({ where: "", postFilters: [] });
  });

  it("子属性のフィルタは Maximo へ送らず postFilters に分ける", () => {
    const r = buildWhere(
      [
        { attr: "multiassetlocci.assetnum", op: "eq", value: "P-100" },
        { attr: "STATUS", op: "eq", value: "APPR" },
      ],
      known,
    );
    expect(r.where).toBe('status="APPR"');
    expect(r.postFilters).toEqual([{ attr: "MULTIASSETLOCCI.ASSETNUM", op: "eq", value: "P-100" }]);
  });

  const rejects: Array<[string, TypedFilter]> = [
    ['値に " を含む', { attr: "DESCRIPTION", op: "eq", value: 'a" or wonum="x' }],
    ["like の値に \" を含む", { attr: "DESCRIPTION", op: "like", value: 'a"b' }],
    ["スキーマに無い属性", { attr: "NOSUCH", op: "eq", value: "x" }],
    ["属性名に演算子を含む", { attr: "status or 1=1", op: "eq", value: "x" }],
    ["notin は未対応", { attr: "STATUS", op: "notin", value: ["A"] }],
    ["in が空", { attr: "STATUS", op: "in", value: [] }],
    ["in が配列でない", { attr: "STATUS", op: "in", value: "A" }],
    ["in の件数上限", { attr: "WOPRIORITY", op: "in", value: Array.from({ length: MAX_IN_VALUES + 1 }, (_, i) => i) }],
    ["eq に null", { attr: "STATUS", op: "eq", value: null }],
    ["eq に値が無い", { attr: "STATUS", op: "eq" }],
    ["eq に空文字", { attr: "STATUS", op: "eq", value: "" }],
    ["eq に *", { attr: "STATUS", op: "eq", value: "*" }],
    ["eq に %", { attr: "STATUS", op: "eq", value: "50%" }],
    ["eq に配列", { attr: "STATUS", op: "eq", value: ["A"] }],
    ["制御文字", { attr: "DESCRIPTION", op: "eq", value: "a\nb" }],
    ["DEL 文字", { attr: "DESCRIPTION", op: "eq", value: "a\u007fb" }],
    ["like に空文字", { attr: "DESCRIPTION", op: "like", value: "" }],
    ["like に真偽値", { attr: "DESCRIPTION", op: "like", value: true }],
    ["isnull に値", { attr: "DESCRIPTION", op: "isnull", value: "x" }],
    ["gt に真偽値", { attr: "WOPRIORITY", op: "gt", value: true }],
    ["数値が有限でない", { attr: "WOPRIORITY", op: "eq", value: Number.NaN }],
    ["未知の演算子", { attr: "STATUS", op: "regex" as TypedFilter["op"], value: "x" }],
  ];

  it.each(rejects)("拒否: %s", (_label, filter) => {
    expect(() => buildWhere([filter], known)).toThrow(QueryBuildError);
  });

  it("性質: 任意の文字列値は、拒否されるか、引用符 1 組の中に閉じ込められる", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.constantFrom<TypedFilter["op"]>("eq", "ne", "gt", "like"), (value, op) => {
        let out: string;
        try {
          out = buildWhere([{ attr: "DESCRIPTION", op, value }], known).where;
        } catch (e) {
          expect(e).toBeInstanceOf(QueryBuildError);
          return;
        }
        const m = /^description(=|!=|>)"(.*)"$/s.exec(out);
        expect(m).not.toBeNull();
        const inner = m![2]!;
        expect(inner.includes('"')).toBe(false);
        expect(/[\u0000-\u001f\u007f]/.test(inner)).toBe(false);
        expect(inner).toBe(op === "like" ? `%${value}%` : value);
      }),
      { numRuns: 300 },
    );
  });
});

describe("buildOrderBy", () => {
  it("-は降順、無印と+は昇順。属性名は小文字", () => {
    expect(buildOrderBy(["-REPORTDATE", "WONUM", "+status"], known)).toBe("-reportdate,+wonum,+status");
  });

  it("子の属性・スキーマに無い列・不正な名前を拒否する", () => {
    expect(() => buildOrderBy(["MULTIASSETLOCCI.ASSETNUM"], known)).toThrow(QueryBuildError);
    expect(() => buildOrderBy(["NOSUCH"], known)).toThrow(QueryBuildError);
    expect(() => buildOrderBy(["wonum desc"], known)).toThrow(QueryBuildError);
  });
});
