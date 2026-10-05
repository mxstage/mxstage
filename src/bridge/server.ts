// 橋渡しの HTTP サーバ。127.0.0.1 だけで待ち受け、次の 5 つを 1 つのオリジンで配る。
//   - 画面（dist/app の静的ファイル）
//   - 作業タブとの WebSocket（/ws。mxrelay.v1）
//   - Maximo への転送（/mx/*。デモの接続先は手元の仮想 Maximo へ。src/bridge/demo.ts）
//   - Excel の単回アップロード（/import/:importId）
//   - 橋渡し同士の内部経路（/_mxstage/*。src/bridge/peer.ts）
// すべての入口で接続元・Host・Origin を検査する（DNS リバインディング対策）。
// ポートは固定する。使用中でもずらさない（ずれると作業タブの URL と Hub が分かれる）。
// 使用中のときにどうするか（既存の橋渡しに中継する・別のアプリなら止まる）は src/bridge/coordinator.ts が決める。

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { RELAY_SUBPROTOCOL } from "../shared/protocol.ts";
import { checkRequest, checkUpgrade, isLocalOrigin } from "./guard.ts";
import type { GuardResult } from "./guard.ts";
import { LocalHub } from "./hub.ts";
import { ImportTickets, handleImportUpload } from "./importUpload.ts";
import { handleMaximoProxy } from "./mx.ts";
import type { UpstreamRequest } from "./mx.ts";
import { PEER_PREFIX, handlePeerRequest, readBody } from "./peer.ts";
import type { LicenseStore } from "./license.ts";
import type { ConnectionEntry, ConnectionStore } from "./connections.ts";
import { handleDemoRequest, isDemoPath, type DemoManager } from "./demo.ts";
import { DEMO_CONNECTION_IDS, DEMO_ORIGINS, demoLangOfConnectionId } from "../shared/demo.ts";
import { HANDOFF_PATHS, Handoffs } from "./handoff.ts";
import type { UpdateManager } from "./updates.ts";
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
  /** 保存した接続先（API キーを預かる）。省くと /_mxstage/connections は 503、/mx は毎回キーを受け取る方式だけ */
  connections?: ConnectionStore | null;
  /** 新しい版の確認と入れ替え（設定の「更新」）。省くと /_mxstage/updates は 503 */
  updates?: UpdateManager | null;
  /** Maximo が無くても試せるデモ（設定の「デモ」）。省く・null（--no-demo）なら /_mxstage/demo は 404、デモの接続先は使えない */
  demo?: DemoManager | null;
}

