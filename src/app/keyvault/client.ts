// メインスレッド側の API キー保管の窓口（ConnectionProvider の実装）。
// - キーそのものは持たない。connect で受け取ったキーはすぐ Web Worker へ渡し、手元に残さない。
// - MaximoClient は apiKey に番兵を返し、fetchImpl で Worker に送信を頼む。Worker が番兵を本物のキーに置き換える。
// - Worker が自動ロックしたら current() は null になる。

import type { ConnectionProvider, MaximoConnection, MaximoConnectionInfo } from "../runtime/contracts";
import { MaximoClient, isRecord, type FetchLike, type MaximoClientOptions, type MaximoVia } from "../maximo/client";
import { VAULT_SENTINEL, type MainToVault, type VaultErrorCode, type VaultFetchResponse, type VaultLockReason, type VaultToMain } from "./protocol";

export interface VaultTransport {
  post(msg: MainToVault): void;
  listen(listener: (msg: VaultToMain) => void): void;
  terminate(): void;
  /** Worker を起動できない・壊れたことを知らせる（任意）。待っている要求を終わらせるために使う */
  onFailure?(listener: (message: string) => void): void;
}

export const VAULT_WORKER_UNAVAILABLE = "API キーの保管用 Worker を起動できませんでした。ページを再読み込みしてください。";

/** 専用 Web Worker を起動する。起動できないときは、待たせずに失敗を返す transport にする */
export function createWorkerTransport(): VaultTransport {
  let notifyFailure: ((message: string) => void) | null = null;
  const fail = (message: string) => notifyFailure?.(message);
  let worker: Worker;
  try {
    worker = new Worker(new URL("./vault.worker.ts", import.meta.url), { type: "module" });
  } catch {
    // 例外の中身は出さない（パスなどを含みうる）
    return {
      post: () => fail(VAULT_WORKER_UNAVAILABLE),
      listen: () => undefined,
      terminate: () => undefined,
      onFailure: (listener) => {
        notifyFailure = listener;
      },
    };
  }
  const w = worker;
  w.onerror = () => fail(VAULT_WORKER_UNAVAILABLE);
  w.onmessageerror = () => fail("API キーの保管用 Worker との通信に失敗しました。");
  return {
    post: (msg) => w.postMessage(msg),
    listen: (listener) => {
      w.onmessage = (ev: MessageEvent<unknown>) => listener(ev.data as VaultToMain);
    },
    terminate: () => w.terminate(),
    onFailure: (listener) => {
      notifyFailure = listener;
    },
  };
}

export class VaultRequestError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultRequestError";
    this.code = code;
  }
}

export interface ConnectInput {
  baseUrl: string;
  via: MaximoVia;
  connectionName: string;
  apiKey: string;
}

export type VaultView =
  | { kind: "disconnected" }
  | { kind: "connected"; info: MaximoConnectionInfo }
  | { kind: "locked"; info: MaximoConnectionInfo; reason: VaultLockReason };

export interface KeyVaultOptions {
  transport: VaultTransport;
  now?: () => number;
  createClient?: (opts: MaximoClientOptions) => MaximoClient;
  /** 操作の通知を Worker へ送る最短の間隔 */
  activityThrottleMs?: number;
  /** unlock / lock の応答を待つ上限（通信を伴わないので短くてよい）。超えたら失敗にする */
  controlTimeoutMs?: number;
}

/**
 * Worker が送る前に止めた要求は、MaximoClient に「送っていない」と分かる HTTP 応答として返す
 * （通信エラーにすると、書き込みで結果不明と扱われるため）。本文は 橋渡しの /mx と同じ {ok:false,error,message} の形。
 */
const REFUSED: Record<"locked" | "forbidden_destination" | "bad_request", { status: number; statusText: string; error: string }> = {
  locked: { status: 423, statusText: "Locked", error: "vault_locked" },
  forbidden_destination: { status: 403, statusText: "Forbidden", error: "vault_forbidden_destination" },
  bad_request: { status: 400, statusText: "Bad Request", error: "vault_bad_request" },
};

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

interface Pending {
  resolve: (response: VaultFetchResponse | undefined) => void;
  reject: (e: Error) => void;
}

