// Maximo が無くても試せるデモ（src/bridge/demo.ts）と、その入口（/_mxstage/demo・/mx のデモの接続先・接続先の一覧の demo）。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionStore, normalizeConnectionUrl } from "../../src/bridge/connections.ts";
import { DemoManager, parseManifest, normalizeDataUrl, DEMO_FILE_LIMIT } from "../../src/bridge/demo.ts";
import { parseMaximoBase, type UpstreamRequest } from "../../src/bridge/mx.ts";
import { SecretBox } from "../../src/bridge/secretBox.ts";
import { CONNECTIONS_PATH, CONNECTIONS_USE_PATH } from "../../src/bridge/server.ts";
import { sampleSeed } from "../../src/demo/fakeMaximo.ts";
import { DEMO_FORMAT, seedToFiles, sha256 } from "../../src/demo/format.ts";
import {
  DEMO_CLOSE_PATH,
  DEMO_DATA_URL,
  DEMO_DATA_VERSION,
  DEMO_DOWNLOAD_PATH,
  DEMO_EXCEL_PREFIX,
  DEMO_ORIGINS,
  DEMO_PATH,
  DEMO_REMOVE_PATH,
  DEMO_RESET_PATH,
  demoLangOfBaseUrl,
  demoLangOfConnectionId,
  isReservedDemoHost,
  type DemoLang,
  type DemoStatus,
} from "../../src/shared/demo.ts";
import { rawRequest, startTestBridge, stopAll, waitFor } from "./support.ts";

/** この製品が使うデータの版のフォルダ（v<版>） */
const V = `v${DEMO_DATA_VERSION}`;

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mxs-demo-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await stopAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DATA_URL = "https://demo-data.example.test";
const XLSX_NAME = "発注一覧_令和8年度上半期.xlsx";

/** 置き場所の中身（v<版>/manifest.json と、言語ごとのファイル）を、小さな種から作る */
function publishedFiles(): { files: Map<string, Buffer>; manifestSha: string } {
  const { osdefs, records } = seedToFiles(sampleSeed());
  const files = new Map<string, Buffer>();
  const languages: Record<string, { files: unknown[] }> = {};
  for (const lang of ["ja", "en"] as const) {
    const list: unknown[] = [];
    const add = (path: string, kind: string, bytes: Uint8Array, extra: Record<string, unknown> = {}): void => {
      files.set(`${V}/${path}`, Buffer.from(bytes));
      list.push({ path, kind, bytes: bytes.byteLength, sha256: sha256(bytes), ...extra });
    };
    add(`${lang}/osdefs.json.gz`, "osdefs", osdefs);
    for (const r of records) add(`${lang}/os/${r.os}.ndjson.gz`, "records", r.bytes, { os: r.os, records: r.count });
    add(`${lang}/excel/purchase-orders.xlsx`, "excel", Buffer.from(`PK sample ${lang}`), { title: "発注一覧", fileName: XLSX_NAME });
    languages[lang] = { files: list };
  }
  const manifest = Buffer.from(JSON.stringify({ format: DEMO_FORMAT, version: DEMO_DATA_VERSION, asOf: "2026-09-30T17:00:00+09:00", languages }));
  files.set(`${V}/manifest.json`, manifest);
  return { files, manifestSha: sha256(manifest) };
}

interface Host {
  files: Map<string, Buffer>;
  manifestSha: string;
  requests: string[];
  fetch: typeof fetch;
}

/** 置き場所（Cloudflare Pages の代わり）。届いた要求の URL を残す */
function host(): Host {
  const { files, manifestSha } = publishedFiles();
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (!url.startsWith(`${DATA_URL}/`)) throw new TypeError("Failed to fetch");
    const body = files.get(url.slice(DATA_URL.length + 1));
    return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { files, manifestSha, requests, fetch: fetchImpl };
}

function manager(h: Host, dir = tempDir(), extra: Partial<ConstructorParameters<typeof DemoManager>[0]> = {}): DemoManager {
  return new DemoManager({ dir, dataUrl: DATA_URL, manifestSha256: h.manifestSha, fetch: h.fetch, ...extra });
}

