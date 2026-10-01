// Maximo REST（MAS Manage）クライアント。作業タブで動く。
// - API キーはリクエストごとにヘッダで送り、URL（クエリ）には載せない。
// - ログは出さない（ヘッダ・本文・キーを console に出さない）。
// - GET だけ 429/502/503/504 と通信エラーで指数バックオフにより再試行する。書き込みは再試行しない
//   （transactionid の窓を越えて Add が重複するのを防ぐため）。

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type MaximoVia = "proxy" | "direct";

export interface MaximoClientOptions {
  /** Maximo のオリジン（例 https://maximo.example.com）。末尾の / は取り除く */
  baseUrl: string;
  /** API キーを返す関数。クライアントはキーを保持せず、呼び出しごとに取り出す */
  apiKey: () => string;
  /** proxy: 橋渡しの /mx 経由、direct: ブラウザから Maximo へ直接（CORS 設定が必要） */
  via: MaximoVia;
  /**
   * 橋渡しに保存した接続先の ID（proxy だけ）。あれば API キーを送らず、橋渡しがキーを付ける（src/bridge/connections.ts）。
   * このとき apiKey は使わない
   */
  connectionId?: string;
  fetchImpl?: FetchLike;
  /** 再試行の待ち。試験で待たないよう差し替える */
  sleep?: (ms: number) => Promise<void>;
  /** 再試行の初回待ち時間（2 倍ずつ伸ばす） */
  retryBaseMs?: number;
  /** GET の再試行回数の上限 */
  maxRetries?: number;
  /** 1 リクエストのタイムアウト */
  timeoutMs?: number;
  /** Maximo のコンテキストルート。既定 /maximo */
  contextRoot?: string;
}

/** Maximo が返したエラー（{Error:{reasonCode,message,statusCode}}）。判定は reasonCode で行う */
export class MaximoError extends Error {
  readonly status: number;
  readonly reasonCode: string | null;
  constructor(status: number, reasonCode: string | null, message: string) {
    super(message);
    this.name = "MaximoError";
    this.status = status;
    this.reasonCode = reasonCode;
  }
}

/** 通信エラー・タイムアウト。書き込みでは「結果不明」として扱う */
export class MaximoNetworkError extends Error {
  readonly timedOut: boolean;
  constructor(message: string, timedOut: boolean) {
    super(message);
    this.name = "MaximoNetworkError";
    this.timedOut = timedOut;
  }
}

