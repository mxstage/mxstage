// 新しい版の確認と入れ替え（設定の「更新」）。
// - 既定はオフ。オフの間は外へ一切問い合わせない（利用者が「今すぐ確かめる」を押したときだけ 1 回問い合わせる）。
// - オンにすると 1 日 1 回、GitHub のリリース（api.github.com）に最新の版の番号だけを問い合わせる。こちらの情報は送らない。
// - 導入スクリプト（git）で入れたもの: 新しい版があり、作業中でない（シートのある窓・実行中のツール呼び出しが無い）とき、
//   リリースのタグまで早送りし、導入（依存の取得と画面の作成）をやり直して、橋渡しを起動し直す。
//   手元に変更がある・main 以外・取得元が違うときは触らない（開発用の写しを壊さない）。
// - Claude Desktop の拡張機能（.mcpb）で入れたもの: 自分では入れ替えない（Claude Desktop が管理する場所のため）。
//   利用者が押したら、新しい .mcpb をダウンロードして SHA-256 を確かめ、置き場所を開く（利用者が Claude Desktop で入れる）。
// 設定と最後に確かめた結果は状態フォルダの updates.json に置く。

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const UPDATES_FILE = "updates.json";
export const RELEASES_LATEST_URL = "https://api.github.com/repos/mxstage/mxstage/releases/latest";
const REPO_URL_RE = /github\.com[/:]mxstage\/mxstage(\.git)?\/?$/i;
/** 自動の確認の間隔 */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 自動の確認・入れ替えを見張る間隔 */
export const TICK_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_MCPB_BYTES = 100 * 1024 * 1024;

export type InstallKind = "git" | "bundle";

export interface LatestRelease {
  version: string;
  tag: string;
  publishedAt: string | null;
  pageUrl: string;
  /** .mcpb と、その SHA-256 のファイル（無ければ null） */
  mcpbUrl: string | null;
  sha256Url: string | null;
}

export type UpdatePhase = "idle" | "checking" | "waiting" | "applying" | "downloading" | "restart_needed" | "error";

export interface UpdateStatus {
  current: string;
  kind: InstallKind;
  autoUpdate: boolean;
  lastCheckAt: number | null;
  latest: LatestRelease | null;
  /** latest が current より新しい */
  available: boolean;
  phase: UpdatePhase;
  /** phase が error のときの理由（短い英語のコード） */
  error: string | null;
  /** .mcpb をダウンロードした場所（bundle のとき） */
  downloaded: string | null;
}

interface Stored {
  autoUpdate: boolean;
  lastCheckAt: number | null;
  latest: LatestRelease | null;
}

/** 1.2.3 の比較（前に v が付いていてもよい。数字以外の部分は無視） */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .slice(0, 3)
      .map((p) => Number.parseInt(p, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** GitHub の応答から必要なものだけを取り出す */
export function parseLatestRelease(json: unknown): LatestRelease | null {
  if (!json || typeof json !== "object") return null;
  const v = json as Record<string, unknown>;
  if (typeof v.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/.test(v.tag_name)) return null;
  if (v.draft === true || v.prerelease === true) return null;
  const assets = Array.isArray(v.assets) ? (v.assets as Record<string, unknown>[]) : [];
  const url = (suffix: string) => {
    const found = assets.find((a) => typeof a.name === "string" && a.name.endsWith(suffix) && typeof a.browser_download_url === "string");
    const u = found?.browser_download_url as string | undefined;
    return u && u.startsWith("https://github.com/mxstage/mxstage/releases/download/") ? u : null;
  };
  return {
    version: v.tag_name.slice(1),
    tag: v.tag_name,
    publishedAt: typeof v.published_at === "string" ? v.published_at : null,
    pageUrl: `https://github.com/mxstage/mxstage/releases/tag/${v.tag_name}`,
    mcpbUrl: url(".mcpb"),
    sha256Url: url(".mcpb.sha256"),
  };
}

/** コマンドを動かす口（試験で差し替える）。標準出力を返す。失敗したら例外 */
export type RunCommand = (file: string, args: readonly string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>;

const runCommand: RunCommand = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, IBM_TELEMETRY_DISABLED: "true" } }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });

