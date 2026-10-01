// mxrelay.v1 のタブ側クライアント（作業タブ ⇔ 橋渡しの Hub）。
// Hub の実装（src/bridge/hub.ts・frames.ts）に合わせてある:
// - 心拍は文字列 "ping" を送り、"pong" を受ける（JSON ではない）。
// - protocol が合わない hello には ErrorFrameMsg（code:PROTOCOL_MISMATCH）を送ったうえで 1008 で閉じてくる。
// - ブラウザ以外（Node の試験など）でも型検査が通るように、DOM の型（document・location）には頼らない。
// - tool.chunk の data は結果 JSON 文字列の断片。Hub は seq 順に連結し、last で JSON.parse する。
// - 同じ tabId の新しい hello が来ると、Hub は古い接続を 4000 で閉じる。
// 引数・結果・ファイルの中身は console に出さない。受信は型を検査してから使い、不正なものは黙って無視する。

import {
  RELAY_LIMITS,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  RELAY_TIMEOUTS,
  RelayErrorCode,
  relayErrorMessage,
} from "../../shared/protocol";
import type {
  AckMsg,
  ChunkMsg,
  ErrorFrameMsg,
  ErrorMsg,
  FocusMsg,
  HelloMsg,
  InvokeMsg,
  ProgressMsg,
  SheetOpsMsg,
  TabRole,
  ToolResultPayload,
} from "../../shared/protocol";
import type { ToolName } from "../../shared/toolDefs";
import { ImportAssembler, parseImportChunk } from "./imports";
import type { ClearTimeoutFn, ImportErrorReason, ImportedFile, SetTimeoutFn, TimerHandle } from "./imports";

export type { ClearTimeoutFn, SetTimeoutFn, TimerHandle } from "./imports";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** 橋渡しがタブの WebSocket を受け付けるパス（src/bridge/server.ts） */
export const RELAY_WS_PATH = "/ws";

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 30_000;
/** 待ち時間を最大でこの割合だけ短くする（同時に切れた多数のタブが一斉に再接続しないように） */
export const BACKOFF_JITTER = 0.3;

/** 完了した呼び出しの結果を idempotencyKey で覚えておく時間と件数 */
export const IDEMPOTENCY_TTL_MS = 60_000;
export const IDEMPOTENCY_MAX_ENTRIES = 200;
/** 覚えておく結果の合計の上限（結果は 1 件最大 8MB あるので、件数だけだとメモリを使いすぎる） */
export const IDEMPOTENCY_MAX_BYTES = 32 * 1024 * 1024;

/** tool.progress を送る最短の間隔（同じ呼び出しについて） */
export const PROGRESS_INTERVAL_MS = 250;
/** tool.error の message の上限（スタックは送らない） */
export const MAX_ERROR_MESSAGE_CHARS = 2_000;
/** Hub の messages.ts は 4,000 字で切る */
const MAX_PROGRESS_MESSAGE_CHARS = 4_000;

/** attachment.ts の MAX_TAB_ID_LENGTH（isValidTabId は 1〜128 文字） */
const MAX_TAB_ID_LENGTH = 128;
/** Hub（src/bridge/hub.ts）の CLOSE_PROTOCOL_MISMATCH */
const CLOSE_PROTOCOL_MISMATCH = 1008;
const CLOSE_NORMAL = 1000;
const CLOSE_HEARTBEAT_TIMEOUT = 4001;
const CLOSE_HANDSHAKE_TIMEOUT = 4002;
/** 心拍（Hub は "ping" に "pong" を返す） */
const PING = "ping";
const PONG = "pong";
const WS_OPEN = 1;
/** 心拍の間隔の下限（Hub の値が壊れていても送りすぎないように） */
const MIN_HEARTBEAT_MS = 1_000;

// LLM が読む文なので英語だけにする（src/shared/i18n.ts）
const DEADLINE_NOT_STARTED_MESSAGE =
  "The request reached the work screen after its deadline, so it was not run (nothing was changed). Run it again.";
const UNSUPPORTED_TOOL_MESSAGE = "The work screen does not support this tool. Reload the work screen and run it again.";
const BAD_RESULT_MESSAGE = "The work screen tool did not return a result.";
const UNSERIALIZABLE_RESULT_MESSAGE = "The work screen tool's result could not be converted to JSON.";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** WebSocket のうち使う部分だけ（試験で偽物を渡せるように） */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = new (url: string, protocols?: string | string[]) => WebSocketLike;