async function downloaded(h: Host, lang: DemoLang = "ja", dir = tempDir()): Promise<DemoManager> {
  const demo = manager(h, dir);
  demo.startDownload(lang);
  await demo.whenDownloaded(lang);
  expect(demo.status().languages[lang]).toMatchObject({ state: "ready", error: null });
  return demo;
}

function fileStore(dir = tempDir()): ConnectionStore {
  return new ConnectionStore({ dir, now: () => 1_000, box: new SecretBox({ dir, platform: "linux" }) });
}

const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };
const JSON_HEADERS = { "content-type": "application/json", "sec-fetch-site": "same-origin" };

describe("デモの決まりごと（src/shared/demo.ts）", () => {
  it("予約の ID・オリジン・ホストを見分ける", () => {
    expect(demoLangOfConnectionId("demo-ja")).toBe("ja");
    expect(demoLangOfConnectionId("demo-en")).toBe("en");
    expect(demoLangOfConnectionId("c_0123456789abcdef")).toBeNull();
    expect(demoLangOfBaseUrl("https://demo-en.mxstage.invalid/")).toBe("en");
    expect(demoLangOfBaseUrl("https://maximo.example.com")).toBeNull();
    expect(isReservedDemoHost("demo-ja.mxstage.invalid")).toBe(true);
    expect(isReservedDemoHost("x.MXSTAGE.invalid.")).toBe(true);
    expect(isReservedDemoHost("mxstage.example.com")).toBe(false);
  });

  it("置き場所は https（と手元の http）だけ。それ以外は既定に戻す", () => {
    expect(normalizeDataUrl(undefined)).toBe(DEMO_DATA_URL);
    expect(normalizeDataUrl("http://127.0.0.1:8123/")).toBe("http://127.0.0.1:8123");
    expect(normalizeDataUrl("http://evil.example.com")).toBe(DEMO_DATA_URL);
    expect(normalizeDataUrl("file:///etc/passwd")).toBe(DEMO_DATA_URL);
  });

  it("予約のホストは、接続先として保存できず、普通の中継でも断る（ネットに出さない）", () => {
    expect(normalizeConnectionUrl(DEMO_ORIGINS.ja)).toBeNull();
    expect(parseMaximoBase(DEMO_ORIGINS.en, [])).toMatchObject({ status: 400, error: "reserved_host" });
  });
});

