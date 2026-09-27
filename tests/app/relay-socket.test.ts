// 中継クライアント（RelaySocket）の試験。
// 偽の WebSocket で送信フレームを記録し、Hub からの受信を注入する。時間は vi.useFakeTimers で進める。
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { RELAY_LIMITS, RELAY_PROTOCOL_VERSION, RELAY_SUBPROTOCOL, RELAY_TIMEOUTS, RelayErrorCode } from "../../src/shared/protocol";
import type { InvokeMsg, SheetOpsMsg, ToolResultPayload } from "../../src/shared/protocol";
import type { ToolName } from "../../src/shared/toolDefs";
import {
  BACKOFF_MAX_MS,
  IDEMPOTENCY_MAX_ENTRIES,
  IDEMPOTENCY_TTL_MS,
  MAX_ERROR_MESSAGE_CHARS,
  PROGRESS_INTERVAL_MS,
  RelaySocket,
  RelayToolError,
  backoffDelay,
  buildChunkFrames,
  pageTabId,
  relayUrl,
  utf8ByteLength,
} from "../../src/app/relay/socket";
import type { RelaySocketOptions, ToolContext, ToolHandler, ToolOutcome, WebSocketLike } from "../../src/app/relay/socket";
import type { ImportedFile } from "../../src/app/relay/imports";

type Frame = Record<string, unknown> & { type: string };

const encoder = new TextEncoder();
const bytesOf = (s: string): number => encoder.encode(s).byteLength;

const TAB_ID = "tab-test";
const HEARTBEAT_MS = RELAY_TIMEOUTS.heartbeatMs;

/** 偽の WebSocket。client 側の操作を記録し、サーバ側の操作（accept・receive・serverClose）を試験から呼ぶ */
class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: string[] = [];
  clientClose: { code: number | undefined; reason: string | undefined } | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("開いていないソケットに送信した");
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.clientClose = { code, reason };
    this.readyState = 3;
  }

  accept(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }

  receiveRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }

  frames(): Frame[] {
    return this.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s) as Frame);
  }

  framesOf(type: string): Frame[] {
    return this.frames().filter((f) => f.type === type);
  }

  pings(): number {
    return this.sent.filter((s) => s === "ping").length;
  }
}

class FakeDocument extends EventTarget {
  visibilityState = "visible";
  focused = true;

  hasFocus(): boolean {
    return this.focused;
  }
}

interface Harness {
  relay: RelaySocket;
  win: EventTarget;
  doc: FakeDocument;
  handler: Mock<ToolHandler>;
}

const relays: RelaySocket[] = [];
let callNo = 0;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
});

afterEach(() => {
  for (const relay of relays.splice(0)) relay.stop();
  vi.useRealTimers();
});

function setup(over: Partial<RelaySocketOptions> & { impl?: ToolHandler } = {}): Harness {
  const { impl, ...opts } = over;
  const win = new EventTarget();
  const doc = new FakeDocument();
  const handler = vi.fn<ToolHandler>(impl ?? (async () => ({ result: textResult("ok"), revision: 7 })));
  const relay = new RelaySocket({
    url: "wss://mx.test/ws",
    appVersion: "test-1",
    tools: ["query_rows", "patch_cells"],
    getRevision: () => 3,
    getWorkspace: () => "WS-1",
    handler,
    WebSocketImpl: FakeWebSocket,
    random: () => 0,
    window: win,
    document: doc,
    tabId: TAB_ID,
    ...opts,
  });
  relays.push(relay);
  return { relay, win, doc, handler };
}

function lastSocket(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error("WebSocket が作られていません");
  return ws;
}

function welcome(ws: FakeWebSocket, over: Record<string, unknown> = {}): void {
  ws.receive({ type: "welcome", role: "primary", primaryTabId: TAB_ID, heartbeatMs: HEARTBEAT_MS, ...over });
}

/** start して接続し、welcome まで済ませる */
function open(h: Harness): FakeWebSocket {
  h.relay.start();
  const ws = lastSocket();
  ws.accept();
  welcome(ws);
  return ws;
}

function textResult(text: string): ToolResultPayload {
  return { content: [{ type: "text", text }] };
}

