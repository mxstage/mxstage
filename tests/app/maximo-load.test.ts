import { describe, expect, it } from "vitest";
import { MaximoClient, type FetchLike } from "../../src/app/maximo/client";
import { loadRecords, NO_ID_CHILD_PREFIX, parseMember, recordsToRows } from "../../src/app/maximo/load";
import { getObjectStructureInfo } from "../../src/app/maximo/meta";
import type { ColumnSchema } from "../../src/shared/model";
import { makeChildRowKey, makeParentKey, type MaximoRecord } from "../../src/shared/sheet";
import { createFakeMaximo, sampleSeed, type FakeMaximo } from "../fakes/fake-maximo";

async function setup(opts: { via?: "proxy" | "direct"; hrefOrigin?: string } = {}) {
  const fake = createFakeMaximo(sampleSeed(opts.hrefOrigin ? { hrefOrigin: opts.hrefOrigin } : {}));
  const client = new MaximoClient({ baseUrl: fake.baseUrl, apiKey: () => fake.apiKey, via: opts.via ?? "direct", fetchImpl: fake.fetch, sleep: async () => {} });
  const info = await getObjectStructureInfo(client, "MXAPIWO");
  fake.state.requests.length = 0;
  const knownAttrs = new Set(info.columns.map((c) => c.name));
  return { fake, client, info, knownAttrs };
}

const collectionGets = (fake: FakeMaximo) => fake.state.requests.filter((r) => r.method === "GET" && r.path.startsWith("/maximo/api/os/mxapiwo?"));

