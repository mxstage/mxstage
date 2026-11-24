// 作業画面（ブラウザのタブ）が要るツールが呼ばれたのにタブが 1 つもつながっていないとき、この PC の既定のブラウザで
// 作業画面（<origin>/app）を開く。開くのは橋渡し（OS の既定のブラウザを起動するだけ）で、AI が URL を打たせなくて済む。
//
// 新しいタブを何枚も開かない:
//   - タブがつながっているあいだは開かない（呼ぶ側が Hub の状態を見てから頼む）。
//   - 開いてから REOPEN_AFTER_MS（60 秒）のあいだは開き直さない（ブラウザが立ち上がってつながるまでの間）。
//   - タブがつながらないまま MAX_OPENS_WITHOUT_TAB 回開いたら、それ以上は開かず、利用者に URL を開いてもらう。
//   - タブがつながったら（tabSeen）数え直す。
// --no-open（拡張機能では設定の「Open the work screen automatically」を切る）では開かない。

import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import type { WorkScreenOpenOutcome } from "../shared/protocol.ts";

/** 開き直すまでの間 */
export const REOPEN_AFTER_MS = 60_000;
/** タブがつながらないまま開く回数の上限 */
export const MAX_OPENS_WITHOUT_TAB = 2;
/** 開く命令の終わりを待つ長さ。過ぎても終わらなければ、開けたものとみなす */
export const LAUNCH_WAIT_MS = 10_000;

/**
 * opened: 今開いた / waiting: 少し前に開いたので、つながるのを待つ（開き直さない） /
 * failed: 開けなかった（ブラウザが無い・命令が失敗した） / gave_up: 開いたがタブがつながらなかった（もう開かない） /
 * off: 開かない設定（--no-open）
 */
export type OpenOutcome = WorkScreenOpenOutcome;

/** URL を既定のブラウザで開く。開けたら true */
export type BrowserLauncher = (url: string) => Promise<boolean>;

export interface WorkScreenOpenerOptions {
  /** 開いてよいか（--no-open なら false） */
  enabled: boolean;
  /** 開く URL（<origin>/app） */
  url: string;
  launch: BrowserLauncher;
  now?: () => number;
  reopenAfterMs?: number;
  maxOpensWithoutTab?: number;
}

export class WorkScreenOpener {
  readonly enabled: boolean;
  readonly url: string;
  private readonly launch: BrowserLauncher;
  private readonly now: () => number;
  private readonly reopenAfterMs: number;
  private readonly maxOpens: number;
  private lastOpenedAt: number | null = null;
  private opensWithoutTab = 0;
  private inFlight: Promise<OpenOutcome> | null = null;

  constructor(opts: WorkScreenOpenerOptions) {
    this.enabled = opts.enabled;
    this.url = opts.url;
    this.launch = opts.launch;
    this.now = opts.now ?? (() => Date.now());
    this.reopenAfterMs = opts.reopenAfterMs ?? REOPEN_AFTER_MS;
    this.maxOpens = opts.maxOpensWithoutTab ?? MAX_OPENS_WITHOUT_TAB;
  }

  /** タブが無いと分かったときに呼ぶ。開くかどうかはここで決める（同時に呼ばれても開く命令は 1 回） */
  request(): Promise<OpenOutcome> {
    if (!this.enabled) return Promise.resolve("off");
    if (this.inFlight !== null) return this.inFlight.then((o) => (o === "opened" ? "waiting" : o));
    if (this.lastOpenedAt !== null && this.now() - this.lastOpenedAt < this.reopenAfterMs) return Promise.resolve("waiting");
    if (this.opensWithoutTab >= this.maxOpens) return Promise.resolve("gave_up");
    this.inFlight = this.launchOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** タブがつながっているのを見たら呼ぶ（次にタブが無くなったら、また開ける） */
  tabSeen(): void {
    this.lastOpenedAt = null;
    this.opensWithoutTab = 0;
  }

  private async launchOnce(): Promise<OpenOutcome> {
    let ok = false;
    try {
      ok = await this.launch(this.url);
    } catch {
      ok = false;
    }
    if (!ok) return "failed";
    this.lastOpenedAt = this.now();
    this.opensWithoutTab += 1;
    return "opened";
  }
}

type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => {
  on(event: "error", listener: (e: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  unref(): void;
};

/** OS ごとの開く命令（標準入出力は渡さない） */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  return platform === "win32"
    ? { file: "cmd", args: ["/c", "start", "", url] }
    : platform === "darwin"
      ? { file: "open", args: [url] }
      : { file: "xdg-open", args: [url] };
}

/**
 * 既定のブラウザで開く。命令が起動できない・0 以外で終わったら false（xdg-open はブラウザが無いと 3 などで終わる）。
 * LAUNCH_WAIT_MS 待っても終わらなければ、開けたものとみなす
 */
export function launchDefaultBrowser(
  url: string,
  deps: { spawn?: SpawnLike; platform?: NodeJS.Platform; waitMs?: number } = {},
): Promise<boolean> {
  const command = browserCommand(url, deps.platform);
  const run = deps.spawn ?? (spawn as unknown as SpawnLike);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => done(true), deps.waitMs ?? LAUNCH_WAIT_MS);
    // 待つあいだも橋渡しの終了を妨げない
    timer.unref?.();
    try {
      // windowsHide: cmd /c start のために黒いコンソール窓を一瞬出さない
      const child = run(command.file, command.args, { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", () => done(false));
      child.on("exit", (code) => done(code === 0));
      child.unref();
    } catch {
      done(false);
    }
  });
}