/** 作業画面の設定が読む Skill の一覧（本文は含めない） */
export const SKILLS_LIST_PATH = "/_mxstage/skills";
/** ライセンスキーの一覧（GET）と保存（POST） */
export const LICENSE_PATH = "/_mxstage/license";
/** ライセンスキーを外す（POST） */
export const LICENSE_REMOVE_PATH = "/_mxstage/license/remove";
/** 本番の接続先に反映してよいかを確かめる（POST） */
export const LICENSE_AUTHORIZE_PATH = "/_mxstage/license/authorize";
const LICENSE_PATHS: readonly string[] = [LICENSE_PATH, LICENSE_REMOVE_PATH, LICENSE_AUTHORIZE_PATH];
/** 保存した接続先の一覧（GET）と保存（POST） */
export const CONNECTIONS_PATH = "/_mxstage/connections";
/** 保存した接続先を消す（POST） */
export const CONNECTIONS_REMOVE_PATH = "/_mxstage/connections/remove";
/** 最後に使った接続先にする（POST） */
export const CONNECTIONS_USE_PATH = "/_mxstage/connections/use";
const CONNECTIONS_PATHS: readonly string[] = [CONNECTIONS_PATH, CONNECTIONS_REMOVE_PATH, CONNECTIONS_USE_PATH];
/** 更新の状態（GET）と自動の更新の切り替え（POST { autoUpdate }） */
export const UPDATES_PATH = "/_mxstage/updates";
/** 今すぐ確かめる（POST） */
export const UPDATES_CHECK_PATH = "/_mxstage/updates/check";
/** 入れる（POST。git は入れ替え、.mcpb はダウンロード） */
export const UPDATES_INSTALL_PATH = "/_mxstage/updates/install";
const UPDATES_PATHS: readonly string[] = [UPDATES_PATH, UPDATES_CHECK_PATH, UPDATES_INSTALL_PATH];
/** 接続先の入口が受ける本文の上限 */
export const CONNECTIONS_BODY_LIMIT = 16 * 1024;
/** /mx で保存した接続先を指すヘッダ（小文字） */
export const MAXIMO_CONNECTION_HEADER = "x-maximo-connection";
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
 * ライセンスの入口（作業画面の「設定」→「ライセンス」と、本番への反映の関門が使う）。
 *   GET  /_mxstage/license            置いてあるキーの状態（キーそのものとメールは返さない）
 *   POST /_mxstage/license            { key } を保存する（正しいキーだけ）
 *   POST /_mxstage/license/remove     { licenseId } のキーを外す
 *   POST /_mxstage/license/authorize  { baseUrl } の本番に反映してよいか（接続先がキーの本番の接続先に含まれるか）
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
    sendJson(res, 200, { ok: true, licenses: license.list() });
    return;
  }
  const body = await readJsonBody(req, LICENSE_BODY_LIMIT);
  if (body === "too_large") {
    sendJson(res, 413, { ok: false, error: "too_large", message: `本文が大きすぎます（上限 ${LICENSE_BODY_LIMIT} バイト）。` });
    return;
  }
  const field = pathname === LICENSE_PATH ? "key" : pathname === LICENSE_REMOVE_PATH ? "licenseId" : "baseUrl";
  const value = body === null ? undefined : body[field];
  if (typeof value !== "string") {
    sendJson(res, 400, { ok: false, error: "invalid_request", message: `${field} を文字列で送ってください。` });
    return;
  }
  if (pathname === LICENSE_PATH) {
    const saved = license.save(value);
    if (saved.ok) sendJson(res, 200, { ok: true, license: saved.license, licenses: license.list() });
    else sendJson(res, 422, { ok: false, error: "license_rejected", problem: saved.problem, licenses: license.list() });
    return;
  }
  if (pathname === LICENSE_REMOVE_PATH) {
    sendJson(res, 200, { ok: true, removed: license.remove(value), licenses: license.list() });
    return;
  }
  const result = license.authorize(value);
  if (result.ok) sendJson(res, 200, { ok: true, host: result.host, license: result.license });
  else sendJson(res, 403, { ok: false, error: "license_required", problem: result.problem, host: result.host, licensedHosts: result.licensedHosts });
}

/** 落とし済みのデモ（予約の ID・オリジン。常にテスト環境） */
function demoConnections(demo: DemoManager | null): ConnectionEntry[] {
  if (demo === null) return [];
  return demo.readyLanguages().map((lang) => ({
    id: DEMO_CONNECTION_IDS[lang],
    name: lang === "ja" ? "MX Stage demo (Japanese)" : "MX Stage demo (English)",
    baseUrl: DEMO_ORIGINS[lang],
    environment: "test",
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
  }));
}

/** 一覧（保存した接続先と、落とし済みのデモ。最後に使ったのが消したデモなら null にする） */
function connectionListing(store: ConnectionStore, demo: DemoManager | null): ReturnType<ConnectionStore["list"]> & { demo: ConnectionEntry[] } {
  const list = store.list();
  const demoList = demoConnections(demo);
  const staleDemo = demoLangOfConnectionId(list.lastUsedId) !== null && !demoList.some((d) => d.id === list.lastUsedId);
  return { ...list, lastUsedId: staleDemo ? null : list.lastUsedId, demo: demoList };
}

/**
 * 保存した接続先の入口（作業画面の「設定」→「接続」と、開いたときの自動接続が使う）。API キーは返さない。
 *   GET  /_mxstage/connections         一覧と、最後に使った接続先（落とし済みのデモは別の配列 demo）
 *   POST /_mxstage/connections         { id?, name, baseUrl, environment, apiKey? } を保存する
 *   POST /_mxstage/connections/remove  { id } を消す
 *   POST /_mxstage/connections/use     { id } を最後に使った接続先にする（デモの ID も受ける）
 */
