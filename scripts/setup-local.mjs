#!/usr/bin/env node
// mxstudio をこの PC に入れる（1 ステップ導入）と、その取り消し。
// 橋渡し（ローカルで動く Node のプロセス）を起動し、Claude Code と Claude Desktop と
// Antigravity（2.0・IDE・agy CLI。入っているときだけ）に MCP サーバとして登録し、
// ログイン時の自動起動とアプリのショートカットを作る。
// Node の標準機能だけで動く（依存を足さない）。何度実行しても壊れない（冪等）。
//
//   node scripts/setup-local.mjs [オプション]        導入する
//   node scripts/setup-local.mjs --uninstall         取り消す
//   node scripts/setup-local.mjs --status            今の状態を見るだけ（何も書き換えない）
//
// 利用者の設定ファイル（~/.claude.json、Claude Desktop の設定、~/.gemini/config/mcp_config.json）を書き換えるので、
// **書き換える前に必ずバックアップを取る**。既存の設定は消さない。取り消し方は画面と docs/local.md に出す。
// 秘密（個人トークン・API キー）は画面にも自分の記録（setup.json）にも書かない。
// 置き換えた古い MCP 設定は、値を伏せた要約だけを記録し、戻すときはバックアップから読み直す。
//
// 終了コード: 0 = 終わった（警告はありうる）、1 = 失敗した手順がある、2 = 引数が不正。

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 橋渡しとの取り決め（contract）
// ---------------------------------------------------------------------------

/** Claude の設定に入れる MCP サーバ名 */
const MCP_NAME = "mxstudio";
/**
 * 橋渡しの取り決め:
 * - 橋渡しは 1 つだけ。ポートは固定（既定 8788）で、塞がっていても隣のポートへはずらさない。
 * - 最初に起動した橋渡しがポートを持ち（primary）、2 つ目以降（Claude Code / Claude Desktop が起動した分など）は
 *   client としてその橋渡しに中継する。
 * - `GET /_mxstudio/health` が `{ name: "mxstudio-bridge", ... }` を返す。これで「橋渡しが動いている」ことを確かめる。
 * 古い版の橋渡し（/_mxstudio/health が無い）は、/ws が 426 と upgrade_required を返すことで見分ける。
 */
const BRIDGE_NAME = "mxstudio-bridge";
const HEALTH_PATH = "/_mxstudio/health";
/**
 * 橋渡しの入口。上から順に探し、最初に見つかったものを使う（--bridge で上書きできる）。
 * Node 22 は .ts をそのまま実行できる（型注釈を取り除いて動かす）。
 */
const BRIDGE_CANDIDATES = [
  "src/bridge/cli.ts",
  "src/bridge/main.ts",
  "src/bridge/index.ts",
  "src/bridge/cli.mjs",
  "src/bridge/main.mjs",
  "dist/bridge/cli.js",
  "bin/mxstudio-bridge.mjs",
];
/** 画面と WebSocket だけを動かす（stdio の MCP を開かない）ときに橋渡しへ渡す引数（src/bridge/options.ts） */
const BRIDGE_SERVE_ARGS = ["--no-mcp"];
/** 既定のポート。橋渡しの既定（src/bridge/server.ts の DEFAULT_PORT）と合わせる。ずらさない */
const DEFAULT_PORT = 8788;
/**
 * 古い版の橋渡しは、ポートが塞がっていると +1 して別に立ち上がっていた。
 * その残り（更新前から動き続けているもの）を見つけるために、隣のポートをこの数だけ見る。
 */
const LEGACY_SCAN_COUNT = 20;

/**
 * 試験の目印。この環境変数が "1" のときは、書き先がすべて一時フォルダでなければ何もせずに止まり、
 * 本物の claude コマンドを探さない（tests/setup/ が設定する。条件は testSandboxProblem）。
 */
const TEST_GUARD_ENV = "MXSTUDIO_SETUP_TEST";
/** claude コマンドの場所を差し替える環境変数（--claude-cli と同じ。引数が優先） */
const CLAUDE_CLI_ENV = "MXSTUDIO_CLAUDE_CLI";

/** スタートアップとデスクトップに置くショートカットの名前（取り消しのときはこの名前で消す） */
const STARTUP_SHORTCUT = "mxstudio-bridge.lnk";
const DESKTOP_SHORTCUT_LNK = "mxstudio.lnk";
const DESKTOP_SHORTCUT_URL = "mxstudio.url";

/** 橋渡しが立ち上がるのを待つ時間 */
const START_TIMEOUT_MS = 20_000;
const PROBE_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 1_500;
/** 取り消しで橋渡しを止めたあと、別の橋渡し（Claude が起動した client）がポートを引き継がないか見張る時間 */
const TAKEOVER_WATCH_MS = 4_000;

// ---------------------------------------------------------------------------
// 手順の記録
// ---------------------------------------------------------------------------

/** 橋渡しを動かせる Node の最小版（--experimental-strip-types が入った版） */
export const MIN_NODE = [22, 6, 0];

