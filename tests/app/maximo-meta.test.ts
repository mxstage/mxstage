import { describe, expect, it } from "vitest";
import { MaximoClient } from "../../src/app/maximo/client";
import {
  describeObjectStructure,
  getObjectStructureInfo,
  inferChildIdAttr,
  listDefinedObjectStructures,
  listObjectStructures,
  mergeStructureLists,
  parseApiMeta,
  parseJsonSchema,
} from "../../src/app/maximo/meta";
import { createFakeMaximo, sampleSeed, withDefinitions, type FakeMaximo } from "../fakes/fake-maximo";

function clientFor(fake: FakeMaximo): MaximoClient {
  return new MaximoClient({ baseUrl: fake.baseUrl, apiKey: () => fake.apiKey, via: "direct", fetchImpl: fake.fetch, sleep: async () => {} });
}

describe("apimeta", () => {
  it("parseApiMeta は配列・member・apis のどの形も受け付け、大文字にして重複を除き名前順に並べる", () => {
    const items = [
      { name: "mxapiwo", description: "Work Order", href: "https://h/maximo/api/os/mxapiwo" },
      { href: "https://h/maximo/api/os/mxasset?x=1" },
      { name: "MXAPIWO", description: "dup" },
      { name: "bad name", description: "x" },
      { title: "MXLOC" },
      "not-an-object",
    ];
    const expected = [
      { name: "MXAPIWO", description: "Work Order", href: "https://h/maximo/api/os/mxapiwo" },
      { name: "MXASSET", description: "", href: "https://h/maximo/api/os/mxasset?x=1" },
      { name: "MXLOC", description: "MXLOC", href: null },
    ];
    expect(parseApiMeta(items)).toEqual(expected);
    expect(parseApiMeta({ member: items })).toEqual(expected);
    expect(parseApiMeta({ apis: items })).toEqual(expected);
    expect(parseApiMeta({ unexpected: true })).toEqual([]);
  });

  it("listObjectStructures は名前・説明の部分一致（大文字小文字を区別しない）で絞り、limit で切る", async () => {
    const fake = createFakeMaximo(sampleSeed());
    const client = clientFor(fake);
    expect((await listObjectStructures(client, "apiwo")).map((o) => o.name)).toEqual(["MXAPIWO"]);
    expect((await listObjectStructures(client, "ASSET")).map((o) => o.name)).toEqual(["MXASSET"]);
    expect((await listObjectStructures(client, "work order")).map((o) => o.name)).toEqual(["MXAPIWO"]);
    expect((await listObjectStructures(client)).map((o) => o.name)).toEqual(["MXAPIWO", "MXASSET"]);
    expect(await listObjectStructures(client, "", 1)).toHaveLength(1);
    expect(fake.state.requests.every((r) => r.path === "/maximo/api/apimeta?lean=1")).toBe(true);
  });
});

describe("Maximo の定義の一覧（MXAPIINTOBJECT）で apimeta を補う", () => {
  const item = (name: string) => ({ name, description: `${name} の説明`, href: null });
  const def = (name: string, usewith: string) => ({ name, description: `${name} の定義`, usewith });

  it("listDefinedObjectStructures は MXAPIINTOBJECT から名前・説明・適用先を名前順に読む", async () => {
    const seed = withDefinitions(sampleSeed(), [{ name: "dmmaxapps", usewith: "マイグレーション・マネージャー" }]);
    const fake = createFakeMaximo(seed);
    const defined = await listDefinedObjectStructures(clientFor(fake));
    expect(defined.map((d) => d.name)).toEqual(["DMMAXAPPS", "MXAPIINTOBJECT", "MXAPIWO", "MXASSET"]);
    expect(defined.find((d) => d.name === "MXAPIWO")).toEqual({ name: "MXAPIWO", description: "Work Order", usewith: "統合" });
    expect(defined.find((d) => d.name === "DMMAXAPPS")).toEqual({ name: "DMMAXAPPS", description: "", usewith: "マイグレーション・マネージャー" });
    expect(fake.state.requests.map((r) => decodeURIComponent(r.path))).toEqual([
      "/maximo/api/os/mxapiintobject?lean=1&oslc.select=_rowstamp,intobjectname,description,usewith&oslc.pageSize=1000&collectioncount=1",
    ]);
  });

  it("apimeta に載らない構造を、apimeta に載る構造と同じ適用先なら足し、それ以外の適用先は API で使えないものとして分ける", () => {
    const listed = [item("MXAPIWO"), item("REP_ASSET")];
    const defined = [def("MXAPIWO", "統合"), def("REP_ASSET", "レポート"), def("EXT_WOPERMIT", "統合"), def("EXT_ASSETSUB", "レポート"), def("DMMAXAPPS", "マイグレーション・マネージャー"), def("WOSINVBAL", "WOS")];
    expect(mergeStructureLists(listed, defined)).toEqual({
      items: [
        { name: "EXT_ASSETSUB", description: "EXT_ASSETSUB の定義" },
        { name: "EXT_WOPERMIT", description: "EXT_WOPERMIT の定義" },
        { name: "MXAPIWO", description: "MXAPIWO の説明" },
        { name: "REP_ASSET", description: "REP_ASSET の説明" },
      ],
      definedCount: 6,
      addedFromDefinitions: 2,
      notApi: [def("DMMAXAPPS", "マイグレーション・マネージャー"), def("WOSINVBAL", "WOS")],
    });
    // 適用先の値は Maximo の言語で返るので決め打ちしない（英語の環境でも同じ決め方）
    expect(mergeStructureLists([item("MXAPIWO")], [def("MXAPIWO", "INTEGRATION"), def("EXT_WO", "INTEGRATION"), def("DMWO", "MIGRATIONMGR")]).items.map((i) => i.name)).toEqual(["EXT_WO", "MXAPIWO"]);
  });

  it("定義を読めなければ apimeta の一覧だけにして、理由を残す", () => {
    expect(mergeStructureLists([item("MXAPIWO")], { error: "403 権限がありません" })).toEqual({
      items: [{ name: "MXAPIWO", description: "MXAPIWO の説明" }],
      definedCount: null,
      addedFromDefinitions: 0,
      notApi: [],
      definedError: "403 権限がありません",
    });
  });
});

