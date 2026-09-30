// 入口の検査（接続元・Host・Origin）。ここが緩むと、他のサイトや他の端末から中継を使われる。

import { describe, expect, it } from "vitest";
import { checkRequest, checkUpgrade, isLocalHost, isLocalOrigin, isLoopbackAddress, splitHostHeader } from "../../src/bridge/guard.ts";

const PORT = 8788;
const LOCAL = "127.0.0.1";

function req(overrides: Partial<Parameters<typeof checkRequest>[0]> = {}) {
  return {
    method: "GET",
    host: `127.0.0.1:${PORT}`,
    origin: undefined,
    secFetchSite: undefined,
    remoteAddress: LOCAL,
    ...overrides,
  };
}

describe("Host ヘッダ", () => {
  it("ホストとポートに分ける", () => {
    expect(splitHostHeader("127.0.0.1:8788")).toEqual({ hostname: "127.0.0.1", port: "8788" });
    expect(splitHostHeader("localhost")).toEqual({ hostname: "localhost", port: "" });
    expect(splitHostHeader("[::1]:8788")).toEqual({ hostname: "[::1]", port: "8788" });
    expect(splitHostHeader("")).toBeNull();
    expect(splitHostHeader("a:1:2")).toBeNull();
  });

  it("ループバックのホスト名と待ち受けポートだけを通す", () => {
    expect(isLocalHost("127.0.0.1:8788", PORT)).toBe(true);
    expect(isLocalHost("localhost:8788", PORT)).toBe(true);
    expect(isLocalHost("[::1]:8788", PORT)).toBe(true);
    // DNS リバインディング（外部の名前を 127.0.0.1 に向ける）を止める
    expect(isLocalHost("evil.example:8788", PORT)).toBe(false);
    expect(isLocalHost("mxstage.localhost.evil.example:8788", PORT)).toBe(false);
    // ポートが違えば別のサーバ宛て
    expect(isLocalHost("127.0.0.1:9999", PORT)).toBe(false);
    expect(isLocalHost(undefined, PORT)).toBe(false);
  });
});

describe("Origin", () => {
  it("自分の配信元だけを通す", () => {
    expect(isLocalOrigin("http://127.0.0.1:8788", PORT)).toBe(true);
    expect(isLocalOrigin("http://localhost:8788", PORT)).toBe(true);
    expect(isLocalOrigin("https://127.0.0.1:8788", PORT)).toBe(false);
    expect(isLocalOrigin("http://127.0.0.1:8789", PORT)).toBe(false);
    expect(isLocalOrigin("null", PORT)).toBe(false);
    expect(isLocalOrigin(undefined, PORT)).toBe(false);
  });
});

describe("接続元", () => {
  it("ループバックだけを通す", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("HTTP の入口", () => {
  it("同一オリジンの GET は Origin が無くても通る", () => {
    expect(checkRequest(req(), PORT).ok).toBe(true);
  });

  it("別のサイトからの POST は通さない", () => {
    const res = checkRequest(req({ method: "POST", origin: "https://evil.example" }), PORT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("forbidden_origin");
  });

  it("Origin が無い POST は Sec-Fetch-Site が無ければ通さない", () => {
    expect(checkRequest(req({ method: "POST" }), PORT).ok).toBe(false);
    expect(checkRequest(req({ method: "POST", secFetchSite: "same-origin" }), PORT).ok).toBe(true);
    expect(checkRequest(req({ method: "POST", secFetchSite: "cross-site" }), PORT).ok).toBe(false);
  });

  it("1 回限りの URL の入口は、curl のようにブラウザ以外からの POST を通す", () => {
    const ticket = { allowNonBrowserWrite: true };
    // curl は Origin も Sec-Fetch-Site も付けない
    expect(checkRequest(req({ method: "POST" }), PORT, ticket).ok).toBe(true);
    // ブラウザから来た要求は、これまでどおり同一オリジンだけ
    expect(checkRequest(req({ method: "POST", origin: "https://evil.example" }), PORT, ticket).ok).toBe(false);
    expect(checkRequest(req({ method: "POST", secFetchSite: "cross-site" }), PORT, ticket).ok).toBe(false);
    expect(checkRequest(req({ method: "POST", secFetchSite: "same-site" }), PORT, ticket).ok).toBe(false);
    // 接続元と Host の検査は緩めない（DNS リバインディング対策）
    expect(checkRequest(req({ method: "POST", host: "evil.example" }), PORT, ticket).ok).toBe(false);
    expect(checkRequest(req({ method: "POST", remoteAddress: "192.168.1.10" }), PORT, ticket).ok).toBe(false);
  });

  it("他の端末からの接続は通さない", () => {
    const res = checkRequest(req({ remoteAddress: "192.168.1.10" }), PORT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("forbidden_remote");
  });

  it("Host が違えば通さない", () => {
    const res = checkRequest(req({ host: "evil.example" }), PORT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("forbidden_host");
  });
});

describe("WebSocket の入口", () => {
  it("Origin の一致を必ず求める", () => {
    expect(checkUpgrade(req({ origin: `http://127.0.0.1:${PORT}` }), PORT).ok).toBe(true);
    expect(checkUpgrade(req({ origin: undefined }), PORT).ok).toBe(false);
    expect(checkUpgrade(req({ origin: "http://evil.example" }), PORT).ok).toBe(false);
  });
});
