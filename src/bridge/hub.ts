// 橋渡しのローカル Hub。以前の Hub Durable Object の振る舞いを 1 プロセスに写したもの。
// - 正本はブラウザの作業タブ。ここはツール呼び出しを primary タブへ渡して結果を持ち帰るだけ。
// - 休止も attachment も無いので、台帳はメモリの Map に置く。
// - 作業データ・API キー・ヘッダは console に出さない。

import { randomUUID } from "node:crypto";
import {
  RELAY_LIMITS,
  RELAY_PROTOCOL_VERSION,
  RELAY_TIMEOUTS,
  RelayErrorCode,
  relayErrorMessage,
} from "../shared/protocol.ts";
import type {
  CancelMsg,
  ChunkMsg,
  ErrorFrameMsg,
  ErrorMsg,
  HelloMsg,
  HubInvokeRequest,
  HubInvokeResponse,
  HubRpc,
  HubStatus,
  ImportChunkMsg,
  InvokeMsg,
  InvokeProgress,
  ProgressMsg,
  ResultMsg,
  RolesMsg,
  SheetOpsMsg,
  TabRole,
  WelcomeMsg,
  WorkspaceExportMsg,
  WorkspaceReleaseMsg,
} from "../shared/protocol.ts";
import {
  MAX_APP_VERSION_LENGTH,
  MAX_WORKSPACE_LENGTH,
  capText,
  isValidTabId,
  normalizeToolResult,
  parseTabMessage,
  utf8Bytes,
} from "./frames.ts";
import { WS_OPEN } from "./wsserver.ts";
import type { BridgeSocket } from "./wsserver.ts";

type Timer = ReturnType<typeof setTimeout>;

export type InvokeProgressCallback = (progress: InvokeProgress) => unknown;

/** 接続を閉じるときのコード（作業タブの src/app/relay/socket.ts と同じ） */
export const CLOSE_PROTOCOL_MISMATCH = 1008;
export const CLOSE_SUPERSEDED = 4000;

/** 同時に追跡するインポートの上限 */
const MAX_IMPORT_TARGETS = 64;

/** タブが送ってくる心拍。Workers では setWebSocketAutoResponse が返していた */
const PING = "ping";
const PONG = "pong";

interface TabEntry {
  ws: BridgeSocket;
  connId: string;
  /** hello を受けるまでは null（ツール呼び出しの対象にしない） */
  tabId: string | null;
  role: TabRole;
  workspace: string | null;
  appVersion: string;
  connectedAt: number;
  lastFocusAt: number;
  closed: boolean;
  /** 作業にあるシートの数（hello・tab.state。古い画面で分からなければ null） */
  sheets: number | null;
}

interface PendingCall {
  id: string;
  req: HubInvokeRequest;
  readOnly: boolean;
  deadlineAt: number;
  connId: string;
  triedConnIds: Set<string>;
  acked: boolean;
  settled: boolean;
  chunks: string[];
  chunkBytes: number;
  chunkRevision: number | undefined;
  ackTimer: Timer | undefined;
  deadlineTimer: Timer | undefined;
  onProgress: InvokeProgressCallback | undefined;
  resolve: (res: HubInvokeResponse) => void;
}

export interface LocalHubOptions {
  /** 試験でタイムアウトを縮める（RELAY_TIMEOUT_SCALE と同じ役割） */
  timeoutScale?: number;
  /** エラー文言に載せる作業画面の URL */
  appUrl?: string;
  now?: () => number;
}

export class LocalHub implements HubRpc {
  private readonly conns = new Map<string, TabEntry>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly tabWaiters = new Set<() => void>();
  private readonly importTargets = new Map<string, string>();
  private readonly scale: number;
  private readonly now: () => number;
  private appUrlValue: string;
  private lastDisconnectAt = 0;

  constructor(opts: LocalHubOptions = {}) {
    this.scale = typeof opts.timeoutScale === "number" && opts.timeoutScale > 0 ? opts.timeoutScale : 1;
    this.appUrlValue = opts.appUrl ?? "";
    this.now = opts.now ?? (() => Date.now());
  }

  /** 起動後にポートが決まってから作業画面の URL を入れる */
  setAppUrl(url: string): void {
    this.appUrlValue = url;
  }