describe("jsonschemas", () => {
  it("親と子の列・型・maxLength・required・readOnly・キー列・子の ID 属性を解析する", async () => {
    const fake = createFakeMaximo(sampleSeed());
    const info = await getObjectStructureInfo(clientFor(fake), "mxapiwo");
    expect(fake.state.requests[0]!.path).toBe("/maximo/api/jsonschemas/mxapiwo?oslc.select=*");
    expect(info.os).toBe("MXAPIWO");
    expect(info.keyColumns).toEqual(["SITEID", "WONUM"]);
    expect(info.childIdAttrs).toEqual({ MULTIASSETLOCCI: "MULTIID", EXT_WOPERMIT: "EXT_WOPERMITID" });

    const col = (name: string) => info.columns.find((c) => c.name === name);
    expect(col("SITEID")).toEqual({ name: "SITEID", title: "Site", type: "string", maxLength: 8, required: true });
    expect(col("ESTDUR")?.type).toBe("number");
    expect(col("WOPRIORITY")?.type).toBe("integer");
    expect(col("EXT_FLAG")?.type).toBe("boolean");
    expect(col("REPORTDATE")?.type).toBe("datetime");
    expect(col("TARGSTARTDATE")?.type).toBe("date");
    expect(col("CHANGEBY")?.readOnly).toBe(true);
    expect(col("DESCRIPTION")?.readOnly).toBeUndefined();
    expect(col("MULTIASSETLOCCI.ASSETNUM")).toEqual({ name: "MULTIASSETLOCCI.ASSETNUM", type: "string", maxLength: 25, child: "MULTIASSETLOCCI" });
    expect(col("MULTIASSETLOCCI.MULTIID")).toMatchObject({ readOnly: true, type: "integer", child: "MULTIASSETLOCCI" });
    expect(col("EXT_WOPERMIT.EXT_PERMITDATE")).toMatchObject({ type: "date", child: "EXT_WOPERMIT" });

    // システム項目は列にしない。親の列が子の列より前に並ぶ
    expect(info.columns.some((c) => /_ROWSTAMP|HREF|LOCALREF/.test(c.name))).toBe(false);
    const firstChild = info.columns.findIndex((c) => c.child);
    expect(info.columns.slice(firstChild).every((c) => c.child)).toBe(true);
    expect(info.columns.every((c) => c.name === c.name.toUpperCase())).toBe(true);
  });

  it("describeObjectStructure(child) はその子の列だけを返し、無い子は拒否する", async () => {
    const client = clientFor(createFakeMaximo(sampleSeed()));
    const cols = await describeObjectStructure(client, "MXAPIWO", "ext_wopermit");
    expect(cols.map((c) => c.name)).toEqual(["EXT_WOPERMIT.EXT_WOPERMITID", "EXT_WOPERMIT.EXT_AUTHORITY", "EXT_WOPERMIT.EXT_PERMITTYPE", "EXT_WOPERMIT.EXT_PERMITDATE", "EXT_WOPERMIT.EXT_MEMO"]);
    await expect(describeObjectStructure(client, "MXAPIWO", "NOSUCH")).rejects.toThrow(/NOSUCH/);
    expect((await describeObjectStructure(client, "MXAPIWO")).length).toBeGreaterThan(cols.length);
  });

  it("不正なオブジェクト構造名は送らずに拒否する", async () => {
    const fake = createFakeMaximo(sampleSeed());
    await expect(getObjectStructureInfo(clientFor(fake), "mxapiwo/../x")).rejects.toThrow();
    await expect(getObjectStructureInfo(clientFor(fake), "mxapiwo?oslc.select=*")).rejects.toThrow();
    expect(fake.state.requests).toHaveLength(0);
  });

  it("readOnly の表記ゆれ・subType・object 形式の子・孫・collectionref を扱う", () => {
    const info = parseJsonSchema("x", {
      required: ["a"],
      properties: {
        a: { type: "string", "x-readonly": true },
        b: { type: "string", readonly: "true", subType: "SMALLINT" },
        c: { type: "number", subType: "AMOUNT", required: true },
        d: { type: "string", subType: "YORN" },
        e: { type: "weird" },
        f: { type: "string", format: "date-time" },
        spec_collectionref: { type: "string" },
        _rowstamp: { type: "string" },
        single: { type: "object", objectName: "SINGLE", properties: { singleid: { type: "integer" }, v: { type: "string" }, grand: { type: "array", items: { properties: { g: {} } } } } },
        loose: { type: "array" },
      },
    });
    const col = (name: string) => info.columns.find((x) => x.name === name);
    expect(col("A")).toMatchObject({ readOnly: true, required: true });
    expect(col("B")).toMatchObject({ readOnly: true, type: "integer" });
    expect(col("C")).toMatchObject({ type: "number", required: true });
    expect(col("D")?.type).toBe("boolean");
    expect(col("E")?.type).toBe("unknown");
    expect(col("F")?.type).toBe("datetime");
    expect(col("SPEC_COLLECTIONREF")).toBeUndefined();
    expect(col("SINGLE.V")).toMatchObject({ child: "SINGLE" });
    expect(col("SINGLE.GRAND")).toBeUndefined();
    expect(col("LOOSE")).toBeUndefined();
    expect(info.childIdAttrs).toEqual({ SINGLE: "SINGLEID" });
    expect(info.keyColumns).toEqual([]);
    expect(() => parseJsonSchema("x", "nope")).toThrow();
  });
});

