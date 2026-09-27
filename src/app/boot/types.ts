// 画面が使うサービスの型（main.tsx で作って Root に渡す）。

import type { ObjectStructureCatalog } from "../catalog/catalog";
import type { KeyVault } from "../keyvault/client";
import type { ToastStore } from "../ui/toast";
import type { Runtime } from "./runtime";

export interface AppServices {
  vault: KeyVault;
  toasts: ToastStore;
  /** 読み込んだオブジェクト構造（設定。/structures と LLM のツールが共有する） */
  catalog: ObjectStructureCatalog;
  /** 作業画面を開いたときと、作業終了の後に呼ぶ */
  createRuntime(): Runtime;
}
