// 保存した接続先へ自動でつなぐ。
// - 作業画面を開いたとき（PWA・普通のタブ・AI クライアントの中のブラウザのどれでも）、前に使った接続先へつなぐ。
// - つながらなかったとき（橋渡しが起動中・Maximo が一時的に応答しない）は、間を置いて・窓に戻ってきたときにやり直す。
//   API キーが通らないとき（401・403）や接続先が消されたときは、やり直さずに設定画面で知らせる。
// - 利用者が「接続を切る」を押した窓では、自分でつなぎ直すまで自動ではつながない。

import { MaximoError, MaximoNetworkError } from "../maximo/client";
import type { Environment } from "../license/client";
import type { MaximoConnectionInfo } from "../runtime/contracts";
import type { SavedConnection, SavedConnectionsClient } from "./client";

/** やり直すまでの間 */
export const AUTO_RETRY_MS = 15_000;

export interface AutoConnectVault {
  connectSaved(saved: { id: string; name: string; baseUrl: string }): Promise<MaximoConnectionInfo>;
  getView(): { kind: "disconnected" | "connected" | "locked" };
  disconnect(): void;
}

export interface AutoConnectLicense {
  declare(baseUrl: string, environment: Environment): void;
}

export interface AutoConnectFailure {
  connection: SavedConnection;
  error: unknown;
  /** やり直すか（つながらないだけ）。false なら API キーなどを直すまで待つ */
  retrying: boolean;
}

export interface WindowEvents {
  addEventListener(type: "focus" | "online", listener: () => void): void;
}

export interface AutoConnectorDeps {
  saved: SavedConnectionsClient;
  vault: AutoConnectVault;
  license?: AutoConnectLicense | null;
  win?: WindowEvents | null;
  retryMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** つながらないだけ（やり直せば通るかもしれない）か */
export function isRetryable(error: unknown): boolean {
  if (error instanceof MaximoNetworkError) return true;
  // 橋渡しが保存した接続先を使えない（消された・この PC で開けない）。やり直しても変わらない
  if (error instanceof MaximoError && /（\/mx: connection_[a-z_]+）$/.test(error.message)) return false;
  if (error instanceof MaximoError) return error.status >= 500 || error.status === 429 || error.status === 423;
  // 橋渡しが応答しない・Worker の失敗など
  return !(error instanceof Error && error.name === "AbortError");
}

export class AutoConnector {
  private readonly deps: AutoConnectorDeps;
  private readonly retryMs: number;
  private failureValue: AutoConnectFailure | null = null;
  private readonly listeners = new Set<() => void>();
  private userDisconnected = false;
  private running: Promise<void> | null = null;
  private timer: unknown = null;
  private started = false;

  constructor(deps: AutoConnectorDeps) {
    this.deps = deps;
    this.retryMs = deps.retryMs ?? AUTO_RETRY_MS;
  }

  failure(): AutoConnectFailure | null {
    return this.failureValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setFailure(f: AutoConnectFailure | null): void {
    if (this.failureValue === f) return;
    this.failureValue = f;
    for (const l of [...this.listeners]) l();
  }

  /** 開いたときに 1 回つなぎ、つながらなければやり直す */
  start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      const again = () => void this.attempt();
      this.deps.win?.addEventListener("focus", again);
      this.deps.win?.addEventListener("online", again);
    }
    return this.attempt();
  }

  /** 自動でつなぐ（つながっている・利用者が切った・前の試みの途中なら何もしない） */
  attempt(): Promise<void> {
    if (this.running) return this.running;
    if (this.userDisconnected || this.deps.vault.getView().kind !== "disconnected") return Promise.resolve();
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<void> {
    this.cancelRetry();
    const snapshot = await this.deps.saved.refresh();
    if (this.userDisconnected || this.deps.vault.getView().kind !== "disconnected") return;
    if (snapshot.status !== "ready") {
      // 橋渡しが起動中かもしれない。保存した接続先があるかは分からないので、静かにやり直す
      this.scheduleRetry();
      return;
    }
    const target = this.deps.saved.preferred();
    if (target === null) return;
    // 前の試みで API キーが通らなかった接続先は、直すまで繰り返さない
    const last = this.failureValue;
    if (last !== null && !last.retrying && last.connection.id === target.id && last.connection.updatedAt === target.updatedAt) return;
    try {
      await this.connect(target);
    } catch {
      // connect が failure に記録した
    }
  }

  /** 保存した接続先でつなぐ（設定画面の「接続」もここを通す） */
  async connect(target: SavedConnection): Promise<MaximoConnectionInfo> {
    this.userDisconnected = false;
    this.cancelRetry();
    try {
      const info = await this.deps.vault.connectSaved(target);
      if (target.environment !== null) this.deps.license?.declare(target.baseUrl, target.environment);
      this.setFailure(null);
      void this.deps.saved.markUsed(target.id);
      return info;
    } catch (error) {
      const retrying = isRetryable(error);
      this.setFailure({ connection: target, error, retrying });
      if (retrying) this.scheduleRetry();
      throw error;
    }
  }

  /** 利用者が「接続を切る」を押した */
  disconnect(): void {
    this.userDisconnected = true;
    this.cancelRetry();
    this.setFailure(null);
    this.deps.vault.disconnect();
  }

  private scheduleRetry(): void {
    this.cancelRetry();
    const set = this.deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = set(() => {
      this.timer = null;
      void this.attempt();
    }, this.retryMs);
  }

  private cancelRetry(): void {
    if (this.timer === null) return;
    const clear = this.deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    clear(this.timer);
    this.timer = null;
  }
}
