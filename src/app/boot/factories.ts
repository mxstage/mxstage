// ツール実行（src/app/tools）と Maximo への反映（src/app/commit）の実装を結線する。
// 契約は src/app/runtime/contracts.ts。ここ以外から実装を直接 import しない。

import { createCommitController } from "../commit/controller";
import { createToolRegistry } from "../tools/registry";
import type { RuntimeFactories } from "./runtime";

export const factories: RuntimeFactories = { createToolRegistry, createCommitController };
