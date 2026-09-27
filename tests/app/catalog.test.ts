// オブジェクト構造のカタログ（作業画面の設定）の試験。
// 保存先に残ること、接続先ごとに分かれること、保存に失敗してもタブの中では使えること、
// 同じ構造を同時に読み込んでも Maximo へは 1 回だけ取りに行くことを確かめる。

import { describe, expect, it } from "vitest";
import { startCatalogAutoSync } from "../../src/app/catalog/autosync";
import { ObjectStructureCatalog } from "../../src/app/catalog/catalog";
import { createMemoryCatalogStorage, normalizeScope, type CatalogStorage } from "../../src/app/catalog/storage";
import { MaximoClient, type FetchLike } from "../../src/app/maximo/client";
import type { ConnectionProvider, MaximoConnection } from "../../src/app/runtime/contracts";
import { createFakeMaximo, sampleSeed, withDefinitions } from "../fakes/fake-maximo";

/** 構造の多い Maximo（打ち切りと続きの試験用）。sampleSeed に単純な構造を足す */
function manySeed(extra = 8) {
  const seed = sampleSeed();
  for (let i = 1; i <= extra; i++) {
    seed.objectStructures[`MXEXTRA${String(i).padStart(2, "0")}`] = { keyAttrs: ["siteid", "extnum"], attrs: { siteid: { type: "string", required: true }, extnum: { type: "string", required: true } } };
  }
  return seed;
}

function setup(storage: CatalogStorage = createMemoryCatalogStorage(), startAt = 1_000, fetchWrap?: (f: FetchLike) => FetchLike, seed = sampleSeed()) {
  const fake = createFakeMaximo(seed);
  const fetchImpl: FetchLike = fetchWrap ? fetchWrap(fake.fetch) : fake.fetch;
  const client = new MaximoClient({ baseUrl: fake.baseUrl, apiKey: () => fake.apiKey, via: "direct", fetchImpl, sleep: async () => {} });
  let t = startAt;
  const catalog = new ObjectStructureCatalog({ storage, now: () => ++t });
  const schemaRequests = () => fake.state.requests.filter((r) => r.path.includes("/jsonschemas/")).length;
  const apimetaRequests = () => fake.state.requests.filter((r) => r.path.includes("/apimeta")).length;
  const osCount = Object.keys(seed.objectStructures).length;
  return { fake, client, catalog, storage, schemaRequests, apimetaRequests, osCount };
}

