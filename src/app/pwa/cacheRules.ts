// Service Worker の判断（純ロジック）。sw.ts とビルド時の差し込み（vite.config.ts）から使う。
//
// ここに置く理由: Service Worker の中では試験ができないため、判断だけを取り出して試験する。
// 【重要】このファイルは画面側（main.tsx から辿れる側）から import しない。
// import すると rollup が共有チャンクを作り、sw.js が import 文を持つ（＝古典スクリプトとして登録できない）。

/** キャッシュ名の接頭辞。ここで始まる古いキャッシュは activate で消す */
export const CACHE_PREFIX = "mxstudio-app-";

/** オフラインのときに画面の枠として返すファイル */
export const APP_SHELL_PATH = "/index.html";

/** ビルド時に差し込む目印（vite.config.ts の plugin が中身に置き換える） */
export const PRECACHE_MARKER = "__MXSTUDIO_PRECACHE__";
export const BUILD_MARKER = "__MXSTUDIO_BUILD__";

/** 画面のファイルではないが先読みしておくもの（publicDir の中身はバンドルに現れないため、ここに書く） */
export const STATIC_PRECACHE: readonly string[] = [
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/favicon.svg",
  "/favicon-32.png",
  "/apple-touch-icon.png",
];

/**
 * 応答を絶対に保存しないパス（同一オリジン）。橋渡しがその場で作って返すもの。
 * Maximo の応答（/mx）・中継（/ws）・取り込み（/import）・橋渡しの状態と Skill の一覧（/_mxstudio）。
 * ここを間違えると作業データがブラウザのディスクに残ったり、古い一覧を出し続けたりする。
 */
const NEVER_CACHED = ["/mx", "/ws", "/import", "/_mxstudio"] as const;

/** 先読みの対象にする拡張子（.map は入れない。ソースマップはオフラインの動作に要らない） */
const PRECACHE_EXTENSIONS = [".html", ".js", ".css", ".webmanifest", ".png", ".svg", ".ico", ".webp", ".woff2", ".woff"] as const;

