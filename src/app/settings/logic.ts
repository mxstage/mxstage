// 設定画面の純ロジック: フォームの検査、接続失敗の文言、保存する設定、Skill の一覧。

import { VaultRequestError } from "../keyvault/client";
import { MaximoError, MaximoNetworkError, type MaximoVia } from "../maximo/client";
import { localizeVaultMessage, settingsMessages as m } from "./messages";

/** 同一オリジン検査（CSRF 対策）に落ちたときの文言 */
export function forbiddenOriginMessage(): string {
  return m().connectError.forbiddenOrigin;
}

export interface SettingsFormInput {
  baseUrl: string;
  via: string;
  connectionName: string;
  apiKey: string;
}

export type SettingsField = keyof SettingsFormInput;
export type SettingsFormErrors = Partial<Record<SettingsField, string>>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const API_KEY_RE = /^[\x21-\x7e]+$/;
export const CONNECTION_NAME_MAX = 128;

export function isVia(v: unknown): v is MaximoVia {
  return v === "proxy" || v === "direct";
}

/** 前後の空白と末尾の / を取る */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** 送信前の検査。空のオブジェクトなら問題なし */
export function validateSettingsForm(input: SettingsFormInput): SettingsFormErrors {
  const t = m().validation;
  const errors: SettingsFormErrors = {};
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!isVia(input.via)) errors.via = t.via;
  if (baseUrl === "") {
    errors.baseUrl = t.urlEmpty;
  } else {
    let u: URL | null = null;
    try {
      u = new URL(baseUrl);
    } catch {
      errors.baseUrl = t.urlFormat;
    }
    if (u) {
      const path = u.pathname.replace(/\/+$/, "");
      const loopbackHttp = u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
      if (u.username || u.password || u.search || u.hash) {
        errors.baseUrl = t.urlExtras;
      } else if (u.protocol !== "https:" && !(input.via === "direct" && loopbackHttp)) {
        errors.baseUrl = t.urlHttps;
      } else if (input.via === "proxy" && path !== "") {
        errors.baseUrl = t.urlProxyPath;
      }
    }
  }
  const name = input.connectionName.trim();
  if (name === "") errors.connectionName = t.nameEmpty;
  else if (name.length > CONNECTION_NAME_MAX) errors.connectionName = t.nameTooLong(CONNECTION_NAME_MAX);
  if (input.apiKey === "") errors.apiKey = t.keyEmpty;
  else if (!API_KEY_RE.test(input.apiKey)) errors.apiKey = t.keyChars;
  return errors;
}

/** 橋渡しの /mx が返したエラーのコード（toMaximoError がメッセージの末尾に「（/mx: コード）」と付ける） */
export function proxyErrorCode(message: string): string | null {
  const found = /（\/mx: ([A-Za-z0-9_]+)）$/.exec(message);
  return found?.[1] ?? null;
}

/** proxy 方式で Maximo に届かなかったときの案内 */
export function unreachableHint(): string {
  return m().connectError.unreachable;
}

/**
 * /mx（橋渡しの中継）が自分で断ったときのエラーコードの案内。知らないコードなら null。
 * どれも Maximo までは届いていない（API キーの誤りではない）ので、キーの誤りと取り違える文言にしない。
 * 画面と橋渡しの版がずれているかもしれないときは、読み込み直し・導入のやり直しを次の手として添える。
 */
export function proxyRejectMessage(code: string | null): string | null {
  const t = m().connectError;
  switch (code) {
    case "path_not_allowed":
      return t.pathNotAllowed;
    case "invalid_path":
      return t.invalidPath;
    case "missing_apikey":
      return t.missingApikey;
    case "apikey_in_query":
      return t.apikeyInQuery;
    case "method_not_allowed":
      return t.methodNotAllowed;
    case "upstream_timeout":
      return t.upstreamTimeout;
    default:
      return null;
  }
}

/** 接続方式の選択肢の文言 */
export function viaOptionLabel(via: MaximoVia): string {
  return via === "direct" ? m().via.direct : m().via.proxy;
}

/** 接続（whoami）の失敗を、利用者が次に何をすればよいか分かる文言にする */
export function connectErrorMessage(e: unknown, via: MaximoVia): string {
  const t = m().connectError;
  // keyvault が送る前に止めた・橋渡しが応答しない。自前の文言（キーやヘッダを含まない）を今の言語にして出す
  if (e instanceof VaultRequestError) return localizeVaultMessage(e.message);
  if (e instanceof MaximoNetworkError) {
    if (via === "direct") return e.timedOut ? t.timeout : t.directUnreachable;
    if (e.timedOut) return t.timeout;
    return t.proxyUnreachable;
  }
  if (e instanceof MaximoError) {
    const code = proxyErrorCode(e.message);
    // 中継役（橋渡し）が自分で断ったもの。HTTP の番号（403 など）だけで判断すると「API キーが無効」と誤るので先に見る
    const rejected = proxyRejectMessage(code);
    if (rejected) return rejected;
    switch (code) {
      case "host_not_allowed":
        return t.hostNotAllowed;
      case "unauthorized":
        return t.unauthorized;
      case "forbidden_origin":
        return t.forbiddenOrigin;
      case "upstream_unreachable":
        return t.unreachable;
      case "invalid_base":
      case "missing_base":
        return t.invalidBase;
      case "vault_locked":
        return t.vaultLocked;
      case "vault_forbidden_destination":
        return t.vaultForbiddenDestination;
      case "vault_bad_request":
        return t.vaultBadRequest;
      default:
        break;
    }
    if (e.status === 401 || e.status === 403) return t.invalidKey;
    if (e.status === 502 || e.status === 526 || e.status === 530 || e.status === 521 || e.status === 522 || e.status === 523 || e.status === 525) {
      return t.unreachableStatus(e.status);
    }
    if (e.status === 504 || e.status === 524) return t.gatewayTimeout(e.status);
    if (e.status === 404) return t.whoamiNotFound;
    if (e.status >= 200 && e.status < 300) return t.notJson;
    return t.httpError(e.status, e.reasonCode ?? null);
  }
  return t.fallback;
}