  /**
   * 前の primary の橋渡しにつながっていたタブが、この Hub へつなぎ直してくる見込みがある（引き継いだ直後）。
   * 直前に切断があったのと同じ扱いにして、再接続の猶予の間はツール呼び出しがタブを待つようにする。
   */
  expectReconnect(): void {
    this.lastDisconnectAt = this.now();
  }

  // -------------------------------------------------------------------------
  // 接続
  // -------------------------------------------------------------------------

  /** 握手済みの WebSocket を台帳に載せる */
  attach(ws: BridgeSocket): void {
    const entry: TabEntry = {
      ws,
      connId: ws.connId,
      tabId: null,
      role: "mirror",
      workspace: null,
      appVersion: "",
      connectedAt: this.now(),
      lastFocusAt: 0,
      closed: false,
      sheets: null,
    };
    this.conns.set(entry.connId, entry);
    ws.onmessage = (text) => this.onMessage(entry, text);
    ws.onclose = () => this.onDisconnect(entry, true);
  }

  /** 開いている接続をすべて閉じる（終了時） */
  closeAll(): void {
    for (const entry of [...this.conns.values()]) {
      try {
        entry.ws.close(1001, "bridge stopping");
      } catch {
        // 既に閉じている
      }
      this.onDisconnect(entry, false);
    }
    this.conns.clear();
  }

  private onMessage(entry: TabEntry, text: string): void {
    // 心拍は JSON ではない
    if (text === PING) {
      entry.ws.send(PONG);
      return;
    }
    const msg = parseTabMessage(text);
    if (!msg || entry.closed) return;

    switch (msg.type) {
      case "hello":
        this.onHello(entry, msg);
        return;
      case "tab.focus":
        this.onFocus(entry);
        return;
      case "tab.state":
        this.onState(entry, msg.tabId, msg.sheets);
        return;
      case "tool.ack": {
        const call = this.callFrom(entry, msg.id);
        if (call) this.markAcked(call);
        return;
      }
      case "tool.progress":
        this.onProgress(entry, msg);
        return;
      case "tool.chunk":
        this.onChunk(entry, msg);
        return;
      case "tool.result":
        this.onResult(entry, msg, text);
        return;
      case "tool.error":
        this.onToolError(entry, msg);
        return;
      case "sheet.ops":
        this.onSheetOps(entry, msg);
        return;
    }
  }

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  async invoke(req: HubInvokeRequest, onProgress?: InvokeProgressCallback): Promise<HubInvokeResponse> {
    const scale = this.scale;
    const budgetMs =
      typeof req.deadlineMs === "number" && Number.isFinite(req.deadlineMs) && req.deadlineMs > 0
        ? Math.min(req.deadlineMs, RELAY_TIMEOUTS.maxDeadlineMs)
        : RELAY_TIMEOUTS.readDeadlineMs;
    const deadlineAt = this.now() + budgetMs * scale;
    const readOnly = req.readOnly === true;

    let target = this.primaryTab();
    if (!target && this.shouldWaitForTab(scale)) {
      target = await this.waitForTab(Math.min(RELAY_TIMEOUTS.reconnectGraceMs * scale, deadlineAt - this.now()));
    }
    if (!target) return this.failure(RelayErrorCode.NO_TAB, false);
    // 再接続を待つ間に締切を過ぎたら送らない（書き込みを結果不明にしないため）
    if (this.now() >= deadlineAt) return this.failure(RelayErrorCode.DEADLINE, false);

    const first = target;
    return new Promise<HubInvokeResponse>((resolve) => {
      const call: PendingCall = {
        id: newCallId(),
        req,
        readOnly,
        deadlineAt,
        connId: first.connId,
        triedConnIds: new Set(),
        acked: false,
        settled: false,
        chunks: [],
        chunkBytes: 0,
        chunkRevision: undefined,
        ackTimer: undefined,
        deadlineTimer: undefined,
        onProgress: typeof onProgress === "function" ? onProgress : undefined,
        resolve,
      };
      this.dispatch(call, first, scale);
    });
  }

  async status(): Promise<HubStatus> {
    const primary = this.primaryTab();
    const tabs = this.tabs()
      .sort((a, b) => a.connectedAt - b.connectedAt)
      .map((t) => ({
        tabId: t.tabId as string,
        role: t.role,
        workspace: t.workspace,
        appVersion: t.appVersion,
        connectedAt: t.connectedAt,
      }));
    return { tabs, primaryTabId: primary?.tabId ?? null };
  }

