import { describe, expect, it } from "vitest";
import { MaximoClient, MaximoError, MaximoNetworkError, toMaximoError, type FetchLike } from "../../src/app/maximo/client";

interface Call {
  url: string;
  init: RequestInit;
}

type Step = Response | Error | ((init: RequestInit) => Promise<Response>);

/** 決めた順に応答を返す fetch。呼び出しを記録する */
function scripted(steps: Step[]): { calls: Call[]; fetchImpl: FetchLike } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const s = steps.shift();
    if (s === undefined) throw new Error("想定外の呼び出し");
    if (s instanceof Error) throw s;
    if (typeof s === "function") return s(init);
    return s;
  };
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const headersOf = (c: Call) => c.init.headers as Record<string, string>;

function makeClient(fetchImpl: FetchLike, extra: Partial<ConstructorParameters<typeof MaximoClient>[0]> = {}) {
  const sleeps: number[] = [];
  const client = new MaximoClient({
    baseUrl: "https://maximo.test",
    apiKey: () => "secret-key-123",
    via: "direct",
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    retryBaseMs: 100,
    ...extra,
  });
  return { client, sleeps };
}

describe("MaximoClient: 送り先とヘッダ", () => {
  it("proxy は /mx + path に X-Maximo-Base / X-Maximo-Apikey を付け、apikey ヘッダは付けない", async () => {
    const { calls, fetchImpl } = scripted([json(200, { ok: 1 })]);
    const { client } = makeClient(fetchImpl, { via: "proxy" });
    await expect(client.get("/maximo/api/os/mxapiwo?lean=1")).resolves.toEqual({ ok: 1 });
    expect(calls[0]!.url).toBe("/mx/maximo/api/os/mxapiwo?lean=1");
    const h = headersOf(calls[0]!);
    expect(h["X-Maximo-Base"]).toBe("https://maximo.test");
    expect(h["X-Maximo-Apikey"]).toBe("secret-key-123");
    expect(h["apikey"]).toBeUndefined();
    // /mx は Worker のログインセッション（Cookie）を要求するので、同一オリジンの Cookie は送る
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("direct は baseUrl + path に apikey ヘッダを付け、Maximo へ Cookie を送らない", async () => {
    const { calls, fetchImpl } = scripted([json(200, { ok: 1 })]);
    const { client } = makeClient(fetchImpl, { baseUrl: "https://maximo.test/" });
    await client.get("/maximo/api/apimeta?lean=1");
    expect(calls[0]!.url).toBe("https://maximo.test/maximo/api/apimeta?lean=1");
    const h = headersOf(calls[0]!);
    expect(h["apikey"]).toBe("secret-key-123");
    expect(h["X-Maximo-Apikey"]).toBeUndefined();
    expect(h["X-Maximo-Base"]).toBeUndefined();
    expect(calls[0]!.init.credentials).toBe("omit");
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("API キーは呼び出しごとに取り出し、URL には載せない", async () => {
    const { calls, fetchImpl } = scripted([json(200, {}), json(200, {})]);
    let n = 0;
    const { client } = makeClient(fetchImpl, { apiKey: () => `key-${++n}` });
    await client.get("/maximo/api/os/a?lean=1");
    await client.get("/maximo/api/os/a?lean=1");
    expect(headersOf(calls[0]!)["apikey"]).toBe("key-1");
    expect(headersOf(calls[1]!)["apikey"]).toBe("key-2");
    for (const c of calls) expect(c.url).not.toMatch(/key-/);
  });

  it("クエリに apikey を含む path は送らずに拒否する", async () => {
    const { calls, fetchImpl } = scripted([]);
    const { client } = makeClient(fetchImpl);
    await expect(client.get("/maximo/api/os/mxapiwo?lean=1&apikey=abc")).rejects.toThrow(/API key in the query/);
    await expect(client.get("/maximo/api/os/mxapiwo?APIKEY=abc")).rejects.toThrow(/API key in the query/);
    await expect(client.post("/maximo/api/os/mxapiwo/_A?apikey=x", {}, {})).rejects.toThrow(/API key in the query/);
    expect(calls).toHaveLength(0);
  });

  it("キーが空なら送らない", async () => {
    const { calls, fetchImpl } = scripted([]);
    const { client } = makeClient(fetchImpl, { apiKey: () => "" });
    await expect(client.get("/maximo/api/apimeta")).rejects.toThrow(/API key is not set/);
    expect(calls).toHaveLength(0);
  });

  it("相対でない path や // で始まる path は拒否する", async () => {
    const { client } = makeClient(scripted([]).fetchImpl);
    await expect(client.get("https://evil.test/maximo/api")).rejects.toThrow();
    await expect(client.get("//evil.test/maximo/api")).rejects.toThrow();
  });

  it("proxy の baseUrl は https でパスを含まない形だけを受け付ける（/mx の検査と同じ）", () => {
    const fetchImpl = scripted([]).fetchImpl;
    expect(() => new MaximoClient({ baseUrl: "http://maximo.test", apiKey: () => "k", via: "proxy", fetchImpl })).toThrow();
    expect(() => new MaximoClient({ baseUrl: "https://maximo.test/prefix", apiKey: () => "k", via: "proxy", fetchImpl })).toThrow();
    expect(() => new MaximoClient({ baseUrl: "https://maximo.test:9443/", apiKey: () => "k", via: "proxy", fetchImpl })).not.toThrow();
    expect(() => new MaximoClient({ baseUrl: "http://localhost:9080", apiKey: () => "k", via: "direct", fetchImpl })).not.toThrow();
    // http はキーが平文で流れるのでループバック以外は拒否する
    expect(() => new MaximoClient({ baseUrl: "http://maximo.test", apiKey: () => "k", via: "direct", fetchImpl })).toThrow(/https/);
    expect(() => new MaximoClient({ baseUrl: "http://127.0.0.1:9080/maximo-dev", apiKey: () => "k", via: "direct", fetchImpl })).not.toThrow();
    expect(() => new MaximoClient({ baseUrl: "ftp://maximo.test", apiKey: () => "k", via: "direct", fetchImpl })).toThrow();
    expect(() => new MaximoClient({ baseUrl: "https://u:p@maximo.test", apiKey: () => "k", via: "direct", fetchImpl })).toThrow();
    expect(() => new MaximoClient({ baseUrl: "https://maximo.test?x=1", apiKey: () => "k", via: "direct", fetchImpl })).toThrow();
  });
});

describe("MaximoClient: エラー", () => {
  it("{Error:{reasonCode,message,statusCode}} を MaximoError にする", async () => {
    const { fetchImpl } = scripted([json(400, { Error: { reasonCode: "BMXAA8744E", message: "where が不正", statusCode: "400" } })]);
    const { client } = makeClient(fetchImpl);
    const err = await client.get("/maximo/api/os/mxapiwo?lean=1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaximoError);
    expect(err).toMatchObject({ status: 400, reasonCode: "BMXAA8744E", message: "where が不正" });
  });

  it("toMaximoError は小文字の error と形の崩れた本文も扱う", () => {
    expect(toMaximoError(403, { error: { reasonCode: "BMXAA9301E", message: "権限" } })).toMatchObject({ status: 403, reasonCode: "BMXAA9301E" });
    const e = toMaximoError(500, "<html>");
    expect(e.reasonCode).toBeNull();
    expect(e.message).toMatch(/500/);
    // HTTP の状態が 2xx でも本文の statusCode がエラーならそちらを使う
    expect(toMaximoError(200, { Error: { statusCode: "409", message: "dup" } }).status).toBe(409);
    // 橋渡しの /mx 自身のエラーは reasonCode にせず、メッセージを残す
    const proxyErr = toMaximoError(401, { ok: false, error: "unauthorized", message: "ログインが必要です。" });
    expect(proxyErr).toMatchObject({ status: 401, reasonCode: null });
    expect(proxyErr.message).toMatch(/ログインが必要.*unauthorized/);
  });

  it("2xx でも本文の最上位が {Error:{...}} なら GET も POST も MaximoError にする", async () => {
    const errBody = { Error: { reasonCode: "BMXAA4214E", message: "batch error", statusCode: "400" } };
    const { calls, fetchImpl } = scripted([json(200, errBody), json(200, errBody)]);
    const { client, sleeps } = makeClient(fetchImpl);
    await expect(client.get("/maximo/api/os/mxapiwo?lean=1")).rejects.toMatchObject({ name: "MaximoError", status: 400, reasonCode: "BMXAA4214E" });
    await expect(client.post("/maximo/api/os/mxapiwo/_A?lean=1", {}, {})).rejects.toMatchObject({ name: "MaximoError", status: 400, reasonCode: "BMXAA4214E" });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([]);
    // 属性として error を持つだけの普通の応答はエラーにしない
    const ok = scripted([json(200, { error: "E-1", member: [] })]);
    await expect(makeClient(ok.fetchImpl).client.get("/maximo/api/os/x?lean=1")).resolves.toEqual({ error: "E-1", member: [] });
  });

  it("JSON でない応答（ログイン画面など）はエラーにし、再試行しない", async () => {
    const { calls, fetchImpl } = scripted([new Response("<html>login</html>", { status: 200 })]);
    const { client } = makeClient(fetchImpl);
    await expect(client.get("/maximo/api/apimeta")).rejects.toBeInstanceOf(MaximoError);
    expect(calls).toHaveLength(1);
  });

  it("通信エラーのメッセージに URL やキーを含めない", async () => {
    const { fetchImpl } = scripted([new TypeError("failed https://maximo.test secret-key-123"), new TypeError("x"), new TypeError("x"), new TypeError("x")]);
    const { client } = makeClient(fetchImpl);
    const err = await client.get("/maximo/api/apimeta").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaximoNetworkError);
    expect((err as Error).message).not.toMatch(/secret|maximo\.test/);
  });

  it("タイムアウトは MaximoNetworkError(timedOut) にする", async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const { fetchImpl } = scripted([hang]);
    const { client } = makeClient(fetchImpl, { timeoutMs: 5 });
    const err = await client.post("/maximo/api/os/mxapiwo/_A?lean=1", {}, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaximoNetworkError);
    expect((err as MaximoNetworkError).timedOut).toBe(true);
  });
});

describe("MaximoClient: 再試行", () => {
  it("GET は 429/502/503/504 と通信エラーを指数バックオフで再試行する（Retry-After を尊重）", async () => {
    const { calls, fetchImpl } = scripted([
      json(503, {}),
      json(429, {}, { "retry-after": "2" }),
      new TypeError("network"),
      json(504, {}),
    ]);
    const { client, sleeps } = makeClient(fetchImpl);
    const err = await client.get("/maximo/api/apimeta").catch((e: unknown) => e);
    // 最初の 1 回 + 再試行 3 回で打ち切る
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([100, 2000, 400]);
    expect(err).toBeInstanceOf(MaximoError);
    expect((err as MaximoError).status).toBe(504);
  });

  it("GET は再試行の途中で成功すれば値を返す", async () => {
    const { calls, fetchImpl } = scripted([json(502, {}), json(200, { member: [] })]);
    const { client, sleeps } = makeClient(fetchImpl);
    await expect(client.get("/maximo/api/os/x?lean=1")).resolves.toEqual({ member: [] });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([100]);
  });

  it("GET の通信エラーが続けば MaximoNetworkError を投げる", async () => {
    const { calls, fetchImpl } = scripted([new TypeError("a"), new TypeError("b"), new TypeError("c"), new TypeError("d")]);
    const { client, sleeps } = makeClient(fetchImpl);
    await expect(client.get("/maximo/api/apimeta")).rejects.toBeInstanceOf(MaximoNetworkError);
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it.each([400, 401, 403, 404, 409, 500])("GET の %i は再試行しない", async (status) => {
    const { calls, fetchImpl } = scripted([json(status, { Error: { reasonCode: "X", message: "m" } })]);
    const { client, sleeps } = makeClient(fetchImpl);
    await expect(client.get("/maximo/api/apimeta")).rejects.toBeInstanceOf(MaximoError);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("POST（書き込み）は 503 でも通信エラーでも再試行しない", async () => {
    const a = scripted([json(503, {})]);
    const c1 = makeClient(a.fetchImpl);
    await expect(c1.client.post("/maximo/api/os/mxapiwo/_A?lean=1", { patchtype: "MERGE" }, { x: 1 })).rejects.toBeInstanceOf(MaximoError);
    expect(a.calls).toHaveLength(1);
    expect(c1.sleeps).toEqual([]);

    const b = scripted([new TypeError("network")]);
    const c2 = makeClient(b.fetchImpl);
    await expect(c2.client.post("/maximo/api/os/mxapiwo/_A?lean=1", {}, {})).rejects.toBeInstanceOf(MaximoNetworkError);
    expect(b.calls).toHaveLength(1);
    expect(c2.sleeps).toEqual([]);
  });

  it("POST は本文を JSON にし、2xx の空本文は null で返す", async () => {
    const { calls, fetchImpl } = scripted([new Response(null, { status: 204 })]);
    const { client } = makeClient(fetchImpl);
    await expect(client.post("/maximo/api/os/mxapiwo/_A?lean=1", { patchtype: "MERGE" }, { description: "x" })).resolves.toEqual({ status: 204, body: null });
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ description: "x" }));
    expect(headersOf(calls[0]!)["patchtype"]).toBe("MERGE");
  });
});

describe("MaximoClient.hrefToPath", () => {
  const { client } = makeClient(scripted([]).fetchImpl);

  it("別オリジンの href はオリジンを捨てて path+query にする", () => {
    expect(client.hrefToPath("https://mx-internal.local:9443/maximo/api/os/mxapiwo/_QlBN?lean=1&pageno=2")).toBe("/maximo/api/os/mxapiwo/_QlBN?lean=1&pageno=2");
  });

  it("コンテキストルートの外・フラグメント付き・符号化したドットは拒否する", () => {
    expect(() => client.hrefToPath("https://maximo.test/other/api/os/x")).toThrow();
    expect(() => client.hrefToPath("https://maximo.test/maximo/../admin")).toThrow();
    expect(() => client.hrefToPath("https://maximo.test/maximo/api/os/x#frag")).toThrow();
    expect(() => client.hrefToPath("https://maximo.test/maximo/api/%2e%2e/x")).toThrow();
    expect(() => client.hrefToPath("https://maximo.test/maximo/api/os%2fx")).toThrow();
  });

  it("/mx と同じく ;（..;/）・二重符号化・正規化で消える . / .. を含む href は拒否する", () => {
    expect(() => client.hrefToPath("https://maximo.test/maximo/api/os/..;/..;/admin")).toThrow();
    expect(() => client.hrefToPath("https://maximo.test/maximo/api/os/mxapiwo;jsessionid=1/_A")).toThrow();
    expect(() => client.hrefToPath("https://maximo.test/maximo/api/os/%252e%252e/x")).toThrow();
    // URL の解析では /maximo/api/os/mxasset/_A に正規化されてしまうもの
    expect(() => client.hrefToPath("https://maximo.test/maximo/api/os/mxapiwo/../mxasset/_A")).toThrow();
    expect(() => client.hrefToPath("/maximo/api/./os/mxapiwo/_A")).toThrow();
    // クエリの中の %25 や ; はパスではないので通す
    expect(client.hrefToPath("https://maximo.test/maximo/api/os/mxapiwo?oslc.where=description%3D%22%2525%22;x&pageno=2")).toBe(
      "/maximo/api/os/mxapiwo?oslc.where=description%3D%22%2525%22;x&pageno=2",
    );
    expect(client.hrefToPath("/maximo/api/os/mxapiwo/_QlBN")).toBe("/maximo/api/os/mxapiwo/_QlBN");
  });
});
