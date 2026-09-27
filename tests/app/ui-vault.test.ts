// API キーの隔離（keyvault）の試験。
// VaultCore: 番兵の置き換え、送信先の拒否、自動ロック。
// KeyVault: Worker との往復を偽の transport で行い、メインスレッド側に本物のキーが出ないことを確かめる。

import { afterEach, describe, expect, it, vi } from "vitest";
import { MaximoClient, MaximoError, MaximoNetworkError } from "../../src/app/maximo/client";
import { KeyVault, VaultRequestError, whoamiUserName, type VaultTransport } from "../../src/app/keyvault/client";
import { VaultCore, VaultError, createVaultEndpoint, parseVaultBaseUrl } from "../../src/app/keyvault/core";
import { VAULT_IDLE_MS, VAULT_SENTINEL, type MainToVault, type VaultFetchRequest, type VaultToMain } from "../../src/app/keyvault/protocol";
import { connectErrorMessage, proxyErrorCode } from "../../src/app/settings/logic";

const ORIGIN = "https://mxstudio.test";
const BASE = "https://maximo.test";
const KEY = "real-api-key-12345";

const proxyRequest = (patch: Partial<VaultFetchRequest> = {}): VaultFetchRequest => ({
  url: "/mx/maximo/api/os/mxapiwo?lean=1",
  method: "GET",
  headers: { accept: "application/json", "X-Maximo-Base": BASE, "X-Maximo-Apikey": VAULT_SENTINEL },
  body: null,
  ...patch,
});

const directRequest = (patch: Partial<VaultFetchRequest> = {}): VaultFetchRequest => ({
  url: `${BASE}/maximo/api/os/mxapiwo?lean=1`,
  method: "GET",
  headers: { accept: "application/json", apikey: VAULT_SENTINEL },
  body: null,
  ...patch,
});

function unlockedCore(via: "proxy" | "direct" = "proxy", opts: { onLock?: (r: "idle" | "manual") => void; now?: () => number } = {}): VaultCore {
  const core = new VaultCore({ origin: ORIGIN, ...opts });
  core.unlock({ apiKey: KEY, via, baseUrl: BASE });
  return core;
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof VaultError ? e.code : `not-vault:${String(e)}`;
  }
  return "no-error";
}

