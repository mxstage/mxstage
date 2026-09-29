// 橋渡し同士の内部経路（/_mxstudio/*）。PC に橋渡しを 1 つにするために使う。
// - primary（ポートを取れた橋渡し）がサーバ側を受け持つ。
// - client（ポートが使用中で、相手が mxstudio の橋渡しだった）は RemoteHub で primary にツール呼び出しを渡す。
//
// 経路:
//   GET  /_mxstudio/health         鍵なし。{ name, version, protocol } だけ返す（鍵や PID は出さない）
//   POST /_mxstudio/invoke         鍵あり。HubInvokeRequest を受け、改行区切り JSON で進捗と結果を返す
//   GET  /_mxstudio/status         鍵あり。HubStatus
//   POST /_mxstudio/import-ticket  鍵あり。アップロード URL のチケットを primary で発行する
//   POST /_mxstudio/import-chunk   鍵あり。ImportChunkMsg を primary の Hub へ流す
//
// 作業データ・鍵は console に出さない。

import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RELAY_LIMITS, RELAY_TIMEOUTS, RelayErrorCode, relayErrorMessage } from "../shared/protocol.ts";
import type { HubInvokeRequest, HubInvokeResponse, HubRpc, HubStatus, ImportChunkMsg, InvokeProgress } from "../shared/protocol.ts";
import { TOOL_DEFS, isReadOnlyTool, runsInTab } from "../shared/toolDefs.ts";
import type { ToolName } from "../shared/toolDefs.ts";
import { BRIDGE_KEY_HEADER } from "./bridgeKey.ts";
import type { BridgeKeyStore } from "./bridgeKey.ts";
import type { ImportTicket } from "./importUpload.ts";

/** health に載せる名前（setup-local.mjs などがこれで橋渡しと見分ける） */
export const BRIDGE_NAME = "mxstudio-bridge";
/** 内部経路の取り決めの版。互換の無い変更をしたら上げる */
export const BRIDGE_PEER_PROTOCOL = 1;

export const PEER_PREFIX = "/_mxstudio/";
export const PEER_HEALTH_PATH = "/_mxstudio/health";
export const PEER_INVOKE_PATH = "/_mxstudio/invoke";
export const PEER_STATUS_PATH = "/_mxstudio/status";
export const PEER_IMPORT_TICKET_PATH = "/_mxstudio/import-ticket";
export const PEER_IMPORT_CHUNK_PATH = "/_mxstudio/import-chunk";

/** invoke の本文の上限（Hub は 1 フレーム 1MiB で断るので、それより少し大きく受けて Hub に判定させる） */
export const PEER_MAX_INVOKE_BYTES = RELAY_LIMITS.maxFrameBytes * 2;
/** import-chunk の本文の上限（断片は base64 で約 683KB） */
export const PEER_MAX_CHUNK_BYTES = RELAY_LIMITS.maxFrameBytes * 2;
/** 小さな要求（status・ticket）の本文の上限 */
const PEER_MAX_SMALL_BYTES = 16 * 1024;

export interface HealthBody {
  name: string;
  version: string;
  protocol: number;
  /**
   * 起動したあとにリポジトリのコードが変わったか（src/bridge/freshness.ts）。古い版の橋渡しは載せない。
   * client はこれで「中継している primary が古い」を知り、導入の --status も同じ値を出す。
   */
  stale?: boolean;
}

/** 発行だけできればよいチケットの窓口（primary では ImportTickets、client では primary への中継） */
export interface TicketIssuer {
  create(): ImportTicket | Promise<ImportTicket>;
}

// ---------------------------------------------------------------------------
// サーバ側（primary）
// ---------------------------------------------------------------------------

