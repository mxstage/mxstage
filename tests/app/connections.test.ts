// 保存した接続先（src/app/connections）: 選び方・自動の接続・やり直し、MaximoClient が API キーの代わりに ID を送ること。
import { describe, expect, it, vi } from "vitest";
import { AutoConnector, isRetryable } from "../../src/app/connections/auto";
import { SELECTED_CONNECTION_KEY, SavedConnectionsClient, type SavedConnection } from "../../src/app/connections/client";
import { MaximoClient, MaximoError, MaximoNetworkError } from "../../src/app/maximo/client";
import type { MaximoConnectionInfo } from "../../src/app/runtime/contracts";

function conn(id: string, name = id, extra: Partial<SavedConnection> = {}): SavedConnection {
  return { id, name, baseUrl: `https://${name}.example.com`, environment: "test", createdAt: 1, updatedAt: 1, lastUsedAt: null, ...extra };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

/** 橋渡しの /_mxstage/connections の偽物 */
function bridgeFetch(state: { connections: SavedConnection[]; lastUsedId: string | null; down?: boolean }) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    if (state.down) throw new TypeError("Failed to fetch");
    if (url.startsWith("/_mxstage/connections/use")) state.lastUsedId = String(body?.id);
    return new Response(JSON.stringify({ ok: true, connections: state.connections, lastUsedId: state.lastUsedId, protection: "dpapi" }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function fakeVault(result: (saved: { id: string }) => Promise<void>) {
  let kind: "disconnected" | "connected" | "locked" = "disconnected";
  const connected: string[] = [];
  return {
    connected,
    getView: () => ({ kind }),
    disconnect: vi.fn(() => {
      kind = "disconnected";
    }),
    connectSaved: async (saved: { id: string; name: string; baseUrl: string }): Promise<MaximoConnectionInfo> => {
      await result(saved);
      kind = "connected";
      connected.push(saved.id);
      return { baseUrl: saved.baseUrl, via: "proxy", connectionName: saved.name, userName: null, connectedAt: 0, savedId: saved.id };
    },
  };
}

describe("どの接続先へつなぐか", () => {
  it("この窓で選んだもの → 橋渡しが覚えている最後のもの → 1 つだけならそれ", async () => {
    const state = { connections: [conn("c_a"), conn("c_b")], lastUsedId: "c_b" as string | null };
    const { fetchImpl } = bridgeFetch(state);
    const mine = new SavedConnectionsClient({ fetch: fetchImpl, storage: memoryStorage({ [SELECTED_CONNECTION_KEY]: "c_a" }) });
    await mine.refresh();
    expect(mine.preferred()?.id).toBe("c_a");

    const fresh = new SavedConnectionsClient({ fetch: fetchImpl, storage: memoryStorage() });
    await fresh.refresh();
    expect(fresh.preferred()?.id).toBe("c_b");

    state.lastUsedId = null;
    await fresh.refresh();
    expect(fresh.preferred()).toBeNull();
    state.connections = [conn("c_a")];
    await fresh.refresh();
    expect(fresh.preferred()?.id).toBe("c_a");
  });
});

describe("自動の接続", () => {
  it("開いたときに最後に使った接続先へつなぎ、環境を申告し、使ったことを覚える", async () => {
    const state = { connections: [conn("c_a", "a", { environment: "production" })], lastUsedId: "c_a" as string | null };
    const { fetchImpl, calls } = bridgeFetch(state);
    const storage = memoryStorage();
    const saved = new SavedConnectionsClient({ fetch: fetchImpl, storage });
    const vault = fakeVault(async () => undefined);
    const declare = vi.fn();
    const auto = new AutoConnector({ saved, vault, license: { declare } });
    await auto.start();
    expect(vault.connected).toEqual(["c_a"]);
    expect(declare).toHaveBeenCalledWith("https://a.example.com", "production");
    await vi.waitFor(() => expect(calls.some((c) => c.url.startsWith("/_mxstage/connections/use"))).toBe(true));
    expect(storage.data.get(SELECTED_CONNECTION_KEY)).toBe("c_a");
  });

  it("橋渡しが起動中でつながらなければ、間を置いてやり直す", async () => {
    const state = { connections: [conn("c_a")], lastUsedId: "c_a" as string | null, down: true };
    const { fetchImpl } = bridgeFetch(state);
    const saved = new SavedConnectionsClient({ fetch: fetchImpl });
    const vault = fakeVault(async () => undefined);
    const timers: (() => void)[] = [];
    const auto = new AutoConnector({ saved, vault, setTimeout: (fn) => timers.push(fn), clearTimeout: () => undefined });
    await auto.start();
    expect(vault.connected).toEqual([]);
    expect(timers).toHaveLength(1);
    state.down = false;
    timers.shift()?.();
    await vi.waitFor(() => expect(vault.connected).toEqual(["c_a"]));
  });

  it("Maximo に届かないときはやり直し、API キーが通らないときは直すまで繰り返さない", async () => {
    const state = { connections: [conn("c_a")], lastUsedId: "c_a" as string | null };
    const { fetchImpl } = bridgeFetch(state);
    const saved = new SavedConnectionsClient({ fetch: fetchImpl });
    let error: Error | null = new MaximoNetworkError("down", false);
    const vault = fakeVault(async () => {
      if (error) throw error;
    });
    const timers: (() => void)[] = [];
    const auto = new AutoConnector({ saved, vault, setTimeout: (fn) => timers.push(fn), clearTimeout: () => undefined });
    await auto.start();
    expect(auto.failure()).toMatchObject({ retrying: true, connection: { id: "c_a" } });
    expect(timers).toHaveLength(1);

    error = new MaximoError(401, null, "unauthorized");
    timers.shift()?.();
    await vi.waitFor(() => expect(auto.failure()).toMatchObject({ retrying: false }));
    expect(timers).toHaveLength(0);
    // 窓に戻ってきても、同じキーのままなら試さない
    error = null;
    await auto.attempt();
    expect(vault.connected).toEqual([]);
    // 直した（更新した）ら試す
    state.connections = [conn("c_a", "c_a", { updatedAt: 2 })];
    await auto.attempt();
    expect(vault.connected).toEqual(["c_a"]);
    expect(auto.failure()).toBeNull();
  });

  it("利用者が切った窓では、自分でつなぐまで自動でつながない", async () => {
    const state = { connections: [conn("c_a")], lastUsedId: "c_a" as string | null };
    const { fetchImpl } = bridgeFetch(state);
    const saved = new SavedConnectionsClient({ fetch: fetchImpl });
    const vault = fakeVault(async () => undefined);
    const auto = new AutoConnector({ saved, vault });
    await auto.start();
    auto.disconnect();
    expect(vault.disconnect).toHaveBeenCalled();
    await auto.attempt();
    expect(vault.connected).toEqual(["c_a"]);
    await auto.connect(conn("c_a"));
    expect(vault.connected).toEqual(["c_a", "c_a"]);
  });

  it("やり直してよい失敗かどうか", () => {
    expect(isRetryable(new MaximoNetworkError("x", true))).toBe(true);
    expect(isRetryable(new MaximoError(503, null, "x"))).toBe(true);
    expect(isRetryable(new MaximoError(401, null, "x"))).toBe(false);
    expect(isRetryable(new MaximoError(500, null, "The saved connection cannot be used.（/mx: connection_unreadable）"))).toBe(false);
  });
});

describe("MaximoClient と保存した接続先", () => {
  it("API キーを送らず、接続先の ID を送る", async () => {
    const seen: Record<string, string>[] = [];
    const client = new MaximoClient({
      baseUrl: "https://maximo.example.com",
      via: "proxy",
      apiKey: () => "",
      connectionId: "c_0123456789abcdef",
      fetchImpl: async (_url, init) => {
        seen.push(init.headers as Record<string, string>);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.get(`${client.apiRoot}/whoami`);
    expect(seen[0]).toMatchObject({ "X-Maximo-Connection": "c_0123456789abcdef" });
    expect(seen[0]).not.toHaveProperty("X-Maximo-Apikey");
    expect(seen[0]).not.toHaveProperty("X-Maximo-Base");
  });

  it("直結（direct）では保存した接続先を使えない", () => {
    expect(() => new MaximoClient({ baseUrl: "https://maximo.example.com", via: "direct", apiKey: () => "", connectionId: "c_0123456789abcdef" })).toThrow();
  });
});