  async pushImport(msg: ImportChunkMsg): Promise<{ delivered: boolean }> {
    const frame = importFrame(msg);
    if (!frame) return { delivered: false };
    const { importId } = frame;

    // 最初の断片は primary へ送り、続きは同じ接続にだけ送る（1 つのファイルを複数のタブに分けない）
    let target: TabEntry | null;
    if (frame.seq === 0) {
      target = this.primaryTab();
    } else {
      const connId = this.importTargets.get(importId);
      target = connId === undefined ? null : this.tabByConn(connId);
    }
    const text = JSON.stringify(frame);
    const delivered = target !== null && utf8Bytes(text) <= RELAY_LIMITS.maxFrameBytes && target.ws.send(text);

    this.importTargets.delete(importId);
    if (delivered && target && !frame.last) {
      this.importTargets.set(importId, target.connId);
      while (this.importTargets.size > MAX_IMPORT_TARGETS) {
        const oldest = this.importTargets.keys().next().value;
        if (oldest === undefined) break;
        this.importTargets.delete(oldest);
      }
    }
    return { delivered };
  }

  // -------------------------------------------------------------------------
  // タブからのメッセージ
  // -------------------------------------------------------------------------

  private onHello(entry: TabEntry, msg: HelloMsg): void {
    if (msg.protocol !== RELAY_PROTOCOL_VERSION) {
      const frame: ErrorFrameMsg = {
        type: "error",
        code: RelayErrorCode.PROTOCOL_MISMATCH,
        message: relayErrorMessage(RelayErrorCode.PROTOCOL_MISMATCH, this.appUrl()),
      };
      sendJson(entry.ws, frame);
      this.dropConnection(entry, CLOSE_PROTOCOL_MISMATCH, "protocol mismatch", true);
      return;
    }
    if (!isValidTabId(msg.tabId)) return;

    // 同じ tabId の古い接続（再接続前の半開きなど）は置き換える。役割とフォーカス時刻は引き継ぐ
    let inheritPrimary = entry.tabId !== null && entry.role === "primary";
    let lastFocusAt = entry.lastFocusAt;
    for (const old of this.tabs()) {
      if (old.connId === entry.connId || old.tabId !== msg.tabId) continue;
      inheritPrimary ||= old.role === "primary";
      lastFocusAt = Math.max(lastFocusAt, old.lastFocusAt);
      this.dropConnection(old, CLOSE_SUPERSEDED, "superseded", false);
    }

    const now = this.now();
    entry.tabId = msg.tabId;
    entry.appVersion = capText(msg.appVersion, MAX_APP_VERSION_LENGTH);
    entry.workspace = msg.workspace === null ? null : capText(msg.workspace, MAX_WORKSPACE_LENGTH);
    entry.lastFocusAt = msg.focused ? now : lastFocusAt;
    entry.role = inheritPrimary ? "primary" : "mirror";
    entry.sheets = msg.sheets ?? null;

    const hasOtherPrimary = this.tabs().some((t) => t.connId !== entry.connId && t.role === "primary");
    // シートの無いタブは、フォーカスがあっても、シートのある primary を奪わない
    const makePrimary = (msg.focused && this.mayTakePrimary(entry)) || inheritPrimary || !hasOtherPrimary;
    const { primary } = this.syncRoles(makePrimary ? entry.connId : undefined);

    const welcome: WelcomeMsg = {
      type: "welcome",
      role: primary?.connId === entry.connId ? "primary" : "mirror",
      primaryTabId: primary?.tabId ?? null,
      heartbeatMs: RELAY_TIMEOUTS.heartbeatMs,
      primarySheets: primary?.sheets ?? null,
    };
    sendJson(entry.ws, welcome);
    this.broadcastRoles(primary);

    for (const wake of [...this.tabWaiters]) wake();
  }

  /**
   * フォーカスでこのタブを primary にしてよいか。
   * シートの無いタブ（AI クライアントの中のブラウザで開いただけの窓など）が、作業のある primary を奪うと、
   * LLM のツールが空の作業に届いてしまう。作業を移したいときは、その窓の「この窓に移す」で移す。
   */
  private mayTakePrimary(entry: TabEntry): boolean {
    if (entry.sheets !== 0) return true;
    const current = this.tabs().find((t) => t.connId !== entry.connId && t.role === "primary");
    return !(current !== undefined && (current.sheets ?? 0) > 0);
  }