export interface UpdateManagerOptions {
  /** 状態フォルダ（~/.config/mxstage） */
  dir: string;
  current: string;
  kind: InstallKind;
  /** git のとき、リポジトリの根 */
  repoRoot?: string;
  /** 作業中か（シートのある窓・実行中のツール呼び出し）。作業中は入れ替えない */
  isBusy: () => boolean;
  /** この橋渡しがポートを持っているか（primary だけが確かめ・入れ替えを行う） */
  isPrimary: () => boolean;
  /** 入れ替えたあとに橋渡しを起動し直す。できない（AI クライアントが起動した橋渡し）なら null */
  restart?: (() => void) | null;
  fetch?: typeof fetch;
  run?: RunCommand;
  now?: () => number;
  log?: (line: string) => void;
  /** 置き場所を開く（.mcpb のダウンロードのあと） */
  reveal?: (path: string) => void;
}

export class UpdateManager {
  private readonly file: string;
  private readonly opts: UpdateManagerOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly run: RunCommand;
  private readonly now: () => number;
  private phase: UpdatePhase = "idle";
  private error: string | null = null;
  private downloaded: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<unknown> | null = null;

  constructor(opts: UpdateManagerOptions) {
    this.opts = opts;
    this.file = join(opts.dir, UPDATES_FILE);
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.run = opts.run ?? runCommand;
    this.now = opts.now ?? Date.now;
  }

  status(): UpdateStatus {
    const s = this.read();
    return {
      current: this.opts.current,
      kind: this.opts.kind,
      autoUpdate: s.autoUpdate,
      lastCheckAt: s.lastCheckAt,
      latest: s.latest,
      available: s.latest !== null && compareVersions(s.latest.version, this.opts.current) > 0,
      phase: this.phase,
      error: this.error,
      downloaded: this.downloaded,
    };
  }

  /** 自動の更新を切り替える。オンにしたらすぐ 1 回確かめる */
  async setAutoUpdate(on: boolean): Promise<UpdateStatus> {
    this.write({ ...this.read(), autoUpdate: on });
    if (on) await this.check();
    return this.status();
  }

  /** 新しい版を確かめる（利用者が押したとき・自動の確認） */
  async check(): Promise<UpdateStatus> {
    if (this.busy) {
      await this.busy.catch(() => undefined);
      return this.status();
    }
    const task = this.doCheck();
    this.busy = task;
    try {
      await task;
    } finally {
      this.busy = null;
    }
    return this.status();
  }

