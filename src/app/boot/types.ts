// 画面が使うサービスの型（main.tsx で作って Root に渡す）。

import type { ObjectStructureCatalog } from "../catalog/catalog";
import type { AutoConnector } from "../connections/auto";
import type { SavedConnectionsClient } from "../connections/client";
import type { KeyVault } from "../keyvault/client";
import type { LicenseClient } from "../license/client";
import type { ToastStore } from "../ui/toast";
import type { Workspace } from "../store";
import type { Runtime } from "./runtime";

export interface AppServices {
  vault: KeyVault;
  toasts: ToastStore;
  /** 読み込んだオブジェクト構造（設定。/structures と LLM のツールが共有する） */
  catalog: ObjectStructureCatalog;
  /** ライセンスキーと接続先ごとの環境（本番／テスト）。設定・上部バー・反映の関門が共有する */
  license: LicenseClient;
  /** 橋渡しに保存した Maximo の接続先（API キーは橋渡しが持つ） */
  connections: SavedConnectionsClient;
  /** 保存した接続先への自動の接続（開いたとき・つながらなかったとき） */
  autoConnect: AutoConnector;
  /**
   * 作業画面を開いたときと、作業終了の後に呼ぶ。
   * workspace: 別の窓から移してきた作業。onReleased: この窓の作業が別の窓へ移り終わった
   */
  createRuntime(extras?: { workspace?: Workspace; onReleased?: () => void }): Runtime;
}