  /** タブのシートの数が変わった。作業のある窓が primary になるように揃え、ほかの窓に知らせる */
  private onState(entry: TabEntry, tabId: string, sheets: number): void {
    if (entry.tabId === null || entry.tabId !== tabId) return;
    entry.sheets = sheets;
    const current = this.tabs().find((t) => t.role === "primary");
    // primary の作業が空になり、この窓に作業があるなら、この窓を primary にする
    const takeOver = entry.role !== "primary" && sheets > 0 && current !== undefined && current.sheets === 0;
    const { primary } = this.syncRoles(takeOver ? entry.connId : undefined);
    this.broadcastRoles(primary);
  }

  /**
   * 作業を移す（target の窓が「この窓に移す」を押した）。target 以外で作業のある primary に workspace.export を送る。
   * 送った先の tabId を返す（作業のある窓が無ければ null）
   */
  requestExport(targetTabId: string, token: string): string | null {
    const primary = this.primaryTab();
    if (!primary || primary.tabId === null || primary.tabId === targetTabId || (primary.sheets ?? 0) === 0) return null;
    const msg: WorkspaceExportMsg = { type: "workspace.export", token };
    return sendJson(primary.ws, msg) ? primary.tabId : null;
  }

  /** 移し終えた。送り元の窓に作業を空にさせる */
  releaseExport(sourceTabId: string, token: string): boolean {
    const source = this.tabs().find((t) => t.tabId === sourceTabId);
    if (!source) return false;
    const msg: WorkspaceReleaseMsg = { type: "workspace.release", token };
    return sendJson(source.ws, msg);
  }

  /** いまの primary のタブ ID（試験・状態の確認用） */
  primaryTabId(): string | null {
    return this.primaryTab()?.tabId ?? null;
  }

  private onFocus(entry: TabEntry): void {
    if (entry.tabId === null) return;
    entry.lastFocusAt = this.now();
    if (!this.mayTakePrimary(entry)) return;
    const { primary } = this.syncRoles(entry.connId);
    this.broadcastRoles(primary);
  }

  private onProgress(entry: TabEntry, msg: ProgressMsg): void {
    const call = this.callFrom(entry, msg.id);
    if (!call) return;
    // progress が届いたならタブは受け取っている
    this.markAcked(call);
    if (!call.onProgress) return;
    const progress: InvokeProgress = { progress: msg.progress };
    if (msg.total !== undefined) progress.total = msg.total;
    if (msg.message !== undefined) progress.message = msg.message;
    try {
      const r = call.onProgress(progress);
      if (r && typeof (r as PromiseLike<unknown>).then === "function") {
        Promise.resolve(r).catch(() => undefined);
      }
    } catch {
      // 通知に失敗しても呼び出しは続ける
    }
  }

  private onChunk(entry: TabEntry, msg: ChunkMsg): void {
    const call = this.callFrom(entry, msg.id);
    if (!call) return;
    this.markAcked(call);
    if (msg.seq !== call.chunks.length) {
      this.settle(call, {
        ok: false,
        code: RelayErrorCode.TOOL_ERROR,
        message: "分割された結果の順序が正しくありません。もう一度実行してください。",
        retryable: call.readOnly,
      });
      return;
    }
    call.chunkBytes += utf8Bytes(msg.data);
    if (call.chunkBytes > RELAY_LIMITS.maxResultBytes) {
      this.settle(call, this.failure(RelayErrorCode.TOO_LARGE, false));
      return;
    }
    call.chunks.push(msg.data);
    if (msg.revision !== undefined) call.chunkRevision = msg.revision;
    if (!msg.last) return;

    const text = call.chunks.join("");
    call.chunks = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const result = normalizeToolResult(parsed);
    if (!result) {
      this.settle(call, {
        ok: false,
        code: RelayErrorCode.TOOL_ERROR,
        message: "作業画面から届いた結果を読み取れませんでした。もう一度実行してください。",
        retryable: call.readOnly,
      });
      return;
    }
    this.settle(call, { ok: true, result, revision: call.chunkRevision ?? 0 });
  }

