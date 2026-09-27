// 橋渡しを PC に 1 つにする仕組み（鍵ファイル・内部経路・役割決め・引き継ぎ）。
// 鍵ファイルは必ず一時フォルダに置く（利用者の本物の %LOCALAPPDATA% に作らない）。
// ポートは port:0 か 19000 番台（利用者が橋渡しを動かしているかもしれない 8788 は使わない）。

import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RELAY_PROTOCOL_VERSION, RelayErrorCode } from "../../src/shared/protocol.ts";
import type { HubInvokeRequest, InvokeMsg, InvokeProgress } from "../../src/shared/protocol.ts";
import { BRIDGE_KEY_FILE_ENV, BRIDGE_KEY_HEADER, BridgeKeyStore, defaultBridgeKeyPath, keysEqual } from "../../src/bridge/bridgeKey.ts";
import { BridgeCoordinator } from "../../src/bridge/coordinator.ts";
import type { BridgeCoordinatorOptions } from "../../src/bridge/coordinator.ts";
import { LocalHub } from "../../src/bridge/hub.ts";
import { runTabToolWithProgress, runWorkerTool } from "../../src/bridge/mcp.ts";
import type { ToolCallContext } from "../../src/bridge/mcp.ts";
import {
  BRIDGE_NAME,
  BRIDGE_PEER_PROTOCOL,
  PEER_HEALTH_PATH,
  PEER_IMPORT_TICKET_PATH,
  PEER_INVOKE_PATH,
  PEER_MAX_INVOKE_BYTES,
  PEER_STATUS_PATH,
  probeBridgeHealth,
} from "../../src/bridge/peer.ts";
import {
  APP_DIR,
  CliProcess,
  FakeTab,
  SCALE,
  addressOf,
  createSandbox,
  findFreePort,
  rawRequest,
  startTestBridge,
  stopAll,
  stopAllCli,
  waitFor,
} from "./support.ts";
import type { BridgeAddress, Sandbox } from "./support.ts";

let box: Sandbox;
const coordinators: BridgeCoordinator[] = [];
const otherServers: Server[] = [];

beforeEach(async () => {
  box = await createSandbox();
});

