// 画面が使うサービスを作る（main.tsx から 1 回だけ呼ぶ）。

import { startCatalogAutoSync } from "../catalog/autosync";
import { ObjectStructureCatalog } from "../catalog/catalog";
import { createDefaultCatalogStorage } from "../catalog/storage";
import { ImportStore, installImportDrop } from "../imports";
import { AutoConnector } from "../connections/auto";
import { SavedConnectionsClient } from "../connections/client";
import { KeyVault, createWorkerTransport } from "../keyvault/client";
import { LicenseClient } from "../license/client";
import { relayUrl, type ImportErrorReason } from "../relay";
import { importErrorMessages } from "../settings/messages";
import { createUpdatesApi } from "../settings/updates";
import { uiMessages } from "../ui/messages";
import { ToastStore } from "../ui/toast";
import { factories } from "./factories";
import { LOCALE_STORAGE_KEY, detectLocale, setLocale } from "../../shared/i18n";
import { browserStorage, migrateLegacyBrowserState } from "./migrate";
import { createRuntime } from "./runtime";
import type { AppServices } from "./types";
import { APP_VERSION } from "./version";

/** ファイルを受け取れなかった理由（今の言語の文言。src/app/settings/messages.ts） */
function importErrorLabel(reason: ImportErrorReason): string {
  const labels: Record<ImportErrorReason, string> = importErrorMessages();
  return labels[reason] ?? reason;
}

/** 利用者が設定で選んだ言語（無い・読めなければ null） */
function readStoredLocale(): string | null {
  try {
    return browserStorage()?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function createServices(): AppServices {
  // 改名前（mxstudio）の名前で残っている設定を先に移す（設定を読む・オブジェクト構造を開く前に）
  migrateLegacyBrowserState({ storage: browserStorage(), indexedDB: typeof indexedDB === "undefined" ? null : indexedDB });
  // 画面の言語（保存した設定 → ブラウザの言語。src/shared/i18n.ts）
  setLocale(detectLocale({ stored: readStoredLocale(), languages: typeof navigator === "undefined" ? [] : navigator.languages }));
  const vault = new KeyVault({ transport: createWorkerTransport() });
  // ライセンスキーは橋渡しが持つ。開いたときと、タブに戻ってきたとき（別のタブでキーを足したかもしれない）に読み直す
  const license = new LicenseClient({ storage: browserStorage() });
  void license.refresh();
  if (typeof window !== "undefined") window.addEventListener("focus", () => void license.refresh());
  // 保存した接続先（API キーは橋渡しが OS の保護付きで預かる）。どの窓で開いても、前に使った接続先へ自動でつなぐ
  const connections = new SavedConnectionsClient({ storage: browserStorage() });
  const autoConnect = new AutoConnector({ saved: connections, vault, license, win: typeof window === "undefined" ? null : window });
  void autoConnect.start();
  const toasts = new ToastStore();
  // 新しい版が分かっていれば知らせる（問い合わせるのは橋渡しで、自動の更新がオフなら問い合わせていない）
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/app")) {
    void createUpdatesApi()
      .status()
      .then((s) => {
        if (s?.available && s.latest && s.phase !== "applying") toasts.show(uiMessages().updateAvailable(s.latest.version));
      });
  }
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
    license,
    connections,
    autoConnect,
    imports,
    createRuntime: (extras) => {
      const runtime = createRuntime({
        ...(extras?.workspace ? { initialWorkspace: extras.workspace } : {}),
        ...(extras?.onReleased ? { onReleased: extras.onReleased } : {}),
        connection: vault,
        catalog,
        license,
        factories,
        // LLM のツール実行も「作業中」として数える（タブを触らないまま API キーが自動ロックされるのを防ぐ）
        noteActivity: () => vault.noteActivity(),
        appVersion: APP_VERSION,
        // 中継・Maximo の代理・取り込みは、画面を配っている橋渡しと同じオリジン
        origin: window.location.origin,
        relayUrl: relayUrl(window.location),
        imports,
        onImport: (file) => toasts.show(uiMessages().drop.imported(file.fileName)),
        onImportError: (_importId, reason) => toasts.show(uiMessages().drop.importFailed(importErrorLabel(reason)), "error"),
      });
      // 開発サーバ（vite dev）で ?samples=1 のときだけ、サンプルのシートを入れて画面を確かめられるようにする。
      // 本番のビルドでは import.meta.env.DEV が false の定数になり、この中ごと落ちる
      if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("samples")) {
        void import("./samples").then(({ seedSampleWorkspace }) => seedSampleWorkspace(runtime.workspace));
      }
      return runtime;
    },
  };
}
