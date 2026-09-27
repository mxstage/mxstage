// /mx/* の転送。上流（Maximo）は偽物に差し替えて、何をどう送ったかを確かめる。

import { PassThrough } from "node:stream";
import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MX_UPSTREAM_TIMEOUT_MS, checkProxyPath, forwardHeaders, parseMaximoBase, sanitizeUpstreamHeaders } from "../../src/bridge/mx.ts";
import type { UpstreamRequest } from "../../src/bridge/mx.ts";
import { rawRequest, startTestBridge, stopAll, waitFor } from "./support.ts";

afterEach(async () => {
  await stopAll();
});

interface Captured {
  options: Record<string, unknown> | null;
  body: string;
}

/** 上流の偽物。受け取った要求を記録し、決まった応答を返す */
function fakeUpstream(
  capture: Captured,
  response: { status?: number; headers?: Record<string, string | string[]>; body?: string } = {},
): UpstreamRequest {
  return (options, onResponse) => {
    capture.options = options as unknown as Record<string, unknown>;
    const req = new PassThrough();
    req.on("data", (c: Buffer) => {
      capture.body += c.toString("utf8");
    });
    const res = new PassThrough() as unknown as IncomingMessage & PassThrough;
    (res as unknown as { statusCode: number }).statusCode = response.status ?? 200;
    (res as unknown as { headers: Record<string, string | string[]> }).headers = response.headers ?? { "content-type": "application/json" };
    setTimeout(() => {
      onResponse(res as unknown as IncomingMessage);
      res.end(response.body ?? JSON.stringify({ member: [] }));
    }, 0);
    return req as unknown as ClientRequest;
  };
}

const BASE = "https://maximo.example.com";
const HEADERS = { "x-maximo-base": BASE, "x-maximo-apikey": "SECRET-KEY" };

describe("転送先の検査", () => {
  it("https のオリジンだけを受け付ける", () => {
    expect(parseMaximoBase(BASE, [])).toEqual({ origin: BASE });
    expect(parseMaximoBase("http://maximo.example.com", [])).toMatchObject({ error: "invalid_base" });
    expect(parseMaximoBase("https://u:p@maximo.example.com", [])).toMatchObject({ error: "invalid_base" });
    expect(parseMaximoBase("https://maximo.example.com/maximo", [])).toMatchObject({ error: "invalid_base" });
    expect(parseMaximoBase(undefined, [])).toMatchObject({ error: "missing_base" });
  });

  it("許可リストが空なら制限しない（ローカルの既定）", () => {
    expect(parseMaximoBase("https://any.example.com", [])).toEqual({ origin: "https://any.example.com" });
  });

  it("許可リストがあれば外のホストは断る", () => {
    expect(parseMaximoBase("https://any.example.com", ["maximo.example.com"])).toMatchObject({ error: "host_not_allowed" });
    expect(parseMaximoBase(BASE, ["maximo.example.com"])).toEqual({ origin: BASE });
  });

  it("許可されたパスの外へは出さない", () => {
    expect(checkProxyPath("/maximo/api/os/mxapiwo", "")).toBeNull();
    expect(checkProxyPath("/maximo/oslc/os/mxapiasset", "")).toBeNull();
    expect(checkProxyPath("/maximo/login", "")).toMatchObject({ error: "path_not_allowed" });
    expect(checkProxyPath("/maximo/api/..%2f..%2fetc", "")).toMatchObject({ error: "invalid_path" });
    expect(checkProxyPath("/maximo/api/..;/x", "")).toMatchObject({ error: "invalid_path" });
    expect(checkProxyPath("/maximo/api/os/x", "?apikey=leak")).toMatchObject({ error: "apikey_in_query" });
  });
});

describe("ヘッダの絞り込み", () => {
  it("許可したヘッダと apikey だけを送る", () => {
    const out = forwardHeaders(
      {
        accept: "application/json",
        "content-type": "application/json",
        cookie: "session=1",
        authorization: "Bearer x",
        "x-maximo-apikey": "SECRET-KEY",
        "user-agent": "test",
        properties: "a,b",
      },
      "SECRET-KEY",
    );
    expect(out).toEqual({ accept: "application/json", "content-type": "application/json", properties: "a,b", apikey: "SECRET-KEY" });
    expect(out).not.toHaveProperty("cookie");
    expect(out).not.toHaveProperty("authorization");
    expect(out).not.toHaveProperty("x-maximo-apikey");
  });

  it("上流の応答ヘッダから危ないものを外す", () => {
    const out = sanitizeUpstreamHeaders(
      { "set-cookie": ["a=1"], "www-authenticate": "Basic", "access-control-allow-origin": "*", "content-type": "application/json", location: "https://evil.example" },
      302,
    );
    expect(out).not.toHaveProperty("set-cookie");
    expect(out).not.toHaveProperty("www-authenticate");
    expect(out).not.toHaveProperty("access-control-allow-origin");
    expect(out).not.toHaveProperty("location");
    expect(out["content-type"]).toBe("application/json");
    expect(out["Cache-Control"]).toBe("no-store");
  });

  it("300 番台でなければ Location は残す", () => {
    const out = sanitizeUpstreamHeaders({ location: "/maximo/api/os/x/1" }, 201);
    expect(out.location).toBe("/maximo/api/os/x/1");
  });
});