/** 接続の出し入れができる ConnectionProvider（KeyVault の代わり） */
function fakeConnection(conn: MaximoConnection) {
  let current: MaximoConnection | null = null;
  const listeners = new Set<() => void>();
  const provider: ConnectionProvider & { set(on: boolean): void } = {
    current: () => current,
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    set(on: boolean) {
      current = on ? conn : null;
      for (const l of Array.from(listeners)) l();
    },
  };
  return provider;
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("待ちきれませんでした");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** すべての操作が失敗する保存先（プライベートウィンドウなどで IndexedDB が使えない場合） */
function brokenStorage(): CatalogStorage {
  const fail = async () => {
    throw new Error("QuotaExceededError");
  };
  return { persistent: true, list: fail, put: fail, remove: fail, getApiList: fail, putApiList: fail };
}

describe("ObjectStructureCatalog", () => {
  it("読み込んだ構造を保存先に残し、同じ保存先を使う別のカタログ（ブラウザを開き直した後）は Maximo に取りに行かない", async () => {
    const a = setup();
    const first = await a.catalog.ensure(a.client, a.fake.baseUrl, "mxapiwo");
    expect(first.fetched).toBe(true);
    expect(first.entry.os).toBe("MXAPIWO");
    expect(first.entry.info.keyColumns).toEqual(["SITEID", "WONUM"]);
    expect(a.schemaRequests()).toBe(1);

    // 開き直した後なので時計は進んでいる
    const b = setup(a.storage, 5_000);
    const again = await b.catalog.ensure(b.client, b.fake.baseUrl, "MXAPIWO");
    expect(again.fetched).toBe(false);
    expect(again.entry.info.columns).toEqual(first.entry.info.columns);
    expect(b.schemaRequests()).toBe(0);

    const refreshed = await b.catalog.ensure(b.client, b.fake.baseUrl, "MXAPIWO", { refresh: true });
    expect(refreshed.fetched).toBe(true);
    expect(refreshed.entry.loadedAt).toBeGreaterThan(first.entry.loadedAt);
    expect(b.schemaRequests()).toBe(1);
  });

  it("接続先ごとに分かれる（末尾の / とホストの大文字小文字は同じ接続先とみなす）", async () => {
    const s = setup();
    await s.catalog.ensure(s.client, s.fake.baseUrl, "MXAPIWO");
    const upper = s.fake.baseUrl.replace(/\/\/([^/]+)/, (_m, host: string) => `//${host.toUpperCase()}`);
    expect(normalizeScope(`${upper}/`)).toBe(normalizeScope(s.fake.baseUrl));
    expect(s.catalog.get(`${upper}/`, "mxapiwo")).not.toBeNull();
    await s.catalog.ready("https://other.example.com/maximo");
    expect(s.catalog.snapshot("https://other.example.com/maximo").entries).toEqual([]);
  });

  it("同じ構造を同時に読み込んでも Maximo へは 1 回だけ取りに行き、読み込み中は snapshot の loading に出す", async () => {
    const s = setup();
    await s.catalog.ready(s.fake.baseUrl);
    const p1 = s.catalog.ensure(s.client, s.fake.baseUrl, "MXAPIWO");
    const p2 = s.catalog.ensure(s.client, s.fake.baseUrl, "mxapiwo");
    await Promise.resolve();
    await Promise.resolve();
    expect(s.catalog.snapshot(s.fake.baseUrl).loading).toEqual(["MXAPIWO"]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.entry).toBe(r2.entry);
    expect(s.schemaRequests()).toBe(1);
    const snap = s.catalog.snapshot(s.fake.baseUrl);
    expect(snap.loading).toEqual([]);
    expect(snap.entries.map((e) => e.os)).toEqual(["MXAPIWO"]);
    // 変わるまで同じオブジェクト（useSyncExternalStore のため）
    expect(s.catalog.snapshot(s.fake.baseUrl)).toBe(snap);
  });

  it("消すと保存先からも消え、変更を購読者に知らせる", async () => {
    const s = setup();
    await s.catalog.ensure(s.client, s.fake.baseUrl, "MXAPIWO");
    await s.catalog.ensure(s.client, s.fake.baseUrl, "MXASSET");
    let calls = 0;
    const unsubscribe = s.catalog.subscribe(() => calls++);
    await s.catalog.remove(s.fake.baseUrl, "mxapiwo");
    unsubscribe();
    expect(calls).toBeGreaterThan(0);
    expect(s.catalog.snapshot(s.fake.baseUrl).entries.map((e) => e.os)).toEqual(["MXASSET"]);
    expect((await s.storage.list(normalizeScope(s.fake.baseUrl))).map((e) => e.os)).toEqual(["MXASSET"]);
  });

  it("無いオブジェクト構造は保存しない", async () => {
    const s = setup();
    await expect(s.catalog.ensure(s.client, s.fake.baseUrl, "MXNOPE")).rejects.toThrow();
    expect(s.catalog.snapshot(s.fake.baseUrl).entries).toEqual([]);
    await expect(s.catalog.ensure(s.client, s.fake.baseUrl, "MX-API")).rejects.toThrow("英数字と _");
  });

  it("apimeta の一覧も保存し、refresh のときだけ取り直す", async () => {
    const s = setup();
    const list = await s.catalog.apiList(s.client, s.fake.baseUrl);
    expect(list.items.map((i) => i.name)).toEqual(expect.arrayContaining(["MXAPIWO", "MXASSET"]));
    const b = setup(s.storage);
    await b.catalog.apiList(b.client, b.fake.baseUrl);
    expect(b.fake.state.requests.filter((r) => r.path.includes("/apimeta")).length).toBe(0);
    await b.catalog.apiList(b.client, b.fake.baseUrl, { refresh: true });
    expect(b.fake.state.requests.filter((r) => r.path.includes("/apimeta")).length).toBe(1);
  });

  it("保存に失敗したらメモリに切り替えて使い続け、その理由を snapshot に出す", async () => {
    const s = setup(brokenStorage());
    const r = await s.catalog.ensure(s.client, s.fake.baseUrl, "MXAPIWO");
    expect(r.entry.os).toBe("MXAPIWO");
    const snap = s.catalog.snapshot(s.fake.baseUrl);
    expect(snap.persistent).toBe(false);
    expect(snap.storageError).toContain("タブを閉じると消えます");
    expect(snap.entries.map((e) => e.os)).toEqual(["MXAPIWO"]);
    // 切り替えた後も読み込み済みのものは使える
    expect((await s.catalog.ensure(s.client, s.fake.baseUrl, "MXAPIWO")).fetched).toBe(false);
  });

  it("保存したものを呼び出し側が書き換えても、保存先の内容は変わらない", async () => {
    const s = setup();
    await s.catalog.ensure(s.client, s.fake.baseUrl, "MXAPIWO");
    const stored = await s.storage.list(normalizeScope(s.fake.baseUrl));
    stored[0]!.info.columns.length = 0;
    expect((await s.storage.list(normalizeScope(s.fake.baseUrl)))[0]!.info.columns.length).toBeGreaterThan(0);
  });
});

/**
 * 実機（2026-09-17）の再現: 顧客が作った EXT_WOPERMIT は apimeta に載らないが、Maximo の定義（MXAPIINTOBJECT）にはあり、
 * jsonschemas も読める。移行マネージャー用・WOS の構造は定義だけあって API では使えない
 */
function customSeed() {
  const seed = sampleSeed();
  seed.objectStructures.EXT_WOPERMIT = {
    description: "J5データ移行（許可申請テーブル単独）",
    hiddenFromApimeta: true,
    keyAttrs: ["ext_wopermitid"],
    attrs: { ext_wopermitid: { type: "integer", required: true }, wonum: { type: "string", title: "工事管理No." }, ext_permitdate: { type: "date", title: "許可取得日" } },
  };
  return withDefinitions(seed, [
    { name: "DMMAXAPPS", usewith: "マイグレーション・マネージャー" },
    { name: "WOSINVBAL", usewith: "WOS" },
  ]);
}

describe("Maximo からの機械的な読み込み（syncAll）", () => {
  it("apimeta に載らない構造も Maximo の定義（MXAPIINTOBJECT）から足して読み込み、API で使えない適用先の構造は読みに行かない", async () => {
    const s = setup(createMemoryCatalogStorage(), 1_000, undefined, customSeed());
    const result = await s.catalog.syncAll(s.client, s.fake.baseUrl);
    // MXAPIWO・MXASSET・EXT_WOPERMIT・MXAPIINTOBJECT
    expect(result).toMatchObject({ state: "done", total: 4, done: 4, failed: [] });
    const snap = s.catalog.snapshot(s.fake.baseUrl);
    expect(snap.entries.map((e) => e.os)).toEqual(["EXT_WOPERMIT", "MXAPIINTOBJECT", "MXAPIWO", "MXASSET"]);
    expect(snap.apiList).toMatchObject({ definedCount: 6, addedFromDefinitions: 1, notApi: [{ name: "DMMAXAPPS" }, { name: "WOSINVBAL" }] });
    expect(snap.apiList?.definedError).toBeUndefined();
    expect(s.fake.state.requests.some((r) => /jsonschemas\/(dmmaxapps|wosinvbal)/.test(r.path))).toBe(false);
    // 保存した一覧も同じ内訳（ブラウザを開き直しても画面に出せる）
    expect(await s.storage.getApiList(normalizeScope(s.fake.baseUrl))).toMatchObject({ definedCount: 6, addedFromDefinitions: 1 });
  });

  it("Maximo の定義（MXAPIINTOBJECT）を読めなくても apimeta の一覧だけで読み込み、読めなかった理由を一覧に残す", async () => {
    const s = setup(createMemoryCatalogStorage(), 1_000, (f) => async (url, init) => {
      if (url.includes("/os/mxapiintobject")) return new Response(JSON.stringify({ Error: { message: "権限がありません", reasonCode: "BMXAA9051E" } }), { status: 403, headers: { "content-type": "application/json" } });
      return f(url, init);
    }, customSeed());
    const result = await s.catalog.syncAll(s.client, s.fake.baseUrl);
    expect(result).toMatchObject({ state: "done", total: 3, failed: [] });
    const list = s.catalog.snapshot(s.fake.baseUrl).apiList!;
    expect(list.items.map((i) => i.name)).toEqual(["MXAPIINTOBJECT", "MXAPIWO", "MXASSET"]);
    expect(list).toMatchObject({ definedCount: null, addedFromDefinitions: 0, notApi: [] });
    expect(list.definedError).toContain("403");
  });

  it("一覧は読み込みのたびに Maximo から取り直し、後から作られた構造も読み込む（保存済みの定義は読み直さない）", async () => {
    const s = setup(createMemoryCatalogStorage(), 1_000, undefined, customSeed());
    await s.catalog.syncAll(s.client, s.fake.baseUrl);
    const before = s.schemaRequests();
    // Maximo で新しく作られた構造（apimeta には載らず、定義にだけ現れる）
    s.fake.state.os.ext_reg = { name: "ext_reg", def: { hiddenFromApimeta: true, keyAttrs: ["ext_lawid"], attrs: { ext_lawid: { type: "integer" } }, children: {} }, records: [] };
    s.fake.records("MXAPIINTOBJECT").push({ uid: "_NEW", rowstamp: 1, attrs: { intobjectname: "EXT_REG", description: "機器法規", usewith: "統合" }, children: {} });

    const again = await s.catalog.syncAll(s.client, s.fake.baseUrl);
    expect(again).toMatchObject({ state: "done", total: 1, done: 1 });
    expect(s.schemaRequests()).toBe(before + 1);
    expect(s.catalog.get(s.fake.baseUrl, "EXT_REG")).not.toBeNull();
    expect(s.apimetaRequests()).toBe(2);
  });

  it("一覧にあるすべての構造の定義を読み込んで保存し、もう一度呼んでも保存済みは読み直さない", async () => {
    const s = setup();
    await s.catalog.ensure(s.client, s.fake.baseUrl, "MXAPIWO");
    const first = await s.catalog.syncAll(s.client, s.fake.baseUrl);
    expect(first).toMatchObject({ state: "done", refresh: false, total: s.osCount - 1, done: s.osCount - 1, failed: [] });
    expect(s.catalog.snapshot(s.fake.baseUrl).entries).toHaveLength(s.osCount);
    expect(s.schemaRequests()).toBe(s.osCount);

    const again = await s.catalog.syncAll(s.client, s.fake.baseUrl);
    expect(again).toMatchObject({ state: "done", total: 0, done: 0 });
    expect(s.schemaRequests()).toBe(s.osCount);
    expect(s.catalog.snapshot(s.fake.baseUrl).sync).toBe(again);
  });

  it("refresh ならすべて読み直し、Maximo の一覧から消えた構造は保存からも消す", async () => {
    const s = setup();
    await s.catalog.syncAll(s.client, s.fake.baseUrl);
    const scope = normalizeScope(s.fake.baseUrl);
    const old = s.catalog.get(scope, "MXAPIWO")!;
    // 以前の Maximo にだけあった構造
    await s.storage.put({ ...old, os: "MXGONE", info: { ...old.info, os: "MXGONE" } });
    const b = setup(s.storage, 9_000);
    await b.catalog.ready(scope);
    expect(b.catalog.get(scope, "MXGONE")).not.toBeNull();

    const result = await b.catalog.syncAll(b.client, b.fake.baseUrl, { refresh: true });
    expect(result).toMatchObject({ state: "done", refresh: true, total: s.osCount, done: s.osCount });
    expect(b.catalog.get(scope, "MXGONE")).toBeNull();
    expect((await s.storage.list(scope)).map((e) => e.os)).not.toContain("MXGONE");
    expect(b.catalog.get(scope, "MXAPIWO")!.loadedAt).toBeGreaterThan(old.loadedAt);
    expect(b.apimetaRequests()).toBe(1);
  });

  it("読めない構造があっても続け、failed に理由を残す（保存はしない）", async () => {
    const s = setup(createMemoryCatalogStorage(), 1_000, (f) => async (url, init) => {
      if (url.includes("/jsonschemas/mxasset")) return new Response(JSON.stringify({ Error: { message: "権限がありません", reasonCode: "BMXAA0021E" } }), { status: 403, headers: { "content-type": "application/json" } });
      return f(url, init);
    });
    const result = await s.catalog.syncAll(s.client, s.fake.baseUrl);
    expect(result.state).toBe("done");
    expect(result.failed.map((f) => f.os)).toEqual(["MXASSET"]);
    expect(result.failed[0]!.message).toContain("403");
    expect(s.catalog.get(s.fake.baseUrl, "MXASSET")).toBeNull();
    expect(s.catalog.snapshot(s.fake.baseUrl).entries).toHaveLength(s.osCount - 1);
  });

  it("一覧そのものを読めなければ failed にして理由を残す", async () => {
    const s = setup(createMemoryCatalogStorage(), 1_000, (f) => async (url, init) => (url.includes("/apimeta") ? new Response("boom", { status: 500 }) : f(url, init)));
    const result = await s.catalog.syncAll(s.client, s.fake.baseUrl);
    expect(result.state).toBe("failed");
    expect(result.error).toContain("一覧を読めませんでした");
    expect(s.schemaRequests()).toBe(0);
  });

  it("接続が切れたら（shouldContinue が false）打ち切って stopped にする", async () => {
    const s = setup(createMemoryCatalogStorage(), 1_000, undefined, manySeed());
    let allowed = 2;
    const result = await s.catalog.syncAll(s.client, s.fake.baseUrl, { concurrency: 1, shouldContinue: () => allowed-- > 0 });
    expect(result.state).toBe("stopped");
    expect(result.done).toBe(2);
    expect(result.total).toBe(s.osCount);
  });

  it("読み込み中にもう一度呼ぶと、同じ読み込みを返す（二重に取りに行かない）", async () => {
    const s = setup();
    const p1 = s.catalog.syncAll(s.client, s.fake.baseUrl);
    const p2 = s.catalog.syncAll(s.client, s.fake.baseUrl, { refresh: true });
    expect(p2).toBe(p1);
    await p1;
    expect(s.schemaRequests()).toBe(s.osCount);
  });
});

describe("接続したら自動で読み込む（startCatalogAutoSync）", () => {
  it("接続したときに読み込み、同じ接続のあいだは繰り返さない。接続し直したら足りない分だけ見る", async () => {
    const s = setup();
    const info = { baseUrl: s.fake.baseUrl, via: "direct" as const, connectionName: "MAXADMIN@test", userName: "MAXADMIN", connectedAt: 1 };
    const connection = fakeConnection({ info, client: s.client });
    const stop = startCatalogAutoSync({ catalog: s.catalog, connection });
    expect(s.apimetaRequests()).toBe(0);

    connection.set(true);
    await waitUntil(() => s.catalog.snapshot(s.fake.baseUrl).sync.state === "done");
    expect(s.catalog.snapshot(s.fake.baseUrl).entries).toHaveLength(s.osCount);
    expect(s.apimetaRequests()).toBe(1);

    // 同じ接続の通知では読み込まない
    connection.set(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.apimetaRequests()).toBe(1);
    stop();
  });

  it("読み込み中に接続が切れたら止まり、また接続すると続きを読む", async () => {
    let connection: ReturnType<typeof fakeConnection> | null = null;
    let schemaCalls = 0;
    const s = setup(
      createMemoryCatalogStorage(),
      1_000,
      (f) => async (url, init) => {
        if (url.includes("/jsonschemas/") && ++schemaCalls === 2) connection?.set(false);
        return f(url, init);
      },
      manySeed(),
    );
    const info = { baseUrl: s.fake.baseUrl, via: "direct" as const, connectionName: "MAXADMIN@test", userName: "MAXADMIN", connectedAt: 1 };
    connection = fakeConnection({ info, client: s.client });
    const stop = startCatalogAutoSync({ catalog: s.catalog, connection });
    connection.set(true);
    await waitUntil(() => s.catalog.snapshot(s.fake.baseUrl).sync.state === "stopped");
    expect(s.catalog.snapshot(s.fake.baseUrl).entries.length).toBeLessThan(s.osCount);

    connection.set(true);
    await waitUntil(() => s.catalog.snapshot(s.fake.baseUrl).sync.state === "done");
    expect(s.catalog.snapshot(s.fake.baseUrl).entries).toHaveLength(s.osCount);
    stop();
  });
});