export function isNeverCached(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return NEVER_CACHED.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/** ビルドの出力のうち、先読みするファイルか（sw.js 自身と .map は除く） */
export function shouldPrecache(fileName: string): boolean {
  const name = fileName.toLowerCase();
  if (name === "sw.js" || name.endsWith(".map")) return false;
  return PRECACHE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** ビルドの出力の一覧から、先読みする URL の一覧を作る（並びは固定。重複は取り除く） */
export function precacheList(fileNames: readonly string[], statics: readonly string[] = STATIC_PRECACHE): string[] {
  const urls = new Set<string>();
  for (const name of fileNames) {
    if (shouldPrecache(name)) urls.add(name.startsWith("/") ? name : `/${name}`);
  }
  for (const s of statics) urls.add(s);
  return Array.from(urls).sort();
}

/** 先読みする一覧から版を決める（中身が変わればキャッシュ名が変わる）。FNV-1a・32bit */
export function buildIdFrom(urls: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const url of [...urls].sort()) {
    for (let i = 0; i < url.length; i++) {
      hash ^= url.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x2f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function cacheNameOf(buildId: string): string {
  return `${CACHE_PREFIX}${buildId}`;
}

/** activate で消すキャッシュか（このツールのもので、いまの版ではないもの） */
export function isStaleCache(name: string, current: string): boolean {
  return name.startsWith(CACHE_PREFIX) && name !== current;
}

/** ビルド時に差し込まれなかったときに備えて、値の形を確かめる */
export function asFileList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.startsWith("/")) : [];
}

/** 目印（__MXSTUDIO_… のまま）だったときは fallback を返す。差し込み前でもキャッシュ名が壊れないように */
export function asBuildId(value: unknown, fallback = "dev"): string {
  return typeof value === "string" && value !== "" && !value.startsWith("__MXSTUDIO") ? value : fallback;
}

// ---------------------------------------------------------------------------
// 要求の扱い方
// ---------------------------------------------------------------------------

/**
 * navigate: 画面の遷移。ネットワークを先に試し、駄目なら保存してある枠を返す
 * cache-first: ハッシュ付きの静的ファイル。保存してあればそれを返す
 * network-only: Service Worker は何もしない（Maximo の応答・ツールの結果・中継・他オリジン）
 */
export type FetchPlan = "navigate" | "cache-first" | "network-only";

export interface RequestInfo {
  method: string;
  /** Request.mode（"navigate" なら画面の遷移） */
  mode: string;
  url: string;
}

export function planFor(req: RequestInfo, swOrigin: string): FetchPlan {
  if (req.method.toUpperCase() !== "GET") return "network-only";
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return "network-only";
  }
  // 他オリジン（direct 方式の Maximo・CDN など）には触らない
  if (url.origin !== swOrigin) return "network-only";
  // 画面の枠を返してよいのは、画面が持っているパスの遷移だけ（取り込みなどの URL に枠を返さない）
  if (isNeverCached(url.pathname)) return "network-only";
  if (req.mode === "navigate") return "navigate";
  return "cache-first";
}

/** 取ってきた応答を保存してよいか（作業データを保存しないための最後の関門） */
export function mayStore(req: RequestInfo, swOrigin: string, res: { status: number; type?: string; contentType?: string | null }): boolean {
  if (planFor(req, swOrigin) !== "cache-first") return false;
  if (res.status !== 200) return false;
  // HTML は保存しない。画面の枠は install のときに /index.html として先読みしてある
  if ((res.contentType ?? "").toLowerCase().includes("text/html")) return false;
  // opaque（CORS 無しの他オリジン）は中身を確かめられないので保存しない
  return res.type === undefined || res.type === "basic" || res.type === "default";
}

/**
 * 先読み（install と、枠の取り直し）で取ってきた応答の扱い。
 * - skip: 保存しない（200 以外・同一オリジンでない応答）
 * - store: そのまま保存する
 * - rewrap: 転送を経た同一オリジンの応答。中身とヘッダだけを新しい応答に詰め直して保存する。
 *   静的配信によっては /index.html を / へ転送する。転送を経た応答（redirected）をそのまま
 *   画面の遷移に返すとブラウザはネットワークエラーにする（オフラインで立ち上がらない）。
 */
export type PrecachePlan = "skip" | "store" | "rewrap";

export function precachePlanFor(res: { status: number; type?: string; redirected?: boolean }): PrecachePlan {
  if (res.status !== 200) return "skip";
  if (res.type !== undefined && res.type !== "basic" && res.type !== "default") return "skip";
  return res.redirected === true ? "rewrap" : "store";
}

// ---------------------------------------------------------------------------
// ビルド時の差し込み
// ---------------------------------------------------------------------------

/**
 * sw.js の中の目印（文字列リテラル）を JSON に置き換える。
 * 目印がちょうど 1 つでなければ例外にする（黙って差し込みに失敗すると、
 * 先読みが空のまま出荷されてオフラインで立ち上がらなくなる）。
 */
export function replaceMarker(code: string, marker: string, value: unknown): string {
  const json = JSON.stringify(value);
  const quotes = ['"', "'", "`"];
  const found = quotes.filter((q) => code.includes(`${q}${marker}${q}`));
  if (found.length === 0) throw new Error(`sw.js に目印 ${marker} が見つかりません`);
  let out = code;
  let count = 0;
  for (const q of found) {
    const token = `${q}${marker}${q}`;
    count += out.split(token).length - 1;
    out = out.split(token).join(json);
  }
  if (count !== 1) throw new Error(`sw.js の目印 ${marker} が ${count} 個あります（1 個のはず）`);
  return out;
}

/**
 * sw.js が単独で動くか（import / export が残っていれば古典スクリプトとして登録できない）。
 * 見つかった箇所の前後を返す。何が残っているか分からないと直せないため。null なら問題なし。
 */
export function findModuleSyntax(code: string): string | null {
  // 文の先頭（ファイルの先頭・; ・} ・改行の後）の import / export だけを見る。
  // 文字列の中の "/import" のような字面に引っかからないため。
  const statement = /(?:^|[;}\n])\s*/.source;
  for (const re of [
    new RegExp(`${statement}import\\s*[{*'"\`]`),
    new RegExp(`${statement}import\\s+[A-Za-z_$]`),
    /(?:^|[^\w."'`/])import\s*\(/,
    new RegExp(`${statement}export\\s*[{*]`),
    new RegExp(`${statement}export\\s+default\\b`),
  ]) {
    const m = re.exec(code);
    if (m) return code.slice(Math.max(0, m.index - 40), m.index + 80);
  }
  return null;
}

export function hasModuleSyntax(code: string): boolean {
  return findModuleSyntax(code) !== null;
}