describe("落とす（DemoManager）", () => {
  it("目録と各ファイルを SHA-256 で確かめて置き、次からはネットにつながずに使う", async () => {
    const h = host();
    const dir = tempDir();
    await downloaded(h, "ja", dir);
    expect(h.requests[0]).toBe(`${DATA_URL}/${V}/manifest.json`);
    // 英語のファイルは落とさない
    expect(h.requests.some((u) => u.includes("/en/"))).toBe(false);
    expect(existsSync(join(dir, V, "ja", "osdefs.json.gz"))).toBe(true);

    const offline = new DemoManager({ dir, dataUrl: DATA_URL, manifestSha256: h.manifestSha, fetch: (() => Promise.reject(new TypeError("offline"))) as typeof fetch });
    expect(offline.readyLanguages()).toEqual(["ja"]);
    const fake = await offline.load("ja");
    expect(fake.records("mxapiwo")).toHaveLength(5);
    expect(fake.baseUrl).toBe(DEMO_ORIGINS.ja);
  });

  it("目録が埋め込んだ SHA-256 と合わなければ止まり、何も使えるようにしない", async () => {
    const h = host();
    const demo = manager(h, tempDir(), { manifestSha256: "0".repeat(64) });
    demo.startDownload("ja");
    await demo.whenDownloaded("ja");
    expect(demo.status().languages.ja).toMatchObject({ state: "failed", error: "manifest_mismatch" });
    expect(demo.readyLanguages()).toEqual([]);
    expect(h.requests).toHaveLength(1);
  });

  it("ファイルが目録と違えば止まる。直ったらやり直せ、確かめ済みのファイルは落とし直さない", async () => {
    const h = host();
    const dir = tempDir();
    const target = [...h.files.keys()].find((k) => k.startsWith(`${V}/ja/os/`))!;
    const good = h.files.get(target)!;
    h.files.set(target, Buffer.concat([good.subarray(0, good.byteLength - 1), Buffer.from([good[good.byteLength - 1]! ^ 1])]));
    const demo = manager(h, dir);
    demo.startDownload("ja");
    await demo.whenDownloaded("ja");
    expect(demo.status().languages.ja).toMatchObject({ state: "failed", error: "file_mismatch" });
    await expect(demo.load("ja")).rejects.toMatchObject({ problem: "not_downloaded" });

    h.files.set(target, good);
    const before = h.requests.length;
    demo.startDownload("ja");
    await demo.whenDownloaded("ja");
    expect(demo.status().languages.ja.state).toBe("ready");
    const again = h.requests.slice(before);
    expect(again).toContain(`${DATA_URL}/${target}`);
    expect(again.some((u) => u.endsWith("osdefs.json.gz"))).toBe(false);
  });

  it("目録の大きさの上限を超えるものは受けない", () => {
    const big = { format: DEMO_FORMAT, version: DEMO_DATA_VERSION, asOf: "x", languages: { ja: { files: [{ path: "ja/osdefs.json.gz", kind: "osdefs", bytes: DEMO_FILE_LIMIT + 1, sha256: "a".repeat(64) }] }, en: { files: [{ path: "en/osdefs.json.gz", kind: "osdefs", bytes: 1, sha256: "a".repeat(64) }] } } };
    expect(() => parseManifest(Buffer.from(JSON.stringify(big)), DEMO_DATA_VERSION)).toThrow(expect.objectContaining({ problem: "too_large" }));
    const escape = { ...big, languages: { ...big.languages, ja: { files: [{ path: "ja/../../x.gz", kind: "osdefs", bytes: 1, sha256: "a".repeat(64) }] } } };
    expect(() => parseManifest(Buffer.from(JSON.stringify(escape)), DEMO_DATA_VERSION)).toThrow(expect.objectContaining({ problem: "manifest_invalid" }));
  });

  it("同時に読んでも 1 回だけ作り、別の言語を読むと前の言語を放す", async () => {
    const h = host();
    const dir = tempDir();
    const demo = await downloaded(h, "ja", dir);
    demo.startDownload("en");
    await demo.whenDownloaded("en");
    const [a, b] = await Promise.all([demo.load("ja"), demo.load("ja")]);
    expect(a).toBe(b);
    await demo.load("en");
    expect(demo.status().loaded?.language).toBe("en");
    expect(await demo.load("ja")).not.toBe(a);
  });

  it("使わないまま時間が過ぎたらメモリから放す", async () => {
    const h = host();
    const demo = new DemoManager({ dir: tempDir(), dataUrl: DATA_URL, manifestSha256: h.manifestSha, fetch: h.fetch, idleMs: 30 });
    demo.startDownload("ja");
    await demo.whenDownloaded("ja");
    await demo.load("ja");
    expect(demo.status().loaded).not.toBeNull();
    await waitFor(() => demo.status().loaded === null, 2_000);
  });

  it("消すと落としたファイルが無くなり、もう一方の言語は残る", async () => {
    const h = host();
    const dir = tempDir();
    const demo = await downloaded(h, "ja", dir);
    demo.startDownload("en");
    await demo.whenDownloaded("en");
    await demo.remove("ja");
    expect(demo.readyLanguages()).toEqual(["en"]);
    expect(existsSync(join(dir, V, "ja"))).toBe(false);
    await demo.remove("en");
    expect(existsSync(join(dir, V))).toBe(false);
  });

  it("手元のファイルが壊れていれば読まない", async () => {
    const h = host();
    const dir = tempDir();
    const demo = await downloaded(h, "ja", dir);
    writeFileSync(join(dir, V, "ja", "osdefs.json.gz"), "broken");
    await expect(demo.load("ja")).rejects.toMatchObject({ problem: "unreadable" });
  });
});