function invokeMsg(over: Partial<InvokeMsg> = {}): InvokeMsg {
  callNo += 1;
  const deadlineAt = over.deadlineAt ?? Date.now() + RELAY_TIMEOUTS.readDeadlineMs;
  return {
    type: "tool.invoke",
    id: `c_${callNo}`,
    tool: "query_rows",
    args: { sheet: "WO" },
    deadlineAt,
    timeoutMs: deadlineAt - Date.now(),
    idempotencyKey: `key-${callNo}`,
    readOnly: true,
    ...over,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** JSON にしたときちょうど n バイトになる結果 */
function resultOfBytes(n: number): ToolResultPayload {
  const empty = JSON.stringify(textResult(""));
  return textResult("a".repeat(n - empty.length));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

// ---------------------------------------------------------------------------

describe("relayUrl と tabId", () => {
  it("https は wss、http は ws にして /ws を付ける", () => {
    expect(relayUrl({ protocol: "https:", host: "mx.example.com" })).toBe("wss://mx.example.com/ws");
    expect(relayUrl({ protocol: "http:", host: "localhost:8787" })).toBe("ws://localhost:8787/ws");
  });

  it("tabId はページごとに 1 つ作り、Hub の isValidTabId に合う。sessionStorage には保存しない", () => {
    const storedBefore = globalThis.sessionStorage?.length ?? 0;
    const a = setup({ tabId: undefined }).relay;
    const b = setup({ tabId: undefined }).relay;
    expect(a.tabId).toMatch(/^tab-[0-9a-f-]{36}$/);
    expect(a.tabId.length).toBeLessThanOrEqual(128);
    expect(b.tabId).toBe(a.tabId);
    expect(pageTabId()).toBe(a.tabId);
    expect(globalThis.sessionStorage?.length ?? 0).toBe(storedBefore);
  });

  it("バックオフのジッタは待ち時間を最大 3 割だけ短くし、上限を超えない", () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(0, () => 1)).toBe(350);
    expect(backoffDelay(3, () => 0.5)).toBe(3_400);
    expect(backoffDelay(50, () => 0)).toBe(BACKOFF_MAX_MS);
  });
});

describe("接続", () => {
  it("open で hello を送り、welcome で open になって role が反映される。tab.roles で role が変わる", () => {
    const h = setup();
    h.relay.start();
    expect(h.relay.getStatus().state).toBe("connecting");
    const ws = lastSocket();
    expect(ws.url).toBe("wss://mx.test/ws");
    expect(ws.protocols).toBe(RELAY_SUBPROTOCOL);

    ws.accept();
    expect(ws.frames()).toEqual([
      {
        type: "hello",
        tabId: TAB_ID,
        protocol: RELAY_PROTOCOL_VERSION,
        appVersion: "test-1",
        tools: ["query_rows", "patch_cells"],
        revision: 3,
        workspace: "WS-1",
        focused: true,
      },
    ]);
    expect(h.relay.getStatus().state).toBe("connecting");

    welcome(ws, { role: "mirror", primaryTabId: "tab-other" });
    expect(h.relay.getStatus()).toMatchObject({ state: "open", role: "mirror", primaryTabId: "tab-other", tabId: TAB_ID });

    ws.receive({ type: "tab.roles", primaryTabId: TAB_ID });
    expect(h.relay.getStatus()).toMatchObject({ role: "primary", primaryTabId: TAB_ID });
    ws.receive({ type: "tab.roles", primaryTabId: null });
    expect(h.relay.getStatus()).toMatchObject({ role: "mirror", primaryTabId: null });
  });

  it("hello の focused は document.hasFocus() の値", () => {
    const h = setup();
    h.doc.focused = false;
    h.relay.start();
    lastSocket().accept();
    expect(lastSocket().framesOf("hello")[0]).toMatchObject({ focused: false });
  });

  it("onStatus に状態の変化を通知する", () => {
    const seen: string[] = [];
    const h = setup({ onStatus: (s) => seen.push(s.state) });
    const ws = open(h);
    ws.serverClose(1006);
    h.relay.stop();
    expect(seen).toEqual(["connecting", "open", "reconnecting", "closed"]);
  });

  it("window の focus と visibilitychange(visible) で tab.focus を送る（接続中のみ）", () => {
    const h = setup();
    h.relay.start();
    const ws = lastSocket();
    h.win.dispatchEvent(new Event("focus"));
    expect(ws.sent).toHaveLength(0);

    ws.accept();
    welcome(ws);
    h.win.dispatchEvent(new Event("focus"));
    expect(ws.framesOf("tab.focus")).toEqual([{ type: "tab.focus", tabId: TAB_ID }]);

    h.doc.visibilityState = "hidden";
    h.doc.dispatchEvent(new Event("visibilitychange"));
    expect(ws.framesOf("tab.focus")).toHaveLength(1);

    h.doc.visibilityState = "visible";
    h.doc.dispatchEvent(new Event("visibilitychange"));
    expect(ws.framesOf("tab.focus")).toHaveLength(2);

    h.relay.notifyFocus();
    expect(ws.framesOf("tab.focus")).toHaveLength(3);
  });

  it("sheet.ops は onSheetOps に渡すだけ", () => {
    const got: SheetOpsMsg[] = [];
    const h = setup({ onSheetOps: (m) => got.push(m) });
    const ws = open(h);
    ws.receive({ type: "sheet.ops", tabId: "tab-other", revision: 4, ops: [{ op: "set", cell: "A1" }] });
    expect(got).toEqual([{ type: "sheet.ops", tabId: "tab-other", revision: 4, ops: [{ op: "set", cell: "A1" }] }]);
  });

  it("不正な JSON・未知の type・形の合わないメッセージでは落ちず、何も送らない", () => {
    const h = setup();
    h.relay.start();
    const ws = lastSocket();
    ws.accept();
    expect(() => {
      ws.receive("{not json");
      ws.receive("null");
      ws.receive("[]");
      ws.receive("42");
      ws.receive("pong");
      ws.receive({ type: "nope" });
      ws.receive({ noType: true });
      ws.receive({ type: "welcome", role: "boss", primaryTabId: null, heartbeatMs: 1 });
      ws.receive({ type: "tab.roles", primaryTabId: 5 });
      ws.receive({ type: "tool.invoke", id: 5 });
      ws.receive({ type: "tool.invoke", id: "c_x", tool: "query_rows" });
      ws.receive({ type: "tool.cancel" });
      ws.receive({ type: "import.chunk", importId: 1 });
      ws.receive({ type: "sheet.ops", tabId: 3 });
      ws.receive({ type: "error", code: "x" });
      ws.receiveRaw(new ArrayBuffer(4));
      ws.receiveRaw(undefined);
    }).not.toThrow();
    expect(ws.frames().map((f) => f.type)).toEqual(["hello"]);
    expect(h.relay.getStatus().state).toBe("connecting");
    expect(h.handler).not.toHaveBeenCalled();

    welcome(ws);
    expect(h.relay.getStatus().state).toBe("open");
  });
});

describe("tool.invoke", () => {
  it("すぐに ack を返し、ハンドラの結果を tool.result で返す", async () => {
    const h = setup({ impl: async () => ({ result: textResult("行を 3 件読みました"), revision: 12 }) });
    const ws = open(h);
    const inv = invokeMsg({ args: { sheet: "WO", limit: 3 } });
    ws.receive(inv);
    expect(ws.frames().map((f) => f.type)).toEqual(["hello", "tool.ack"]);
    expect(ws.framesOf("tool.ack")).toEqual([{ type: "tool.ack", id: inv.id }]);

    await flush();
    expect(ws.framesOf("tool.result")).toEqual([{ type: "tool.result", id: inv.id, result: textResult("行を 3 件読みました"), revision: 12 }]);
    expect(h.handler).toHaveBeenCalledTimes(1);
    const [passed, ctx] = h.handler.mock.calls[0] ?? [];
    expect(passed).toEqual(inv);
    expect(ctx?.signal.aborted).toBe(false);
  });

  it("RelayToolError は code・message・retryable をそのまま tool.error にする", async () => {
    const h = setup({
      impl: async () => {
        throw new RelayToolError(RelayErrorCode.STALE_REVISION, "読み直してください", true);
      },
    });
    const ws = open(h);
    const inv = invokeMsg();
    ws.receive(inv);
    await flush();
    expect(ws.framesOf("tool.error")).toEqual([
      { type: "tool.error", id: inv.id, code: RelayErrorCode.STALE_REVISION, message: "読み直してください", retryable: true },
    ]);
  });

  it("それ以外の例外は TOOL_ERROR。message は 2000 字に切り、スタックは送らない", async () => {
    const long = "失敗".repeat(3_000);
    const h = setup({
      impl: async (inv) => {
        if (inv.idempotencyKey === "sync") throw new TypeError("同期の失敗");
        throw new Error(long);
      },
    });
    const ws = open(h);
    const a = invokeMsg();
    ws.receive(a);
    await flush();
    const [err] = ws.framesOf("tool.error");
    expect(err).toMatchObject({ id: a.id, code: RelayErrorCode.TOOL_ERROR, message: long.slice(0, MAX_ERROR_MESSAGE_CHARS) });
    expect((err?.message as string).length).toBe(MAX_ERROR_MESSAGE_CHARS);
    expect(err).not.toHaveProperty("retryable");
    expect(JSON.stringify(err)).not.toContain("at ");

    // 同期的に投げるハンドラでも落ちない
    const syncHandler: ToolHandler = () => {
      throw new TypeError("同期の失敗");
    };
    const h2 = setup({ impl: syncHandler });
    const ws2 = open(h2);
    const b = invokeMsg();
    ws2.receive(b);
    await flush();
    expect(ws2.framesOf("tool.error")).toEqual([{ type: "tool.error", id: b.id, code: RelayErrorCode.TOOL_ERROR, message: "同期の失敗" }]);
  });

  it("Hub とブラウザの時計がずれていても timeoutMs（受信時刻からの残り）で締切を判定する", async () => {
    const h = setup();
    const ws = open(h);
    // Hub の時計ではすでに締切を過ぎているが、残り時間は 5 秒ある
    const skewed = invokeMsg({ deadlineAt: Date.now() - 60_000, timeoutMs: 5_000, idempotencyKey: "skew" });
    ws.receive(skewed);
    await flush();
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(ws.framesOf("tool.error").filter((f) => f.id === skewed.id)).toEqual([]);
  });

  it("締切を過ぎた invoke はハンドラを呼ばずに DEADLINE を返す（結果は覚えない）", async () => {
    const h = setup();
    const ws = open(h);
    const past = invokeMsg({ deadlineAt: Date.now() - 1, idempotencyKey: "late" });
    const exact = invokeMsg({ deadlineAt: Date.now() });
    ws.receive(past);
    ws.receive(exact);
    await flush();
    expect(h.handler).not.toHaveBeenCalled();
    expect(ws.framesOf("tool.ack").map((f) => f.id)).toEqual([past.id, exact.id]);
    expect(ws.framesOf("tool.error")).toEqual([
      expect.objectContaining({ id: past.id, code: RelayErrorCode.DEADLINE, retryable: false }),
      expect.objectContaining({ id: exact.id, code: RelayErrorCode.DEADLINE, retryable: false }),
    ]);

    // 同じキーでも締切内に届けば実行する
    ws.receive(invokeMsg({ idempotencyKey: "late" }));
    await flush();
    expect(h.handler).toHaveBeenCalledTimes(1);
  });

  it("tools に無いツールはハンドラを呼ばずに TOOL_ERROR", async () => {
    const h = setup();
    const ws = open(h);
    const inv = invokeMsg({ tool: "not_a_tool" as ToolName });
    ws.receive(inv);
    await flush();
    expect(h.handler).not.toHaveBeenCalled();
    expect(ws.framesOf("tool.error")).toEqual([expect.objectContaining({ id: inv.id, code: RelayErrorCode.TOOL_ERROR })]);
  });

  it("tool.cancel で signal を abort し、その後の結果は送らない", async () => {
    let seen: ToolContext | undefined;
    const gate = deferred<void>();
    const h = setup({
      impl: async (_inv, ctx) => {
        seen = ctx;
        await gate.promise;
        return { result: textResult("遅れて完了"), revision: 1 };
      },
    });
    const ws = open(h);
    const inv = invokeMsg();
    ws.receive(inv);
    await flush();
    expect(seen?.signal.aborted).toBe(false);

    ws.receive({ type: "tool.cancel", id: inv.id, reason: "deadline" });
    expect(seen?.signal.aborted).toBe(true);
    gate.resolve();
    await flush();
    expect(ws.framesOf("tool.result")).toHaveLength(0);
    expect(ws.framesOf("tool.error")).toHaveLength(0);
  });

  it("キャンセルで失敗した実行は覚えず、同じキーの再試行で実行し直す", async () => {
    const h = setup({
      impl: (_inv, ctx) =>
        new Promise<ToolOutcome>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("中断しました")));
        }),
    });
    const ws = open(h);
    const first = invokeMsg({ idempotencyKey: "retry-me" });
    ws.receive(first);
    await flush();
    ws.receive({ type: "tool.cancel", id: first.id, reason: "superseded" });
    await flush();
    expect(ws.framesOf("tool.error")).toHaveLength(0);

    ws.receive(invokeMsg({ idempotencyKey: "retry-me" }));
    await flush();
    expect(h.handler).toHaveBeenCalledTimes(2);
  });

  it("progress は tool.progress として送り、250ms に 1 回に間引く", async () => {
    let seen: ToolContext | undefined;
    const gate = deferred<ToolOutcome>();
    const h = setup({
      impl: (_inv, ctx) => {
        seen = ctx;
        return gate.promise;
      },
    });
    const ws = open(h);
    const inv = invokeMsg();
    ws.receive(inv);
    await flush();
    if (!seen) throw new Error("ハンドラが呼ばれていません");
    seen.progress(1, 10, "開始");
    seen.progress(2, 10);
    seen.progress(3, 10);
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
    seen.progress(4, 10, "途中");
    seen.progress(Number.NaN);
    gate.resolve({ result: textResult("done"), revision: 2 });
    await flush();
    seen.progress(5, 10);
    expect(ws.framesOf("tool.progress")).toEqual([
      { type: "tool.progress", id: inv.id, progress: 1, total: 10, message: "開始" },
      { type: "tool.progress", id: inv.id, progress: 4, total: 10, message: "途中" },
    ]);
  });

  it("増えない progress は送らず、間引きの起点も動かさない", async () => {
    let seen: ToolContext | undefined;
    const gate = deferred<ToolOutcome>();
    const h = setup({
      impl: (_inv, ctx) => {
        seen = ctx;
        return gate.promise;
      },
    });
    const ws = open(h);
    const inv = invokeMsg();
    ws.receive(inv);
    await flush();
    if (!seen) throw new Error("ハンドラが呼ばれていません");
    seen.progress(5, 10);
    vi.advanceTimersByTime(PROGRESS_INTERVAL_MS);
    // 増えない値は送らない。ここで間引きの起点が動くと、直後の増えた値まで落ちて無応答になる
    seen.progress(3, 10);
    seen.progress(5, 10);
    seen.progress(6, 10);
    gate.resolve({ result: textResult("done"), revision: 1 });
    await flush();
    expect(ws.framesOf("tool.progress")).toEqual([
      { type: "tool.progress", id: inv.id, progress: 5, total: 10 },
      { type: "tool.progress", id: inv.id, progress: 6, total: 10 },
    ]);
  });

  it("結果を送る時にソケットが閉じていれば黙って捨てる（再接続後の接続にも送らない）", async () => {
    const gate = deferred<ToolOutcome>();
    const h = setup({ impl: () => gate.promise });
    const ws = open(h);
    ws.receive(invokeMsg());
    await flush();
    ws.serverClose(1006);
    vi.advanceTimersByTime(500);
    const ws2 = lastSocket();
    expect(ws2).not.toBe(ws);
    ws2.accept();
    welcome(ws2);

    gate.resolve({ result: textResult("done"), revision: 2 });
    await expect(flush()).resolves.toBeUndefined();
    expect(ws.framesOf("tool.result")).toHaveLength(0);
    expect(ws2.framesOf("tool.result")).toHaveLength(0);
  });
});

