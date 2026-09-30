// 設定画面の純ロジック: フォームの検査、接続失敗の文言、保存する設定、Skill の一覧。

import { VaultRequestError } from "../keyvault/client";
import { MaximoError, MaximoNetworkError, type MaximoVia } from "../maximo/client";

/** 同一オリジン検査（CSRF 対策）に落ちたときの文言 */
export const FORBIDDEN_ORIGIN_MESSAGE = "同一オリジンからの要求として受け付けられませんでした。作業画面の URL から開き直してください。";

/** proxy 方式の中継役（このパソコンの橋渡し） */
const PROXY = "橋渡し（このパソコンの MX Stage）";

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
  const errors: SettingsFormErrors = {};
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!isVia(input.via)) errors.via = "接続方式を選んでください。";
  if (baseUrl === "") {
    errors.baseUrl = "Maximo URL を入力してください。";
  } else {
    let u: URL | null = null;
    try {
      u = new URL(baseUrl);
    } catch {
      errors.baseUrl = "URL の形式が正しくありません（例 https://maximo.example.com）。";
    }
    if (u) {
      const path = u.pathname.replace(/\/+$/, "");
      const loopbackHttp = u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
      if (u.username || u.password || u.search || u.hash) {
        errors.baseUrl = "URL にユーザー名・クエリ（?）・# を含めないでください。";
      } else if (u.protocol !== "https:" && !(input.via === "direct" && loopbackHttp)) {
        errors.baseUrl = "https の URL にしてください。";
      } else if (input.via === "proxy" && path !== "") {
        errors.baseUrl = "proxy 方式では https://host[:port] の形にしてください（/maximo などのパスは付けません）。";
      }
    }
  }
  const name = input.connectionName.trim();
  if (name === "") errors.connectionName = "接続名を入力してください（例 MAXADMIN@mas-dev）。";
  else if (name.length > CONNECTION_NAME_MAX) errors.connectionName = `接続名は ${CONNECTION_NAME_MAX} 文字以内にしてください。`;
  if (input.apiKey === "") errors.apiKey = "API キーを入力してください。";
  else if (!API_KEY_RE.test(input.apiKey)) errors.apiKey = "API キーに使えない文字（空白・改行・全角文字）が含まれています。";
  return errors;
}

/** 橋渡しの /mx が返したエラーのコード（toMaximoError がメッセージの末尾に「（/mx: コード）」と付ける） */
export function proxyErrorCode(message: string): string | null {
  const m = /（\/mx: ([A-Za-z0-9_]+)）$/.exec(message);
  return m?.[1] ?? null;
}

/** proxy 方式で Maximo に届かなかったときの案内 */
export function unreachableHint(): string {
  return `${PROXY} から Maximo に到達できませんでした。URL を確認してください。Maximo の証明書が私設 CA の場合などは、接続方式を「直結（direct）」にしてください（Maximo 側でこのツールのオリジンと apikey ヘッダを CORS で許可する必要があります）。`;
}

/** 画面と橋渡しの版がずれているかもしれないときの、次の手 */
const RELOAD_HINT =
  "作業画面を読み込み直してから、もう一度接続してください。直らないときは、作業画面と橋渡しの版が合っていない可能性があります（導入をやり直してください）。";

/**
 * /mx（橋渡しの中継）が自分で断ったときのエラーコードの案内。知らないコードなら null。
 * どれも Maximo までは届いていない（API キーの誤りではない）ので、キーの誤りと取り違える文言にしない。
 */
export function proxyRejectMessage(code: string | null): string | null {
  switch (code) {
    case "path_not_allowed":
      return `${PROXY}が転送しないパスへの要求でした（転送するのは /maximo/api/ と /maximo/oslc/ で始まるパスだけです）。API キーの誤りではありません。${RELOAD_HINT}`;
    case "invalid_path":
      return `要求のパスに使えない文字（%2e・%2f・;・.. など）が含まれていたので、${PROXY}が転送を止めました。API キーの誤りではありません。${RELOAD_HINT}`;
    case "missing_apikey":
      return `${PROXY}に API キーが届きませんでした。設定画面で API キーを入れ直してから、もう一度接続してください。`;
    case "apikey_in_query":
      return `API キーを URL のクエリ（?apikey=）に入れた要求だったので、${PROXY}が転送を止めました（キーが履歴やログに残らないようにするためです）。API キーは設定画面の API キー欄にだけ入れ、Maximo URL に ? を含めないでください。`;
    case "method_not_allowed":
      return `${PROXY}が受け付けない方式の要求でした（転送するのは GET と POST だけです）。API キーの誤りではありません。${RELOAD_HINT}`;
    case "upstream_timeout":
      return `${PROXY}から Maximo への要求が、時間内に返りませんでした。Maximo が動いているか、VPN やプロキシなどのネットワークを確認してから、もう一度接続してください。`;
    default:
      return null;
  }
}

