// 辞書と共有フォルダの入口（作業画面から。同一オリジンの検査は server.ts の checkRequest が行う）。
//   GET  /_mxstage/dictionaries?scope=<接続先>            辞書の一覧・共有フォルダ・メンバー・変わったかの印
//   GET  /_mxstage/dictionaries/get?scope=&id=            辞書の中身（全員の変更を合わせたもの）と履歴
//   POST /_mxstage/dictionaries/create   { scope, name, kind, description? }
//   POST /_mxstage/dictionaries/save     { scope, id, ops }
//   POST /_mxstage/dictionaries/revert   { scope, id, saveId }
//   POST /_mxstage/shared-folder         { scope, path | null, project? }  接続先に共有フォルダを付ける・外す
//   POST /_mxstage/shared-folder/pick    {}  フォルダを選ぶ画面を開く
//   POST /_mxstage/shared-folder/open    { scope }  共有フォルダをエクスプローラーなどで開く
//   GET  /_mxstage/member                 この PC の利用者の表示名
//   POST /_mxstage/member                 { name }
// scope は作業画面の接続先（保存した接続先の ID・デモの ID・保存していない接続先の Maximo の URL）。

import type { IncomingMessage, ServerResponse } from "node:http";
import { DictionaryError, scopeKeyOf, type DictionaryStore, type ProjectConnection, type SaveOp } from "./dictionaries.ts";
import { pickFolder } from "./folderPicker.ts";

export const DICTIONARIES_PATH = "/_mxstage/dictionaries";
export const DICTIONARIES_GET_PATH = "/_mxstage/dictionaries/get";
export const DICTIONARIES_CREATE_PATH = "/_mxstage/dictionaries/create";
export const DICTIONARIES_SAVE_PATH = "/_mxstage/dictionaries/save";
export const DICTIONARIES_REVERT_PATH = "/_mxstage/dictionaries/revert";
export const SHARED_FOLDER_PATH = "/_mxstage/shared-folder";
export const SHARED_FOLDER_PICK_PATH = "/_mxstage/shared-folder/pick";
export const SHARED_FOLDER_OPEN_PATH = "/_mxstage/shared-folder/open";
export const MEMBER_PATH = "/_mxstage/member";

export const DICTIONARY_PATHS: readonly string[] = [
  DICTIONARIES_PATH,
  DICTIONARIES_GET_PATH,
  DICTIONARIES_CREATE_PATH,
  DICTIONARIES_SAVE_PATH,
  DICTIONARIES_REVERT_PATH,
  SHARED_FOLDER_PATH,
  SHARED_FOLDER_PICK_PATH,
  SHARED_FOLDER_OPEN_PATH,
  MEMBER_PATH,
];

/** 保存の本文の上限（2,000 件 × 1 件 1 KB 弱） */
export const DICTIONARY_BODY_LIMIT = 2 * 1024 * 1024;

const GET_PATHS = new Set([DICTIONARIES_PATH, DICTIONARIES_GET_PATH, MEMBER_PATH]);
const BOTH_PATHS = new Set([MEMBER_PATH]);

export interface DictionaryRouteDeps {
  store: DictionaryStore | null;
  send: (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
  readBody: (req: IncomingMessage, limit: number) => Promise<Record<string, unknown> | null | "too_large">;
  /** フォルダをエクスプローラー・Finder で開く */
  reveal: (path: string) => void;
  /** フォルダを選ぶ画面（試験で差し替える） */
  pick?: (title: string) => ReturnType<typeof pickFolder>;
}

function errorStatus(code: DictionaryError["code"]): number {
  switch (code) {
    case "not_found":
      return 404;
    case "name_taken":
      return 409;
    case "unreachable":
      return 503;
    case "not_writable":
      return 403;
    default:
      return 422;
  }
}

function projectOf(raw: unknown): { name: string; connections: ProjectConnection[] } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as { name?: unknown; connections?: unknown };
  if (typeof v.name !== "string") return undefined;
  const connections: ProjectConnection[] = [];
  if (Array.isArray(v.connections)) {
    for (const c of v.connections.slice(0, 20)) {
      const x = c as Record<string, unknown>;
      if (typeof x?.name === "string" && typeof x.baseUrl === "string") {
        connections.push({ name: x.name, baseUrl: x.baseUrl, environment: x.environment === "production" || x.environment === "test" ? x.environment : null });
      }
    }
  }
  return { name: v.name, connections };
}

