// dist/app の静的配信。SPA なので /・/app・/settings・/structures は index.html を返す。

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

const CONTENT_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  // PWA のマニフェスト（ブラウザは application/manifest+json 以外だと警告を出す）
  [".webmanifest", "application/manifest+json"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream";
}

/**
 * URL のパスを配信ディレクトリの中の実ファイルに直す。
 * 外に出る指定（.. や絶対パス）は null にする。
 */
export function resolveStaticPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  // Windows のドライブ指定・UNC・区切りの揺れをまとめて弾く
  if (/^[a-zA-Z]:/.test(decoded) || decoded.includes("\\")) return null;
  const rel = normalize(decoded).replace(/^[/\\]+/, "");
  const full = resolve(root, rel);
  const base = resolve(root);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}


/** 名前にハッシュが入る資材（vite の出力は /assets/ 配下） */
export function isHashedAsset(pathname: string): boolean {
  return pathname.startsWith("/assets/");
}

/** SPA の入口（画面の中で history API により切り替える。src/app/ui/routes.ts と同じ） */
const SPA_PATHS = new Set(["/", "/app", "/settings", "/structures"]);

export function isSpaPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  return SPA_PATHS.has(p);
}

/**
 * 実ファイルが無かったときに index.html を返してよいパスか。
 * 画面は /app と /settings 以外のパスも自分で /app へ寄せる（src/app/ui/routes.ts の resolveRoute）ので、
 * 打ち間違いや古いブックマークでも画面が出るようにする。
 * ただし拡張子の付いたパス（/assets/index-abc.js など）は、消えた資材の代わりに HTML を返すと
 * 画面が「module の読み込みに失敗した」という分かりにくい形で壊れるため 404 のままにする。
 */
export function isSpaFallbackPath(pathname: string): boolean {
  if (isHashedAsset(pathname)) return false;
  const last = pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  return !last.includes(".");
}

/** 配信するファイルを決める。見つからなければ null */
export async function pickFile(root: string, pathname: string): Promise<string | null> {
  if (isSpaPath(pathname)) return join(resolve(root), "index.html");
  const full = resolveStaticPath(root, pathname);
  if (full) {
    try {
      const info = await stat(full);
      if (info.isFile()) return full;
      if (info.isDirectory()) {
        const index = join(full, "index.html");
        const sub = await stat(index);
        if (sub.isFile()) return index;
      }
    } catch {
      // 実ファイルが無ければ下の SPA の受け皿に回す
    }
  }
  if (!isSpaFallbackPath(pathname)) return null;
  const index = join(resolve(root), "index.html");
  try {
    return (await stat(index)).isFile() ? index : null;
  } catch {
    return null;
  }
}

export interface ServeStaticOptions {
  root: string;
  /** HEAD では本文を送らない */
  head?: boolean;
}

/** 静的ファイルを返す。見つからなければ false（呼び出し側が 404 を返す） */
export async function serveStatic(res: ServerResponse, pathname: string, opts: ServeStaticOptions): Promise<boolean> {
  const file = await pickFile(opts.root, pathname);
  if (!file) return false;
  // ファイル名にハッシュが入る /assets/ だけ長く持たせる。
  // それ以外（index.html・sw.js など名前が変わらないもの）は毎回取りに来させる
  const cacheControl = isHashedAsset(pathname) ? "public, max-age=31536000, immutable" : "no-store";
  return sendFile(res, file, { ...opts, cacheControl });
}

async function sendFile(
  res: ServerResponse,
  file: string,
  opts: ServeStaticOptions & { cacheControl: string; extraHeaders?: Record<string, string> },
): Promise<boolean> {
  let size = 0;
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    size = info.size;
  } catch {
    return false;
  }
  const headers: Record<string, string> = {
    "Content-Type": contentTypeFor(file),
    "Content-Length": String(size),
    "X-Content-Type-Options": "nosniff",
    // 画面は外への送信で URL を漏らさない
    "Referrer-Policy": "no-referrer",
    // 他のサイトに iframe で埋め込ませない。ログインが無いので、
    // 埋め込まれると見えないタブとして中継につながり primary を奪われたり、[Maximo に反映] を押させる
    // クリックジャッキングの足場にされうる（画面は iframe で使わない。src/app/settings/SettingsPage.tsx）
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "Cache-Control": opts.cacheControl,
    ...opts.extraHeaders,
  };
  res.writeHead(200, headers);
  if (opts.head) {
    res.end();
    return true;
  }
  await new Promise<void>((done) => {
    const stream = createReadStream(file);
    stream.on("error", () => {
      res.destroy();
      done();
    });
    stream.on("end", () => done());
    stream.pipe(res);
  });
  return true;
}
