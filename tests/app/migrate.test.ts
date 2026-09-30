import { describe, expect, it, vi } from "vitest";
import { LEGACY_CATALOG_DB_NAME, LEGACY_IDB_DELETED_KEY, LEGACY_STORAGE_KEYS, migrateLegacyBrowserState } from "../../src/app/boot/migrate";
import { STORAGE_KEYS } from "../../src/app/settings/logic";
import { bridgeJsonUrl } from "../../src/app/settings/logic";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("改名前（mxstudio）の名前でブラウザに残っているものを移す", () => {
  it("接続先と接続方式を新しい名前へ写し、古い名前は消す。古い IndexedDB は 1 回だけ消す", () => {
    const storage = memoryStorage({ [LEGACY_STORAGE_KEYS.baseUrl]: "https://maximo.example.com", [LEGACY_STORAGE_KEYS.via]: "direct" });
    const deleteDatabase = vi.fn();
    const first = migrateLegacyBrowserState({ storage, indexedDB: { deleteDatabase } });
    expect(first.moved).toEqual([STORAGE_KEYS.baseUrl, STORAGE_KEYS.via]);
    expect(first.deletedCatalog).toBe(true);
    expect(storage.getItem(STORAGE_KEYS.baseUrl)).toBe("https://maximo.example.com");
    expect(storage.getItem(STORAGE_KEYS.via)).toBe("direct");
    expect(storage.getItem(LEGACY_STORAGE_KEYS.baseUrl)).toBeNull();
    expect(storage.getItem(LEGACY_STORAGE_KEYS.via)).toBeNull();
    expect(deleteDatabase).toHaveBeenCalledWith(LEGACY_CATALOG_DB_NAME);
    expect(storage.getItem(LEGACY_IDB_DELETED_KEY)).toBe("1");

    // 2 回目は何もしない
    const second = migrateLegacyBrowserState({ storage, indexedDB: { deleteDatabase } });
    expect(second).toEqual({ moved: [], deletedCatalog: false });
    expect(deleteDatabase).toHaveBeenCalledTimes(1);
  });

  it("新しい名前に値があれば上書きしない（古い名前だけ消す）", () => {
    const storage = memoryStorage({ [LEGACY_STORAGE_KEYS.baseUrl]: "https://old.example.com", [STORAGE_KEYS.baseUrl]: "https://new.example.com" });
    const r = migrateLegacyBrowserState({ storage, indexedDB: null });
    expect(r.moved).toEqual([]);
    expect(storage.getItem(STORAGE_KEYS.baseUrl)).toBe("https://new.example.com");
    expect(storage.getItem(LEGACY_STORAGE_KEYS.baseUrl)).toBeNull();
  });

  it("ストレージを使えない環境では何もしない（例外を投げない）", () => {
    expect(migrateLegacyBrowserState({ storage: null })).toEqual({ moved: [], deletedCatalog: false });
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(() => migrateLegacyBrowserState({ storage: broken, indexedDB: { deleteDatabase: vi.fn() } })).not.toThrow();
  });
});

describe("橋渡しの JSON を取りに行く URL", () => {
  it("毎回違う URL にする（改名前の Service Worker に保存させない）。経路は変えない", () => {
    expect(bridgeJsonUrl("/_mxstage/skills", 123)).toBe("/_mxstage/skills?t=123");
    expect(new URL(bridgeJsonUrl("/_mxstage/skills"), "http://127.0.0.1:8788").pathname).toBe("/_mxstage/skills");
  });
});
