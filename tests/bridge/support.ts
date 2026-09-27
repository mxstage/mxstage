// 橋渡しの試験で使う道具。偽のタブ（WebSocket クライアント）と、後片付け付きの起動。
// 鍵ファイル・設定の置き場所は必ず一時フォルダに差し替える（利用者の本物の %LOCALAPPDATA% などに作らない）。

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { BRIDGE_KEY_FILE_ENV, BridgeKeyStore } from "../../src/bridge/bridgeKey.ts";
import { RELAY_PROTOCOL_VERSION, RELAY_SUBPROTOCOL } from "../../src/shared/protocol.ts";
import type { InvokeMsg, ToolResultPayload } from "../../src/shared/protocol.ts";
import { LocalHub } from "../../src/bridge/hub.ts";
import { ImportTickets } from "../../src/bridge/importUpload.ts";
import { startBridgeServer } from "../../src/bridge/server.ts";
import type { BridgeServer, BridgeServerOptions } from "../../src/bridge/server.ts";

export const REPO_ROOT = join(import.meta.dirname, "..", "..");
export const APP_DIR = join(REPO_ROOT, "dist", "app");

/** 試験では締切を 1/20 にする（worker の RELAY_TIMEOUT_SCALE=0.05 と同じ考え方） */
export const SCALE = 0.05;

const running: BridgeServer[] = [];
const tabs: FakeTab[] = [];

/** 橋渡しの接続先（BridgeServer か、別プロセスの橋渡しのポート） */
export interface BridgeAddress {
  readonly port: number;
  readonly origin: string;
}

export function addressOf(port: number): BridgeAddress {
  return { port, origin: `http://127.0.0.1:${port}` };
}

export async function startTestBridge(opts: Partial<BridgeServerOptions> = {}): Promise<BridgeServer> {
  const bridge = await startBridgeServer({
    port: 0,
    root: opts.root ?? APP_DIR,
    hub: opts.hub ?? new LocalHub({ timeoutScale: SCALE }),
    tickets: opts.tickets ?? new ImportTickets(),
    ...opts,
  });
  running.push(bridge);
  return bridge;
}

export async function stopAll(): Promise<void> {
  for (const tab of tabs.splice(0)) tab.close();
  for (const bridge of running.splice(0)) await bridge.close();
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** fetch では付けられないヘッダ（Host など）も指定できる素の HTTP 要求 */
export function rawRequest(
  bridge: BridgeAddress,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<RawResponse> {
  return new Promise((done, failed) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: bridge.port, path, method: opts.method ?? "GET", headers: { host: `127.0.0.1:${bridge.port}`, ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", failed);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > until) throw new Error("条件が時間内に満たされませんでした");
    await sleep(5);
  }
}

type Frame = Record<string, unknown> & { type: string };

export interface FakeTabOptions {
  tabId?: string;
  focused?: boolean;
  protocol?: number;
  /** Origin ヘッダ（既定は橋渡しのオリジン。null なら付けない） */
  origin?: string | null;
  /** hello を自動で送らない */
  noHello?: boolean;
  appVersion?: string;
}

/** 作業タブのふりをする WebSocket クライアント */
export class FakeTab {
  readonly tabId: string;
  readonly received: Frame[] = [];
  /** tool.invoke が届いたときの応答（既定は ack して空の結果を返す） */
  onInvoke: ((msg: InvokeMsg, tab: FakeTab) => void) | null = null;

  private readonly ws: WebSocket;

  private constructor(ws: WebSocket, tabId: string) {
    this.ws = ws;
    this.tabId = tabId;
    ws.onmessage = (ev: MessageEvent): void => {
      const text = String(ev.data);
      if (text === "pong") {
        this.received.push({ type: "pong" });
        return;
      }
      let frame: Frame;
      try {
        frame = JSON.parse(text) as Frame;
      } catch {
        return;
      }
      this.received.push(frame);
      if (frame.type === "tool.invoke" && this.onInvoke) this.onInvoke(frame as unknown as InvokeMsg, this);
    };
  }

  static async connect(bridge: BridgeAddress, opts: FakeTabOptions = {}): Promise<FakeTab> {
    const tabId = opts.tabId ?? `tab-${Math.random().toString(16).slice(2)}`;
    const origin = opts.origin === null ? undefined : (opts.origin ?? bridge.origin);
    const headers: Record<string, string> = {};
    if (origin) headers.Origin = origin;
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, { protocols: [RELAY_SUBPROTOCOL], headers } as unknown as string[]);
    const tab = new FakeTab(ws, tabId);
    tabs.push(tab);
    await new Promise<void>((done, failed) => {
      ws.onopen = () => done();
      ws.onerror = () => failed(new Error("WebSocket を開けませんでした"));
      ws.onclose = (ev) => failed(new Error(`WebSocket が閉じました（${ev.code}）`));
    });
    ws.onclose = null;
    ws.onerror = null;
    if (!opts.noHello) {
      tab.send({
        type: "hello",
        tabId,
        protocol: opts.protocol ?? RELAY_PROTOCOL_VERSION,
        appVersion: opts.appVersion ?? "test",
        tools: [],
        revision: 0,
        workspace: null,
        focused: opts.focused ?? true,
      });
      await tab.waitFor("welcome").catch(() => undefined);
    }
    return tab;
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  ack(id: string): void {
    this.send({ type: "tool.ack", id });
  }

  result(id: string, result: ToolResultPayload, revision = 1): void {
    this.send({ type: "tool.result", id, result, revision });
  }

  /** ack してから結果を返す（普通のタブの動き） */
  answer(id: string, text = "ok", revision = 1): void {
    this.ack(id);
    this.result(id, { content: [{ type: "text", text }] }, revision);
  }

  frames(type: string): Frame[] {
    return this.received.filter((f) => f.type === type);
  }

  async waitFor(type: string, timeoutMs = 3_000): Promise<Frame> {
    await waitFor(() => this.received.some((f) => f.type === type), timeoutMs);
    return this.received.find((f) => f.type === type) as Frame;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // 既に閉じている
    }
  }
}

// ---------------------------------------------------------------------------
// 一時フォルダの隔離環境（鍵ファイル・設定の置き場所）
// ---------------------------------------------------------------------------

export interface Sandbox {
  dir: string;
  /** 鍵ファイルの場所（一時フォルダの中） */
  keyFile: string;
  /** 子プロセスに渡す環境変数。鍵ファイルと設定の置き場所をすべて一時フォルダに向ける */
  env: NodeJS.ProcessEnv;
  keyStore(): BridgeKeyStore;
  cleanup(): Promise<void>;
}

/** 一時フォルダの中か（本物の置き場所を指していないことの確認） */
export function isUnderTmp(path: string): boolean {
  return resolve(path).startsWith(resolve(tmpdir()) + sep);
}

export async function createSandbox(): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), "mxs-bridge-sbx-"));
  const keyFile = join(dir, "local", "mxstudio", "bridge.key");
  if (!isUnderTmp(keyFile)) throw new Error("鍵ファイルが一時フォルダの外を指しています");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [BRIDGE_KEY_FILE_ENV]: keyFile,
    LOCALAPPDATA: join(dir, "local"),
    APPDATA: join(dir, "roaming"),
    XDG_CONFIG_HOME: join(dir, "config"),
    HOME: join(dir, "home"),
    USERPROFILE: join(dir, "home"),
  };
  return {
    dir,
    keyFile,
    env,
    keyStore: () => new BridgeKeyStore(keyFile),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// ポート
// ---------------------------------------------------------------------------

/** 待ち受けられるか（すぐ閉じる） */
export function canListen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
}

