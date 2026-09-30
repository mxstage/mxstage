// 画面が使うサービスを作る（main.tsx から 1 回だけ呼ぶ）。

import { startCatalogAutoSync } from "../catalog/autosync";
import { ObjectStructureCatalog } from "../catalog/catalog";
import { createDefaultCatalogStorage } from "../catalog/storage";
import { ImportStore, installImportDrop } from "../imports";
import { KeyVault, createWorkerTransport } from "../keyvault/client";
import { relayUrl, type ImportErrorReason } from "../relay";
import { ToastStore } from "../ui/toast";
import { factories } from "./factories";
import { browserStorage, migrateLegacyBrowserState } from "./migrate";
import { createRuntime } from "./runtime";
import type { AppServices } from "./types";
import { APP_VERSION } from "./version";

const IMPORT_ERROR_LABEL: Record<ImportErrorReason, string> = {
  sequence: "断片の順番が合いません",
  size_mismatch: "大きさが合いません",
  too_large: "大きすぎます（20MB まで）",
  too_many: "同時に受け取れるファイル数を超えました",
  timeout: "続きが届きませんでした",
  invalid_data: "内容を読み取れませんでした",
  digest_failed: "チェックサムを計算できませんでした",
};

export function createServices(): AppServices {
  // 改名前（mxstudio）の名前で残っている設定を先に移す（設定を読む・オブジェクト構造を開く前に）
  migrateLegacyBrowserState({ storage: browserStorage(), indexedDB: typeof indexedDB === "undefined" ? null : indexedDB });
  const vault = new KeyVault({ transport: createWorkerTransport() });
  const toasts = new ToastStore();
  // オブジェクト構造は設定としてブラウザに保存し、作業終了でも消さない。
  // Maximo に接続したら、LLM の操作を待たずにすべての定義を機械的に読み込む
  const catalog = new ObjectStructureCatalog({ storage: createDefaultCatalogStorage() });
  startCatalogAutoSync({ catalog, connection: vault });
  // Excel・CSV は Claude が送るか、利用者が作業画面にドロップする（どちらも同じ置き場に入る）
  const imports = new ImportStore();
  installImportDrop({ win: window, store: imports, notify: (text, tone) => toasts.show(text, tone) });
  return {
    vault,
    toasts,
    catalog,
    createRuntime: () => {
      const runtime = createRuntime({
        connection: vault,
        catalog,
        factories,
        // LLM のツール実行も「作業中」として数える（タブを触らないまま API キーが自動ロックされるのを防ぐ）
        noteActivity: () => vault.noteActivity(),
        appVersion: APP_VERSION,
        // 中継・Maximo の代理・取り込みは、画面を配っている橋渡しと同じオリジン
        origin: window.location.origin,
        relayUrl: relayUrl(window.location),
        imports,
        onImport: (file) => toasts.show(`ファイル ${file.fileName} を受け取りました。Claude が中身を確かめてシートにします。`),
        onImportError: (_importId, reason) => toasts.show(`ファイルを受け取れませんでした（${IMPORT_ERROR_LABEL[reason] ?? reason}）`, "error"),
      });
      // 開発サーバ（vite dev）で ?demo=1 のときだけ、サンプルのシートを入れて画面を確かめられるようにする。
      // 本番のビルドでは import.meta.env.DEV が false の定数になり、この中ごと落ちる
      if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo")) {
        void import("./demo").then(({ seedDemoWorkspace }) => seedDemoWorkspace(runtime.workspace));
      }
      return runtime;
    },
  };
}