export interface PeerServerDeps {
  hub: HubRpc;
  tickets: TicketIssuer;
  /** null なら鍵付きの経路はすべて 403 */
  keyStore: BridgeKeyStore | null;
  version: string;
  /** 起動したあとにコードが変わったか。省くと health に stale を載せない */
  codeStale?: () => boolean;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text, "utf8")),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(text);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** 本文を上限付きで読む。上限を超えたら null */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const declared = Number(headerValue(req, "content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const chunk = value as Buffer;
    size += chunk.byteLength;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** 中継を受けてよい invoke 要求か。readOnly は送り手を信用せず、ツール名から決め直す */
export function parseInvokeRequest(value: unknown): HubInvokeRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.tool !== "string" || !Object.hasOwn(TOOL_DEFS, v.tool)) return null;
  const tool = v.tool as ToolName;
  if (!runsInTab(tool)) return null;
  if (typeof v.deadlineMs !== "number" || !Number.isFinite(v.deadlineMs) || v.deadlineMs <= 0) return null;
  if (typeof v.idempotencyKey !== "string" || v.idempotencyKey.length === 0 || v.idempotencyKey.length > 200) return null;
  return { tool, args: v.args, readOnly: isReadOnlyTool(tool), deadlineMs: v.deadlineMs, idempotencyKey: v.idempotencyKey };
}

function forbidden(res: ServerResponse): void {
  sendJson(res, 403, { ok: false, error: "forbidden_key", message: "橋渡しの鍵が一致しません。" });
}

/** /_mxstudio/* を処理する（入口の Host・Origin の検査は呼び出し側で済ませておく） */
export async function handlePeerRequest(req: IncomingMessage, res: ServerResponse, pathname: string, deps: PeerServerDeps): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();

  if (pathname === PEER_HEALTH_PATH) {
    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "GET だけを受け付けます。" }, { Allow: "GET, HEAD" });
      return;
    }
    const body: HealthBody = { name: BRIDGE_NAME, version: deps.version, protocol: BRIDGE_PEER_PROTOCOL };
    if (deps.codeStale !== undefined) body.stale = deps.codeStale();
    sendJson(res, 200, body);
    return;
  }

  const routes: Record<string, string> = {
    [PEER_INVOKE_PATH]: "POST",
    [PEER_STATUS_PATH]: "GET",
    [PEER_IMPORT_TICKET_PATH]: "POST",
    [PEER_IMPORT_CHUNK_PATH]: "POST",
  };
  const allowed = routes[pathname];
  if (allowed === undefined) {
    sendJson(res, 404, { ok: false, error: "not_found", message: "見つかりません。" });
    return;
  }
  // 鍵は経路とメソッドの判定より先に確かめる（鍵を持たない相手に経路の中身を教えない）
  if (!deps.keyStore || !deps.keyStore.verify(headerValue(req, BRIDGE_KEY_HEADER))) {
    forbidden(res);
    return;
  }
  if (method !== allowed) {
    sendJson(res, 405, { ok: false, error: "method_not_allowed", message: `${allowed} だけを受け付けます。` }, { Allow: allowed });
    return;
  }

  switch (pathname) {
    case PEER_STATUS_PATH: {
      const status = await deps.hub.status();
      sendJson(res, 200, { ok: true, status });
      return;
    }
    case PEER_IMPORT_TICKET_PATH: {
      if ((await readBody(req, PEER_MAX_SMALL_BYTES)) === null) {
        sendJson(res, 413, { ok: false, error: "too_large", message: "本文が大きすぎます。" });
        return;
      }
      const ticket = await deps.tickets.create();
      sendJson(res, 200, { ok: true, ticket: { importId: ticket.importId, expiresAt: ticket.expiresAt, maxBytes: ticket.maxBytes } });
      return;
    }
    case PEER_IMPORT_CHUNK_PATH: {
      const body = await readBody(req, PEER_MAX_CHUNK_BYTES);
      if (body === null) {
        sendJson(res, 413, { ok: false, error: "too_large", message: "本文が大きすぎます。" });
        return;
      }
      const msg = parseJson(body);
      if (!msg || typeof msg !== "object") {
        sendJson(res, 400, { ok: false, error: "invalid_request", message: "本文が正しくありません。" });
        return;
      }
      // 形の検査は Hub の pushImport が行う（不正なら delivered:false）
      const { delivered } = await deps.hub.pushImport(msg as ImportChunkMsg);
      sendJson(res, 200, { ok: true, delivered });
      return;
    }
    case PEER_INVOKE_PATH: {
      const body = await readBody(req, PEER_MAX_INVOKE_BYTES);
      if (body === null) {
        sendJson(res, 413, { ok: false, error: "too_large", message: "引数が大きすぎます。" });
        return;
      }
      const invoke = parseInvokeRequest(parseJson(body));
      if (!invoke) {
        sendJson(res, 400, { ok: false, error: "invalid_request", message: "ツール呼び出しの形が正しくありません。" });
        return;
      }
      await streamInvoke(res, deps.hub, invoke);
      return;
    }
  }
}

