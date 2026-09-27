// Maximo に接続したら、オブジェクト構造を機械的に読み込む（LLM の操作は要らない）。
// - 接続したとき（接続先か接続時刻が変わったとき）に、一覧のうち保存していない構造の定義をすべて読み込む。
// - 途中で接続が切れた・ロックされた・別の接続先に変わったら打ち切り、また接続したら続きを読む。
// - 一覧そのものを読めなかったとき（failed）は、同じ接続のあいだは自動で繰り返さない（画面の「すべて取り直す」で読み直す）。

import type { ConnectionProvider } from "../runtime/contracts";
import { normalizeScope, type ObjectStructureCatalog } from "./catalog";

export interface CatalogAutoSyncOptions {
  catalog: ObjectStructureCatalog;
  connection: ConnectionProvider;
}

/** 自動の読み込みを始める。戻り値で止める */
export function startCatalogAutoSync({ catalog, connection }: CatalogAutoSyncOptions): () => void {
  let lastConnection: string | null = null;
  const check = () => {
    const conn = connection.current();
    if (conn === null) return;
    const scope = normalizeScope(conn.info.baseUrl);
    const connectionKey = `${scope}|${conn.info.connectedAt}`;
    const state = catalog.snapshot(scope).sync.state;
    if (state === "running") return;
    // 同じ接続で読み終えた・一覧を読めなかったときは繰り返さない。打ち切られたときだけ続きを読む
    if (connectionKey === lastConnection && state !== "stopped") return;
    lastConnection = connectionKey;
    const stillSame = () => {
      const c = connection.current();
      return c !== null && normalizeScope(c.info.baseUrl) === scope;
    };
    void catalog.syncAll(conn.client, conn.info.baseUrl, { shouldContinue: stillSame }).catch(() => undefined);
  };
  const unsubscribe = connection.subscribe(check);
  check();
  return unsubscribe;
}