/** 接続方式の選択肢の文言 */
export function viaOptionLabel(via: MaximoVia): string {
  if (via === "direct") return "直結（ブラウザから直接。Maximo 側の CORS 設定が必要）";
  return "proxy（このパソコンの橋渡し経由。既定）";
}

/** 接続（whoami）の失敗を、利用者が次に何をすればよいか分かる文言にする */
export function connectErrorMessage(e: unknown, via: MaximoVia): string {
  // keyvault が送る前に止めた・橋渡しが応答しない。自前の文言（キーやヘッダを含まない）をそのまま出す
  if (e instanceof VaultRequestError) return e.message;
  if (e instanceof MaximoNetworkError) {
    if (via === "direct") {
      return e.timedOut
        ? "Maximo の応答がタイムアウトしました。"
        : "ブラウザから Maximo に直接届きませんでした。Maximo 側の CORS 設定（このツールのオリジンと apikey ヘッダの許可）と証明書を確認するか、接続方式を proxy にしてください。";
    }
    if (e.timedOut) return "Maximo の応答がタイムアウトしました。";
    return `Maximo に接続できませんでした。${PROXY}が動いているか、ネットワークを確認してください。`;
  }
  if (e instanceof MaximoError) {
    const code = proxyErrorCode(e.message);
    // 中継役（橋渡し）が自分で断ったもの。HTTP の番号（403 など）だけで判断すると「API キーが無効」と誤るので先に見る
    const rejected = proxyRejectMessage(code);
    if (rejected) return rejected;
    switch (code) {
      case "host_not_allowed":
        return "この Maximo ホストへの接続は許可されていません（橋渡しの起動引数 --allow-host の許可ホスト外）。橋渡しを起動するときの --allow-host にこのホストを足してください。";
      case "unauthorized":
        return "橋渡しが要求を受け付けませんでした。橋渡しを起動し直してから、もう一度接続してください。";
      case "forbidden_origin":
        return FORBIDDEN_ORIGIN_MESSAGE;
      case "upstream_unreachable":
        return unreachableHint();
      case "invalid_base":
      case "missing_base":
        return "Maximo URL は https://host[:port] の形にしてください（パスを含めない）。";
      case "vault_locked":
        return "API キーがロックされました。もう一度接続してください。";
      case "vault_forbidden_destination":
        return "この送り先には API キーを付けて送れません。Maximo URL と接続方式を確認してください。";
      case "vault_bad_request":
        return "API キーまたは URL に使えない文字が含まれています。";
      default:
        break;
    }
    if (e.status === 401 || e.status === 403) return "API キーが無効か、この接続に権限がありません。";
    if (e.status === 502 || e.status === 526 || e.status === 530 || e.status === 521 || e.status === 522 || e.status === 523 || e.status === 525) {
      return `${unreachableHint()}（HTTP ${e.status}）`;
    }
    if (e.status === 504 || e.status === 524) return `Maximo の応答が時間内に返りませんでした（HTTP ${e.status}）。`;
    if (e.status === 404) return "whoami が見つかりません。Maximo URL（/maximo の手前まで）を確認してください。";
    if (e.status >= 200 && e.status < 300) return "Maximo の応答が JSON ではありません。URL がログイン画面などに向いていないか確認してください。";
    return `Maximo がエラーを返しました（HTTP ${e.status}${e.reasonCode ? `、${e.reasonCode}` : ""}）。`;
  }
  return "接続できませんでした。Maximo URL と接続方式を確認してください。";
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
  return {
    summary: "Claude Code に登録済みです。",
    notes: [
      "Claude Code が起動する橋渡し（stdio の MCP サーバ）は、この画面を配っている橋渡しに中継します。URL もトークンも要りません。",
      "Claude Code のツールの一覧に MX Stage が出てこないときは、Claude Code に「MX Stage を入れ直して」と頼むか、導入をもう一度実行してください。",
    ],
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
  if (!res.ok) throw new Error(`Skill の一覧を読めませんでした（${res.status}）。橋渡しの版が古い可能性があります。導入をやり直してください。`);
  return parseSkillList(await res.json());
}
