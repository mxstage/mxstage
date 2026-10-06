// 橋渡しを PC に 1 つにするための役割決めと引き継ぎ。
//
// 起動時（先に GET /_mxstage/health を聞き、何も応答しなければポートを取りに行く）:
//   - ポートを取れた → primary。画面の配信・WebSocket の中継・/mx・内部経路を受け持ち、自分の MCP はローカルの Hub を使う。
//   - ポートが使用中（誰かが応答した・待ち受けが EADDRINUSE で失敗した）→ /_mxstage/health の応答で相手を確かめる。
//       MX Stage の橋渡しなら client（自分では待ち受けず、ツール呼び出しを primary に渡す）。
//       それ以外なら、少し待って聞き直し（終わりかけの橋渡しを見誤らない）、それでも分からなければ
//       「ポート <port> は別のアプリが使っています」で終わる（ずらさない）。
// 引き継ぎ:
//   - client は、呼び出しの前（と、watchIntervalMs ごと）にポートを取り直してみる。取れたら primary になる。
//     ポートの取り合いは OS が 1 つにしか許さないので、同時に試しても勝つのは 1 つだけ。
//   - 作業タブは同じ URL に自動で再接続する（src/app/relay）。引き継いだ Hub は再接続の猶予の間だけタブを待つ。
//
// 鍵・作業データは console に出さない。

import { RelayErrorCode, relayErrorMessage } from "../shared/protocol.ts";
import type { HubInvokeRequest, HubInvokeResponse, HubRpc, HubStatus, ImportChunkMsg, InvokeProgress } from "../shared/protocol.ts";
import type { BridgeKeyStore } from "./bridgeKey.ts";
import { LocalHub } from "./hub.ts";
import { ImportTickets } from "./importUpload.ts";
import type { ImportTicket } from "./importUpload.ts";
import type { UpstreamRequest } from "./mx.ts";
import { BRIDGE_PEER_PROTOCOL, PeerUnreachableError, RemoteHub, probeBridgeHealth } from "./peer.ts";
import type { HealthBody, TicketIssuer } from "./peer.ts";
import { isPortInUseError, startBridgeServer } from "./server.ts";
import type { LicenseStore } from "./license.ts";
import type { ConnectionStore } from "./connections.ts";
import type { UpdateManager } from "./updates.ts";
import type { DemoManager } from "./demo.ts";
import type { BridgeServer } from "./server.ts";

/** CLI の client が primary の終了を確かめる間隔 */
export const CLIENT_WATCH_INTERVAL_MS = 2_000;

/** 起動時、ポートが「使用中なのに誰も応答しない」ときに取り直す回数 */
const START_ATTEMPTS = 4;
/** ポートの相手が MX Stage と分からなかったとき、聞き直すまでの間隔（終わりかけの橋渡しを別のアプリと見誤らない） */
const START_RETRY_DELAY_MS = 500;

export type BridgeRole = "idle" | "primary" | "client" | "closed";

export type CoordinatorStart =
  | { kind: "primary"; bridge: BridgeServer }
  | { kind: "client"; health: HealthBody }
  /** ポートを別のアプリ（または互換の無い橋渡し）が使っている。ずらさずに終える */
  | { kind: "conflict"; message: string }
  | { kind: "error"; message: string };

export interface BridgeCoordinatorOptions {
  port: number;
  /** dist/app の絶対パス */
  root: string;
  allowedHosts?: string[];
  insecure?: boolean;
  keyStore: BridgeKeyStore;
  version: string;
  requestImpl?: UpstreamRequest;
  upstreamTimeoutMs?: number;
  /** primary になるたびに新しい Hub を作る（試験で締切を縮める） */
  createHub?: () => LocalHub;
  /** client のとき、primary が終わっていないかを確かめる間隔。0 なら呼び出しの前だけ確かめる */
  watchIntervalMs?: number;
  probeTimeoutMs?: number;
  /** 起動時に相手が分からなかったとき、聞き直すまでの間隔（試験で縮める） */
  startRetryDelayMs?: number;
  /** client がツール呼び出しの締切に足す余裕 */
  remoteGraceMs?: number;
  /** stderr への 1 行ログ（鍵・作業データは渡さない） */
  log?: (line: string) => void;
  /** 利用者の Skill のフォルダ（~/.config/mxstage/skills） */
  userSkillsDir?: string | null;
  /** 起動したあとにコードが変わったか（primary のとき health の stale に載せる。src/bridge/freshness.ts） */
  codeStale?: () => boolean;
  /** ライセンスキーの保存と確かめ（primary のとき /_mxstage/license で作業画面に出す） */
  license?: LicenseStore | null;
  /** 保存した接続先（primary のとき /_mxstage/connections と /mx で使う） */
  connections?: ConnectionStore | null;
  /** 新しい版の確認と入れ替え（primary のとき /_mxstage/updates で作業画面に出す） */
  updates?: UpdateManager | null;
  /** Maximo が無くても試せるデモ（primary のとき /_mxstage/demo と、デモの接続先の /mx で使う） */
  demo?: DemoManager | null;
}