afterEach(async () => {
  await stopAllCli();
  await stopAll();
  for (const c of coordinators.splice(0)) await c.close();
  for (const s of otherServers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
  await box.cleanup();
});

const LOAD_ARGS = { name: "WO", os: "MXAPIWO", select: ["WONUM"], where: [], maxRows: 10 };

function readRequest(tool = "get_status", deadlineMs = 5_000): HubInvokeRequest {
  return { tool: tool as HubInvokeRequest["tool"], args: {}, readOnly: true, deadlineMs, idempotencyKey: `k-${Math.random()}` };
}

function coordinator(port: number, overrides: Partial<BridgeCoordinatorOptions> = {}): BridgeCoordinator {
  const c = new BridgeCoordinator({
    port,
    root: APP_DIR,
    keyStore: box.keyStore(),
    version: "9.9.9-test",
    createHub: () => new LocalHub({ timeoutScale: SCALE }),
    watchIntervalMs: 0,
    probeTimeoutMs: 1_000,
    ...overrides,
  });
  coordinators.push(c);
  return c;
}

/** mxstudio 以外のサーバでポートを埋める */
async function occupyWith(port: number, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  const server = createServer(handler);
  await new Promise<void>((done, failed) => {
    server.once("error", failed);
    server.listen(port, "127.0.0.1", () => done());
  });
  otherServers.push(server);
  return server;
}

/** 偽タブが ack → 進捗 → 結果の順に答える */
function answerWithProgress(tab: FakeTab, text: string): void {
  tab.onInvoke = (msg: InvokeMsg) => {
    tab.ack(msg.id);
    tab.send({ type: "tool.progress", id: msg.id, progress: 1, total: 2, message: "読み込み中" });
    setTimeout(() => tab.answer(msg.id, text), 30);
  };
}

function parseNdjson(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------

describe("鍵ファイル", () => {
  it("既定の場所はどの OS でも ~/.config/mxstudio（%LOCALAPPDATA% は見ない）。環境変数で差し替えられる", () => {
    // Claude Desktop（MSIX）が起動した橋渡しは %LOCALAPPDATA% への書き込みを振り替えられるので、そこに置かない
    const local = join("C:", "Users", "u", "AppData", "Local");
    expect(defaultBridgeKeyPath({ env: { LOCALAPPDATA: local }, home: join("C:", "Users", "u") })).toBe(join("C:", "Users", "u", ".config", "mxstudio", "bridge.key"));
    expect(defaultBridgeKeyPath({ env: {}, home: "/home/u" })).toBe(join("/home/u", ".config", "mxstudio", "bridge.key"));
    expect(defaultBridgeKeyPath({ env: { [BRIDGE_KEY_FILE_ENV]: box.keyFile, LOCALAPPDATA: local } })).toBe(resolve(box.keyFile));
  });

  it("無ければ 256 ビットの乱数で作り、あればそれを使う", () => {
    const first = new BridgeKeyStore(box.keyFile);
    expect(first.load()).toBeNull();
    const key = first.ensure();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(box.keyFile)).toBe(true);
    if (process.platform !== "win32") expect(statSync(box.keyFile).mode & 0o777).toBe(0o600);
    // 別の橋渡しも同じ値を使う
    expect(new BridgeKeyStore(box.keyFile).ensure()).toBe(key);
    expect(new BridgeKeyStore(box.keyFile).load()).toBe(key);
  });

  it("読むだけの窓口はファイルを作らない", () => {
    const store = new BridgeKeyStore(box.keyFile);
    expect(store.load()).toBeNull();
    expect(store.current()).toBeNull();
    expect(existsSync(box.keyFile)).toBe(false);
    expect(store.verify("0".repeat(64))).toBe(false);
  });

  it("壊れた鍵ファイルは作り直す", async () => {
    await mkdir(join(box.keyFile, ".."), { recursive: true });
    await writeFile(box.keyFile, "not-a-key", "utf8");
    const key = new BridgeKeyStore(box.keyFile).ensure();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("照合は値が一致するときだけ通す", () => {
    const store = new BridgeKeyStore(box.keyFile);
    const key = store.ensure();
    expect(store.verify(key)).toBe(true);
    expect(store.verify(undefined)).toBe(false);
    expect(store.verify("")).toBe(false);
    expect(store.verify(`${key}0`)).toBe(false);
    expect(store.verify(key.slice(1))).toBe(false);
    expect(store.verify("f".repeat(64) === key ? "e".repeat(64) : "f".repeat(64))).toBe(false);
    expect(keysEqual("abc", "abc")).toBe(true);
    expect(keysEqual("abc", "abd")).toBe(false);
    expect(keysEqual("abc", "abcd")).toBe(false);
  });

  it("鍵ファイルが作り直されたら読み直して照合する", async () => {
    const store = new BridgeKeyStore(box.keyFile);
    store.ensure();
    const fresh = "a".repeat(64);
    await writeFile(box.keyFile, `${fresh}\n`, "utf8");
    expect(store.verify(fresh)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("内部経路（/_mxstudio/*）", () => {
  async function keyedBridge() {
    const keyStore = box.keyStore();
    const bridge = await startTestBridge({ keyStore, version: "1.2.3" });
    const key = keyStore.current() as string;
    return { bridge, key };
  }

  it("primary は待ち受けを始めたときに鍵ファイルを作る", async () => {
    expect(existsSync(box.keyFile)).toBe(false);
    const { bridge, key } = await keyedBridge();
    expect(bridge.keyReady).toBe(true);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("health は鍵なしで名前・版・取り決めの版だけを返す（鍵や PID は出さない）", async () => {
    const { bridge, key } = await keyedBridge();
    const res = await rawRequest(bridge, PEER_HEALTH_PATH);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ name: BRIDGE_NAME, version: "1.2.3", protocol: BRIDGE_PEER_PROTOCOL });
    expect(res.body).not.toContain(key);
    expect(res.body).not.toContain(String(process.pid));
    expect(await probeBridgeHealth(bridge.port)).toEqual({ kind: "bridge", health: { name: BRIDGE_NAME, version: "1.2.3", protocol: BRIDGE_PEER_PROTOCOL } });
  });

  it("鍵なし・違う鍵の invoke は 403 で、タブには届かない", async () => {
    const { bridge, key } = await keyedBridge();
    const tab = await FakeTab.connect(bridge);
    const body = JSON.stringify(readRequest());
    const headers = { "content-type": "application/json" };

    const none = await rawRequest(bridge, PEER_INVOKE_PATH, { method: "POST", headers, body });
    expect(none.status).toBe(403);
    expect(JSON.parse(none.body)).toMatchObject({ error: "forbidden_key" });

    const wrong = "0".repeat(64) === key ? "1".repeat(64) : "0".repeat(64);
    const bad = await rawRequest(bridge, PEER_INVOKE_PATH, { method: "POST", headers: { ...headers, [BRIDGE_KEY_HEADER]: wrong }, body });
    expect(bad.status).toBe(403);
    expect(bad.body).not.toContain(key);
    expect(bad.body).not.toContain(wrong);

    // 長さの違う鍵・status・チケットも同じ
    expect((await rawRequest(bridge, PEER_INVOKE_PATH, { method: "POST", headers: { ...headers, [BRIDGE_KEY_HEADER]: key.slice(2) }, body })).status).toBe(403);
    expect((await rawRequest(bridge, PEER_STATUS_PATH)).status).toBe(403);
    expect((await rawRequest(bridge, PEER_IMPORT_TICKET_PATH, { method: "POST", headers, body: "{}" })).status).toBe(403);

    expect(tab.frames("tool.invoke")).toHaveLength(0);
  });

  it("鍵が合っていても Host・Origin の検査は通す", async () => {
    const { bridge, key } = await keyedBridge();
    const body = JSON.stringify(readRequest());
    const host = await rawRequest(bridge, PEER_INVOKE_PATH, { method: "POST", headers: { host: "evil.example", [BRIDGE_KEY_HEADER]: key }, body });
    expect(host.status).toBe(403);
    expect(JSON.parse(host.body)).toMatchObject({ error: "forbidden_host" });
    const origin = await rawRequest(bridge, PEER_INVOKE_PATH, { method: "POST", headers: { origin: "http://evil.example", [BRIDGE_KEY_HEADER]: key }, body });
    expect(origin.status).toBe(403);
    expect(JSON.parse(origin.body)).toMatchObject({ error: "forbidden_origin" });
  });

  it("鍵を持たない橋渡し（keyStore なし）は、どの鍵でも 403", async () => {
    const bridge = await startTestBridge();
    const res = await rawRequest(bridge, PEER_INVOKE_PATH, { method: "POST", headers: { [BRIDGE_KEY_HEADER]: "0".repeat(64) }, body: JSON.stringify(readRequest()) });
    expect(res.status).toBe(403);
  });

  it("正しい鍵の invoke は、進捗と結果を改行区切り JSON で返す", async () => {
    const { bridge, key } = await keyedBridge();
    const tab = await FakeTab.connect(bridge);
    answerWithProgress(tab, "できた");
    const res = await rawRequest(bridge, PEER_INVOKE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", [BRIDGE_KEY_HEADER]: key },
      body: JSON.stringify(readRequest("load_sheet")),
    });
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("application/x-ndjson");
    const lines = parseNdjson(res.body);
    expect(lines[0]).toEqual({ type: "progress", progress: 1, total: 2, message: "読み込み中" });
    const last = lines[lines.length - 1] as { type: string; response: { ok: boolean; result: { content: Array<{ text: string }> } } };
    expect(last.type).toBe("result");
    expect(last.response.ok).toBe(true);
    expect(last.response.result.content[0]?.text).toBe("できた");
  });

  it("readOnly は送り手の値を使わず、ツール名から決め直す", async () => {
    const { bridge, key } = await keyedBridge();
    const tab = await FakeTab.connect(bridge);
    tab.onInvoke = (msg) => tab.answer(msg.id);
    const res = await rawRequest(bridge, PEER_INVOKE_PATH, {
      method: "POST",
      headers: { [BRIDGE_KEY_HEADER]: key },
      body: JSON.stringify({ ...readRequest("patch_cells"), readOnly: true }),
    });
    expect(res.status).toBe(200);
    const invoke = tab.frames("tool.invoke")[0] as unknown as InvokeMsg;
    expect(invoke.tool).toBe("patch_cells");
    expect(invoke.readOnly).toBe(false);
  });

  it("形の合わない呼び出し（橋渡しで完結するツール・知らないツール・壊れた JSON）は 400", async () => {
    const { bridge, key } = await keyedBridge();
    const headers = { [BRIDGE_KEY_HEADER]: key };
    for (const body of [JSON.stringify(readRequest("open_grid")), JSON.stringify(readRequest("no_such_tool")), "{", JSON.stringify({ tool: "get_status" })]) {
      const res = await rawRequest(bridge, PEER_INVOKE_PATH, { method: "POST", headers, body });
      expect(res.status).toBe(400);
    }
  });

  it("status とチケットの発行は鍵があれば通る", async () => {
    const { bridge, key } = await keyedBridge();
    const tab = await FakeTab.connect(bridge);
    const status = await rawRequest(bridge, PEER_STATUS_PATH, { headers: { [BRIDGE_KEY_HEADER]: key } });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toMatchObject({ ok: true, status: { primaryTabId: tab.tabId } });
    const ticket = await rawRequest(bridge, PEER_IMPORT_TICKET_PATH, { method: "POST", headers: { [BRIDGE_KEY_HEADER]: key }, body: "{}" });
    expect(ticket.status).toBe(200);
    expect(JSON.parse(ticket.body)).toMatchObject({ ok: true, ticket: { importId: expect.any(String) } });
  });
});

// ---------------------------------------------------------------------------

describe("役割決め（同じプロセスの中）", () => {
  it("同じポートで 2 つ目は client になり、ツール呼び出し・進捗・状態・チケットが primary に届く", async () => {
    const port = await findFreePort();
    const primary = coordinator(port);
    const client = coordinator(port);
    expect((await primary.start()).kind).toBe("primary");
    const started = await client.start();
    expect(started).toMatchObject({ kind: "client", health: { name: BRIDGE_NAME, protocol: BRIDGE_PEER_PROTOCOL } });
    expect(client.server).toBeNull();

    const tab = await FakeTab.connect(addressOf(port));
    answerWithProgress(tab, "primary のタブが答えた");

    // Hub の RPC
    const seen: InvokeProgress[] = [];
    const res = await client.hub.invoke(readRequest("load_sheet"), (p) => seen.push(p));
    expect(res).toMatchObject({ ok: true, result: { content: [{ text: "primary のタブが答えた" }] } });
    expect(seen[0]).toEqual({ progress: 1, total: 2, message: "読み込み中" });

    // MCP の呼び出し（progressToken 付き）
    const deps = { origin: client.origin, hub: client.hub, tickets: client.tickets, version: "test" };
    const sent: unknown[] = [];
    const ctx: ToolCallContext = { mcpReq: { _meta: { progressToken: "tok-1" }, notify: async (n) => void sent.push(n) } };
    const mcp = await runTabToolWithProgress(deps, "load_sheet", LOAD_ARGS, ctx);
    expect(mcp.content[0]).toMatchObject({ text: "primary のタブが答えた" });
    expect(sent[0]).toMatchObject({ method: "notifications/progress", params: { progressToken: "tok-1", progress: 1, total: 2 } });

    // 状態と open_grid
    expect((await client.hub.status()).primaryTabId).toBe(tab.tabId);
    const grid = await runWorkerTool(deps, "open_grid", {});
    expect(grid.structuredContent).toMatchObject({ appUrl: `http://127.0.0.1:${port}/app`, tabConnected: true });

    // アップロード URL は primary で発行され、primary のポートに POST すればタブに届く
    const session = await runWorkerTool(deps, "create_import_session", { fileName: "台帳.xlsx" });
    const uploadUrl = new URL((session.structuredContent as { uploadUrl: string }).uploadUrl);
    expect(uploadUrl.port).toBe(String(port));
    const file = Buffer.from("PK-test");
    const upload = await rawRequest(addressOf(port), uploadUrl.pathname, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": "a.xlsx", "content-length": String(file.byteLength) },
      body: file,
    });
    expect(upload.status).toBe(200);
    await tab.waitFor("import.chunk");
  });

  it("primary を止めると client が引き継ぎ、タブが再接続した後の呼び出しが通る", async () => {
    const port = await findFreePort();
    const primary = coordinator(port);
    const client = coordinator(port);
    await primary.start();
    await client.start();
    const tab = await FakeTab.connect(addressOf(port));
    tab.onInvoke = (msg) => tab.answer(msg.id, "前");
    expect(await client.hub.invoke(readRequest())).toMatchObject({ ok: true });

    await primary.close();
    expect(await client.tryTakeOver()).toBe(true);
    expect(client.role).toBe("primary");
    expect((await probeBridgeHealth(port)).kind).toBe("bridge");

    // 作業タブは同じ URL につなぎ直す
    const again = await FakeTab.connect(addressOf(port));
    again.onInvoke = (msg) => again.answer(msg.id, "引き継ぎ後");
    const res = await client.hub.invoke(readRequest());
    expect(res).toMatchObject({ ok: true, result: { content: [{ text: "引き継ぎ後" }] } });
  });

  it("primary が居なくなっていたら、呼び出しの前に引き継ぎ、タブの再接続を猶予の間だけ待つ", async () => {
    const port = await findFreePort();
    // 猶予を 1.5 秒にする（再接続の猶予 3 秒 × 0.5）
    const slow = { createHub: () => new LocalHub({ timeoutScale: 0.5 }) };
    const primary = coordinator(port, slow);
    const client = coordinator(port, slow);
    await primary.start();
    await client.start();
    await primary.close();

    const pending = client.hub.invoke(readRequest("get_status", 5_000));
    await waitFor(() => client.role === "primary");
    // 待っていた呼び出しは hello の直後に届くので、応答を決めてから hello を送る
    const tab = await FakeTab.connect(addressOf(port), { noHello: true });
    tab.onInvoke = (msg) => tab.answer(msg.id, "待ってから届いた");
    tab.send({ type: "hello", tabId: tab.tabId, protocol: RELAY_PROTOCOL_VERSION, appVersion: "test", tools: [], revision: 0, workspace: null, focused: true });
    expect(await pending).toMatchObject({ ok: true, result: { content: [{ text: "待ってから届いた" }] } });
  });

  it("処理中に primary が終了したら、読み取りは再試行できる切断、書き込みは結果不明として返す", async () => {
    const port = await findFreePort();
    const primary = coordinator(port);
    const client = coordinator(port);
    await primary.start();
    await client.start();
    const tab = await FakeTab.connect(addressOf(port));
    // ack だけして結果を返さない（処理中）
    tab.onInvoke = (msg) => tab.ack(msg.id);

    const write = client.hub.invoke({ tool: "patch_cells", args: {}, readOnly: false, deadlineMs: 5_000, idempotencyKey: "w1" });
    const read = client.hub.invoke(readRequest("query_rows"));
    await waitFor(() => tab.frames("tool.invoke").length === 2);
    await primary.close();

    const [w, r] = await Promise.all([write, read]);
    expect(w).toMatchObject({ ok: false, code: RelayErrorCode.UNKNOWN_OUTCOME, retryable: false });
    expect(r).toMatchObject({ ok: false, code: RelayErrorCode.TAB_DISCONNECTED, retryable: true });
  });

  it("見張りの間隔ごとに primary の終了を見つけて引き継ぐ", async () => {
    const port = await findFreePort();
    const primary = coordinator(port);
    const client = coordinator(port, { watchIntervalMs: 50 });
    await primary.start();
    await client.start();
    await primary.close();
    await waitFor(() => client.role === "primary", 5_000);
    expect((await probeBridgeHealth(port)).kind).toBe("bridge");
  });

  it("引き継ぎの取り合いは 1 つだけが勝ち、負けた方はその primary へ渡す", async () => {
    const port = await findFreePort();
    const primary = coordinator(port);
    const a = coordinator(port);
    const b = coordinator(port);
    await primary.start();
    await a.start();
    await b.start();
    await primary.close();

    const results = await Promise.all([a.tryTakeOver(), b.tryTakeOver(), a.tryTakeOver(), b.tryTakeOver()]);
    const roles = [a.role, b.role].sort();
    expect(roles).toEqual(["client", "primary"]);
    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1);

    const tab = await FakeTab.connect(addressOf(port));
    tab.onInvoke = (msg) => tab.answer(msg.id, "勝った方のタブ");
    const loser = a.role === "client" ? a : b;
    expect(await loser.hub.invoke(readRequest())).toMatchObject({ ok: true, result: { content: [{ text: "勝った方のタブ" }] } });
  });

  it("鍵が食い違うと、client の呼び出しは実行されずにエラーになる", async () => {
    const port = await findFreePort();
    const other = await createSandbox();
    try {
      new BridgeKeyStore(other.keyFile).ensure();
      const primary = coordinator(port);
      const client = coordinator(port, { keyStore: other.keyStore() });
      await primary.start();
      expect((await client.start()).kind).toBe("client");
      const tab = await FakeTab.connect(addressOf(port));
      tab.onInvoke = (msg) => tab.answer(msg.id);
      const res = await client.hub.invoke(readRequest("patch_cells"));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(RelayErrorCode.TOOL_ERROR);
        expect(res.message).toContain("認証");
      }
      expect(tab.frames("tool.invoke")).toHaveLength(0);
    } finally {
      await other.cleanup();
    }
  });

  it("ポートを mxstudio 以外のサーバが使っていたら、ずらさず conflict", async () => {
    const port = await findFreePort();
    await occupyWith(port, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h1>other app</h1>");
    });
    const c = coordinator(port);
    const started = await c.start();
    expect(started.kind).toBe("conflict");
    if (started.kind === "conflict") expect(started.message).toContain(`ポート ${port} は別のアプリが使っています`);
    expect(c.server).toBeNull();
    // primary にならなかったので鍵ファイルも作らない
    expect(existsSync(box.keyFile)).toBe(false);
  });

  it("ポートで誰かが応答するなら待ち受けを試さない（0.0.0.0 で待つ別のアプリの手前に割り込まない）", async () => {
    // Windows と macOS では、別のアプリが 0.0.0.0 や [::] で待ち受けていても 127.0.0.1 での待ち受けが成功し、
    // 黙ってそのアプリの手前に割り込んでしまう。試験で 0.0.0.0 に待ち受けると Windows のファイアウォールの
    // 確認が出ることがあるので、「応答があるときは Hub を作らない＝待ち受けを試していない」ことで確かめる
    const countingHub = (counter: { n: number }) => () => {
      counter.n += 1;
      return new LocalHub({ timeoutScale: SCALE });
    };
    const otherPort = await findFreePort();
    await occupyWith(otherPort, (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h1>other app</h1>");
    });
    const againstOther = { n: 0 };
    expect((await coordinator(otherPort, { createHub: countingHub(againstOther) }).start()).kind).toBe("conflict");
    expect(againstOther.n).toBe(0);

    // mxstudio の橋渡しが応答するときも、待ち受けを試さずに client になる
    const port = await findFreePort();
    const primaryHubs = { n: 0 };
    expect((await coordinator(port, { createHub: countingHub(primaryHubs) }).start()).kind).toBe("primary");
    expect(primaryHubs.n).toBe(1);
    const clientHubs = { n: 0 };
    expect((await coordinator(port, { createHub: countingHub(clientHubs) }).start()).kind).toBe("client");
    expect(clientHubs.n).toBe(0);
  });

  it("大きすぎる呼び出しは primary へ送らずに TOO_LARGE（実行されていない書き込みを結果不明にしない）", async () => {
    const port = await findFreePort();
    const primary = coordinator(port);
    const client = coordinator(port);
    await primary.start();
    await client.start();
    const tab = await FakeTab.connect(addressOf(port));
    tab.onInvoke = (msg) => tab.answer(msg.id);
    const big = "x".repeat(Math.ceil(PEER_MAX_INVOKE_BYTES * 1.5));
    const res = await client.hub.invoke({ tool: "patch_cells", args: { big }, readOnly: false, deadlineMs: 5_000, idempotencyKey: "big" });
    expect(res).toMatchObject({ ok: false, code: RelayErrorCode.TOO_LARGE, retryable: false });
    expect(tab.frames("tool.invoke")).toHaveLength(0);
  });

  it("/_mxstudio/health を持たない古い版の橋渡しは見分けて止まる", async () => {
    const port = await findFreePort();
    await occupyWith(port, (req, res) => {
      if (req.url === "/ws") {
        res.writeHead(426, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "upgrade_required" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html>");
    });
    const started = await coordinator(port).start();
    expect(started.kind).toBe("conflict");
    if (started.kind === "conflict") expect(started.message).toContain("古い版");
  });

  it("取り決めの版が違う橋渡しには中継しない", async () => {
    const port = await findFreePort();
    await occupyWith(port, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: BRIDGE_NAME, version: "99.0.0", protocol: 999 }));
    });
    const started = await coordinator(port).start();
    expect(started.kind).toBe("conflict");
    if (started.kind === "conflict") expect(started.message).toContain("版の違う");
  });
});

// ---------------------------------------------------------------------------

describe("CLI（別プロセス）", () => {
  it("2 つ目の CLI は client になり、MCP のツール呼び出しが primary の Hub の偽タブに届く（進捗も届く）。primary を止めると引き継ぐ", async () => {
    const port = await findFreePort();
    const first = new CliProcess(["--port", String(port)], box);
    await first.waitForStderr("listening on");
    const second = new CliProcess(["--port", String(port)], box);
    await second.waitForStderr("relaying to");
    expect(second.stderr).not.toContain("listening on");
    await second.initialize(1);

    const address: BridgeAddress = addressOf(port);
    const tab = await FakeTab.connect(address);
    answerWithProgress(tab, "primary のタブ");
    const call = await second.call(2, "tools/call", { name: "load_sheet", arguments: LOAD_ARGS, _meta: { progressToken: "tok-cli" } }, 20_000);
    // 会話で最初の呼び出しなので、タブの結果の後ろに基本手順の Skill が添えられる
    expect(call.result).toMatchObject({ content: [{ type: "text", text: "primary のタブ" }, { type: "text", text: expect.stringContaining("mxstudio の基本手順と禁止事項") }] });
    expect((tab.frames("tool.invoke")[0] as unknown as InvokeMsg).tool).toBe("load_sheet");
    const progress = second.notifications.filter((n) => n.method === "notifications/progress");
    expect(progress[0]?.params).toMatchObject({ progressToken: "tok-cli", progress: 1, total: 2 });
    expect(second.badLines).toEqual([]);

    // primary のプロセスを止めると、client がポートを取り直して primary になる
    first.stop();
    await first.exited;
    await second.waitForStderr("took over as primary", 15_000);
    await waitFor(async () => (await probeBridgeHealth(port, 500)).kind === "bridge", 10_000);

    // 作業タブが同じ URL につなぎ直した後の呼び出しが通る
    const again = await FakeTab.connect(address);
    again.onInvoke = (msg) => again.answer(msg.id, "引き継いだ橋渡しのタブ");
    const after = await second.call(3, "tools/call", { name: "get_status", arguments: {} }, 20_000);
    expect(after.result).toMatchObject({ content: [{ type: "text", text: "引き継いだ橋渡しのタブ" }] });

    // 鍵の値はどちらのログにも出さない
    const key = box.keyStore().current() as string;
    expect(first.stderr + second.stderr + second.stdout).not.toContain(key);
  }, 60_000);

  it("client の呼び出しの途中で primary のプロセスが落ちたら、書き込みは結果不明、読み取りは結果不明にしない", async () => {
    const port = await findFreePort();
    const first = new CliProcess(["--port", String(port), "--no-mcp"], box);
    await first.waitForStderr("listening on");
    const second = new CliProcess(["--port", String(port)], box);
    await second.waitForStderr("relaying to");
    await second.initialize(1);

    const tab = await FakeTab.connect(addressOf(port));
    // ack だけして結果を返さない（作業画面が処理している最中）
    tab.onInvoke = (msg) => tab.ack(msg.id);
    const writeArgs = { sheet: "WO", edits: [{ rowKey: "1", col: "DESCRIPTION", value: "x" }], baseRevision: 0, reason: "試験" };
    const write = second.call(2, "tools/call", { name: "patch_cells", arguments: writeArgs }, 40_000);
    const read = second.call(3, "tools/call", { name: "query_rows", arguments: { sheet: "WO" } }, 40_000);
    await waitFor(() => tab.frames("tool.invoke").length === 2, 10_000);

    // primary のプロセスを強制終了する（後片付けをさせない）
    first.stop();
    type ToolReply = { isError?: boolean; structuredContent?: { error?: { code?: number } } };
    const w = (await write).result as ToolReply;
    const r = (await read).result as ToolReply;
    expect(w.isError).toBe(true);
    expect(w.structuredContent?.error?.code).toBe(RelayErrorCode.UNKNOWN_OUTCOME);
    // 読み取りは送り直してよい（引き継いだ橋渡しにタブがつなぎ直していなければ NO_TAB などになる）
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.error?.code).not.toBe(RelayErrorCode.UNKNOWN_OUTCOME);
    expect(second.badLines).toEqual([]);
  }, 60_000);

  it("MCP クライアントが stdin を閉じると、client も primary も終了してポートを残さない", async () => {
    const port = await findFreePort();
    const first = new CliProcess(["--port", String(port)], box);
    await first.waitForStderr("listening on");
    const second = new CliProcess(["--port", String(port)], box);
    await second.waitForStderr("relaying to");

    second.child.stdin.end();
    expect(await second.exited).toBe(0);
    // client が終わっても primary はそのまま
    expect((await probeBridgeHealth(port)).kind).toBe("bridge");

    first.child.stdin.end();
    expect(await first.exited).toBe(0);
    expect((await probeBridgeHealth(port, 1_000)).kind).toBe("down");
  }, 30_000);

  it("ポートを mxstudio 以外のサーバが使っていると、ずらさず終了コード 1", async () => {
    const port = await findFreePort();
    await occupyWith(port, (_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not mxstudio");
    });
    const cli = new CliProcess(["--port", String(port)], box);
    expect(await cli.exited).toBe(1);
    expect(cli.stderr).toContain(`ポート ${port} は別のアプリが使っています`);
    expect(cli.stderr).not.toContain("listening on");
    expect(cli.stdout).toBe("");
    expect(existsSync(box.keyFile)).toBe(false);
  }, 30_000);

  it("--no-mcp の 2 つ目は、既に動いている橋渡しを使うと知らせて終了コード 0", async () => {
    const port = await findFreePort();
    const first = new CliProcess(["--port", String(port), "--no-mcp"], box);
    await first.waitForStderr("listening on");
    const second = new CliProcess(["--port", String(port), "--no-mcp"], box);
    expect(await second.exited).toBe(0);
    expect(second.stderr).toContain("既に mxstudio の橋渡し");
    // 先に動いている橋渡しはそのまま
    expect((await probeBridgeHealth(port)).kind).toBe("bridge");
  }, 30_000);
});