/** whoami の応答から Maximo の利用者名を取り出す。【応答の形は実機で未確認。候補のキーを順に見る】 */
export function whoamiUserName(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const byLower = new Map(Object.entries(body).map(([k, v]) => [k.toLowerCase(), v] as const));
  for (const k of ["username", "loginid", "personid", "displayname"]) {
    const v = byLower.get(k);
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (h === undefined) return out;
  if (typeof Headers !== "undefined" && h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) if (k !== undefined && v !== undefined) out[k] = v;
  } else {
    for (const [k, v] of Object.entries(h as Record<string, string>)) out[k] = v;
  }
  return out;
}

function abortError(): Error {
  return typeof DOMException === "function" ? new DOMException("中止しました", "AbortError") : new Error("中止しました");
}

function toResponse(r: VaultFetchResponse): Response {
  if (r.status < 200 || r.status > 599) throw new TypeError("Maximo の応答を受け取れませんでした");
  return new Response(NULL_BODY_STATUSES.has(r.status) ? null : r.bodyText, { status: r.status, statusText: r.statusText, headers: r.headers });
}

function refusedResponse(code: keyof typeof REFUSED, message: string): Response {
  const r = REFUSED[code];
  return new Response(JSON.stringify({ ok: false, error: r.error, message }), {
    status: r.status,
    statusText: r.statusText,
    headers: { "content-type": "application/json" },
  });
}

export class KeyVault implements ConnectionProvider {
  private readonly transport: VaultTransport;
  private readonly now: () => number;
  private readonly createClient: (opts: MaximoClientOptions) => MaximoClient;
  private readonly activityThrottleMs: number;
  private readonly controlTimeoutMs: number;

  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<() => void>();
  private conn: MaximoConnection | null = null;
  private view: VaultView = { kind: "disconnected" };
  private lastActivityPostAt = Number.NEGATIVE_INFINITY;
  private connectSeq = 0;
  private disposed = false;

  constructor(opts: KeyVaultOptions) {
    this.transport = opts.transport;
    this.now = opts.now ?? (() => Date.now());
    this.createClient = opts.createClient ?? ((o) => new MaximoClient(o));
    this.activityThrottleMs = opts.activityThrottleMs ?? 15_000;
    this.controlTimeoutMs = opts.controlTimeoutMs ?? 15_000;
    this.transport.listen((msg) => this.onMessage(msg));
    this.transport.onFailure?.((message) => this.failAll(message));
  }