describe("idempotencyKey の重複排除", () => {
  it("実行中の重複は再実行せず、同じ実行の結果を新しい id でも返す", async () => {
    const gate = deferred<ToolOutcome>();
    const h = setup({ impl: () => gate.promise });
    const ws = open(h);
    const a = invokeMsg({ tool: "patch_cells", readOnly: false, idempotencyKey: "write-1" });
    const b = invokeMsg({ tool: "patch_cells", readOnly: false, idempotencyKey: "write-1" });
    ws.receive(a);
    ws.receive(b);
    await flush();
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(ws.framesOf("tool.ack").map((f) => f.id)).toEqual([a.id, b.id]);

    gate.resolve({ result: textResult("2 セル更新"), revision: 5 });
    await flush();
    expect(ws.framesOf("tool.result")).toEqual([
      { type: "tool.result", id: a.id, result: textResult("2 セル更新"), revision: 5 },
      { type: "tool.result", id: b.id, result: textResult("2 セル更新"), revision: 5 },
    ]);
  });

  it("完了後 60 秒以内は保存した結果を返し、60 秒を過ぎたら再実行する", async () => {
    let clock = 1_000_000;
    let runs = 0;
    const h = setup({
      now: () => clock,
      impl: async () => {
        runs += 1;
        return { result: textResult(`run-${runs}`), revision: runs };
      },
    });
    const ws = open(h);
    ws.receive(invokeMsg({ idempotencyKey: "k" }));
    await flush();

    clock += IDEMPOTENCY_TTL_MS;
    const second = invokeMsg({ idempotencyKey: "k" });
    ws.receive(second);
    await flush();
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(ws.framesOf("tool.result").find((f) => f.id === second.id)).toEqual({
      type: "tool.result",
      id: second.id,
      result: textResult("run-1"),
      revision: 1,
    });

    clock += 1;
    const third = invokeMsg({ idempotencyKey: "k" });
    ws.receive(third);
    await flush();
    expect(h.handler).toHaveBeenCalledTimes(2);
    expect(ws.framesOf("tool.result").find((f) => f.id === third.id)).toMatchObject({ result: textResult("run-2"), revision: 2 });
  });

  it("エラーの結果も保存し、再実行しない", async () => {
    let runs = 0;
    const h = setup({
      impl: async () => {
        runs += 1;
        throw new RelayToolError(RelayErrorCode.BUSY, `busy-${runs}`, true);
      },
    });
    const ws = open(h);
    const a = invokeMsg({ idempotencyKey: "err" });
    const b = invokeMsg({ idempotencyKey: "err" });
    ws.receive(a);
    await flush();
    ws.receive(b);
    await flush();
    expect(h.handler).toHaveBeenCalledTimes(1);
    expect(ws.framesOf("tool.error")).toEqual([
      { type: "tool.error", id: a.id, code: RelayErrorCode.BUSY, message: "busy-1", retryable: true },
      { type: "tool.error", id: b.id, code: RelayErrorCode.BUSY, message: "busy-1", retryable: true },
    ]);
  });

  it("保存は最大 200 件の LRU（使ったものは残り、最も古いものから消える）", async () => {
    const h = setup();
    const ws = open(h);
    for (let i = 0; i <= IDEMPOTENCY_MAX_ENTRIES; i++) ws.receive(invokeMsg({ idempotencyKey: `lru-${i}` }));
    await flush();
    expect(h.handler).toHaveBeenCalledTimes(IDEMPOTENCY_MAX_ENTRIES + 1);

    ws.receive(invokeMsg({ idempotencyKey: "lru-1" }));
    await flush();
    expect(h.handler).toHaveBeenCalledTimes(IDEMPOTENCY_MAX_ENTRIES + 1);

    ws.receive(invokeMsg({ idempotencyKey: "lru-0" }));
    await flush();
    expect(h.handler).toHaveBeenCalledTimes(IDEMPOTENCY_MAX_ENTRIES + 2);
  });
});