describe("inferChildIdAttr（子の ID 属性の推定規則）", () => {
  const props = (...names: string[]) => ({ properties: Object.fromEntries(names.map((n) => [n, { type: "string" }])) });

  it("<子オブジェクト名>ID を採る", () => {
    expect(inferChildIdAttr("EXT_WOPERMIT", props("ext_wopermitid", "ext_memo"))).toBe("EXT_WOPERMITID");
  });

  it("既知の対応 MULTIASSETLOCCI → MULTIID（属性が実在する場合だけ）", () => {
    expect(inferChildIdAttr("MULTIASSETLOCCI", props("multiid", "assetnum"))).toBe("MULTIID");
    expect(inferChildIdAttr("MULTIASSETLOCCI", props("assetnum"))).toBeNull();
  });

  it("ID が無ければ <子オブジェクト名>UID、ID と UID が両方あれば ID", () => {
    expect(inferChildIdAttr("FOO", props("foouid", "x"))).toBe("FOOUID");
    expect(inferChildIdAttr("FOO", props("fooid", "foouid"))).toBe("FOOID");
  });

  it("OS 上の別名と違う場合は resource / objectName でも試す", () => {
    expect(inferChildIdAttr("SPEC", { resource: "ASSETSPEC", ...props("assetspecid", "alnvalue") })).toBe("ASSETSPECID");
    expect(inferChildIdAttr("SPEC", props("alnvalue"), { objectName: "ASSETSPEC" })).toBeNull();
    expect(inferChildIdAttr("SPEC", props("assetspecid"), { objectName: "ASSETSPEC" })).toBe("ASSETSPECID");
  });

  it("主キー表示が 1 属性だけならそれ、複数や推定不能なら null", () => {
    expect(inferChildIdAttr("FOO", { ...props("a", "b"), pk: ["a"] })).toBe("A");
    expect(inferChildIdAttr("FOO", { ...props("a", "b"), pk: ["a", "b"] })).toBeNull();
    expect(inferChildIdAttr("FOO", props("a", "b"))).toBeNull();
  });
});
