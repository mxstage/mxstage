// 改名前（mxstudio）の名前でブラウザに残っているものを、新しい名前へ移す（createServices の最初に呼ぶ）。
// 0.2.0 で mxstudio を MX Stage（mxstage）に改名した。オリジン（127.0.0.1:8788）は同じなので、古い名前の保存が残っている。
// - localStorage の接続先と接続方式: 新しい名前に無いときだけ写し、古い名前は消す（パスワードマネージャーの接続名は触らない）
// - IndexedDB の保存したオブジェクト構造（データベース mxstudio）: 1 回だけ消す。次に接続したとき自動で読み込み直す
// 何度呼んでも同じ結果になる。ストレージを使えない環境（プライベートウィンドウなど）では何もしない。

import { STORAGE_KEYS } from "../settings/logic";

/** 改名前の localStorage のキー（新しい名前の STORAGE_KEYS と同じ並び） */
export const LEGACY_STORAGE_KEYS: Readonly<Record<keyof typeof STORAGE_KEYS, string>> = {
  baseUrl: "mxstudio.maximo.baseUrl",
  via: "mxstudio.maximo.via",
};

/** 改名前の IndexedDB のデータベース名 */
export const LEGACY_CATALOG_DB_NAME = "mxstudio";

/** 古い IndexedDB を消したことを覚えておくキー（2 回目からは消しに行かない） */
export const LEGACY_IDB_DELETED_KEY = "mxstage.migrated.idb";

export interface MigrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LegacyMigrationResult {
  /** 写した設定のキー（新しい名前） */
  moved: string[];
  /** 古い IndexedDB を消しに行ったか */
  deletedCatalog: boolean;
}

export function migrateLegacyBrowserState(deps: { storage: MigrationStorage | null; indexedDB?: Pick<IDBFactory, "deleteDatabase"> | null }): LegacyMigrationResult {
  const result: LegacyMigrationResult = { moved: [], deletedCatalog: false };
  const { storage } = deps;
  if (storage === null) return result;
  try {
    for (const name of Object.keys(STORAGE_KEYS) as (keyof typeof STORAGE_KEYS)[]) {
      const legacyKey = LEGACY_STORAGE_KEYS[name];
      const value = storage.getItem(legacyKey);
      if (value === null) continue;
      if (storage.getItem(STORAGE_KEYS[name]) === null) {
        storage.setItem(STORAGE_KEYS[name], value);
        result.moved.push(STORAGE_KEYS[name]);
      }
      storage.removeItem(legacyKey);
    }
    if (deps.indexedDB && storage.getItem(LEGACY_IDB_DELETED_KEY) === null) {
      deps.indexedDB.deleteDatabase(LEGACY_CATALOG_DB_NAME);
      storage.setItem(LEGACY_IDB_DELETED_KEY, "1");
      result.deletedCatalog = true;
    }
  } catch {
    // 使えない・満杯でも、作業画面は動かす（古い名前が残るだけ）
  }
  return result;
}

/** window.localStorage を安全に取り出す（使えない環境では null） */
export function browserStorage(): MigrationStorage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}