describe("結果の分割", () => {
  it("chunkThresholdBytes ちょうどは tool.result、1 バイト超えると tool.chunk", async () => {
    const atLimit = resultOfBytes(RELAY_LIMITS.chunkThresholdBytes);
    const overLimit = resultOfBytes(RELAY_LIMITS.chunkThresholdBytes + 1);
    expect(bytesOf(JSON.stringify(atLimit))).toBe(RELAY_LIMITS.chunkThresholdBytes);
    const h = setup({ impl: async (inv) => ({ result: inv.idempotencyKey === "at" ? atLimit : overLimit, revision: 11 }) });
    const ws = open(h);

    const a = invokeMsg({ idempotencyKey: "at" });
    ws.receive(a);
    await flush();
    expect(ws.framesOf("tool.result")).toEqual([{ type: "tool.result", id: a.id, result: atLimit, revision: 11 }]);
    expect(ws.framesOf("tool.chunk")).toHaveLength(0);

    const b = invokeMsg({ idempotencyKey: "over" });
    ws.receive(b);
    await flush();
    const chunks = ws.framesOf("tool.chunk");
    expect(chunks).toEqual([{ type: "tool.chunk", id: b.id, seq: 0, data: JSON.stringify(overLimit), last: true, revision: 11 }]);
    expect(ws.framesOf("tool.result")).toHaveLength(1);
  });

  it("日本語・絵文字・エスケープを含む大きな結果を、各フレーム maxFrameBytes 以下・文字境界で分割する", async () => {
    const unit = "日本語の点検記録😀🧯\"引用\"\\パス\n改行\u0001制御\té";
    const result: ToolResultPayload = {
      content: [{ type: "text", text: unit.repeat(60_000) }],
      structuredContent: { rows: Array.from({ length: 2_000 }, (_, i) => ({ WONUM: `WO${i}`, DESCRIPTION: "ポンプ😀点検" })) },
    };
    const json = JSON.stringify(result);
    expect(utf8ByteLength(json)).toBe(bytesOf(json));
    expect(bytesOf(json)).toBeGreaterThan(RELAY_LIMITS.maxFrameBytes * 3);
    expect(bytesOf(json)).toBeLessThanOrEqual(RELAY_LIMITS.maxResultBytes);

    const h = setup({ impl: async () => ({ result, revision: 42 }) });
    const ws = open(h);
    const inv = invokeMsg();
    ws.receive(inv);
    await flush();

    const raw = ws.sent.filter((s) => s.startsWith('{"type":"tool.chunk"'));
    expect(raw.length).toBeGreaterThan(3);
    const chunks = raw.map((s) => JSON.parse(s) as { id: string; seq: number; data: string; last: boolean; revision?: number });
    raw.forEach((s, i) => {
      const size = bytesOf(s);
      expect(size).toBeLessThanOrEqual(RELAY_LIMITS.maxFrameBytes);
      // 詰めて使っている（最後以外は上限の近くまで入る）
      if (i < raw.length - 1) expect(size).toBeGreaterThan(RELAY_LIMITS.maxFrameBytes - 64);
    });
    chunks.forEach((c, i) => {
      const last = i === chunks.length - 1;
      expect(c.id).toBe(inv.id);
      expect(c.seq).toBe(i);
      expect(c.last).toBe(last);
      if (last) expect(c.revision).toBe(42);
      else expect(c).not.toHaveProperty("revision");
      if (!last) expect(isHighSurrogate(c.data.charCodeAt(c.data.length - 1))).toBe(false);
      if (i > 0) expect(isLowSurrogate(c.data.charCodeAt(0))).toBe(false);
    });
    // Hub（src/bridge/hub.ts）と同じく連結して JSON.parse すると元に戻る
    expect(JSON.parse(chunks.map((c) => c.data).join(""))).toEqual(result);
    expect(ws.framesOf("tool.result")).toHaveLength(0);
  });

  it("buildChunkFrames は任意の文字列でフレーム上限を守り、サロゲートペアを割らずに元へ戻せる", () => {
    const piece = fc.oneof(
      fc.string({ unit: "binary", maxLength: 8 }),
      fc.constantFrom('"', "\\", "\n", "\u0001", "\u001f", "\u2028", "\ud83d", "\ude00", "😀", "日本", "é", "a"),
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 200 }), fc.integer({ min: 100, max: 400 }), (parts, maxFrameBytes) => {
        const text = parts.join("");
        const json = JSON.stringify({ content: [{ type: "text", text }] });
        const frames = buildChunkFrames("c_prop", json, 5, maxFrameBytes);
        if (!frames) return false;
        const chunks = frames.map((f) => JSON.parse(f) as { seq: number; data: string; last: boolean; revision?: number });
        for (const f of frames) expect(bytesOf(f)).toBeLessThanOrEqual(maxFrameBytes);
        chunks.forEach((c, i) => {
          expect(c.seq).toBe(i);
          expect(c.last).toBe(i === chunks.length - 1);
          if (i < chunks.length - 1) expect(isHighSurrogate(c.data.charCodeAt(c.data.length - 1))).toBe(false);
        });
        expect(chunks.at(-1)?.revision).toBe(5);
        expect(chunks.map((c) => c.data).join("")).toBe(json);
        return true;
      }),
      { numRuns: 300 },
    );
    expect(buildChunkFrames("c_small", '{"a":1}', 1, 50)).toBeNull();
  });

  it("結果 JSON が maxResultBytes を超えたら TOO_LARGE（分割して送らない）", async () => {
    const huge = textResult("a".repeat(RELAY_LIMITS.maxResultBytes));
    const h = setup({ impl: async () => ({ result: huge, revision: 1 }) });
    const ws = open(h);
    const inv = invokeMsg();
    ws.receive(inv);
    await flush();
    expect(ws.framesOf("tool.error")).toEqual([expect.objectContaining({ id: inv.id, code: RelayErrorCode.TOO_LARGE, retryable: false })]);
    expect(ws.framesOf("tool.chunk")).toHaveLength(0);
    expect(ws.framesOf("tool.result")).toHaveLength(0);
  });
});

