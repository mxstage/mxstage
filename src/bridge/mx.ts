// /mx/*: Maximo（MAS Manage REST）への無状態プロキシ（ローカル版）。
// 約束:
//   - キーはリクエストごとに X-Maximo-Apikey で受け取り、apikey ヘッダとして転送する。
//   - 保存もログ出力もしない（キーは console にもファイルにも書かない）。
//   - GET と POST だけ。転送するヘッダは絞る。Cookie は送らない。リダイレクトは追わない。
// ローカルではブラウザの CORS 制約を外すのが目的なので、宛先ホストの許可リストは既定で無制限にする
// （--allow-host で絞れる）。

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage, RequestOptions, ServerResponse } from "node:http";

/**
 * 上流（Maximo）への要求の時間の上限。応答の頭が届くまでの時間と、本文が途切れている時間の両方に使う。
 * 上限が無いと、応答しない Maximo への要求がタブの fetch と上流の接続をいつまでも抱える。
 */
export const MX_UPSTREAM_TIMEOUT_MS = 60_000;

/** 転送するリクエストヘッダ（これ以外は送らない。Cookie・Authorization も送らない） */
const FORWARD_HEADERS = ["accept", "content-type", "x-method-override", "patchtype", "properties", "transactionid", "batcherror", "if-match", "x-public-uri"];

const ALLOWED_PREFIXES = ["/maximo/api/", "/maximo/oslc/"];

/** 転送しない応答ヘッダ（上流に、こちらのオリジンの方針を決めさせない） */
const DROP_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "set-cookie2",
  "www-authenticate",
  "proxy-authenticate",
  "clear-site-data",
  "refresh",
  "link",
  "alt-svc",
  "strict-transport-security",
  "content-security-policy",
  "content-security-policy-report-only",
  "permissions-policy",
  "report-to",
  "reporting-endpoints",
  "nel",
  "service-worker-allowed",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "origin-agent-cluster",
  "x-frame-options",
  // Node が受け取った本文の長さは自分で決め直すので、上流の値は使わない
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

export interface ProxyError {
  status: number;
  error: string;
  message: string;
}

/** 上流の応答ヘッダから、転送してよいものだけを残す */
export function sanitizeUpstreamHeaders(upstream: NodeJS.Dict<string | string[]>, status: number): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(upstream)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(lower) || lower.startsWith("access-control-")) continue;
    // リダイレクトはブラウザに辿らせない（辿るとキーのヘッダ付きで別オリジンへ行こうとする）
    if (lower === "location" && status >= 300 && status < 400) continue;
    out[name] = value;
  }
  out["Cache-Control"] = "no-store";
  out["X-Content-Type-Options"] = "nosniff";
  out["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'; sandbox";
  return out;
}

/** X-Maximo-Base を検証して転送先のオリジンを返す */
export function parseMaximoBase(value: string | undefined, allowedHosts: string[]): { origin: string } | ProxyError {
  if (!value) return { status: 400, error: "missing_base", message: "X-Maximo-Base ヘッダが必要です。" };
  let base: URL;
  try {
    base = new URL(value);
  } catch {
    return { status: 400, error: "invalid_base", message: "X-Maximo-Base は https://host[:port] の形で指定してください。" };
  }
  if (base.protocol !== "https:" || base.username || base.password || (base.pathname !== "/" && base.pathname !== "") || base.search || base.hash) {
    return { status: 400, error: "invalid_base", message: "X-Maximo-Base は https://host[:port] の形で指定してください。" };
  }
  // 許可リストが空なら制限しない（ローカルなので既定は無制限）
  if (allowedHosts.length > 0) {
    const hostname = base.hostname.toLowerCase();
    const host = base.host.toLowerCase();
    if (!allowedHosts.includes(hostname) && !allowedHosts.includes(host)) {
      return { status: 403, error: "host_not_allowed", message: "この Maximo ホストへの接続は許可されていません（--allow-host）。" };
    }
  }
  return { origin: base.origin };
}

/** /mx を除いたパスと検索文字列が転送してよいものか調べる */
export function checkProxyPath(path: string, search: string): ProxyError | null {
  if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
    return { status: 403, error: "path_not_allowed", message: "転送できるのは /mx/maximo/api/ と /mx/maximo/oslc/ で始まるパスだけです。" };
  }
  // 符号化した区切りやドット、二重符号化（%25）、Java サーブレットのパスパラメータ（..;/ で上に出る）を防ぐ
  if (/%2e|%2f|%5c|%25|\\|;/i.test(path) || path.split("/").some((seg) => seg === "." || seg === "..")) {
    return { status: 400, error: "invalid_path", message: "パスに使えない文字が含まれています。" };
  }
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const key of params.keys()) {
    if (key.toLowerCase() === "apikey") {
      return { status: 400, error: "apikey_in_query", message: "API キーをクエリに入れないでください。X-Maximo-Apikey ヘッダで送ってください。" };
    }
  }
  return null;
}

/** 転送するヘッダだけを取り出し、apikey を足す */
export function forwardHeaders(incoming: NodeJS.Dict<string | string[]>, apikey: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARD_HEADERS) {
    const v = incoming[name];
    const value = Array.isArray(v) ? v[0] : v;
    if (typeof value === "string") headers[name] = value;
  }
  headers["apikey"] = apikey;
  return headers;
}

