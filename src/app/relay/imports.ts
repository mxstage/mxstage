// import.chunk（橋渡しの /import/:ticket が Hub 経由でタブへ流すファイルの断片）を組み立てる。
// - 断片は importId ごとに seq 0 から連続で届く（src/bridge/importUpload.ts。生バイト 512KB ごとに base64）。
// - 欠番・重複・順不同・サイズ不一致・上限超過は、その importId を丸ごと破棄して onImportError で知らせる。
// - ファイルの中身は console に出さない。

import type { ImportChunkMsg } from "../../shared/protocol";

export type TimerHandle = unknown;
export type SetTimeoutFn = (fn: () => void, ms: number) => TimerHandle;
export type ClearTimeoutFn = (handle: TimerHandle) => void;

/** 1 ファイルの上限。橋渡しの IMPORT_MAX_BYTES（src/bridge/importUpload.ts）と同じ 20MB */
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
/** 続きの断片をこれだけ待っても来なければ破棄する */
export const IMPORT_IDLE_MS = 5 * 60 * 1000;
/** 同時に組み立てる importId の数 */
export const IMPORT_MAX_CONCURRENT = 3;
/** 破棄・完了した importId を覚えておく数（残りの断片が届くたびに onImportError を出さないため） */
const CLOSED_MEMORY = 64;
const MAX_IMPORT_ID_LENGTH = 256;
const MAX_FILE_NAME_LENGTH = 1_024;
const MAX_CONTENT_TYPE_LENGTH = 256;

export interface ImportedFile {
  importId: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  /** 小文字 16 進の SHA-256（Worker が curl に返す sha256 と同じ表記） */
  sha256: string;
}

export type ImportErrorReason =
  /** 欠番・重複・順不同、または seq 0 以外から始まった */
  | "sequence"
  /** 受け取ったバイト数が totalBytes と合わない（途中で totalBytes が変わった場合も含む） */
  | "size_mismatch"
  /** 上限（20MB）を超えた */
  | "too_large"
  /** 同時に扱える importId の数を超えた */
  | "too_many"
  /** 続きが IMPORT_IDLE_MS 来なかった */
  | "timeout"
  /** base64 として読めなかった */
  | "invalid_data"
  /** sha256 を計算できなかった（安全でないオリジンで crypto.subtle が無い等） */
  | "digest_failed";

