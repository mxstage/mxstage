// API キーの保管と送信（Web Worker の中身。Worker に依存しない純ロジックなので試験できる）。
// - 本物のキーはここにだけ置く。メインスレッドの MaximoClient は番兵（VAULT_SENTINEL）をキーとして使い、
//   ここで番兵と同じ値のキーのヘッダ（proxy: X-Maximo-Apikey、direct: apikey）だけを本物のキーへ置き換える。
// - 送り先は proxy なら同一オリジンの /mx/ 配下、direct なら設定した Maximo のオリジンだけ。
// - 利用者の操作が idleMs 無ければキーを消す（自動ロック）。
// - キー・ヘッダ・本文をログにもエラーメッセージにも入れない。

import type { MaximoVia } from "../maximo/client";
import {
  VAULT_IDLE_MS,
  VAULT_SENTINEL,
  type VaultErrorCode,
  type VaultFetchRequest,
  type VaultFetchResponse,
  type VaultLockReason,
  type VaultToMain,
} from "./protocol";

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

type TimerHandle = unknown;

export type VaultFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface VaultCoreOptions {
  /** 作業画面（Worker）のオリジン。proxy の送り先の検査に使う */
  origin: string;
  idleMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  onLock?: (reason: VaultLockReason) => void;
}

interface UnlockedState {
  apiKey: string;
  via: MaximoVia;
  /** 正規化した Maximo の URL（末尾の / なし） */
  baseUrl: string;
  baseOrigin: string;
}

/** 見える ASCII だけ（空白・改行・全角を含むキーはヘッダに入れられない） */
const API_KEY_RE = /^[\x21-\x7e]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** メインスレッドへ返す応答ヘッダ（MaximoClient が読むものだけ） */
const PASS_RESPONSE_HEADERS = ["content-type", "retry-after"] as const;
const KEY_HEADER: Record<MaximoVia, string> = { proxy: "x-maximo-apikey", direct: "apikey" };
const ALL_KEY_HEADERS = new Set(Object.values(KEY_HEADER));

/** Maximo の URL を検査して正規化する。proxy は 橋渡しの /mx と同じく https://host[:port] だけ */
export function parseVaultBaseUrl(raw: string, via: MaximoVia): { baseUrl: string; baseOrigin: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new VaultError("bad_request", "Maximo の URL を解析できません。");
  }
  if (u.username || u.password || u.search || u.hash) throw new VaultError("bad_request", "Maximo の URL に認証情報・クエリ・# を含めないでください。");
  const loopbackHttp = u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
  if (u.protocol !== "https:" && !(via === "direct" && loopbackHttp)) throw new VaultError("bad_request", "Maximo の URL は https にしてください。");
  const path = u.pathname.replace(/\/+$/, "");
  if (via === "proxy" && path !== "") throw new VaultError("bad_request", "proxy 方式の Maximo の URL にはパスを含めません。");
  return { baseUrl: `${u.origin}${path}`, baseOrigin: u.origin };
}

export class VaultCore {
  private readonly origin: string;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly onLock: ((reason: VaultLockReason) => void) | undefined;

  private state: UnlockedState | null = null;
  private lastActivityAt = 0;
  private timer: TimerHandle | undefined;

  constructor(opts: VaultCoreOptions) {
    this.origin = new URL(opts.origin).origin;
    this.idleMs = opts.idleMs ?? VAULT_IDLE_MS;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer = opts.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onLock = opts.onLock;
  }

  /** キーを受け取る。前のキーは置き換える */
  unlock(input: { apiKey: unknown; via: unknown; baseUrl: unknown }): void {
    if (input.via !== "proxy" && input.via !== "direct") throw new VaultError("bad_request", "接続方式が正しくありません。");
    if (typeof input.apiKey !== "string" || !API_KEY_RE.test(input.apiKey) || input.apiKey === VAULT_SENTINEL) {
      throw new VaultError("bad_request", "API キーが空か、使えない文字を含んでいます。");
    }
    if (typeof input.baseUrl !== "string") throw new VaultError("bad_request", "Maximo の URL がありません。");
    const { baseUrl, baseOrigin } = parseVaultBaseUrl(input.baseUrl, input.via);
    this.state = { apiKey: input.apiKey, via: input.via, baseUrl, baseOrigin };
    this.touch();
  }