  private onResult(entry: TabEntry, msg: ResultMsg, raw: string): void {
    const call = this.callFrom(entry, msg.id);
    if (!call) return;
    // 分割せずに届いた結果にも合計の上限をかける
    if (raw.length * 3 > RELAY_LIMITS.maxResultBytes && utf8Bytes(raw) > RELAY_LIMITS.maxResultBytes) {
      this.settle(call, this.failure(RelayErrorCode.TOO_LARGE, false));
      return;
    }
    const result = normalizeToolResult(msg.result);
    if (!result) {
      this.settle(call, {
        ok: false,
        code: RelayErrorCode.TOOL_ERROR,
        message: "作業画面から届いた結果の形が正しくありません。もう一度実行してください。",
        retryable: call.readOnly,
      });
      return;
    }
    this.settle(call, { ok: true, result, revision: msg.revision });
  }

  private onToolError(entry: TabEntry, msg: ErrorMsg): void {
    const call = this.callFrom(entry, msg.id);
    if (!call) return;
    this.settle(call, {
      ok: false,
      code: msg.code,
      message: msg.message || relayErrorMessage(msg.code, this.appUrl()),
      retryable: msg.retryable === true,
    });
  }

  private onSheetOps(entry: TabEntry, msg: SheetOpsMsg): void {
    if (entry.tabId === null) return;
    // 送信元は接続の台帳から決める（本文の tabId は信用しない）
    const frame: SheetOpsMsg = { type: "sheet.ops", tabId: entry.tabId, revision: msg.revision, ops: msg.ops };
    let text: string;
    try {
      text = JSON.stringify(frame);
    } catch {
      return;
    }
    for (const t of this.tabs()) {
      if (t.connId !== entry.connId) t.ws.send(text);
    }
  }

  // -------------------------------------------------------------------------
  // 呼び出しの状態遷移
  // -------------------------------------------------------------------------

  private dispatch(call: PendingCall, target: TabEntry, scale: number): void {
    call.connId = target.connId;
    call.triedConnIds.add(target.connId);
    call.acked = false;
    // 送り直しでは前の試行の断片を持ち越さない
    call.chunks = [];
    call.chunkBytes = 0;
    call.chunkRevision = undefined;
    this.pending.set(call.id, call);

    const msg: InvokeMsg = {
      type: "tool.invoke",
      id: call.id,
      tool: call.req.tool,
      args: call.req.args,
      deadlineAt: call.deadlineAt,
      timeoutMs: Math.max(0, call.deadlineAt - this.now()),
      idempotencyKey: call.req.idempotencyKey,
      readOnly: call.readOnly,
    };
    let text: string;
    try {
      text = JSON.stringify(msg);
    } catch {
      this.settle(call, this.failure(RelayErrorCode.INVALID_ARGS, false));
      return;
    }
    if (text.length * 3 > RELAY_LIMITS.maxFrameBytes && utf8Bytes(text) > RELAY_LIMITS.maxFrameBytes) {
      // 送っていないので実行されていない
      this.settle(call, {
        ok: false,
        code: RelayErrorCode.TOO_LARGE,
        message: "引数が大きすぎて作業画面へ送れません。対象を分けて、複数回に分けて実行してください。",
        retryable: false,
      });
      return;
    }
    if (!target.ws.send(text)) {
      // 送れていないので実行されていない。読み取り・書き込みとも再試行してよい
      this.settle(call, this.failure(RelayErrorCode.TAB_DISCONNECTED, true));
      return;
    }

    const remaining = Math.max(0, call.deadlineAt - this.now());
    call.deadlineTimer ??= setTimeout(() => this.onDeadline(call), remaining);
    const ackMs = RELAY_TIMEOUTS.ackMs * scale;
    if (ackMs < remaining) {
      const attemptId = call.id;
      call.ackTimer = setTimeout(() => this.onAckTimeout(call, attemptId, scale), ackMs);
    }
  }

  private markAcked(call: PendingCall): void {
    if (call.acked) return;
    call.acked = true;
    if (call.ackTimer !== undefined) {
      clearTimeout(call.ackTimer);
      call.ackTimer = undefined;
    }
  }

  private onAckTimeout(call: PendingCall, attemptId: string, scale: number): void {
    if (call.settled || call.id !== attemptId || call.acked) return;
    call.ackTimer = undefined;
    const current = this.tabByConn(call.connId);

    if (call.readOnly) {
      // 読み取りは別のタブへ 1 回だけ送り直す
      const alternate = call.triedConnIds.size === 1 ? this.pickAlternate(call.triedConnIds) : null;
      if (alternate) {
        if (current) sendJson(current.ws, cancelMsg(call.id, "superseded"));
        this.pending.delete(call.id);
        call.id = newCallId();
        this.dispatch(call, alternate, scale);
        return;
      }
      if (current) sendJson(current.ws, cancelMsg(call.id, "deadline"));
      this.settle(call, this.failure(RelayErrorCode.NO_ACK, true));
      return;
    }
    // 書き込みは cancel を送らない（タブが後から受け取って完了させうるので再試行不可）
    this.settle(call, this.failure(RelayErrorCode.NO_ACK, false));
  }