/** 上流へ要求を出す関数（試験で差し替える） */
export type UpstreamRequest = (options: RequestOptions & { rejectUnauthorized?: boolean }, onResponse: (res: IncomingMessage) => void) => ClientRequest;

export interface MaximoProxyOptions {
  /** 空なら無制限 */
  allowedHosts: string[];
  /** 自己署名証明書の Maximo に届かせる（この接続だけ検証を切る） */
  insecure: boolean;
  /** 既定は node:https / node:http の request */
  requestImpl?: UpstreamRequest | undefined;
  /** 上流への要求の時間の上限（既定 MX_UPSTREAM_TIMEOUT_MS） */
  timeoutMs?: number | undefined;
  /** 保存した接続先のオリジンと API キー（あれば X-Maximo-Base・X-Maximo-Apikey は読まない。src/bridge/connections.ts） */
  saved?: { origin: string; apiKey: string } | undefined;
}

function sendError(res: ServerResponse, err: ProxyError): void {
  const body = JSON.stringify({ ok: false, error: err.error, message: err.message });
  res.writeHead(err.status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** /mx/* を Maximo へ転送する */
export function handleMaximoProxy(req: IncomingMessage, res: ServerResponse, url: URL, opts: MaximoProxyOptions): void {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    sendError(res, { status: 405, error: "method_not_allowed", message: "GET と POST だけを転送します。" });
    return;
  }

  const path = url.pathname.slice("/mx".length);
  const pathError = checkProxyPath(path, url.search);
  if (pathError) {
    sendError(res, pathError);
    return;
  }

  const baseHeader = req.headers["x-maximo-base"];
  const base = parseMaximoBase(opts.saved ? opts.saved.origin : Array.isArray(baseHeader) ? baseHeader[0] : baseHeader, opts.allowedHosts);
  if (!("origin" in base)) {
    sendError(res, base);
    return;
  }

  const keyHeader = req.headers["x-maximo-apikey"];
  const apikey = opts.saved ? opts.saved.apiKey : Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
  if (!apikey) {
    sendError(res, { status: 400, error: "missing_apikey", message: "X-Maximo-Apikey ヘッダが必要です。" });
    return;
  }

  const target = new URL(base.origin + path + url.search);
  const headers = forwardHeaders(req.headers, apikey);
  const length = req.headers["content-length"];
  if (method === "POST" && typeof length === "string") headers["content-length"] = length;

  const send: UpstreamRequest = opts.requestImpl ?? (target.protocol === "https:" ? (httpsRequest as UpstreamRequest) : (httpRequest as UpstreamRequest));
  const timeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : MX_UPSTREAM_TIMEOUT_MS;
  let timedOut = false;
  let responded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  /** 上限を過ぎたら上流の要求を切る（応答の頭の前なら 504 を返す） */
  const arm = (onTimeout: () => void): void => {
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      timedOut = true;
      onTimeout();
    }, timeoutMs);
  };

  const upstream = send(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method,
      headers,
      // 自己署名証明書を受け入れるのはこの接続だけ（プロセス全体の設定は変えない）
      rejectUnauthorized: !opts.insecure,
    },
    (upRes: IncomingMessage) => {
      responded = true;
      if (timedOut) {
        upRes.destroy();
        return;
      }
      const status = upRes.statusCode ?? 502;
      res.writeHead(status, sanitizeUpstreamHeaders(upRes.headers, status));
      // 本文が途切れたまま上限を過ぎたら切る（ヘッダは送ってあるので、接続を切ってタブに失敗を知らせる）
      const idle = (): void =>
        arm(() => {
          upRes.destroy();
          upstream.destroy();
          res.destroy();
        });
      idle();
      upRes.on("data", idle);
      upRes.on("end", clearTimer);
      upRes.on("close", clearTimer);
      upRes.pipe(res);
      upRes.on("error", () => {
        clearTimer();
        res.destroy();
      });
    },
  );

  // 応答の頭が上限までに届かなければ 504
  if (!responded) arm(() => {
    upstream.destroy();
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) sendError(res, { status: 504, error: "upstream_timeout", message: `Maximo が ${Math.round(timeoutMs / 1000)} 秒以内に応答しませんでした。Maximo の状態を確認するか、対象を絞ってもう一度実行してください。` });
    else res.destroy();
  });

  upstream.on("error", () => {
    if (timedOut) return;
    clearTimer();
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) sendError(res, { status: 502, error: "upstream_unreachable", message: "Maximo に接続できませんでした。URL と証明書を確認してください。" });
    else res.destroy();
  });

  // タブが要求を取り消した（fetch の中断・タブを閉じた）ら Maximo への要求も切る。
  // 切らないと、誰も読まない応答を Maximo から受け取り続け、上流の接続が残る
  res.on("close", () => {
    clearTimer();
    if (!res.writableFinished) upstream.destroy();
  });

  if (method === "POST") {
    req.pipe(upstream);
    req.on("error", () => upstream.destroy());
  } else {
    upstream.end();
  }
}