  /** キーを消す。持っていたときだけ onLock を呼ぶ */
  lock(reason: VaultLockReason = "manual"): void {
    this.cancelTimer();
    if (this.state === null) return;
    this.state = null;
    try {
      this.onLock?.(reason);
    } catch {
      // 通知先の失敗でロックを止めない
    }
  }

  isUnlocked(): boolean {
    this.expireIfIdle();
    return this.state !== null;
  }

  /** 利用者の操作があった。自動ロックの時計を戻す */
  touch(): void {
    if (this.state === null) return;
    this.lastActivityAt = this.now();
    this.cancelTimer();
    this.scheduleCheck(this.idleMs);
  }

  /** 送り先の検査と番兵の置き換え。fetch に渡す URL と init を返す（キーを含むので外へ出さない） */
  prepare(req: VaultFetchRequest): { url: string; init: RequestInit } {
    this.expireIfIdle();
    const st = this.state;
    if (st === null) throw new VaultError("locked", "API キーはロックされています。設定画面で再接続してください。");

    const method = typeof req.method === "string" ? req.method.toUpperCase() : "";
    if (method !== "GET" && method !== "POST") throw new VaultError("bad_request", "GET と POST だけを送ります。");

    let url: URL;
    try {
      url = new URL(req.url, this.origin);
    } catch {
      throw new VaultError("forbidden_destination", "送り先の URL を解析できません。");
    }
    if (url.username || url.password || url.hash) throw new VaultError("forbidden_destination", "送り先の URL に認証情報や # を含めないでください。");
    if (url.href.includes(VAULT_SENTINEL) || (req.body !== null && req.body.includes(VAULT_SENTINEL))) {
      throw new VaultError("bad_request", "キーの置き換え用の文字列を URL や本文に入れないでください。");
    }

    const keyHeader = KEY_HEADER[st.via];
    if (st.via === "proxy") {
      if (url.origin !== this.origin || !url.pathname.startsWith("/mx/")) {
        throw new VaultError("forbidden_destination", "proxy 方式では、同一オリジンの /mx/ 配下にだけ API キーを付けて送ります。");
      }
      // /mx が転送する先（X-Maximo-Base）も、キーを受け取ったときの Maximo に限る
      const base = headerValue(req.headers, "x-maximo-base");
      if (base === null || base.replace(/\/+$/, "") !== st.baseUrl) {
        throw new VaultError("forbidden_destination", "接続した Maximo 以外へは API キーを付けて送りません。");
      }
    } else if (url.origin !== st.baseOrigin) {
      throw new VaultError("forbidden_destination", "direct 方式では、接続した Maximo のオリジンにだけ API キーを付けて送ります。");
    }

    const headers: Record<string, string> = {};
    const seen = new Set<string>();
    let replaced = false;
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value !== "string") throw new VaultError("bad_request", "ヘッダの値が文字列ではありません。");
      const lower = name.toLowerCase();
      // 大文字小文字違いの同名ヘッダ（送り先の検査をすり抜ける X-Maximo-Base の重ね付けなど）は受け付けない
      if (seen.has(lower)) throw new VaultError("bad_request", `ヘッダ ${lower} が重複しています。`);
      seen.add(lower);
      if (lower === keyHeader) {
        if (value !== VAULT_SENTINEL || replaced) throw new VaultError("bad_request", "API キーのヘッダが正しくありません。");
        headers[name] = st.apiKey;
        replaced = true;
        continue;
      }
      if (ALL_KEY_HEADERS.has(lower) || lower === "authorization" || lower === "cookie") {
        throw new VaultError("bad_request", `ヘッダ ${lower} は付けられません。`);
      }
      if (value.includes(VAULT_SENTINEL)) throw new VaultError("bad_request", "キーの置き換え用の文字列を別のヘッダに入れないでください。");
      headers[name] = value;
    }
    if (!replaced) throw new VaultError("bad_request", "API キーのヘッダがありません。");

    const init: RequestInit = {
      method,
      headers,
      // proxy（同一オリジンの /mx）はログインのセッション Cookie が要る。direct では Maximo へ Cookie を送らない（MaximoClient と同じ）
      credentials: st.via === "proxy" ? "same-origin" : "omit",
      redirect: "manual",
      cache: "no-store",
    };
    if (method === "POST" && req.body !== null) init.body = req.body;
    return { url: url.href, init };
  }

  /** 検査・置き換えをして送り、本文を文字列で返す */
  async execute(req: VaultFetchRequest, fetchImpl: VaultFetch, signal?: AbortSignal): Promise<VaultFetchResponse> {
    const { url, init } = this.prepare(req);
    if (signal) init.signal = signal;
    let res: Response;
    let bodyText: string;
    try {
      res = await fetchImpl(url, init);
      bodyText = await res.text();
    } catch {
      // 例外の中身（URL やヘッダを含みうる）は返さない
      if (signal?.aborted) throw new VaultError("aborted", "中止しました。");
      throw new VaultError("network", "Maximo へ通信できません。");
    }
    // redirect:"manual" のリダイレクトは status 0 の opaqueredirect になる。辿らずに通信エラーとして扱う
    if (res.type === "opaqueredirect" || res.status < 200 || res.status > 599) {
      throw new VaultError("network", "Maximo がリダイレクトを返しました。URL を確認してください。");
    }
    const headers: Record<string, string> = {};
    for (const name of PASS_RESPONSE_HEADERS) {
      const v = res.headers.get(name);
      if (v !== null) headers[name] = v;
    }
    return { status: res.status, statusText: res.statusText, headers, bodyText };
  }

  private scheduleCheck(ms: number): void {
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (this.expireIfIdle() || this.state === null) return;
      // タイマーが早く発火した場合（バックグラウンドでの間引きの補正など）は残りを待つ
      this.scheduleCheck(Math.max(1, this.idleMs - (this.now() - this.lastActivityAt)));
    }, ms);
  }

  private expireIfIdle(): boolean {
    if (this.state !== null && this.now() - this.lastActivityAt >= this.idleMs) {
      this.lock("idle");
      return true;
    }
    return false;
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }
}

