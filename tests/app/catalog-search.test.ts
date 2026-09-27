// 保存したオブジェクト構造の横断検索（LLM の find_object_structures と作業画面の検索欄が使う）の試験。

import { describe, expect, it } from "vitest";
import type { StoredObjectStructure } from "../../src/app/catalog/catalog";
import { searchStructures, searchTerms } from "../../src/app/catalog/search";
import type { ColumnSchema } from "../../src/shared/model";

function entry(os: string, columns: ColumnSchema[], childIdAttrs: Record<string, string | null> = {}): StoredObjectStructure {
  return { baseUrl: "https://maximo.test/maximo", os, loadedAt: 1, info: { os, columns, keyColumns: [], childIdAttrs } };
}

const WO = entry(
  "MXAPIWO",
  [
    { name: "WONUM", type: "string", title: "作業指示書" },
    { name: "STATUS", type: "string", title: "ステータス" },
    { name: "EXT_NEEDPERMIT", type: "boolean", title: "許可申請あり" },
    { name: "EXT_WOPERMIT.EXT_PERMITDATE", type: "date", title: "申請完了日", child: "EXT_WOPERMIT" },
    { name: "EXT_WOPERMIT.EXT_AUTHORITY", type: "string", title: "許可/法規", child: "EXT_WOPERMIT" },
  ],
  { EXT_WOPERMIT: "EXT_WOPERMITID" },
);
const MHWO = entry("MHWO", [
  { name: "WONUM", type: "string", title: "作業指示書" },
  { name: "STATUS", type: "string", title: "ステータス" },
]);
const ASSET = entry(
  "MXAPIASSET",
  [
    { name: "ASSETNUM", type: "string", title: "資産" },
    { name: "EXT_EQUIPTAG", type: "string", title: "タグ番号" },
    { name: "ASSETSPEC.ALNVALUE", type: "string", title: "英数字の値", child: "ASSETSPEC" },
  ],
  { ASSETSPEC: "ASSETSPECID" },
);
const ALL = [MHWO, ASSET, WO];

describe("searchTerms", () => {
  it("空白・読点・カンマ・中黒で分け、全角半角と大文字小文字をそろえ、重複を除く", () => {
    expect(searchTerms(" 許可申請　申請完了日、ＴＡＧＮＯ・tagno ,x ")).toEqual(["許可申請", "申請完了日", "tagno", "x"]);
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("searchStructures", () => {
  it("日本語のラベルから構造と当たった属性を返す（完全一致のラベルを先に並べる）", () => {
    const r = searchStructures(ALL, "申請完了日");
    expect(r.partial).toBe(false);
    expect(r.hits.map((h) => h.os)).toEqual(["MXAPIWO"]);
    expect(r.hits[0]!.columns[0]).toEqual({ name: "EXT_WOPERMIT.EXT_PERMITDATE", title: "申請完了日", type: "date" });

    const partialTitle = searchStructures(ALL, "申請");
    expect(partialTitle.hits[0]!.columns.map((c) => c.name)).toEqual(["EXT_NEEDPERMIT", "EXT_WOPERMIT.EXT_PERMITDATE"]);
  });

  it("属性名・子オブジェクト名・構造名でも当たる（全角でも小文字でもよい）", () => {
    expect(searchStructures(ALL, "ｅｘｔ＿ｅｑｕｉｐｔａｇ").hits.map((h) => h.os)).toEqual(["MXAPIASSET"]);
    const child = searchStructures(ALL, "assetspec").hits[0]!;
    expect(child).toMatchObject({ os: "MXAPIASSET", childMatches: ["ASSETSPEC"] });
    const name = searchStructures(ALL, "mhwo").hits[0]!;
    expect(name).toMatchObject({ os: "MHWO", nameMatched: true });
  });

  it("言葉をすべて含む構造を優先し、1 つも無ければ一部だけ当たる構造を partial で返す", () => {
    const both = searchStructures(ALL, "許可 ステータス");
    expect(both.partial).toBe(false);
    expect(both.hits.map((h) => h.os)).toEqual(["MXAPIWO"]);

    const partial = searchStructures(ALL, "タグ番号 許可");
    expect(partial.partial).toBe(true);
    expect(partial.hits.map((h) => h.os).sort()).toEqual(["MXAPIASSET", "MXAPIWO"]);
    expect(partial.hits.find((h) => h.os === "MXAPIASSET")!.matchedTerms).toEqual(["タグ番号"]);

    const none = searchStructures(ALL, "存在しない");
    expect(none).toEqual({ terms: ["存在しない"], partial: false, totalHits: 0, hits: [] });
  });

  it("当たり方が同じなら MXAPI で始まる構造を先に並べる", () => {
    expect(searchStructures(ALL, "ステータス").hits.map((h) => h.os)).toEqual(["MXAPIWO", "MHWO"]);
  });

  it("件数と、構造ごとに返す属性の数を区切る（当たった属性の総数は matchedColumnCount）", () => {
    const r = searchStructures(ALL, "許可", { columnsPerStructure: 1, limit: 1 });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.columns).toHaveLength(1);
    expect(r.hits[0]!.matchedColumnCount).toBe(2);
    expect(searchStructures(ALL, "作業指示書", { limit: 1 }).totalHits).toBe(2);
  });
});
