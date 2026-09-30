// 橋渡しの HTTP サーバ。127.0.0.1 だけで待ち受け、次の 5 つを 1 つのオリジンで配る。
//   - 画面（dist/app の静的ファイル）
//   - 作業タブとの WebSocket（/ws。mxrelay.v1）
//   - Maximo への転送（/mx/*）
//   - Excel の単回アップロード（/import/:importId）
//   - 橋渡し同士の内部経路（/_mxstage/*。src/bridge/peer.ts）
// すべての入口で接続元・Host・Origin を検査する（DNS リバインディング対策）。
// ポートは固定する。使用中でもずらさない（ずれると作業タブの URL と Hub が分かれる）。
// 使用中のときにどうするか（既存の橋渡しに中継する・別のアプリなら止まる）は src/bridge/coordinator.ts が決める。

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { RELAY_SUBPROTOCOL } from "../shared/protocol.ts";
import { checkRequest, checkUpgrade } from "./guard.ts";
import type { GuardResult } from "./guard.ts";
import { LocalHub } from "./hub.ts";
import { ImportTickets, handleImportUpload } from "./importUpload.ts";
import { handleMaximoProxy } from "./mx.ts";
import type { UpstreamRequest } from "./mx.ts";
import { PEER_PREFIX, handlePeerRequest, readBody } from "./peer.ts";
import type { LicenseStore } from "./license.ts";
import type { BridgeKeyStore } from "./bridgeKey.ts";
import { readSkillCatalog } from "./skills.ts";
import { serveStatic } from "./staticFiles.ts";
import { acceptWebSocket } from "./wsserver.ts";
import type { UpgradeSocket } from "./wsserver.ts";

export const DEFAULT_PORT = 8788;

export interface BridgeServerOptions {
  /** 既定 8788。使用中なら EADDRINUSE で失敗する（ずらさない）。0 なら OS に選ばせる（試験用） */
  port?: number;
  /** dist/app の絶対パス */
  root: string;
  /** Maximo の宛先ホストの許可リスト（空なら無制限） */
  allowedHosts?: string[];
  /** 自己署名証明書の Maximo に届かせる */
  insecure?: boolean;
  /** 上流への要求（試験で差し替える） */
  requestImpl?: UpstreamRequest;
  hub?: LocalHub;
  tickets?: ImportTickets;
  /**
   * 橋渡し同士の鍵。待ち受けを始めた直後に ensure() で用意する（無ければ作る）。
   * 省略すると鍵付きの内部経路（/_mxstage/invoke など）はすべて 403 になる。
   */
  keyStore?: BridgeKeyStore | null;
  /** /_mxstage/health に載せる版 */
  version?: string;
  /** Maximo への要求の時間の上限（ミリ秒。試験で縮める） */
  upstreamTimeoutMs?: number;
  /** 利用者の Skill のフォルダ（~/.config/mxstage/skills）。null・省略なら既定の Skill だけ */
  userSkillsDir?: string | null;
  /** 起動したあとにコードが変わったか。/_mxstage/health の stale に載せる（省くと載せない） */
  codeStale?: () => boolean;
  /** ライセンスキーの保存と確かめ。省くと /_mxstage/license は 503（本番への反映はできない） */
  license?: LicenseStore | null;
}

/** 作業画面の設定が読む Skill の一覧（本文は含めない） */
export const SKILLS_LIST_PATH = "/_mxstage/skills";
/** ライセンスの状態（GET）と保存（POST） */
export const LICENSE_PATH = "/_mxstage/license";
/** 本番の環境をライセンスに結びつける（POST） */
export const LICENSE_AUTHORIZE_PATH = "/_mxstage/license/authorize";
/** ライセンスの入口が受ける本文の上限 */
export const LICENSE_BODY_LIMIT = 8 * 1024;

export interface BridgeServer {
  readonly port: number;
  readonly origin: string;
  readonly hub: LocalHub;
  readonly tickets: ImportTickets;
  readonly server: Server;
  /** 鍵を用意できたか（false なら他の橋渡しからの中継は受けられない） */
  readonly keyReady: boolean;
  close(): Promise<void>;
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

function sendGuardError(res: ServerResponse, guard: GuardResult): void {
  if (guard.ok) return;
  sendJson(res, guard.status, { ok: false, error: guard.error, message: guard.message });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** ポートが使用中で待ち受けられなかったか（EACCES は Windows で予約済み・他の利用者が使用中のとき） */
export function isPortInUseError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "EADDRINUSE" || code === "EACCES";
}

/** 指定のポートで待ち受ける。使用中なら失敗させる（ずらさない） */
async function listenOn(server: Server, port: number): Promise<number> {
  await new Promise<void>((done, failed) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListening);
      failed(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      done();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    // 127.0.0.1 だけで待ち受ける（0.0.0.0 では待たない）
    server.listen(port, "127.0.0.1");
  });
  const address = server.address();
  // ポート 0 を渡されたときは実際に割り当てられた番号を返す
  return address !== null && typeof address === "object" ? (address as AddressInfo).port : port;
}