function headerValue(headers: Record<string, string>, lowerName: string): string | null {
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() === lowerName) return value;
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function parseFetchRequest(v: unknown): VaultFetchRequest | null {
  if (!isRecord(v) || typeof v.url !== "string" || typeof v.method !== "string" || !isRecord(v.headers)) return null;
  if (v.body !== null && typeof v.body !== "string") return null;
  const headers: Record<string, string> = {};
  for (const [k, x] of Object.entries(v.headers)) {
    if (typeof x !== "string") return null;
    headers[k] = x;
  }
  return { url: v.url, method: v.method, headers, body: v.body };
}

export interface VaultEndpointOptions {
  core: VaultCore;
  post: (msg: VaultToMain) => void;
  fetchImpl: VaultFetch;
}

/** Worker の onmessage に渡す関数を作る（受信したメッセージを検査して VaultCore を呼ぶ） */
export function createVaultEndpoint(opts: VaultEndpointOptions): (data: unknown) => void {
  const { core, post, fetchImpl } = opts;
  const aborts = new Map<number, AbortController>();
  const fail = (id: number, e: unknown) => {
    const code: VaultErrorCode = e instanceof VaultError ? e.code : "bad_request";
    const message = e instanceof VaultError ? e.message : "処理できない要求です。";
    post({ type: "reply", id, ok: false, code, message });
  };
  return (data: unknown) => {
    if (!isRecord(data)) return;
    switch (data.type) {
      case "activity":
        core.touch();
        return;
      case "unlock": {
        if (!isId(data.id)) return;
        try {
          core.unlock({ apiKey: data.apiKey, via: data.via, baseUrl: data.baseUrl });
          post({ type: "reply", id: data.id, ok: true });
        } catch (e) {
          fail(data.id, e);
        }
        return;
      }
      case "lock":
        if (!isId(data.id)) return;
        core.lock("manual");
        post({ type: "reply", id: data.id, ok: true });
        return;
      case "abort":
        if (isId(data.id)) aborts.get(data.id)?.abort();
        return;
      case "fetch": {
        if (!isId(data.id)) return;
        const id = data.id;
        const req = parseFetchRequest(data.request);
        if (!req) {
          fail(id, new VaultError("bad_request", "送信の要求が正しくありません。"));
          return;
        }
        const controller = new AbortController();
        aborts.set(id, controller);
        core
          .execute(req, fetchImpl, controller.signal)
          .then(
            (response) => post({ type: "reply", id, ok: true, response }),
            (e: unknown) => fail(id, e),
          )
          .finally(() => aborts.delete(id));
        return;
      }
      default:
        return;
    }
  };
}
