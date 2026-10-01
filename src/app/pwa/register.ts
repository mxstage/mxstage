// Service Worker の登録と「新しい版があります」の知らせ（画面側）。
// 勝手に入れ替えない（skipWaiting しない）ので、入れ替わるのは次にこの画面を開き直したとき。

import { uiMessages } from "../ui/messages";

export const SW_URL = "/sw.js";

/** 新しい版を用意したときの知らせ（今の言語の文言） */
export function updateReadyMessage(): string {
  return uiMessages().updateReady;
}

/** 使う部分だけの型（試験で偽物を渡せるように） */
export interface ServiceWorkerLike {
  readonly state: string;
  addEventListener(type: "statechange", listener: () => void): void;
}

export interface RegistrationLike {
  readonly installing: ServiceWorkerLike | null;
  readonly waiting: ServiceWorkerLike | null;
  addEventListener(type: "updatefound", listener: () => void): void;
}

export interface ServiceWorkerContainerLike {
  readonly controller: unknown;
  register(url: string, options?: { scope?: string }): Promise<RegistrationLike>;
}

/**
 * 新しい版が使える状態になったか。
 * この画面を読み込んだ時点で制御している Service Worker が既にあった（＝2 回目以降の起動）ときだけ知らせる。
 * 初回の登録では「更新」ではないので黙っている。
 *
 * hasController は「登録を始めた時点の控え」であって、そのときどきの navigator.serviceWorker.controller ではない。
 * 初回の登録でも activate の clients.claim() で controller が付くので、
 * 都度いまの値を見ると、まっさらな PC の 1 回目の起動で「新しい版を用意しました」と誤って出る。
 */
export function isUpdateReady(state: string, hasController: boolean): boolean {
  return hasController && (state === "installed" || state === "activated");
}

export interface RegisterOptions {
  container: ServiceWorkerContainerLike;
  /** 新しい版が用意できたときに 1 回だけ呼ぶ */
  onUpdate?: (message: string) => void;
  url?: string;
}

/**
 * 登録する。失敗しても画面は動かす（例外は投げない）。
 * 失敗の中身は console に出さない（URL などを含みうるため）。
 */
export async function registerServiceWorker(opts: RegisterOptions): Promise<RegistrationLike | null> {
  const { container } = opts;
  // 【控えを先に取る】この画面が既に Service Worker に制御されて読み込まれたかどうか。
  // register() より後や statechange のたびに見ると、初回の clients.claim() で付いた controller を
  // 「更新が来た」と取り違える。
  const hadController = container.controller !== null && container.controller !== undefined;
  let registration: RegistrationLike;
  try {
    registration = await container.register(opts.url ?? SW_URL, { scope: "/" });
  } catch {
    return null;
  }
  const notify = once(() => opts.onUpdate?.(updateReadyMessage()));
  const watch = (worker: ServiceWorkerLike | null) => {
    if (!worker) return;
    const check = () => {
      if (isUpdateReady(worker.state, hadController)) notify();
    };
    worker.addEventListener("statechange", check);
    check();
  };
  // 既に待機中のものがあれば、その場で知らせる
  watch(registration.waiting);
  watch(registration.installing);
  registration.addEventListener("updatefound", () => watch(registration.installing));
  return registration;
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/** ブラウザの navigator.serviceWorker（使えなければ null） */
export function browserServiceWorker(): ServiceWorkerContainerLike | null {
  try {
    const sw = navigator.serviceWorker as unknown as ServiceWorkerContainerLike | undefined;
    return sw && typeof sw.register === "function" ? sw : null;
  } catch {
    return null;
  }
}