  private onDeadline(call: PendingCall): void {
    if (call.settled) return;
    call.deadlineTimer = undefined;
    if (call.readOnly) {
      const current = this.tabByConn(call.connId);
      if (current) sendJson(current.ws, cancelMsg(call.id, "deadline"));
      this.settle(call, this.failure(RelayErrorCode.DEADLINE, false));
      return;
    }
    // 書き込みは打ち切らずタブに完了させる。結果は分からない
    this.settle(call, this.failure(RelayErrorCode.UNKNOWN_OUTCOME, false));
  }

  private settle(call: PendingCall, res: HubInvokeResponse): void {
    if (call.settled) return;
    call.settled = true;
    if (call.ackTimer !== undefined) clearTimeout(call.ackTimer);
    if (call.deadlineTimer !== undefined) clearTimeout(call.deadlineTimer);
    call.ackTimer = undefined;
    call.deadlineTimer = undefined;
    call.chunks = [];
    call.onProgress = undefined;
    if (this.pending.get(call.id) === call) this.pending.delete(call.id);
    call.resolve(res);
  }

  /** 送信元の接続が担当している保留中の呼び出し */
  private callFrom(entry: TabEntry, id: string): PendingCall | undefined {
    const call = this.pending.get(id);
    if (!call || call.settled || call.connId !== entry.connId) return undefined;
    return call;
  }

  // -------------------------------------------------------------------------
  // 切断
  // -------------------------------------------------------------------------

  private onDisconnect(entry: TabEntry, promote: boolean): void {
    if (entry.closed) return;
    entry.closed = true;
    this.conns.delete(entry.connId);
    if (entry.tabId !== null) this.lastDisconnectAt = this.now();
    for (const [importId, connId] of [...this.importTargets]) {
      if (connId === entry.connId) this.importTargets.delete(importId);
    }

    for (const call of [...this.pending.values()]) {
      if (call.connId !== entry.connId) continue;
      this.settle(
        call,
        call.readOnly ? this.failure(RelayErrorCode.TAB_DISCONNECTED, true) : this.failure(RelayErrorCode.UNKNOWN_OUTCOME, false),
      );
    }

    if (promote && entry.tabId !== null && entry.role === "primary") {
      const { primary, changed } = this.syncRoles();
      if (changed) this.broadcastRoles(primary);
    }
  }

  private dropConnection(entry: TabEntry, code: number, reason: string, promote: boolean): void {
    this.onDisconnect(entry, promote);
    try {
      entry.ws.close(code, reason);
    } catch {
      // 既に閉じている
    }
  }

  // -------------------------------------------------------------------------
  // 台帳
  // -------------------------------------------------------------------------

  /** hello 済みで開いている接続 */
  private tabs(): TabEntry[] {
    const out: TabEntry[] = [];
    for (const entry of this.conns.values()) {
      if (entry.tabId === null || entry.closed || entry.ws.readyState !== WS_OPEN) continue;
      out.push(entry);
    }
    return out;
  }

  private tabByConn(connId: string): TabEntry | null {
    const entry = this.conns.get(connId);
    if (!entry || entry.tabId === null || entry.closed || entry.ws.readyState !== WS_OPEN) return null;
    return entry;
  }

  /** つないだばかりで hello 前の接続があるか（直後に hello が来る見込み） */
  private hasHandshakingSocket(graceMs: number): boolean {
    const since = this.now() - graceMs;
    for (const entry of this.conns.values()) {
      if (entry.tabId === null && !entry.closed && entry.connectedAt >= since && entry.ws.readyState === WS_OPEN) return true;
    }
    return false;
  }

