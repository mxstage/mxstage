// API キーを持つ専用 Web Worker。中身は core.ts（試験できる純ロジック）に置き、ここは結線だけ。

import { VaultCore, createVaultEndpoint } from "./core";
import type { VaultToMain } from "./protocol";

/** Worker のグローバルのうち使う部分（tsconfig の lib に WebWorker を入れないため最小の型で扱う） */
interface VaultWorkerScope {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  postMessage(msg: VaultToMain): void;
  location: { origin: string };
}

const scope = self as unknown as VaultWorkerScope;
const post = (msg: VaultToMain) => scope.postMessage(msg);
const core = new VaultCore({ origin: scope.location.origin, onLock: (reason) => post({ type: "locked", reason }) });
const handle = createVaultEndpoint({ core, post, fetchImpl: (url, init) => fetch(url, init) });

scope.onmessage = (ev) => handle(ev.data);