describe("VaultCore の番兵の置き換え", () => {
  it("proxy ではキーのヘッダだけを本物に置き換え、同一オリジンの /mx/ へ送る", () => {
    const { url, init } = unlockedCore("proxy").prepare(proxyRequest());
    expect(url).toBe(`${ORIGIN}/mx/maximo/api/os/mxapiwo?lean=1`);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Maximo-Apikey"]).toBe(KEY);
    expect(headers.accept).toBe("application/json");
    expect(headers["X-Maximo-Base"]).toBe(BASE);
    expect(init.credentials).toBe("same-origin");
    expect(init.redirect).toBe("manual");
  });

  it("direct では apikey ヘッダを置き換え、Cookie を送らない", () => {
    const { url, init } = unlockedCore("direct").prepare(directRequest());
    expect(url).toBe(`${BASE}/maximo/api/os/mxapiwo?lean=1`);
    expect((init.headers as Record<string, string>).apikey).toBe(KEY);
    expect(init.credentials).toBe("omit");
  });

  it("送信先とヘッダの誤りを拒む", () => {
    const proxy = unlockedCore("proxy");
    expect(errorCode(() => new VaultCore({ origin: ORIGIN }).prepare(proxyRequest()))).toBe("locked");
    expect(errorCode(() => proxy.prepare(proxyRequest({ url: "https://evil.test/mx/maximo/api/x" })))).toBe("forbidden_destination");
    expect(errorCode(() => proxy.prepare(proxyRequest({ url: "/api/tokens" })))).toBe("forbidden_destination");
    // /mx が転送する先も、接続した Maximo に限る
    expect(errorCode(() => proxy.prepare(proxyRequest({ headers: { "X-Maximo-Base": "https://other.test", "X-Maximo-Apikey": VAULT_SENTINEL } })))).toBe("forbidden_destination");
    // 番兵でないキーのヘッダ、キーのヘッダ無し、別のヘッダに番兵
    expect(errorCode(() => proxy.prepare(proxyRequest({ headers: { "X-Maximo-Base": BASE, "X-Maximo-Apikey": "手で入れたキー" } })))).toBe("bad_request");
    expect(errorCode(() => proxy.prepare(proxyRequest({ headers: { "X-Maximo-Base": BASE } })))).toBe("bad_request");
    expect(errorCode(() => proxy.prepare(proxyRequest({ headers: { "X-Maximo-Base": BASE, "X-Maximo-Apikey": VAULT_SENTINEL, "x-other": VAULT_SENTINEL } })))).toBe("bad_request");
    expect(errorCode(() => proxy.prepare(proxyRequest({ method: "DELETE" })))).toBe("bad_request");
    // 大文字小文字違いの同名ヘッダ（検査するのは先頭だけなので、重ね付けを許さない）
    expect(
      errorCode(() =>
        proxy.prepare(proxyRequest({ headers: { "X-Maximo-Base": BASE, "x-maximo-base": "https://evil.test", "X-Maximo-Apikey": VAULT_SENTINEL } })),
      ),
    ).toBe("bad_request");
    const direct = unlockedCore("direct");
    expect(errorCode(() => direct.prepare(directRequest({ url: "https://evil.test/maximo/api/x" })))).toBe("forbidden_destination");
    // direct のときに proxy 用のキーのヘッダは付けさせない
    expect(errorCode(() => direct.prepare(directRequest({ headers: { apikey: VAULT_SENTINEL, "X-Maximo-Apikey": VAULT_SENTINEL } })))).toBe("bad_request");
  });

  it("キーと URL の検査", () => {
    const core = new VaultCore({ origin: ORIGIN });
    expect(errorCode(() => core.unlock({ apiKey: "", via: "proxy", baseUrl: BASE }))).toBe("bad_request");
    expect(errorCode(() => core.unlock({ apiKey: "key with space", via: "proxy", baseUrl: BASE }))).toBe("bad_request");
    expect(errorCode(() => core.unlock({ apiKey: VAULT_SENTINEL, via: "proxy", baseUrl: BASE }))).toBe("bad_request");
    expect(errorCode(() => core.unlock({ apiKey: KEY, via: "other", baseUrl: BASE }))).toBe("bad_request");
    expect(errorCode(() => core.unlock({ apiKey: KEY, via: "proxy", baseUrl: `${BASE}/maximo` }))).toBe("bad_request");
    expect(errorCode(() => core.unlock({ apiKey: KEY, via: "proxy", baseUrl: "http://maximo.test" }))).toBe("bad_request");
    expect(parseVaultBaseUrl("https://maximo.test/maximo/", "direct")).toEqual({ baseUrl: "https://maximo.test/maximo", baseOrigin: BASE });
    expect(core.isUnlocked()).toBe(false);
  });
});

describe("VaultCore の自動ロック", () => {
  afterEach(() => vi.useRealTimers());

  it("無操作 30 分でキーを消す", () => {
    vi.useFakeTimers();
    const onLock = vi.fn();
    const core = unlockedCore("proxy", { onLock });
    vi.advanceTimersByTime(VAULT_IDLE_MS - 60_000);
    expect(core.isUnlocked()).toBe(true);
    core.touch();
    vi.advanceTimersByTime(VAULT_IDLE_MS - 1);
    expect(onLock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLock).toHaveBeenCalledWith("idle");
    expect(core.isUnlocked()).toBe(false);
    expect(errorCode(() => core.prepare(proxyRequest()))).toBe("locked");
  });

  it("タイマーが動かなくても、送る直前に時間切れを確かめる", () => {
    let t = 1_000;
    const onLock = vi.fn();
    const core = new VaultCore({ origin: ORIGIN, onLock, now: () => t, setTimeout: () => 0, clearTimeout: () => undefined });
    core.unlock({ apiKey: KEY, via: "proxy", baseUrl: BASE });
    t += VAULT_IDLE_MS;
    expect(errorCode(() => core.prepare(proxyRequest()))).toBe("locked");
    expect(onLock).toHaveBeenCalledWith("idle");
  });

  it("手動のロックは 1 回だけ通知する", () => {
    const onLock = vi.fn();
    const core = unlockedCore("proxy", { onLock });
    core.lock();
    core.lock();
    expect(onLock).toHaveBeenCalledTimes(1);
    expect(onLock).toHaveBeenCalledWith("manual");
  });
});

