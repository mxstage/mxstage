// オブジェクト構造のカタログ（作業画面の設定）。
// Maximo に接続すると、API で使えるすべてのオブジェクト構造（jsonschemas の解析結果）を機械的に読み込み（syncAll。
// src/app/catalog/autosync.ts が接続のたびに呼ぶ）、接続先ごとに保存する。
// 一覧は apimeta だけでは足りない（顧客が作った構造が載らない）ので、Maximo の定義（MXAPIINTOBJECT）で補う（mergeStructureLists）。
// 画面（/structures）と LLM のツール（find_object_structures・describe_object_structure・load_sheet）が同じものを使い、
// シートは読み込んだ構造の定義の版を持って、Maximo への反映の前に今の定義と比べる（src/app/commit/controller.ts）。
// - 作業ではなく設定なので、作業終了では消さない。ブラウザを閉じても残る（IndexedDB。src/app/catalog/storage.ts）。
// - 保存するのは属性の定義だけ。API キーや行データは持たない。
// - 保存に失敗したら、そのタブの間はメモリに置いて続ける（画面に知らせる）。

import type { MaximoClient } from "../maximo/client";
import { getObjectStructureInfo, listDefinedObjectStructures, mergeStructureLists, parseApiMeta } from "../maximo/meta";
import {
  createMemoryCatalogStorage,
  normalizeScope,
  type CatalogStorage,
  type StoredApiList,
  type StoredObjectStructure,
} from "./storage";
import { catalogMessages as m } from "../settings/messages";

export type { StoredApiList, StoredObjectStructure } from "./storage";
export { normalizeScope } from "./storage";

const OS_NAME_RE = /^[A-Z0-9_]+$/;

/** 読めなかった理由（Maximo の本文は長さを区切る） */
function errorText(e: unknown): string {
  const status = typeof (e as { status?: unknown })?.status === "number" ? `${(e as { status: number }).status} ` : "";
  const message = e instanceof Error && e.message ? e.message : m().unknownError;
  return `${status}${message}`.slice(0, 200);
}

