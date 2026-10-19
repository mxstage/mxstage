// 設定の「Skill と辞書」の入口（作業画面から。同一オリジンの検査は server.ts の checkRequest が行い、書き込みはブラウザからだけ受ける）。
//   GET  /_mxstage/skills?scope=<接続先>                  Skill の一覧（既定・この PC だけ・接続先の Skill・AI の案）
//   GET  /_mxstage/skills/get?scope=&place=&name=         1 つの Skill（本文・変更履歴）。place は default / pc / connection / draft
//   GET  /_mxstage/skills/places?scope=a&scope=b          接続先ごとの置き場所（フォルダ・辞書と Skill の数）
//   POST /_mxstage/skills/check    { name, description, body }                  保存の前に確かめる（形・API キーらしいもの・ほかの客先の名前）
//   POST /_mxstage/skills/save     { scope, place, name, description, body, version?, baseVersion?, force?, overwrite?, draft? }
//   POST /_mxstage/skills/delete   { scope, place, name }
//   POST /_mxstage/skills/revert   { scope, place, name, versionId }
//   POST /_mxstage/skills/move     { scope, name, force? }                      この PC だけの Skill を接続先へ移す
//   POST /_mxstage/skills/discard  { draft, name }                              AI の案を捨てる（draft は案の置き場の印）
// scope は作業画面の接続先（保存した接続先の ID・デモの ID・保存していない接続先の Maximo の URL）。

import type { IncomingMessage, ServerResponse } from "node:http";
import { checkSkill, PC_DRAFT_SCOPE, type SkillDraft, type SkillSaveResult, type SkillShelf } from "./sharedSkills.ts";
import { fallbackLabelOf, scopeKeyOf, type DictionaryStore } from "./dictionaries.ts";
import { readSkillCatalog } from "./skills.ts";

export const SKILLS_PATH = "/_mxstage/skills";
export const SKILLS_GET_PATH = "/_mxstage/skills/get";
export const SKILLS_PLACES_PATH = "/_mxstage/skills/places";
export const SKILLS_CHECK_PATH = "/_mxstage/skills/check";
export const SKILLS_SAVE_PATH = "/_mxstage/skills/save";
export const SKILLS_DELETE_PATH = "/_mxstage/skills/delete";
export const SKILLS_REVERT_PATH = "/_mxstage/skills/revert";
export const SKILLS_MOVE_PATH = "/_mxstage/skills/move";
export const SKILLS_DISCARD_PATH = "/_mxstage/skills/discard";

const GET_PATHS = new Set([SKILLS_PATH, SKILLS_GET_PATH, SKILLS_PLACES_PATH]);
/** 書き込みの入口（ブラウザの作業画面からだけ受ける。AI が設定を通さずに保存しないように） */
export const SKILL_WRITE_PATHS: readonly string[] = [SKILLS_CHECK_PATH, SKILLS_SAVE_PATH, SKILLS_DELETE_PATH, SKILLS_REVERT_PATH, SKILLS_MOVE_PATH, SKILLS_DISCARD_PATH];
export const SKILL_PATHS: readonly string[] = [...GET_PATHS, ...SKILL_WRITE_PATHS];

/** 本文の上限（本文 8,000 バイト・説明 200 文字に余裕を持たせる） */
const BODY_LIMIT = 256 * 1024;
const DRAFT_SCOPE_RE = /^(pc|c_[0-9a-f]{16}|o_[0-9a-f]{16}|demo-(ja|en))$/;
/** places で一度に見る接続先の数 */
const PLACES_MAX = 60;