/** "22.19.0" のような版が MIN_NODE 以上か */
export function nodeVersionOk(version) {
  const parts = String(version).replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < MIN_NODE.length; i++) {
    const a = parts[i] ?? 0;
    const b = MIN_NODE[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** 画面と Skill のもと。どれかが dist/app/index.html より新しければビルドし直す */
export const BUILD_SOURCES = ["src/app", "src/shared", "skills", "public", "vite.config.ts", "package-lock.json"];

/** ファイルかフォルダの中で一番新しい更新時刻（ミリ秒。無ければ 0） */
export function newestMtime(target) {
  let info;
  try {
    info = statSync(target);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.mtimeMs;
  let newest = 0;
  for (const name of readdirSync(target)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    newest = Math.max(newest, newestMtime(path.join(target, name)));
  }
  return newest;
}

/** npm install が要るか。要るならその理由、要らなければ null */
export function needsInstall(repoRoot) {
  const modules = path.join(repoRoot, "node_modules");
  if (!isDir(modules)) return "node_modules がありません";
  const lock = newestMtime(path.join(repoRoot, "package-lock.json"));
  const installed = newestMtime(path.join(modules, ".package-lock.json"));
  if (lock > 0 && lock > installed) return "依存の一覧（package-lock.json）が更新されています";
  return null;
}

/** npm run build が要るか。要るならその理由、要らなければ null */
export function needsBuild(repoRoot) {
  const built = newestMtime(path.join(repoRoot, "dist", "app", "index.html"));
  if (built === 0) return "画面のビルド（dist/app）がありません";
  const newer = BUILD_SOURCES.filter((rel) => newestMtime(path.join(repoRoot, rel)) > built);
  if (newer.length > 0) return `画面か Skill のもと（${newer.join(", ")}）がビルドより新しくなっています`;
  return null;
}

/** level: "ok" | "warn" | "error" | "skip"。error が 1 件でもあれば終了コードは 1 */
export function step(level, id, message, hint) {
  return hint ? { level, id, message, hint } : { level, id, message };
}

const LABEL = { ok: "OK  ", warn: "警告", error: "NG  ", skip: "飛ばした" };

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

const USAGE = `mxstudio をこの PC に入れる（1 ステップ導入）

  node scripts/setup-local.mjs [オプション]
  node scripts/setup-local.mjs --uninstall
  node scripts/setup-local.mjs --status

  --uninstall              取り消す（Claude の設定から外す・ショートカットを消す・橋渡しを止める）
  --status                 今の状態を出すだけ（何も書き換えない）
  --port <番号>            使うポート（既定: ${DEFAULT_PORT}。橋渡しは Claude と同じポートを共有するので、塞がっていてもずらさない）
  --bridge <パス>          橋渡しの入口（既定: ${BRIDGE_CANDIDATES[0]} などを順に探す）
  --dry-run                書き換えずに、やることだけ出す
  --no-install             npm install を実行しない
  --no-build               npm run build を実行しない
  --no-start               橋渡しを起動しない
  --no-autostart           ログイン時の自動起動を作らない
  --no-shortcut            デスクトップのショートカットを作らない
  --no-open                最後にアプリを開かない
  --no-skills              Claude Code と Antigravity に Skill（作業手順書）を入れない
  --no-antigravity         Antigravity（2.0・IDE・agy CLI）に登録しない（~/.gemini が無ければ、指定しなくても登録しない）
  --json                   機械可読な JSON で結果を出す
  --help                   この説明を出す

  試験用（ふだんは使わない。書き換え先を差し替える）:
  --state-dir <パス>          記録とバックアップの置き場（既定: ~/.config/mxstudio）
  --claude-code-config <パス> Claude Code の設定ファイル（既定: ~/.claude.json）
  --claude-desktop-config <パス> Claude Desktop の設定ファイル
  --startup-dir <パス>        スタートアップフォルダ
  --desktop-dir <パス>        デスクトップフォルダ
  --claude-skills-dir <パス>  Claude Code の Skill の置き場所（既定: ~/.claude/skills）
  --antigravity-dir <パス>    Antigravity の設定フォルダ（既定: ~/.gemini。MCP は config/mcp_config.json、Skill は skills/）
  --claude-cli <パス>         claude コマンドの場所（環境変数 ${CLAUDE_CLI_ENV} でも指定できる）。
                              使うのは Claude Code の設定が既定の場所のときだけ（試験中は一時フォルダの偽物だけ）
  環境変数 ${TEST_GUARD_ENV}=1  試験中の印。書き先（一時フォルダの中で、本物の書き先でないこと）・--port・--bridge・
                              --no-open・--no-install・--no-build（Skill を入れるなら --claude-skills-dir、
                              Antigravity に登録するなら --antigravity-dir も）がそろっていなければ止まり、
                              本物の claude コマンドを探さない

終了コード: 0 = 終わった、1 = 失敗した手順がある、2 = 引数が不正`;

export function parseArgs(argv) {
  const opts = {
    mode: "install",
    port: null,
    bridge: null,
    dryRun: false,
    install: true,
    build: true,
    start: true,
    autostart: true,
    shortcut: true,
    open: true,
    skills: true,
    antigravity: true,
    json: false,
    help: false,
    stateDir: null,
    claudeCodeConfig: null,
    claudeDesktopConfig: null,
    startupDir: null,
    desktopDir: null,
    claudeSkillsDir: null,
    antigravityDir: null,
    claudeCli: null,
  };
  const withValue = {
    "--port": "port",
    "--bridge": "bridge",
    "--state-dir": "stateDir",
    "--claude-code-config": "claudeCodeConfig",
    "--claude-desktop-config": "claudeDesktopConfig",
    "--startup-dir": "startupDir",
    "--desktop-dir": "desktopDir",
    "--claude-skills-dir": "claudeSkillsDir",
    "--antigravity-dir": "antigravityDir",
    "--claude-cli": "claudeCli",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--uninstall") opts.mode = "uninstall";
    else if (arg === "--status") opts.mode = "status";
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--no-install") opts.install = false;
    else if (arg === "--no-build") opts.build = false;
    else if (arg === "--no-start") opts.start = false;
    else if (arg === "--no-autostart") opts.autostart = false;
    else if (arg === "--no-shortcut") opts.shortcut = false;
    else if (arg === "--no-open") opts.open = false;
    else if (arg === "--no-skills") opts.skills = false;
    else if (arg === "--no-antigravity") opts.antigravity = false;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else {
      const eq = arg.indexOf("=");
      const name = eq > 0 ? arg.slice(0, eq) : arg;
      const key = withValue[name];
      if (!key) return { error: `知らない引数です: ${arg}` };
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "") return { error: `${name} には値が必要です。` };
      opts[key] = value;
    }
  }
  if (opts.port !== null) {
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `--port は 1〜65535 の整数です: ${opts.port}` };
    opts.port = port;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// ファイルの読み書き（壊さないための決まり）
// ---------------------------------------------------------------------------

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** JSON を読む。読めない（壊れている）ときは書き換えを諦めるために error を返す */
export function readJsonFile(filePath) {
  if (!existsSync(filePath)) return { exists: false, json: {} };
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    return { exists: true, error: `読めません: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw.trim() === "") return { exists: true, json: {}, raw };
  try {
    const json = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (json === null || typeof json !== "object" || Array.isArray(json)) return { exists: true, raw, error: "JSON のオブジェクトではありません。" };
    return { exists: true, json, raw };
  } catch (err) {
    return { exists: true, raw, error: `JSON として読めません: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 一時ファイルに書いてから置き換える（途中で止まっても元のファイルを壊さない） */
function writeJsonFileAtomic(filePath, json) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.mxstudio.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`, "utf8");
    renameSync(tmp, filePath);
  } catch (err) {
    // 置き換えられなかった（ほかのプログラムが開いている等）。一時ファイルを残さない
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 一時ファイルが残っても、元のファイルは書き換わっていない
    }
    throw err;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** 書き換える前のファイルを控える。控えた場所を返す（元が無ければ null） */
function backupFile(filePath, backupDir) {
  if (!existsSync(filePath)) return null;
  mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, `${path.basename(filePath)}.${timestamp()}.bak`);
  copyFileSync(filePath, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// MCP の設定（Claude Code / Claude Desktop）
// ---------------------------------------------------------------------------

/**
 * Claude Code に入れる形。`claude mcp add --scope user mxstudio -- <node> <入口> --port <番号>` が
 * 書くものと同じ形にしてある（type/command/args/env）。
 */
export function buildCodeEntry(nodePath, bridgeEntry, port) {
  return { type: "stdio", command: nodePath, args: [...bridgeArgs(bridgeEntry, port)], env: {} };
}

/** Claude Desktop に入れる形（Desktop の設定は type を使わない） */
export function buildDesktopEntry(nodePath, bridgeEntry, port) {
  return { command: nodePath, args: [...bridgeArgs(bridgeEntry, port)] };
}

/**
 * Antigravity に入れる形（~/.gemini/config/mcp_config.json。2.0・IDE・agy CLI が同じファイルを読む）。
 * stdio は command / args だけで、type は使わない。env は渡さない（Antigravity の env の受け渡しには不具合の報告があり、橋渡しも要らない）。
 */
export function buildAntigravityEntry(nodePath, bridgeEntry, port) {
  return { command: nodePath, args: [...bridgeArgs(bridgeEntry, port)] };
}

/**
 * node に渡す引数。入口が .ts のときは型を取り除いて実行する指定を先に置く
 * （Node 22.18 以降は既定で動くが、それより前でも動くように明示する）。
 * Claude の設定に書くのはこの導入を動かしている node そのものなので、その node が
 * 知らない指定（将来の版で消えた場合）は付けない。付けると Claude から起動できなくなる。
 */
export function nodeFlagsFor(bridgeEntry, accepts = (flag) => process.allowedNodeEnvironmentFlags.has(flag)) {
  if (!bridgeEntry.toLowerCase().endsWith(".ts")) return [];
  return accepts("--experimental-strip-types") ? ["--experimental-strip-types"] : [];
}

/** 橋渡しを起動する引数（node に渡す並び。extra は --no-mcp など） */
export function bridgeArgs(bridgeEntry, port, extra = []) {
  return [...nodeFlagsFor(bridgeEntry), bridgeEntry, ...extra, "--port", String(port)];
}

/** 同じ起動の仕方か（type と env の有無は問わない） */
export function isSameEntry(a, b) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (a.command !== b.command) return false;
  const left = Array.isArray(a.args) ? a.args : [];
  const right = Array.isArray(b.args) ? b.args : [];
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/** mxstudio の橋渡しを指している設定か（取り消しのとき、人が自分で足した設定を消さないため） */
export function isOurEntry(entry, bridgeEntry) {
  if (!entry || typeof entry !== "object") return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (bridgeEntry && args.some((a) => typeof a === "string" && path.resolve(a) === path.resolve(bridgeEntry))) return true;
  return args.some((a) => typeof a === "string" && /[\\/]bridge[\\/]/.test(a));
}

/**
 * この導入が書く形そのものか（`node [--experimental-strip-types] <…/src/bridge/cli.ts など> --port <番号>`）。
 * 入口がどこにあっても（リポジトリを移した・消した後でも）この形なら、前にこの導入が書いたものと見なす。
 */
export function isSetupShapedEntry(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.command !== "string" || !Array.isArray(entry.args)) return false;
  const base = entry.command.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (base !== "node" && base !== "node.exe") return false;
  const args = [...entry.args];
  if (args[0] === "--experimental-strip-types") args.shift();
  if (args.length !== 3 || typeof args[0] !== "string" || args[1] !== "--port" || !/^\d{1,5}$/.test(String(args[2]))) return false;
  const script = args[0].replace(/\\/g, "/").toLowerCase();
  return BRIDGE_CANDIDATES.some((candidate) => script.endsWith(`/${candidate.toLowerCase()}`));
}

/** 前回の導入の記録（setup.json）から、そのとき Claude に書いた設定を組み立て直す */
export function lastWrittenEntries(state) {
  if (!state || typeof state.nodePath !== "string" || typeof state.bridgeEntry !== "string" || !Number.isInteger(state.port)) return [];
  return [buildCodeEntry(state.nodePath, state.bridgeEntry, state.port)];
}

/**
 * コマンド名を PATH から探す。見つかればその場所、見つからなければ null、
 * PATH が無くて判断できなければ undefined（「無い」と決めつけない）。
 */
export function findOnPath(command, env = process.env, exists = isFile) {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  const dirs = String(raw)
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  if (dirs.length === 0) return undefined;
  const exts = process.platform === "win32" && path.extname(command) === "" ? String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * MCP の設定（stdio）の command / args が指すファイルのうち、見つからないものを返す。
 * - command: 絶対パスならそのファイル（Windows は拡張子を省いた書き方も認める）、名前だけなら PATH から探す。
 * - args: フラグでない絶対パスで、拡張子が付いているもの（node に渡すスクリプトなど）。
 * 相対パスは、どこから起動されるか分からないので問わない。URL の設定（type: http）はファイルを指さないので問わない。
 * 形が壊れている（オブジェクトでない・command も url も無い）ときは、その旨を 1 件だけ返す。
 */
export function missingTargets(entry, exists = existsSync, findCommand = (name) => findOnPath(name)) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return ["（設定がオブジェクトではありません）"];
  const hasUrl = typeof entry.url === "string" && entry.url.trim() !== "";
  const command = typeof entry.command === "string" ? entry.command.trim() : "";
  if (!hasUrl && command === "") return ["（command も url もありません）"];
  if (command === "") return [];
  const missing = [];
  if (path.isAbsolute(command)) {
    const withExt = process.platform === "win32" && path.extname(command) === "" ? [".exe", ".cmd", ".bat", ".com"].map((ext) => `${command}${ext}`) : [];
    if (![command, ...withExt].some((p) => exists(p))) missing.push(command);
  } else if (!/[\\/]/.test(command) && findCommand(command) === null) {
    missing.push(`${command}（PATH に見つかりません）`);
  }
  for (const arg of Array.isArray(entry.args) ? entry.args : []) {
    if (typeof arg !== "string" || arg.startsWith("-")) continue;
    if (!path.isAbsolute(arg) || path.extname(arg) === "") continue;
    if (!exists(arg)) missing.push(arg);
  }
  return missing;
}

/**
 * 置き換える前の mcpServers.mxstudio が何者か。
 * - "none": 無かった
 * - "ours": この導入が前に書いたもの（入口が同じ・この導入の形・前回の記録と同じ）
 * - "broken": 指しているファイルが無い（壊れた登録）
 * - "user": 利用者の設定（例: 別の方法で登録したもの）。取り消しのときに戻す先として覚えるのはこれだけ
 */
export function classifyPrevious(entry, { bridgeEntry = null, lastWritten = [], exists, findCommand } = {}) {
  if (entry === null || entry === undefined) return { kind: "none", missing: [] };
  if (isOurEntry(entry, bridgeEntry) || isSetupShapedEntry(entry) || lastWritten.some((w) => isSameEntry(entry, w))) return { kind: "ours", missing: [] };
  const missing = missingTargets(entry, exists, findCommand);
  if (missing.length > 0) return { kind: "broken", missing };
  return { kind: "user", missing: [] };
}

const REDACTED = "<伏せ>";
/** 値を伏せる引数名（--token xxx / --api-key=xxx など） */
const SECRET_NAME = "(?:token|key|api[-_]?key|apikey|secret|password|passwd|pat|auth|authorization|bearer|access[-_]?token|client[-_]?secret)";
const SECRET_FLAG = new RegExp(`^--?${SECRET_NAME}$`, "i");
const SECRET_ASSIGN = new RegExp(`^(?:--?)?${SECRET_NAME}=`, "i");

/** 秘密リンクのトークンらしい部分か（長い英数字の並び） */
function looksLikeToken(segment) {
  if (segment.length >= 24) return true;
  return segment.length >= 16 && /\d/.test(segment) && /[A-Za-z]/.test(segment);
}

/**
 * URL の秘密になりうる部分を伏せる。秘密リンク（/w/<トークン>）や ?key= を画面と記録に出さないため、
 * 利用者情報・クエリ・フラグメントは必ず伏せ、パスは長い英数字の部分だけを伏せる。
 */
export function redactUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return REDACTED;
  }
  const pathname = url.pathname
    .split("/")
    .map((segment) => (looksLikeToken(segment) ? REDACTED : segment))
    .join("/");
  const tail = url.search || url.hash ? `?${REDACTED}` : "";
  const user = url.username || url.password ? `${REDACTED}@` : "";
  return `${url.protocol}//${user}${url.host}${pathname}${tail}`;
}

/** 起動引数のうち秘密になりうるものを伏せる（パスとフラグはそのまま出す） */
export function redactArgs(args) {
  const out = [];
  let hideNext = false;
  for (const raw of args) {
    const arg = String(raw);
    if (hideNext) {
      out.push(REDACTED);
      hideNext = false;
    } else if (SECRET_FLAG.test(arg)) {
      out.push(arg);
      hideNext = true;
    } else if (SECRET_ASSIGN.test(arg)) {
      out.push(`${arg.slice(0, arg.indexOf("=") + 1)}${REDACTED}`);
    } else if (/^https?:\/\//i.test(arg)) {
      out.push(redactUrl(arg));
    } else if (/^bearer\s/i.test(arg)) {
      out.push(`Bearer ${REDACTED}`);
    } else if (!arg.startsWith("-") && !/[\\/\s]/.test(arg) && arg.length >= 20) {
      // パスでもフラグでもない長い値はトークンかもしれない
      out.push(REDACTED);
    } else {
      out.push(arg);
    }
  }
  return out;
}

/** 秘密（Bearer トークン・秘密リンクなど）を伏せた要約。画面と記録にはこちらだけを出す */
export function redactEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const out = {};
  if (typeof entry.type === "string") out.type = entry.type;
  if (typeof entry.url === "string") out.url = redactUrl(entry.url);
  if (typeof entry.command === "string") out.command = entry.command;
  if (Array.isArray(entry.args)) out.args = redactArgs(entry.args);
  if (entry.headers && typeof entry.headers === "object") out.headers = Object.fromEntries(Object.keys(entry.headers).map((k) => [k, "<伏せ>"]));
  if (entry.env && typeof entry.env === "object") out.env = Object.fromEntries(Object.keys(entry.env).map((k) => [k, "<伏せ>"]));
  return out;
}

/** mcpServers に 1 ブロックだけ足す/差し替える。ほかの設定には触らない */
export function mergeMcpServer(json, name, entry) {
  const base = json && typeof json === "object" ? json : {};
  const servers = base.mcpServers && typeof base.mcpServers === "object" && !Array.isArray(base.mcpServers) ? base.mcpServers : {};
  const previous = Object.prototype.hasOwnProperty.call(servers, name) ? servers[name] : null;
  const changed = !isSameEntry(previous, entry);
  const next = { ...base, mcpServers: { ...servers, [name]: entry } };
  return { next, previous, changed };
}

/** mcpServers から 1 ブロックだけ外す（restore があればそれに戻す） */
export function removeMcpServer(json, name, restore) {
  const base = json && typeof json === "object" ? json : {};
  const servers = base.mcpServers && typeof base.mcpServers === "object" && !Array.isArray(base.mcpServers) ? base.mcpServers : {};
  if (!Object.prototype.hasOwnProperty.call(servers, name)) return { next: base, changed: false, previous: null };
  const previous = servers[name];
  const nextServers = { ...servers };
  if (restore) nextServers[name] = restore;
  else delete nextServers[name];
  return { next: { ...base, mcpServers: nextServers }, changed: true, previous };
}

/** バックアップから、その名前の設定だけを読み直す（秘密を自分の記録に写さないため） */
export function entryFromBackup(backupPath, name) {
  if (!backupPath || !isFile(backupPath)) return null;
  const read = readJsonFile(backupPath);
  if (read.error || !read.json) return null;
  const servers = read.json.mcpServers;
  if (!servers || typeof servers !== "object") return null;
  const entry = servers[name];
  return entry && typeof entry === "object" ? entry : null;
}

// ---------------------------------------------------------------------------
// 場所を決める
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const IS_WINDOWS = process.platform === "win32";

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

function appData() {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

/**
 * デスクトップとスタートアップの場所。OneDrive に移されていることがあるので、
 * 決め打ちせず Windows に聞く（聞けなければ既定の場所を使う）。
 */
function shellFolders() {
  const fallback = {
    desktop: path.join(os.homedir(), "Desktop"),
    startup: path.join(appData(), "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
  };
  if (!IS_WINDOWS) return fallback;
  const ran = runPowerShell(
    "$out = @{ desktop = [Environment]::GetFolderPath('Desktop'); startup = [Environment]::GetFolderPath('Startup') }; $out | ConvertTo-Json -Compress",
  );
  if (!ran.ok) return fallback;
  try {
    const parsed = JSON.parse(ran.stdout.trim());
    return {
      desktop: typeof parsed.desktop === "string" && parsed.desktop ? parsed.desktop : fallback.desktop,
      startup: typeof parsed.startup === "string" && parsed.startup ? parsed.startup : fallback.startup,
    };
  } catch {
    return fallback;
  }
}

/** 橋渡しの入口を探す。見つからなければ null（候補も返して、画面に出せるようにする） */
export function resolveBridgeEntry(repoRoot, explicit, exists = isFile) {
  if (explicit) {
    const resolved = path.resolve(repoRoot, explicit);
    return exists(resolved) ? { entry: resolved, explicit: true } : { entry: null, explicit: true, missing: resolved };
  }
  for (const candidate of BRIDGE_CANDIDATES) {
    const resolved = path.join(repoRoot, ...candidate.split("/"));
    if (exists(resolved)) return { entry: resolved, explicit: false };
  }
  return { entry: null, explicit: false };
}

/**
 * 記録（setup.json）・控え・橋渡しの鍵ファイルの置き場所。どの OS でも ~/.config/mxstudio（src/bridge/bridgeKey.ts と同じ）。
 * %LOCALAPPDATA% に置くと、Claude（MSIX パッケージ）の中から実行したときに書き込みがパッケージ専用の場所へ振り替えられ、
 * ダブルクリックやログイン時の自動起動（パッケージの外）からは見えなくなる。
 */
function mxstudioHome(home = os.homedir()) {
  return path.join(home, ".config", "mxstudio");
}

function makePaths(opts) {
  const folders = opts.startupDir && opts.desktopDir ? { startup: opts.startupDir, desktop: opts.desktopDir } : shellFolders();
  const stateDir = opts.stateDir ? path.resolve(opts.stateDir) : mxstudioHome();
  // Claude Code と同じ決め方（CLAUDE_CONFIG_DIR があればその下、無ければホーム）
  const codeConfigDefault = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json");
  return {
    repoRoot: REPO_ROOT,
    stateDir,
    statePath: path.join(stateDir, "setup.json"),
    backupDir: path.join(stateDir, "backup"),
    claudeCodeConfig: opts.claudeCodeConfig ? path.resolve(opts.claudeCodeConfig) : codeConfigDefault,
    claudeCodeConfigDefault: codeConfigDefault,
    claudeDesktopConfig: opts.claudeDesktopConfig ? path.resolve(opts.claudeDesktopConfig) : path.join(appData(), "Claude", "claude_desktop_config.json"),
    startupDir: opts.startupDir ? path.resolve(opts.startupDir) : folders.startup,
    desktopDir: opts.desktopDir ? path.resolve(opts.desktopDir) : folders.desktop,
    // Claude Code の個人の Skill（Claude Code と同じ決め方: CLAUDE_CONFIG_DIR があればその下、無ければ ~/.claude）
    claudeSkillsDir: opts.claudeSkillsDir ? path.resolve(opts.claudeSkillsDir) : path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "skills"),
    // Antigravity（2.0・IDE・agy CLI が共有する設定。MCP は config/mcp_config.json、どの面からも読める Skill は skills/）
    ...antigravityPaths(opts.antigravityDir ? path.resolve(opts.antigravityDir) : path.join(os.homedir(), ".gemini")),
  };
}

/** Antigravity の設定フォルダ（~/.gemini）から、MCP の設定と Skill の置き場所を決める */
export function antigravityPaths(dir) {
  return {
    antigravityDir: dir,
    antigravityConfig: path.join(dir, "config", "mcp_config.json"),
    antigravitySkillsDir: path.join(dir, "skills"),
  };
}

/**
 * Antigravity に登録するか。--no-antigravity か、設定フォルダ（~/.gemini）が無い（Antigravity を入れていない）なら登録しない。
 * 入れていない PC に ~/.gemini を作らないため。
 */
export function antigravityWanted(opts, paths, dirExists = isDir) {
  if (!opts.antigravity) return { ok: false, reason: "--no-antigravity なので" };
  if (!dirExists(paths.antigravityDir)) return { ok: false, reason: `Antigravity の設定フォルダ（${paths.antigravityDir}）が無いので` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 記録（setup.json）
// ---------------------------------------------------------------------------

function readState(statePath) {
  const read = readJsonFile(statePath);
  if (read.error || !read.exists) return null;
  return read.json;
}

function writeState(statePath, state) {
  writeJsonFileAtomic(statePath, { ...state, updatedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// 外のプログラムを呼ぶ
// ---------------------------------------------------------------------------

/**
 * PowerShell を標準入力から実行する（引数の引用符で悩まないため。値は環境変数で渡す）。
 * 標準入力から読むときは 1 行ずつ実行されるので、if { } else { } などは 1 行に書くこと。
 * 出力は UTF-8 にそろえる。既定（cp932）のままだと、日本語のパス（OneDrive の「デスクトップ」や
 * 日本語のユーザー名）が化けて、フォルダが見つからなくなる（実測で確認）。
 */
export function runPowerShell(script, env) {
  if (!IS_WINDOWS) return { ok: false, stdout: "", stderr: "Windows ではありません。" };
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
    input: `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${script}`,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  const stdout = run.stdout ?? "";
  const stderr = run.stderr ?? "";
  return { ok: run.status === 0 && !run.error, stdout, stderr: run.error ? String(run.error.message ?? run.error) : stderr };
}

/**
 * npm を呼ぶ。シェルを経由せずに node から npm-cli.js を直接動かす。
 * npm の標準出力はこちらの標準エラーへ回す（--json の結果に npm の出力が混ざって読めなくならないように。画面にはどちらも出る）。
 */
function runNpm(args, cwd) {
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const stdio = ["inherit", 2, "inherit"];
  if (isFile(cli)) {
    const run = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", stdio, timeout: 600_000, windowsHide: true });
    return { ok: run.status === 0 && !run.error, error: run.error ? String(run.error.message ?? run.error) : "" };
  }
  const run = spawnSync(IS_WINDOWS ? "npm.cmd" : "npm", args, { cwd, encoding: "utf8", stdio, shell: IS_WINDOWS, timeout: 600_000, windowsHide: true });
  return { ok: run.status === 0 && !run.error, error: run.error ? String(run.error.message ?? run.error) : "" };
}

/** claude コマンド（Claude Code）があるか */
function findClaudeCli() {
  const run = spawnSync(IS_WINDOWS ? "where" : "which", ["claude"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  if (run.status !== 0 || !run.stdout) return null;
  const first = run.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  return first ?? null;
}

/**
 * claude コマンドで書いてよい相手か。claude コマンドは自分の設定（<CLAUDE_CONFIG_DIR ?? ~>/.claude.json）しか
 * 書かないので、書き先がちょうどその既定のファイルのときだけ使う。
 * --claude-code-config で別のファイルを指定されたときは claude コマンドを使わず自分で書く。
 * （CLAUDE_CONFIG_DIR を差し替えて合わせる方法は取らない。差し替えると claude はそのフォルダを
 * 設定フォルダとして扱い、backups\ などを作る。既定の場所でそれをするとホームフォルダを散らかす。）
 */
export function canUseClaudeCli(configPath, defaultConfigPath) {
  if (!configPath || !defaultConfigPath) return false;
  if (path.basename(configPath).toLowerCase() !== ".claude.json") return false;
  const a = path.resolve(configPath);
  const b = path.resolve(defaultConfigPath);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** child が dir の中（dir そのものは含まない）にあるか */
export function isInside(dir, child) {
  if (!dir || !child) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 試験中の印が立っているか */
export function isTestGuard(env = process.env) {
  return env[TEST_GUARD_ENV] === "1";
}

/**
 * どの claude コマンドを使うか決める。戻り値の exe が null なら claude コマンドを使わず自分で書く。
 * - 試験中（MXSTUDIO_SETUP_TEST=1）: 本物を**探さない**。一時フォルダに置いた偽物が指定されたときだけ使う
 *   （偽物は、差し替えた書き先に書くように試験が作る）。
 * - ふだん: 書き先が既定の ~/.claude.json のときだけ使う（claude コマンドは既定のファイルしか書かないため）。
 *   --claude-cli / MXSTUDIO_CLAUDE_CLI で場所を指定でき、無ければ PATH から探す。
 * locate は PATH から探す関数（試験で「呼ばれないこと」を確かめるために差し替える）。
 */
export function chooseClaudeCli({ explicit = null, configPath, defaultConfigPath, guard = false, locate = findClaudeCli, tmpDir = os.tmpdir() }) {
  if (guard) {
    if (explicit && isInside(tmpDir, explicit)) return { exe: path.resolve(explicit), source: "explicit" };
    return { exe: null, source: "guard" };
  }
  if (!canUseClaudeCli(configPath, defaultConfigPath)) return { exe: null, source: "redirected" };
  if (explicit) return { exe: path.resolve(explicit), source: "explicit" };
  const found = locate();
  return { exe: found, source: found ? "path" : "missing" };
}

/** child が dir そのものか、その中にあるか（Windows は大文字小文字を区別しない） */
function isSameOrInside(dir, child) {
  const a = path.resolve(dir);
  const b = path.resolve(child);
  const same = process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  return same || isInside(a, b);
}

/**
 * 利用者の本物の書き先（この導入が既定で書く場所）。試験の囲いで「一時フォルダの中でも、ここは拒む」ために使う
 * （TEMP がホームフォルダなどに向いていると、「一時フォルダの中」の検査だけでは本物に届いてしまう）。
 * CLAUDE_CONFIG_DIR は、それ自体が一時フォルダの中なら試験が差し替えたものなので含めない。
 */
export function realWriteLocations(env = process.env, home = os.homedir(), tmpDir = os.tmpdir()) {
  const appDataDir = env.APPDATA || path.join(home, "AppData", "Roaming");
  const localDir = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const list = [
    path.join(home, ".claude.json"),
    path.join(home, ".claude"),
    path.join(appDataDir, "Claude"),
    path.join(appDataDir, "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
    path.join(home, "Desktop"),
    path.join(home, "OneDrive", "Desktop"),
    path.join(home, ".gemini"),
    mxstudioHome(home),
    // 以前の版の置き場所（残っている PC があるので、試験ではここも拒む）
    path.join(localDir, "mxstudio"),
  ];
  const configDir = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  if (configDir !== "" && !isInside(tmpDir, configDir)) list.push(path.join(configDir, ".claude.json"));
  return list;
}

/**
 * 試験中（MXSTUDIO_SETUP_TEST=1）に、本物の設定・フォルダ・橋渡し・リポジトリに触れうる指定なら、その理由を返す（問題なければ null）。
 * - 書き先（Skill と Antigravity は入れるときだけ）と --claude-cli は一時フォルダの中。一時フォルダの中でも、本物の書き先（realWriteLocations）とその中は拒む。
 * - --port と --bridge は必ず指定し、--port は既定の番号にしない（利用者が動かしている橋渡しを止めないため）。
 * - --no-open・--no-install・--no-build も必須（npm install / npm run build は本物のリポジトリの node_modules と dist を
 *   書き換え、ほかの人が同時に動かしているビルドや試験を壊しうるため）。
 */
export function testSandboxProblem(opts, tmpDir = os.tmpdir(), realLocations = realWriteLocations(process.env, os.homedir(), tmpDir)) {
  const problems = [];
  for (const [key, flag] of [
    ["stateDir", "--state-dir"],
    ["claudeCodeConfig", "--claude-code-config"],
    ["claudeDesktopConfig", "--claude-desktop-config"],
    ["startupDir", "--startup-dir"],
    ["desktopDir", "--desktop-dir"],
    ...(opts.skills ? [["claudeSkillsDir", "--claude-skills-dir"]] : []),
    ...(opts.antigravity ? [["antigravityDir", "--antigravity-dir"]] : []),
  ]) {
    const unless = { claudeSkillsDir: "（Skill を入れないなら --no-skills）", antigravityDir: "（Antigravity に登録しないなら --no-antigravity）" }[key] ?? "";
    if (!opts[key]) problems.push(`${flag} がありません${unless}`);
    else if (!isInside(tmpDir, opts[key])) problems.push(`${flag} が一時フォルダ（${tmpDir}）の外です: ${opts[key]}`);
    else if (realLocations.some((real) => isSameOrInside(real, opts[key]))) problems.push(`${flag} が本物の書き先です: ${opts[key]}`);
  }
  if (opts.claudeCli && !isInside(tmpDir, opts.claudeCli)) problems.push(`--claude-cli が一時フォルダの外です: ${opts.claudeCli}`);
  if (opts.port === null) problems.push("--port がありません");
  else if (opts.port === DEFAULT_PORT) problems.push(`--port に既定の ${DEFAULT_PORT} は使えません`);
  if (!opts.bridge) problems.push("--bridge がありません");
  if (opts.open) problems.push("--no-open がありません");
  if (opts.install) problems.push("--no-install がありません");
  if (opts.build) problems.push("--no-build がありません");
  return problems.length > 0 ? problems.join(" / ") : null;
}

/** cmd.exe に渡すときの引用（空白を含むパスがそのままだと切れてしまう） */
export function quoteForCmd(value) {
  return /[\s&|<>^"()]/.test(value) ? `"${value}"` : value;
}

/**
 * 外部コマンドを呼ぶ。.cmd / .bat はシェル経由でないと起動できない（Node の仕様）ので、
 * そのときだけ 1 本の文字列に組み立てる（引数は自分で引用する）。
 */
function runCli(exe, args, env) {
  const options = { encoding: "utf8", timeout: 60_000, windowsHide: true, env: { ...process.env, ...env } };
  const needsShell = IS_WINDOWS && /\.(cmd|bat)$/i.test(exe);
  if (!needsShell) return spawnSync(exe, args, options);
  const line = [exe, ...args].map(quoteForCmd).join(" ");
  return spawnSync(line, { ...options, shell: true });
}

// ---------------------------------------------------------------------------
// ポートと橋渡し
// ---------------------------------------------------------------------------

/** そのポートで待ち受けられるか（＝誰も使っていないか） */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/** /_mxstudio/health の応答が mxstudio の橋渡しのものか */
export function isBridgeHealth(body) {
  return Boolean(body) && typeof body === "object" && !Array.isArray(body) && body.name === BRIDGE_NAME;
}

/** 応答の本文を読み捨てる（読まずに放っておくと接続が残る） */
async function discardBody(res) {
  try {
    await res.arrayBuffer();
  } catch {
    // 読めなくても判定には関係ない
  }
}

/**
 * そのポートで何が動いているかを調べる。
 * state: "bridge" = mxstudio の橋渡し、"other" = 別のもの、"down" = 何も居ない（応答しない）。
 * health: /_mxstudio/health の本文（今の橋渡し）。legacy: true なら /_mxstudio/health に応えない古い版の橋渡し。
 */
export async function probeBridge(port, timeoutMs = PROBE_TIMEOUT_MS) {
  const base = `http://127.0.0.1:${port}`;
  // 1) /_mxstudio/health（橋渡しの取り決め）
  try {
    const res = await fetch(`${base}${HEALTH_PATH}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (isBridgeHealth(body)) return { state: "bridge", health: body, legacy: false };
    } else {
      await discardBody(res);
    }
  } catch {
    return { state: "down", health: null, legacy: false };
  }
  // 2) 古い版: /ws は 426 と upgrade_required を返す（橋渡しだけの応答）
  try {
    const res = await fetch(`${base}/ws`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => null);
    if (res.status === 426 && body && typeof body === "object" && body.error === "upgrade_required") return { state: "bridge", health: null, legacy: true };
  } catch {
    return { state: "down", health: null, legacy: false };
  }
  return { state: "other", health: null, legacy: false };
}

/**
 * 隣のポート（port+1 から）で動いている橋渡しを探す。今の橋渡しはポートをずらさないので、
 * 見つかるのは古い版（更新前から動き続けているもの）か、手で別のポートに起動したものだけ。
 */
export async function findOtherBridges(port, count = LEGACY_SCAN_COUNT, probe = probeBridge) {
  const found = [];
  for (let p = port + 1; p < port + count && p <= 65_535; p++) {
    if ((await probe(p)).state === "bridge") found.push(p);
  }
  return found;
}

/**
 * 使うポートの様子を調べる。ポートはずらさない（橋渡しを 1 つにするため）。
 * - reused: 既に橋渡しが動いている（それを使う）
 * - busy: 橋渡しではないものが使っている（何も書き換えずに止める）
 */
export async function decidePort(port, probe = probeBridge, portFree = isPortFree) {
  const found = await probe(port);
  if (found.state === "bridge") return { port, reused: true, busy: false, health: found.health, legacy: found.legacy };
  // 127.0.0.1 に HTTP で応えるものが居る。Windows では 0.0.0.0 で待ち受けているプログラムがあっても
  // 127.0.0.1 だけの待ち受けは通ってしまうので、「空いている」の判定より先に断る
  if (found.state === "other") return { port, reused: false, busy: true, health: null, legacy: false };
  if (await portFree(port)) return { port, reused: false, busy: false, health: null, legacy: false };
  return { port, reused: false, busy: true, health: null, legacy: false };
}

/**
 * このリポジトリの橋渡しが話す内部経路の取り決めの版（src/bridge/peer.ts の BRIDGE_PEER_PROTOCOL）。
 * 入口と同じフォルダの peer.ts から読む。読めない・見つからないときは null（比べない）。
 */
export function expectedPeerProtocol(bridgeEntry, read = (p) => readFileSync(p, "utf8")) {
  if (!bridgeEntry) return null;
  try {
    const m = /export const BRIDGE_PEER_PROTOCOL = (\d{1,6});/.exec(read(path.join(path.dirname(bridgeEntry), "peer.ts")));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * 「橋渡しが 1 つ動いている」ことを /_mxstudio/health で確かめた結果を、画面の 1 行にする。
 * expectRunning が false（--no-start など）なら、動いていないことは警告にしない。
 * expectedProtocol（このリポジトリの橋渡しの取り決めの版）が分かっていて、動いている橋渡しの protocol と違うときは警告する。
 * 違うと、Claude Code / Claude Desktop が起動する（このリポジトリの）橋渡しは、動いている橋渡しに中継せずに終了する（src/bridge/coordinator.ts）。
 */
export function singleBridgeStep(port, probe, expectRunning = true, expectedProtocol = null) {
  if (probe.state === "bridge" && probe.health) {
    const version = typeof probe.health.version === "string" && /^[\w.+-]{1,32}$/.test(probe.health.version) ? `・版 ${probe.health.version}` : "";
    const pid = Number.isInteger(probe.health.pid) ? `・プロセス ${probe.health.pid}` : "";
    const running = probe.health.protocol;
    if (Number.isInteger(expectedProtocol) && Number.isInteger(running) && running !== expectedProtocol) {
      return step(
        "warn",
        "bridge_single",
        `ポート ${port} で動いている橋渡しは、このリポジトリの橋渡しと取り決めの版が違います（動いている橋渡し: ${running}${version}、このリポジトリ: ${expectedProtocol}）。`,
        "このままでは、Claude Code / Claude Desktop が起動する橋渡しがこの橋渡しに中継できず、ツールが使えません。Claude Code / Claude Desktop を終了し、動いている橋渡しを止めてから（docs/local.md の 4 章「今すぐ橋渡しを止める」）、もう一度実行してください。",
      );
    }
    return step(
      "ok",
      "bridge_single",
      `ポート ${port} で橋渡しが 1 つ動いています（${HEALTH_PATH} が ${BRIDGE_NAME} と応えました${version}${pid}）。`,
      "Claude Code / Claude Desktop が起動する橋渡しは、別のポートには立たず、この橋渡しに中継します（作業画面もツールも同じ橋渡しを通ります）。",
    );
  }
  if (probe.state === "bridge") {
    return step(
      "warn",
      "bridge_single",
      `ポート ${port} で動いている橋渡しは古い版です（${HEALTH_PATH} に応えません）。`,
      "古い版は、Claude が起動する橋渡しを隣のポートに別に立てるので、作業画面とツールが別々の橋渡しにつながります。いったん止めてから（docs/local.md の 4 章「今すぐ橋渡しを止める」）、もう一度実行してください。",
    );
  }
  if (probe.state === "other") {
    return step("warn", "bridge_single", `ポート ${port} には mxstudio の橋渡しではないものが応えています。`, "そのプログラムを止めてから、もう一度実行してください。");
  }
  return step(
    expectRunning ? "warn" : "skip",
    "bridge_single",
    `ポート ${port} で橋渡しは動いていません。`,
    "最初に起動した橋渡し（ログイン時の自動起動、または Claude Code / Claude Desktop が起動したもの）がこのポートを持ち、あとから起動したものはそこへ中継します。今すぐ作業画面を使うなら、この導入をもう一度実行してください。",
  );
}

/** 橋渡し同士の認証の鍵ファイルの場所を差し替える環境変数（src/bridge/bridgeKey.ts） */
const BRIDGE_KEY_FILE_ENV = "MXSTUDIO_BRIDGE_KEY_FILE";

/**
 * 試験中に起動する橋渡しへ足す環境変数。本物の橋渡しは、primary になると鍵ファイル
 * （既定は ~/.config/mxstudio/bridge.key）を作るので、試験中は記録の置き場所（一時フォルダ）の中に向ける。
 * ふだん（試験中でない）と、呼び出し側が既に差し替えているときは何も足さない。
 */
export function bridgeTestEnv(paths, env = process.env) {
  if (!isTestGuard(env) || (typeof env[BRIDGE_KEY_FILE_ENV] === "string" && env[BRIDGE_KEY_FILE_ENV].trim() !== "")) return {};
  return { [BRIDGE_KEY_FILE_ENV]: path.join(paths.stateDir, "bridge.key") };
}

/**
 * ふだん（試験中でない）の導入を、MXSTUDIO_BRIDGE_KEY_FILE を設定したまま実行したときの警告（無ければ null）。
 * この導入が起動する橋渡しはその鍵ファイルを使うが、Claude Code / Claude Desktop の登録（env は空）と
 * ログイン時の自動起動はその値を受け取らないので、橋渡し同士の鍵が食い違って中継が認証に失敗する。
 * 値（パス）は画面に出さない。
 */
export function keyFileEnvStep(env = process.env) {
  if (isTestGuard(env)) return null;
  const value = env[BRIDGE_KEY_FILE_ENV];
  if (typeof value !== "string" || value.trim() === "") return null;
  return step(
    "warn",
    "bridge_key_env",
    `環境変数 ${BRIDGE_KEY_FILE_ENV} が設定されています。この導入が起動する橋渡しは、既定の場所ではなくその鍵ファイルを使います。`,
    "Claude Code / Claude Desktop とログイン時の自動起動の橋渡しはこの値を受け取らないので、橋渡し同士の鍵が食い違い、ツール呼び出しの中継が認証に失敗します。試験のために設定したものなら、設定していないコマンドプロンプト（またはダブルクリック）で実行し直してください。",
  );
}

/** 隣のポートに橋渡しが残っているときの 1 行 */
export function otherBridgesStep(ports) {
  return step(
    "warn",
    "bridge_others",
    `隣のポートでも橋渡しが動いています（ポート ${ports.join(" / ")}）。止めていません。`,
    "今の橋渡しはポートをずらさないので、これは更新前の古い版か、手で別のポートに起動したものです。Claude Code / Claude Desktop が起動したものなら Claude を終了すると止まります。手で起動したものは、そのウィンドウを閉じてください。",
  );
}

/** 橋渡しを起動して、応えるようになるまで待つ（ポートはずらさない）。extraEnv は橋渡しに足す環境変数 */
async function startBridge(nodePath, bridgeEntry, port, repoRoot, extraEnv = {}) {
  const args = bridgeArgs(bridgeEntry, port, BRIDGE_SERVE_ARGS);
  const env = { ...process.env, ...extraEnv };
  let child;
  try {
    child = spawn(nodePath, args, { cwd: repoRoot, env, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } catch (err) {
    return { ok: false, pid: null, detail: err instanceof Error ? err.message : String(err) };
  }
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const probe = await probeBridge(port);
    if (probe.state === "bridge") return { ok: true, pid: child.pid ?? null, health: probe.health, legacy: probe.legacy };
    // 子が先に終わった（ポートを取れなかった・入口が壊れている等）。待ち続けない
    if (exited) break;
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
  // 立ち上がらなかったときだけ、もう一度前に出して理由を捕まえる（起動したほうは投げっぱなしにしない）
  const retry = spawnSync(nodePath, args, { cwd: repoRoot, env, encoding: "utf8", timeout: 5_000, windowsHide: true });
  const detail = [retry.stderr ?? "", retry.stdout ?? ""].join("\n").split(/\r?\n/).filter((line) => line.trim()).slice(-8).join("\n");
  return { ok: false, pid: child.pid ?? null, exited, detail };
}

/**
 * コマンドラインが、この入口で起動した橋渡しのものか。
 * 入口の**絶対パス**を含むときだけ認める（「cli.ts」のようなファイル名だけで比べると、
 * 別のツールの node プロセスを取り違えて止めてしまう）。
 */
export function isBridgeCommandLine(commandLine, bridgeEntry) {
  if (typeof commandLine !== "string" || commandLine === "" || !bridgeEntry) return false;
  const norm = (s) => s.replace(/\//g, "\\").toLowerCase();
  return norm(commandLine).includes(norm(path.resolve(bridgeEntry)));
}

/**
 * コマンドラインが、この導入（とログイン時の自動起動）が起動した**画面用の**橋渡し（--no-mcp 付き）のものか。
 * --no-mcp が無いものは、Claude Code / Claude Desktop が MCP サーバとして起動した橋渡し。
 * 橋渡しが 1 つになってからは、それがポートを持つ（primary になる）ことがあるが、取り消しでは止めない
 * （Claude の中で使っている最中のツールを、Claude に知らせずに切ってしまうため）。
 */
export function isServeBridgeCommandLine(commandLine, bridgeEntry) {
  return isBridgeCommandLine(commandLine, bridgeEntry) && /(?:^|\s)"?--no-mcp"?(?=\s|$)/i.test(commandLine);
}

/**
 * プロセスのコマンドラインを Windows に聞く。port を渡したときは 127.0.0.1 のそのポートで
 * 待ち受けているプロセスを、pid を渡したときはその番号のプロセスを調べる。
 * 戻り値: { ok: true, pid, commandLine }（見つからなければ pid は 0）/ { ok: false, reason }
 */
function inspectProcess({ pid, port }) {
  if (!IS_WINDOWS) return { ok: false, reason: "Windows ではないので、プロセスを確かめられません。" };
  const script =
    "$id = 0; if ($env:MXS_PORT) { $c = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ([int]$env:MXS_PORT) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -ne $c) { $id = [int]$c.OwningProcess } } else { $id = [int]$env:MXS_PID }; " +
    "$p = $null; if ($id -gt 0) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id) -ErrorAction SilentlyContinue }; " +
    "if ($null -eq $p) { '{\"pid\":0,\"commandLine\":\"\"}' } else { @{ pid = $id; commandLine = [string]$p.CommandLine } | ConvertTo-Json -Compress }";
  const ran = runPowerShell(script, port ? { MXS_PORT: String(port), MXS_PID: "" } : { MXS_PORT: "", MXS_PID: String(pid) });
  if (!ran.ok) return { ok: false, reason: `プロセスを確かめられません: ${ran.stderr.trim().slice(0, 200)}` };
  try {
    const lines = ran.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const parsed = JSON.parse(lines[lines.length - 1] ?? "");
    return { ok: true, pid: Number.isInteger(parsed.pid) ? parsed.pid : 0, commandLine: typeof parsed.commandLine === "string" ? parsed.commandLine : "" };
  } catch {
    return { ok: false, reason: "プロセスの情報を読み取れませんでした。" };
  }
}

/** 橋渡しが（また）応えるようになるまで待つ。応えたら true */
async function waitUntilBridge(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeBridge(port)).state === "bridge") return true;
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
  return false;
}

/** 止まるまで少し待つ（止めたと言ったのに動いている、を避ける） */
async function waitUntilDown(port, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeBridge(port)).state !== "bridge") return true;
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
  return false;
}

/**
 * pid が本当にこの入口の橋渡しか確かめてから止める（番号の使い回しで無関係なプロセスを殺さない）。
 * Windows 以外ではコマンドラインを確かめられないので、確かめずには止めない。
 */
function stopBridgeByPid(pid, bridgeEntry) {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: "プロセス番号が分かりません。" };
  const info = inspectProcess({ pid });
  if (!info.ok) return { ok: false, reason: info.reason };
  if (info.pid === 0) return { ok: true, stopped: false, reason: `プロセス ${pid} はもう動いていません。` };
  if (!isBridgeCommandLine(info.commandLine, bridgeEntry)) {
    return { ok: false, reason: `プロセス ${pid} は ${bridgeEntry ?? "mxstudio"} の橋渡しではないようです。止めませんでした。` };
  }
  if (!isServeBridgeCommandLine(info.commandLine, bridgeEntry)) {
    return { ok: true, stopped: false, mcp: true, reason: `プロセス ${pid} は Claude Code / Claude Desktop が起動した橋渡しなので、止めませんでした。` };
  }
  try {
    process.kill(pid);
    return { ok: true, stopped: true, reason: `プロセス ${pid} を止めました。` };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : "";
    if (code === "ESRCH") return { ok: true, stopped: false, reason: `プロセス ${pid} はもう動いていません。` };
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// ショートカット
// ---------------------------------------------------------------------------

/** ブラウザをアプリ窓で開くための実行ファイルを探す（Chrome → Edge の順） */
export function findBrowser(exists = isFile) {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = localAppData();
  const candidates = [
    { kind: "chrome", exe: path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe") },
    { kind: "chrome", exe: path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe") },
    { kind: "chrome", exe: path.join(local, "Google", "Chrome", "Application", "chrome.exe") },
    { kind: "edge", exe: path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe") },
    { kind: "edge", exe: path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe") },
  ];
  for (const candidate of candidates) if (exists(candidate.exe)) return candidate;
  return null;
}

/** 既定のブラウザで開くためのショートカット（.url は中身がただのテキスト） */
export function buildInternetShortcut(url) {
  return `[InternetShortcut]\r\nURL=${url}\r\n`;
}

/** .lnk を作る（WScript.Shell。値は環境変数で渡す） */
function createLnk({ lnkPath, target, args, workDir, description, windowStyle }) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject WScript.Shell",
    "$sc = $shell.CreateShortcut($env:MXS_LNK)",
    "$sc.TargetPath = $env:MXS_TARGET",
    "$sc.Arguments = $env:MXS_ARGS",
    "$sc.WorkingDirectory = $env:MXS_WORKDIR",
    "$sc.Description = $env:MXS_DESC",
    "$sc.WindowStyle = [int]$env:MXS_STYLE",
    "$sc.Save()",
    "'saved'",
  ].join("\n");
  const ran = runPowerShell(script, {
    MXS_LNK: lnkPath,
    MXS_TARGET: target,
    MXS_ARGS: args ?? "",
    MXS_WORKDIR: workDir ?? "",
    MXS_DESC: description ?? "",
    MXS_STYLE: String(windowStyle ?? 1),
  });
  if (!ran.ok || !existsSync(lnkPath)) {
    const detail = (ran.stderr || ran.stdout).split(/\r?\n/).filter((l) => l.trim()).slice(0, 3).join(" / ");
    return { ok: false, detail: detail.slice(0, 300) };
  }
  return { ok: true, detail: "" };
}

/** ショートカットの引数（パスに空白があるので "" でくくる） */
export function quoteArgs(args) {
  return args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}

// ---------------------------------------------------------------------------
// 導入
// ---------------------------------------------------------------------------

async function install(opts, paths, out) {
  const dry = opts.dryRun;
  const nodePath = process.execPath;
  const state = readState(paths.statePath) ?? {};
  const result = {
    version: 1,
    repoRoot: paths.repoRoot,
    nodePath,
    bridgeEntry: null,
    port: null,
    appUrl: null,
    installed: { claudeCode: false, claudeDesktop: false, antigravity: false, startup: null, desktopShortcut: null, skills: [], antigravitySkills: [] },
    previous: state.previous ?? {},
    backups: Array.isArray(state.backups) ? state.backups : [],
  };

  // --- Node の版（橋渡しは --experimental-strip-types で .ts をそのまま動かすので 22.6 以上が要る）---
  if (!nodeVersionOk(process.versions.node)) {
    out.push(
      step(
        "error",
        "node",
        `Node ${process.versions.node} では動きません（${MIN_NODE.join(".")} 以上が要ります）。何も書き換えていません。`,
        "https://nodejs.org から LTS（22 以上）を入れてから、もう一度実行してください（Windows なら winget install OpenJS.NodeJS.LTS）。",
      ),
    );
    return result;
  }
  out.push(step("ok", "node", `Node ${process.versions.node} を使います（${nodePath}）。`));

  // --- 橋渡しの入口 ---
  const found = resolveBridgeEntry(paths.repoRoot, opts.bridge);
  if (!found.entry) {
    const where = found.explicit ? `指定された ${found.missing}` : BRIDGE_CANDIDATES.join(" / ");
    out.push(
      step("error", "bridge_entry", `橋渡しの入口が見つかりません（探した場所: ${where}）。`, "橋渡しがまだこのリポジトリにありません。入口ができたら、この導入をもう一度実行してください（--bridge <パス> で場所を指定することもできます）。"),
    );
    return result;
  }
  result.bridgeEntry = found.entry;
  out.push(step("ok", "bridge_entry", `橋渡しの入口: ${found.entry}`));

  // --- 依存とビルド（更新のあとは、古い依存・古い画面のままにしない）---
  const install = needsInstall(paths.repoRoot);
  if (install !== null) {
    if (!opts.install) out.push(step("warn", "npm_install", `${install}が、--no-install なので入れていません。`));
    else if (dry) out.push(step("skip", "npm_install", "npm install を実行します（--dry-run なので実行していません）。"));
    else {
      const ran = runNpm(["install"], paths.repoRoot);
      if (ran.ok) out.push(step("ok", "npm_install", `npm install を実行しました（${install}）。`));
      else out.push(step("error", "npm_install", `npm install に失敗しました。${ran.error}`, `手で ${paths.repoRoot} に移動して npm install を実行してください。`));
    }
  } else {
    out.push(step("ok", "npm_install", "依存（node_modules）は入っています。"));
  }

  const indexHtml = path.join(paths.repoRoot, "dist", "app", "index.html");
  const build = needsBuild(paths.repoRoot);
  if (build !== null) {
    if (!opts.build) out.push(step("warn", "build", `${build}が、--no-build なのでビルドしていません。`));
    else if (dry) out.push(step("skip", "build", "npm run build を実行します（--dry-run なので実行していません）。"));
    else {
      const ran = runNpm(["run", "build"], paths.repoRoot);
      if (ran.ok && isFile(indexHtml)) out.push(step("ok", "build", `画面をビルドしました（${build}。dist/app）。`));
      else out.push(step("error", "build", `ビルドに失敗しました。${ran.error}`, `手で ${paths.repoRoot} に移動して npm run build を実行してください。`));
    }
  } else {
    out.push(step("ok", "build", "画面のビルドは最新です（dist/app/index.html）。"));
  }

  // --- ポート ---
  // 橋渡しは 1 つだけで、ポートはずらさない。前回 --port で番号を指定したときだけ、その番号を引き継ぐ
  // （古い版の導入が自分でずらした番号は引き継がず、既定に戻す）。
  const keepExplicit = opts.port === null && state.portExplicit === true && Number.isInteger(state.port);
  const port = opts.port ?? (keepExplicit ? state.port : DEFAULT_PORT);
  result.port = port;
  result.portExplicit = port !== DEFAULT_PORT;
  result.appUrl = `http://127.0.0.1:${port}/app`;
  const decided = await decidePort(port);
  if (decided.busy) {
    out.push(
      step(
        "error",
        "port",
        `ポート ${port} を、mxstudio の橋渡しではないプログラムが使っています。何も書き換えずに止めます。`,
        "橋渡しは Claude Code / Claude Desktop と同じポートを共有するので、別のポートへはずらしません。そのプログラムを止めてからもう一度実行するか、--port <番号> で空いている番号を指定してください（Claude の設定とショートカットもその番号で作ります）。",
      ),
    );
    return result;
  }
  if (decided.reused) {
    out.push(step("ok", "port", `ポート ${port} で橋渡しが既に動いています。これを使います（起動し直しはしません）。`, "リポジトリを更新したあとは、橋渡しを止めてから導入し直すと新しい橋渡しで動きます（docs/local.md の 3 章）。"));
  } else {
    out.push(step("ok", "port", `ポート ${port} を使います。`));
  }
  // 前回と違うポートにしたのに、前回の橋渡しがまだ動いている（古い版の導入がずらした番号など）
  if (!dry && Number.isInteger(state.port) && state.port !== port && (await probeBridge(state.port)).state === "bridge") {
    out.push(
      step(
        "warn",
        "port_old",
        `前回の導入のポート ${state.port} でも橋渡しが動いています。今回はポート ${port} を使うので、そちらは使われません。`,
        "止めてください（最小化された node のウィンドウを閉じる／タスクマネージャー。docs/local.md の 4 章）。Claude Code / Claude Desktop が起動したものなら、Claude を終了すると止まります。",
      ),
    );
  }

  // --- 橋渡しの起動 ---
  if (decided.reused) {
    // 動いている橋渡しの本当のプロセス番号を Windows に聞く（記録の番号は古いことがある）
    const owner = IS_WINDOWS && !dry ? inspectProcess({ port }) : null;
    if (owner?.ok && owner.pid > 0 && isServeBridgeCommandLine(owner.commandLine, found.entry)) {
      result.bridgePid = owner.pid;
    } else if (owner?.ok && owner.pid > 0 && isBridgeCommandLine(owner.commandLine, found.entry)) {
      // Claude Code / Claude Desktop が起動した橋渡しがポートを持っている。その番号は記録しない（取り消しでも止めない）
      result.bridgePid = null;
      out.push(
        step(
          "ok",
          "bridge_start",
          `ポート ${port} の橋渡しは Claude Code / Claude Desktop が起動したもの（プロセス ${owner.pid}）です。画面用の橋渡しは起動していません。`,
          "Claude を終了するとこの橋渡しも終わり、ほかに橋渡しが動いていなければ作業画面はつながらなくなります。そのときは .\\mxstudio.cmd をもう一度実行するか、スタートアップの mxstudio-bridge.lnk を実行してください。",
        ),
      );
    } else if (owner?.ok && owner.pid > 0) {
      result.bridgePid = null;
      out.push(step("warn", "bridge_start", `ポート ${port} で動いている橋渡しは、この入口（${found.entry}）から起動したものではないようです。`, "別の場所にある mxstudio の橋渡しかもしれません。止めてから導入し直すか、--port で別の番号を指定してください。"));
    } else {
      result.bridgePid = Number.isInteger(decided.health?.pid) ? decided.health.pid : (state.bridgePid ?? null);
    }
  } else if (!opts.start) {
    out.push(step("skip", "bridge_start", "--no-start なので橋渡しを起動していません。"));
  } else if (dry) {
    out.push(step("skip", "bridge_start", `橋渡しを起動します（node ${bridgeArgs(found.entry, port, BRIDGE_SERVE_ARGS).join(" ")}）。--dry-run なので実行していません。`));
  } else {
    const keyEnv = keyFileEnvStep();
    if (keyEnv) out.push(keyEnv);
    const started = await startBridge(nodePath, found.entry, port, paths.repoRoot, bridgeTestEnv(paths));
    if (started.ok) {
      // 起動する直前に別の橋渡しがポートを取ったときは、応えているのはそちら。health の番号を優先する
      result.bridgePid = Number.isInteger(started.health?.pid) ? started.health.pid : started.pid;
      out.push(step("ok", "bridge_start", `橋渡しを起動しました（ポート ${port}${result.bridgePid ? `・プロセス ${result.bridgePid}` : ""}）。`));
    } else {
      // 遅れて立ち上がるかもしれないので、番号は記録しておく（--uninstall で止められるように）
      if (Number.isInteger(started.pid) && !started.exited) result.bridgePid = started.pid;
      const why = started.exited ? "橋渡しが起動してすぐに終了しました。" : `橋渡しが ${Math.round(START_TIMEOUT_MS / 1000)} 秒たっても応答しません。`;
      out.push(
        step(
          "error",
          "bridge_start",
          `${why}${started.detail ? `\n         ${started.detail.replace(/\n/g, "\n         ")}` : ""}`,
          `手で次を実行して、出てくるエラーを見てください: node ${quoteArgs(bridgeArgs(found.entry, port, BRIDGE_SERVE_ARGS))}`,
        ),
      );
    }
  }

  // --- Claude Code ---
  const lastWritten = lastWrittenEntries(state);
  const codeEntry = buildCodeEntry(nodePath, found.entry, port);
  registerCode(opts, paths, codeEntry, found.entry, lastWritten, result, out);

  // --- Claude Desktop ---
  const desktopEntry = buildDesktopEntry(nodePath, found.entry, port);
  registerDesktop(opts, paths, desktopEntry, found.entry, lastWritten, result, out);

  // --- Antigravity（入っているときだけ）---
  const antigravity = antigravityWanted(opts, paths);
  if (antigravity.ok) registerAntigravity(opts, paths, buildAntigravityEntry(nodePath, found.entry, port), found.entry, lastWritten, result, out);
  else out.push(step("skip", "antigravity", `${antigravity.reason}、Antigravity には登録していません。`));

  // --- Skill（アプリ既定と利用者の Skill を Claude Code の ~/.claude/skills と Antigravity の ~/.gemini/skills へ）---
  installSkills(opts, paths, state, result, out);

  // --- ログイン時の自動起動 ---
  const startupPath = path.join(paths.startupDir, STARTUP_SHORTCUT);
  if (!opts.autostart) {
    out.push(step("skip", "autostart", "--no-autostart なので自動起動は作っていません。"));
  } else if (!IS_WINDOWS) {
    out.push(step("skip", "autostart", "Windows ではないので自動起動は作っていません。"));
  } else if (dry) {
    out.push(step("skip", "autostart", `スタートアップに ${startupPath} を作ります（--dry-run なので作っていません）。`));
  } else if (!isDir(paths.startupDir)) {
    out.push(step("error", "autostart", `スタートアップフォルダがありません: ${paths.startupDir}`, "エクスプローラーのアドレス欄に shell:startup と入れて開けるフォルダです。"));
  } else {
    const made = createLnk({
      lnkPath: startupPath,
      target: nodePath,
      args: quoteArgs(bridgeArgs(found.entry, port, BRIDGE_SERVE_ARGS)),
      workDir: paths.repoRoot,
      description: "mxstudio の橋渡し（ローカル）",
      windowStyle: 7, // 最小化して起動する
    });
    if (made.ok) {
      result.installed.startup = startupPath;
      out.push(step("ok", "autostart", `ログイン時に橋渡しを起動します（${startupPath}）。`, "やめたいときは、このファイルを消すだけです。"));
    } else {
      out.push(step("error", "autostart", `自動起動のショートカットを作れませんでした。${made.detail}`, `エクスプローラーで shell:startup を開き、node.exe への"ショートカット"を手で作ってください（リンク先: ${quoteArgs([nodePath, ...bridgeArgs(found.entry, port, BRIDGE_SERVE_ARGS)])}）。`));
    }
  }

  // --- デスクトップのショートカット ---
  if (!opts.shortcut) {
    out.push(step("skip", "shortcut", "--no-shortcut なのでデスクトップのショートカットは作っていません。"));
  } else if (dry) {
    out.push(step("skip", "shortcut", `デスクトップに ${result.appUrl} を開くショートカットを作ります（--dry-run なので作っていません）。`));
  } else if (!isDir(paths.desktopDir)) {
    out.push(step("warn", "shortcut", `デスクトップのフォルダが見つかりません: ${paths.desktopDir}`, `ブラウザで ${result.appUrl} を開いてください。`));
  } else {
    const browser = IS_WINDOWS ? findBrowser() : null;
    const lnkPath = path.join(paths.desktopDir, DESKTOP_SHORTCUT_LNK);
    const urlPath = path.join(paths.desktopDir, DESKTOP_SHORTCUT_URL);
    if (browser) {
      const made = createLnk({
        lnkPath,
        target: browser.exe,
        args: quoteArgs([`--app=${result.appUrl}`]),
        workDir: paths.repoRoot,
        description: "mxstudio の作業画面",
        windowStyle: 1,
      });
      if (made.ok) {
        result.installed.desktopShortcut = lnkPath;
        if (existsSync(urlPath)) rmSync(urlPath, { force: true });
        out.push(step("ok", "shortcut", `デスクトップに作業画面のショートカットを作りました（${path.basename(lnkPath)}・${browser.kind} のアプリ窓）。`));
      } else {
        writeFileSync(urlPath, buildInternetShortcut(result.appUrl), "utf8");
        result.installed.desktopShortcut = urlPath;
        out.push(step("warn", "shortcut", `アプリ窓のショートカットを作れなかったので、既定のブラウザで開くショートカットにしました（${path.basename(urlPath)}）。${made.detail}`));
      }
    } else {
      writeFileSync(urlPath, buildInternetShortcut(result.appUrl), "utf8");
      result.installed.desktopShortcut = urlPath;
      out.push(step("ok", "shortcut", `デスクトップにショートカットを作りました（${path.basename(urlPath)}・既定のブラウザで開きます）。`, "Chrome か Edge があれば、枠の無いアプリ窓で開くようにします。"));
    }
  }

  // --- 橋渡しが 1 つ動いているか（/_mxstudio/health で確かめる）---
  // 橋渡しは 1 つだけで、Claude Code / Claude Desktop が起動する橋渡しはこのポートの橋渡しに中継する。
  // 最後にもう一度ポートに聞いて、いま本当に応えているかを出す（起動したあとに落ちていることもある）。
  if (!dry) {
    const expectRunning = decided.reused || (opts.start && !out.some((s) => s.id === "bridge_start" && s.level === "error"));
    out.push(singleBridgeStep(port, await probeBridge(port), expectRunning, expectedPeerProtocol(found.entry)));
    const others = await findOtherBridges(port);
    if (others.length > 0) out.push(otherBridgesStep(others));
  }

  // --- 記録 ---
  if (!dry) {
    try {
      writeState(paths.statePath, result);
      out.push(step("ok", "state", `この導入の記録: ${paths.statePath}`));
    } catch (err) {
      out.push(step("warn", "state", `記録を書けませんでした: ${err instanceof Error ? err.message : String(err)}`, "取り消し（--uninstall）のときに、置き換える前の設定に戻せません。"));
    }
  }

  // --- アプリを開く ---
  if (!opts.open) out.push(step("skip", "open", "--no-open なのでアプリを開いていません。"));
  else if (dry) out.push(step("skip", "open", `アプリを開きます（${result.appUrl}）。--dry-run なので開いていません。`));
  else if (out.some((s) => s.id === "bridge_start" && s.level === "error")) out.push(step("skip", "open", "橋渡しが動いていないので、アプリは開きません。"));
  else {
    const opened = openApp(result.appUrl, paths.repoRoot);
    if (opened) out.push(step("ok", "open", `作業画面を開きました（${result.appUrl}）。`));
    else out.push(step("warn", "open", `作業画面を開けませんでした。ブラウザで ${result.appUrl} を開いてください。`));
  }

  return result;
}

/**
 * 置き換える前の設定を覚える（取り消しのときに戻すため）。値を伏せた要約と控えの場所だけを覚え、
 * トークンを自分の記録に写さない。戻す先として覚えるのは**利用者の設定**（例: 別の方法で登録したもの）だけ。
 * - 置き換える相手が**この導入が前に書いた設定**（入口が同じ・この導入の形・前回の記録と同じ）なら覚えない。
 *   記録を無くしたあとに入れ直したとき、取り消しで古い自分の設定に「戻して」しまわないため。
 * - 置き換える相手が**壊れた登録**（command / args が指すファイルが無い）なら覚えない。
 *   取り消しで、動かない設定に戻してしまわないため。
 * どちらのときも、既に覚えている戻す先は消さない。
 * classification を省くと、その場で classifyPrevious で決める。
 */
export function rememberPrevious(previousRecord, key, previousEntry, backup, bridgeEntry, classification) {
  const next = { ...previousRecord };
  const kind = (classification ?? classifyPrevious(previousEntry, { bridgeEntry })).kind;
  if (previousEntry && kind === "user") next[key] = { backup, entry: redactEntry(previousEntry) };
  else if (next[key] === undefined) next[key] = null;
  return next;
}

/**
 * 置き換える前の設定について、画面に出す行。
 * 戻す先として記録したか・しなかったか（とその理由）を必ず出す。
 */
export function previousEntrySteps(id, previousEntry, classification, backup) {
  if (!previousEntry || classification.kind === "none") return [];
  const summary = JSON.stringify(redactEntry(previousEntry));
  if (classification.kind === "user") {
    return [step("warn", `${id}_prev`, `置き換えた前の設定（値は伏せています）: ${summary}`, "戻すときは --uninstall を実行してください（控えから戻します）。")];
  }
  if (classification.kind === "ours") {
    return [step("ok", `${id}_prev`, "置き換えた前の mxstudio の設定は、前回この導入が書いたものなので、取り消し（--uninstall）で戻す先としては記録しません。")];
  }
  return [
    step(
      "warn",
      `${id}_prev`,
      `置き換えた前の mxstudio の設定は、指しているファイルが見つからないので（${classification.missing.join(" / ")}）、取り消し（--uninstall）で戻す先としては記録しません（値は伏せています: ${summary}）。`,
      backup ? `取り消すと mxstudio の設定は外れるだけになります。前の設定が必要なら、控えから手で戻してください: ${backup}` : "取り消すと mxstudio の設定は外れるだけになります。",
    ),
  ];
}

/** 登録の行に付ける「何を置き換えたか」 */
function replacedNote(kind) {
  if (kind === "user") return "（前の mxstudio の設定を置き換えました）";
  if (kind === "ours") return "（前回の導入の設定を書き直しました）";
  if (kind === "broken") return "（見つからないファイルを指していた前の設定を置き換えました）";
  return "";
}

/** Claude Code（~/.claude.json の mcpServers）に登録する */
function registerCode(opts, paths, entry, bridgeEntry, lastWritten, result, out) {
  const configPath = paths.claudeCodeConfig;
  const read = readJsonFile(configPath);
  if (read.error) {
    out.push(step("error", "claude_code", `${configPath} を読めないので触りません（${read.error}）。`, "ファイルを直してから、この導入をもう一度実行してください。"));
    return;
  }
  const merged = mergeMcpServer(read.json, MCP_NAME, entry);
  if (!merged.changed) {
    result.installed.claudeCode = true;
    out.push(step("ok", "claude_code", `Claude Code には既に同じ設定が入っています（${configPath}）。`));
    return;
  }
  if (opts.dryRun) {
    out.push(step("skip", "claude_code", `Claude Code に ${MCP_NAME} を登録します（${configPath}）。--dry-run なので書いていません。`));
    return;
  }

  let backup = null;
  try {
    backup = backupFile(configPath, paths.backupDir);
  } catch (err) {
    out.push(step("error", "claude_code", `控えを取れないので書き換えません: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  if (backup) result.backups.push(backup);

  const classification = classifyPrevious(merged.previous, { bridgeEntry, lastWritten });
  result.previous = rememberPrevious(result.previous, "claudeCode", merged.previous, backup, bridgeEntry, classification);

  // claude コマンドを使えるときはそれで登録する（`claude mcp add --scope user mxstudio -- <node> <入口> --port <番号>`）。
  // 無い・失敗した・書けていないときは、同じ内容を自分で書く。
  //
  // claude コマンドが書くのは自分の既定の設定ファイルだけで、こちらが指定したパスではない。
  // 書き先が既定のファイルでないとき（--claude-code-config で差し替えたとき）は claude コマンドを使わない。
  // これを守らないと、別のファイルを直すつもりで本物の ~/.claude.json を書き換えてしまう（実際に起きた）。
  // 試験中（MXSTUDIO_SETUP_TEST=1）は本物の claude コマンドを探さず、一時フォルダの偽物だけを使う（chooseClaudeCli）。
  // 環境変数（CLAUDE_CONFIG_DIR）はそのまま引き継ぎ、こちらからは変えない。
  const chosen = chooseClaudeCli({
    explicit: opts.claudeCli,
    configPath,
    defaultConfigPath: paths.claudeCodeConfigDefault,
    guard: isTestGuard(),
  });
  let wroteWithCli = false;
  if (chosen.exe) {
    // 既にある名前には足せない（「already exists」で終わる）ので、置き換えるときは外してから足す
    if (merged.previous) runCli(chosen.exe, ["mcp", "remove", "--scope", "user", MCP_NAME]);
    const add = runCli(chosen.exe, ["mcp", "add", "--scope", "user", MCP_NAME, "--", entry.command, ...entry.args]);
    const after = readJsonFile(configPath);
    wroteWithCli = add.status === 0 && !after.error && isSameEntry(after.json?.mcpServers?.[MCP_NAME], entry);
  }
  if (!wroteWithCli) {
    try {
      const again = readJsonFile(configPath);
      if (again.error) throw new Error(again.error);
      writeJsonFileAtomic(configPath, mergeMcpServer(again.json, MCP_NAME, entry).next);
    } catch (err) {
      out.push(step("error", "claude_code", `Claude Code の設定を書けませんでした: ${err instanceof Error ? err.message : String(err)}`, backup ? `控え: ${backup}` : undefined));
      return;
    }
  }
  result.installed.claudeCode = true;
  out.push(
    step(
      "ok",
      "claude_code",
      `Claude Code に ${MCP_NAME} を登録しました${replacedNote(classification.kind)}（${configPath}${wroteWithCli ? "・claude コマンド" : ""}）。`,
      backup ? `書き換える前の控え: ${backup}` : undefined,
    ),
  );
  out.push(...previousEntrySteps("claude_code", merged.previous, classification, backup));
}

/** Claude Desktop（claude_desktop_config.json）に登録する */
function registerDesktop(opts, paths, entry, bridgeEntry, lastWritten, result, out) {
  const target = { id: "claude_desktop", label: "Claude Desktop", key: "claudeDesktop", configPath: paths.claudeDesktopConfig };
  if (!registerMcpConfigFile(opts, paths, target, entry, bridgeEntry, lastWritten, result, out)) return;
  out.push(step("warn", "claude_desktop_restart", "Claude Desktop は再起動するまで新しい設定を読みません。", "タスクトレイのアイコンから終了して、開き直してください（ウィンドウを閉じるだけでは終わりません）。"));
}

/** Antigravity（~/.gemini/config/mcp_config.json。2.0・IDE・agy CLI が共有する）に登録する */
function registerAntigravity(opts, paths, entry, bridgeEntry, lastWritten, result, out) {
  const target = {
    id: "antigravity",
    label: "Antigravity",
    key: "antigravity",
    configPath: paths.antigravityConfig,
    hint: "2.0・IDE・agy CLI が同じ設定を読みます。新しい会話から mxstudio のツールが使えます（出てこなければ Antigravity を開き直してください）。",
  };
  registerMcpConfigFile(opts, paths, target, entry, bridgeEntry, lastWritten, result, out);
}

/**
 * mcpServers を持つ JSON の設定ファイルに mxstudio を 1 ブロックだけ書く（Claude Desktop・Antigravity）。
 * 読めないファイルには触らず、書き換える前に控えを取り、置き換えた前の設定は取り消しで戻せるように覚える。
 * 書いた（書くことになった）ときだけ true を返す。
 */
function registerMcpConfigFile(opts, paths, target, entry, bridgeEntry, lastWritten, result, out) {
  const { id, label, key, configPath, hint } = target;
  const read = readJsonFile(configPath);
  if (read.error) {
    out.push(step("error", id, `${configPath} を読めないので触りません（${read.error}）。`, "ファイルを直してから、この導入をもう一度実行してください。"));
    return false;
  }
  const merged = mergeMcpServer(read.json, MCP_NAME, entry);
  if (!merged.changed) {
    result.installed[key] = true;
    out.push(step("ok", id, `${label} には既に同じ設定が入っています（${configPath}）。`));
    return false;
  }
  if (opts.dryRun) {
    out.push(step("skip", id, `${label} に ${MCP_NAME} を登録します（${configPath}）。--dry-run なので書いていません。`));
    return false;
  }

  let backup = null;
  try {
    backup = backupFile(configPath, paths.backupDir);
  } catch (err) {
    out.push(step("error", id, `控えを取れないので書き換えません: ${err instanceof Error ? err.message : String(err)}`));
    return false;
  }
  if (backup) result.backups.push(backup);
  const classification = classifyPrevious(merged.previous, { bridgeEntry, lastWritten });
  result.previous = rememberPrevious(result.previous, key, merged.previous, backup, bridgeEntry, classification);

  try {
    writeJsonFileAtomic(configPath, merged.next);
  } catch (err) {
    out.push(step("error", id, `${label} の設定を書けませんでした: ${err instanceof Error ? err.message : String(err)}`, backup ? `控え: ${backup}` : undefined));
    return false;
  }
  result.installed[key] = true;
  const hints = [backup ? `書き換える前の控え: ${backup}` : null, hint ?? null].filter(Boolean);
  out.push(step("ok", id, `${label} に ${MCP_NAME} を登録しました${replacedNote(classification.kind)}（${configPath}）。`, hints.length > 0 ? hints.join(" ") : undefined));
  out.push(...previousEntrySteps(id, merged.previous, classification, backup));
  return true;
}

// ---------------------------------------------------------------------------
// Skill（作業手順書）
// ---------------------------------------------------------------------------

const SKILL_FILE = "SKILL.md";
const SKILL_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
/** 利用者の Skill の置き場所（状態フォルダ ~/.config/mxstudio の下。橋渡しの src/bridge/skills.ts と同じ） */
export const USER_SKILLS_DIR_NAME = "skills";

/** BOM を除き、改行を LF にそろえる（scripts/build-skills.ts の normalizeText と同じ） */
export function normalizeSkillText(text) {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, "\n");
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** フォルダの下の Skill（<name>/SKILL.md）。名前の書式に合うフォルダだけ */
function readSkillsIn(dir) {
  if (!isDir(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && SKILL_NAME_PATTERN.test(e.name) && isFile(path.join(dir, e.name, SKILL_FILE)))
    .map((e) => ({ name: e.name, text: normalizeSkillText(readFileSync(path.join(dir, e.name, SKILL_FILE), "utf8")) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** アプリ既定の Skill（リポジトリの skills/<name>/SKILL.md） */
export function readRepoSkills(repoRoot) {
  return readSkillsIn(path.join(repoRoot, "skills"));
}

/** frontmatter の name（無ければ null）。細かい検証は橋渡しが行う（作業画面の設定に問題として出る） */
export function skillFrontmatterName(text) {
  const lines = normalizeSkillText(text).split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  for (const line of lines.slice(1, end < 0 ? 1 : end)) {
    const m = /^name:\s*["']?([a-z0-9-]+)["']?\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * 利用者の Skill（~/.config/mxstudio/skills/<name>/SKILL.md）。
 * 既定と同じ名前、frontmatter の name がフォルダ名と違うものは入れない（problems に理由を返す）。
 */
export function readUserSkills(stateDir, defaultNames) {
  const skills = [];
  const problems = [];
  for (const skill of readSkillsIn(path.join(stateDir, USER_SKILLS_DIR_NAME))) {
    if (defaultNames.has(skill.name)) problems.push(`${skill.name}（アプリ既定と同じ名前）`);
    else if (skillFrontmatterName(skill.text) !== skill.name) problems.push(`${skill.name}（frontmatter の name がフォルダ名と違う）`);
    else skills.push(skill);
  }
  return { skills, problems };
}

/**
 * 入れ方を決める。
 * - "install": まだ無い
 * - "same": 同じ中身が入っている（書かない）
 * - "update": 前回この導入が入れた中身のまま（記録のハッシュと一致）なので上書きしてよい
 * - "backup": 利用者が書き換えたか、同じ名前の別の Skill。控えを取ってから置き換える
 */
export function planSkillInstall(text, existingText, recordedHash) {
  if (existingText === null) return "install";
  const current = normalizeSkillText(existingText);
  if (current === text) return "same";
  if (recordedHash && sha256Hex(current) === recordedHash) return "update";
  return "backup";
}

/**
 * 取り消すかを決める。この導入が入れた中身のまま（記録のハッシュと一致）なら消す。
 * 書き換えられていたら残す（利用者の手を消さない）。
 */
export function planSkillRemoval(existingText, recordedHash) {
  if (existingText === null) return "absent";
  if (recordedHash && sha256Hex(normalizeSkillText(existingText)) === recordedHash) return "remove";
  return "keep";
}

function readTextIfFile(file) {
  return isFile(file) ? readFileSync(file, "utf8") : null;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function installSkills(opts, paths, state, result, out) {
  if (!opts.skills) {
    out.push(step("skip", "skills", "--no-skills なので Claude Code に Skill を入れていません。"));
    return;
  }
  const defaults = readRepoSkills(paths.repoRoot);
  if (defaults.length === 0) {
    out.push(step("warn", "skills", `リポジトリに Skill がありません（${path.join(paths.repoRoot, "skills")}）。`));
    return;
  }
  const userDir = path.join(paths.stateDir, USER_SKILLS_DIR_NAME);
  const user = readUserSkills(paths.stateDir, new Set(defaults.map((sk) => sk.name)));
  const skills = [...defaults.map((sk) => ({ ...sk, origin: "default" })), ...user.skills.map((sk) => ({ ...sk, origin: "user" }))];
  if (user.problems.length > 0) {
    out.push(step("warn", "user_skills", `入れなかった利用者の Skill があります: ${user.problems.join(" / ")}`, `${userDir} の中を直してから、もう一度実行してください（作業画面の設定の「Skill」にも理由が出ます）。`));
  }
  const targets = skillTargets(opts, paths);
  if (opts.dryRun) {
    for (const t of targets) {
      out.push(step("skip", t.id, `${t.label} に Skill を入れます（${t.dir} に ${skills.map((sk) => sk.name).join(", ")}）。--dry-run なので書いていません。`));
    }
    return;
  }
  for (const t of targets) copySkillsTo(t, skills, paths, state, result, out);
}

/**
 * Skill を写す先。Claude Code（~/.claude/skills）と、Antigravity に登録するなら ~/.gemini/skills
 * （Antigravity の 2.0・IDE・agy CLI のどれからも読める場所）。
 * record は setup.json の installed の下の名前。step の id と控えの名前も先ごとに分ける。
 */
export function skillTargets(opts, paths, dirExists = isDir) {
  const targets = [
    {
      id: "skills",
      label: "Claude Code",
      dir: paths.claudeSkillsDir,
      record: "skills",
      backupPrefix: "skill",
      readyHint: "Claude Code（Claude Desktop の Code タブを含む）は新しいセッションから使えます。",
    },
  ];
  if (antigravityWanted(opts, paths, dirExists).ok) {
    targets.push({
      id: "antigravity_skills",
      label: "Antigravity",
      dir: paths.antigravitySkillsDir,
      record: "antigravitySkills",
      backupPrefix: "antigravity-skill",
      readyHint: "Antigravity（2.0・IDE・agy CLI）は新しい会話から使えます。",
    });
  }
  return targets;
}

/** 記録（setup.json）にある、その先に入れた Skill の一覧 */
function recordedSkills(state, record) {
  const list = state?.installed?.[record];
  return Array.isArray(list) ? list.filter((sk) => sk && SKILL_NAME_PATTERN.test(sk.name)) : [];
}

function copySkillsTo(target, skills, paths, state, result, out) {
  const userDir = path.join(paths.stateDir, USER_SKILLS_DIR_NAME);
  const recordedList = recordedSkills(state, target.record);
  const recorded = new Map(recordedList.map((sk) => [sk.name, sk.sha256]));
  const installed = result.installed[target.record];
  const backups = [];
  const failed = [];
  for (const skill of skills) {
    const dir = path.join(target.dir, skill.name);
    const file = path.join(dir, SKILL_FILE);
    try {
      const plan = planSkillInstall(skill.text, readTextIfFile(file), recorded.get(skill.name));
      if (plan === "backup") {
        const dest = path.join(paths.backupDir, `${target.backupPrefix}-${skill.name}.${timestamp()}`);
        mkdirSync(paths.backupDir, { recursive: true });
        cpSync(dir, dest, { recursive: true });
        backups.push(dest);
        result.backups.push(dest);
      }
      if (plan !== "same") {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, skill.text, "utf8");
      }
      installed.push({ name: skill.name, sha256: sha256Hex(skill.text), origin: skill.origin });
    } catch (err) {
      failed.push(`${skill.name}（${err instanceof Error ? err.message : String(err)}）`);
    }
  }
  // 前回入れたが、今は既定にも利用者の Skill にも無いもの（利用者が消した・既定から外れた）。書き換えられていなければ消す
  const provided = new Set(skills.map((sk) => sk.name));
  const retired = [];
  for (const sk of recordedList) {
    if (provided.has(sk.name)) continue;
    const dir = path.join(target.dir, sk.name);
    const file = path.join(dir, SKILL_FILE);
    const plan = planSkillRemoval(readTextIfFile(file), sk.sha256);
    if (plan === "keep") {
      // 書き換えられている。消さずに記録からだけ外す（利用者の手を消さない）
      out.push(step("warn", target.id, `${sk.name} はもう配っていませんが、書き換えられているので残しました（${dir}）。`, "要らなければ手で消してください。"));
      continue;
    }
    if (plan === "remove") {
      try {
        rmSync(file, { force: true });
        if (isDir(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
        retired.push(sk.name);
      } catch (err) {
        failed.push(`${sk.name}（${err instanceof Error ? err.message : String(err)}）`);
      }
    }
  }
  const named = (origin) => installed.filter((sk) => sk.origin === origin).map((sk) => sk.name);
  if (installed.length > 0) {
    const users = named("user");
    out.push(
      step(
        "ok",
        target.id,
        `${target.label} に Skill を ${installed.length} 件入れました（${target.dir}。アプリ既定: ${named("default").join(", ")}／利用者の Skill: ${users.length > 0 ? users.join(", ") : "なし"}）。`,
        `${target.readyHint}業務や客先ごとの手順は ${userDir} に <名前>/SKILL.md で置き、この導入をもう一度実行すると入ります。`,
      ),
    );
  }
  if (retired.length > 0) out.push(step("ok", `${target.id}_retired`, `もう配っていない Skill を消しました（${target.dir}: ${retired.join(", ")}）。`));
  if (backups.length > 0) out.push(step("warn", `${target.id}_backup`, `同じ名前の Skill が書き換えられていたので、控えを取ってから置き換えました: ${backups.join(" / ")}`));
  if (failed.length > 0) out.push(step("error", target.id, `Skill を入れられませんでした: ${failed.join(" / ")}`, `${target.dir} に書き込めるか確かめてから、もう一度実行してください。`));
}

function uninstallSkills(opts, paths, state, out) {
  const targets = [
    { id: "skills", label: "Claude Code", dir: paths.claudeSkillsDir, record: "skills" },
    // Antigravity の分は、記録があるときだけ（入れていなければ行を出さない）。--no-antigravity なら触らない
    ...(opts.antigravity && recordedSkills(state, "antigravitySkills").length > 0
      ? [{ id: "antigravity_skills", label: "Antigravity", dir: paths.antigravitySkillsDir, record: "antigravitySkills" }]
      : []),
  ];
  for (const t of targets) uninstallSkillsFrom(t, opts, paths, state, out);
}

function uninstallSkillsFrom(target, opts, paths, state, out) {
  const recorded = recordedSkills(state, target.record);
  if (recorded.length === 0) {
    out.push(step("ok", target.id, "この導入が入れた Skill の記録はありません。"));
    return;
  }
  const removed = [];
  const kept = [];
  const failed = [];
  for (const sk of recorded) {
    const dir = path.join(target.dir, sk.name);
    const file = path.join(dir, SKILL_FILE);
    const plan = planSkillRemoval(readTextIfFile(file), sk.sha256);
    if (plan === "absent") continue;
    if (plan === "keep") {
      kept.push(sk.name);
      continue;
    }
    if (opts.dryRun) {
      removed.push(sk.name);
      continue;
    }
    try {
      rmSync(file, { force: true });
      // SKILL.md のほかにファイルが無ければフォルダも消す（利用者が足したファイルは残す）
      if (isDir(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
      removed.push(sk.name);
    } catch (err) {
      failed.push(`${sk.name}（${err instanceof Error ? err.message : String(err)}）`);
    }
  }
  if (removed.length > 0) {
    const message = opts.dryRun
      ? `${target.label} の Skill を消します（${removed.join(", ")}。--dry-run なので消していません）。`
      : `${target.label} の Skill を消しました（${target.dir}: ${removed.join(", ")}）。`;
    out.push(step(opts.dryRun ? "skip" : "ok", target.id, message, `利用者の Skill の元（${path.join(paths.stateDir, USER_SKILLS_DIR_NAME)}）は消していません。`));
  } else if (kept.length === 0 && failed.length === 0) {
    out.push(step("ok", target.id, "この導入が入れた Skill は、もうありません。"));
  }
  if (kept.length > 0) out.push(step("warn", target.id, `書き換えられている Skill は残しました（${target.dir}: ${kept.join(", ")}）。`, "要らなければ手で消してください。"));
  if (failed.length > 0) out.push(step("warn", target.id, `Skill を消せませんでした: ${failed.join(" / ")}`));
}

/** Skill が記録どおりに入っているか。target を省くと Claude Code の分 */
export function skillsStatusStep(paths, state, target = { id: "skills", label: "Skill", dir: paths.claudeSkillsDir, record: "skills" }) {
  const { id, label, dir, record } = target;
  const recorded = Array.isArray(state?.installed?.[record]) ? state.installed[record].map((sk) => sk.name) : [];
  if (recorded.length === 0) return step("warn", id, `${label}: この導入の記録がありません（${dir}）。`);
  const present = readdirSafe(dir).filter((name) => isFile(path.join(dir, name, SKILL_FILE)));
  const missing = recorded.filter((name) => !present.includes(name));
  if (missing.length > 0) return step("warn", id, `${label}: ${missing.join(", ")} がありません（${dir}）。`, "導入をもう一度実行すると入れ直します。");
  return step("ok", id, `${label}: ${recorded.join(", ")}（${dir}）`);
}

/** 作業画面を開く */
function openApp(url, cwd) {
  const browser = IS_WINDOWS ? findBrowser() : null;
  try {
    if (browser) {
      spawn(browser.exe, [`--app=${url}`], { cwd, detached: true, stdio: "ignore", windowsHide: false }).unref();
      return true;
    }
    if (IS_WINDOWS) {
      spawn("cmd.exe", ["/c", "start", "", url], { cwd, detached: true, stdio: "ignore", windowsHide: true }).unref();
      return true;
    }
    spawn("xdg-open", [url], { cwd, detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 取り消し
// ---------------------------------------------------------------------------

async function uninstall(opts, paths, out) {
  const dry = opts.dryRun;
  const state = readState(paths.statePath);
  if (!state) out.push(step("warn", "state", `導入の記録がありません（${paths.statePath}）。分かる範囲で取り消します。`));
  const bridgeEntry = state?.bridgeEntry ?? resolveBridgeEntry(paths.repoRoot, opts.bridge).entry;

  // --- 橋渡しを止める ---
  const port = Number.isInteger(state?.port) ? state.port : (opts.port ?? DEFAULT_PORT);
  if (dry) {
    out.push(step("skip", "bridge_stop", `橋渡し（ポート ${port}）を止めます。--dry-run なので止めていません。`));
  } else {
    const manualHint = "自動起動で動いている分は、最小化されている「node」のウィンドウを閉じれば止まります。導入の途中で起動した分はウィンドウを出さないので、タスクマネージャーの「詳細」タブで node.exe（コマンドラインに src\\bridge\\cli.ts を含むもの。コマンドラインの列は列の見出しを右クリック →「列の選択」で出します）を終了してください。";
    const reasons = [];
    const handled = new Set();
    let failed = false;
    /** 止めたあとにポートを引き継いだ別の橋渡しのプロセス番号 */
    let takeover = null;
    /** ポートを持っていたのが Claude Code / Claude Desktop の起動した橋渡しだったとき、そのプロセス番号（止めない） */
    let claudeOwned = null;
    // 1) いまポートで待ち受けている橋渡し（自動起動の分は記録に番号が無いので、Windows に聞く）
    const before = await probeBridge(port);
    if (before.state === "bridge") {
      const owner = inspectProcess({ port });
      const pid = owner.ok && owner.pid > 0 ? owner.pid : Number.isInteger(before.health?.pid) ? before.health.pid : null;
      if (pid) handled.add(pid);
      const stopped = pid ? stopBridgeByPid(pid, bridgeEntry) : { ok: false, reason: owner.ok ? "待ち受けているプロセスが分かりません。" : owner.reason };
      const down = stopped.ok && !stopped.mcp && (await waitUntilDown(port));
      if (stopped.ok && stopped.mcp) {
        claudeOwned = pid;
      } else if (stopped.ok && (down || stopped.stopped)) {
        // 止めたあと、Claude Code / Claude Desktop が起動した橋渡し（client）がポートを引き継ぐことがある
        // （本物の橋渡しで、止めてから約 1.3 秒後に引き継いだ）。少しのあいだ見張り、別のプロセスが応えたら止めずに知らせる
        const back = down ? await waitUntilBridge(port, TAKEOVER_WATCH_MS) : true;
        const next = back ? inspectProcess({ port }) : null;
        if (!back) {
          reasons.push(stopped.reason);
        } else if (next?.ok && next.pid > 0 && next.pid !== pid) {
          reasons.push(stopped.reason);
          takeover = next.pid;
        } else if (down) {
          // 一度止まってから、また応えた。プロセス番号は分からないが、止めたものとは別
          reasons.push(stopped.reason);
          takeover = "?";
        } else {
          failed = true;
          reasons.push(`ポート ${port} の橋渡しがまだ応答しています。`);
        }
      } else {
        failed = true;
        reasons.push(stopped.ok ? `ポート ${port} の橋渡しがまだ応答しています。` : stopped.reason);
      }
    }
    // 2) 記録にある番号（古い版の導入でポートがずれて起動した分など）
    if (Number.isInteger(state?.bridgePid) && !handled.has(state.bridgePid)) {
      const stopped = stopBridgeByPid(state.bridgePid, bridgeEntry);
      // 番号が使い回されて別のプロセスになっていることがある。そのときは止めないのが正しいので失敗扱いにしない
      if (stopped.ok && stopped.stopped) reasons.push(stopped.reason);
    }
    if (failed) out.push(step("warn", "bridge_stop", `橋渡しを止められませんでした（${reasons.join(" / ")}）。`, manualHint));
    else if (claudeOwned) {
      out.push(
        step(
          "warn",
          "bridge_stop",
          `ポート ${port} の橋渡しは Claude Code / Claude Desktop が起動したもの（プロセス ${claudeOwned}）なので、止めていません${reasons.length > 0 ? `（${reasons.join(" / ")}）` : ""}。`,
          "Claude の中で使っている最中のツールを切らないためです。Claude Code / Claude Desktop を終了すると止まります（Claude の設定からは、このあと mxstudio を外します）。",
        ),
      );
    } else if (reasons.length > 0) out.push(step("ok", "bridge_stop", `橋渡しを止めました（${reasons.join(" / ")}）。`));
    else out.push(step("ok", "bridge_stop", `ポート ${port} で橋渡しは動いていません。`));
    if (takeover) {
      out.push(
        step(
          "warn",
          "bridge_takeover",
          `止めたあと、別の橋渡し（プロセス ${takeover}）がポート ${port} を引き継ぎました。止めていません。`,
          "Claude Code / Claude Desktop が起動したものなら、Claude を終了すると止まります（Claude の設定からは、このあと mxstudio を外します）。",
        ),
      );
    }
    // 隣のポートの橋渡し（古い版・手で起動した分）はここでは止めない。残っていれば知らせる
    const others = await findOtherBridges(port);
    if (others.length > 0) out.push(otherBridgesStep(others));
  }

  // --- Claude Code / Claude Desktop ---
  const lastWritten = lastWrittenEntries(state);
  unregister(opts, paths, paths.claudeCodeConfig, state?.previous?.claudeCode, bridgeEntry, lastWritten, "claude_code", "Claude Code", out);
  unregister(opts, paths, paths.claudeDesktopConfig, state?.previous?.claudeDesktop, bridgeEntry, lastWritten, "claude_desktop", "Claude Desktop", out);
  // Antigravity は入れていない PC が多いので、設定ファイルがあるか、記録に入れたとあるときだけ行を出す
  if (opts.antigravity && (state?.installed?.antigravity || existsSync(paths.antigravityConfig))) {
    unregister(opts, paths, paths.antigravityConfig, state?.previous?.antigravity, bridgeEntry, lastWritten, "antigravity", "Antigravity", out);
  }

  // --- Skill ---
  uninstallSkills(opts, paths, state, out);

  // --- ショートカット ---
  for (const [id, label, target] of [
    ["autostart", "自動起動", state?.installed?.startup ?? path.join(paths.startupDir, STARTUP_SHORTCUT)],
    ["shortcut", "デスクトップのショートカット", state?.installed?.desktopShortcut ?? path.join(paths.desktopDir, DESKTOP_SHORTCUT_LNK)],
  ]) {
    const extra = id === "shortcut" ? [path.join(paths.desktopDir, DESKTOP_SHORTCUT_URL), path.join(paths.desktopDir, DESKTOP_SHORTCUT_LNK)] : [];
    const targets = [...new Set([target, ...extra])].filter((p) => existsSync(p));
    if (targets.length === 0) {
      out.push(step("ok", id, `${label}のファイルはありません。`));
      continue;
    }
    if (dry) {
      out.push(step("skip", id, `${label}を消します（${targets.join(" / ")}）。--dry-run なので消していません。`));
      continue;
    }
    const failed = [];
    for (const p of targets) {
      try {
        rmSync(p, { force: true });
      } catch (err) {
        failed.push(`${p}（${err instanceof Error ? err.message : String(err)}）`);
      }
    }
    if (failed.length === 0) out.push(step("ok", id, `${label}を消しました（${targets.join(" / ")}）。`));
    else out.push(step("warn", id, `${label}を消せませんでした: ${failed.join(" / ")}`, "エクスプローラーで手で消してください。"));
  }

  // --- 記録 ---
  if (!dry && existsSync(paths.statePath)) {
    try {
      rmSync(paths.statePath, { force: true });
      out.push(step("ok", "state", `導入の記録を消しました（${paths.statePath}）。`, `控えは ${paths.backupDir} に残してあります。`));
    } catch (err) {
      out.push(step("warn", "state", `導入の記録を消せませんでした: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  return state ?? {};
}

/** 設定から mxstudio を外す。置き換える前の設定があれば控えから戻す */
function unregister(opts, paths, configPath, previous, bridgeEntry, lastWritten, id, label, out) {
  const read = readJsonFile(configPath);
  if (!read.exists) {
    out.push(step("ok", id, `${label} の設定ファイルはありません（${configPath}）。`));
    return;
  }
  if (read.error) {
    out.push(step("warn", id, `${label} の設定を読めないので触りません（${read.error}）。`));
    return;
  }
  const current = read.json?.mcpServers?.[MCP_NAME];
  if (!current) {
    out.push(step("ok", id, `${label} に ${MCP_NAME} の設定はありません。`));
    return;
  }
  if (!isOurEntry(current, bridgeEntry)) {
    out.push(step("warn", id, `${label} の ${MCP_NAME} は、この導入が作ったものではないようなので残します: ${JSON.stringify(redactEntry(current))}`, "外すなら手で消してください。"));
    return;
  }
  let restore = previous ? entryFromBackup(previous.backup, MCP_NAME) : null;
  if (previous && !restore) {
    out.push(step("warn", id, `${label} の前の設定を控えから読めませんでした（${previous.backup ?? "控え無し"}）。外すだけにします。`));
  }
  // 控えにあった前の設定が、この導入の書いたもの・壊れた登録なら戻さない（古い版の導入が記録してしまった分）
  if (restore) {
    const kind = classifyPrevious(restore, { bridgeEntry, lastWritten });
    if (kind.kind === "ours") {
      out.push(step("warn", id, `${label} の控えにある前の設定は、この導入が書いたものなので戻しません。外すだけにします。`));
      restore = null;
    } else if (kind.kind === "broken") {
      out.push(
        step(
          "warn",
          id,
          `${label} の控えにある前の設定は、指しているファイルが見つからないので戻しません（${kind.missing.join(" / ")}）。外すだけにします。`,
          `前の設定が必要なら、控えから手で戻してください: ${previous.backup}`,
        ),
      );
      restore = null;
    }
  }
  if (opts.dryRun) {
    out.push(step("skip", id, `${label} から ${MCP_NAME} を${restore ? "前の設定に戻します" : "外します"}（${configPath}）。--dry-run なので書いていません。`));
    return;
  }
  let backup = null;
  try {
    backup = backupFile(configPath, paths.backupDir);
    writeJsonFileAtomic(configPath, removeMcpServer(read.json, MCP_NAME, restore).next);
  } catch (err) {
    out.push(step("error", id, `${label} の設定を書けませんでした: ${err instanceof Error ? err.message : String(err)}`, backup ? `控え: ${backup}` : undefined));
    return;
  }
  out.push(step("ok", id, `${label} から ${MCP_NAME} を${restore ? "外し、前の設定に戻しました" : "外しました"}（${configPath}）。`, backup ? `書き換える前の控え: ${backup}` : undefined));
  if (id === "claude_desktop") out.push(step("warn", "claude_desktop_restart", "Claude Desktop は再起動するまで設定の変更を読みません。"));
}

// ---------------------------------------------------------------------------
// 状態を見る
// ---------------------------------------------------------------------------

async function status(opts, paths, out) {
  const state = readState(paths.statePath);
  if (!state) {
    out.push(step("warn", "state", `導入の記録がありません（${paths.statePath}）。まだ導入していないか、別の場所に入れています。`));
  } else {
    out.push(step("ok", "state", `記録: ${paths.statePath}（ポート ${state.port}・入口 ${state.bridgeEntry}）`));
  }
  const port = opts.port ?? (Number.isInteger(state?.port) ? state.port : DEFAULT_PORT);
  // 橋渡しが 1 つ動いているか（/_mxstudio/health で確かめる）。隣のポートに残っている古い版も知らせる
  const entryForProtocol = typeof state?.bridgeEntry === "string" ? state.bridgeEntry : resolveBridgeEntry(paths.repoRoot, opts.bridge).entry;
  out.push(singleBridgeStep(port, await probeBridge(port), true, expectedPeerProtocol(entryForProtocol)));
  const others = await findOtherBridges(port);
  if (others.length > 0) out.push(otherBridgesStep(others));

  const antigravity = antigravityWanted(opts, paths);
  for (const [id, label, configPath] of [
    ["claude_code", "Claude Code", paths.claudeCodeConfig],
    ["claude_desktop", "Claude Desktop", paths.claudeDesktopConfig],
    ...(antigravity.ok ? [["antigravity", "Antigravity", paths.antigravityConfig]] : []),
  ]) {
    const read = readJsonFile(configPath);
    if (!read.exists) out.push(step("warn", id, `${label} の設定ファイルがありません（${configPath}）。`));
    else if (read.error) out.push(step("warn", id, `${label} の設定を読めません（${read.error}）。`));
    else {
      const entry = read.json?.mcpServers?.[MCP_NAME];
      if (entry) out.push(step("ok", id, `${label}: ${JSON.stringify(redactEntry(entry))}`));
      else out.push(step("warn", id, `${label} に ${MCP_NAME} の設定はありません。`));
    }
  }
  if (!antigravity.ok) out.push(step("skip", "antigravity", `${antigravity.reason}、Antigravity は見ていません。`));
  out.push(skillsStatusStep(paths, state));
  if (antigravity.ok) {
    out.push(skillsStatusStep(paths, state, { id: "antigravity_skills", label: "Antigravity の Skill", dir: paths.antigravitySkillsDir, record: "antigravitySkills" }));
  }
  const startupPath = path.join(paths.startupDir, STARTUP_SHORTCUT);
  out.push(existsSync(startupPath) ? step("ok", "autostart", `自動起動: ${startupPath}`) : step("warn", "autostart", `自動起動: ありません（${startupPath}）`));
  // デスクトップは .lnk（アプリ窓）か .url（既定のブラウザ）のどちらか 1 つがあればよい
  const shortcuts = [DESKTOP_SHORTCUT_LNK, DESKTOP_SHORTCUT_URL].map((name) => path.join(paths.desktopDir, name)).filter((p) => existsSync(p));
  out.push(
    shortcuts.length > 0
      ? step("ok", "shortcut", `デスクトップのショートカット: ${shortcuts.join(" / ")}`)
      : step("warn", "shortcut", `デスクトップのショートカット: ありません（${paths.desktopDir} に ${DESKTOP_SHORTCUT_LNK} も ${DESKTOP_SHORTCUT_URL} も無い）`),
  );
  return state ?? {};
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------

function printText(mode, steps, result, paths, dryRun) {
  const title = mode === "uninstall" ? "mxstudio の取り消し" : mode === "status" ? "mxstudio の状態" : "mxstudio をこの PC に入れる";
  const lines = [title, ""];
  for (const s of steps) {
    lines.push(`[${LABEL[s.level]}] ${s.message}`);
    if (s.hint) lines.push(`         → ${s.hint}`);
  }
  const errors = steps.filter((s) => s.level === "error").length;
  const warns = steps.filter((s) => s.level === "warn").length;
  const undo = IS_WINDOWS ? `"${path.join(paths.repoRoot, "mxstudio.cmd")}" --uninstall` : `node "${path.join(paths.repoRoot, "scripts", "setup-local.mjs")}" --uninstall`;
  lines.push("");
  if (dryRun && mode !== "status") {
    lines.push(`--dry-run なので、何も書き換えていません（上は実際に行う手順です。警告 ${warns} 件・NG ${errors} 件）。`);
  } else if (mode === "install") {
    if (errors === 0) {
      lines.push(warns === 0 ? "導入できました。" : `導入できました（警告 ${warns} 件。上の [警告] の行を読んでください）。`);
      if (result.appUrl) lines.push(`  作業画面: ${result.appUrl}${result.installed?.desktopShortcut ? "（デスクトップのショートカットからも開けます）" : ""}`);
      if (result.port) lines.push(`  橋渡し: ポート ${result.port} の 1 つだけ（作業画面と Claude Code / Claude Desktop / Antigravity で共有します）`);
      if (result.installed?.claudeCode) lines.push("  Claude Code: 起動し直すと mxstudio のツールが使えます。");
      if (result.installed?.claudeDesktop) lines.push("  Claude Desktop: いったん終了して開き直してください（再起動するまで設定を読みません）。");
      if (result.installed?.antigravity) lines.push("  Antigravity: 新しい会話から mxstudio のツールが使えます（2.0・IDE・agy CLI 共通。出てこなければ開き直してください）。");
      lines.push(`  取り消す: ${undo}`);
      if (result.installed?.startup) lines.push(`  自動起動だけやめる: ${result.installed.startup} を消す`);
    } else {
      lines.push(`NG ${errors} 件（警告 ${warns} 件）。上の「→」の手順で失敗したところを直してから、もう一度実行してください（何度実行しても壊れません）。`);
      lines.push(`  途中まで入ったものを取り消す: ${undo}`);
    }
  } else if (mode === "uninstall") {
    lines.push(errors === 0 && warns === 0 ? "取り消しました。" : errors === 0 ? `取り消しました（警告 ${warns} 件。上の [警告] の行を読んでください）。` : `NG ${errors} 件（警告 ${warns} 件）。残っているものは「→」の手順で手で消してください。`);
    lines.push(`  控え（バックアップ）: ${paths.backupDir}（元の設定ファイルのまるごとの写しなので、トークンも含みます。要らなくなったら消してください）`);
  } else {
    lines.push(`警告 ${warns} 件・NG ${errors} 件。`);
  }
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`${opts.error}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  // claude コマンドの場所は、引数が無ければ環境変数から
  if (!opts.claudeCli && process.env[CLAUDE_CLI_ENV]) opts.claudeCli = process.env[CLAUDE_CLI_ENV];
  // 試験中は、本物の設定・フォルダ・橋渡しに触れうる指定なら、場所を調べる前に止める
  if (isTestGuard()) {
    const problem = testSandboxProblem(opts);
    if (problem) {
      console.error(`${TEST_GUARD_ENV}=1（試験中）なので止めました: ${problem}`);
      return 2;
    }
  }
  const paths = makePaths(opts);
  const steps = [];
  let result = {};
  try {
    if (opts.mode === "uninstall") result = await uninstall(opts, paths, steps);
    else if (opts.mode === "status") result = await status(opts, paths, steps);
    else result = await install(opts, paths, steps);
  } catch (err) {
    steps.push(step("error", "unexpected", `途中で止まりました: ${err instanceof Error ? err.message : String(err)}`));
  }
  const errors = steps.filter((s) => s.level === "error").length;
  if (opts.json) console.log(JSON.stringify({ ok: errors === 0, mode: opts.mode, steps, result, paths }, null, 2));
  else printText(opts.mode, steps, result, paths, opts.dryRun);
  return errors === 0 ? 0 : 1;
}

// 直接実行されたときだけ動かす（試験から import しても実行されない）
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