/** 進捗と結果を改行区切り JSON で流す。1 行目以降は必ず {type:"progress"} か {type:"result"} */
async function streamInvoke(res: ServerResponse, hub: HubRpc, invoke: HubInvokeRequest): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.flushHeaders();
  const writeLine = (value: unknown): void => {
    if (res.destroyed || res.writableEnded) return;
    try {
      res.write(`${JSON.stringify(value)}\n`);
    } catch {
      // 相手が去った。呼び出し自体は Hub が決着させる
    }
  };
  let response: HubInvokeResponse;
  try {
    response = await hub.invoke(invoke, (p: InvokeProgress) => {
      const line: Record<string, unknown> = { type: "progress", progress: p.progress };
      if (p.total !== undefined) line.total = p.total;
      if (p.message !== undefined) line.message = p.message;
      writeLine(line);
    });
  } catch {
    response = invoke.readOnly
      ? { ok: false, code: RelayErrorCode.TAB_DISCONNECTED, message: "", retryable: true }
      : { ok: false, code: RelayErrorCode.UNKNOWN_OUTCOME, message: "", retryable: false };
  }
  writeLine({ type: "result", response });
  if (!res.destroyed && !res.writableEnded) res.end();
}

// ---------------------------------------------------------------------------
// client 側
// ---------------------------------------------------------------------------

/** 相手に届かなかった（接続を拒まれた）。何も実行されていないので、引き継いでから送り直してよい */
export class PeerUnreachableError extends Error {
  constructor() {
    super("primary の橋渡しに接続できませんでした");
    this.name = "PeerUnreachableError";
  }
}

export type HealthProbe =
  | { kind: "bridge"; health: HealthBody }
  /** 何も待ち受けていない */
  | { kind: "down" }
  /** mxstudio の橋渡しだが、/_mxstudio/health の無い古い版 */
  | { kind: "legacy" }
  /** mxstudio 以外のアプリ（または応答しない） */
  | { kind: "other" };

interface RawReply {
  status: number;
  contentType: string;
  body: Buffer;
}

interface PeerRequestOptions {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
  maxBytes?: number;
}

function isRefused(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ECONNREFUSED";
}