/** 本文を JSON のオブジェクトとして読む。大きすぎれば "too_large"、読めなければ null */
async function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown> | null | "too_large"> {
  const body = await readBody(req, limit);
  if (body === null) return "too_large";
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * ライセンスの入口。
 *   GET  /_mxstage/license            今の状態（キーとメールは返さない）
 *   POST /_mxstage/license            { key } を保存する（正しいキーだけ）
 *   POST /_mxstage/license/authorize  { baseUrl } を本番の環境としてライセンスに結びつける
 */
async function handleLicenseRequest(req: IncomingMessage, res: ServerResponse, pathname: string, license: LicenseStore | null): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const allowed = pathname === LICENSE_PATH ? ["GET", "POST"] : ["POST"];
  if (!allowed.includes(method)) {
    sendJson(res, 405, { ok: false, error: "method_not_allowed", message: `${allowed.join(", ")} だけを受け付けます。` }, { Allow: allowed.join(", ") });
    return;
  }
  if (license === null) {
    sendJson(res, 503, { ok: false, error: "license_unavailable", message: "この橋渡しではライセンスを扱えません。" });
    return;
  }
  if (method === "GET") {
    sendJson(res, 200, { ok: true, license: license.status() });
    return;
  }
  const body = await readJsonBody(req, LICENSE_BODY_LIMIT);
  if (body === "too_large") {
    sendJson(res, 413, { ok: false, error: "too_large", message: `本文が大きすぎます（上限 ${LICENSE_BODY_LIMIT} バイト）。` });
    return;
  }
  if (pathname === LICENSE_PATH) {
    if (body === null || typeof body.key !== "string") {
      sendJson(res, 400, { ok: false, error: "invalid_request", message: "key（ライセンスキーの文字列）を送ってください。" });
      return;
    }
    const saved = license.save(body.key);
    if (saved.ok) sendJson(res, 200, { ok: true, license: saved.status });
    else sendJson(res, 422, { ok: false, error: "license_rejected", problem: saved.problem, license: saved.status });
    return;
  }
  if (body === null || typeof body.baseUrl !== "string") {
    sendJson(res, 400, { ok: false, error: "invalid_request", message: "baseUrl（Maximo の接続先）を送ってください。" });
    return;
  }
  const result = license.authorize(body.baseUrl);
  if (result.ok) sendJson(res, 200, { ok: true, scope: result.scope, newlyBound: result.newlyBound, license: result.status });
  else sendJson(res, 403, { ok: false, error: "license_required", problem: result.problem, license: result.status });
}

