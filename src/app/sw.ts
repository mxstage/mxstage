// Service Worker。画面（HTML/JS/CSS/アイコン）だけを保存し、2 回目からはネットワーク無しでも立ち上がるようにする。
//
// 【保存しないもの】Maximo の応答（/mx）・中継（/ws）・取り込み・橋渡しの状態と Skill の一覧（/_mxstudio）・他オリジン。
//   作業データと資格情報をブラウザのディスクに残さないため、判断は cacheRules.ts の 1 か所に集める。
// 【更新】新しい版が来ても勝手に入れ替えない（skipWaiting しない）。画面に知らせて、次に開き直したときに入れ替わる。
// 【依存】import するのは cacheRules.ts だけ（共有チャンクを作らせず、単独で動く 1 ファイルに保つ）。

import {
  APP_SHELL_PATH,
  asBuildId,
  asFileList,
  cacheNameOf,
  isStaleCache,
  mayStore,
  planFor,
  precachePlanFor,
  type RequestInfo as PlanRequest,
} from "./pwa/cacheRules";

/** Service Worker のグローバルのうち使う部分だけ（tsconfig の lib に WebWorker を入れないため最小の型で扱う） */
interface ExtendableEventLike {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface ServiceWorkerScope {
  readonly location: { origin: string };
  readonly clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", listener: (ev: ExtendableEventLike) => void): void;
  addEventListener(type: "fetch", listener: (ev: FetchEventLike) => void): void;
}

const scope = self as unknown as ServiceWorkerScope;

// ビルド時に vite の plugin がこの文字列リテラルを中身に置き換える
// （cacheRules.ts の PRECACHE_MARKER / BUILD_MARKER と同じ綴り。違っていればビルドが止まる）。
// 置き換わらなかったときは先読みしない＝ただの素通しになる。
const PRECACHE_RAW: unknown = "__MXSTUDIO_PRECACHE__";
const BUILD_RAW: unknown = "__MXSTUDIO_BUILD__";
const PRECACHE = asFileList(PRECACHE_RAW);
const BUILD_ID = asBuildId(BUILD_RAW);
const CACHE_NAME = cacheNameOf(BUILD_ID);
const ORIGIN = scope.location.origin;

scope.addEventListener("install", (ev) => {
  ev.waitUntil(precache());
});

scope.addEventListener("activate", (ev) => {
  ev.waitUntil(cleanup());
});

scope.addEventListener("fetch", (ev) => {
  const request = ev.request;
  const info: PlanRequest = { method: request.method, mode: request.mode, url: request.url };
  const plan = planFor(info, ORIGIN);
  if (plan === "network-only") return;
  if (plan === "navigate") {
    ev.respondWith(navigateFirst(request));
    // 先読みで枠を取りこぼしていたら、ここで取り直す（install は 1 回きりなので放っておくと直らない）
    ev.waitUntil(ensureShell());
    return;
  }
  ev.respondWith(cacheFirst(request, info));
});

/**
 * 先読み。1 件ずつ入れる。
 * 【cache.addAll を使わない理由】addAll は 1 件でも取れないと何も保存しない。
 * install は版ごとに 1 回しか走らないので、そのときたまたま 1 件取れなかっただけで
 * 「オフラインで立ち上がらないが、誰も気づかない PWA」になる。
 */
async function precache(): Promise<void> {
  if (PRECACHE.length === 0) return;
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(PRECACHE.map((url) => store(cache, url)));
}

/** 1 件取ってきて保存する。取れなくても install は止めない（実行時に取りに行く） */
async function store(cache: Cache, url: string): Promise<boolean> {
  try {
    // cache: "reload" で、ブラウザの HTTP キャッシュに残った古い応答を先読みしない
    const res = await fetch(new Request(url, { cache: "reload" }));
    // 判断は cacheRules.ts（転送を経た応答は詰め直す。理由はそちらに書いてある）
    const plan = precachePlanFor({ status: res.status, type: res.type, redirected: res.redirected });
    if (plan === "skip") return false;
    const clean = plan === "rewrap" ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers }) : res;
    await cache.put(url, clean);
    return true;
  } catch {
    return false;
  }
}

/** 画面の枠が保存されているか。無ければ取り直す（オフラインのときは何もせず、次の遷移でまた試す） */
let shellReady = false;

async function ensureShell(): Promise<void> {
  if (shellReady) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    if (await cache.match(APP_SHELL_PATH)) {
      shellReady = true;
      return;
    }
    shellReady = await store(cache, APP_SHELL_PATH);
  } catch {
    // 次の遷移でまた試す
  }
}

async function cleanup(): Promise<void> {
  const names = await caches.keys();
  await Promise.all(names.filter((n) => isStaleCache(n, CACHE_NAME)).map((n) => caches.delete(n)));
  // 初回の登録でも、いま開いている画面から使えるようにする
  await scope.clients.claim();
}

/** 画面の遷移: ネットワークを先に試し、届かなければ保存してある枠を返す（応答そのものは保存しない） */
async function navigateFirst(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const shell = await cache.match(APP_SHELL_PATH);
    if (shell) return shell;
    return new Response("オフラインです。ネットワークにつながってからもう一度開いてください。", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

/**
 * ハッシュ付きの静的ファイル: 保存してあればそれを返し、無ければ取ってきて保存する。
 * 鍵は URL の文字列だけにする（要求のヘッダをキャッシュに残さない。先読み（URL で保存）とも確実に突き合う）。
 */
async function cacheFirst(request: Request, info: PlanRequest): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(info.url);
  if (hit) return hit;
  const res = await fetch(request);
  if (mayStore(info, ORIGIN, { status: res.status, type: res.type, contentType: res.headers.get("content-type") })) {
    try {
      await cache.put(info.url, res.clone());
    } catch {
      // 保存できなくても応答は返す
    }
  }
  return res;
}