describe("VaultCore の送信", () => {
  it("応答は必要最小限のヘッダだけを返す", async () => {
    const core = unlockedCore("proxy");
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json", "set-cookie": "a=b", "retry-after": "3" } }));
    const res = await core.execute(proxyRequest(), fetchImpl);
    expect(res.status).toBe(200);
    expect(res.bodyText).toBe('{"ok":true}');
    expect(Object.keys(res.headers).sort()).toEqual(["content-type", "retry-after"]);
  });

  it("通信できないときはキーを含まないエラーにする", async () => {
    const core = unlockedCore("proxy");
    const fetchImpl = async () => {
      throw new TypeError(`failed to fetch ${KEY}`);
    };
    await expect(core.execute(proxyRequest(), fetchImpl)).rejects.toMatchObject({ code: "network" });
    await core.execute(proxyRequest(), fetchImpl).catch((e: unknown) => {
      expect(String((e as Error).message)).not.toContain(KEY);
    });
  });
});

// ---------------------------------------------------------------------------
// KeyVault（メインスレッド側）
// ---------------------------------------------------------------------------

interface Harness {
  transport: VaultTransport;
  posted: MainToVault[];
  core: VaultCore;
}

/** Worker の代わりに、同じプロセスで VaultCore を動かす transport */
function harness(fetchImpl: (url: string, init: RequestInit) => Promise<Response>): Harness {
  const posted: MainToVault[] = [];
  let listener: ((msg: VaultToMain) => void) | null = null;
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const post = (msg: VaultToMain) => queueMicrotask(() => listener?.(clone(msg)));
  const core = new VaultCore({ origin: ORIGIN, onLock: (reason) => post({ type: "locked", reason }) });
  const handle = createVaultEndpoint({ core, post, fetchImpl });
  const transport: VaultTransport = {
    post: (msg) => {
      posted.push(clone(msg));
      queueMicrotask(() => handle(clone(msg)));
    },
    listen: (l) => {
      listener = l;
    },
    terminate: () => undefined,
  };
  return { transport, posted, core };
}

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("KeyVault", () => {
  it("接続すると whoami を呼び、本物のキーはメインスレッドのメッセージに出ない", async () => {
    const urls: string[] = [];
    const inits: RequestInit[] = [];
    const { transport, posted } = harness(async (url, init) => {
      urls.push(url);
      inits.push(init);
      return jsonResponse({ userName: "MAXADMIN" });
    });
    const vault = new KeyVault({ transport });
    const info = await vault.connect({ baseUrl: BASE, via: "proxy", connectionName: "MAXADMIN@dev", apiKey: KEY });

    expect(urls).toEqual([`${ORIGIN}/mx/maximo/api/whoami`]);
    expect((inits[0]?.headers as Record<string, string>)["X-Maximo-Apikey"]).toBe(KEY);
    expect(info).toMatchObject({ baseUrl: BASE, via: "proxy", connectionName: "MAXADMIN@dev", userName: "MAXADMIN" });
    expect(vault.current()?.info.userName).toBe("MAXADMIN");
    expect(vault.getView().kind).toBe("connected");

    // Worker へ渡すのは unlock の 1 回だけ。ほかのメッセージには番兵しか載らない
    const withKey = posted.filter((m) => JSON.stringify(m).includes(KEY));
    expect(withKey.map((m) => m.type)).toEqual(["unlock"]);
    expect(JSON.stringify(posted.filter((m) => m.type === "fetch"))).toContain(VAULT_SENTINEL);
  });

  it("whoami が 401 なら接続せず、Worker のキーも消す", async () => {
    const { transport, core } = harness(async () => jsonResponse({ Error: { reasonCode: "BMXAA0021E", message: "invalid", statusCode: "401" } }, 401));
    const vault = new KeyVault({ transport });
    await expect(vault.connect({ baseUrl: BASE, via: "proxy", connectionName: "n", apiKey: KEY })).rejects.toBeInstanceOf(MaximoError);
    await new Promise((r) => setTimeout(r, 0));
    expect(vault.current()).toBeNull();
    expect(vault.getView().kind).toBe("disconnected");
    expect(core.isUnlocked()).toBe(false);
  });

  it("URL が不正ならキーを Worker へ渡さない", async () => {
    const { transport, posted } = harness(async () => jsonResponse({}));
    const vault = new KeyVault({ transport });
    await expect(vault.connect({ baseUrl: `${BASE}/maximo`, via: "proxy", connectionName: "n", apiKey: KEY })).rejects.toBeInstanceOf(Error);
    expect(posted).toEqual([]);
  });

  it("自動ロックすると current() が null になり、その後の要求は「送っていない」と分かる形で返る", async () => {
    const { transport, core } = harness(async () => jsonResponse({ userName: "MAXADMIN" }));
    const vault = new KeyVault({ transport });
    let changes = 0;
    vault.subscribe(() => changes++);
    await vault.connect({ baseUrl: BASE, via: "proxy", connectionName: "MAXADMIN@dev", apiKey: KEY });
    const client = vault.current()?.client;
    expect(client).toBeDefined();

    core.lock("idle");
    await new Promise((r) => setTimeout(r, 0));
    expect(vault.current()).toBeNull();
    const view = vault.getView();
    expect(view.kind).toBe("locked");
    if (view.kind === "locked") expect(view.reason).toBe("idle");
    expect(changes).toBeGreaterThan(0);

    const err = await client?.get(`${client.apiRoot}/whoami`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaximoError);
    expect((err as MaximoError).status).toBe(423);
    expect(proxyErrorCode((err as MaximoError).message)).toBe("vault_locked");
  });

  it("タイムアウトで中止すると Worker 側の fetch も中止する", async () => {
    const signals: AbortSignal[] = [];
    let call = 0;
    const { transport } = harness(async (_url, init) => {
      call++;
      if (call === 1) return jsonResponse({ userName: "MAXADMIN" });
      if (init.signal) signals.push(init.signal);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const vault = new KeyVault({ transport, createClient: (o) => new MaximoClient({ ...o, timeoutMs: 20, maxRetries: 0 }) });
    await vault.connect({ baseUrl: BASE, via: "proxy", connectionName: "n", apiKey: KEY });
    const client = vault.current()?.client;
    const err = await client?.get("/maximo/api/os/mxapiwo").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaximoNetworkError);
    expect((err as MaximoNetworkError).timedOut).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(signals.at(-1)?.aborted).toBe(true);
  });

  it("Worker を起動できないときは待たせず、理由の分かる失敗にする", async () => {
    // new Worker が失敗した（ブラウザが module worker を作れない・読み込めない）ときの transport
    const sink: { fail: ((message: string) => void) | null } = { fail: null };
    const transport: VaultTransport = {
      post: () => sink.fail?.("API キーの保管用 Worker を起動できませんでした。ページを再読み込みしてください。"),
      listen: () => undefined,
      terminate: () => undefined,
      onFailure: (listener) => {
        sink.fail = listener;
      },
    };
    const vault = new KeyVault({ transport });
    const err: unknown = await vault.connect({ baseUrl: BASE, via: "proxy", connectionName: "n", apiKey: KEY }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultRequestError);
    // 設定画面には、次に何をすればよいか分かる文言を出す
    expect(connectErrorMessage(err, "proxy")).toContain("Worker");
    expect(vault.current()).toBeNull();
    expect(vault.getView().kind).toBe("disconnected");
  });

  it("whoami の利用者名を取り出す", () => {
    expect(whoamiUserName({ userName: "MAXADMIN" })).toBe("MAXADMIN");
    expect(whoamiUserName({ loginID: " wilson " })).toBe("wilson");
    expect(whoamiUserName({ personid: "MX" })).toBe("MX");
    expect(whoamiUserName({})).toBeNull();
    expect(whoamiUserName(null)).toBeNull();
  });
});