describe("入口（/_mxstage/demo と /mx のデモの接続先）", () => {
  it("落とす前は 409、落としたら手元の仮想 Maximo が答える（ネットの Maximo には出ない）", async () => {
    const h = host();
    let upstreamCalled = false;
    const requestImpl = (() => {
      upstreamCalled = true;
      throw new Error("must not reach the network");
    }) as unknown as UpstreamRequest;
    const demo = manager(h);
    const bridge = await startTestBridge({ demo, connections: fileStore(), requestImpl });

    const before = await rawRequest(bridge, "/mx/maximo/api/whoami", { headers: { "x-maximo-connection": "demo-ja", ...SAME_ORIGIN } });
    expect(before.status).toBe(409);
    expect(JSON.parse(before.body)).toMatchObject({ error: "connection_demo_not_downloaded" });

    const start = await rawRequest(bridge, DEMO_DOWNLOAD_PATH, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ language: "ja" }) });
    expect(start.status).toBe(200);
    await demo.whenDownloaded("ja");
    const status = JSON.parse((await rawRequest(bridge, DEMO_PATH, { headers: SAME_ORIGIN })).body) as DemoStatus & { ok: boolean };
    expect(status).toMatchObject({ ok: true, version: DEMO_DATA_VERSION, dataHost: "demo-data.example.test", languages: { ja: { state: "ready" }, en: { state: "none" } }, loaded: null });
    expect(status.excel.ja).toEqual([expect.objectContaining({ id: "purchase-orders", fileName: XLSX_NAME })]);

    const list = await rawRequest(bridge, "/mx/maximo/api/os/mxapiwo?lean=1&oslc.select=wonum,description&oslc.pageSize=10", {
      headers: { "x-maximo-connection": "demo-ja", "x-maximo-base": "https://evil.example.com", ...SAME_ORIGIN },
    });
    expect(list.status).toBe(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    const members = (JSON.parse(list.body) as { member: Array<{ wonum: string; href: string }> }).member;
    expect(members.map((m) => m.wonum)).toContain("WO1001");
    expect(members[0]!.href.startsWith(`${DEMO_ORIGINS.ja}/maximo/api/os/mxapiwo/`)).toBe(true);
    expect(upstreamCalled).toBe(false);
  });

  it("書き込みは手元の写しにだけ効き、「初めの状態に戻す」で元に戻る", async () => {
    const h = host();
    const demo = await downloaded(h);
    const bridge = await startTestBridge({ demo, connections: fileStore() });
    const headers = { "x-maximo-connection": "demo-ja", ...SAME_ORIGIN };
    const read = async (): Promise<{ description: string; href: string }> => {
      const res = await rawRequest(bridge, '/mx/maximo/api/os/mxapiwo?lean=1&oslc.select=wonum,description&oslc.where=wonum="WO1001"', { headers });
      return (JSON.parse(res.body) as { member: Array<{ description: string; href: string }> }).member[0]!;
    };
    const first = await read();
    const path = new URL(first.href).pathname;
    const patch = await rawRequest(bridge, `/mx${path}?lean=1`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "x-method-override": "PATCH", patchtype: "MERGE" },
      body: JSON.stringify({ description: "書き換えた" }),
    });
    expect(patch.status).toBeLessThan(300);
    expect((await read()).description).toBe("書き換えた");

    const reset = await rawRequest(bridge, DEMO_RESET_PATH, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    expect(reset.status).toBe(200);
    expect((await read()).description).toBe("ポンプ点検");

    const close = await rawRequest(bridge, DEMO_CLOSE_PATH, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    expect(JSON.parse(close.body)).toMatchObject({ ok: true, loaded: null });
  });

  it("作業画面（ブラウザの同一オリジン）からだけ受ける", async () => {
    const h = host();
    const demo = await downloaded(h);
    const bridge = await startTestBridge({ demo, connections: fileStore() });
    const curl = await rawRequest(bridge, "/mx/maximo/api/whoami", { headers: { "x-maximo-connection": "demo-ja" } });
    expect(curl.status).toBe(403);
    const crossSite = await rawRequest(bridge, DEMO_DOWNLOAD_PATH, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: '{"language":"en"}' });
    expect(crossSite.status).toBe(403);
    const tool = await rawRequest(bridge, DEMO_REMOVE_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: '{"language":"ja"}' });
    expect(tool.status).toBe(403);
    expect(demo.readyLanguages()).toEqual(["ja"]);
  });

  it("サンプルの Excel を日本語のファイル名で返す", async () => {
    const h = host();
    const demo = await downloaded(h);
    const bridge = await startTestBridge({ demo });
    const res = await rawRequest(bridge, `${DEMO_EXCEL_PREFIX}ja/purchase-orders.xlsx`, { headers: SAME_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.body).toBe("PK sample ja");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="purchase-orders.xlsx"; filename*=UTF-8''${encodeURIComponent(XLSX_NAME)}`);
    expect((await rawRequest(bridge, `${DEMO_EXCEL_PREFIX}en/purchase-orders.xlsx`, { headers: SAME_ORIGIN })).status).toBe(404);
    expect((await rawRequest(bridge, `${DEMO_EXCEL_PREFIX}ja/..%2Fmanifest.xlsx`, { headers: SAME_ORIGIN })).status).toBe(404);
  });

  it("接続先の一覧に落とし済みのデモを別の配列で出し、最後に使った接続先にできる", async () => {
    const h = host();
    const dir = tempDir();
    const demo = manager(h, dir);
    const bridge = await startTestBridge({ demo, connections: fileStore() });
    const listOf = async () => JSON.parse((await rawRequest(bridge, CONNECTIONS_PATH, { headers: SAME_ORIGIN })).body) as { connections: unknown[]; demo: Array<{ id: string; baseUrl: string; environment: string }>; lastUsedId: string | null };

    expect(await listOf()).toMatchObject({ connections: [], demo: [], lastUsedId: null });
    const notYet = await rawRequest(bridge, CONNECTIONS_USE_PATH, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ id: "demo-ja" }) });
    expect(notYet.status).toBe(404);

    demo.startDownload("ja");
    await demo.whenDownloaded("ja");
    expect((await listOf()).demo).toEqual([expect.objectContaining({ id: "demo-ja", baseUrl: DEMO_ORIGINS.ja, environment: "test" })]);
    const use = await rawRequest(bridge, CONNECTIONS_USE_PATH, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ id: "demo-ja" }) });
    expect(use.status).toBe(200);
    expect((await listOf()).lastUsedId).toBe("demo-ja");

    await rawRequest(bridge, DEMO_REMOVE_PATH, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ language: "ja" }) });
    expect(await listOf()).toMatchObject({ demo: [], lastUsedId: null });
  });

  it("--no-demo（demo: null）ではデモの入口もデモの接続先も使えない", async () => {
    const bridge = await startTestBridge({ demo: null, connections: fileStore() });
    const status = await rawRequest(bridge, DEMO_PATH, { headers: SAME_ORIGIN });
    expect(status.status).toBe(404);
    expect(JSON.parse(status.body)).toMatchObject({ error: "demo_disabled" });
    const mx = await rawRequest(bridge, "/mx/maximo/api/whoami", { headers: { "x-maximo-connection": "demo-en", ...SAME_ORIGIN } });
    expect(mx.status).toBe(404);
    const list = JSON.parse((await rawRequest(bridge, CONNECTIONS_PATH, { headers: SAME_ORIGIN })).body) as { demo: unknown[] };
    expect(list.demo).toEqual([]);
  });

  it("状態の応答に、置き場所の URL の他は何も含めない（パスや API キーを出さない）", async () => {
    const h = host();
    const dir = tempDir();
    const demo = await downloaded(h, "ja", dir);
    await demo.load("ja");
    const bridge = await startTestBridge({ demo });
    const body = (await rawRequest(bridge, DEMO_PATH, { headers: SAME_ORIGIN })).body;
    expect(body).not.toContain(dir.replace(/\\/g, "\\\\"));
    expect(body).not.toContain((await demo.load("ja")).apiKey);
    expect(readFileSync(join(dir, V, "ja.complete"), "utf8").trim()).toBe(h.manifestSha);
  });
});