/** 19000 番台で空いているポートを探す（利用者の 8788 は避ける） */
export async function findFreePort(): Promise<number> {
  const span = 1_000;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < 300; i += 1) {
    const port = 19_000 + ((start + i * 7) % span);
    if (await canListen(port)) return port;
  }
  throw new Error("19000 番台に空いているポートが見つかりませんでした");
}

// ---------------------------------------------------------------------------
// CLI（別プロセスの橋渡し）
// ---------------------------------------------------------------------------

export interface Rpc {
  id: number;
  result?: unknown;
  error?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

const cliProcesses: CliProcess[] = [];

/** CLI を子プロセスで動かし、stdio の MCP として話す。環境変数は必ず隔離環境のものを渡す */
export class CliProcess {
  readonly child: ChildProcessWithoutNullStreams;
  stdout = "";
  stderr = "";
  exitCode: number | null = null;
  readonly exited: Promise<number>;
  /** JSON として読めなかった標準出力の行 */
  readonly badLines: string[] = [];
  readonly notifications: RpcNotification[] = [];
  private buffer = "";
  private readonly replies = new Map<number, Rpc>();

  constructor(args: string[], sandbox: Pick<Sandbox, "env" | "keyFile">) {
    if (!isUnderTmp(sandbox.keyFile) || sandbox.env[BRIDGE_KEY_FILE_ENV] !== sandbox.keyFile) {
      throw new Error("CLI の試験は一時フォルダの鍵ファイルでだけ動かします");
    }
    this.child = spawn(process.execPath, ["--experimental-strip-types", "src/bridge/cli.ts", ...args], {
      cwd: REPO_ROOT,
      env: sandbox.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    cliProcesses.push(this);
    this.exited = new Promise((done) => {
      this.child.on("exit", (code) => {
        this.exitCode = code ?? -1;
        done(this.exitCode);
      });
    });
    this.child.stdout.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      this.stdout += text;
      this.buffer += text;
      let nl = this.buffer.indexOf("\n");
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) {
          try {
            const msg = JSON.parse(line) as Rpc & RpcNotification & { jsonrpc?: string };
            if (msg.jsonrpc !== "2.0") this.badLines.push(line);
            else if (typeof msg.id === "number") this.replies.set(msg.id, msg);
            else if (typeof msg.method === "string") this.notifications.push({ method: msg.method, params: msg.params });
          } catch {
            this.badLines.push(line);
          }
        }
        nl = this.buffer.indexOf("\n");
      }
    });
    this.child.stderr.on("data", (d: Buffer) => {
      this.stderr += d.toString("utf8");
    });
    // 試験が失敗して stdin が閉じられないまま残っても、書き込みの失敗で落とさない
    this.child.stdin.on("error", () => undefined);
  }

  send(msg: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  async call(id: number, method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<Rpc> {
    this.send({ jsonrpc: "2.0", id, method, params });
    await waitFor(() => this.replies.has(id), timeoutMs);
    return this.replies.get(id) as Rpc;
  }

  /** initialize と notifications/initialized */
  async initialize(id = 1): Promise<Rpc> {
    const init = await this.call(id, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return init;
  }

  async waitForStderr(text: string, timeoutMs = 15_000): Promise<void> {
    await waitFor(() => this.stderr.includes(text), timeoutMs);
  }

  stop(): void {
    if (this.exitCode === null) this.child.kill();
  }
}

/** 起動した CLI をすべて止める（終了を待つ） */
export async function stopAllCli(): Promise<void> {
  const list = cliProcesses.splice(0);
  for (const cli of list) cli.stop();
  await Promise.all(list.map((cli) => Promise.race([cli.exited, sleep(5_000)])));
}