export interface SkillRouteDeps {
  store: DictionaryStore | null;
  shelf: SkillShelf | null;
  userSkillsDir: string | null;
  send: (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;
  readBody: (req: IncomingMessage, limit: number) => Promise<Record<string, unknown> | null | "too_large">;
}

function draftView(d: SkillDraft): Record<string, unknown> {
  return { name: d.name, description: d.description, version: d.version, createdAt: d.createdAt, basedOn: d.basedOn, draftScope: d.scope };
}

function saveStatus(r: Extract<SkillSaveResult, { ok: false }>): number {
  switch (r.code) {
    case "conflict":
    case "exists":
      return 409;
    case "not_found":
      return 404;
    case "unreachable":
      return 503;
    case "not_writable":
      return 403;
    default:
      return 422;
  }
}

/** ほかの接続先の名前が本文にあれば、その名前（客先の名前を別の客先の Skill に書かないため。止めずに知らせる） */
function otherCustomerNames(store: DictionaryStore, scopeKey: string | null, text: string): string[] {
  const found: string[] = [];
  const hay = text.normalize("NFKC").toLowerCase();
  for (const key of store.knownScopes()) {
    if (key === scopeKey) continue;
    const label = store.labelFor(key);
    if (label === null || label.trim().length < 2) continue;
    if (hay.includes(label.normalize("NFKC").toLowerCase()) && !found.includes(label)) found.push(label);
  }
  return found.slice(0, 5);
}

export async function handleSkillRequest(req: IncomingMessage, res: ServerResponse, url: URL, deps: SkillRouteDeps): Promise<void> {
  const { store, shelf, send } = deps;
  const pathname = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();
  const allowed = GET_PATHS.has(pathname) ? "GET" : "POST";
  if (method !== allowed) {
    send(res, 405, { ok: false, error: "method_not_allowed", message: `Only ${allowed} is accepted.` }, { Allow: allowed });
    return;
  }

  // 一覧は、接続先の Skill を扱えない橋渡しでも返す（既定とこの PC だけの Skill）
  if (pathname === SKILLS_PATH) {
    const raw = url.searchParams.get("scope");
    const scopeKey = scopeKeyOf(raw);
    let connection: Record<string, unknown> | null = null;
    let connectionSkills: { label: string; skills: { name: string; description: string; version: string; body: string }[] } | null = null;
    if (store !== null && shelf !== null && scopeKey !== null) {
      store.ensurePlace(scopeKey, fallbackLabelOf(raw));
      const folder = store.folderInfo(scopeKey);
      const label = store.labelFor(scopeKey, fallbackLabelOf(raw)) ?? scopeKey;
      const listed = folder.reachable ? shelf.listConnection(scopeKey) : { skills: [], deleted: [], problems: [] };
      connectionSkills = { label, skills: listed.skills };
      connection = {
        label,
        folder,
        skills: listed.skills.map(({ body: _b, text: _t, ...s }) => s),
        deleted: listed.deleted,
        problems: listed.problems,
        drafts: shelf.listDrafts(scopeKey).map(draftView),
      };
    }
    const catalog = readSkillCatalog(deps.userSkillsDir, connectionSkills);
    send(res, 200, {
      ok: true,
      userSkillsDir: catalog.userDir,
      skills: catalog.skills.filter((s) => s.origin !== "connection").map((s) => ({ name: s.name, version: s.version, description: s.description, origin: s.origin, category: s.category })),
      problems: catalog.problems,
      connection,
      pcDrafts: shelf !== null ? shelf.listDrafts(PC_DRAFT_SCOPE).map(draftView) : [],
    });
    return;
  }

  if (store === null || shelf === null) {
    send(res, 503, { ok: false, error: "skills_unavailable", message: "This bridge cannot keep shared Skills." });
    return;
  }

  try {
    if (pathname === SKILLS_PLACES_PATH) {
      const places: Record<string, unknown>[] = [];
      for (const raw of url.searchParams.getAll("scope").slice(0, PLACES_MAX)) {
        const scopeKey = scopeKeyOf(raw);
        if (scopeKey === null) continue;
        store.ensurePlace(scopeKey, fallbackLabelOf(raw));
        const folder = store.folderInfo(scopeKey);
        const reachable = folder.reachable;
        places.push({
          scope: raw,
          label: store.labelFor(scopeKey, fallbackLabelOf(raw)) ?? scopeKey,
          folder,
          dictionaries: reachable ? store.list(scopeKey).length : null,
          skills: reachable ? shelf.listConnection(scopeKey).skills.length : null,
          drafts: shelf.listDrafts(scopeKey).length,
          members: reachable ? store.memberNamesOf(scopeKey).size : null,
        });
      }
      send(res, 200, { ok: true, places, member: store.member() });
      return;
    }

    if (pathname === SKILLS_GET_PATH) {
      const name = url.searchParams.get("name") ?? "";
      const place = url.searchParams.get("place") ?? "";
      const raw = url.searchParams.get("scope");
      const scopeKey = scopeKeyOf(raw);
      if (place === "default" || place === "pc") {
        const catalog = readSkillCatalog(place === "pc" ? deps.userSkillsDir : null);
        const s = catalog.skills.find((x) => x.name === name && x.origin === (place === "pc" ? "user" : "default"));
        if (s === undefined) {
          send(res, 404, { ok: false, error: "not_found", message: `There is no Skill ${name}.` });
          return;
        }
        const pc = place === "pc" ? shelf.getPc(name) : null;
        send(res, 200, { ok: true, skill: { name: s.name, description: s.description, version: s.version, place, body: s.body, versionId: pc?.skill?.versionId ?? null, updatedAt: pc?.skill?.updatedAt ?? null, updatedBy: pc?.skill?.updatedBy ?? null }, history: pc?.history ?? [] });
        return;
      }
      if (place === "draft") {
        const draftScope = url.searchParams.get("draft") ?? "";
        const d = DRAFT_SCOPE_RE.test(draftScope) ? shelf.getDraft(draftScope, name) : null;
        if (d === null) {
          send(res, 404, { ok: false, error: "not_found", message: `There is no draft ${name}.` });
          return;
        }
        send(res, 200, { ok: true, draft: { ...draftView(d), body: d.body } });
        return;
      }
      if (place !== "connection" || scopeKey === null) {
        send(res, 422, { ok: false, error: "invalid_request", message: "Send place (default, pc, connection or draft) and scope." });
        return;
      }
      store.ensurePlace(scopeKey, fallbackLabelOf(raw));
      const got = shelf.getConnection(scopeKey, name);
      if (got.skill === null && got.history.length === 0) {
        send(res, 404, { ok: false, error: "not_found", message: `There is no Skill ${name} in this connection.` });
        return;
      }
      send(res, 200, { ok: true, skill: got.skill === null ? null : { ...got.skill, text: undefined }, history: got.history, problem: got.problem });
      return;
    }

    const body = await deps.readBody(req, BODY_LIMIT);
    if (body === "too_large") {
      send(res, 413, { ok: false, error: "too_large", message: `The body is too large (limit ${BODY_LIMIT} bytes).` });
      return;
    }
    if (body === null) {
      send(res, 400, { ok: false, error: "invalid_request", message: "Send a JSON object." });
      return;
    }
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const name = str(body.name).trim();
    const scopeKey = scopeKeyOf(body.scope);
    if (scopeKey !== null) store.ensurePlace(scopeKey, fallbackLabelOf(body.scope));
    const input = { name, description: str(body.description), body: str(body.body), ...(typeof body.version === "string" && body.version !== "" ? { version: body.version } : {}) };

    if (pathname === SKILLS_CHECK_PATH) {
      const check = checkSkill(input);
      send(res, 200, { ok: true, check, otherCustomers: otherCustomerNames(store, scopeKey, `${input.description}\n${input.body}`) });
      return;
    }

    if (pathname === SKILLS_DISCARD_PATH) {
      const draftScope = str(body.draft);
      const done = DRAFT_SCOPE_RE.test(draftScope) && shelf.discardDraft(draftScope, name);
      send(res, done ? 200 : 404, done ? { ok: true } : { ok: false, error: "not_found", message: `There is no draft ${name}.` });
      return;
    }

    const place = str(body.place);
    if (place !== "connection" && place !== "pc") {
      send(res, 422, { ok: false, error: "invalid_request", message: "place must be connection or pc." });
      return;
    }
    if (place === "connection" && scopeKey === null && pathname !== SKILLS_MOVE_PATH) {
      send(res, 422, { ok: false, error: "invalid_scope", message: "scope is not a connection." });
      return;
    }

    let result: SkillSaveResult;
    if (pathname === SKILLS_SAVE_PATH) {
      result =
        place === "connection"
          ? shelf.saveConnection(scopeKey!, input, { baseVersion: typeof body.baseVersion === "string" ? body.baseVersion : null, force: body.force === true })
          : shelf.savePc(input, { overwrite: body.overwrite === true });
      // 案から保存したら、その案を片づける
      const draftScope = str(body.draft);
      if (result.ok && DRAFT_SCOPE_RE.test(draftScope)) shelf.discardDraft(draftScope, name);
    } else if (pathname === SKILLS_DELETE_PATH) {
      const done = place === "connection" ? shelf.removeConnection(scopeKey!, name) : shelf.removePc(name);
      send(res, done ? 200 : 404, done ? { ok: true } : { ok: false, error: "not_found", message: `There is no Skill ${name}.` });
      return;
    } else if (pathname === SKILLS_REVERT_PATH) {
      const versionId = str(body.versionId);
      result = place === "connection" ? shelf.revertConnection(scopeKey!, name, versionId) : shelf.revertPc(name, versionId);
    } else if (pathname === SKILLS_MOVE_PATH) {
      if (scopeKey === null) {
        send(res, 422, { ok: false, error: "invalid_scope", message: "scope is not a connection." });
        return;
      }
      result = shelf.movePcToConnection(scopeKey, name, { force: body.force === true });
    } else {
      send(res, 404, { ok: false, error: "not_found", message: "Not found." });
      return;
    }
    if (!result.ok) {
      send(res, saveStatus(result), { ok: false, error: result.code, message: result.message, ...(result.check ? { check: result.check } : {}), ...(result.conflict ? { conflict: result.conflict } : {}) });
      return;
    }
    send(res, 200, { ok: true, skill: { ...result.skill, text: undefined }, created: result.created, warnings: result.warnings });
  } catch (e) {
    send(res, 500, { ok: false, error: "skill_failed", message: e instanceof Error ? e.message : String(e) });
  }
}