export interface MaximoResponse {
  status: number;
  /** JSON を解析した本文。空なら null */
  body: unknown;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 30_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MaximoClient {
  readonly baseUrl: string;
  readonly via: MaximoVia;
  readonly contextRoot: string;
  /** 例 /maximo/api */
  readonly apiRoot: string;
  private readonly apiKey: () => string;
  /** 橋渡しに保存した接続先の ID（無ければ null） */
  readonly connectionId: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryBaseMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(opts: MaximoClientOptions) {
    const base = new URL(opts.baseUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("baseUrl must be an http(s) URL");
    if (base.search || base.hash || base.username || base.password) throw new Error("baseUrl must not contain a query, fragment or credentials");
    // http では API キーが平文で流れる。ローカルの試験環境（ループバック）だけ許す
    if (base.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
      throw new Error("baseUrl must use https (http only for loopback)");
    }
    this.baseUrl = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
    // 橋渡しの /mx は X-Maximo-Base に https://host[:port] だけを受け付けるので、送る前に同じ条件で止める
    if (opts.via === "proxy" && (base.protocol !== "https:" || this.baseUrl !== base.origin)) {
      throw new Error("A baseUrl through the proxy must be https://host[:port] (no path)");
    }
    this.via = opts.via;
    if (opts.connectionId !== undefined && opts.via !== "proxy") throw new Error("A saved connection works only through the proxy");
    this.connectionId = opts.connectionId ?? null;
    this.contextRoot = (opts.contextRoot ?? "/maximo").replace(/\/+$/, "");
    if (!/^\/[A-Za-z0-9_\-/]*$/.test(this.contextRoot)) throw new Error("Invalid contextRoot");
    this.apiRoot = `${this.contextRoot}/api`;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /**
   * Maximo が返した href（nextPage や member の href）を、このクライアントで送る path+query に付け替える。
   * href のオリジンは使わない（Maximo が内部ホスト名を返すことがあり、別オリジンへ送らないため）。
   * コンテキストルート配下でなければ拒否する。
   */
  hrefToPath(href: string): string {
    let u: URL;
    try {
      u = new URL(href, "http://placeholder.invalid");
    } catch {
      throw new Error("Cannot parse href");
    }
    if (u.hash) throw new Error("href must not contain a fragment");
    // 符号化したドット・区切り・二重符号化（%25）・Java サーブレットのパスパラメータ（..;/）・ドットだけの区切りで
    // コンテキストルートの外へ出るのを防ぐ（/mx プロキシと同じ規則）。
    // URL の解析は %2e や .. を正規化してしまうので、解析前の文字列で調べる
    const rawPath = href.replace(/[?#][\s\S]*$/, "");
    if (/%2e|%2f|%5c|%25|\\|;/i.test(rawPath)) throw new Error("The href path contains characters that cannot be used");
    const rawPathOnly = rawPath.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, "");
    if (rawPathOnly.split("/").some((seg) => seg === "." || seg === "..")) throw new Error("The href path must not contain . or ..");
    if (!u.pathname.startsWith(`${this.contextRoot}/`)) throw new Error("href is not under the Maximo context root");
    return `${u.pathname}${u.search}`;
  }

  /** GET して JSON を返す。429/502/503/504 と通信エラーは指数バックオフで再試行する */
  async get<T = unknown>(path: string): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.fetchOnce("GET", path, {}, undefined);
        if (res.status >= 200 && res.status < 300) {
          if (res.body === null) throw new MaximoError(res.status, null, "Empty Maximo response");
          if (hasErrorBody(res.body)) throw toMaximoError(res.status, res.body);
          return res.body as T;
        }
        const err = toMaximoError(res.status, res.body);
        if (!RETRY_STATUSES.has(res.status) || attempt >= this.maxRetries) throw err;
        await this.sleep(Math.max(this.backoff(attempt), Math.min(res.retryAfterMs ?? 0, MAX_RETRY_AFTER_MS)));
      } catch (e) {
        if (!(e instanceof MaximoNetworkError) || attempt >= this.maxRetries) throw e;
        await this.sleep(this.backoff(attempt));
      }
      attempt++;
    }
  }

  /**
   * 書き込み（POST）。再試行しない。
   * - 2xx 以外（2xx でも本文が {Error:{...}} のもの）と、JSON でない応答は MaximoError
   * - 通信エラー・タイムアウトは MaximoNetworkError
   * - それ以外の Error は送る前に止めたもの（path の不正・API キー未設定など。リクエストは送っていない）
   */
  async post(path: string, headers: Record<string, string>, body: unknown): Promise<MaximoResponse> {
    const res = await this.fetchOnce("POST", path, headers, JSON.stringify(body));
    if (res.status >= 200 && res.status < 300 && !hasErrorBody(res.body)) return { status: res.status, body: res.body };
    throw toMaximoError(res.status, res.body);
  }

  private backoff(attempt: number): number {
    return this.retryBaseMs * 2 ** attempt;
  }

  private buildUrl(path: string): string {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("path must be a relative path starting with /");
    const q = path.indexOf("?");
    if (q >= 0 && /(^|[?&])apikey=/i.test(path.slice(q))) throw new Error("Do not put the API key in the query");
    return this.via === "proxy" ? `/mx${path}` : `${this.baseUrl}${path}`;
  }

  private buildHeaders(extra: Record<string, string>): Record<string, string> {
    if (this.connectionId !== null) return { accept: "application/json", ...extra, "X-Maximo-Connection": this.connectionId };
    const key = this.apiKey();
    if (!key) throw new Error("The Maximo API key is not set");
    const headers: Record<string, string> = { accept: "application/json", ...extra };
    if (this.via === "proxy") {
      headers["X-Maximo-Base"] = this.baseUrl;
      headers["X-Maximo-Apikey"] = key;
    } else {
      headers["apikey"] = key;
    }
    return headers;
  }

  private async fetchOnce(
    method: "GET" | "POST",
    path: string,
    extraHeaders: Record<string, string>,
    body: string | undefined,
  ): Promise<{ status: number; body: unknown; retryAfterMs: number | null }> {
    const url = this.buildUrl(path);
    const headers = this.buildHeaders(extraHeaders);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      // proxy（同一オリジンの /mx）はログインのセッション Cookie が要る。direct では Maximo へ Cookie を送らない
      const credentials: RequestCredentials = this.via === "proxy" ? "same-origin" : "omit";
      const init: RequestInit = { method, headers, signal: controller.signal, credentials, redirect: "manual" };
      if (body !== undefined) init.body = body;
      res = await this.fetchImpl(url, init);
      text = await res.text();
    } catch {
      // 例外の中身（URL やヘッダを含みうる）はメッセージに含めない
      throw new MaximoNetworkError(timedOut ? "The request to Maximo timed out" : "Cannot reach Maximo", timedOut);
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown = null;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        // ログイン画面の HTML などを 200 で返されることがあるので、JSON 以外は受け付けない
        throw new MaximoError(res.status, null, `The Maximo response is not JSON (HTTP ${res.status})`);
      }
    }
    const ra = res.headers.get("retry-after");
    const retryAfterMs = ra !== null && /^\d+$/.test(ra) ? Number(ra) * 1000 : null;
    return { status: res.status, body: parsed, retryAfterMs };
  }
}

/** Maximo のエラー応答を MaximoError に変換する */
export function toMaximoError(status: number, body: unknown): MaximoError {
  const obj = isRecord(body) ? body : null;
  const errObj = obj && (isRecord(obj.Error) ? obj.Error : isRecord(obj.error) ? obj.error : null);
  const reasonCode = errObj && typeof errObj.reasonCode === "string" && errObj.reasonCode !== "" ? errObj.reasonCode : null;
  // 橋渡しの /mx 自身が返すエラー（{ok:false, error:"コード", message}）は Maximo の reasonCode にせず、メッセージだけ使う
  const proxyMessage =
    obj && obj.ok === false && typeof obj.error === "string" && typeof obj.message === "string" && obj.message !== "" ? `${obj.message}（/mx: ${obj.error}）` : null;
  const message = errObj && typeof errObj.message === "string" && errObj.message !== "" ? errObj.message : (proxyMessage ?? `Maximo returned an error (HTTP ${status})`);
  let code = status;
  if (errObj && (typeof errObj.statusCode === "string" || typeof errObj.statusCode === "number")) {
    const n = Number(errObj.statusCode);
    if (Number.isInteger(n) && n >= 400 && n < 600 && (status < 400 || status >= 600)) code = n;
  }
  return new MaximoError(code, reasonCode, message);
}

/** 2xx でも本文の最上位が {Error:{...}} ならエラーとして扱う（batcherror 指定時などに備える。実機の形は P0-3 で確認する） */
function hasErrorBody(body: unknown): boolean {
  return isRecord(body) && isRecord(body.Error);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