export async function handleDictionaryRequest(req: IncomingMessage, res: ServerResponse, url: URL, deps: DictionaryRouteDeps): Promise<void> {
  const { store, send } = deps;
  const pathname = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();
  const allowed = BOTH_PATHS.has(pathname) ? ["GET", "POST"] : GET_PATHS.has(pathname) ? ["GET"] : ["POST"];
  if (!allowed.includes(method)) {
    send(res, 405, { ok: false, error: "method_not_allowed", message: `Only ${allowed.join(", ")} is accepted.` }, { Allow: allowed.join(", ") });
    return;
  }
  if (store === null) {
    send(res, 503, { ok: false, error: "dictionaries_unavailable", message: "This bridge cannot keep dictionaries." });
    return;
  }
  try {
    if (pathname === MEMBER_PATH && method === "GET") {
      send(res, 200, { ok: true, member: store.member() });
      return;
    }
    if (method === "GET") {
      const scopeKey = scopeKeyOf(url.searchParams.get("scope"));
      if (scopeKey === null) throw new DictionaryError("invalid_scope", "scope is not a connection.");
      const folder = store.folderInfo(scopeKey);
      if (pathname === DICTIONARIES_PATH) {
        // 共有フォルダに届かなくても、フォルダの様子は返す（作業画面がそう出す）
        if (!folder.reachable) {
          send(res, 200, { ok: true, folder, member: store.member(), dictionaries: [], version: null });
          return;
        }
        send(res, 200, { ok: true, folder, member: store.member(), dictionaries: store.list(scopeKey), version: store.version(scopeKey) });
        return;
      }
      const id = url.searchParams.get("id") ?? "";
      const found = store.find(scopeKey, id);
      if (found === null) throw new DictionaryError("not_found", `There is no dictionary ${id}.`, { id });
      send(res, 200, { ok: true, folder, ...store.get(scopeKey, found.id) });
      return;
    }

    if (pathname === SHARED_FOLDER_PICK_PATH) {
      const picked = await (deps.pick ?? pickFolder)("MX Stage: 共有フォルダを選ぶ / Choose the shared folder");
      if (picked.ok) send(res, 200, { ok: true, path: picked.path });
      else send(res, picked.reason === "busy" ? 409 : 501, { ok: false, error: `pick_${picked.reason}`, message: "The folder chooser could not be opened." });
      return;
    }

    const body = await deps.readBody(req, DICTIONARY_BODY_LIMIT);
    if (body === "too_large") {
      send(res, 413, { ok: false, error: "too_large", message: `The body is too large (limit ${DICTIONARY_BODY_LIMIT} bytes).` });
      return;
    }
    if (body === null) {
      send(res, 400, { ok: false, error: "invalid_request", message: "Send a JSON object." });
      return;
    }
    if (pathname === MEMBER_PATH) {
      const member = store.setMemberName(typeof body.name === "string" ? body.name : "");
      store.renameMemberEverywhere();
      send(res, 200, { ok: true, member });
      return;
    }
    const scopeKey = scopeKeyOf(body.scope);
    if (scopeKey === null) throw new DictionaryError("invalid_scope", "scope is not a connection.");

    if (pathname === SHARED_FOLDER_PATH) {
      const path = body.path === null ? null : typeof body.path === "string" ? body.path : undefined;
      if (path === undefined) throw new DictionaryError("invalid_request", "Send path as a string, or null to stop sharing.");
      const folder = await store.setSharedFolder(scopeKey, path, projectOf(body.project));
      send(res, 200, { ok: true, folder, member: store.member(), dictionaries: folder.reachable ? store.list(scopeKey) : [], version: folder.reachable ? store.version(scopeKey) : null });
      return;
    }
    if (pathname === SHARED_FOLDER_OPEN_PATH) {
      const folder = store.folderInfo(scopeKey);
      if (folder.path === null || !folder.reachable) throw new DictionaryError("unreachable", "There is no shared folder to open.");
      deps.reveal(folder.path);
      send(res, 200, { ok: true });
      return;
    }
    if (pathname === DICTIONARIES_CREATE_PATH) {
      const meta = await store.create(scopeKey, {
        name: typeof body.name === "string" ? body.name : "",
        kind: body.kind === undefined ? "alias" : (body.kind as "alias"),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
      });
      send(res, 200, { ok: true, ...store.get(scopeKey, meta.id) });
      return;
    }
    const id = typeof body.id === "string" ? body.id : "";
    const found = store.find(scopeKey, id);
    if (found === null) throw new DictionaryError("not_found", `There is no dictionary ${id}.`, { id });
    if (pathname === DICTIONARIES_SAVE_PATH) {
      const saved = await store.save(scopeKey, found.id, Array.isArray(body.ops) ? (body.ops as SaveOp[]) : []);
      send(res, 200, { ok: true, saveId: saved.saveId, ids: saved.ids, ...saved.state });
      return;
    }
    if (pathname === DICTIONARIES_REVERT_PATH) {
      const r = await store.revert(scopeKey, found.id, typeof body.saveId === "string" ? body.saveId : "");
      send(res, 200, { ok: true, reverted: r.reverted, skipped: r.skipped, ...r.state });
      return;
    }
    send(res, 404, { ok: false, error: "not_found", message: "Not found." });
  } catch (e) {
    if (e instanceof DictionaryError) {
      send(res, errorStatus(e.code), { ok: false, error: e.code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) });
      return;
    }
    send(res, 500, { ok: false, error: "dictionary_failed", message: e instanceof Error ? e.message : String(e) });
  }
}