  private async doCheck(): Promise<void> {
    this.phase = "checking";
    this.error = null;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        // こちらの情報は送らない（GitHub の API が求める User-Agent と Accept だけ）
        res = await this.fetchImpl(RELEASES_LATEST_URL, { headers: { accept: "application/vnd.github+json", "user-agent": "mxstage-update-check" }, signal: controller.signal });
      } finally {
        clearTimeout(t);
      }
      if (!res.ok) throw new Error(`http_${res.status}`);
      const latest = parseLatestRelease(await res.json());
      if (!latest) throw new Error("no_release");
      this.write({ ...this.read(), lastCheckAt: this.now(), latest });
      this.phase = compareVersions(latest.version, this.opts.current) > 0 && this.opts.kind === "git" ? "waiting" : "idle";
    } catch (e) {
      this.phase = "error";
      this.error = e instanceof Error && /^[a-z_0-9]+$/.test(e.message) ? e.message : "check_failed";
    }
  }

  /** 自動の確認と入れ替えを始める（primary のときだけ働く） */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 見張り: 1 日 1 回確かめ、git なら作業中でないときに入れ替える */
  async tick(): Promise<void> {
    if (!this.opts.isPrimary() || this.busy) return;
    const s = this.read();
    if (!s.autoUpdate) return;
    if (s.lastCheckAt === null || this.now() - s.lastCheckAt >= CHECK_INTERVAL_MS) await this.check();
    const status = this.status();
    // 失敗したら翌日の確認まで待つ（作業中で断っただけなら、作業が終わり次第入れ替える）
    const blocked = this.phase === "restart_needed" || (this.phase === "error" && this.error !== "busy");
    if (status.available && this.opts.kind === "git" && !blocked && !this.opts.isBusy()) await this.install();
  }

  /**
   * 入れる。git: タグまで早送りして導入をやり直し、橋渡しを起動し直す（作業中なら断る）。
   * bundle: .mcpb をダウンロードして確かめ、置き場所を開く。
   */
  async install(): Promise<UpdateStatus> {
    const status = this.status();
    if (!status.available || !status.latest) return status;
    if (this.busy) return this.status();
    const task = this.opts.kind === "git" ? this.applyGit(status.latest) : this.downloadBundle(status.latest);
    this.busy = task;
    try {
      await task;
    } finally {
      this.busy = null;
    }
    return this.status();
  }

  private fail(code: string): void {
    this.phase = "error";
    this.error = code;
    this.opts.log?.(`update: ${code}`);
  }

  private async applyGit(latest: LatestRelease): Promise<void> {
    const repo = this.opts.repoRoot;
    if (!repo || !existsSync(join(repo, ".git"))) return this.fail("not_git");
    if (this.opts.isBusy()) return this.fail("busy");
    this.phase = "applying";
    this.error = null;
    const git = (...args: string[]) => this.run("git", args, { cwd: repo, timeoutMs: 120_000 });
    try {
      // 開発用の写しや、手を入れた写しは触らない
      const origin = (await git("remote", "get-url", "origin")).trim();
      if (!REPO_URL_RE.test(origin)) return this.fail("other_origin");
      const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).trim();
      if (branch !== "main") return this.fail("not_main");
      if ((await git("status", "--porcelain", "--untracked-files=no")).trim() !== "") return this.fail("local_changes");
      await git("fetch", "--no-tags", "origin", `refs/tags/${latest.tag}:refs/tags/${latest.tag}`);
      await git("merge", "--ff-only", latest.tag);
    } catch {
      return this.fail("git_failed");
    }
    try {
      // 依存の取得と画面の作成（登録もやり直すが、何度実行しても同じ結果になる）
      await this.run(process.execPath, [join(repo, "scripts", "setup-local.mjs"), "--json", "--no-open"], { cwd: repo, timeoutMs: 15 * 60_000 });
    } catch {
      return this.fail("setup_failed");
    }
    this.opts.log?.(`update: ${this.opts.current} → ${latest.version}`);
    if (this.opts.restart) {
      this.opts.restart();
      return;
    }
    // AI クライアントが起動した橋渡しは自分では起動し直せない（クライアントを開き直すと新しい版になる）
    this.phase = "restart_needed";
  }

  private async downloadBundle(latest: LatestRelease): Promise<void> {
    if (!latest.mcpbUrl || !latest.sha256Url) return this.fail("no_asset");
    this.phase = "downloading";
    this.error = null;
    try {
      const shaText = await (await this.fetchImpl(latest.sha256Url)).text();
      const expected = /^([0-9a-f]{64})\b/i.exec(shaText.trim())?.[1]?.toLowerCase();
      if (!expected) return this.fail("no_checksum");
      const res = await this.fetchImpl(latest.mcpbUrl);
      if (!res.ok) return this.fail(`http_${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > MAX_MCPB_BYTES) return this.fail("too_large");
      if (createHash("sha256").update(data).digest("hex") !== expected) return this.fail("checksum_mismatch");
      const dir = join(this.opts.dir, "updates");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `mxstage-${latest.version}.mcpb`);
      writeFileSync(path, data);
      this.downloaded = path;
      this.phase = "idle";
      this.opts.reveal?.(path);
    } catch {
      this.fail("download_failed");
    }
  }

  private read(): Stored {
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Stored>;
      return { autoUpdate: v.autoUpdate === true, lastCheckAt: typeof v.lastCheckAt === "number" ? v.lastCheckAt : null, latest: parseStoredLatest(v.latest) };
    } catch {
      return { autoUpdate: false, lastCheckAt: null, latest: null };
    }
  }

  private write(s: Stored): void {
    mkdirSync(this.opts.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}

function parseStoredLatest(v: unknown): LatestRelease | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.version !== "string" || typeof r.tag !== "string" || typeof r.pageUrl !== "string") return null;
  return {
    version: r.version,
    tag: r.tag,
    publishedAt: typeof r.publishedAt === "string" ? r.publishedAt : null,
    pageUrl: r.pageUrl,
    mcpbUrl: typeof r.mcpbUrl === "string" ? r.mcpbUrl : null,
    sha256Url: typeof r.sha256Url === "string" ? r.sha256Url : null,
  };
}

/** ダウンロードした .mcpb をエクスプローラー（Finder）で選んだ状態で開く */
export function revealInFolder(path: string): void {
  const command = process.platform === "win32" ? { file: "explorer.exe", args: [`/select,${path}`] } : process.platform === "darwin" ? { file: "open", args: ["-R", path] } : null;
  if (!command) return;
  try {
    const child = spawn(command.file, command.args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // 開けなくても、画面に場所を出す
  }
}