describe("心拍と再接続", () => {
  it("heartbeatMs ごとに文字列 ping を送り、pong が返らなければ閉じて同じ tabId で再接続する", () => {
    const h = setup();
    const ws = open(h);
    expect(ws.pings()).toBe(0);

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(ws.pings()).toBe(1);
    ws.receive("pong");
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(ws.pings()).toBe(2);
    expect(ws.clientClose).toBeNull();

    // 最後の受信（pong）から heartbeatMs×2 経っても何も来ない
    vi.advanceTimersByTime(HEARTBEAT_MS - 1);
    expect(ws.clientClose).toBeNull();
    vi.advanceTimersByTime(1);
    expect(ws.clientClose?.code).toBe(4001);
    expect(h.relay.getStatus()).toMatchObject({ state: "reconnecting", role: null, nextRetryMs: 500 });
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const ws2 = lastSocket();
    ws2.accept();
    expect(ws2.framesOf("hello")[0]).toMatchObject({ tabId: TAB_ID });
  });

  it("welcome の heartbeatMs を使う", () => {
    const h = setup();
    h.relay.start();
    const ws = lastSocket();
    ws.accept();
    welcome(ws, { heartbeatMs: 5_000 });
    expect(h.relay.getStatus().heartbeatMs).toBe(5_000);
    vi.advanceTimersByTime(5_000);
    expect(ws.pings()).toBe(1);
  });

  it("welcome が来なければ閉じて再接続する", () => {
    const h = setup();
    h.relay.start();
    const ws = lastSocket();
    ws.accept();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    ws.receive("pong");
    vi.advanceTimersByTime(HEARTBEAT_MS - 1);
    expect(ws.clientClose).toBeNull();
    vi.advanceTimersByTime(1);
    expect(ws.clientClose?.code).toBe(4002);
    expect(h.relay.getStatus().state).toBe("reconnecting");
  });

  it("バックオフは伸びて上限で頭打ちになり、welcome でリセット、online で即再接続する", () => {
    const h = setup();
    h.relay.start();
    const expected = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const delay of expected) {
      const count = FakeWebSocket.instances.length;
      lastSocket().serverClose(1006);
      expect(h.relay.getStatus()).toMatchObject({ state: "reconnecting", nextRetryMs: delay, lastCloseCode: 1006 });
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(count + 1);
    }

    const ws = lastSocket();
    ws.accept();
    welcome(ws);
    expect(h.relay.getStatus().attempt).toBe(0);
    ws.serverClose(1006);
    expect(h.relay.getStatus().nextRetryMs).toBe(500);

    const count = FakeWebSocket.instances.length;
    h.win.dispatchEvent(new Event("online"));
    expect(FakeWebSocket.instances).toHaveLength(count + 1);
    expect(h.relay.getStatus().state).toBe("connecting");
    // 待っていた再接続のタイマーは消え、接続待ちのタイマーだけが残る
    expect(vi.getTimerCount()).toBe(1);
  });

  it("pageshow と visibilitychange(visible) でも閉じていれば即再接続し、接続中は何もしない", () => {
    const h = setup();
    const ws = open(h);
    ws.serverClose(1006);
    h.win.dispatchEvent(new Event("pageshow"));
    expect(FakeWebSocket.instances).toHaveLength(2);

    lastSocket().serverClose(1006);
    h.doc.visibilityState = "hidden";
    h.doc.dispatchEvent(new Event("visibilitychange"));
    expect(FakeWebSocket.instances).toHaveLength(2);
    h.doc.visibilityState = "visible";
    h.doc.dispatchEvent(new Event("visibilitychange"));
    expect(FakeWebSocket.instances).toHaveLength(3);

    h.win.dispatchEvent(new Event("online"));
    h.win.dispatchEvent(new Event("pageshow"));
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("close 1008 では再接続せず protocol_mismatch を通知する", () => {
    const states: string[] = [];
    const h = setup({ onStatus: (s) => states.push(s.state) });
    h.relay.start();
    const ws = lastSocket();
    ws.accept();
    ws.serverClose(1008);
    expect(h.relay.getStatus()).toMatchObject({ state: "protocol_mismatch", lastCloseCode: 1008 });
    expect(states.at(-1)).toBe("protocol_mismatch");

    vi.advanceTimersByTime(BACKOFF_MAX_MS * 4);
    h.win.dispatchEvent(new Event("online"));
    h.win.dispatchEvent(new Event("pageshow"));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Hub の PROTOCOL_MISMATCH フレームでも再接続しない", () => {
    const h = setup();
    h.relay.start();
    const ws = lastSocket();
    ws.accept();
    ws.receive({ type: "error", code: RelayErrorCode.PROTOCOL_MISMATCH, message: "再読み込みしてください" });
    expect(h.relay.getStatus().state).toBe("protocol_mismatch");
    expect(ws.clientClose).not.toBeNull();
    ws.serverClose(1008);
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("stop() の後はタイマーが残らず、イベントでも再接続しない", () => {
    const h = setup();
    const ws = open(h);
    ws.receive({
      type: "import.chunk",
      importId: "imp-stop",
      seq: 0,
      data: btoa("abc"),
      last: false,
      fileName: "a.xlsx",
      contentType: "application/octet-stream",
      totalBytes: 6,
    });
    // 心拍と取り込みの待ち
    expect(vi.getTimerCount()).toBe(2);
    ws.serverClose(1006);
    // 再接続の待ちと取り込みの待ち
    expect(vi.getTimerCount()).toBe(2);

    h.relay.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.relay.getStatus().state).toBe("closed");

    h.win.dispatchEvent(new Event("online"));
    h.doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(BACKOFF_MAX_MS * 2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("接続中に stop() すると 1000 で閉じ、タイマーが残らない", () => {
    const h = setup();
    const ws = open(h);
    h.relay.stop();
    expect(ws.clientClose?.code).toBe(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("import.chunk", () => {
  it("組み立てたファイルを onImport に渡す", async () => {
    vi.useRealTimers();
    const got = deferred<ImportedFile>();
    const h = setup({ onImport: (f) => got.resolve(f) });
    const ws = open(h);
    const data = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xfa, 0xfb, 0xfc]);
    ws.receive({
      type: "import.chunk",
      importId: "imp-1",
      seq: 0,
      data: btoa(String.fromCharCode(...data)),
      last: true,
      fileName: "spec.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      totalBytes: data.byteLength,
    });
    const file = await got.promise;
    expect(file).toMatchObject({ importId: "imp-1", fileName: "spec.xlsx" });
    expect(Array.from(file.bytes)).toEqual(Array.from(data));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    expect(file.sha256).toBe(Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join(""));
  });
});
