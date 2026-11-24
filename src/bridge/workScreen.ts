// 作業画面（ブラウザのタブ）が要るツールが呼ばれたのにタブが 1 つもつながっていないとき、この PC の既定のブラウザで
// 作業画面（<origin>/app）を開く。開くのは橋渡しで、AI が URL を打たせなくて済む。
// 開き方はデスクトップの mxstage.lnk と同じ: Windows で Chrome か Edge があればアプリ窓（--app=<URL>）、どちらも無ければ既定のブラウザ。
//
// 新しいタブを何枚も開かない:
//   - タブがつながっているあいだは開かない（呼ぶ側が Hub の状態を見てから頼む）。
//   - 開いてから REOPEN_AFTER_MS（60 秒）のあいだは開き直さない（ブラウザが立ち上がってつながるまでの間）。
//   - タブがつながらないまま MAX_OPENS_WITHOUT_TAB 回開いたら、それ以上は開かず、利用者に URL を開いてもらう。
//   - タブがつながったら（tabSeen）数え直す。
// --no-open（拡張機能では設定の「Open the work screen automatically」を切る）では開かない。

import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
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

/** 作業画面をアプリ窓で開くブラウザ（Chrome → Edge の順。scripts/setup-local.mjs の findBrowser と同じ選び方） */
export interface AppBrowser {
  kind: "chrome" | "edge";
  exe: string;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Windows で、作業画面をアプリ窓で開くための実行ファイルを探す。
 * 導入（scripts/setup-local.mjs の findBrowser）がデスクトップの mxstage.lnk を作るときと同じ候補・同じ順にする
 * （tests/bridge/workScreen.test.ts で同じ答えになるかを確かめる）。どちらも無ければ null（既定のブラウザで開く）
 */
export function findAppBrowser(
  exists: (p: string) => boolean = isFile,
  env: NodeJS.ProcessEnv = process.env,
  join: (...parts: string[]) => string = path.join,
): AppBrowser | null {
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const candidates: AppBrowser[] = [
    { kind: "chrome", exe: join(programFiles, "Google", "Chrome", "Application", "chrome.exe") },
    { kind: "chrome", exe: join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe") },
    { kind: "chrome", exe: join(local, "Google", "Chrome", "Application", "chrome.exe") },
    { kind: "edge", exe: join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe") },
    { kind: "edge", exe: join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe") },
  ];
  for (const candidate of candidates) if (exists(candidate.exe)) return candidate;
  return null;
}

/** どう開くか。chrome-app / edge-app: デスクトップの mxstage.lnk と同じアプリ窓、default: 既定のブラウザ（mxstage.url と同じ） */
export type OpenHow = "chrome-app" | "edge-app" | "default";

export interface WorkScreenCommand {
  how: OpenHow;
  file: string;
  args: string[];
  /** アプリ窓は隠さない（windowsHide を付けると最初の窓が出ないことがある。導入の openApp と同じ） */
  windowsHide: boolean;
}

/**
 * 作業画面を開く命令。Windows では、Chrome か Edge があれば --app=<URL> でアプリ窓にする（デスクトップの mxstage.lnk と同じ）。
 * どちらも無いとき・Windows 以外では既定のブラウザ（Windows は cmd /c start、macOS は open、ほかは xdg-open）
 */
export function workScreenCommand(
  url: string,
  opts: { platform?: NodeJS.Platform; browser?: AppBrowser | null } = {},
): WorkScreenCommand {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    const browser = opts.browser === undefined ? findAppBrowser() : opts.browser;
    if (browser !== null) return { how: browser.kind === "chrome" ? "chrome-app" : "edge-app", file: browser.exe, args: [`--app=${url}`], windowsHide: false };
    // windowsHide: cmd /c start のために黒いコンソール窓を一瞬出さない
    return { how: "default", file: "cmd", args: ["/c", "start", "", url], windowsHide: true };
  }
  return { how: "default", file: platform === "darwin" ? "open" : "xdg-open", args: [url], windowsHide: true };
}

/**
 * 作業画面を開く（workScreenCommand の命令）。命令が起動できない・0 以外で終わったら false（xdg-open はブラウザが無いと 3 などで終わる）。
 * LAUNCH_WAIT_MS 待っても終わらなければ、開けたものとみなす（Chrome がまだ動いていなければ、起動した chrome.exe はそのまま動き続ける）
 */
export function launchWorkScreen(
  url: string,
  deps: { spawn?: SpawnLike; platform?: NodeJS.Platform; browser?: AppBrowser | null; waitMs?: number } = {},
): Promise<boolean> {
  const command = workScreenCommand(url, { ...(deps.platform !== undefined ? { platform: deps.platform } : {}), ...(deps.browser !== undefined ? { browser: deps.browser } : {}) });
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
      const child = run(command.file, command.args, { detached: true, stdio: "ignore", windowsHide: command.windowsHide });
      child.on("error", () => done(false));
      child.on("exit", (code) => done(code === 0));
      child.unref();
    } catch {
      done(false);
    }
  });
}