/** 検索のための正規化（全角半角をそろえ、大文字小文字を区別しない）。画面とツールで同じ決め方にする */
export function foldText(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/**
 * Maximo からの機械的な読み込み（接続したときに一覧のすべての定義を読み込む）の状態。
 * - idle: まだ読み込んでいない / running: 読み込み中 / done: 終わった（failed に読めなかったもの）
 * - stopped: 途中で接続が切れた・ロックされた / failed: 一覧そのものを読めなかった（error に理由）
 */
export interface CatalogSyncState {
  state: "idle" | "running" | "done" | "stopped" | "failed";
  /** 保存済みも読み直すか（「すべて取り直す」） */
  refresh: boolean;
  /** 今回読み込む数 */
  total: number;
  /** 読み終えた数（失敗を含む） */
  done: number;
  failed: ReadonlyArray<{ os: string; message: string }>;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface SyncOptions {
  /** 保存済みの定義も Maximo から読み直す。一覧から消えた構造は保存からも消す */
  refresh?: boolean;
  /** 同時に読み込む数（既定 3。Maximo に負荷をかけすぎない） */
  concurrency?: number;
  /** false を返したら読み込みを打ち切る（接続が切れた・別の接続先に変わったとき） */
  shouldContinue?: () => boolean;
}

export const SYNC_CONCURRENCY = 3;

const IDLE_SYNC: CatalogSyncState = { state: "idle", refresh: false, total: 0, done: 0, failed: [] };

/** 接続先 1 つ分の状態（画面が useSyncExternalStore で読む。変わるまで同じオブジェクト） */
export interface CatalogSnapshot {
  baseUrl: string;
  /** 保存先から読み終えたか */
  ready: boolean;
  /** 名前順 */
  entries: readonly StoredObjectStructure[];
  apiList: StoredApiList | null;
  /** Maximo から読み込み中のオブジェクト構造名 */
  loading: readonly string[];
  /** オブジェクト構造の一覧を取得中か */
  listing: boolean;
  /** ブラウザを閉じても残るか */
  persistent: boolean;
  /** 保存に失敗してメモリに切り替えたときの説明 */
  storageError: string | null;
  /** Maximo からの機械的な読み込みの状態 */
  sync: CatalogSyncState;
}

export interface EnsureOptions {
  /** 保存済みでも Maximo から読み直す */
  refresh?: boolean;
}

export interface EnsureResult {
  entry: StoredObjectStructure;
  /** この呼び出しで Maximo から読んだか（false なら保存済みを返した） */
  fetched: boolean;
}

interface ScopeState {
  ready: boolean;
  loadingStorage: Promise<void> | null;
  entries: Map<string, StoredObjectStructure>;
  apiList: StoredApiList | null;
  inflight: Map<string, Promise<StoredObjectStructure>>;
  listing: Promise<StoredApiList> | null;
  sync: CatalogSyncState;
  syncing: Promise<CatalogSyncState> | null;
  snapshot: CatalogSnapshot | null;
}

export interface ObjectStructureCatalogOptions {
  storage?: CatalogStorage;
  now?: () => number;
}

export class ObjectStructureCatalog {
  private storage: CatalogStorage;
  private readonly now: () => number;
  private readonly scopes = new Map<string, ScopeState>();
  private readonly listeners = new Set<() => void>();
  private storageError: string | null = null;

  constructor(opts: ObjectStructureCatalogOptions = {}) {
    this.storage = opts.storage ?? createMemoryCatalogStorage();
    this.now = opts.now ?? (() => Date.now());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 接続先の状態。まだ保存先から読んでいなければ読み始める */
  snapshot(baseUrl: string): CatalogSnapshot {
    const key = normalizeScope(baseUrl);
    const s = this.scope(key);
    if (!s.ready) void this.ready(key);
    if (s.snapshot === null) {
      s.snapshot = {
        baseUrl: key,
        ready: s.ready,
        entries: Array.from(s.entries.values()).sort((a, b) => (a.os < b.os ? -1 : a.os > b.os ? 1 : 0)),
        apiList: s.apiList,
        loading: Array.from(s.inflight.keys()).sort(),
        listing: s.listing !== null,
        persistent: this.storage.persistent,
        storageError: this.storageError,
        sync: s.sync,
      };
    }
    return s.snapshot;
  }

  /**
   * API で使えるオブジェクト構造の定義を、機械的にすべて読み込んで保存する。
   * 一覧は毎回 Maximo から読み直す（後から作られた構造も入るように）。
   * 保存済みの定義は読み直さない（refresh なら読み直し、一覧から消えたものは保存からも消す）。
   * 読み込み中にもう一度呼ばれたら、同じ読み込みを返す。1 件が読めなくても続け、failed に残す。
   */
  syncAll(client: MaximoClient, baseUrl: string, opts: SyncOptions = {}): Promise<CatalogSyncState> {
    const key = normalizeScope(baseUrl);
    const s = this.scope(key);
    if (s.syncing !== null) return s.syncing;
    const refresh = opts.refresh === true;
    const concurrency = Math.max(1, Math.floor(opts.concurrency ?? SYNC_CONCURRENCY));
    const keepGoing = opts.shouldContinue ?? (() => true);
    const run = (async (): Promise<CatalogSyncState> => {
      const startedAt = this.now();
      const failed: Array<{ os: string; message: string }> = [];
      const update = (patch: Partial<CatalogSyncState>) => {
        s.sync = { ...s.sync, ...patch, failed: [...failed] };
        this.changed(s);
      };
      s.sync = { state: "running", refresh, total: 0, done: 0, failed: [], startedAt };
      this.changed(s);
      await this.ready(key);
      let names: string[];
      try {
        const list = await this.apiList(client, key, { refresh: true });
        names = list.items.map((i) => i.name);
      } catch (e) {
        update({ state: "failed", error: m().listFailed(errorText(e)), finishedAt: this.now() });
        return s.sync;
      }
      if (refresh) {
        const listed = new Set(names);
        for (const os of Array.from(s.entries.keys())) if (!listed.has(os)) await this.remove(key, os);
      }
      const targets = refresh ? names : names.filter((n) => !s.entries.has(n));
      update({ total: targets.length });
      let next = 0;
      let done = 0;
      let stopped = false;
      const worker = async () => {
        while (next < targets.length) {
          if (!keepGoing()) {
            stopped = true;
            return;
          }
          const os = targets[next++] as string;
          try {
            await this.ensure(client, key, os, { refresh });
          } catch (e) {
            failed.push({ os, message: errorText(e) });
          }
          done++;
          update({ done });
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, () => worker()));
      update({ state: stopped ? "stopped" : "done", done, finishedAt: this.now() });
      return s.sync;
    })();
    s.syncing = run;
    const clear = () => {
      if (s.syncing === run) s.syncing = null;
    };
    run.then(clear, clear);
    return run;
  }

  /** 保存先から読み終えるまで待つ */
  async ready(baseUrl: string): Promise<void> {
    const key = normalizeScope(baseUrl);
    const s = this.scope(key);
    if (s.ready) return;
    if (s.loadingStorage === null) {
      s.loadingStorage = (async () => {
        try {
          const [stored, list] = await Promise.all([this.storage.list(key), this.storage.getApiList(key)]);
          // 読んでいる間に Maximo から読み込んだものは新しいので、そちらを残す
          for (const e of stored) if (!s.entries.has(e.os)) s.entries.set(e.os, e);
          if (s.apiList === null) s.apiList = list;
        } catch (e) {
          this.fallbackToMemory(e);
        } finally {
          s.ready = true;
          s.loadingStorage = null;
          this.changed(s);
        }
      })();
    }
    await s.loadingStorage;
  }

  /** 保存済みのオブジェクト構造（保存先から読み終えていなければ null） */
  get(baseUrl: string, os: string): StoredObjectStructure | null {
    const s = this.scopes.get(normalizeScope(baseUrl));
    return s?.entries.get(os.trim().toUpperCase()) ?? null;
  }

  /**
   * オブジェクト構造を返す。保存済みならそれを、無ければ（または refresh なら）Maximo から読んで保存する。
   * 同じ名前を同時に読み込むときは 1 回にまとめる。
   */
  async ensure(client: MaximoClient, baseUrl: string, rawOs: string, opts: EnsureOptions = {}): Promise<EnsureResult> {
    const key = normalizeScope(baseUrl);
    const os = rawOs.trim().toUpperCase();
    if (!OS_NAME_RE.test(os)) throw new Error(m().badName(JSON.stringify(rawOs)));
    await this.ready(key);
    const s = this.scope(key);
    const saved = s.entries.get(os);
    if (saved !== undefined && opts.refresh !== true) return { entry: saved, fetched: false };
    let pending = s.inflight.get(os);
    if (pending === undefined) {
      const created = (async () => {
        const info = await getObjectStructureInfo(client, os);
        const entry: StoredObjectStructure = { baseUrl: key, os: info.os, info, loadedAt: this.now() };
        s.entries.set(entry.os, entry);
        await this.save(() => this.storage.put(entry));
        return entry;
      })();
      s.inflight.set(os, created);
      this.changed(s);
      const cleanup = () => {
        if (s.inflight.get(os) === created) s.inflight.delete(os);
        this.changed(s);
      };
      created.then(cleanup, cleanup);
      pending = created;
    }
    return { entry: await pending, fetched: true };
  }

  /** 保存から消す（Maximo には何もしない） */
  async remove(baseUrl: string, rawOs: string): Promise<void> {
    const key = normalizeScope(baseUrl);
    const os = rawOs.trim().toUpperCase();
    await this.ready(key);
    const s = this.scope(key);
    if (!s.entries.delete(os)) return;
    this.changed(s);
    await this.save(() => this.storage.remove(key, os));
  }

  /**
   * API で使えるオブジェクト構造の一覧。保存済みならそれを、無ければ（または refresh なら）Maximo から読んで保存する。
   * apimeta は読めなければ失敗にする。MXAPIINTOBJECT は読めなくても（権限が無いなど）apimeta の一覧だけで続け、理由を definedError に残す。
   */
  async apiList(client: MaximoClient, baseUrl: string, opts: EnsureOptions = {}): Promise<StoredApiList> {
    const key = normalizeScope(baseUrl);
    await this.ready(key);
    const s = this.scope(key);
    if (s.apiList !== null && opts.refresh !== true) return s.apiList;
    if (s.listing === null) {
      const created = (async () => {
        const [json, defined] = await Promise.all([
          client.get(`${client.apiRoot}/apimeta?lean=1`),
          listDefinedObjectStructures(client).catch((e: unknown) => ({ error: errorText(e) })),
        ]);
        const list: StoredApiList = { baseUrl: key, ...mergeStructureLists(parseApiMeta(json), defined), fetchedAt: this.now() };
        s.apiList = list;
        await this.save(() => this.storage.putApiList(list));
        return list;
      })();
      s.listing = created;
      this.changed(s);
      const cleanup = () => {
        if (s.listing === created) s.listing = null;
        this.changed(s);
      };
      created.then(cleanup, cleanup);
    }
    return s.listing as Promise<StoredApiList>;
  }

  private scope(key: string): ScopeState {
    let s = this.scopes.get(key);
    if (s === undefined) {
      s = { ready: false, loadingStorage: null, entries: new Map(), apiList: null, inflight: new Map(), listing: null, sync: IDLE_SYNC, syncing: null, snapshot: null };
      this.scopes.set(key, s);
    }
    return s;
  }

  /** 保存に失敗したら、以後はメモリに置く（読み込んだものは失わない） */
  private async save(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (e) {
      this.fallbackToMemory(e);
      for (const s of this.scopes.values()) {
        for (const entry of s.entries.values()) await this.storage.put(entry);
        if (s.apiList !== null) await this.storage.putApiList(s.apiList);
      }
    }
  }

  private fallbackToMemory(e: unknown): void {
    if (!this.storage.persistent) return;
    this.storage = createMemoryCatalogStorage();
    this.storageError = m().storageFallback(e instanceof Error && e.message ? e.message : null);
    for (const s of this.scopes.values()) this.changed(s, false);
    this.emit();
  }

  private changed(s: ScopeState, emit = true): void {
    s.snapshot = null;
    if (emit) this.emit();
  }

  private emit(): void {
    for (const l of Array.from(this.listeners)) {
      try {
        l();
      } catch {
        // 表示側の失敗で読み込みを止めない
      }
    }
  }
}
