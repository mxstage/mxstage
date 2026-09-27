// ローカルの入口を守る検査。
// ログインの代わりに「127.0.0.1 に来られる＝その PC の利用者」を根拠にするので、
// 他のホスト名で名前解決させて外から入られること（DNS リバインディング）を必ず止める。

/** 受け付けるホスト名（Host ヘッダ・Origin のホスト部） */
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** 受け付ける接続元アドレス */
const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** ループバックからの接続か（TCP の相手アドレスで判定する） */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  return LOCAL_ADDRESSES.has(address.toLowerCase());
}

/** Host ヘッダのホスト部とポート部に分ける（IPv6 の [::1]:8788 も扱う） */
export function splitHostHeader(host: string): { hostname: string; port: string } | null {
  const value = host.trim();
  if (value === "") return null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return null;
    const hostname = value.slice(0, end + 1);
    const rest = value.slice(end + 1);
    if (rest === "") return { hostname, port: "" };
    if (!rest.startsWith(":")) return null;
    return { hostname, port: rest.slice(1) };
  }
  const colon = value.indexOf(":");
  if (colon < 0) return { hostname: value, port: "" };
  if (value.indexOf(":", colon + 1) >= 0) return null; // ポートの無い IPv6 は受けない
  return { hostname: value.slice(0, colon), port: value.slice(colon + 1) };
}

/**
 * Host ヘッダが自分自身を指しているか。
 * ホスト名が 127.0.0.1 / localhost / [::1] のいずれかで、ポートが待ち受けているポートと同じときだけ通す。
 */
export function isLocalHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const parts = splitHostHeader(host);
  if (!parts) return false;
  if (!LOCAL_HOSTNAMES.has(parts.hostname.toLowerCase())) return false;
  if (parts.port === "") return port === 80;
  return parts.port === String(port);
}

/** この橋渡しが配っている画面のオリジン（Origin ヘッダと突き合わせる） */
export function localOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
}

/** Origin が自分の配信元と一致するか（WebSocket と /mx で使う） */
export function isLocalOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return false;
  return localOrigins(port).includes(origin.trim().toLowerCase());
}

/**
 * 状態を変えない安全なメソッドか。Origin を付けない同一オリジンの GET を止めないために使う
 */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

export interface RequestGuardInput {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  remoteAddress: string | undefined;
}

export type GuardResult = { ok: true } | { ok: false; status: number; error: string; message: string };

export interface GuardOptions {
  /**
   * ブラウザ以外の道具（curl など）からの POST も受ける入口か。
   * create_import_session が配る 1 回限りの URL（/import/<importId>）にだけ付ける。
   * curl は Origin も Sec-Fetch-Site も付けないので、ここを閉じると案内した curl が必ず 403 になる。
   * 当て推量できない importId が合言葉なので、ブラウザから来た要求（Origin か Sec-Fetch-Site がある）は
   * これまでどおり同一オリジンだけを通す。
   */
  allowNonBrowserWrite?: boolean;
}

/** ローカルの HTTP 要求を検査する（すべての経路の入口で最初に呼ぶ） */
export function checkRequest(input: RequestGuardInput, port: number, opts: GuardOptions = {}): GuardResult {
  if (!isLoopbackAddress(input.remoteAddress)) {
    return { ok: false, status: 403, error: "forbidden_remote", message: "この PC（127.0.0.1）からの接続だけを受け付けます。" };
  }
  if (!isLocalHost(input.host, port)) {
    return { ok: false, status: 403, error: "forbidden_host", message: "Host は 127.0.0.1 または localhost にしてください。" };
  }
  if (input.origin !== undefined && !isLocalOrigin(input.origin, port)) {
    return { ok: false, status: 403, error: "forbidden_origin", message: "同一オリジンからのリクエストだけを受け付けます。" };
  }
  if (input.origin === undefined) {
    const site = input.secFetchSite;
    if (site !== undefined && site !== "same-origin" && site !== "none") {
      return { ok: false, status: 403, error: "forbidden_origin", message: "同一オリジンからのリクエストだけを受け付けます。" };
    }
    if (site === undefined && !SAFE_METHODS.has(input.method.toUpperCase()) && opts.allowNonBrowserWrite !== true) {
      return { ok: false, status: 403, error: "forbidden_origin", message: "同一オリジンからのリクエストだけを受け付けます。" };
    }
  }
  return { ok: true };
}

/** WebSocket の Upgrade は Origin の一致を必ず求める（ブラウザは必ず付ける） */
export function checkUpgrade(input: RequestGuardInput, port: number): GuardResult {
  const base = checkRequest({ ...input, method: "GET" }, port);
  if (!base.ok) return base;
  if (!isLocalOrigin(input.origin, port)) {
    return { ok: false, status: 403, error: "forbidden_origin", message: "同一オリジンからの接続だけを受け付けます。" };
  }
  return { ok: true };
}