async function handleConnectionsRequest(req: IncomingMessage, res: ServerResponse, pathname: string, store: ConnectionStore | null, demo: DemoManager | null): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const allowed = pathname === CONNECTIONS_PATH ? ["GET", "POST"] : ["POST"];
  if (!allowed.includes(method)) {
    sendJson(res, 405, { ok: false, error: "method_not_allowed", message: `Only ${allowed.join(", ")} is accepted.` }, { Allow: allowed.join(", ") });
    return;
  }
  if (store === null) {
    sendJson(res, 503, { ok: false, error: "connections_unavailable", message: "This bridge cannot save connections." });
    return;
  }
  if (method === "GET") {
    sendJson(res, 200, { ok: true, ...connectionListing(store, demo) });
    return;
  }
  const body = await readJsonBody(req, CONNECTIONS_BODY_LIMIT);
  if (body === "too_large") {
    sendJson(res, 413, { ok: false, error: "too_large", message: `The body is too large (limit ${CONNECTIONS_BODY_LIMIT} bytes).` });
    return;
  }
  if (body === null) {
    sendJson(res, 400, { ok: false, error: "invalid_request", message: "Send a JSON object." });
    return;
  }
  if (pathname === CONNECTIONS_PATH) {
    const saved = await store.save({
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      name: typeof body.name === "string" ? body.name : "",
      baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
      environment: body.environment === "production" || body.environment === "test" ? body.environment : null,
      ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
    });
    if (saved.ok) sendJson(res, 200, { ok: true, connection: saved.connection, ...connectionListing(store, demo) });
    else sendJson(res, 422, { ok: false, error: "connection_rejected", problem: saved.problem, ...connectionListing(store, demo) });
    return;
  }
  if (typeof body.id !== "string") {
    sendJson(res, 400, { ok: false, error: "invalid_request", message: "Send id as a string." });
    return;
  }
  if (pathname === CONNECTIONS_REMOVE_PATH) {
    sendJson(res, 200, { ok: true, removed: store.remove(body.id), ...connectionListing(store, demo) });
    return;
  }
  if (demoLangOfConnectionId(body.id) !== null) {
    const entry = demoConnections(demo).find((d) => d.id === body.id);
    if (entry && store.useDemo(entry.id)) sendJson(res, 200, { ok: true, connection: entry, ...connectionListing(store, demo) });
    else sendJson(res, 404, { ok: false, error: "connection_not_found", message: "The demo data has not been downloaded." });
    return;
  }
  const used = store.use(body.id);
  if (used) sendJson(res, 200, { ok: true, connection: used, ...connectionListing(store, demo) });
  else sendJson(res, 404, { ok: false, error: "connection_not_found", message: "The saved connection was not found." });
}

/**
 * 更新の入口（作業画面の設定の「更新」）。外へ問い合わせるのは、自動の更新がオンのときと「今すぐ確かめる」を押したときだけ。
 *   GET  /_mxstage/updates          今の版・最新の版・自動の更新のオン／オフ
 *   POST /_mxstage/updates          { autoUpdate } を切り替える（オンにしたらすぐ確かめる）
 *   POST /_mxstage/updates/check    今すぐ確かめる
 *   POST /_mxstage/updates/install  入れる（git は入れ替え、.mcpb はダウンロードして置き場所を開く）
 */
async function handleUpdatesRequest(req: IncomingMessage, res: ServerResponse, pathname: string, updates: UpdateManager | null): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const allowed = pathname === UPDATES_PATH ? ["GET", "POST"] : ["POST"];
  if (!allowed.includes(method)) {
    sendJson(res, 405, { ok: false, error: "method_not_allowed", message: `Only ${allowed.join(", ")} is accepted.` }, { Allow: allowed.join(", ") });
    return;
  }
  if (updates === null) {
    sendJson(res, 503, { ok: false, error: "updates_unavailable", message: "This bridge cannot check for updates." });
    return;
  }
  if (method === "GET") {
    sendJson(res, 200, { ok: true, ...updates.status() });
    return;
  }
  if (pathname === UPDATES_PATH) {
    const body = await readJsonBody(req, 1024);
    if (body === null || body === "too_large" || typeof body.autoUpdate !== "boolean") {
      sendJson(res, 400, { ok: false, error: "invalid_request", message: "Send autoUpdate as a boolean." });
      return;
    }
    sendJson(res, 200, { ok: true, ...(await updates.setAutoUpdate(body.autoUpdate)) });
    return;
  }
  req.resume();
  const status = pathname === UPDATES_CHECK_PATH ? await updates.check() : await updates.install();
  sendJson(res, 200, { ok: true, ...status });
}