describe("実際の転送", () => {
  it("パスとクエリを保ったまま apikey ヘッダで送る", async () => {
    const capture: Captured = { options: null, body: "" };
    const bridge = await startTestBridge({ requestImpl: fakeUpstream(capture) });
    const res = await rawRequest(bridge, "/mx/maximo/api/os/mxapiwo?oslc.select=wonum&oslc.pageSize=10", {
      headers: { ...HEADERS, accept: "application/json", cookie: "session=1" },
    });
    expect(res.status).toBe(200);
    expect(capture.options?.hostname).toBe("maximo.example.com");
    expect(capture.options?.path).toBe("/maximo/api/os/mxapiwo?oslc.select=wonum&oslc.pageSize=10");
    const sent = capture.options?.headers as Record<string, string>;
    expect(sent.apikey).toBe("SECRET-KEY");
    expect(sent.accept).toBe("application/json");
    expect(sent).not.toHaveProperty("cookie");
    // 証明書の検証は既定で有効
    expect(capture.options?.rejectUnauthorized).toBe(true);
  });

  it("POST の本文を素通しする", async () => {
    const capture: Captured = { options: null, body: "" };
    const bridge = await startTestBridge({ requestImpl: fakeUpstream(capture) });
    const res = await rawRequest(bridge, "/mx/maximo/api/os/mxapiwo", {
      method: "POST",
      headers: { ...HEADERS, "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ wonum: "1001" }),
    });
    expect(res.status).toBe(200);
    expect(capture.body).toBe(JSON.stringify({ wonum: "1001" }));
    expect(capture.options?.method).toBe("POST");
  });

  it("--insecure のときだけ証明書の検証を切る", async () => {
    const capture: Captured = { options: null, body: "" };
    const bridge = await startTestBridge({ requestImpl: fakeUpstream(capture), insecure: true });
    await rawRequest(bridge, "/mx/maximo/api/os/mxapiwo", { headers: HEADERS });
    expect(capture.options?.rejectUnauthorized).toBe(false);
  });

  it("上流の Set-Cookie とリダイレクト先は返さない", async () => {
    const capture: Captured = { options: null, body: "" };
    const bridge = await startTestBridge({
      requestImpl: fakeUpstream(capture, { status: 302, headers: { "set-cookie": "s=1", location: "https://evil.example", "content-type": "text/html" } }),
    });
    const res = await rawRequest(bridge, "/mx/maximo/api/os/mxapiwo", { headers: HEADERS });
    expect(res.status).toBe(302);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers.location).toBeUndefined();
  });

  it("キーが無ければ転送しない", async () => {
    const capture: Captured = { options: null, body: "" };
    const bridge = await startTestBridge({ requestImpl: fakeUpstream(capture) });
    const res = await rawRequest(bridge, "/mx/maximo/api/os/mxapiwo", { headers: { "x-maximo-base": BASE } });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "missing_apikey" });
    expect(capture.options).toBeNull();
  });

  it("許可されていないパスは転送しない", async () => {
    const capture: Captured = { options: null, body: "" };
    const bridge = await startTestBridge({ requestImpl: fakeUpstream(capture) });
    const res = await rawRequest(bridge, "/mx/maximo/login", { headers: HEADERS });
    expect(res.status).toBe(403);
    expect(capture.options).toBeNull();
  });

  it("GET と POST 以外は転送しない", async () => {
    const capture: Captured = { options: null, body: "" };
    const bridge = await startTestBridge({ requestImpl: fakeUpstream(capture) });
    const res = await rawRequest(bridge, "/mx/maximo/api/os/mxapiwo", { method: "DELETE", headers: { ...HEADERS, "sec-fetch-site": "same-origin" } });
    expect(res.status).toBe(405);
    expect(capture.options).toBeNull();
  });

  it("--allow-host で絞ったホスト以外は転送しない", async () => {
    const capture: Captured = { options: null, body: "" };
    const bridge = await startTestBridge({ requestImpl: fakeUpstream(capture), allowedHosts: ["maximo.allowed.example"] });
    const res = await rawRequest(bridge, "/mx/maximo/api/os/mxapiwo", { headers: HEADERS });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: "host_not_allowed" });
    expect(capture.options).toBeNull();
  });

  it("タブが要求を取り消したら Maximo への要求も切る", async () => {
    let upstreamDestroyed = false;
    let sent = false;
    // 応答を返さない上流（重い検索の途中を想定）
    const hanging: UpstreamRequest = () => {
      sent = true;
      const req = new PassThrough();
      const destroy = req.destroy.bind(req);
      req.destroy = ((err?: Error) => {
        upstreamDestroyed = true;
        return destroy(err);
      }) as typeof req.destroy;
      return req as unknown as ClientRequest;
    };
    const bridge = await startTestBridge({ requestImpl: hanging });
    const client = httpRequest({
      host: "127.0.0.1",
      port: bridge.port,
      path: "/mx/maximo/api/os/mxapiwo",
      headers: { host: `127.0.0.1:${bridge.port}`, ...HEADERS },
    });
    client.on("error", () => undefined);
    client.end();
    await waitFor(() => sent);
    client.destroy();
    await waitFor(() => upstreamDestroyed);
  });

  it("/import/ の例外（curl 向け）を ../ で /mx に持ち込めない", async () => {
    const capture: Captured = { options: null, body: "" };
    const bridge = await startTestBridge({ requestImpl: fakeUpstream(capture) });
    // Origin も Sec-Fetch-Site も無い POST は /mx では通さない
    const res = await rawRequest(bridge, "/import/../mx/maximo/api/os/mxapiwo", { method: "POST", headers: { ...HEADERS, "content-length": "2" }, body: "{}" });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: "forbidden_origin" });
    expect(capture.options).toBeNull();
  });

  it("Maximo に届かないときの 502 にキーを載せない", async () => {
    const failing: UpstreamRequest = () => {
      const req = new PassThrough();
      setTimeout(() => req.emit("error", new Error("connect ECONNREFUSED apikey=SECRET-KEY")), 0);
      return req as unknown as ClientRequest;
    };
    const bridge = await startTestBridge({ requestImpl: failing });
    const res = await rawRequest(bridge, "/mx/maximo/api/os/mxapiwo", { headers: HEADERS });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toMatchObject({ error: "upstream_unreachable" });
    expect(res.body).not.toContain("SECRET-KEY");
    expect(JSON.stringify(res.headers)).not.toContain("SECRET-KEY");
  });
});