export class BridgeCoordinator {
  readonly port: number;
  /** 作業画面のオリジン（primary でも client でも同じ URL） */
  readonly origin: string;
  /** MCP が使う Hub。呼び出しのたびに役割を確かめ、primary ならローカルの Hub、client なら primary へ渡す */
  readonly hub: HubRpc;
  /** create_import_session のチケット（アップロードは primary のポートに届くので、発行も primary で行う） */
  readonly tickets: TicketIssuer;

  private readonly opts: BridgeCoordinatorOptions;
  private readonly remote: RemoteHub;
  private readonly log: (line: string) => void;
  private roleValue: BridgeRole = "idle";
  private bridge: BridgeServer | null = null;
  private takeover: Promise<boolean> | null = null;
  private watchTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: BridgeCoordinatorOptions) {
    this.opts = opts;
    this.port = opts.port;
    this.origin = `http://127.0.0.1:${opts.port}`;
    this.log = opts.log ?? (() => undefined);
    const remoteOpts: ConstructorParameters<typeof RemoteHub>[0] = { port: opts.port, keyStore: opts.keyStore, appUrl: this.origin };
    if (opts.remoteGraceMs !== undefined) remoteOpts.graceMs = opts.remoteGraceMs;
    this.remote = new RemoteHub(remoteOpts);
    this.hub = {
      invoke: (req, onProgress) => this.invoke(req, onProgress),
      status: () => this.status(),
      pushImport: (msg) => this.pushImport(msg),
    };
    this.tickets = { create: () => this.createTicket() };
  }

  /** 作業中か（primary の Hub に、シートのある窓か実行中のツール呼び出しがある）。primary でなければ false */
  isBusy(): boolean {
    return this.roleValue === "primary" && this.bridge !== null ? this.bridge.hub.isBusy() : false;
  }

  get role(): BridgeRole {
    return this.roleValue;
  }

  /** primary のときの待ち受け（client のときは null） */
  get server(): BridgeServer | null {
    return this.roleValue === "primary" ? this.bridge : null;
  }

  /** 役割を決める。conflict・error のときは何も待ち受けていない */
  async start(): Promise<CoordinatorStart> {
    if (this.roleValue !== "idle") throw new Error("start は 1 回だけ呼べます");
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
      // ポートを取りに行く前に、127.0.0.1:<port> で誰かが応答するかを聞く。
      // Windows（と macOS）では、別のアプリが 0.0.0.0 や [::] で待ち受けていても 127.0.0.1 での待ち受けが成功し
      // （EADDRINUSE にならない）、黙ってそのアプリの手前に割り込んでしまう。応答があればポートを取りに行かない。
      // 何も待ち受けていなければ接続はすぐ拒まれる（"down"）。
      const probe = await probeBridgeHealth(this.port, this.opts.probeTimeoutMs);
      if (probe.kind === "down") {
        try {
          const bridge = await this.listen();
          this.becomePrimary(bridge, false);
          return { kind: "primary", bridge };
        } catch (err) {
          if (!isPortInUseError(err)) return { kind: "error", message: `ポート ${this.port} で橋渡しを起動できませんでした。` };
          // 聞いてから取りに行くまでの間に他の橋渡しが先に取った（または Windows が予約している）。もう一度聞く
          continue;
        }
      }
      switch (probe.kind) {
        case "bridge":
          if (probe.health.protocol !== BRIDGE_PEER_PROTOCOL) {
            return {
              kind: "conflict",
              message: `ポート ${this.port} では版の違う MX Stage の橋渡し（${probe.health.version.slice(0, 40)}）が動いています。すべての MX Stage の橋渡しを止めてから起動し直してください。`,
            };
          }
          this.roleValue = "client";
          this.startWatch();
          return { kind: "client", health: probe.health };
        case "legacy":
          return {
            kind: "conflict",
            message: `ポート ${this.port} では古い版の MX Stage の橋渡しが動いています。それを止めてから起動し直してください。`,
          };
        case "renamed":
          return {
            kind: "conflict",
            message:
              `ポート ${this.port} では改名前の mxstudio の橋渡し${probe.version ? `（${probe.version}）` : ""}が動いています。` +
              "Claude などの LLM のアプリをすべて終了し、mxstage.cmd（または node scripts/setup-local.mjs）を実行してから開き直してください。",
          };
        case "other":
          // 終わりかけの橋渡し（Claude が試しに起動してすぐ止めたもの・入れ替えで止まる古い版）は、
          // 接続を切るだけで health に答えないことがある。すぐに別のアプリと決めず、少し待って聞き直す
          if (attempt < START_ATTEMPTS - 1) {
            await new Promise((done) => setTimeout(done, this.opts.startRetryDelayMs ?? START_RETRY_DELAY_MS));
            continue;
          }
          return { kind: "conflict", message: `ポート ${this.port} は別のアプリが使っています。--port で別の番号を指定してください。` };
      }
    }
    return {
      kind: "conflict",
      message: `ポート ${this.port} は別のアプリが使っています（または Windows が予約しています）。--port で別の番号を指定してください。`,
    };
  }

  /**
   * client なら、ポートが空いていれば取り直して primary になる。primary になれたら true。
   * 同じプロセスの中で同時に呼ばれても 1 回にまとめる（プロセスをまたいだ取り合いは OS が 1 つに決める）。
   */
  tryTakeOver(): Promise<boolean> {
    if (this.roleValue !== "client") return Promise.resolve(this.roleValue === "primary");
    if (this.takeover) return this.takeover;
    const attempt = (async (): Promise<boolean> => {
      let bridge: BridgeServer;
      try {
        bridge = await this.listen();
      } catch {
        // まだ primary が居る（または他の橋渡しが先に取った）
        return false;
      }
      if (this.roleValue !== "client") {
        // 取り直している間に終了した
        await bridge.close().catch(() => undefined);
        return false;
      }
      this.becomePrimary(bridge, true);
      return true;
    })();
    this.takeover = attempt;
    void attempt.finally(() => {
      if (this.takeover === attempt) this.takeover = null;
    });
    return attempt;
  }

  /**
   * ポートを持つ橋渡し（primary）のコードが、起動したあとに変わったか。
   * primary なら自分の値、client なら primary の health に載った値。分からなければ null（古い版の primary など）。
   */
  async primaryStale(): Promise<boolean | null> {
    if (this.roleValue === "primary") return this.opts.codeStale?.() ?? null;
    if (this.roleValue !== "client") return null;
    const probe = await probeBridgeHealth(this.port, this.opts.probeTimeoutMs);
    return probe.kind === "bridge" && typeof probe.health.stale === "boolean" ? probe.health.stale : null;
  }

  async close(): Promise<void> {
    const previous = this.roleValue;
    this.roleValue = "closed";
    this.stopWatch();
    const pending = this.takeover;
    if (pending) await pending.catch(() => false);
    if (previous === "primary" && this.bridge) await this.bridge.close();
    this.bridge = null;
  }

  // -------------------------------------------------------------------------

  private listen(): Promise<BridgeServer> {
    const hub = this.opts.createHub ? this.opts.createHub() : new LocalHub();
    return startBridgeServer({
      port: this.port,
      root: this.opts.root,
      allowedHosts: this.opts.allowedHosts ?? [],
      insecure: this.opts.insecure === true,
      requestImpl: this.opts.requestImpl,
      upstreamTimeoutMs: this.opts.upstreamTimeoutMs,
      hub,
      tickets: new ImportTickets(),
      keyStore: this.opts.keyStore,
      version: this.opts.version,
      userSkillsDir: this.opts.userSkillsDir ?? null,
      ...(this.opts.codeStale !== undefined ? { codeStale: this.opts.codeStale } : {}),
      license: this.opts.license ?? null,
      connections: this.opts.connections ?? null,
      updates: this.opts.updates ?? null,
      demo: this.opts.demo ?? null,
    });
  }

  private becomePrimary(bridge: BridgeServer, tookOver: boolean): void {
    this.bridge = bridge;
    this.roleValue = "primary";
    this.stopWatch();
    if (tookOver) {
      // 前の primary につながっていたタブがつなぎ直してくるのを、猶予の間だけ待つ
      bridge.hub.expectReconnect();
      this.log(`mxstage bridge ${this.opts.version} listening on ${bridge.origin} (took over as primary)`);
      this.log("primary の橋渡しが終了したため、このプロセスがポートを引き継ぎました。");
    }
    if (!bridge.keyReady) this.log("警告: 橋渡しの鍵ファイルを用意できませんでした。他の MCP クライアントからの中継は受け付けられません。");
  }

  private startWatch(): void {
    const ms = this.opts.watchIntervalMs ?? 0;
    if (ms <= 0 || this.watchTimer !== undefined) return;
    this.watchTimer = setInterval(() => {
      void this.tryTakeOver().catch(() => false);
    }, ms);
    // 見張りのためだけにプロセスを生かし続けない（MCP の stdin が閉じたら終わる）
    this.watchTimer.unref?.();
  }

  private stopWatch(): void {
    if (this.watchTimer !== undefined) clearInterval(this.watchTimer);
    this.watchTimer = undefined;
  }

  /** 呼び出しの前に役割を確かめ、primary ならローカルの Hub を返す */
  private async localHub(): Promise<LocalHub | null> {
    if (this.roleValue === "client") await this.tryTakeOver();
    return this.roleValue === "primary" && this.bridge ? this.bridge.hub : null;
  }

  private notRunning(): Error {
    return new Error(this.roleValue === "closed" ? "橋渡しは終了しています" : "橋渡しはまだ起動していません");
  }

  private async invoke(req: HubInvokeRequest, onProgress?: (p: InvokeProgress) => unknown): Promise<HubInvokeResponse> {
    // 接続を拒まれた（primary が居なくなった）ら、何も実行されていないので引き継いでから送り直す
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const local = await this.localHub();
      if (local) return onProgress ? local.invoke(req, onProgress) : local.invoke(req);
      if (this.roleValue !== "client") throw this.notRunning();
      try {
        return await this.remote.invoke(req, onProgress);
      } catch (err) {
        if (!(err instanceof PeerUnreachableError)) throw err;
      }
    }
    // 送れていないので実行されていない。読み取り・書き込みとも再試行してよい
    return {
      ok: false,
      code: RelayErrorCode.TAB_DISCONNECTED,
      message: relayErrorMessage(RelayErrorCode.TAB_DISCONNECTED, this.origin),
      retryable: true,
    };
  }

  private async status(): Promise<HubStatus> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const local = await this.localHub();
      if (local) return local.status();
      if (this.roleValue !== "client") throw this.notRunning();
      try {
        return await this.remote.status();
      } catch (err) {
        if (!(err instanceof PeerUnreachableError)) throw err;
      }
    }
    throw new Error("primary の橋渡しに接続できませんでした");
  }

  private async pushImport(msg: ImportChunkMsg): Promise<{ delivered: boolean }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const local = await this.localHub();
      if (local) return local.pushImport(msg);
      if (this.roleValue !== "client") return { delivered: false };
      try {
        return await this.remote.pushImport(msg);
      } catch (err) {
        if (!(err instanceof PeerUnreachableError)) return { delivered: false };
      }
    }
    return { delivered: false };
  }

  private async createTicket(): Promise<ImportTicket> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.localHub();
      if (this.roleValue === "primary" && this.bridge) return this.bridge.tickets.create();
      if (this.roleValue !== "client") throw this.notRunning();
      try {
        return await this.remote.createImportTicket();
      } catch (err) {
        if (!(err instanceof PeerUnreachableError)) throw err;
      }
    }
    throw new Error("primary の橋渡しに接続できませんでした");
  }
}