  /** Worker が使えなくなった。待っている要求を終わらせ、接続は無いものとして扱う */
  private failAll(message: string): void {
    const waiting = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of waiting) p.reject(new VaultRequestError("network", message));
    if (this.view.kind === "connected") this.setState(null, { kind: "locked", info: this.view.info, reason: "manual" });
    else this.setState(null, { kind: "disconnected" });
  }

  current(): MaximoConnection | null {
    return this.conn;
  }

  getView(): VaultView {
    return this.view;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * キーを Worker に渡して whoami で確かめる。失敗したら Worker のキーを消して例外を投げる。
   * 呼び出し側は input を変数に残さないこと（フォームの値はこの呼び出しに直接渡して入力欄を空にする）。
   */
  async connect(input: ConnectInput): Promise<MaximoConnectionInfo> {
    const seq = ++this.connectSeq;
    // 送る前に URL を検査する（不正ならキーを Worker へ渡さない）
    const client = this.createClient({ baseUrl: input.baseUrl, via: input.via, apiKey: () => VAULT_SENTINEL, fetchImpl: this.fetchImpl });
    const via = input.via;
    const connectionName = input.connectionName;
    const unlocked = this.request((id) => ({ type: "unlock", id, apiKey: input.apiKey, via, baseUrl: client.baseUrl }));
    this.setState(null, { kind: "disconnected" });
    try {
      await unlocked;
      const body = await client.get(`${client.apiRoot}/whoami`);
      if (seq !== this.connectSeq) throw new Error("別の接続を始めたため、この接続は取りやめました。");
      const info: MaximoConnectionInfo = { baseUrl: client.baseUrl, via, connectionName, userName: whoamiUserName(body), connectedAt: this.now() };
      this.setState({ info, client }, { kind: "connected", info });
      return info;
    } catch (e) {
      if (seq === this.connectSeq) this.request((id) => ({ type: "lock", id })).catch(() => undefined);
      throw e;
    }
  }

  /** 接続を切る（Worker のキーを消す） */
  disconnect(): void {
    this.connectSeq++;
    this.setState(null, { kind: "disconnected" });
    this.request((id) => ({ type: "lock", id })).catch(() => undefined);
  }

  /** 利用者の操作を Worker に知らせる（自動ロックの時計を戻す）。間引いて送る */
  noteActivity(): void {
    if (this.view.kind !== "connected") return;
    const t = this.now();
    if (t - this.lastActivityPostAt < this.activityThrottleMs) return;
    this.lastActivityPostAt = t;
    this.transport.post({ type: "activity" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const p of this.pending.values()) p.reject(new Error("キーの保管を終了しました"));
    this.pending.clear();
    this.setState(null, { kind: "disconnected" });
    this.transport.terminate();
  }

  /** MaximoClient の fetchImpl。キーのヘッダには番兵が入っている */
  private readonly fetchImpl: FetchLike = (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? null;
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const request = {
        url: input,
        method: (init.method ?? "GET").toUpperCase(),
        headers: headersToRecord(init.headers),
        body: typeof init.body === "string" ? init.body : null,
      };
      let id = -1;
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        this.transport.post({ type: "abort", id });
        reject(abortError());
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      id = this.send((i) => ({ type: "fetch", id: i, request }), {
        resolve: (res) => {
          cleanup();
          if (!res) {
            reject(new TypeError("Maximo の応答を受け取れませんでした"));
            return;
          }
          try {
            resolve(toResponse(res));
          } catch (e) {
            reject(e instanceof Error ? e : new TypeError("Maximo の応答を受け取れませんでした"));
          }
        },
        reject: (e) => {
          cleanup();
          if (e instanceof VaultRequestError && (e.code === "locked" || e.code === "forbidden_destination" || e.code === "bad_request")) {
            resolve(refusedResponse(e.code, e.message));
          } else if (e instanceof VaultRequestError && e.code === "aborted") {
            reject(abortError());
          } else {
            reject(new TypeError("Maximo へ通信できません"));
          }
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });

  /** unlock / lock。Worker が黙ったままにならないよう時間切れを付ける（fetch は MaximoClient 側で中止する） */
  private request(build: (id: number) => MainToVault): Promise<VaultFetchResponse | undefined> {
    return new Promise((resolve, reject) => {
      let id = -1;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new VaultRequestError("network", "API キーの保管用 Worker が応答しません。ページを再読み込みしてください。"));
      }, this.controlTimeoutMs);
      id = this.send(build, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  private send(build: (id: number) => MainToVault, pending: Pending): number {
    const id = ++this.seq;
    if (this.disposed) {
      pending.reject(new Error("キーの保管を終了しました"));
      return id;
    }
    this.pending.set(id, pending);
    try {
      this.transport.post(build(id));
    } catch {
      this.pending.delete(id);
      pending.reject(new Error("キーの保管用の Worker に送れませんでした"));
    }
    return id;
  }

  private onMessage(msg: VaultToMain): void {
    if (!isRecord(msg)) return;
    if (msg.type === "locked") {
      if (this.view.kind === "connected") this.setState(null, { kind: "locked", info: this.view.info, reason: msg.reason });
      return;
    }
    if (msg.type === "reply") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.response);
      else p.reject(new VaultRequestError(msg.code, msg.message));
    }
  }

  private setState(conn: MaximoConnection | null, view: VaultView): void {
    const same = this.conn === conn && this.view.kind === view.kind && ("info" in this.view ? this.view.info : null) === ("info" in view ? view.info : null);
    this.conn = conn;
    this.view = view;
    if (same) return;
    for (const l of Array.from(this.listeners)) {
      try {
        l();
      } catch {
        // 表示側の失敗で接続の状態を壊さない
      }
    }
  }
}