describe("loadRecords", () => {
  it("nextPage をたどって全件を読み、別オリジンの href でも同じ baseUrl に送る（concurrency 1）", async () => {
    const { fake, client, info, knownAttrs } = await setup({ hrefOrigin: "https://mx-internal.local:9443" });
    const progress: Array<[number, number | null]> = [];
    const res = await loadRecords(
      client,
      { os: "MXAPIWO", select: ["DESCRIPTION", "STATUS"], keyColumns: info.keyColumns, childIdAttrs: info.childIdAttrs, knownAttrs, pageSize: 2, concurrency: 1 },
      (loaded, total) => progress.push([loaded, total]),
    );
    expect(res.records.map((r) => r.attrs.WONUM)).toEqual(["WO1001", "WO1002", "WO1003", "WO1004", "WO1005"]);
    expect(res.total).toBe(5);
    expect(res.truncated).toBe(false);
    expect(progress).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
    const gets = collectionGets(fake);
    expect(gets).toHaveLength(3);
    for (const r of fake.state.requests) expect(r.url.startsWith("https://maximo.test/maximo/api/")).toBe(true);

    const first = new URL(gets[0]!.url);
    expect(first.searchParams.get("lean")).toBe("1");
    expect(first.searchParams.get("oslc.select")).toBe("_rowstamp,siteid,wonum,description,status");
    expect(first.searchParams.get("oslc.pageSize")).toBe("2");
    expect(first.searchParams.get("collectioncount")).toBe("1");
    expect(first.searchParams.has("oslc.where")).toBe(false);
    // href は Maximo が返したもの（内部オリジン）をそのまま記録する。送信先の付け替えはクライアントが行う
    expect(res.records[0]!.href.startsWith("https://mx-internal.local:9443/maximo/api/os/mxapiwo/")).toBe(true);
  });

  it("2 ページ目以降は pageno で並列に取り、並び順を決めて重複を取り除く（往復を減らす）", async () => {
    const { fake, client, info, knownAttrs } = await setup();
    const progress: Array<[number, number | null]> = [];
    const res = await loadRecords(
      client,
      { os: "MXAPIWO", select: ["DESCRIPTION"], keyColumns: info.keyColumns, childIdAttrs: {}, knownAttrs, pageSize: 2, concurrency: 4 },
      (loaded, total) => progress.push([loaded, total]),
    );
    expect(res.records.map((r) => r.attrs.WONUM)).toEqual(["WO1001", "WO1002", "WO1003", "WO1004", "WO1005"]);
    expect(res.truncated).toBe(false);
    // 1 ページ目のあと、2・3 ページ目を pageno で取る（nextPage は追わない）
    const gets = collectionGets(fake);
    expect(gets).toHaveLength(3);
    expect(gets.map((g) => new URL(g.url).searchParams.get("pageno"))).toEqual([null, "2", "3"]);
    // 並列でページの境目がずれないよう、指定が無ければキー列で並べる
    expect(new URL(gets[0]!.url).searchParams.get("oslc.orderBy")).toBe("+siteid,+wonum");
    expect(progress.at(-1)).toEqual([5, 5]);
  });

  it("maxRows で打ち切るときは、そこまでのページだけ取る", async () => {
    const { fake, client, info, knownAttrs } = await setup();
    const res = await loadRecords(client, {
      os: "MXAPIWO",
      select: ["DESCRIPTION"],
      keyColumns: info.keyColumns,
      childIdAttrs: {},
      knownAttrs,
      pageSize: 2,
      maxRows: 3,
    });
    expect(res.records).toHaveLength(3);
    expect(res.truncated).toBe(true);
    expect(collectionGets(fake)).toHaveLength(2);
  });

  it("属性名は大文字、子は MaximoChild（idAttr・id・rowstamp・href）にする。lean で省略された null は持たない", async () => {
    const { client, info, knownAttrs, fake } = await setup();
    const res = await loadRecords(client, {
      os: "mxapiwo",
      select: ["DESCRIPTION", "MULTIASSETLOCCI.ASSETNUM", "MULTIASSETLOCCI.ISPRIMARY", "EXT_WOPERMIT.EXT_PERMITDATE"],
      keyColumns: info.keyColumns,
      childIdAttrs: info.childIdAttrs,
      knownAttrs,
    });
    const wo = res.records[0]!;
    const uid = fake.records("mxapiwo")[0]!.uid;
    expect(wo.href).toBe(fake.hrefOf("mxapiwo", uid));
    expect(wo.rowstamp).toBe(String(fake.records("mxapiwo")[0]!.rowstamp));
    expect(wo.attrs).toEqual({ SITEID: "BEDFORD", WONUM: "WO1001", DESCRIPTION: "ポンプ点検" });
    expect(wo.children.MULTIASSETLOCCI).toHaveLength(3);
    const c0 = wo.children.MULTIASSETLOCCI![0]!;
    expect(c0).toMatchObject({ idAttr: "MULTIID", id: 1001, attrs: { MULTIID: 1001, ASSETNUM: "P-100", ISPRIMARY: true } });
    expect(typeof c0.rowstamp).toBe("string");
    expect(c0.href).toContain("/multiassetlocci/1001");
    expect(wo.children.EXT_WOPERMIT![0]).toMatchObject({ idAttr: "EXT_WOPERMITID", id: 1004, attrs: { EXT_WOPERMITID: 1004, EXT_PERMITDATE: "2026-04-01" } });
    // 子を持たない親には子のキーが無い
    expect(res.records[2]!.children).toEqual({});
  });

  it("maxRows を超えたら打ち切って truncated にし、次のページは読まない", async () => {
    const { fake, client, info, knownAttrs } = await setup();
    const res = await loadRecords(client, { os: "MXAPIWO", select: ["STATUS"], keyColumns: info.keyColumns, childIdAttrs: info.childIdAttrs, knownAttrs, pageSize: 2, maxRows: 3 });
    expect(res.records).toHaveLength(3);
    expect(res.truncated).toBe(true);
    expect(res.total).toBe(5);
    expect(collectionGets(fake)).toHaveLength(2);
  });

  it("件数がちょうど maxRows なら truncated にしない", async () => {
    const { client, info, knownAttrs } = await setup();
    const res = await loadRecords(client, { os: "MXAPIWO", select: ["STATUS"], keyColumns: info.keyColumns, childIdAttrs: info.childIdAttrs, knownAttrs, pageSize: 5, maxRows: 5 });
    expect(res.records).toHaveLength(5);
    expect(res.truncated).toBe(false);
  });

  it("where・orderBy を Maximo へ送り、子のフィルタは送らず postFilters で返す", async () => {
    const { fake, client, info, knownAttrs } = await setup();
    const res = await loadRecords(client, {
      os: "MXAPIWO",
      select: ["STATUS", "MULTIASSETLOCCI.ASSETNUM"],
      where: [
        { attr: "STATUS", op: "in", value: ["WAPPR", "APPR"] },
        { attr: "SITEID", op: "eq", value: "BEDFORD" },
        { attr: "MULTIASSETLOCCI.ASSETNUM", op: "like", value: "P-" },
      ],
      orderBy: ["-WONUM"],
      keyColumns: info.keyColumns,
      childIdAttrs: info.childIdAttrs,
      knownAttrs,
    });
    expect(res.records.map((r) => r.attrs.WONUM)).toEqual(["WO1004", "WO1002", "WO1001"]);
    expect(res.postFilters).toEqual([{ attr: "MULTIASSETLOCCI.ASSETNUM", op: "like", value: "P-" }]);
    const u = new URL(collectionGets(fake)[0]!.url);
    expect(u.searchParams.get("oslc.where")).toBe('status in ["WAPPR","APPR"] and siteid="BEDFORD"');
    expect(u.searchParams.get("oslc.orderBy")).toBe("-wonum");
  });

  it("like / isnull / notnull が fake でも期待どおりに絞り込まれる", async () => {
    const { client, info, knownAttrs } = await setup();
    const base = { os: "MXAPIWO", select: ["STATUS"], keyColumns: info.keyColumns, childIdAttrs: info.childIdAttrs, knownAttrs };
    const wonums = async (where: Parameters<typeof loadRecords>[1]["where"]) => (await loadRecords(client, { ...base, where })).records.map((r) => r.attrs.WONUM);
    expect(await wonums([{ attr: "DESCRIPTION", op: "like", value: "ポンプ" }])).toEqual(["WO1001", "WO1005"]);
    expect(await wonums([{ attr: "ESTDUR", op: "isnull" }])).toEqual(["WO1003", "WO1004"]);
    expect(await wonums([{ attr: "WOPRIORITY", op: "notnull" }, { attr: "WOPRIORITY", op: "lt", value: 3 }])).toEqual(["WO1001", "WO1002"]);
  });

  it("proxy 経由でも読め、どの URL にも API キーが載らない", async () => {
    const { fake, client, info, knownAttrs } = await setup({ via: "proxy" });
    const res = await loadRecords(client, { os: "MXAPIWO", select: ["STATUS"], keyColumns: info.keyColumns, childIdAttrs: info.childIdAttrs, knownAttrs, pageSize: 2 });
    expect(res.records).toHaveLength(5);
    for (const r of fake.state.requests) {
      expect(r.url.startsWith("/mx/maximo/api/")).toBe(true);
      expect(r.url).not.toContain(fake.apiKey);
      expect(r.headers["apikey"]).toBeUndefined();
    }
  });

  it("スキーマに無い列は送る前に拒否する", async () => {
    const { fake, client, info, knownAttrs } = await setup();
    await expect(loadRecords(client, { os: "MXAPIWO", select: ["NOSUCH"], childIdAttrs: info.childIdAttrs, knownAttrs })).rejects.toThrow(/NOSUCH/);
    await expect(loadRecords(client, { os: "MXAPIWO", select: ["STATUS"], where: [{ attr: "NOSUCH", op: "eq", value: 1 }], childIdAttrs: info.childIdAttrs, knownAttrs })).rejects.toThrow();
    await expect(loadRecords(client, { os: "MX/APIWO", select: ["STATUS"], childIdAttrs: info.childIdAttrs, knownAttrs })).rejects.toThrow();
    expect(fake.state.requests).toHaveLength(0);
  });

  describe("nextPage の異常", () => {
    const page = (next: string) =>
      new Response(JSON.stringify({ member: [{ href: "https://maximo.test/maximo/api/os/mxapiwo/_A", _rowstamp: "1", wonum: "A" }], responseInfo: { nextPage: { href: next } } }), {
        status: 200,
      });
    const clientWith = (fetchImpl: FetchLike) => new MaximoClient({ baseUrl: "https://maximo.test", apiKey: () => "k", via: "direct", fetchImpl, sleep: async () => {} });
    const opts = { os: "MXAPIWO", select: ["WONUM"], childIdAttrs: {}, knownAttrs: new Set(["WONUM"]), pageSize: 1 };

    it("別のコレクションを指す nextPage は拒否する", async () => {
      const client = clientWith(async () => page("https://maximo.test/maximo/api/os/mxasset?lean=1&pageno=2"));
      await expect(loadRecords(client, opts)).rejects.toThrow(/別のコレクション/);
    });

    it("循環する nextPage は拒否する", async () => {
      const client = clientWith(async () => page("https://other.test/maximo/api/os/mxapiwo?lean=1&pageno=2"));
      await expect(loadRecords(client, opts)).rejects.toThrow(/循環/);
    });

    it("コンテキストルートの外を指す nextPage は拒否する", async () => {
      const client = clientWith(async () => page("https://maximo.test/evil/api/os/mxapiwo?pageno=2"));
      await expect(loadRecords(client, opts)).rejects.toThrow();
    });
  });

  it("parseMember は href の無い member を拒否する", () => {
    expect(() => parseMember({ wonum: "A" }, {})).toThrow(/href/);
    expect(parseMember({ wonum: "A" }, {}, { requireHref: false }).attrs).toEqual({ WONUM: "A" });
  });
});