describe("上流の時間の上限", () => {
  it("既定の上限は 60 秒", () => {
    expect(MX_UPSTREAM_TIMEOUT_MS).toBe(60_000);
  });

  it("応答の頭が上限までに届かなければ 504 にして、上流の要求を切る", async () => {
    let upstreamDestroyed = false;
    const hanging: UpstreamRequest = () => {
      const req = new PassThrough();
      const destroy = req.destroy.bind(req);
      req.destroy = ((err?: Error) => {
        upstreamDestroyed = true;
        return destroy(err);
      }) as typeof req.destroy;
      return req as unknown as ClientRequest;
    };
    const bridge = await startTestBridge({ requestImpl: hanging, upstreamTimeoutMs: 100 });
    const res = await rawRequest(bridge, "/mx/maximo/api/os/mxapiwo", { headers: HEADERS });
    expect(res.status).toBe(504);
    expect(JSON.parse(res.body)).toMatchObject({ error: "upstream_timeout" });
    expect(res.body).not.toContain("SECRET-KEY");
    expect(upstreamDestroyed).toBe(true);
  });

  it("本文が途切れたまま上限を過ぎたら接続を切る", async () => {
    let upstreamDestroyed = false;
    const stalled: UpstreamRequest = (_options, onResponse) => {
      const req = new PassThrough();
      const destroy = req.destroy.bind(req);
      req.destroy = ((err?: Error) => {
        upstreamDestroyed = true;
        return destroy(err);
      }) as typeof req.destroy;
      const res = new PassThrough() as unknown as IncomingMessage & PassThrough;
      (res as unknown as { statusCode: number }).statusCode = 200;
      (res as unknown as { headers: Record<string, string> }).headers = { "content-type": "application/json" };
      setTimeout(() => {
        onResponse(res as unknown as IncomingMessage);
        // 頭と本文の一部だけ送って止まる
        res.write('{"member":[');
      }, 0);
      return req as unknown as ClientRequest;
    };
    const bridge = await startTestBridge({ requestImpl: stalled, upstreamTimeoutMs: 150 });
    const outcome = await new Promise<string>((done) => {
      const client = httpRequest({ host: "127.0.0.1", port: bridge.port, path: "/mx/maximo/api/os/mxapiwo", headers: { host: `127.0.0.1:${bridge.port}`, ...HEADERS } }, (res) => {
        res.on("data", () => undefined);
        res.on("end", () => done("end"));
        res.on("error", () => done("error"));
        res.on("aborted", () => done("aborted"));
        res.on("close", () => done("close"));
      });
      client.on("error", () => done("error"));
      client.end();
    });
    // 正常に終わった（end）のではなく、途中で切られている
    expect(outcome).not.toBe("end");
    await waitFor(() => upstreamDestroyed);
  });

  it("応答が届けば上限で切らない", async () => {
    const capture: Captured = { options: null, body: "" };
    const bridge = await startTestBridge({ requestImpl: fakeUpstream(capture), upstreamTimeoutMs: 100 });
    const res = await rawRequest(bridge, "/mx/maximo/api/os/mxapiwo", { headers: HEADERS });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ member: [] });
  });
});