  /**
   * primary を 1 つに揃える。forceConnId があればそれを primary にする。
   * 無ければ既存の primary を保ち、居なければ最後にフォーカスされたタブを昇格する。
   */
  private syncRoles(forceConnId?: string): { primary: TabEntry | null; changed: boolean } {
    const tabs = this.tabs();
    let primary = forceConnId === undefined ? undefined : tabs.find((t) => t.connId === forceConnId);
    if (!primary) {
      const flagged = tabs.filter((t) => t.role === "primary");
      // primary が居なければ、作業のある窓を先に選ぶ
      primary = flagged.length > 0 ? flagged.sort(byRecentFocus)[0] : [...tabs].sort(byWorkThenFocus)[0];
    }
    // 作業のある窓があるのに、空の窓を primary にしない（LLM のツールが空の作業に届かないように）
    if (primary !== undefined && primary.sheets === 0) {
      const working = tabs.filter((t) => (t.sheets ?? 0) > 0).sort(byRecentFocus)[0];
      if (working !== undefined) primary = working;
    }
    let changed = false;
    for (const t of tabs) {
      const role: TabRole = t === primary ? "primary" : "mirror";
      if (t.role === role) continue;
      t.role = role;
      changed = true;
    }
    return { primary: primary ?? null, changed };
  }

  private primaryTab(): TabEntry | null {
    const { primary, changed } = this.syncRoles();
    if (changed) this.broadcastRoles(primary);
    return primary;
  }

  private pickAlternate(exclude: Set<string>): TabEntry | null {
    return this.tabs().filter((t) => !exclude.has(t.connId)).sort(byRecentFocus)[0] ?? null;
  }

  private broadcastRoles(primary: TabEntry | null): void {
    const msg: RolesMsg = { type: "tab.roles", primaryTabId: primary?.tabId ?? null, primarySheets: primary?.sheets ?? null };
    const text = JSON.stringify(msg);
    for (const t of this.tabs()) t.ws.send(text);
  }

  // -------------------------------------------------------------------------
  // 再接続の猶予
  // -------------------------------------------------------------------------

  private shouldWaitForTab(scale: number): boolean {
    const graceMs = RELAY_TIMEOUTS.reconnectGraceMs * scale;
    return (this.lastDisconnectAt > 0 && this.now() - this.lastDisconnectAt <= graceMs) || this.hasHandshakingSocket(graceMs);
  }

  private waitForTab(ms: number): Promise<TabEntry | null> {
    if (ms <= 0) return Promise.resolve(this.primaryTab());
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.tabWaiters.delete(wake);
        resolve(this.primaryTab());
      };
      const timer = setTimeout(wake, ms);
      this.tabWaiters.add(wake);
    });
  }

  // -------------------------------------------------------------------------
  // 補助
  // -------------------------------------------------------------------------

  private appUrl(): string {
    return this.appUrlValue;
  }

  private failure(code: RelayErrorCode, retryable: boolean): HubInvokeResponse {
    return { ok: false, code, message: relayErrorMessage(code, this.appUrl()), retryable };
  }
}

function newCallId(): string {
  return `c_${randomUUID()}`;
}

/** 受け取った断片を契約のキーだけで作り直す（余分なキーはタブへ流さない） */
function importFrame(msg: ImportChunkMsg): ImportChunkMsg | null {
  const m = msg as unknown as Record<string, unknown> | null;
  if (!m || typeof m !== "object") return null;
  const { importId, seq, data, last, fileName, contentType, totalBytes } = m;
  if (typeof importId !== "string" || importId.length === 0) return null;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
  if (typeof data !== "string" || typeof last !== "boolean") return null;
  if (typeof fileName !== "string" || typeof contentType !== "string") return null;
  if (typeof totalBytes !== "number" || !Number.isFinite(totalBytes) || totalBytes < 0) return null;
  return { type: "import.chunk", importId, seq, data, last, fileName, contentType, totalBytes };
}

function cancelMsg(id: string, reason: CancelMsg["reason"]): CancelMsg {
  return { type: "tool.cancel", id, reason };
}

function byRecentFocus(a: TabEntry, b: TabEntry): number {
  return b.lastFocusAt - a.lastFocusAt || b.connectedAt - a.connectedAt;
}

/** 作業のある窓を先に、その中では最後にフォーカスされた順 */
function byWorkThenFocus(a: TabEntry, b: TabEntry): number {
  const work = Number((b.sheets ?? 0) > 0) - Number((a.sheets ?? 0) > 0);
  return work || byRecentFocus(a, b);
}

function sendJson(ws: BridgeSocket, msg: unknown): boolean {
  let text: string;
  try {
    text = JSON.stringify(msg);
  } catch {
    return false;
  }
  return ws.send(text);
}
