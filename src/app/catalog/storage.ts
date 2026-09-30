// オブジェクト構造のカタログの保存先。
// - ブラウザの IndexedDB（データベース mxstage）に、Maximo の接続先（baseUrl）ごとに保存する。
// - 保存するのは jsonschemas から読んだ属性の定義と、オブジェクト構造の一覧（apimeta と MXAPIINTOBJECT）だけ。API キーや行データは入れない。
// - IndexedDB が使えない環境（プライベートウィンドウ、試験など）ではメモリに置く（タブを閉じると消える）。

import type { DefinedObjectStructure, ObjectStructureInfo, ObjectStructureListItem } from "../maximo/meta";

/** 保存したオブジェクト構造 1 つ */
export interface StoredObjectStructure {
  /** normalizeScope した接続先 */
  baseUrl: string;
  /** オブジェクト構造名（大文字） */
  os: string;
  info: ObjectStructureInfo;
  /** Maximo から読んだ時刻（epoch ミリ秒） */
  loadedAt: number;
}

/**
 * 保存したオブジェクト構造の一覧（src/app/maximo/meta.ts の mergeStructureLists）。
 * items 以外は、MXAPIINTOBJECT も読むようにする前に保存した一覧には無い。
 */
export interface StoredApiList {
  baseUrl: string;
  /** API で使える構造。apimeta の一覧に、Maximo の定義にあって apimeta に載らない構造を足したもの */
  items: Array<Pick<ObjectStructureListItem, "name" | "description">>;
  /** Maximo に定義された構造の数。定義を読めなければ null */
  definedCount?: number | null;
  /** apimeta に載らず、定義から足した数 */
  addedFromDefinitions?: number;
  /** 定義はあるが、適用先が API で使えないため読み込まない構造 */
  notApi?: DefinedObjectStructure[];
  /** 定義（MXAPIINTOBJECT）を読めなかった理由。このときは apimeta の一覧だけ */
  definedError?: string;
  fetchedAt: number;
}

export interface CatalogStorage {
  /** ブラウザを閉じても残るか（画面の文言に使う） */
  readonly persistent: boolean;
  list(baseUrl: string): Promise<StoredObjectStructure[]>;
  put(entry: StoredObjectStructure): Promise<void>;
  remove(baseUrl: string, os: string): Promise<void>;
  getApiList(baseUrl: string): Promise<StoredApiList | null>;
  putApiList(list: StoredApiList): Promise<void>;
}

/** 保存のキーにする接続先。前後の空白と末尾の / を取り、スキームとホストを小文字にする（パスの大文字小文字は残す） */
export function normalizeScope(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed;
  }
}

const entryId = (baseUrl: string, os: string) => `${baseUrl}\n${os}`;

// ---------------------------------------------------------------------------
// メモリ
// ---------------------------------------------------------------------------

export function createMemoryCatalogStorage(): CatalogStorage {
  const entries = new Map<string, StoredObjectStructure>();
  const lists = new Map<string, StoredApiList>();
  // 呼び出し側が受け取ったオブジェクトを書き換えても保存内容が変わらないよう、出し入れで複製する
  const copy = <T>(v: T): T => structuredClone(v);
  return {
    persistent: false,
    list: async (baseUrl) => Array.from(entries.values()).filter((e) => e.baseUrl === baseUrl).map(copy),
    put: async (entry) => {
      entries.set(entryId(entry.baseUrl, entry.os), copy(entry));
    },
    remove: async (baseUrl, os) => {
      entries.delete(entryId(baseUrl, os));
    },
    getApiList: async (baseUrl) => {
      const v = lists.get(baseUrl);
      return v === undefined ? null : copy(v);
    },
    putApiList: async (list) => {
      lists.set(list.baseUrl, copy(list));
    },
  };
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

export const CATALOG_DB_NAME = "mxstage";
export const CATALOG_DB_VERSION = 1;
const STRUCTURES_STORE = "objectStructures";
const API_LISTS_STORE = "apiLists";

interface StructureRecord extends StoredObjectStructure {
  id: string;
}

function promised<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB の要求に失敗しました"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB の書き込みが中断されました"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB の書き込みに失敗しました"));
  });
}

/**
 * IndexedDB に保存する。開くのは最初に使うとき。開けなければ各操作が失敗する
 * （呼び出し側の ObjectStructureCatalog がメモリに切り替える）。
 */
export function createIndexedDbCatalogStorage(factory: IDBFactory): CatalogStorage {
  let opening: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    if (opening === null) {
      opening = new Promise<IDBDatabase>((resolve, reject) => {
        let req: IDBOpenDBRequest;
        try {
          req = factory.open(CATALOG_DB_NAME, CATALOG_DB_VERSION);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(STRUCTURES_STORE)) {
            d.createObjectStore(STRUCTURES_STORE, { keyPath: "id" }).createIndex("baseUrl", "baseUrl", { unique: false });
          }
          if (!d.objectStoreNames.contains(API_LISTS_STORE)) d.createObjectStore(API_LISTS_STORE, { keyPath: "baseUrl" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB を開けませんでした"));
        req.onblocked = () => reject(new Error("IndexedDB が別のタブの古い版に使われているため開けませんでした"));
      });
      // 失敗したら次の操作で開き直す
      opening.catch(() => {
        opening = null;
      });
    }
    return opening;
  };

  return {
    persistent: true,
    list: async (baseUrl) => {
      const d = await db();
      const tx = d.transaction(STRUCTURES_STORE, "readonly");
      const rows = await promised(tx.objectStore(STRUCTURES_STORE).index("baseUrl").getAll(baseUrl) as IDBRequest<StructureRecord[]>);
      return rows.map(({ id: _id, ...rest }) => rest);
    },
    put: async (entry) => {
      const d = await db();
      const tx = d.transaction(STRUCTURES_STORE, "readwrite");
      const record: StructureRecord = { ...entry, id: entryId(entry.baseUrl, entry.os) };
      tx.objectStore(STRUCTURES_STORE).put(record);
      await done(tx);
    },
    remove: async (baseUrl, os) => {
      const d = await db();
      const tx = d.transaction(STRUCTURES_STORE, "readwrite");
      tx.objectStore(STRUCTURES_STORE).delete(entryId(baseUrl, os));
      await done(tx);
    },
    getApiList: async (baseUrl) => {
      const d = await db();
      const tx = d.transaction(API_LISTS_STORE, "readonly");
      const v = await promised(tx.objectStore(API_LISTS_STORE).get(baseUrl) as IDBRequest<StoredApiList | undefined>);
      return v ?? null;
    },
    putApiList: async (list) => {
      const d = await db();
      const tx = d.transaction(API_LISTS_STORE, "readwrite");
      tx.objectStore(API_LISTS_STORE).put(list);
      await done(tx);
    },
  };
}

/** ブラウザに IndexedDB があればそれを、無ければメモリを使う */
export function createDefaultCatalogStorage(scope: { indexedDB?: IDBFactory } = globalThis as { indexedDB?: IDBFactory }): CatalogStorage {
  try {
    if (scope.indexedDB) return createIndexedDbCatalogStorage(scope.indexedDB);
  } catch {
    // 参照だけで例外になる環境（一部のプライベートモード）はメモリにする
  }
  return createMemoryCatalogStorage();
}