// ---------------------------------------------------------------------------
// 保存する設定（API キーは保存しない）
// ---------------------------------------------------------------------------

export const STORAGE_KEYS = { baseUrl: "mxstage.maximo.baseUrl", via: "mxstage.maximo.via" } as const;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SavedSettings {
  baseUrl: string;
  via: MaximoVia;
}

export function loadSavedSettings(storage: StorageLike | null): SavedSettings {
  let baseUrl = "";
  let via: MaximoVia = "proxy";
  try {
    baseUrl = storage?.getItem(STORAGE_KEYS.baseUrl) ?? "";
    const v = storage?.getItem(STORAGE_KEYS.via);
    if (isVia(v)) via = v;
  } catch {
    // 使えない環境（プライベートウィンドウ等）では既定値
  }
  return { baseUrl, via };
}

export function saveSettings(storage: StorageLike | null, s: SavedSettings): void {
  try {
    storage?.setItem(STORAGE_KEYS.baseUrl, s.baseUrl);
    storage?.setItem(STORAGE_KEYS.via, s.via);
  } catch {
    // 保存できなくても接続は続ける
  }
}

// ---------------------------------------------------------------------------
// LLM クライアントへの登録の表示
// ---------------------------------------------------------------------------

/** 橋渡しを登録するときの MCP サーバ名（Claude Code / Claude Desktop の一覧に出る名前） */
export const LOCAL_MCP_SERVER_NAME = "mxstage";

export interface LocalClientStatus {
  /** 画面に出す現状の一言 */
  summary: string;
  /** 補足（順に並べる） */
  notes: string[];
  /** 登録を確かめるコマンド */
  checkCommand: string;
}

/**
 * 「LLM クライアントの接続」。橋渡しは stdio の MCP サーバなので、URL もトークンも要らない
 * （LLM クライアントが橋渡しを起動し、標準入出力で話す）。橋渡しは 1 つだけで、
 * LLM クライアントが起動した橋渡しは、この画面を配っている橋渡しに中継する。
 */
export function localClientStatus(): LocalClientStatus {
  const t = m().llm;
  return {
    summary: t.summary,
    notes: [t.relayNote, t.reinstallNote],
    checkCommand: `claude mcp list`,
  };
}

// ---------------------------------------------------------------------------
// Skill の一覧（橋渡しの /_mxstage/skills。アプリ既定と利用者の Skill を分けて返す）
// ---------------------------------------------------------------------------

export const SKILLS_LIST_URL = "/_mxstage/skills";

export type SkillOrigin = "default" | "user";

export interface SkillListEntry {
  name: string;
  version: string;
  description: string;
  origin: SkillOrigin;
}

export interface SkillListProblem {
  name: string;
  level: "error" | "warn";
  message: string;
}

export interface SkillList {
  skills: SkillListEntry[];
  problems: SkillListProblem[];
  /** 利用者の Skill のフォルダ。分からなければ null */
  userSkillsDir: string | null;
}

const SKILL_NAME = /^[a-z0-9-]{1,64}$/;

/** 橋渡しの応答を読む。形の合わない項目は捨てる */
export function parseSkillList(json: unknown): SkillList {
  const obj = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const skills: SkillListEntry[] = [];
  for (const item of Array.isArray(obj.skills) ? obj.skills : []) {
    if (typeof item !== "object" || item === null) continue;
    const { name, version, description, origin } = item as Record<string, unknown>;
    if (typeof name !== "string" || !SKILL_NAME.test(name)) continue;
    if (origin !== "default" && origin !== "user") continue;
    skills.push({ name, version: typeof version === "string" ? version : "", description: typeof description === "string" ? description : "", origin });
  }
  const problems: SkillListProblem[] = [];
  for (const item of Array.isArray(obj.problems) ? obj.problems : []) {
    if (typeof item !== "object" || item === null) continue;
    const { name, level, message } = item as Record<string, unknown>;
    if (typeof message !== "string") continue;
    problems.push({ name: typeof name === "string" ? name : "", level: level === "warn" ? "warn" : "error", message });
  }
  return { skills, problems, userSkillsDir: typeof obj.userSkillsDir === "string" ? obj.userSkillsDir : null };
}

/**
 * 橋渡しがその場で作る JSON を取りに行く URL。更新の直後は改名前の Service Worker が 1 回だけ残り、
 * 新しい経路（/_mxstage）を保存してよいものと見なすので、毎回違う URL にして保存した応答を返させない。
 */
export function bridgeJsonUrl(pathname: string, now: number = Date.now()): string {
  return `${pathname}?t=${now}`;
}

export async function fetchSkillList(fetchImpl: typeof fetch = fetch): Promise<SkillList> {
  const res = await fetchImpl(bridgeJsonUrl(SKILLS_LIST_URL), { cache: "no-store" });
  if (!res.ok) throw new Error(m().skills.listFailed(res.status));
  return parseSkillList(await res.json());
}
