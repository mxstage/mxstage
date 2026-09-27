// タブの tool.progress（Hub DO の RPC で届く）を MCP の notifications/progress に変換する。
// 目的はクライアントの無応答タイムアウトを延ばすこと（Claude Code は無応答が続くと切る）。
// - progressToken が無い呼び出しでは送らない。
// - 間隔を空けて送る（PROGRESS_NOTIFY_INTERVAL_MS に 1 回。間引いた値は後から送らない）。
// - MCP の仕様どおり progress は送るたびに増やす（増えない値は送らない）。
// - close() の後は送らない。結果を返す前に close() を待ち、送信中の通知を結果より先に書き終える。
// 通知の中身は console に出さない。

import type { InvokeProgress } from "../shared/protocol.ts";

export const PROGRESS_NOTIFY_INTERVAL_MS = 500;
/** close() で送信中の通知を待つ上限 */
export const PROGRESS_FLUSH_TIMEOUT_MS = 1_000;
/** 通知の message の上限（Hub は 4,000 字で切っている） */
export const MAX_PROGRESS_NOTIFY_MESSAGE_CHARS = 1_000;

export type ProgressToken = string | number;

export interface ProgressNotificationMessage {
  method: "notifications/progress";
  params: { progressToken: ProgressToken; progress: number; total?: number; message?: string };
}

export type ProgressNotifyFn = (notification: ProgressNotificationMessage) => Promise<void>;

export interface ProgressForwarderOptions {
  intervalMs?: number;
  flushTimeoutMs?: number;
  now?: () => number;
}

export interface ProgressForwarder {
  /** Hub の invoke(req, onProgress) に渡す。DO からは RPC のスタブ経由で呼ばれる */
  readonly onProgress: (progress: InvokeProgress) => void;
  /** 以後の進捗を捨て、送信中の通知が書き終わるのを待つ（上限 flushTimeoutMs） */
  close(): Promise<void>;
}

/** params._meta.progressToken を取り出す（文字列か有限の数だけ） */
export function progressTokenOf(meta: unknown): ProgressToken | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const token = (meta as { progressToken?: unknown }).progressToken;
  if (typeof token === "string") return token;
  if (typeof token === "number" && Number.isFinite(token)) return token;
  return undefined;
}

export function createProgressForwarder(token: ProgressToken, notify: ProgressNotifyFn, opts: ProgressForwarderOptions = {}): ProgressForwarder {
  const intervalMs = opts.intervalMs ?? PROGRESS_NOTIFY_INTERVAL_MS;
  const flushTimeoutMs = opts.flushTimeoutMs ?? PROGRESS_FLUSH_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const inflight = new Set<Promise<void>>();
  let closed = false;
  let lastSentAt: number | null = null;
  let lastProgress: number | null = null;

  const onProgress = (p: InvokeProgress): void => {
    if (closed || !p || typeof p !== "object") return;
    const { progress, total, message } = p;
    if (typeof progress !== "number" || !Number.isFinite(progress)) return;
    if (lastProgress !== null && progress <= lastProgress) return;
    const at = now();
    if (lastSentAt !== null && at - lastSentAt < intervalMs) return;

    const params: ProgressNotificationMessage["params"] = { progressToken: token, progress };
    if (typeof total === "number" && Number.isFinite(total)) params.total = total;
    if (typeof message === "string" && message.length > 0) params.message = message.slice(0, MAX_PROGRESS_NOTIFY_MESSAGE_CHARS);
    lastSentAt = at;
    lastProgress = progress;

    let sending: Promise<void>;
    try {
      // 送れなくても（クライアントが去った等）呼び出しは続ける
      sending = Promise.resolve(notify({ method: "notifications/progress", params })).catch(() => undefined);
    } catch {
      return;
    }
    inflight.add(sending);
    void sending.finally(() => inflight.delete(sending));
  };

  const close = async (): Promise<void> => {
    closed = true;
    if (inflight.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, flushTimeoutMs);
    });
    try {
      await Promise.race([Promise.allSettled([...inflight]).then(() => undefined), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return { onProgress, close };
}