export async function startBridgeServer(opts: BridgeServerOptions): Promise<BridgeServer> {
  const hub = opts.hub ?? new LocalHub();
  const tickets = opts.tickets ?? new ImportTickets();
  const allowedHosts = (opts.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  const insecure = opts.insecure === true;
  const keyStore = opts.keyStore ?? null;
  const version = opts.version ?? "0.0.0";
  let boundPort = opts.port ?? DEFAULT_PORT;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 1 回限りの importId が合言葉になっている入口だけ、curl のような
    // Origin も Sec-Fetch-Site も付けない道具からの POST を受ける（ブラウザからの要求の検査は変えない）
    // （/import/../mx/... のような指定で /mx の検査を緩めないよう、URL として正規化した後のパスで決める）
    // 橋渡し同士の内部経路も同じ扱い（鍵が合言葉。Node の http には Origin も Sec-Fetch-Site も無い）
    let isTicketPath = false;
    try {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      // ライセンスの入口は作業画面（同一オリジン）からだけ受ける
      const licensePath = pathname === LICENSE_PATH || pathname === LICENSE_AUTHORIZE_PATH;
      isTicketPath = pathname.startsWith("/import/") || (pathname.startsWith(PEER_PREFIX) && !licensePath);
    } catch {
      isTicketPath = false;
    }
    const guard = checkRequest(
      {
        method: req.method ?? "GET",
        host: header(req, "host"),
        origin: header(req, "origin"),
        secFetchSite: header(req, "sec-fetch-site"),
        remoteAddress: req.socket.remoteAddress,
      },
      boundPort,
      { allowNonBrowserWrite: isTicketPath },
    );
    if (!guard.ok) {
      sendGuardError(res, guard);
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid_request", message: "URL が不正です。" });
      return;
    }

    if (url.pathname === SKILLS_LIST_PATH) {
      // アプリ既定と利用者の Skill を分けて返す（設定画面の「Skill」）。名前・版・出どころ・問題だけで、本文は返さない
      const catalog = readSkillCatalog(opts.userSkillsDir ?? null);
      sendJson(res, 200, {
        ok: true,
        userSkillsDir: catalog.userDir,
        skills: catalog.skills.map((s) => ({ name: s.name, version: s.version, description: s.description, origin: s.origin })),
        problems: catalog.problems,
      });
      return;
    }

    if (url.pathname === LICENSE_PATH || url.pathname === LICENSE_AUTHORIZE_PATH) {
      await handleLicenseRequest(req, res, url.pathname, opts.license ?? null);
      return;
    }

    if (url.pathname.startsWith(PEER_PREFIX)) {
      await handlePeerRequest(req, res, url.pathname, { hub, tickets, keyStore, version, ...(opts.codeStale !== undefined ? { codeStale: opts.codeStale } : {}) });
      return;
    }

    if (url.pathname === "/mx" || url.pathname.startsWith("/mx/")) {
      handleMaximoProxy(req, res, url, { allowedHosts, insecure, requestImpl: opts.requestImpl, timeoutMs: opts.upstreamTimeoutMs });
      return;
    }

    if (url.pathname.startsWith("/import/")) {
      const encoded = url.pathname.slice("/import/".length);
      let importId: string;
      try {
        importId = decodeURIComponent(encoded);
      } catch {
        importId = encoded; // 符号化が壊れていればそのまま照合する（見つからず 403 になる）
      }
      await handleImportUpload(req, res, importId, tickets, hub);
      return;
    }

    if (url.pathname === "/ws") {
      sendJson(res, 426, { ok: false, error: "upgrade_required", message: "WebSocket で接続してください。" }, { Upgrade: "websocket" });
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "GET だけを受け付けます。" }, { Allow: "GET, HEAD" });
      return;
    }
    const served = await serveStatic(res, url.pathname, { root: opts.root, head: method === "HEAD" });
    if (!served) sendJson(res, 404, { ok: false, error: "not_found", message: "見つかりません。" });
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      // 詳細（ヘッダ・本文・キー）は応答にもログにも出さない
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal_error", message: "内部エラーが発生しました。" });
      else res.destroy();
    });
  });

  server.on("upgrade", (req: IncomingMessage, socket: UpgradeSocket, head: Buffer) => {
    const url = (req.url ?? "/").split("?")[0];
    const guard = checkUpgrade(
      {
        method: "GET",
        host: header(req, "host"),
        origin: header(req, "origin"),
        secFetchSite: header(req, "sec-fetch-site"),
        remoteAddress: socket.remoteAddress,
      },
      boundPort,
    );
    if (url !== "/ws" || !guard.ok) {
      const status = guard.ok ? "404 Not Found" : `${guard.status} Forbidden`;
      try {
        socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      } catch {
        // 既に切れている
      }
      return;
    }
    const ws = acceptWebSocket(req, socket, head, { subprotocol: RELAY_SUBPROTOCOL });
    if (ws) hub.attach(ws);
  });

  boundPort = await listenOn(server, opts.port ?? DEFAULT_PORT);
  const origin = `http://127.0.0.1:${boundPort}`;
  hub.setAppUrl(origin);

  // 待ち受けを始めた直後、同期で鍵を用意する（この間に届いた要求はまだ処理されない）。
  // ポートを取れた橋渡しだけが鍵ファイルを作る
  let keyReady = false;
  if (keyStore) {
    try {
      keyStore.ensure();
      keyReady = true;
    } catch {
      keyReady = false;
    }
  }

  return {
    port: boundPort,
    origin,
    hub,
    tickets,
    server,
    keyReady,
    close: async () => {
      hub.closeAll();
      await new Promise<void>((done) => {
        server.close(() => done());
        // keep-alive で残っている接続を待たずに閉じる
        server.closeAllConnections?.();
      });
    },
  };
}
