// 起動時の結線: Workspace・反映コントローラ・ツール実行・中継ソケットを作ってつなぐ。

import type { ObjectStructureCatalog } from "../catalog/catalog";
import type { LicenseGate } from "../license/client";
import type { ImportStore } from "../imports";
import { RelaySocket, type RelaySocketOptions, type RelayStatus } from "../relay";
import type { ImportErrorReason, ImportedFile } from "../relay";
import type {
  CommitController,
  CommitRequester,
  ConnectionProvider,
  CreateCommitController,
  CreateToolRegistry,
  TabToolRegistry,
} from "../runtime/contracts";
import { Workspace, type JobRegistry } from "../store";

export interface RuntimeFactories {
  createToolRegistry: CreateToolRegistry;
  createCommitController: CreateCommitController;
}

type RelayOverrides = Partial<
  Omit<RelaySocketOptions, "url" | "appVersion" | "tools" | "handler" | "getRevision" | "getWorkspace" | "onStatus" | "onImport" | "onImportError">
>;

export interface RuntimeOptions {
  connection: ConnectionProvider;
  /** オブジェクト構造のカタログ。作業終了で作り直さないよう、ランタイムの外（services）で作って渡す */
  catalog: ObjectStructureCatalog;
  /** ライセンスと環境（本番／テスト）。反映の関門が使う。作業終了で作り直さないよう services で作って渡す */
  license?: LicenseGate;
  factories: RuntimeFactories;
  appVersion: string;
  /** 例 http://127.0.0.1:8788 */
  origin: string;
  /** relayUrl(location) */
  relayUrl: string;
  workspaceName?: string;
  /** ツールが呼ばれたことを知らせる（API キーの自動ロックの時計を戻す） */
  noteActivity?: () => void;
  now?: () => number;
  /** 作業画面に届いたファイルの置き場（Claude が送ったもの・ドロップしたもの）。作業終了で空にする */
  imports?: ImportStore;
  onImport?: (file: ImportedFile) => void;
  onImportError?: (importId: string, reason: ImportErrorReason) => void;
  /** 試験用（WebSocketImpl・window・document・タイマーなど） */
  relayOverrides?: RelayOverrides;
}

export interface Runtime {
  readonly workspace: Workspace;
  readonly jobs: JobRegistry;
  readonly commits: CommitController;
  /** hello で Hub に知らせるツール名 */
  readonly tools: readonly string[];
  readonly tabId: string;
  /** 変わるまで同じオブジェクトを返す */
  relayStatus(): RelayStatus;
  subscribeRelay(listener: () => void): () => void;
  start(): void;
  dispose(): void;
}

export function defaultWorkspaceName(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `作業 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** LLM のツールに渡す反映の口。run などを持たない別のオブジェクトにして、ツールからは書き込めないようにする */
export function commitRequesterOf(c: CommitController): CommitRequester {
  return {
    request: (sheet, note, by) => c.request(sheet, note, by),
    panel: (sheet) => c.panel(sheet),
    isRunning: (sheet) => c.isRunning(sheet),
  };
}

export function createRuntime(opts: RuntimeOptions): Runtime {
  const now = opts.now ?? (() => Date.now());
  const workspace = new Workspace(opts.workspaceName ?? defaultWorkspaceName(new Date(now())), { now });
  const jobs = workspace.jobs;
  const commits = opts.factories.createCommitController({ workspace, connection: opts.connection, catalog: opts.catalog, now, ...(opts.license ? { license: opts.license } : {}) });
  const registry: TabToolRegistry = opts.factories.createToolRegistry({
    workspace,
    jobs,
    connection: opts.connection,
    commits: commitRequesterOf(commits),
    catalog: opts.catalog,
    ...(opts.imports ? { imports: opts.imports } : {}),
    appVersion: opts.appVersion,
    appUrl: `${opts.origin}/app`,
    ...(opts.noteActivity ? { noteActivity: opts.noteActivity } : {}),
    now,
  });

  const listeners = new Set<() => void>();
  let status: RelayStatus | null = null;
  const relay = new RelaySocket({
    ...opts.relayOverrides,
    url: opts.relayUrl,
    appVersion: opts.appVersion,
    tools: registry.tools,
    handler: registry.handler,
    getRevision: () => workspace.revision,
    getWorkspace: () => workspace.name,
    onStatus: (s) => {
      status = s;
      for (const l of Array.from(listeners)) {
        try {
          l();
        } catch {
          // 表示側の失敗で中継を止めない
        }
      }
    },
    onImport: (file) => {
      opts.imports?.add(file);
      opts.onImport?.(file);
    },
    onImportError: opts.onImportError,
  });
  const initial = relay.getStatus();
  let disposed = false;

  return {
    workspace,
    jobs,
    commits,
    tools: [...registry.tools],
    tabId: relay.tabId,
    relayStatus: () => status ?? initial,
    subscribeRelay: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () => {
      if (!disposed) relay.start();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // 作業を捨てる前に、実行中の反映を打ち切る。
      // 打ち切らないと、画面から消えた作業データのために残りの行が Maximo へ送られ続け、
      // 利用者には止める口も結果を見る口も残らない（送信済みの分は取り消せない）。
      for (const sheet of Array.from(workspace.sheets.keys())) {
        try {
          if (commits.isRunning(sheet)) commits.cancel(sheet);
        } catch {
          // 打ち切れなくても後始末は続ける
        }
      }
      relay.stop();
      listeners.clear();
      // 受け取ったファイルも作業データなので捨てる
      opts.imports?.clear();
    },
  };
}