export interface RelayEventSource {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface RelayDocument extends RelayEventSource {
  readonly visibilityState?: string;
  hasFocus?(): boolean;
}

export interface ToolContext {
  /** Hub から tool.cancel が届くと abort される */
  signal: AbortSignal;
  /**
   * 進捗を Hub へ送る（250ms に 1 回程度に間引く。間引いた値は送らない）。
   * 同じ呼び出しの中で値は増やすこと。増えない値は送らない（MCP の notifications/progress は
   * 増える値しか送れないため、Worker 側でも捨てられる。段階ごとに 0 から数え直さない）。
   */
  progress(progress: number, total?: number, message?: string): void;
}

export interface ToolOutcome {
  result: ToolResultPayload;
  revision: number;
}

export type ToolHandler = (invoke: InvokeMsg, ctx: ToolContext) => Promise<ToolOutcome>;

/** ハンドラがこれを投げると、code・message・retryable をそのまま tool.error にする */
export class RelayToolError extends Error {
  readonly code: RelayErrorCode;
  readonly retryable: boolean | undefined;

  constructor(code: RelayErrorCode, message: string, retryable?: boolean) {
    super(message);
    this.name = "RelayToolError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type RelayState = "connecting" | "open" | "reconnecting" | "closed" | "protocol_mismatch";

export interface RelayStatus {
  state: RelayState;
  tabId: string;
  /** welcome を受けるまでと切断中は null */
  role: TabRole | null;
  primaryTabId: string | null;
  heartbeatMs: number;
  /** 連続した再接続の回数（welcome で 0 に戻る） */
  attempt: number;
  /** state が reconnecting のときの待ち時間 */
  nextRetryMs: number | null;
  lastCloseCode: number | null;
}

export interface RelaySocketOptions {
  /** 既定は relayUrl(location) */
  url?: string;
  appVersion: string;
  /** タブが実行できるツール名 */
  tools: string[];
  getRevision(): number;
  getWorkspace(): string | null;
  handler: ToolHandler;
  onImport?(file: ImportedFile): void;
  onImportError?(importId: string, reason: ImportErrorReason): void;
  /** Phase 3 のミラー用。受け取ったものを渡すだけ */
  onSheetOps?(msg: SheetOpsMsg): void;
  onStatus?(status: RelayStatus): void;
  /** 既定は pageTabId()（試験用に差し替えられる） */
  tabId?: string;
  /** 既定は globalThis.WebSocket */
  WebSocketImpl?: WebSocketFactory;
  now?(): number;
  setTimeout?: SetTimeoutFn;
  clearTimeout?: ClearTimeoutFn;
  random?(): number;
  /** focus・pageshow・online を受ける。既定は globalThis。null なら受けない */
  window?: RelayEventSource | null;
  /** visibilitychange と hasFocus()。既定は globalThis.document。null なら受けない */
  document?: RelayDocument | null;
}

type ExecOutcome =
  | { kind: "result"; json: string; bytes: number; revision: number }
  | { kind: "error"; code: RelayErrorCode; message: string; retryable?: boolean };

/** ハンドラの 1 回の実行。同じ idempotencyKey の呼び出しはこれを共有する */
interface Execution {
  key: string | null;
  controller: AbortController;
  /** 結果を待っている呼び出し ID（cancel されたものは外す） */
  waiterIds: Set<string>;
  done: boolean;
  outcome: ExecOutcome | null;
  completedAt: number | null;
  cachedBytes: number;
  lastProgressAt: number | null;
  /** 直前に送った progress（増えない値は送らない） */
  lastProgressValue: number | null;
}

interface Waiter {
  ws: WebSocketLike;
  exec: Execution;
}

type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 補助関数（公開）
// ---------------------------------------------------------------------------

/** https → wss、http → ws にして `${host}/ws` を作る */
export function relayUrl(location: { protocol: string; host: string }): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${RELAY_WS_PATH}`;
}

let pageTabIdValue: string | null = null;

/**
 * このページ読み込みのタブ ID。モジュール変数に 1 回だけ作り、再接続でも同じものを使う。
 * sessionStorage には保存しない: タブを複製すると sessionStorage も複製されて同じ tabId が 2 つでき、
 * Hub は同じ tabId の新しい hello で古い接続を 4000 で閉じる（src/bridge/hub.ts）ため、2 つのタブが互いを追い出し続ける。
 */
export function pageTabId(): string {
  pageTabIdValue ??= newTabId();
  return pageTabIdValue;
}

/** Hub の isValidTabId（1〜128 文字）に合う ID を作る */
export function newTabId(): string {
  const c = relayGlobals().crypto;
  if (!c) throw new Error("crypto がありません");
  if (c && typeof c.randomUUID === "function") return `tab-${c.randomUUID()}`;
  // randomUUID は安全なオリジンでしか使えないので、無ければ getRandomValues で作る
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `tab-${hex}`;
}

/** attempt 回目（0 始まり）の再接続の待ち時間 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(Math.max(0, attempt), 30));
  let r = random();
  if (!Number.isFinite(r)) r = 0;
  r = Math.min(1, Math.max(0, r));
  return Math.round(raw * (1 - BACKOFF_JITTER * r));
}

/** 文字列を UTF-8 にしたときのバイト数（孤立したサロゲートは TextEncoder と同じく 3 バイト） */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else {
        n += 3;
      }
    } else {
      n += 3;
    }
  }
  return n;
}

/**
 * 結果 JSON を tool.chunk のフレーム（メッセージ全体の JSON 文字列）に分ける。
 * 各フレームの UTF-8 バイト数が maxFrameBytes 以下になるように、data を JSON 文字列として
 * エスケープした後の大きさで数え、サロゲートペアの途中では切らない。最後のフレームだけ last:true と revision を持つ。
 * 1 文字も入らないほど maxFrameBytes が小さければ null。
 */
export function buildChunkFrames(
  id: string,
  json: string,
  revision: number,
  maxFrameBytes: number = RELAY_LIMITS.maxFrameBytes,
): string[] | null {
  // data 以外の部分の大きさ。seq は最大桁、last は長い方の false、revision ありで上から見積もる
  const envelope: ChunkMsg = { type: "tool.chunk", id, seq: Number.MAX_SAFE_INTEGER, data: "", last: false, revision };
  const budget = maxFrameBytes - utf8ByteLength(JSON.stringify(envelope));
  // 1 文字の最大は \u001f 形式の 6 バイト
  if (budget < 6) return null;

  const pieces: string[] = [];
  let start = 0;
  let size = 0;
  for (let i = 0; i < json.length; ) {
    const c = json.charCodeAt(i);
    let width: number;
    let units = 1;
    if (c === 0x22 || c === 0x5c) {
      width = 2; // \" と \\
    } else if (c < 0x20) {
      width = c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d ? 2 : 6;
    } else if (c < 0x80) {
      width = 1;
    } else if (c < 0x800) {
      width = 2;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const d = i + 1 < json.length ? json.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
        width = 4;
        units = 2;
      } else {
        width = 6; // 孤立したサロゲートは JSON.stringify が \udxxx にエスケープする
      }
    } else {
      width = 3;
    }
    if (size + width > budget && i > start) {
      pieces.push(json.slice(start, i));
      start = i;
      size = 0;
    }
    size += width;
    i += units;
  }
  if (start < json.length || pieces.length === 0) pieces.push(json.slice(start));

  return pieces.map((data, seq) => {
    const last = seq === pieces.length - 1;
    const frame: ChunkMsg = { type: "tool.chunk", id, seq, data, last };
    if (last) frame.revision = revision;
    return JSON.stringify(frame);
  });
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export class RelaySocket {
  readonly tabId: string;

  private readonly url: string;
  private readonly appVersion: string;
  private readonly tools: string[];
  private readonly toolSet: Set<string>;
  private readonly getRevisionFn: () => number;
  private readonly getWorkspaceFn: () => string | null;
  private readonly handler: ToolHandler;
  private readonly onSheetOps: ((msg: SheetOpsMsg) => void) | undefined;
  private readonly onStatus: ((status: RelayStatus) => void) | undefined;
  private readonly WebSocketImpl: WebSocketFactory | undefined;
  private readonly now: () => number;
  private readonly setTimer: SetTimeoutFn;
  private readonly clearTimer: ClearTimeoutFn;
  private readonly random: () => number;
  private readonly win: RelayEventSource | null;
  private readonly doc: RelayDocument | null;
  private readonly imports: ImportAssembler;

  private started = false;
  private mismatch = false;
  private ws: WebSocketLike | null = null;
  private helloSent = false;
  private welcomed = false;
  private attempt = 0;
  private heartbeatMs: number = RELAY_TIMEOUTS.heartbeatMs;
  private lastRecvAt = 0;
  private pingSentAt: number | null = null;
  private reconnectTimer: TimerHandle | undefined;
  private heartbeatTimer: TimerHandle | undefined;
  private handshakeTimer: TimerHandle | undefined;

  /** idempotencyKey → 実行（挿入順を LRU の順として使う） */
  private readonly executions = new Map<string, Execution>();
  /** 呼び出し ID → 結果を待つ呼び出し */
  private readonly waiters = new Map<string, Waiter>();
  private cachedBytes = 0;

  private status: RelayStatus;

  private readonly onPageShow = (): void => this.reconnectNow();
  private readonly onOnline = (): void => this.reconnectNow();
  private readonly onWindowFocus = (): void => this.notifyFocus();
  private readonly onVisibilityChange = (): void => {
    if (this.doc?.visibilityState !== "visible") return;
    this.reconnectNow();
    this.notifyFocus();
  };

  constructor(opts: RelaySocketOptions) {
    const tabId = opts.tabId ?? pageTabId();
    if (tabId.length === 0 || tabId.length > MAX_TAB_ID_LENGTH) throw new TypeError("tabId は 1〜128 文字にしてください");
    this.tabId = tabId;

    const globals = relayGlobals();
    if (opts.url !== undefined) {
      this.url = opts.url;
    } else if (globals.location) {
      this.url = relayUrl(globals.location);
    } else {
      throw new TypeError("url を指定してください");
    }

    this.appVersion = opts.appVersion;
    this.tools = [...opts.tools];
    this.toolSet = new Set(opts.tools);
    this.getRevisionFn = opts.getRevision;
    this.getWorkspaceFn = opts.getWorkspace;
    this.handler = opts.handler;
    this.onSheetOps = opts.onSheetOps;
    this.onStatus = opts.onStatus;
    this.WebSocketImpl =
      opts.WebSocketImpl ?? (typeof globals.WebSocket === "function" ? (globals.WebSocket as unknown as WebSocketFactory) : undefined);
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer = opts.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
    this.random = opts.random ?? Math.random;
    this.win = opts.window !== undefined ? opts.window : defaultWindow();
    this.doc = opts.document !== undefined ? opts.document : defaultDocument();
    this.imports = new ImportAssembler({
      onImport: opts.onImport,
      onImportError: opts.onImportError,
      setTimeout: this.setTimer,
      clearTimeout: this.clearTimer,
    });
    this.status = {
      state: "closed",
      tabId,
      role: null,
      primaryTabId: null,
      heartbeatMs: this.heartbeatMs,
      attempt: 0,
      nextRetryMs: null,
      lastCloseCode: null,
    };
  }

  // -------------------------------------------------------------------------
  // 公開メソッド
  // -------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    this.mismatch = false;
    this.attempt = 0;
    this.listen(true);
    this.connect();
  }

  /** 接続を閉じ、再接続もしない。タイマーとイベントの購読をすべて外す（実行中のハンドラは止めない） */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.listen(false);
    this.cancelReconnect();
    this.dropSocket(CLOSE_NORMAL, "stopped");
    this.imports.dispose();
    this.updateStatus({ state: "closed", role: null, attempt: 0, nextRetryMs: null });
  }

  /** tab.focus を送る（hello 済みの接続があるときだけ） */
  notifyFocus(): void {
    const ws = this.ws;
    if (!ws || !this.helloSent) return;
    const msg: FocusMsg = { type: "tab.focus", tabId: this.tabId };
    this.sendJson(ws, msg);
  }

  getStatus(): RelayStatus {
    return { ...this.status };
  }

  // -------------------------------------------------------------------------
  // 接続
  // -------------------------------------------------------------------------

  private connect(): void {
    this.cancelReconnect();
    if (!this.started || this.mismatch || this.ws) return;

    let ws: WebSocketLike;
    try {
      const Impl = this.WebSocketImpl;
      if (!Impl) throw new Error("WebSocket がありません");
      ws = new Impl(this.url, RELAY_SUBPROTOCOL);
    } catch {
      this.scheduleReconnect(null);
      return;
    }
    this.ws = ws;
    this.helloSent = false;
    this.welcomed = false;
    this.pingSentAt = null;
    ws.onopen = () => this.handleOpen(ws);
    ws.onmessage = (ev) => this.handleMessage(ws, ev);
    ws.onclose = (ev) => this.handleClose(ws, ev);
    // error の後には必ず close が届くので、決着は close でつける
    ws.onerror = () => undefined;
    // 接続も welcome も来ないまま固まらないようにする
    this.handshakeTimer = this.setTimer(() => this.handleHandshakeTimeout(ws), RELAY_TIMEOUTS.heartbeatMs * 2);
    this.updateStatus({ state: "connecting", nextRetryMs: null });
  }

  private handleOpen(ws: WebSocketLike): void {
    if (ws !== this.ws) return;
    this.lastRecvAt = this.now();
    const hello: HelloMsg = {
      type: "hello",
      tabId: this.tabId,
      protocol: RELAY_PROTOCOL_VERSION,
      appVersion: this.appVersion,
      tools: this.tools,
      revision: this.currentRevision(),
      workspace: this.currentWorkspace(),
      focused: this.hasFocus(),
    };
    this.sendJson(ws, hello);
    this.helloSent = true;
    this.scheduleHeartbeat(ws);
  }

  private handleClose(ws: WebSocketLike, ev: { code: number } | undefined): void {
    if (ws !== this.ws) return;
    this.detach();
    if (!this.started) return;
    const code = typeof ev?.code === "number" ? ev.code : null;
    if (code === CLOSE_PROTOCOL_MISMATCH || this.mismatch) {
      this.enterMismatch(code);
      return;
    }
    this.scheduleReconnect(code);
  }

  private handleHandshakeTimeout(ws: WebSocketLike): void {
    this.handshakeTimer = undefined;
    if (ws !== this.ws || this.welcomed) return;
    this.dropSocket(CLOSE_HANDSHAKE_TIMEOUT, "handshake timeout");
    this.scheduleReconnect(null);
  }

  /** 再読み込みが必要な状態にする。以後は再接続しない */
  private enterMismatch(code: number | null): void {
    this.mismatch = true;
    this.cancelReconnect();
    this.dropSocket(CLOSE_NORMAL, "protocol mismatch");
    this.updateStatus({ state: "protocol_mismatch", role: null, nextRetryMs: null, lastCloseCode: code });
  }

  private scheduleReconnect(code: number | null): void {
    if (!this.started || this.mismatch) return;
    this.cancelReconnect();
    const delay = backoffDelay(this.attempt, this.random);
    this.attempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.updateStatus({ state: "reconnecting", role: null, attempt: this.attempt, nextRetryMs: delay, lastCloseCode: code });
  }

  /** pageshow・online・visibilitychange(visible) で、閉じていれば待たずに再接続する */
  private reconnectNow(): void {
    if (!this.started || this.mismatch || this.ws) return;
    this.connect();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer === undefined) return;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  /** 今のソケットを切り離して閉じる（close イベントは待たない） */
  private dropSocket(code: number, reason: string): void {
    const ws = this.ws;
    if (!ws) return;
    this.detach();
    try {
      ws.close(code, reason);
    } catch {
      // 既に閉じている
    }
  }

  private detach(): void {
    const ws = this.ws;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
    }
    this.ws = null;
    this.helloSent = false;
    this.welcomed = false;
    this.pingSentAt = null;
    if (this.heartbeatTimer !== undefined) this.clearTimer(this.heartbeatTimer);
    if (this.handshakeTimer !== undefined) this.clearTimer(this.handshakeTimer);
    this.heartbeatTimer = undefined;
    this.handshakeTimer = undefined;
  }

  // -------------------------------------------------------------------------
  // 心拍
  // -------------------------------------------------------------------------

  private scheduleHeartbeat(ws: WebSocketLike): void {
    if (this.heartbeatTimer !== undefined) this.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = this.setTimer(() => this.heartbeatTick(ws), this.heartbeatMs);
  }

  /**
   * 送った ping の後に何も受け取らず、最後の受信から heartbeatMs×2 を過ぎていたら切れたとみなす。
   * 「ping を送った後に」を条件にするのは、裏に回ったタブではタイマーが 1 分単位に間引かれ、
   * ping 自体が遅れて最後の受信が古く見えるだけの状態を切断と取り違えないため。
   */
  private heartbeatTick(ws: WebSocketLike): void {
    this.heartbeatTimer = undefined;
    if (ws !== this.ws) return;
    const now = this.now();
    if (this.pingSentAt !== null && this.lastRecvAt < this.pingSentAt && now - this.lastRecvAt >= this.heartbeatMs * 2) {
      this.dropSocket(CLOSE_HEARTBEAT_TIMEOUT, "heartbeat timeout");
      this.scheduleReconnect(null);
      return;
    }
    if (this.sendRaw(ws, PING)) this.pingSentAt = now;
    this.scheduleHeartbeat(ws);
  }

  // -------------------------------------------------------------------------
  // 受信
  // -------------------------------------------------------------------------

  private handleMessage(ws: WebSocketLike, ev: { data: unknown } | undefined): void {
    if (ws !== this.ws) return;
    this.lastRecvAt = this.now();
    const data = ev?.data;
    if (typeof data !== "string" || data === PONG) return;
    let v: unknown;
    try {
      v = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObj(v) || typeof v.type !== "string") return;
    try {
      this.dispatch(ws, v);
    } catch {
      // 1 通の処理の失敗で接続を止めない
    }
  }

  private dispatch(ws: WebSocketLike, v: Obj): void {
    switch (v.type) {
      case "welcome": {
        const role = v.role === "primary" || v.role === "mirror" ? v.role : null;
        if (role === null || !isNullableString(v.primaryTabId)) return;
        this.welcomed = true;
        if (this.handshakeTimer !== undefined) this.clearTimer(this.handshakeTimer);
        this.handshakeTimer = undefined;
        this.attempt = 0;
        const hb = finite(v.heartbeatMs) && v.heartbeatMs > 0 ? Math.max(MIN_HEARTBEAT_MS, v.heartbeatMs) : RELAY_TIMEOUTS.heartbeatMs;
        if (hb !== this.heartbeatMs) {
          this.heartbeatMs = hb;
          this.scheduleHeartbeat(ws);
        }
        this.updateStatus({ state: "open", role, primaryTabId: v.primaryTabId, heartbeatMs: hb, attempt: 0, nextRetryMs: null });
        return;
      }
      case "tab.roles": {
        if (!isNullableString(v.primaryTabId)) return;
        this.updateStatus({ primaryTabId: v.primaryTabId, role: v.primaryTabId === this.tabId ? "primary" : "mirror" });
        return;
      }
      case "tool.invoke": {
        const msg = parseInvoke(v);
        // 締切は Hub の時計の deadlineAt ではなく、受信時刻＋timeoutMs（このブラウザの時計）で判定する
        if (msg) this.handleInvoke(ws, { ...msg, deadlineAt: this.now() + msg.timeoutMs });
        return;
      }
      case "tool.cancel":
        if (typeof v.id === "string") this.handleCancel(v.id);
        return;
      case "import.chunk": {
        const msg = parseImportChunk(v);
        if (msg) this.imports.push(msg);
        return;
      }
      case "sheet.ops": {
        if (typeof v.tabId !== "string" || !finite(v.revision) || !("ops" in v)) return;
        const msg: SheetOpsMsg = { type: "sheet.ops", tabId: v.tabId, revision: v.revision, ops: v.ops };
        try {
          this.onSheetOps?.(msg);
        } catch {
          // ミラー側の失敗で接続を止めない
        }
        return;
      }
      case "error": {
        // Hub の ErrorFrameMsg。PROTOCOL_MISMATCH なら直後に 1008 で閉じられる
        const frame = parseErrorFrame(v);
        if (frame?.code === RelayErrorCode.PROTOCOL_MISMATCH) this.enterMismatch(null);
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // ツール呼び出し
  // -------------------------------------------------------------------------

  private handleInvoke(ws: WebSocketLike, msg: InvokeMsg): void {
    const ack: AckMsg = { type: "tool.ack", id: msg.id };
    this.sendJson(ws, ack);
    // 同じ呼び出し ID の再送は ack だけ返す
    if (this.waiters.has(msg.id)) return;

    const key = msg.idempotencyKey.length > 0 ? msg.idempotencyKey : null;
    if (key !== null) {
      // 締切の判定より先に見る: 同じキーで既に反映した書き込みに「未反映」の DEADLINE を返さないため
      this.pruneExecutions();
      const existing = this.executions.get(key);
      if (existing) {
        if (existing.outcome) {
          // 完了済み: 再実行せずに保存した結果を返す（書き込みの二重適用を防ぐ）
          this.executions.delete(key);
          this.executions.set(key, existing);
          this.sendOutcome(ws, msg.id, existing.outcome);
        } else {
          // 実行中: 同じ実行の結果を新しい ID でも返す
          this.waiters.set(msg.id, { ws, exec: existing });
          existing.waiterIds.add(msg.id);
        }
        return;
      }
    }

    // 締切を過ぎていればハンドラを呼ばない（書き込みも始めないので未反映が保証される）
    if (this.now() >= msg.deadlineAt) {
      this.sendOutcome(ws, msg.id, {
        kind: "error",
        code: RelayErrorCode.DEADLINE,
        message: DEADLINE_NOT_STARTED_MESSAGE,
        retryable: false,
      });
      return;
    }
    if (!this.toolSet.has(msg.tool)) {
      this.sendOutcome(ws, msg.id, { kind: "error", code: RelayErrorCode.TOOL_ERROR, message: UNSUPPORTED_TOOL_MESSAGE, retryable: false });
      return;
    }

    const exec: Execution = {
      key,
      controller: new AbortController(),
      waiterIds: new Set([msg.id]),
      done: false,
      outcome: null,
      completedAt: null,
      cachedBytes: 0,
      lastProgressAt: null,
      lastProgressValue: null,
    };
    if (key !== null) this.executions.set(key, exec);
    this.waiters.set(msg.id, { ws, exec });

    const ctx: ToolContext = {
      signal: exec.controller.signal,
      progress: (progress, total, message) => this.sendProgress(exec, progress, total, message),
    };
    let running: Promise<ToolOutcome>;
    try {
      running = Promise.resolve(this.handler(msg, ctx));
    } catch (err) {
      running = Promise.reject(err);
    }
    running
      .then(
        (out) => this.toResultOutcome(out),
        (err: unknown) => toErrorOutcome(err),
      )
      .then((outcome) => this.complete(exec, outcome))
      .catch(() => undefined);
  }

  private handleCancel(id: string): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    const exec = waiter.exec;
    exec.waiterIds.delete(id);
    // 同じ実行を待つ呼び出しが残っていれば止めない
    if (!exec.done && exec.waiterIds.size === 0) exec.controller.abort();
  }

  private complete(exec: Execution, outcome: ExecOutcome): void {
    exec.done = true;
    if (exec.key !== null && this.executions.get(exec.key) === exec) {
      if (exec.controller.signal.aborted && outcome.kind === "error") {
        // キャンセルで失敗した実行は覚えない（同じキーの再試行で実行し直せるように）
        this.executions.delete(exec.key);
      } else {
        exec.outcome = outcome;
        exec.completedAt = this.now();
        exec.cachedBytes = outcome.kind === "result" ? outcome.bytes : 0;
        this.cachedBytes += exec.cachedBytes;
        this.executions.delete(exec.key);
        this.executions.set(exec.key, exec);
        this.pruneExecutions();
      }
    }
    const ids = [...exec.waiterIds];
    exec.waiterIds.clear();
    for (const id of ids) {
      const waiter = this.waiters.get(id);
      if (!waiter || waiter.exec !== exec) continue;
      this.waiters.delete(id);
      this.sendOutcome(waiter.ws, id, outcome);
    }
  }

  /** 期限切れの結果を捨て、件数と合計サイズの上限を超えた分を古い順に捨てる（実行中のものは残す） */
  private pruneExecutions(): void {
    const now = this.now();
    let completed = 0;
    for (const [key, exec] of this.executions) {
      if (exec.completedAt === null) continue;
      if (now - exec.completedAt > IDEMPOTENCY_TTL_MS) {
        this.dropExecution(key, exec);
      } else {
        completed += 1;
      }
    }
    for (const [key, exec] of this.executions) {
      if (completed <= IDEMPOTENCY_MAX_ENTRIES && this.cachedBytes <= IDEMPOTENCY_MAX_BYTES) break;
      if (exec.completedAt === null) continue;
      this.dropExecution(key, exec);
      completed -= 1;
    }
  }

  private dropExecution(key: string, exec: Execution): void {
    this.executions.delete(key);
    this.cachedBytes -= exec.cachedBytes;
    exec.cachedBytes = 0;
  }

  private toResultOutcome(out: unknown): ExecOutcome {
    if (!isObj(out) || !isObj(out.result)) {
      return { kind: "error", code: RelayErrorCode.TOOL_ERROR, message: BAD_RESULT_MESSAGE };
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(out.result);
    } catch {
      json = undefined;
    }
    if (typeof json !== "string") {
      return { kind: "error", code: RelayErrorCode.TOOL_ERROR, message: UNSERIALIZABLE_RESULT_MESSAGE };
    }
    const bytes = utf8ByteLength(json);
    if (bytes > RELAY_LIMITS.maxResultBytes) {
      return { kind: "error", code: RelayErrorCode.TOO_LARGE, message: relayErrorMessage(RelayErrorCode.TOO_LARGE, ""), retryable: false };
    }
    const revision = finite(out.revision) ? out.revision : this.currentRevision();
    return { kind: "result", json, bytes, revision };
  }

  private sendOutcome(ws: WebSocketLike, id: string, outcome: ExecOutcome): void {
    if (outcome.kind === "error") {
      const msg: ErrorMsg = { type: "tool.error", id, code: outcome.code, message: outcome.message };
      if (outcome.retryable !== undefined) msg.retryable = outcome.retryable;
      this.sendJson(ws, msg);
      return;
    }
    if (outcome.bytes <= RELAY_LIMITS.chunkThresholdBytes) {
      // 結果は JSON 文字列にしてあるので、もう一度 stringify せずに組み立てる
      this.sendRaw(ws, `{"type":"tool.result","id":${JSON.stringify(id)},"result":${outcome.json},"revision":${outcome.revision}}`);
      return;
    }
    const frames = buildChunkFrames(id, outcome.json, outcome.revision);
    if (!frames) {
      this.sendOutcome(ws, id, { kind: "error", code: RelayErrorCode.TOO_LARGE, message: relayErrorMessage(RelayErrorCode.TOO_LARGE, ""), retryable: false });
      return;
    }
    for (const frame of frames) {
      if (!this.sendRaw(ws, frame)) return;
    }
  }

  private sendProgress(exec: Execution, progress: number, total?: number, message?: string): void {
    if (exec.done || exec.waiterIds.size === 0 || !finite(progress)) return;
    // 増えない値は下流（Hub → Worker → MCP の notifications/progress）で捨てられる。
    // ここで落として間引きの起点も動かさない（後から来た増えた値が間引かれて無応答にならないように）
    if (exec.lastProgressValue !== null && progress <= exec.lastProgressValue) return;
    const now = this.now();
    if (exec.lastProgressAt !== null && now - exec.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    exec.lastProgressAt = now;
    exec.lastProgressValue = progress;
    for (const id of exec.waiterIds) {
      const waiter = this.waiters.get(id);
      if (!waiter) continue;
      const msg: ProgressMsg = { type: "tool.progress", id, progress };
      if (finite(total)) msg.total = total;
      if (typeof message === "string") msg.message = message.slice(0, MAX_PROGRESS_MESSAGE_CHARS);
      this.sendJson(waiter.ws, msg);
    }
  }

  // -------------------------------------------------------------------------
  // 送信・補助
  // -------------------------------------------------------------------------

  /** 今のソケットが開いているときだけ送る。閉じていれば黙って捨てる（Hub が切断として決着させる） */
  private sendRaw(ws: WebSocketLike, text: string): boolean {
    if (ws !== this.ws || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  private sendJson(ws: WebSocketLike, msg: unknown): boolean {
    let text: string;
    try {
      text = JSON.stringify(msg);
    } catch {
      return false;
    }
    return this.sendRaw(ws, text);
  }

  private updateStatus(patch: Partial<RelayStatus>): void {
    const next: RelayStatus = { ...this.status, ...patch };
    const keys = Object.keys(next) as Array<keyof RelayStatus>;
    if (keys.every((k) => next[k] === this.status[k])) return;
    this.status = next;
    try {
      this.onStatus?.({ ...next });
    } catch {
      // 表示側の失敗で接続を止めない
    }
  }

  private listen(on: boolean): void {
    const method = on ? "addEventListener" : "removeEventListener";
    try {
      this.win?.[method]("pageshow", this.onPageShow);
      this.win?.[method]("online", this.onOnline);
      this.win?.[method]("focus", this.onWindowFocus);
      this.doc?.[method]("visibilitychange", this.onVisibilityChange);
    } catch {
      // イベントを受けられない環境では何もしない
    }
  }

  private currentRevision(): number {
    try {
      const r = this.getRevisionFn();
      return finite(r) ? r : 0;
    } catch {
      return 0;
    }
  }

  private currentWorkspace(): string | null {
    try {
      const w = this.getWorkspaceFn();
      return typeof w === "string" ? w : null;
    } catch {
      return null;
    }
  }

  private hasFocus(): boolean {
    try {
      return this.doc?.hasFocus?.() === true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// 内部の補助関数
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

const RELAY_ERROR_CODES = new Set<number>(Object.values(RelayErrorCode));

function isRelayErrorCode(v: unknown): v is RelayErrorCode {
  return typeof v === "number" && RELAY_ERROR_CODES.has(v);
}

function parseInvoke(v: Obj): InvokeMsg | null {
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.tool !== "string" || !finite(v.deadlineAt) || !finite(v.timeoutMs)) return null;
  if (typeof v.idempotencyKey !== "string" || typeof v.readOnly !== "boolean") return null;
  return {
    type: "tool.invoke",
    id: v.id,
    // 実行できるかは handleInvoke で tools と照合する
    tool: v.tool as ToolName,
    args: v.args,
    deadlineAt: v.deadlineAt,
    timeoutMs: Math.max(0, v.timeoutMs),
    idempotencyKey: v.idempotencyKey,
    readOnly: v.readOnly,
  };
}

/** Hub の "error" フレーム（ErrorFrameMsg）。code が中継のエラー種別でなければ null */
function parseErrorFrame(v: Obj): ErrorFrameMsg | null {
  if (v.type !== "error" || !isRelayErrorCode(v.code)) return null;
  return { type: "error", code: v.code, message: capMessage(v.message) };
}

function toErrorOutcome(err: unknown): ExecOutcome {
  if (err instanceof RelayToolError && isRelayErrorCode(err.code)) {
    const outcome: ExecOutcome = { kind: "error", code: err.code, message: capMessage(err.message) };
    if (typeof err.retryable === "boolean") outcome.retryable = err.retryable;
    return outcome;
  }
  // 例外のメッセージだけを送る（スタックは送らない）。空なら Hub が既定の文言にする
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return { kind: "error", code: RelayErrorCode.TOOL_ERROR, message: capMessage(message) };
}

function capMessage(message: unknown): string {
  return typeof message === "string" ? message.slice(0, MAX_ERROR_MESSAGE_CHARS) : "";
}

function defaultWindow(): RelayEventSource | null {
  const g = globalThis as unknown as Partial<RelayEventSource>;
  return typeof g.addEventListener === "function" && typeof g.removeEventListener === "function" ? (g as RelayEventSource) : null;
}

/** 実行環境（ブラウザ・Workers・試験）に依存しない形で globalThis を読む。DOM の型には頼らない */
interface RelayGlobals {
  location?: { protocol: string; host: string };
  document?: RelayDocument;
  WebSocket?: unknown;
  crypto?: Crypto;
}

function relayGlobals(): RelayGlobals {
  return globalThis as unknown as RelayGlobals;
}

function defaultDocument(): RelayDocument | null {
  return relayGlobals().document ?? null;
}