/** ブラウザの同一オリジンの要求か（保存した接続先で Maximo へ送るときに求める） */
function isSameOriginBrowserRequest(req: IncomingMessage, port: number): boolean {
  const origin = header(req, "origin");
  if (origin !== undefined) return isLocalOrigin(origin, port);
  return header(req, "sec-fetch-site") === "same-origin";
}

export async function startBridgeServer(opts: BridgeServerOptions): Promise<BridgeServer> {
  const hub = opts.hub ?? new LocalHub();
  // 作業を別の窓へ移す（「この窓に移す」。作業のデータはメモリを通るだけ）
  const handoffs = new Handoffs();
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
      // ライセンスと保存した接続先の入口は作業画面（同一オリジン）からだけ受ける
      isTicketPath =
        pathname.startsWith("/import/") ||
        (pathname.startsWith(PEER_PREFIX) && !LICENSE_PATHS.includes(pathname) && !CONNECTIONS_PATHS.includes(pathname) && !HANDOFF_PATHS.includes(pathname) && !UPDATES_PATHS.includes(pathname) && !isDemoPath(pathname));
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
        skills: catalog.skills.map((s) => ({ name: s.name, version: s.version, description: s.description, origin: s.origin, category: s.category })),
        problems: catalog.problems,
      });
      return;
    }

    if (LICENSE_PATHS.includes(url.pathname)) {
      await handleLicenseRequest(req, res, url.pathname, opts.license ?? null);
      return;
    }

    if (UPDATES_PATHS.includes(url.pathname)) {
      await handleUpdatesRequest(req, res, url.pathname, opts.updates ?? null);
      return;
    }

    if (HANDOFF_PATHS.includes(url.pathname)) {
      await handoffs.handle(req, res, url.pathname, hub);
      return;
    }

    if (CONNECTIONS_PATHS.includes(url.pathname)) {
      await handleConnectionsRequest(req, res, url.pathname, opts.connections ?? null, opts.demo ?? null);
      return;
    }

    if (isDemoPath(url.pathname)) {
      await handleDemoRequest(req, res, url.pathname, opts.demo ?? null);
      return;
    }

    if (url.pathname.startsWith(PEER_PREFIX)) {
      await handlePeerRequest(req, res, url.pathname, { hub, tickets, keyStore, version, ...(opts.codeStale !== undefined ? { codeStale: opts.codeStale } : {}) });
      return;
    }

    if (url.pathname === "/mx" || url.pathname.startsWith("/mx/")) {
      // 保存した接続先を指す要求は、橋渡しが API キーを付ける。作業画面（ブラウザの同一オリジン）からだけ受ける
      const connectionId = header(req, MAXIMO_CONNECTION_HEADER);
      let saved: { origin: string; apiKey: string } | undefined;
      if (connectionId !== undefined) {
        if (!isSameOriginBrowserRequest(req, boundPort)) {
          sendJson(res, 403, { ok: false, error: "forbidden_origin", message: "Saved connections can only be used from the work screen." });
          return;
        }
        // デモの予約の ID は、保存した接続先を引く前に手元の仮想 Maximo へ回す（ネットには出ない）
        const demoLang = demoLangOfConnectionId(connectionId);
        if (demoLang !== null) {
          const demo = opts.demo ?? null;
          if (demo === null) {
            sendJson(res, 404, { ok: false, error: "connection_not_found", message: "The demo is turned off in this bridge." });
            return;
          }
          await demo.handleMx(req, res, url, demoLang);
          return;
        }
        const store = opts.connections ?? null;
        const resolved = store === null ? ({ ok: false, problem: "unavailable" } as const) : await store.resolve(connectionId);
        if (!resolved.ok) {
          const status = resolved.problem === "not_found" ? 404 : resolved.problem === "unavailable" ? 503 : 500;
          sendJson(res, status, { ok: false, error: `connection_${resolved.problem}`, message: "The saved connection cannot be used." });
          return;
        }
        saved = { origin: resolved.origin, apiKey: resolved.apiKey };
      }
      handleMaximoProxy(req, res, url, { allowedHosts, insecure, requestImpl: opts.requestImpl, timeoutMs: opts.upstreamTimeoutMs, saved });
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