describe("recordsToRows", () => {
  const columns: ColumnSchema[] = [
    { name: "SITEID", type: "string" },
    { name: "WONUM", type: "string" },
    { name: "DESCRIPTION", type: "string" },
    { name: "MULTIASSETLOCCI.ASSETNUM", type: "string", child: "MULTIASSETLOCCI" },
    { name: "EXT_WOPERMIT.EXT_PERMITDATE", type: "date", child: "EXT_WOPERMIT" },
  ];
  const r1: MaximoRecord = {
    href: "https://maximo.test/maximo/api/os/mxapiwo/_1",
    rowstamp: "10",
    attrs: { SITEID: "BEDFORD", WONUM: "WO1", DESCRIPTION: "d1" },
    children: {
      MULTIASSETLOCCI: [
        { idAttr: "MULTIID", id: 11, rowstamp: "1", attrs: { MULTIID: 11, ASSETNUM: "A-1" } },
        { idAttr: "MULTIID", id: 12, rowstamp: "2", attrs: { MULTIID: 12, ASSETNUM: "A-2" } },
      ],
      EXT_WOPERMIT: [{ idAttr: "EXT_WOPERMITID", id: 21, rowstamp: "3", attrs: { EXT_WOPERMITID: 21, EXT_PERMITDATE: "2026-04-01" } }],
    },
  };
  const r2: MaximoRecord = { href: "https://maximo.test/maximo/api/os/mxapiwo/_2", rowstamp: "20", attrs: { SITEID: "BEDFORD", WONUM: "WO2" }, children: {} };
  const p1 = makeParentKey(["BEDFORD", "WO1"]);
  const p2 = makeParentKey(["BEDFORD", "WO2"]);

  it("親の値を子の行数だけ繰り返し、子の種類ごとに行を作る。子の無い親は親 1 行", () => {
    const rows = recordsToRows([r1, r2], { columns, keyColumns: ["SITEID", "WONUM"] });
    const empty = { "MULTIASSETLOCCI.ASSETNUM": null, "EXT_WOPERMIT.EXT_PERMITDATE": null };
    expect(rows).toEqual([
      { rowKey: makeChildRowKey(p1, "MULTIASSETLOCCI", 11), parentKey: p1, childName: "MULTIASSETLOCCI", values: { SITEID: "BEDFORD", WONUM: "WO1", DESCRIPTION: "d1", ...empty, "MULTIASSETLOCCI.ASSETNUM": "A-1" } },
      { rowKey: makeChildRowKey(p1, "MULTIASSETLOCCI", 12), parentKey: p1, childName: "MULTIASSETLOCCI", values: { SITEID: "BEDFORD", WONUM: "WO1", DESCRIPTION: "d1", ...empty, "MULTIASSETLOCCI.ASSETNUM": "A-2" } },
      { rowKey: makeChildRowKey(p1, "EXT_WOPERMIT", 21), parentKey: p1, childName: "EXT_WOPERMIT", values: { SITEID: "BEDFORD", WONUM: "WO1", DESCRIPTION: "d1", ...empty, "EXT_WOPERMIT.EXT_PERMITDATE": "2026-04-01" } },
      { rowKey: p2, parentKey: p2, childName: null, values: { SITEID: "BEDFORD", WONUM: "WO2", DESCRIPTION: null, ...empty } },
    ]);
  });

  it("子の列を選んでいなければ、子を持つ親も親 1 行", () => {
    const rows = recordsToRows([r1, r2], { columns: columns.slice(0, 3), keyColumns: ["SITEID", "WONUM"] });
    expect(rows.map((r) => [r.rowKey, r.childName])).toEqual([
      [p1, null],
      [p2, null],
    ]);
  });

  it("キー列が無ければ href を親キーにし、キー列が列に無くても値に入れる", () => {
    expect(recordsToRows([r2], { columns: [{ name: "DESCRIPTION", type: "string" }], keyColumns: [] })[0]!.rowKey).toBe(r2.href);
    const withKey = recordsToRows([r2], { columns: [{ name: "DESCRIPTION", type: "string" }], keyColumns: ["WONUM"] })[0]!;
    expect(withKey.values).toEqual({ DESCRIPTION: null, WONUM: "WO2" });
  });

  it("ID の分からない子は idx~ の行キーにする", () => {
    const rec: MaximoRecord = { ...r2, children: { EXT_WOPERMIT: [{ idAttr: null, id: null, rowstamp: null, attrs: { EXT_PERMITDATE: "2026-01-01" } }] } };
    const rows = recordsToRows([rec], { columns, keyColumns: ["SITEID", "WONUM"] });
    expect(rows[0]!.rowKey).toBe(makeChildRowKey(p2, "EXT_WOPERMIT", `${NO_ID_CHILD_PREFIX}0`));
  });

  it("親キーや子 ID が重複していれば止める", () => {
    expect(() => recordsToRows([r2, { ...r2, href: "x" }], { columns, keyColumns: ["SITEID", "WONUM"] })).toThrow(/重複/);
    const dupChild: MaximoRecord = { ...r2, children: { MULTIASSETLOCCI: [r1.children.MULTIASSETLOCCI![0]!, r1.children.MULTIASSETLOCCI![0]!] } };
    expect(() => recordsToRows([dupChild], { columns, keyColumns: ["SITEID", "WONUM"] })).toThrow(/重複/);
  });

  it("fake から読んだレコードを行にできる", async () => {
    const { client, info, knownAttrs } = await setup();
    const res = await loadRecords(client, { os: "MXAPIWO", select: ["DESCRIPTION", "MULTIASSETLOCCI.ASSETNUM"], keyColumns: info.keyColumns, childIdAttrs: info.childIdAttrs, knownAttrs });
    const meta = { columns: info.columns.filter((c) => ["SITEID", "WONUM", "DESCRIPTION", "MULTIASSETLOCCI.ASSETNUM"].includes(c.name)), keyColumns: info.keyColumns };
    const rows = recordsToRows(res.records, meta);
    // WO1001 は子 3 行、WO1002 は子 1 行、残り 3 件は親 1 行
    expect(rows).toHaveLength(7);
    expect(rows.filter((r) => r.parentKey === makeParentKey(["BEDFORD", "WO1001"])).map((r) => r.values["MULTIASSETLOCCI.ASSETNUM"])).toEqual(["P-100", "P-101", "P-102"]);
  });
});