export interface ImportAssemblerOptions {
  onImport?(file: ImportedFile): void;
  onImportError?(importId: string, reason: ImportErrorReason): void;
  setTimeout?: SetTimeoutFn;
  clearTimeout?: ClearTimeoutFn;
  /** SHA-256 の計算（既定は crypto.subtle.digest） */
  digest?(bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
  maxBytes?: number;
  idleMs?: number;
  maxConcurrent?: number;
}

interface PendingImport {
  importId: string;
  fileName: string;
  contentType: string;
  totalBytes: number;
  nextSeq: number;
  received: number;
  parts: Uint8Array[];
  timer: TimerHandle | undefined;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** import.chunk の形を検査する。合わなければ null */
export function parseImportChunk(v: unknown): ImportChunkMsg | null {
  if (!isObj(v) || v.type !== "import.chunk") return null;
  if (typeof v.importId !== "string" || v.importId.length === 0 || v.importId.length > MAX_IMPORT_ID_LENGTH) return null;
  if (!isCount(v.seq) || !isCount(v.totalBytes)) return null;
  if (typeof v.data !== "string" || typeof v.last !== "boolean") return null;
  if (typeof v.fileName !== "string" || typeof v.contentType !== "string") return null;
  return {
    type: "import.chunk",
    importId: v.importId,
    seq: v.seq,
    data: v.data,
    last: v.last,
    fileName: v.fileName.slice(0, MAX_FILE_NAME_LENGTH),
    contentType: v.contentType.slice(0, MAX_CONTENT_TYPE_LENGTH),
    totalBytes: v.totalBytes,
  };
}

export class ImportAssembler {
  private readonly onImport: ((file: ImportedFile) => void) | undefined;
  private readonly onImportError: ((importId: string, reason: ImportErrorReason) => void) | undefined;
  private readonly setTimer: SetTimeoutFn;
  private readonly clearTimer: ClearTimeoutFn;
  private readonly digest: (bytes: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;
  private readonly maxBytes: number;
  private readonly idleMs: number;
  private readonly maxConcurrent: number;

  private readonly active = new Map<string, PendingImport>();
  private readonly closed = new Set<string>();
  /** dispose() で進める。計算中の sha256 が後から終わっても通知しないために使う */
  private generation = 0;

  constructor(opts: ImportAssemblerOptions = {}) {
    this.onImport = opts.onImport;
    this.onImportError = opts.onImportError;
    this.setTimer = opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer = opts.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
    this.digest = opts.digest ?? ((bytes) => (globalThis as unknown as { crypto: Crypto }).crypto.subtle.digest("SHA-256", bytes));
    this.maxBytes = opts.maxBytes ?? IMPORT_MAX_BYTES;
    this.idleMs = opts.idleMs ?? IMPORT_IDLE_MS;
    this.maxConcurrent = opts.maxConcurrent ?? IMPORT_MAX_CONCURRENT;
  }

  /** 組み立て中の importId の数 */
  get activeCount(): number {
    return this.active.size;
  }

  push(msg: ImportChunkMsg): void {
    const id = msg.importId;
    // 破棄・完了済みの importId の残りは黙って捨てる
    if (this.closed.has(id)) return;

    let entry = this.active.get(id);
    if (!entry) {
      if (msg.seq !== 0) {
        this.fail(id, "sequence");
        return;
      }
      if (this.active.size >= this.maxConcurrent) {
        this.fail(id, "too_many");
        return;
      }
      if (msg.totalBytes > this.maxBytes) {
        this.fail(id, "too_large");
        return;
      }
      entry = {
        importId: id,
        fileName: msg.fileName,
        contentType: msg.contentType,
        totalBytes: msg.totalBytes,
        nextSeq: 0,
        received: 0,
        parts: [],
        timer: undefined,
      };
      this.active.set(id, entry);
    } else if (msg.seq !== entry.nextSeq) {
      this.abandon(entry, "sequence");
      return;
    } else if (msg.totalBytes !== entry.totalBytes) {
      this.abandon(entry, "size_mismatch");
      return;
    }

    // デコードする前に、base64 の長さから分かる上限（パディングの 2 バイト分は許す）で弾く
    const upperBound = Math.floor((msg.data.length * 3) / 4);
    if (entry.received + upperBound > this.maxBytes + 2) {
      this.abandon(entry, "too_large");
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(msg.data);
    } catch {
      this.abandon(entry, "invalid_data");
      return;
    }
    entry.received += bytes.byteLength;
    if (entry.received > this.maxBytes) {
      this.abandon(entry, "too_large");
      return;
    }
    if (entry.received > entry.totalBytes) {
      this.abandon(entry, "size_mismatch");
      return;
    }
    entry.parts.push(bytes);
    entry.nextSeq += 1;

    if (msg.last) {
      this.finish(entry);
      return;
    }
    this.armIdleTimer(entry);
  }

  /** 組み立て中のものとタイマーをすべて捨てる（通知はしない） */
  dispose(): void {
    this.generation += 1;
    for (const entry of this.active.values()) this.clearIdleTimer(entry);
    this.active.clear();
    this.closed.clear();
  }

  // -------------------------------------------------------------------------

  private finish(entry: PendingImport): void {
    this.release(entry);
    this.remember(entry.importId);
    if (entry.received !== entry.totalBytes) {
      this.emitError(entry.importId, "size_mismatch");
      return;
    }
    const bytes = new Uint8Array(entry.received);
    let offset = 0;
    for (const part of entry.parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    entry.parts = [];

    const generation = this.generation;
    let digesting: Promise<ArrayBuffer>;
    try {
      digesting = Promise.resolve(this.digest(bytes));
    } catch (err) {
      digesting = Promise.reject(err);
    }
    digesting.then(
      (hash) => {
        if (generation !== this.generation) return;
        const file: ImportedFile = {
          importId: entry.importId,
          fileName: entry.fileName,
          contentType: entry.contentType,
          bytes,
          sha256: toHex(hash),
        };
        try {
          this.onImport?.(file);
        } catch {
          // 受け取り側の失敗で組み立て処理を止めない
        }
      },
      () => {
        if (generation !== this.generation) return;
        this.emitError(entry.importId, "digest_failed");
      },
    );
  }

  private abandon(entry: PendingImport, reason: ImportErrorReason): void {
    this.release(entry);
    entry.parts = [];
    this.fail(entry.importId, reason);
  }

  private fail(importId: string, reason: ImportErrorReason): void {
    this.remember(importId);
    this.emitError(importId, reason);
  }

  private emitError(importId: string, reason: ImportErrorReason): void {
    try {
      this.onImportError?.(importId, reason);
    } catch {
      // 受け取り側の失敗で組み立て処理を止めない
    }
  }

  private release(entry: PendingImport): void {
    this.clearIdleTimer(entry);
    if (this.active.get(entry.importId) === entry) this.active.delete(entry.importId);
  }

  private remember(importId: string): void {
    this.closed.delete(importId);
    this.closed.add(importId);
    while (this.closed.size > CLOSED_MEMORY) {
      const oldest = this.closed.values().next();
      if (oldest.done) break;
      this.closed.delete(oldest.value);
    }
  }

  private armIdleTimer(entry: PendingImport): void {
    this.clearIdleTimer(entry);
    entry.timer = this.setTimer(() => {
      entry.timer = undefined;
      if (this.active.get(entry.importId) !== entry) return;
      this.abandon(entry, "timeout");
    }, this.idleMs);
  }

  private clearIdleTimer(entry: PendingImport): void {
    if (entry.timer === undefined) return;
    this.clearTimer(entry.timer);
    entry.timer = undefined;
  }
}

/** base64 をバイト列にする。不正な文字があれば例外（atob が投げる） */
export function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const view = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}