/** 短い要求を 1 つ出して、本文をまとめて受け取る。接続を拒まれたら PeerUnreachableError */
function peerRequest(opts: PeerRequestOptions): Promise<RawReply> {
  const maxBytes = opts.maxBytes ?? RELAY_LIMITS.maxResultBytes * 2;
  return new Promise((done, failed) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${opts.port}`, ...opts.headers };
    if (opts.body !== undefined) headers["content-length"] = String(opts.body.byteLength);
    const req = httpRequest({ host: "127.0.0.1", port: opts.port, method: opts.method, path: opts.path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.byteLength;
        if (size > maxBytes) {
          req.destroy(new Error("応答が大きすぎます"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        clearTimeout(timer);
        const type = res.headers["content-type"];
        done({ status: res.statusCode ?? 0, contentType: typeof type === "string" ? type : "", body: Buffer.concat(chunks) });
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        failed(err);
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("応答が時間内にありませんでした")), opts.timeoutMs);
    req.on("error", (err) => {
      clearTimeout(timer);
      failed(isRefused(err) ? new PeerUnreachableError() : err);
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function isHealthBody(value: unknown): value is HealthBody {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.name === BRIDGE_NAME && typeof v.version === "string" && typeof v.protocol === "number";
}

/** そのポートで何が待ち受けているかを調べる */
export async function probeBridgeHealth(port: number, timeoutMs = 3_000): Promise<HealthProbe> {
  let reply: RawReply;
  try {
    reply = await peerRequest({ port, method: "GET", path: PEER_HEALTH_PATH, timeoutMs, maxBytes: 64 * 1024 });
  } catch (err) {
    return err instanceof PeerUnreachableError ? { kind: "down" } : { kind: "other" };
  }
  if (reply.status === 200 && reply.contentType.includes("application/json")) {
    const body = parseJson(reply.body);
    if (isHealthBody(body)) {
      // 版は相手が決める文字列。ログ（stderr）に載せるので、表示できる ASCII だけを短く残す（端末の制御文字を流さない）
      const version = body.version.replace(/[^\x20-\x7e]/g, "").slice(0, 40);
      const health: HealthBody = { name: body.name, version, protocol: body.protocol };
      if (typeof body.stale === "boolean") health.stale = body.stale;
      return { kind: "bridge", health };
    }
  }
  // 古い版の橋渡しは /ws に 426 と upgrade_required を返す（src/bridge/server.ts）
  try {
    const ws = await peerRequest({ port, method: "GET", path: "/ws", timeoutMs, maxBytes: 64 * 1024 });
    const body = parseJson(ws.body) as { error?: unknown } | undefined;
    if (ws.status === 426 && body && body.error === "upgrade_required") return { kind: "legacy" };
  } catch {
    // 見分けられなければ別のアプリとして扱う
  }
  return { kind: "other" };
}

export interface RemoteHubOptions {
  port: number;
  keyStore: BridgeKeyStore;
  /** 作業画面のオリジン（エラー文言に載せる） */
  appUrl: string;
  /** 締切に足す余裕（primary の Hub が締切で決着させるのを待つ分） */
  graceMs?: number;
  /** status・チケットなど短い要求の上限 */
  shortTimeoutMs?: number;
}

/** 呼び出しが届いたか分からない失敗（読み取りは送り直してよい切断、書き込みは結果不明） */
function lostResponse(req: HubInvokeRequest, appUrl: string): HubInvokeResponse {
  return req.readOnly
    ? { ok: false, code: RelayErrorCode.TAB_DISCONNECTED, message: relayErrorMessage(RelayErrorCode.TAB_DISCONNECTED, appUrl), retryable: true }
    : { ok: false, code: RelayErrorCode.UNKNOWN_OUTCOME, message: relayErrorMessage(RelayErrorCode.UNKNOWN_OUTCOME, appUrl), retryable: false };
}

function peerFailure(message: string): HubInvokeResponse {
  // 実行されていない（primary が受け付ける前に断った）
  return { ok: false, code: RelayErrorCode.TOOL_ERROR, message, retryable: false };
}

const KEY_MISSING_MESSAGE =
  "橋渡し同士の鍵ファイルが見つかりません。すでに動いている mxstudio の橋渡しを再起動してから、もう一度実行してください。";
const KEY_REJECTED_MESSAGE =
  "橋渡し同士の認証に失敗しました（鍵ファイルが食い違っています）。mxstudio の橋渡しをすべて止めてから起動し直してください。";
const TOO_LARGE_MESSAGE = "引数が大きすぎて作業画面へ送れません。対象を分けて、複数回に分けて実行してください。";

function isHubInvokeResponse(value: unknown): value is HubInvokeResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.ok === true) return typeof v.result === "object" && v.result !== null && typeof v.revision === "number";
  return v.ok === false && typeof v.code === "number" && typeof v.message === "string" && typeof v.retryable === "boolean";
}

/** primary の Hub を、この PC の中の HTTP 経由で呼ぶ */
export class RemoteHub implements HubRpc {
  private readonly port: number;
  private readonly keyStore: BridgeKeyStore;
  private readonly appUrl: string;
  private readonly graceMs: number;
  private readonly shortTimeoutMs: number;

  constructor(opts: RemoteHubOptions) {
    this.port = opts.port;
    this.keyStore = opts.keyStore;
    this.appUrl = opts.appUrl;
    this.graceMs = opts.graceMs ?? 15_000;
    this.shortTimeoutMs = opts.shortTimeoutMs ?? 10_000;
  }

  /**
   * ツール呼び出しを primary へ渡す。進捗は onProgress へ流す。
   * 接続を拒まれたら（primary が居ない）PeerUnreachableError を投げる。それ以外の失敗は応答にして返す。
   */
  async invoke(req: HubInvokeRequest, onProgress?: (p: InvokeProgress) => unknown): Promise<HubInvokeResponse> {
    let body: Buffer;
    try {
      body = Buffer.from(JSON.stringify(req), "utf8");
    } catch {
      // 送っていないので実行されていない（ローカルの Hub と同じ扱い）
      return { ok: false, code: RelayErrorCode.INVALID_ARGS, message: relayErrorMessage(RelayErrorCode.INVALID_ARGS, this.appUrl), retryable: false };
    }
    if (body.byteLength > PEER_MAX_INVOKE_BYTES) {
      // primary は上限を超えた本文を読まずに 413 を返して接続を閉じる。送りかけの本文が接続のリセットになると
      // 応答より先にエラーが届き、実行されていない書き込みを「結果不明」と取り違える。送る前に断る
      return { ok: false, code: RelayErrorCode.TOO_LARGE, message: TOO_LARGE_MESSAGE, retryable: false };
    }
    const key = this.keyStore.load() ?? this.keyStore.current();
    if (key === null) return peerFailure(KEY_MISSING_MESSAGE);
    let first = await this.invokeOnce(req, body, key, onProgress);
    if (first === "forbidden") {
      // 鍵ファイルが作り直されたかもしれない。読み直して 1 回だけ送り直す（403 なら実行されていない）
      const again = this.keyStore.load();
      first = again !== null && again !== key ? await this.invokeOnce(req, body, again, onProgress) : first;
    }
    return first === "forbidden" ? peerFailure(KEY_REJECTED_MESSAGE) : first;
  }

  private invokeOnce(req: HubInvokeRequest, body: Buffer, key: string, onProgress?: (p: InvokeProgress) => unknown): Promise<HubInvokeResponse | "forbidden"> {
    const budget = Math.min(Math.max(req.deadlineMs, 0), RELAY_TIMEOUTS.maxDeadlineMs);
    const timeoutMs = budget + RELAY_TIMEOUTS.reconnectGraceMs + this.graceMs;

    return new Promise((done, failed) => {
      let settled = false;
      let responded = false;
      // 結果の行を受け取った後に接続が切れても、受け取った結果を使う
      let result: HubInvokeResponse | null = null;
      const finish = (value: HubInvokeResponse | "forbidden"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done(value);
      };
      const http = httpRequest(
        {
          host: "127.0.0.1",
          port: this.port,
          method: "POST",
          path: PEER_INVOKE_PATH,
          agent: false,
          headers: {
            host: `127.0.0.1:${this.port}`,
            "content-type": "application/json; charset=utf-8",
            "content-length": String(body.byteLength),
            [BRIDGE_KEY_HEADER]: key,
          },
        },
        (res) => {
          responded = true;
          const status = res.statusCode ?? 0;
          if (status !== 200) {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => {
              if (chunks.length < 64) chunks.push(c);
            });
            res.on("end", () => {
              if (status === 403) return finish("forbidden");
              if (status === 413) {
                return finish({ ok: false, code: RelayErrorCode.TOO_LARGE, message: TOO_LARGE_MESSAGE, retryable: false });
              }
              const parsed = parseJson(Buffer.concat(chunks)) as { message?: unknown } | undefined;
              const detail = parsed && typeof parsed.message === "string" ? parsed.message.slice(0, 500) : `HTTP ${status}`;
              finish(peerFailure(`primary の橋渡しがツール呼び出しを受け付けませんでした（${detail}）。ポート ${this.port} で別のアプリが動いていないか確認してください。`));
            });
            res.on("error", () => finish(status === 403 ? "forbidden" : lostResponse(req, this.appUrl)));
            res.on("close", () => finish(status === 403 ? "forbidden" : lostResponse(req, this.appUrl)));
            return;
          }
          let buffer = "";
          res.setEncoding("utf8");
          res.on("data", (text: string) => {
            buffer += text;
            if (buffer.length > RELAY_LIMITS.maxResultBytes * 3) {
              http.destroy();
              return;
            }
            let nl = buffer.indexOf("\n");
            while (nl >= 0) {
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              nl = buffer.indexOf("\n");
              if (line.trim() === "") continue;
              let msg: unknown;
              try {
                msg = JSON.parse(line);
              } catch {
                continue;
              }
              const m = msg as { type?: unknown; progress?: unknown; total?: unknown; message?: unknown; response?: unknown };
              if (m.type === "progress" && typeof m.progress === "number" && Number.isFinite(m.progress)) {
                if (!onProgress) continue;
                const p: InvokeProgress = { progress: m.progress };
                if (typeof m.total === "number" && Number.isFinite(m.total)) p.total = m.total;
                if (typeof m.message === "string") p.message = m.message;
                try {
                  const r = onProgress(p);
                  if (r && typeof (r as PromiseLike<unknown>).then === "function") Promise.resolve(r).catch(() => undefined);
                } catch {
                  // 通知に失敗しても呼び出しは続ける
                }
              } else if (m.type === "result" && isHubInvokeResponse(m.response)) {
                result = m.response;
              }
            }
          });
          res.on("end", () => finish(result ?? lostResponse(req, this.appUrl)));
          res.on("error", () => finish(result ?? lostResponse(req, this.appUrl)));
          res.on("close", () => finish(result ?? lostResponse(req, this.appUrl)));
        },
      );
      const timer = setTimeout(() => {
        http.destroy(new Error("timeout"));
      }, timeoutMs);
      http.on("error", (err) => {
        if (settled) return;
        if (!responded && isRefused(err)) {
          settled = true;
          clearTimeout(timer);
          failed(new PeerUnreachableError());
          return;
        }
        finish(result ?? lostResponse(req, this.appUrl));
      });
      http.write(body);
      http.end();
    });
  }

  async status(): Promise<HubStatus> {
    const reply = await this.keyed("GET", PEER_STATUS_PATH);
    const parsed = parseJson(reply.body) as { ok?: unknown; status?: unknown } | undefined;
    const status = parsed?.status as HubStatus | undefined;
    if (reply.status !== 200 || !status || !Array.isArray(status.tabs)) throw new Error("primary の状態を取得できませんでした");
    return status;
  }

  async pushImport(msg: ImportChunkMsg): Promise<{ delivered: boolean }> {
    try {
      const reply = await this.keyed("POST", PEER_IMPORT_CHUNK_PATH, Buffer.from(JSON.stringify(msg), "utf8"));
      const parsed = parseJson(reply.body) as { delivered?: unknown } | undefined;
      return { delivered: reply.status === 200 && parsed?.delivered === true };
    } catch (err) {
      if (err instanceof PeerUnreachableError) throw err;
      return { delivered: false };
    }
  }

  /** アップロード URL のチケットを primary で発行する（アップロードは primary のポートに届くため） */
  async createImportTicket(): Promise<ImportTicket> {
    const reply = await this.keyed("POST", PEER_IMPORT_TICKET_PATH, Buffer.from("{}", "utf8"));
    const parsed = parseJson(reply.body) as { ticket?: Record<string, unknown> } | undefined;
    const t = parsed?.ticket;
    if (reply.status !== 200 || !t || typeof t.importId !== "string" || typeof t.expiresAt !== "number" || typeof t.maxBytes !== "number") {
      throw new Error("primary でアップロード URL を発行できませんでした");
    }
    return { importId: t.importId, expiresAt: t.expiresAt, maxBytes: t.maxBytes };
  }

  /** 鍵を付けた短い要求。403 なら鍵を読み直して 1 回だけ送り直す */
  private async keyed(method: string, path: string, body?: Buffer): Promise<RawReply> {
    const key = this.keyStore.load() ?? this.keyStore.current();
    if (key === null) throw new Error(KEY_MISSING_MESSAGE);
    const send = (k: string): Promise<RawReply> => {
      const headers: Record<string, string> = { [BRIDGE_KEY_HEADER]: k };
      if (body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
      const opts: PeerRequestOptions = { port: this.port, method, path, headers, timeoutMs: this.shortTimeoutMs };
      if (body !== undefined) opts.body = body;
      return peerRequest(opts);
    };
    let reply = await send(key);
    if (reply.status === 403) {
      const again = this.keyStore.load();
      if (again !== null && again !== key) reply = await send(again);
    }
    if (reply.status === 403) throw new Error(KEY_REJECTED_MESSAGE);
    return reply;
  }
}
