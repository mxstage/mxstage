#!/usr/bin/env node
// MX Stage をこの PC に入れる（1 ステップ導入）と、その取り消し。
// 橋渡し（ローカルで動く Node のプロセス）を起動し、Claude Code と Claude Desktop（入っているときだけ。Microsoft Store 版を含む）と
// Antigravity（2.0・IDE・agy CLI。入っているときだけ）と Codex（デスクトップ・CLI・IDE 拡張。入っているときだけ）と
// IBM Bob（入っているときだけ）に MCP サーバとして登録し、
// ログイン時の自動起動とアプリのショートカットを作る。
// Node の標準機能だけで動く（依存を足さない）。何度実行しても壊れない（冪等）。
//
//   node scripts/setup-local.mjs [オプション]        導入する
//   node scripts/setup-local.mjs --uninstall         取り消す
//   node scripts/setup-local.mjs --status            今の状態を見るだけ（何も書き換えない）
//
// 利用者の設定ファイル（~/.claude.json、Claude Desktop の設定、~/.gemini/config/mcp_config.json、~/.codex/config.toml、
// ~/.bob/settings/mcp.json）を書き換えるので、
// **書き換える前に必ずバックアップを取る**。既存の設定は消さない。取り消し方は画面と docs/local.md に出す。
// 改名前（mxstudio）の導入が残したものがあれば、先に片付けて新しい名前へ移す（migrateLegacy）。
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
const MCP_NAME = "mxstage";
/**
 * 橋渡しの取り決め:
 * - 橋渡しは 1 つだけ。ポートは固定（既定 8788）で、塞がっていても隣のポートへはずらさない。
 * - 最初に起動した橋渡しがポートを持ち（primary）、2 つ目以降（Claude Code / Claude Desktop が起動した分など）は
 *   client としてその橋渡しに中継する。
 * - `GET /_mxstage/health` が `{ name: "mxstage-bridge", ... }` を返す。これで「橋渡しが動いている」ことを確かめる。
 * 古い版の橋渡し（/_mxstage/health が無い）は、/ws が 426 と upgrade_required を返すことで見分ける。
 */
const BRIDGE_NAME = "mxstage-bridge";
const HEALTH_PATH = "/_mxstage/health";
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
  "bin/mxstage-bridge.mjs",
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
const TEST_GUARD_ENV = "MXSTAGE_SETUP_TEST";
/** claude コマンドの場所を差し替える環境変数（--claude-cli と同じ。引数が優先） */
const CLAUDE_CLI_ENV = "MXSTAGE_CLAUDE_CLI";

/** スタートアップとデスクトップに置くショートカットの名前（取り消しのときはこの名前で消す） */
const STARTUP_SHORTCUT = "mxstage-bridge.lnk";
const DESKTOP_SHORTCUT_LNK = "mxstage.lnk";
const DESKTOP_SHORTCUT_URL = "mxstage.url";

/**
 * 改名前（mxstudio）の名前。0.2.0 で mxstudio を MX Stage（mxstage）に改名した。
 * 導入のたびに、古い名前の登録・Skill の写し・自動起動・ショートカットが残っていないかを調べて片付け、
 * 利用者の Skill と公開前の検査の語の一覧を新しい置き場所へ写す（migrateLegacy）。
 */
const LEGACY = Object.freeze({
  mcpName: "mxstudio",
  bridgeName: "mxstudio-bridge",
  healthPath: "/_mxstudio/health",
  stateDirName: "mxstudio",
  startupShortcut: "mxstudio-bridge.lnk",
  desktopShortcuts: Object.freeze(["mxstudio.lnk", "mxstudio.url"]),
  defaultSkill: "mxstudio-workbench",
  claudeCliEnv: "MXSTUDIO_CLAUDE_CLI",
  publishTerms: "publish-terms.txt",
  /** 改名前の置き場所から写し終えた印（新しい状態フォルダに置く。橋渡しの src/bridge/legacy.ts の LEGACY_MIGRATED_MARKER と同じ） */
  migratedMarker: "migrated-from-mxstudio.json",
});

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

const USAGE = `MX Stage をこの PC に入れる（1 ステップ導入）

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
  --no-skills              Claude Code・Antigravity・Codex・IBM Bob に Skill（作業手順書）を入れない
  --no-antigravity         Antigravity（2.0・IDE・agy CLI）に登録しない（~/.gemini が無ければ、指定しなくても登録しない）
  --no-codex               Codex（デスクトップ・CLI・IDE 拡張）に登録しない（~/.codex が無ければ、指定しなくても登録しない）
  --no-claude-desktop      Claude Desktop に登録しない・触らない（設定フォルダが無ければ、指定しなくても登録しない。
                           拡張機能（.mcpb）の MX Stage が入っていて有効なら、設定ファイルには登録しない）
  --no-bob                 IBM Bob に登録しない（~/.bob が無ければ、指定しなくても登録しない）
  --claude-code            Claude Desktop に拡張機能（.mcpb）の MX Stage が入っていて有効でも、Claude Code（~/.claude.json）に登録する
                           （ふだんは Code タブでツールが二重に出ないよう登録しない。ターミナルの Claude Code で使う人向け。次回からも引き継ぐ）
  --json                   機械可読な JSON で結果を出す
  --help                   この説明を出す

  試験用（ふだんは使わない。書き換え先を差し替える）:
  --state-dir <パス>          記録とバックアップの置き場（既定: ~/.config/mxstage）
  --legacy-state-dir <パス>   改名前（mxstudio）の記録の置き場（既定: ~/.config/mxstudio。試験中は指定したときだけ移す）
  --claude-code-config <パス> Claude Code の設定ファイル（既定: ~/.claude.json）
  --claude-desktop-config <パス> Claude Desktop の設定ファイル（既定: %APPDATA%\\Claude\\claude_desktop_config.json。
                              指定すると、Microsoft Store 版の置き場所は --claude-desktop-packages-dir を指定したときだけ探す）
  --claude-desktop-packages-dir <パス> Microsoft Store 版の Claude Desktop を探すフォルダ（既定: %LOCALAPPDATA%\\Packages。
                              Claude_<発行元 ID>\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json を見る）
  --startup-dir <パス>        スタートアップフォルダ
  --desktop-dir <パス>        デスクトップフォルダ
  --claude-skills-dir <パス>  Claude Code の Skill の置き場所（既定: ~/.claude/skills）
  --antigravity-dir <パス>    Antigravity の設定フォルダ（既定: ~/.gemini。MCP は config/mcp_config.json、Skill は config/skills/）
  --codex-dir <パス>          Codex の設定フォルダ（既定: CODEX_HOME か ~/.codex。MCP は config.toml）
  --agents-skills-dir <パス>  Codex が読む個人の Skill の置き場所（既定: ~/.agents/skills）
  --bob-dir <パス>            IBM Bob の設定フォルダ（既定: ~/.bob。MCP は settings/mcp.json、Skill は skills/）
  --claude-cli <パス>        claude コマンドの場所（環境変数 ${CLAUDE_CLI_ENV} でも指定できる）。
                              使うのは Claude Code の設定が既定の場所のときだけ（試験中は一時フォルダの偽物だけ）
  環境変数 ${TEST_GUARD_ENV}=1  試験中の印。書き先（一時フォルダの中で、本物の書き先でないこと）・--port・--bridge・
                              --no-open・--no-install・--no-build（Skill を入れるなら --claude-skills-dir、
                              Antigravity に登録するなら --antigravity-dir、Codex に登録するなら --codex-dir と
                              --agents-skills-dir、IBM Bob に登録するなら --bob-dir、Claude Desktop に登録するなら
                              --claude-desktop-config も）がそろっていなければ止まり、
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
    codex: true,
    claudeDesktop: true,
    bob: true,
    claudeCode: false,
    json: false,
    help: false,
    stateDir: null,
    legacyStateDir: null,
    claudeCodeConfig: null,
    claudeDesktopConfig: null,
    claudeDesktopPackagesDir: null,
    startupDir: null,
    desktopDir: null,
    claudeSkillsDir: null,
    antigravityDir: null,
    codexDir: null,
    agentsSkillsDir: null,
    bobDir: null,
    claudeCli: null,
  };
  const withValue = {
    "--port": "port",
    "--bridge": "bridge",
    "--state-dir": "stateDir",
    "--legacy-state-dir": "legacyStateDir",
    "--claude-code-config": "claudeCodeConfig",
    "--claude-desktop-config": "claudeDesktopConfig",
    "--claude-desktop-packages-dir": "claudeDesktopPackagesDir",
    "--startup-dir": "startupDir",
    "--desktop-dir": "desktopDir",
    "--claude-skills-dir": "claudeSkillsDir",
    "--antigravity-dir": "antigravityDir",
    "--codex-dir": "codexDir",
    "--agents-skills-dir": "agentsSkillsDir",
    "--bob-dir": "bobDir",
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
    else if (arg === "--no-codex") opts.codex = false;
    else if (arg === "--no-claude-desktop") opts.claudeDesktop = false;
    else if (arg === "--no-bob") opts.bob = false;
    else if (arg === "--claude-code") opts.claudeCode = true;
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
  const tmp = `${filePath}.mxstage.tmp`;
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
  // 同じ名前の別のファイル（ふつうの版と Microsoft Store 版の claude_desktop_config.json など）を同じ時刻に控えても、上書きしない
  const stamp = timestamp();
  let dest = path.join(backupDir, `${path.basename(filePath)}.${stamp}.bak`);
  for (let i = 2; existsSync(dest); i++) dest = path.join(backupDir, `${path.basename(filePath)}.${stamp}-${i}.bak`);
  copyFileSync(filePath, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// MCP の設定（Claude Code / Claude Desktop）
// ---------------------------------------------------------------------------

/**
 * Claude Code に入れる形。`claude mcp add --scope user mxstage -- <node> <入口> --port <番号>` が
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

/** MX Stage の橋渡しを指している設定か（取り消しのとき、人が自分で足した設定を消さないため） */
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
 * 置き換える前の mcpServers.mxstage が何者か。
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
// Codex の設定（~/.codex/config.toml の [mcp_servers.mxstage]）
// デスクトップ版・CLI・IDE 拡張が同じファイルを読む。TOML なので、依存を足さずに MX Stage の表 1 つだけを読み書きし、
// ほかの行（コメントや並びも）には触らない。
// ---------------------------------------------------------------------------

/** Codex が橋渡しの起動を待つ秒数（既定の 10 秒では、初回の起動や引き継ぎで足りないことがある） */
export const CODEX_STARTUP_TIMEOUT_SEC = 30;

/** Codex に入れる設定（比べる・分類するための形。書くのは buildCodexBlock） */
export function buildCodexEntry(nodePath, bridgeEntry, port) {
  return { command: nodePath, args: [...bridgeArgs(bridgeEntry, port)] };
}

/** Codex の config.toml に書く表。文字列は JSON と同じ書き方（TOML の基本文字列としてそのまま読める） */
export function buildCodexBlock(nodePath, bridgeEntry, port) {
  const entry = buildCodexEntry(nodePath, bridgeEntry, port);
  return [
    `[mcp_servers.${MCP_NAME}]`,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT_SEC}`,
  ].join("\n");
}

/** TOML の文字列 1 つ（"基本" か 'リテラル'）を s[i] から読む。読めなければ投げる */
function tomlString(s, i) {
  if (s[i] === '"') {
    let j = i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
    if (j >= s.length) throw new Error("二重引用符が閉じていない");
    return { value: JSON.parse(s.slice(i, j + 1)), next: j + 1 };
  }
  if (s[i] === "'") {
    const j = s.indexOf("'", i + 1);
    if (j < 0) throw new Error("単一引用符が閉じていない");
    return { value: s.slice(i + 1, j), next: j + 1 };
  }
  throw new Error("文字列ではない");
}

/** 表の見出し（[a.b."c"]）を名前の並びにする。見出しでなければ null（[[配列の表]] も null） */
export function tomlTableKey(line) {
  const m = /^\s*\[(?!\[)(.*)\]\s*(?:#.*)?$/.exec(line);
  if (!m) return null;
  const inner = m[1];
  const parts = [];
  let i = 0;
  const skip = () => {
    while (inner[i] === " " || inner[i] === "\t") i++;
  };
  try {
    skip();
    while (i < inner.length) {
      if (inner[i] === '"' || inner[i] === "'") {
        const r = tomlString(inner, i);
        parts.push(r.value);
        i = r.next;
      } else {
        const bare = /^[A-Za-z0-9_-]+/.exec(inner.slice(i));
        if (!bare) return null;
        parts.push(bare[0]);
        i += bare[0].length;
      }
      skip();
      if (i < inner.length) {
        if (inner[i] !== ".") return null;
        i++;
        skip();
      }
    }
  } catch {
    return null;
  }
  return parts.length > 0 ? parts : null;
}

/** TOML の値（文字列・数・真偽値と、それらの配列）を読む。読めなければ undefined */
export function tomlValue(text) {
  let i = 0;
  const skip = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const value = () => {
    skip();
    if (text[i] === "[") {
      i++;
      const list = [];
      skip();
      while (text[i] !== "]") {
        if (i >= text.length) throw new Error("配列が閉じていない");
        list.push(value());
        skip();
        if (text[i] === ",") {
          i++;
          skip();
        } else if (text[i] !== "]") throw new Error("配列の区切りが不正");
      }
      i++;
      return list;
    }
    if (text[i] === '"' || text[i] === "'") {
      const r = tomlString(text, i);
      i = r.next;
      return r.value;
    }
    const m = /^(true|false|[-+]?\d+(?:\.\d+)?)/.exec(text.slice(i));
    if (!m) throw new Error("値を読めない");
    i += m[0].length;
    return m[0] === "true" ? true : m[0] === "false" ? false : Number(m[0]);
  };
  try {
    const v = value();
    skip();
    return i >= text.length || text[i] === "#" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 表の中の「キー = 値」を読む（複数行の配列はつなげて読む）。読めない値は undefined のまま入れる */
function tomlPairs(lines) {
  const pairs = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*([A-Za-z0-9_-]+|"[^"]*"|'[^']*')\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let raw = m[2];
    // 複数行の配列（[ で始まり、閉じていない）は ] が来るまでつなげる
    while (raw.trim().startsWith("[") && (raw.match(/\[/g) ?? []).length > (raw.match(/\]/g) ?? []).length && i + 1 < lines.length) raw += `\n${lines[++i]}`;
    pairs.set(m[1].replace(/^["']|["']$/g, ""), tomlValue(raw.trim()));
  }
  return pairs;
}

function isCodexTableKey(key, sub, name = MCP_NAME) {
  if (key === null || key.length < 2 || key[0] !== "mcp_servers" || key[1] !== name) return false;
  return sub ? key.length > 2 : key.length === 2;
}

/**
 * config.toml から [mcp_servers.mxstage] の表（と、その下の [mcp_servers.mxstage.env] などの小さな表）を探す。
 * - start / end: 表の行の範囲（end は含まない。後ろの空行は含めない）。無ければ start は -1
 * - entry: 読めた設定（command / args / env のキー）。表が無ければ null、読めなければ { unreadable: true }
 * - otherForm: 表の見出し以外の書き方（mcp_servers.mxstage.command = … や mxstage = { … }）で書かれている。触らない
 * name を渡すと、その名前の表を探す（改名前の mxstudio の表を片付けるとき）。
 */
export function findCodexTable(text, name = MCP_NAME) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  let orphanSubtable = false;
  for (let i = 0; i < lines.length; i++) {
    const isHeader = /^\s*\[/.test(lines[i]);
    if (!isHeader) continue;
    const key = tomlTableKey(lines[i]);
    if (start < 0) {
      if (isCodexTableKey(key, false, name)) start = i;
      else if (isCodexTableKey(key, true, name)) orphanSubtable = true;
    } else if (!isCodexTableKey(key, true, name)) {
      end = i;
      break;
    }
  }
  if (start >= 0) while (end > start + 1 && lines[end - 1].trim() === "") end--;
  const block = start >= 0 ? lines.slice(start, end) : null;
  const outside = start >= 0 ? [...lines.slice(0, start), ...lines.slice(end)] : lines;
  const otherForm =
    orphanSubtable ||
    outside.some((l) => new RegExp(`^\\s*(?:mcp_servers\\s*\\.\\s*)?["']?${name}["']?\\s*(?:\\.|=)`).test(l));
  let entry = null;
  if (block !== null) {
    const firstSub = block.findIndex((l, i) => i > 0 && /^\s*\[/.test(l));
    const main = tomlPairs(block.slice(1, firstSub < 0 ? block.length : firstSub));
    const command = main.get("command");
    const args = main.get("args");
    if (typeof command !== "string" || (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === "string")))) {
      entry = { unreadable: true };
    } else {
      entry = { command, args: args ?? [] };
      const envAt = block.findIndex((l) => {
        const key = tomlTableKey(l);
        return key !== null && key.length === 3 && isCodexTableKey(key, true, name) && key[2] === "env";
      });
      if (envAt >= 0) {
        const envEnd = block.findIndex((l, i) => i > envAt && /^\s*\[/.test(l));
        entry.env = Object.fromEntries(Array.from(tomlPairs(block.slice(envAt + 1, envEnd < 0 ? block.length : envEnd)).keys()).map((k) => [k, ""]));
      }
    }
  }
  return { eol, lines, start, end, block, entry, otherForm };
}

/** [mcp_servers.mxstage] の表を書く（あれば置き換え、無ければ末尾に足す）。ほかの行には触らない */
export function upsertCodexTable(text, block) {
  const found = findCodexTable(text);
  const blockLines = block.split("\n");
  let lines;
  if (found.start >= 0) {
    lines = [...found.lines.slice(0, found.start), ...blockLines, ...found.lines.slice(found.end)];
  } else {
    lines = [...found.lines];
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(...blockLines, "");
  }
  return lines.join(found.eol);
}

/** [mcp_servers.mxstage] の表を外す（restore があればその表に戻す）。name を渡すとその名前の表を外す */
export function removeCodexTable(text, restore = null, name = MCP_NAME) {
  const found = findCodexTable(text, name);
  if (found.start < 0) return { next: text, changed: false };
  const before = found.lines.slice(0, found.start);
  const after = found.lines.slice(found.end);
  if (restore) return { next: [...before, ...restore.split("\n"), ...after].join(found.eol), changed: true };
  // 表の前に置いた空行も 1 つ詰める
  if (before.length > 0 && before[before.length - 1].trim() === "") before.pop();
  return { next: [...before, ...after].join(found.eol), changed: true };
}

function writeTextFileAtomic(filePath, text) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.mxstage.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 一時ファイルが残っても、元のファイルは書き換わっていない
    }
    throw err;
  }
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
 * 記録（setup.json）・控え・橋渡しの鍵ファイルの置き場所。どの OS でも ~/.config/mxstage（src/bridge/bridgeKey.ts と同じ）。
 * %LOCALAPPDATA% に置くと、Claude（MSIX パッケージ）の中から実行したときに書き込みがパッケージ専用の場所へ振り替えられ、
 * ダブルクリックやログイン時の自動起動（パッケージの外）からは見えなくなる。
 */
function mxstageHome(home = os.homedir()) {
  return path.join(home, ".config", "mxstage");
}

function makePaths(opts) {
  const folders = opts.startupDir && opts.desktopDir ? { startup: opts.startupDir, desktop: opts.desktopDir } : shellFolders();
  const stateDir = opts.stateDir ? path.resolve(opts.stateDir) : mxstageHome();
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
    // Microsoft Store 版（MSIX）の Claude Desktop の設定ファイル（パッケージの中に設定フォルダがあるものだけ）。
    // --claude-desktop-config で差し替えたとき・試験中は、--claude-desktop-packages-dir を指定したときだけ探す（試験で本物を探さないため）
    claudeDesktopMsixConfigs: msixDesktopConfigs(
      opts.claudeDesktopPackagesDir
        ? path.resolve(opts.claudeDesktopPackagesDir)
        : opts.claudeDesktopConfig || !IS_WINDOWS || isTestGuard()
          ? null
          : path.join(localAppData(), "Packages"),
    ),
    startupDir: opts.startupDir ? path.resolve(opts.startupDir) : folders.startup,
    desktopDir: opts.desktopDir ? path.resolve(opts.desktopDir) : folders.desktop,
    // Claude Code の個人の Skill（Claude Code と同じ決め方: CLAUDE_CONFIG_DIR があればその下、無ければ ~/.claude）
    claudeSkillsDir: opts.claudeSkillsDir ? path.resolve(opts.claudeSkillsDir) : path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "skills"),
    // Antigravity（2.0・IDE・agy CLI が共有する設定。MCP は config/mcp_config.json、どの面からも読める Skill は skills/）
    ...antigravityPaths(opts.antigravityDir ? path.resolve(opts.antigravityDir) : path.join(os.homedir(), ".gemini")),
    // Codex（デスクトップ・CLI・IDE 拡張が共有する設定。Codex と同じ決め方: CODEX_HOME があればそこ、無ければ ~/.codex）
    ...codexPaths(opts.codexDir ? path.resolve(opts.codexDir) : process.env.CODEX_HOME || path.join(os.homedir(), ".codex")),
    // Codex が読む個人の Skill（~/.agents/skills。ほかのエージェントも読むことがある共通の置き場所）
    codexSkillsDir: opts.agentsSkillsDir ? path.resolve(opts.agentsSkillsDir) : path.join(os.homedir(), ".agents", "skills"),
    // IBM Bob（MCP は settings/mcp.json、Skill は skills/）
    ...bobPaths(opts.bobDir ? path.resolve(opts.bobDir) : path.join(os.homedir(), ".bob")),
  };
}

/** Microsoft Store 版の Claude Desktop のパッケージのフォルダ名（Claude_<発行元 ID>。例: Claude_pzs8sxrjxfjjc） */
export const MSIX_DESKTOP_PACKAGE = /^Claude_[a-z0-9]+$/i;

/**
 * Microsoft Store 版（MSIX）の Claude Desktop の設定ファイルを探す。
 * MSIX のアプリが %APPDATA% に新しく作るフォルダは、パッケージの中（%LOCALAPPDATA%\Packages\Claude_<発行元 ID>\LocalCache\Roaming）へ
 * 振り替えられる（%APPDATA%\Claude が先にあれば振り替えずにそこを使う）。
 * パッケージの中に設定フォルダ（LocalCache\Roaming\Claude）があるものだけを返す（無いものには作らない）。
 * packagesDir が null なら探さない。
 */
export function msixDesktopConfigs(packagesDir, dirExists = isDir) {
  if (!packagesDir) return [];
  let names = [];
  try {
    names = readdirSync(packagesDir).filter((name) => MSIX_DESKTOP_PACKAGE.test(name)).sort();
  } catch {
    return [];
  }
  return names
    .map((name) => ({ packageName: name, configPath: path.join(packagesDir, name, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json") }))
    .filter((c) => dirExists(path.dirname(c.configPath)));
}

/**
 * Claude Desktop の設定ファイルの置き場所の一覧（ふつうの版と Microsoft Store 版）。
 * present は設定フォルダがあるか（＝その置き場所の Claude Desktop が入っていて、一度は起動したか）。
 * key は setup.json の previous / installed の名前、id は画面の行の id。
 */
export function desktopLocations(paths, dirExists = isDir) {
  const list = [{ id: "claude_desktop", label: "Claude Desktop", key: "claudeDesktop", installedKey: "claudeDesktop", configPath: paths.claudeDesktopConfig }];
  for (const c of paths.claudeDesktopMsixConfigs ?? []) {
    list.push({
      id: "claude_desktop_msix",
      label: `Claude Desktop（Microsoft Store 版・${c.packageName}）`,
      key: `claudeDesktopMsix:${c.packageName}`,
      installedKey: "claudeDesktopMsix",
      configPath: c.configPath,
    });
  }
  return list.map((l) => ({ ...l, present: dirExists(path.dirname(l.configPath)) }));
}

/**
 * Claude Desktop に拡張機能（.mcpb。以前の名前は .dxt）として入っている MX Stage を探す。何も書き換えない。
 * Claude Desktop（Windows の 2.16120 で、アプリの中身から確かめた）は、設定フォルダ（userData。claude_desktop_config.json と同じフォルダ）に
 * - extensions-installations.json: { "extensions": { "<id>": { "manifest": { "name": … }, … } } }（入っている拡張機能の一覧）
 * - Claude Extensions\<id>\manifest.json: 展開した拡張機能
 * - Claude Extensions Settings\<id>.json: { "isEnabled": true | false, … }（入れたときに true で作る。必須の設定が足りないと false）
 * を置く。手元のファイルから入れた .mcpb の id は local.mcpb.<author.name を小文字にして空白を - にしたもの>.<name>
 * （MX Stage なら local.mcpb.kazuhiro-muto.mxstage）、ディレクトリから入れたものは ant.dir.… なので、id の形には頼らず、
 * manifest の name が MX Stage のもの（mcpb/manifest.template.json の "mxstage"）を探す。
 * 拡張機能のフォルダ（Claude Extensions\<id>）が無いものは入っていないと見なす。
 * 有効と見なすのは、設定の isEnabled がちょうど true のときだけ（無い・読めないときは無効と見なし、ふつうに登録する。
 * 取り違えても二重に登録されるだけで、MX Stage が使えなくなることはないため）。
 * 返す: 見つからなければ null。見つかれば { id, enabled }（有効なものを優先）
 */
export function findDesktopExtension(userDataDir, name = MCP_NAME) {
  const extDir = path.join(userDataDir, "Claude Extensions");
  const ids = new Set();
  const index = readJsonFile(path.join(userDataDir, "extensions-installations.json"));
  const extensions = index.json?.extensions;
  if (extensions && typeof extensions === "object" && !Array.isArray(extensions)) {
    for (const [id, entry] of Object.entries(extensions)) {
      const manifestName = entry && typeof entry === "object" ? entry.manifest?.name : undefined;
      if (manifestName === name || (manifestName === undefined && id.split(".").pop() === name)) ids.add(id);
    }
  }
  let dirs = [];
  try {
    dirs = readdirSync(extDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // 拡張機能を 1 つも入れていない
  }
  for (const id of dirs) if (readJsonFile(path.join(extDir, id, "manifest.json")).json?.name === name) ids.add(id);
  const found = [...ids]
    .filter((id) => !/[\\/]/.test(id) && id !== "." && id !== ".." && isDir(path.join(extDir, id)))
    .sort()
    .map((id) => ({ id, enabled: readJsonFile(path.join(userDataDir, "Claude Extensions Settings", `${id}.json`)).json?.isEnabled === true }));
  return found.find((f) => f.enabled) ?? found[0] ?? null;
}

/** Claude Desktop に登録するか（--no-claude-desktop なら登録しない。設定フォルダがあるかは置き場所ごとに見る） */
export function claudeDesktopWanted(opts) {
  return opts.claudeDesktop ? { ok: true } : { ok: false, reason: "--no-claude-desktop なので" };
}

/** IBM Bob の設定フォルダ（~/.bob）から、MCP の設定と Skill の置き場所を決める */
export function bobPaths(dir) {
  return { bobDir: dir, bobConfig: path.join(dir, "settings", "mcp.json"), bobSkillsDir: path.join(dir, "skills") };
}

/**
 * IBM Bob に登録するか。--no-bob か、設定フォルダ（~/.bob）が無い（IBM Bob を入れていない）なら登録しない。
 * 入れていない PC に ~/.bob を作らないため。
 */
export function bobWanted(opts, paths, dirExists = isDir) {
  if (!opts.bob) return { ok: false, reason: "--no-bob なので" };
  if (!dirExists(paths.bobDir)) return { ok: false, reason: `IBM Bob の設定フォルダ（${paths.bobDir}）が無いので` };
  return { ok: true };
}

/**
 * Antigravity の設定フォルダ（~/.gemini）から、MCP の設定と Skill の置き場所を決める。
 * Skill は 2.0・IDE が読む config/skills（https://antigravity.google/docs/skills）。
 * 以前の導入は skills/（Gemini CLI の置き場所で、Antigravity は読まない）に写していたので、そこは片付ける先として持つ。
 */
export function antigravityPaths(dir) {
  return {
    antigravityDir: dir,
    antigravityConfig: path.join(dir, "config", "mcp_config.json"),
    antigravitySkillsDir: path.join(dir, "config", "skills"),
    antigravityLegacySkillsDir: path.join(dir, "skills"),
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

/** Codex の設定フォルダ（~/.codex）から、MCP の設定の場所を決める */
export function codexPaths(dir) {
  return { codexDir: dir, codexConfig: path.join(dir, "config.toml") };
}

/**
 * Codex に登録するか。--no-codex か、設定フォルダ（~/.codex）が無い（Codex を入れていない）なら登録しない。
 * 入れていない PC に ~/.codex や ~/.agents/skills を作らないため。
 */
export function codexWanted(opts, paths, dirExists = isDir) {
  if (!opts.codex) return { ok: false, reason: "--no-codex なので" };
  if (!dirExists(paths.codexDir)) return { ok: false, reason: `Codex の設定フォルダ（${paths.codexDir}）が無いので` };
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
 * npm に渡す環境変数。IBM のテレメトリ（@carbon/react などが入れるときに動く @ibm/telemetry-js）を止める。
 * 客先の Maximo の環境で動かすので、依存の使い方の情報を外へ送らせない。
 */
export function npmEnv(env = process.env) {
  return { ...env, IBM_TELEMETRY_DISABLED: "true" };
}

/**
 * npm を呼ぶ。シェルを経由せずに node から npm-cli.js を直接動かす。
 * npm の標準出力はこちらの標準エラーへ回す（--json の結果に npm の出力が混ざって読めなくならないように。画面にはどちらも出る）。
 */
function runNpm(args, cwd) {
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const stdio = ["inherit", 2, "inherit"];
  const env = npmEnv();
  if (isFile(cli)) {
    const run = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8", stdio, timeout: 600_000, windowsHide: true });
    return { ok: run.status === 0 && !run.error, error: run.error ? String(run.error.message ?? run.error) : "" };
  }
  const run = spawnSync(IS_WINDOWS ? "npm.cmd" : "npm", args, { cwd, env, encoding: "utf8", stdio, shell: IS_WINDOWS, timeout: 600_000, windowsHide: true });
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
 * - 試験中（MXSTAGE_SETUP_TEST=1）: 本物を**探さない**。一時フォルダに置いた偽物が指定されたときだけ使う
 *   （偽物は、差し替えた書き先に書くように試験が作る）。
 * - ふだん: 書き先が既定の ~/.claude.json のときだけ使う（claude コマンドは既定のファイルしか書かないため）。
 *   --claude-cli / MXSTAGE_CLAUDE_CLI で場所を指定でき、無ければ PATH から探す。
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
    path.join(home, ".codex"),
    path.join(home, ".agents"),
    path.join(home, ".bob"),
    // Microsoft Store 版の Claude Desktop の設定（パッケージの中）
    path.join(localDir, "Packages"),
    mxstageHome(home),
    // 改名前（mxstudio）の置き場所と、それより前の版の置き場所（残っている PC があるので、試験ではここも拒む）
    path.join(home, ".config", LEGACY.stateDirName),
    path.join(localDir, LEGACY.stateDirName),
  ];
  const configDir = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  if (configDir !== "" && !isInside(tmpDir, configDir)) list.push(path.join(configDir, ".claude.json"));
  const codexHome = typeof env.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  if (codexHome !== "" && !isInside(tmpDir, codexHome)) list.push(codexHome);
  return list;
}

/**
 * 試験中（MXSTAGE_SETUP_TEST=1）に、本物の設定・フォルダ・橋渡し・リポジトリに触れうる指定なら、その理由を返す（問題なければ null）。
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
    ...(opts.claudeDesktop ? [["claudeDesktopConfig", "--claude-desktop-config"]] : []),
    ["startupDir", "--startup-dir"],
    ["desktopDir", "--desktop-dir"],
    ...(opts.skills ? [["claudeSkillsDir", "--claude-skills-dir"]] : []),
    ...(opts.antigravity ? [["antigravityDir", "--antigravity-dir"]] : []),
    ...(opts.codex ? [["codexDir", "--codex-dir"], ...(opts.skills ? [["agentsSkillsDir", "--agents-skills-dir"]] : [])] : []),
    ...(opts.bob ? [["bobDir", "--bob-dir"]] : []),
  ]) {
    const unless =
      {
        claudeDesktopConfig: "（Claude Desktop に登録しないなら --no-claude-desktop）",
        claudeSkillsDir: "（Skill を入れないなら --no-skills）",
        antigravityDir: "（Antigravity に登録しないなら --no-antigravity）",
        codexDir: "（Codex に登録しないなら --no-codex）",
        agentsSkillsDir: "（Codex に Skill を入れないなら --no-codex か --no-skills）",
        bobDir: "（IBM Bob に登録しないなら --no-bob）",
      }[key] ?? "";
    if (!opts[key]) problems.push(`${flag} がありません${unless}`);
    else if (!isInside(tmpDir, opts[key])) problems.push(`${flag} が一時フォルダ（${tmpDir}）の外です: ${opts[key]}`);
    else if (realLocations.some((real) => isSameOrInside(real, opts[key]))) problems.push(`${flag} が本物の書き先です: ${opts[key]}`);
  }
  // 改名前の記録の置き場所は、試験で移行を確かめるときだけ指定する（指定しなければ移行そのものをしない）。
  // Microsoft Store 版の Claude Desktop を探すフォルダも、指定したときだけ探す（--claude-desktop-config を差し替えると、指定しなければ探さない）
  for (const [key, flag] of [
    ["legacyStateDir", "--legacy-state-dir"],
    ["claudeDesktopPackagesDir", "--claude-desktop-packages-dir"],
  ]) {
    if (!opts[key]) continue;
    if (!isInside(tmpDir, opts[key])) problems.push(`${flag} が一時フォルダ（${tmpDir}）の外です: ${opts[key]}`);
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

/** /_mxstage/health の応答が MX Stage の橋渡しのものか */
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
 * state: "bridge" = MX Stage の橋渡し、"other" = 別のもの、"down" = 何も居ない（応答しない）。
 * health: /_mxstage/health の本文（今の橋渡し）。legacy: true なら /_mxstage/health に応えない古い版の橋渡し。
 */
export async function probeBridge(port, timeoutMs = PROBE_TIMEOUT_MS) {
  const base = `http://127.0.0.1:${port}`;
  // 1) /_mxstage/health（橋渡しの取り決め）
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
 * 「橋渡しが 1 つ動いている」ことを /_mxstage/health で確かめた結果を、画面の 1 行にする。
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
    return step("warn", "bridge_single", `ポート ${port} には MX Stage の橋渡しではないものが応えています。`, "そのプログラムを止めてから、もう一度実行してください。");
  }
  return step(
    expectRunning ? "warn" : "skip",
    "bridge_single",
    `ポート ${port} で橋渡しは動いていません。`,
    "最初に起動した橋渡し（ログイン時の自動起動、または Claude Code / Claude Desktop が起動したもの）がこのポートを持ち、あとから起動したものはそこへ中継します。今すぐ作業画面を使うなら、この導入をもう一度実行してください。",
  );
}

/** 橋渡し同士の認証の鍵ファイルの場所を差し替える環境変数（src/bridge/bridgeKey.ts） */
const BRIDGE_KEY_FILE_ENV = "MXSTAGE_BRIDGE_KEY_FILE";

/**
 * 試験中に起動する橋渡しへ足す環境変数。本物の橋渡しは、primary になると鍵ファイル
 * （既定は ~/.config/mxstage/bridge.key）を作るので、試験中は記録の置き場所（一時フォルダ）の中に向ける。
 * ふだん（試験中でない）と、呼び出し側が既に差し替えているときは何も足さない。
 */
export function bridgeTestEnv(paths, env = process.env) {
  if (!isTestGuard(env) || (typeof env[BRIDGE_KEY_FILE_ENV] === "string" && env[BRIDGE_KEY_FILE_ENV].trim() !== "")) return {};
  return { [BRIDGE_KEY_FILE_ENV]: path.join(paths.stateDir, "bridge.key") };
}

/**
 * ふだん（試験中でない）の導入を、MXSTAGE_BRIDGE_KEY_FILE を設定したまま実行したときの警告（無ければ null）。
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
    return { ok: false, reason: `プロセス ${pid} は ${bridgeEntry ?? "mxstage"} の橋渡しではないようです。止めませんでした。` };
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

/**
 * PNG を詰めた .ico を作る（Windows Vista 以降は PNG のままの項目を読める）。
 * デスクトップのショートカットは chrome.exe / msedge.exe を指すので、アイコンを渡さないとブラウザのアイコンになる。
 * 1 辺が 256px を超える画像は .ico に入れられないので渡さない。
 */
export function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = アイコン
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach((png, i) => {
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width > 256 || height > 256) throw new Error(`.ico に入れられない大きさです（${width}×${height}）`);
    const at = i * 16;
    dir.writeUInt8(width === 256 ? 0 : width, at);
    dir.writeUInt8(height === 256 ? 0 : height, at + 1);
    dir.writeUInt8(0, at + 2); // 色数（パレット無し）
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4); // 面の数
    dir.writeUInt16LE(32, at + 6); // 色の深さ
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...pngs]);
}

/** ショートカットに付ける MX Stage のアイコン（public/ の PNG から作る）。作れなければ null（ブラウザのアイコンのまま） */
function writeAppIcon(stateDir) {
  try {
    const pngs = ["favicon-32.png", "icon-192.png"].map((f) => readFileSync(path.join(REPO_ROOT, "public", f)));
    mkdirSync(stateDir, { recursive: true });
    const icoPath = path.join(stateDir, "mxstage.ico");
    writeFileSync(icoPath, buildIco(pngs));
    return icoPath;
  } catch {
    return null;
  }
}

/** .lnk を作る（WScript.Shell。値は環境変数で渡す） */
function createLnk({ lnkPath, target, args, workDir, description, windowStyle, icon }) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject WScript.Shell",
    "$sc = $shell.CreateShortcut($env:MXS_LNK)",
    "$sc.TargetPath = $env:MXS_TARGET",
    "$sc.Arguments = $env:MXS_ARGS",
    "$sc.WorkingDirectory = $env:MXS_WORKDIR",
    "$sc.Description = $env:MXS_DESC",
    "$sc.WindowStyle = [int]$env:MXS_STYLE",
    "if ($env:MXS_ICON) { $sc.IconLocation = \"$($env:MXS_ICON),0\" }",
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
    MXS_ICON: icon ?? "",
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
    installed: {
      claudeCode: false,
      claudeDesktop: false,
      claudeDesktopMsix: false,
      claudeDesktopExtension: null,
      antigravity: false,
      codex: false,
      bob: false,
      startup: null,
      desktopShortcut: null,
      skills: [],
      antigravitySkills: [],
      codexSkills: [],
      bobSkills: [],
    },
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

  // --- 改名前（mxstudio）からの移行（ポートを確かめる前に。改名前の橋渡しがポートを持っていると、新しい橋渡しを起動できない）---
  const legacy = await migrateLegacy(opts, paths, out, { port, bridgeEntry: found.entry, mode: "install" });
  if (legacy.blocked) return result;
  const migratedFrom = legacy.migratedFrom ?? (typeof state.migratedFrom === "string" ? state.migratedFrom : null);
  if (migratedFrom) result.migratedFrom = migratedFrom;

  const decided = await decidePort(port);
  if (decided.busy) {
    out.push(
      step(
        "error",
        "port",
        `ポート ${port} を、MX Stage の橋渡しではないプログラムが使っています。何も書き換えずに止めます。`,
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
          "Claude を終了するとこの橋渡しも終わり、ほかに橋渡しが動いていなければ作業画面はつながらなくなります。そのときは .\\mxstage.cmd をもう一度実行するか、スタートアップの mxstage-bridge.lnk を実行してください。",
        ),
      );
    } else if (owner?.ok && owner.pid > 0) {
      result.bridgePid = null;
      out.push(step("warn", "bridge_start", `ポート ${port} で動いている橋渡しは、この入口（${found.entry}）から起動したものではないようです。`, "別の場所にある MX Stage の橋渡しかもしれません。止めてから導入し直すか、--port で別の番号を指定してください。"));
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

  // --- Claude Code（Claude Desktop に拡張機能（.mcpb）の MX Stage が有効なら、--claude-code が無い限り登録しない）---
  const lastWritten = lastWrittenEntries(state);
  const codeEntry = buildCodeEntry(nodePath, found.entry, port);
  const extension = enabledDesktopExtension(opts, paths);
  const code = claudeCodeWanted(opts, state, extension);
  if (code.forced) result.claudeCodeForced = true;
  if (code.ok) {
    registerCode(opts, paths, codeEntry, found.entry, lastWritten, result, out);
    if (code.forced) {
      out.push(
        step(
          "warn",
          "claude_code_duplicate",
          `${code.reason}、Claude Desktop に拡張機能（.mcpb）の ${MCP_NAME} が有効でも Claude Code に登録しました（${extension.id}）。Claude Desktop の Code タブではツールが二重に見えます。`,
          "ターミナルの Claude Code だけで使うためです。やめるときは、--uninstall してから --claude-code を付けずに導入し直してください。",
        ),
      );
    }
  } else {
    retireEntryForExtension(
      opts,
      paths,
      { id: "claude_code", label: "Claude Code", configPath: paths.claudeCodeConfig },
      { why: claudeCodeSkipWhy(extension), okHint: CLAUDE_CODE_FORCE_HINT, duplicateHint: "Claude Desktop の Code タブではツールが二重に見えます。要らなければ claude mcp remove --scope user mxstage で外してください。" },
      found.entry,
      lastWritten,
      result,
      out,
    );
  }

  // --- Claude Desktop（入っているときだけ。ふつうの版と Microsoft Store 版。拡張機能（.mcpb）で入っていれば設定ファイルには登録しない）---
  const desktop = claudeDesktopWanted(opts);
  if (desktop.ok) installDesktop(opts, paths, buildDesktopEntry(nodePath, found.entry, port), found.entry, lastWritten, result, out);
  else out.push(step("skip", "claude_desktop", `${desktop.reason}、Claude Desktop には登録していません。`));

  // --- Antigravity（入っているときだけ）---
  const antigravity = antigravityWanted(opts, paths);
  if (antigravity.ok) registerAntigravity(opts, paths, buildAntigravityEntry(nodePath, found.entry, port), found.entry, lastWritten, result, out);
  else out.push(step("skip", "antigravity", `${antigravity.reason}、Antigravity には登録していません。`));

  // --- Codex（入っているときだけ）---
  const codex = codexWanted(opts, paths);
  if (codex.ok) registerCodex(opts, paths, nodePath, found.entry, port, lastWritten, result, out);
  else out.push(step("skip", "codex", `${codex.reason}、Codex には登録していません。`));

  // --- IBM Bob（入っているときだけ）---
  const bob = bobWanted(opts, paths);
  if (bob.ok) registerBob(opts, paths, buildDesktopEntry(nodePath, found.entry, port), found.entry, lastWritten, result, out);
  else out.push(step("skip", "bob", `${bob.reason}、IBM Bob には登録していません。`));

  // --- Skill（アプリ既定と利用者の Skill を Claude Code の ~/.claude/skills、Antigravity の ~/.gemini/config/skills、Codex の ~/.agents/skills へ）---
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
      description: "MX Stage の橋渡し（ローカル）",
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
        description: "MX Stage の作業画面",
        windowStyle: 1,
        // ブラウザを指すショートカットなので、MX Stage のアイコンを付ける（無いとブラウザのアイコンになる）
        icon: writeAppIcon(paths.stateDir),
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

  // --- 橋渡しが 1 つ動いているか（/_mxstage/health で確かめる）---
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
    return [step("ok", `${id}_prev`, "置き換えた前の MX Stage の設定は、前回この導入が書いたものなので、取り消し（--uninstall）で戻す先としては記録しません。")];
  }
  return [
    step(
      "warn",
      `${id}_prev`,
      `置き換えた前の MX Stage の設定は、指しているファイルが見つからないので（${classification.missing.join(" / ")}）、取り消し（--uninstall）で戻す先としては記録しません（値は伏せています: ${summary}）。`,
      backup ? `取り消すと MX Stage の設定は外れるだけになります。前の設定が必要なら、控えから手で戻してください: ${backup}` : "取り消すと MX Stage の設定は外れるだけになります。",
    ),
  ];
}

/** 登録の行に付ける「何を置き換えたか」 */
function replacedNote(kind) {
  if (kind === "user") return "（前の MX Stage の設定を置き換えました）";
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

  // claude コマンドを使えるときはそれで登録する（`claude mcp add --scope user mxstage -- <node> <入口> --port <番号>`）。
  // 無い・失敗した・書けていないときは、同じ内容を自分で書く。
  //
  // claude コマンドが書くのは自分の既定の設定ファイルだけで、こちらが指定したパスではない。
  // 書き先が既定のファイルでないとき（--claude-code-config で差し替えたとき）は claude コマンドを使わない。
  // これを守らないと、別のファイルを直すつもりで本物の ~/.claude.json を書き換えてしまう（実際に起きた）。
  // 試験中（MXSTAGE_SETUP_TEST=1）は本物の claude コマンドを探さず、一時フォルダの偽物だけを使う（chooseClaudeCli）。
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

/**
 * Claude Desktop（claude_desktop_config.json）に登録する。設定フォルダがある置き場所（ふつうの版の %APPDATA%\Claude と、
 * Microsoft Store 版のパッケージの中）すべてに書く。どこにも無ければ（Claude Desktop を入れていない）何も作らない。
 * その置き場所に拡張機能（.mcpb）の MX Stage が入っていて有効なら、設定ファイルには登録せず、前にこの導入が書いた登録を外す。
 */
function installDesktop(opts, paths, entry, bridgeEntry, lastWritten, result, out) {
  const locations = desktopLocations(paths);
  const present = locations.filter((l) => l.present);
  if (present.length === 0) {
    out.push(
      step(
        "skip",
        "claude_desktop",
        `Claude Desktop の設定フォルダが無いので（${locations.map((l) => path.dirname(l.configPath)).join(" / ")}）、Claude Desktop には登録していません。`,
        "Claude Desktop を入れて一度起動してから、この導入をもう一度実行すると登録します。",
      ),
    );
    return;
  }
  let wrote = false;
  for (const location of present) {
    const extension = findDesktopExtension(path.dirname(location.configPath));
    if (extension?.enabled) {
      result.installed.claudeDesktopExtension = extension.id;
      if (retireDesktopEntryForExtension(opts, paths, location, extension, bridgeEntry, lastWritten, result, out)) wrote = true;
      continue;
    }
    const hint = extension ? `拡張機能（.mcpb）の ${MCP_NAME} も入っていますが無効なので（${extension.id}）、設定ファイルに登録しました。` : undefined;
    if (registerMcpConfigFile(opts, paths, { ...location, hint }, entry, bridgeEntry, lastWritten, result, out)) wrote = true;
  }
  if (wrote) out.push(step("warn", "claude_desktop_restart", "Claude Desktop は再起動するまで新しい設定を読みません。", "タスクトレイのアイコンから終了して、開き直してください（ウィンドウを閉じるだけでは終わりません）。"));
}

/**
 * 拡張機能（.mcpb）の MX Stage が有効な Claude Desktop では、claude_desktop_config.json に登録しない（同じ MX Stage が二重に出るため）。
 * 前にこの導入が書いた mcpServers.mxstage があれば外す（retireEntryForExtension）。書き換えたときだけ true を返す。
 */
function retireDesktopEntryForExtension(opts, paths, location, extension, bridgeEntry, lastWritten, result, out) {
  return retireEntryForExtension(opts, paths, location, {
    why: `${location.label} には拡張機能（.mcpb）の ${MCP_NAME} が入っていて有効なので（${extension.id}）、設定ファイルには登録しません（二重に登録しないため）。`,
    okHint: "拡張機能を外したときは、この導入をもう一度実行すると設定ファイルに登録します。",
    duplicateHint: "同じ名前のサーバが 2 つ読み込まれます。どちらかを外してください（設定ファイルの mcpServers から消すか、Settings の「Extensions」で拡張機能を無効にする）。",
  }, bridgeEntry, lastWritten, result, out);
}

/**
 * 拡張機能（.mcpb）で入っている MX Stage と同じものが、設定ファイルにも入らないようにする（Claude Desktop のチャットと Claude Code の共通）。
 * - 設定ファイルに mcpServers.mxstage が無い: ok の行を出すだけ
 * - この導入が書いたもの（classifyPrevious が "ours"）: 控えを取ってから外す
 * - 利用者が書いたもの: 残して warn（二重になる）
 * texts: { why（理由の文）, okHint（無いときの案内）, duplicateHint（利用者の設定を残したときの案内） }。
 * 書き換えた（書き換えることになった）ときだけ true を返す。
 */
function retireEntryForExtension(opts, paths, target, texts, bridgeEntry, lastWritten, result, out) {
  const { id, label, configPath } = target;
  const { why, okHint, duplicateHint } = texts;
  const read = readJsonFile(configPath);
  if (read.error) {
    out.push(step("warn", id, `${why}設定ファイルは読めないので触っていません（${read.error}）。`));
    return false;
  }
  const current = read.json?.mcpServers?.[MCP_NAME];
  if (!current) {
    out.push(step("ok", id, why, okHint));
    return false;
  }
  if (classifyPrevious(current, { bridgeEntry, lastWritten }).kind !== "ours") {
    out.push(step("warn", id, `${why}ただし設定ファイル（${configPath}）にも、この導入が書いたものではない ${MCP_NAME} があるので残しました: ${JSON.stringify(redactEntry(current))}`, duplicateHint));
    return false;
  }
  if (opts.dryRun) {
    out.push(step("skip", id, `${why}前にこの導入が書いた ${MCP_NAME} を設定ファイルから外します（${configPath}）。--dry-run なので書いていません。`));
    return false;
  }
  let backup = null;
  try {
    backup = backupFile(configPath, paths.backupDir);
    if (backup) result.backups.push(backup);
    writeJsonFileAtomic(configPath, removeMcpServer(read.json, MCP_NAME, null).next);
  } catch (err) {
    out.push(step("error", id, `${label} の設定を書けませんでした: ${err instanceof Error ? err.message : String(err)}`, backup ? `控え: ${backup}` : undefined));
    return false;
  }
  out.push(step("ok", id, `${why}前にこの導入が書いた ${MCP_NAME} を設定ファイルから外しました（${configPath}）。`, [backup ? `書き換える前の控え: ${backup}` : null, okHint].filter(Boolean).join(" ")));
  return true;
}

/**
 * Claude Desktop のどこかに、拡張機能（.mcpb）の MX Stage が入っていて有効か（有効なもの 1 つを返す。無ければ null）。
 * --no-claude-desktop のときは Claude Desktop を見ないので null。
 */
export function enabledDesktopExtension(opts, paths, find = findDesktopExtension, dirExists = isDir) {
  if (!opts.claudeDesktop) return null;
  for (const l of desktopLocations(paths, dirExists)) {
    if (!l.present) continue;
    const found = find(path.dirname(l.configPath));
    if (found?.enabled) return { ...found, label: l.label };
  }
  return null;
}

/**
 * Claude Code（~/.claude.json）に登録するか。Claude Desktop に拡張機能（.mcpb）の MX Stage が入っていて有効なら、
 * Claude Desktop の Code タブは拡張機能から MX Stage を受け取るので、~/.claude.json にも書くとツールが二重に出る。
 * そのときは登録しない（--claude-code を付けたか、前回付けたときは登録する。ターミナルの Claude Code で使う人のため）。
 */
export function claudeCodeWanted(opts, state, extension) {
  if (!extension) return { ok: true, forced: false };
  if (opts.claudeCode) return { ok: true, forced: true, reason: "--claude-code なので" };
  if (state?.claudeCodeForced === true) return { ok: true, forced: true, reason: "前回 --claude-code を付けたので" };
  return { ok: false, forced: false };
}

/** 拡張機能が有効なので Claude Code に登録しないときの理由の文 */
function claudeCodeSkipWhy(extension) {
  return `Claude Desktop に拡張機能（.mcpb）の ${MCP_NAME} が入っていて有効なので（${extension.id}）、Claude Code の設定には登録しません（Claude Desktop の Code タブは拡張機能から MX Stage を受け取ります。両方にあるとツールが二重に出ます）。ターミナルの Claude Code では MX Stage を使えません。`;
}
const CLAUDE_CODE_FORCE_HINT = "ターミナルの Claude Code（CLI）でも使うときは、導入に --claude-code を付けて実行してください（Code タブではツールが二重に見えます）。";

/** IBM Bob（~/.bob/settings/mcp.json）に登録する */
function registerBob(opts, paths, entry, bridgeEntry, lastWritten, result, out) {
  const target = { id: "bob", label: "IBM Bob", key: "bob", configPath: paths.bobConfig, hint: "IBM Bob を再起動すると、MX Stage のツールが使えます。" };
  registerMcpConfigFile(opts, paths, target, entry, bridgeEntry, lastWritten, result, out);
}

/** Antigravity（~/.gemini/config/mcp_config.json。2.0・IDE・agy CLI が共有する）に登録する */
function registerAntigravity(opts, paths, entry, bridgeEntry, lastWritten, result, out) {
  const target = {
    id: "antigravity",
    label: "Antigravity",
    key: "antigravity",
    configPath: paths.antigravityConfig,
    hint: "2.0・IDE・agy CLI が同じ設定を読みます。新しい会話から MX Stage のツールが使えます（出てこなければ Antigravity を開き直してください）。",
  };
  registerMcpConfigFile(opts, paths, target, entry, bridgeEntry, lastWritten, result, out);
}

/**
 * Codex（~/.codex/config.toml の [mcp_servers.mxstage]。デスクトップ版・CLI・IDE 拡張が共有する）に登録する。
 * JSON の設定と同じく、読めないものには触らず、書き換える前に控えを取り、置き換えた前の設定は取り消しで戻せるように覚える。
 */
function registerCodex(opts, paths, nodePath, bridgeEntry, port, lastWritten, result, out) {
  const id = "codex";
  const configPath = paths.codexConfig;
  let text = "";
  if (existsSync(configPath)) {
    try {
      text = readFileSync(configPath, "utf8");
    } catch (err) {
      out.push(step("error", id, `${configPath} を読めないので触りません（${err instanceof Error ? err.message : String(err)}）。`));
      return false;
    }
  }
  const found = findCodexTable(text);
  if (found.otherForm) {
    out.push(
      step("warn", id, `Codex の設定（${configPath}）に、[mcp_servers.${MCP_NAME}] の表ではない書き方の ${MCP_NAME} があるので触りません。`, `表の形に書き直すか消してから、この導入をもう一度実行してください。`),
    );
    return false;
  }
  if (found.entry?.unreadable) {
    out.push(step("warn", id, `Codex の設定の [mcp_servers.${MCP_NAME}] を読めないので触りません（${configPath}）。`, "中身を直すか消してから、この導入をもう一度実行してください。"));
    return false;
  }
  const block = buildCodexBlock(nodePath, bridgeEntry, port);
  if (found.block !== null && found.block.map((l) => l.trimEnd()).join("\n") === block) {
    result.installed.codex = true;
    out.push(step("ok", id, `Codex には既に同じ設定が入っています（${configPath}）。`));
    return false;
  }
  if (opts.dryRun) {
    out.push(step("skip", id, `Codex に ${MCP_NAME} を登録します（${configPath}）。--dry-run なので書いていません。`));
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
  const previousEntry = found.entry;
  const classification = classifyPrevious(previousEntry, { bridgeEntry, lastWritten });
  result.previous = rememberPrevious(result.previous, "codex", previousEntry, backup, bridgeEntry, classification);
  try {
    writeTextFileAtomic(configPath, upsertCodexTable(text, block));
  } catch (err) {
    out.push(step("error", id, `Codex の設定を書けませんでした: ${err instanceof Error ? err.message : String(err)}`, backup ? `控え: ${backup}` : undefined));
    return false;
  }
  result.installed.codex = true;
  const hints = [backup ? `書き換える前の控え: ${backup}` : null, "デスクトップ版・CLI・IDE 拡張が同じ設定を読みます。新しい会話から MX Stage のツールが使えます（出てこなければ Codex を開き直してください）。"].filter(Boolean);
  out.push(step("ok", id, `Codex に ${MCP_NAME} を登録しました${replacedNote(classification.kind)}（${configPath}）。`, hints.join(" ")));
  out.push(...previousEntrySteps(id, previousEntry, classification, backup));
  return true;
}

/**
 * mcpServers を持つ JSON の設定ファイルに MX Stage を 1 ブロックだけ書く（Claude Desktop・Antigravity）。
 * 読めないファイルには触らず、書き換える前に控えを取り、置き換えた前の設定は取り消しで戻せるように覚える。
 * 書いた（書くことになった）ときだけ true を返す。
 */
function registerMcpConfigFile(opts, paths, target, entry, bridgeEntry, lastWritten, result, out) {
  const { id, label, key, configPath, hint } = target;
  // installedKey: setup.json の installed の名前（previous の名前 key と分けたいとき。Microsoft Store 版の Claude Desktop）
  const installedKey = target.installedKey ?? key;
  const read = readJsonFile(configPath);
  if (read.error) {
    out.push(step("error", id, `${configPath} を読めないので触りません（${read.error}）。`, "ファイルを直してから、この導入をもう一度実行してください。"));
    return false;
  }
  const merged = mergeMcpServer(read.json, MCP_NAME, entry);
  if (!merged.changed) {
    result.installed[installedKey] = true;
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
  result.installed[installedKey] = true;
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
/** 利用者の Skill の置き場所（状態フォルダ ~/.config/mxstage の下。橋渡しの src/bridge/skills.ts と同じ） */
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
 * 利用者の Skill（~/.config/mxstage/skills/<name>/SKILL.md）。
 * 既定と同じ名前、mxstage で始まる名前、frontmatter の name がフォルダ名と違うものは入れない（problems に理由を返す）。
 */
export function readUserSkills(stateDir, defaultNames) {
  const skills = [];
  const problems = [];
  for (const skill of readSkillsIn(path.join(stateDir, USER_SKILLS_DIR_NAME))) {
    if (defaultNames.has(skill.name)) problems.push(`${skill.name}（アプリ既定と同じ名前）`);
    else if (skill.name === "mxstage" || skill.name.startsWith("mxstage-")) problems.push(`${skill.name}（mxstage で始まる名前はアプリ既定の Skill 専用）`);
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
  // 写した先を記録する。橋渡しが「写しが元と揃っているか」を見るのに使う（src/bridge/freshness.ts の skillCopyProblems）
  result.skillDirs = Object.fromEntries(targets.map((t) => [t.record, t.dir]));
}

/**
 * Skill を写す先。Claude Code（~/.claude/skills）と、Antigravity に登録するなら ~/.gemini/config/skills
 * （Antigravity の 2.0・IDE が読む場所。agy CLI は別の場所を読むので、ツールの結果で届く基本手順だけになる）、
 * Codex に登録するなら ~/.agents/skills（Codex が読む個人の Skill）。
 * record は setup.json の installed の下の名前。step の id と控えの名前も先ごとに分ける。
 * legacyDir は、写した先を記録していなかった頃（setup.json に skillDirs が無い）の導入が写していた場所。
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
      legacyDir: paths.antigravityLegacySkillsDir,
      record: "antigravitySkills",
      backupPrefix: "antigravity-skill",
      readyHint: "Antigravity（2.0・IDE）は新しい会話から使えます。",
    });
  }
  if (codexWanted(opts, paths, dirExists).ok) {
    targets.push({
      id: "codex_skills",
      label: "Codex",
      dir: paths.codexSkillsDir,
      record: "codexSkills",
      backupPrefix: "codex-skill",
      readyHint: "Codex（デスクトップ・CLI・IDE 拡張）は新しい会話から使えます（~/.agents/skills はほかのエージェントも読むことがあります）。",
    });
  }
  if (bobWanted(opts, paths, dirExists).ok) {
    targets.push({
      id: "bob_skills",
      label: "IBM Bob",
      dir: paths.bobSkillsDir,
      record: "bobSkills",
      backupPrefix: "bob-skill",
      readyHint: "IBM Bob は再起動すると使えます。",
    });
  }
  return targets;
}

/** 記録（setup.json）にある、その先に入れた Skill の一覧 */
function recordedSkills(state, record) {
  const list = state?.installed?.[record];
  return Array.isArray(list) ? list.filter((sk) => sk && SKILL_NAME_PATTERN.test(sk.name)) : [];
}

/**
 * 前回の導入が、その先の Skill を実際に写した場所。記録（skillDirs）があればそれ、
 * 無ければ（記録する前の導入）legacyDir、それも無ければ今の写す先。
 */
export function previousSkillDir(state, target) {
  const recorded = state?.skillDirs?.[target.record];
  if (typeof recorded === "string" && recorded !== "") return recorded;
  return target.legacyDir ?? target.dir;
}

/**
 * 写す先が変わったとき（Antigravity の ~/.gemini/skills → ~/.gemini/config/skills など）、前の場所の写しを片付ける。
 * この導入が入れた中身のまま（記録のハッシュと一致）のものだけ消し、書き換えられたものは残して知らせる。
 */
function retireMovedSkills(target, oldDir, recordedList, out) {
  const removed = [];
  const kept = [];
  const failed = [];
  for (const sk of recordedList) {
    const dir = path.join(oldDir, sk.name);
    const file = path.join(dir, SKILL_FILE);
    const plan = planSkillRemoval(readTextIfFile(file), sk.sha256);
    if (plan === "absent") continue;
    if (plan === "keep") {
      kept.push(sk.name);
      continue;
    }
    try {
      rmSync(file, { force: true });
      if (isDir(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
      removed.push(sk.name);
    } catch (err) {
      failed.push(`${sk.name}（${err instanceof Error ? err.message : String(err)}）`);
    }
  }
  if (removed.length > 0) out.push(step("ok", `${target.id}_moved`, `${target.label} の Skill の置き場所が変わったので、前の場所の写しを消しました（${oldDir}: ${removed.join(", ")}）。`));
  if (kept.length > 0) out.push(step("warn", `${target.id}_moved`, `前の置き場所の Skill は書き換えられているので残しました（${oldDir}: ${kept.join(", ")}）。`, `${target.label} は ${target.dir} から読みます。要らなければ手で消してください。`));
  if (failed.length > 0) out.push(step("warn", `${target.id}_moved`, `前の置き場所の Skill を消せませんでした: ${failed.join(" / ")}`));
}

function copySkillsTo(target, skills, paths, state, result, out) {
  const userDir = path.join(paths.stateDir, USER_SKILLS_DIR_NAME);
  const recordedList = recordedSkills(state, target.record);
  const recorded = new Map(recordedList.map((sk) => [sk.name, sk.sha256]));
  const installed = result.installed[target.record];
  const backups = [];
  const failed = [];
  const oldDir = previousSkillDir(state, target);
  if (recordedList.length > 0 && path.resolve(oldDir) !== path.resolve(target.dir)) retireMovedSkills(target, oldDir, recordedList, out);
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
      ? [{ id: "antigravity_skills", label: "Antigravity", dir: paths.antigravitySkillsDir, legacyDir: paths.antigravityLegacySkillsDir, record: "antigravitySkills" }]
      : []),
    // Codex の分も、記録があるときだけ。--no-codex なら触らない
    ...(opts.codex && recordedSkills(state, "codexSkills").length > 0 ? [{ id: "codex_skills", label: "Codex", dir: paths.codexSkillsDir, record: "codexSkills" }] : []),
    // IBM Bob の分も、記録があるときだけ。--no-bob なら触らない
    ...(opts.bob && recordedSkills(state, "bobSkills").length > 0 ? [{ id: "bob_skills", label: "IBM Bob", dir: paths.bobSkillsDir, record: "bobSkills" }] : []),
  ];
  // 消すのは、前回の導入が実際に写した場所（写す先が変わる前の導入なら、前の場所）
  for (const t of targets) uninstallSkillsFrom({ ...t, dir: previousSkillDir(state, t) }, opts, paths, state, out);
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

/**
 * 写す元の Skill（アプリ既定と、導入が写す利用者の Skill）と、写し（dir）の中身を比べる。
 * changed: 中身が違う / missing: 写しが無い（新しく足した・save_skill で保存した Skill など）。
 * 比べ方は橋渡しの src/bridge/freshness.ts の skillCopyProblems と同じ。
 */
export function compareSkillCopies(repoRoot, stateDir, dir) {
  const defaults = readRepoSkills(repoRoot);
  const user = readUserSkills(stateDir, new Set(defaults.map((sk) => sk.name))).skills;
  const changed = [];
  const missing = [];
  const same = [];
  for (const skill of [...defaults, ...user]) {
    const copy = readTextIfFile(path.join(dir, skill.name, SKILL_FILE));
    if (copy === null) missing.push(skill.name);
    else if (normalizeSkillText(copy) !== skill.text) changed.push(skill.name);
    else same.push(skill.name);
  }
  return { changed, missing, same };
}

/** Skill の写しが今の元と揃っているか。target を省くと Claude Code の分 */
export function skillsStatusStep(paths, state, target = { id: "skills", label: "Skill", dir: paths.claudeSkillsDir, record: "skills" }) {
  const { id, label, dir, record } = target;
  const recorded = Array.isArray(state?.installed?.[record]) ? state.installed[record].map((sk) => sk.name) : [];
  if (recorded.length === 0) return step("warn", id, `${label}: この導入の記録がありません（${dir}）。`);
  const { changed, missing, same } = compareSkillCopies(paths.repoRoot, paths.stateDir, dir);
  if (changed.length > 0 || missing.length > 0) {
    const parts = [changed.length > 0 ? `中身が元と違う: ${changed.join(", ")}` : null, missing.length > 0 ? `まだ配っていない: ${missing.join(", ")}` : null].filter(Boolean);
    return step("warn", id, `${label}: 写しが今の Skill と揃っていません（${parts.join("／")}。${dir}）。`, "導入をもう一度実行すると写し直します（書き換えていた写しは、控えを取ってから置き換えます）。新しい会話から使えます。");
  }
  return step("ok", id, `${label}: ${same.join(", ")}（${dir}。元と同じ中身）`);
}

/**
 * 動いている橋渡しが、起動したあとに更新されたコードで動いていないか（health の stale）。
 * stale を載せない古い版の橋渡しなら null（何も言わない）。
 */
export function bridgeCodeStep(probe) {
  if (probe?.state !== "bridge" || typeof probe.health?.stale !== "boolean") return null;
  if (!probe.health.stale) return step("ok", "bridge_code", "動いている橋渡しは、今のリポジトリのコードで動いています。");
  return step(
    "warn",
    "bridge_code",
    "動いている橋渡しは、起動したあとにリポジトリのコードが更新されています（中継は古いコードのままです）。",
    "止めて起動し直してください。Claude が起動したものならその Claude を終了し、自動起動や導入で起動したものは docs/local.md の「今すぐ橋渡しを止める」のあと導入をもう一度実行します。",
  );
}

/** 作業画面のビルドが元より古くないか */
export function buildStatusStep(repoRoot) {
  const reason = needsBuild(repoRoot);
  if (reason === null) return step("ok", "build", "作業画面のビルドは最新です（dist/app）。");
  return step("warn", "build", `${reason}。`, "導入をもう一度実行するとビルドし直します。そのあと作業画面を再読み込みしてください。");
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
// 改名前（mxstudio）からの移行
// ---------------------------------------------------------------------------

/** パスを比べるための形（Windows は大文字と小文字を区別しない） */
function pathKey(p) {
  const resolved = path.resolve(p);
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

/** 改名前の記録の置き場所（~/.config/mxstudio）。--legacy-state-dir で差し替えられる（試験用） */
export function legacyStateDirOf(opts, home = os.homedir()) {
  return opts.legacyStateDir ? path.resolve(opts.legacyStateDir) : path.join(home, ".config", LEGACY.stateDirName);
}

/**
 * そのポートで改名前の橋渡しが動いていれば、その /_mxstudio/health の本文（name が mxstudio-bridge）を返す。
 * 動いていなければ（別のもの・何も無い）null。
 */
export async function probeLegacyBridge(port, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${LEGACY.healthPath}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) {
      await discardBody(res);
      return null;
    }
    const body = await res.json().catch(() => null);
    return body && typeof body === "object" && !Array.isArray(body) && body.name === LEGACY.bridgeName ? body : null;
  } catch {
    return null;
  }
}

/** 改名前の橋渡しの health が done（本文か null を受ける）を満たすまで待つ。満たしたときの health（null もある）を返し、時間切れなら undefined */
async function waitForLegacyBridge(port, done, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeLegacyBridge(port);
    if (done(health)) return health;
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
  return undefined;
}

/** 改名前の既定の Skill の写しを探す場所（今の導入が知っている Skill の置き場所） */
function knownSkillDirs(paths) {
  return [paths.claudeSkillsDir, paths.antigravitySkillsDir, paths.antigravityLegacySkillsDir, paths.codexSkillsDir];
}

/**
 * 改名前（mxstudio）の導入が残したもの（記録・各クライアントの登録・既定の Skill の写し・自動起動・ショートカット）を探す。
 * 何も書き換えない。見つかったものの一覧を返す（空なら片付けるものは無い）。
 */
export function findLegacyLeftovers(paths, legacyDir) {
  const found = [];
  const statePath = path.join(legacyDir, "setup.json");
  if (isFile(statePath)) found.push({ kind: "state", path: statePath });
  for (const [id, label, file] of [
    ["claude_code", "Claude Code", paths.claudeCodeConfig],
    ["claude_desktop", "Claude Desktop", paths.claudeDesktopConfig],
    ...(paths.claudeDesktopMsixConfigs ?? []).map((c) => ["claude_desktop_msix", `Claude Desktop（Microsoft Store 版・${c.packageName}）`, c.configPath]),
    ["antigravity", "Antigravity", paths.antigravityConfig],
  ]) {
    const read = readJsonFile(file);
    if (read.exists && !read.error && read.json?.mcpServers?.[LEGACY.mcpName]) found.push({ kind: "mcp", id, label, path: file });
  }
  if (isFile(paths.codexConfig)) {
    try {
      if (findCodexTable(readFileSync(paths.codexConfig, "utf8"), LEGACY.mcpName).start >= 0) found.push({ kind: "mcp", id: "codex", label: "Codex", path: paths.codexConfig });
    } catch {
      // 読めなければ見ない（Codex への登録の手順が、読めないことを知らせる）
    }
  }
  const seen = new Set();
  for (const dir of knownSkillDirs(paths)) {
    const file = path.join(dir, LEGACY.defaultSkill, SKILL_FILE);
    if (seen.has(pathKey(file))) continue;
    seen.add(pathKey(file));
    if (isFile(file)) found.push({ kind: "skill", path: file });
  }
  for (const file of [path.join(paths.startupDir, LEGACY.startupShortcut), ...LEGACY.desktopShortcuts.map((name) => path.join(paths.desktopDir, name))]) {
    if (existsSync(file)) found.push({ kind: "shortcut", path: file });
  }
  return found;
}

/** --no-claude-desktop のときは、Claude Desktop の設定に残った改名前の登録にも触らない（見ない） */
function withoutSkippedClients(opts, leftovers) {
  return opts.claudeDesktop ? leftovers : leftovers.filter((l) => !(l.kind === "mcp" && l.id.startsWith("claude_desktop")));
}

/** --status の行: 改名前（mxstudio）の導入が残したもの（無ければ null） */
export function legacyStatusStep(leftovers, bridgeRunning, port) {
  const parts = leftovers.map((l) => (l.kind === "mcp" ? `${l.label} の登録（${l.path}）` : l.path));
  if (bridgeRunning) parts.unshift(`ポート ${port} で動いている改名前の橋渡し`);
  if (parts.length === 0) return null;
  return step("warn", "legacy", `改名前（mxstudio）の導入が残したものがあります: ${parts.join(" / ")}`, "LLM のアプリをすべて終了してから導入をもう一度実行すると、片付けて MX Stage に移します（mxstage.cmd）。");
}

/** 改名前の置き場所から写すもの（利用者の Skill と公開前の検査の語の一覧）のうち、新しい置き場所にまだ無いもの */
function pendingLegacyCopies(paths, legacyDir) {
  const from = path.join(legacyDir, USER_SKILLS_DIR_NAME);
  let skills = [];
  try {
    skills = isDir(from) ? readdirSync(from).filter((name) => isDir(path.join(from, name)) && !existsSync(path.join(paths.stateDir, USER_SKILLS_DIR_NAME, name))) : [];
  } catch {
    // 読めなければ写さない（改名前の置き場所は残るので、手で写せる）
  }
  const terms = isFile(path.join(legacyDir, LEGACY.publishTerms)) && !existsSync(path.join(paths.stateDir, LEGACY.publishTerms));
  return { skills, terms };
}

/** 改名前の置き場所から写し終えた印を書く。写したあとに利用者が消したものを、次の導入や橋渡しの起動で写し直さないため */
function writeLegacyMarker(marker, legacyDir, copied) {
  try {
    writeJsonFileAtomic(marker, { from: legacyDir, copied, at: new Date().toISOString() });
  } catch {
    // 書けなくても困らない（新しい置き場所に既にあるものは写さない）
  }
}

/**
 * ポートで動いている改名前の橋渡しを止める。導入を止めるべきなら true を返す。
 * - 画面用の橋渡し（--no-mcp。改名前の導入と自動起動が起動したもの）は止める。止めたあと、Claude などが起動した
 *   改名前の橋渡しがポートを引き継いだら（本物の橋渡しで約 1.3 秒後に起きた）、導入では止まる
 * - Claude などの LLM のアプリが起動したもの（--no-mcp なし）は止めない（使っている最中のツールを切らないため）。
 *   導入では止まって LLM のアプリの終了を頼み（新しい橋渡しがポートを取れないため）、取り消しでは知らせるだけにする
 */
async function stopLegacyBridge(opts, port, entries, install, out) {
  const quitApps = "Claude Desktop・Claude Code・Codex などの LLM のアプリをすべて終了してから（Claude Desktop はタスクトレイのアイコンから終了）、もう一度実行してください。";
  if (opts.dryRun) {
    out.push(step("skip", "legacy_bridge", `ポート ${port} で改名前（mxstudio）の橋渡しが動いています。止めます（--dry-run なので止めていません）。`));
    return false;
  }
  const owner = inspectProcess({ port });
  const pid = owner.ok && owner.pid > 0 ? owner.pid : null;
  const serveEntry = pid ? [...new Set(entries.filter((e) => typeof e === "string" && e !== ""))].find((e) => isServeBridgeCommandLine(owner.commandLine, e)) : undefined;
  if (serveEntry) {
    const stopped = stopBridgeByPid(pid, serveEntry);
    // 止まった（応えなくなった）か、別のプロセスが応えるようになった（引き継いだ）まで待つ
    const tookOver = (health) => health !== null && Number.isInteger(health.pid) && health.pid !== pid;
    const after = stopped.ok ? await waitForLegacyBridge(port, (health) => health === null || tookOver(health)) : undefined;
    if (after === undefined) {
      out.push(
        step(
          install ? "error" : "warn",
          "legacy_bridge",
          `ポート ${port} の改名前の橋渡し（プロセス ${pid}）を止められませんでした（${stopped.ok ? "応答が続いています" : stopped.reason}）。${install ? "設定は何も書き換えずに止めます。" : ""}`,
          "タスクマネージャーの「詳細」タブで node.exe（コマンドラインに src\\bridge\\cli.ts と --no-mcp を含むもの）を終了してから、もう一度実行してください。",
        ),
      );
      return install;
    }
    // 止まったあとも少し見張る（Claude などが起動した改名前の橋渡しが、空いたポートを引き継ぐことがある）
    if (after !== null || (await waitForLegacyBridge(port, (health) => health !== null, TAKEOVER_WATCH_MS)) !== undefined) {
      out.push(
        step(
          install ? "error" : "warn",
          "legacy_bridge",
          `ポート ${port} の改名前の橋渡し（プロセス ${pid}）を止めましたが、LLM のアプリが起動した改名前の橋渡しがポートを引き継ぎました。${install ? "設定は何も書き換えずに止めます。" : ""}`,
          quitApps,
        ),
      );
      return install;
    }
    out.push(step("ok", "legacy_bridge", `ポート ${port} の改名前の橋渡しを止めました（プロセス ${pid}）。`));
    return false;
  }
  const who = pid ? `（プロセス ${pid}）` : "";
  if (install) {
    out.push(
      step(
        "error",
        "legacy_bridge",
        `ポート ${port} では、LLM のアプリが起動した（または手で起動した）改名前（mxstudio）の橋渡し${who}が動いています。新しい橋渡しがポートを取れないので、設定は何も書き換えずに止めます。`,
        `${quitApps}手で起動したものなら、そのウィンドウを閉じてください。`,
      ),
    );
    return true;
  }
  out.push(step("warn", "legacy_bridge", `ポート ${port} の改名前（mxstudio）の橋渡し${who}は LLM のアプリが起動したものなので、止めていません。`, "LLM のアプリを終了すると止まります（登録はこのあと外します）。"));
  return false;
}

/**
 * 改名前の導入が写した Skill を片付ける。消すのは、改名前の導入が写した中身のまま（記録のハッシュと一致）のものだけ。
 * - 既定の Skill（mxstudio-workbench）はいつも片付ける（新しい既定は mxstage-workbench）
 * - 利用者の Skill は、新しい導入が同じ場所へ同じ名前で写し直すもの（provided にある）だけ残し、ほかは片付ける
 *   （取り消し・写す先が変わった・--no-skills・元を消した。残したものは、新しい導入が写し直して記録する）
 * 記録に無い写し（記録を無くした・手で写した）は中身を確かめられないので、消さずに知らせる。
 */
function retireLegacySkills(opts, paths, legacyState, leftovers, install, provided, out) {
  const known = new Set(knownSkillDirs(paths).map(pathKey));
  const rewritten = new Set(install && opts.skills ? skillTargets(opts, paths).map((t) => pathKey(t.dir)) : []);
  const covered = new Set();
  for (const t of [
    { id: "legacy_skills", label: "Claude Code（改名前の mxstudio の分）", dir: paths.claudeSkillsDir, record: "skills" },
    { id: "legacy_antigravity_skills", label: "Antigravity（改名前の mxstudio の分）", dir: paths.antigravitySkillsDir, legacyDir: paths.antigravityLegacySkillsDir, record: "antigravitySkills" },
    { id: "legacy_codex_skills", label: "Codex（改名前の mxstudio の分）", dir: paths.codexSkillsDir, record: "codexSkills" },
  ]) {
    const recorded = recordedSkills(legacyState, t.record);
    if (recorded.length === 0) continue;
    const dir = previousSkillDir(legacyState, t);
    if (!known.has(pathKey(dir))) {
      out.push(step("warn", t.id, `改名前の導入が Skill を写した場所（${dir}）は今の置き場所と違うので、触りません。`, `要らなければ手で消してください（${recorded.map((sk) => sk.name).join(", ")}）。`));
      continue;
    }
    const rewrites = rewritten.has(pathKey(dir));
    const list = recorded.filter((sk) => !(rewrites && sk.origin === "user" && provided.has(sk.name)) && isFile(path.join(dir, sk.name, SKILL_FILE)));
    if (recorded.some((sk) => sk.name === LEGACY.defaultSkill)) covered.add(pathKey(dir));
    if (list.length > 0) uninstallSkillsFrom({ ...t, dir }, opts, paths, { installed: { [t.record]: list } }, out);
  }
  const unrecorded = leftovers.filter((l) => l.kind === "skill" && !covered.has(pathKey(path.dirname(path.dirname(l.path)))));
  if (unrecorded.length > 0) {
    out.push(
      step(
        "warn",
        "legacy_skill_copies",
        `改名前の既定の Skill の写しが残っています（改名前の導入の記録に無いので、中身を確かめられず消していません）: ${unrecorded.map((l) => path.dirname(l.path)).join(" / ")}`,
        `新しい既定の Skill（mxstage-workbench）が入るので要りません。書き換えていなければ、手で消してください。`,
      ),
    );
  }
}

/** 改名前の置き場所から、利用者の Skill と公開前の検査の語の一覧を写す（新しい置き場所に無いものだけ。写し終えたら印を書く） */
function copyLegacyFiles(paths, legacyDir, pending, marker, dry, out) {
  const names = [...pending.skills, ...(pending.terms ? [LEGACY.publishTerms] : [])];
  if (dry) {
    if (names.length > 0) out.push(step("skip", "legacy_copy", `改名前の置き場所（${legacyDir}）から新しい置き場所（${paths.stateDir}）へ写します: ${names.join(", ")}。--dry-run なので写していません。`));
    return;
  }
  const failed = [];
  for (const name of pending.skills) {
    try {
      cpSync(path.join(legacyDir, USER_SKILLS_DIR_NAME, name), path.join(paths.stateDir, USER_SKILLS_DIR_NAME, name), { recursive: true, errorOnExist: true, force: false });
    } catch (err) {
      failed.push(`${name}（${err instanceof Error ? err.message : String(err)}）`);
    }
  }
  if (pending.terms) {
    try {
      mkdirSync(paths.stateDir, { recursive: true });
      copyFileSync(path.join(legacyDir, LEGACY.publishTerms), path.join(paths.stateDir, LEGACY.publishTerms));
    } catch (err) {
      failed.push(`${LEGACY.publishTerms}（${err instanceof Error ? err.message : String(err)}）`);
    }
  }
  if (failed.length > 0) {
    out.push(step("warn", "legacy_copy", `改名前の置き場所から写せなかったものがあります: ${failed.join(" / ")}`, `手で ${legacyDir} から ${paths.stateDir} へ写してください（次の導入でも、もう一度写します）。`));
    return;
  }
  writeLegacyMarker(marker, legacyDir, names);
  if (names.length > 0) {
    out.push(step("ok", "legacy_copy", `改名前の置き場所（${legacyDir}）から新しい置き場所（${paths.stateDir}）へ写しました: ${names.join(", ")}`, "中身は書き換えていません。改名前の置き場所も残してあります。"));
  }
}

/** 改名前の自動起動とデスクトップのショートカットを消す */
function removeLegacyShortcuts(leftovers, dry, out) {
  const files = leftovers.filter((l) => l.kind === "shortcut").map((l) => l.path);
  if (files.length === 0) return;
  if (dry) {
    out.push(step("skip", "legacy_shortcut", `改名前の自動起動・ショートカットを消します（${files.join(" / ")}）。--dry-run なので消していません。`));
    return;
  }
  const failed = [];
  for (const file of files) {
    try {
      rmSync(file, { force: true });
    } catch (err) {
      failed.push(`${file}（${err instanceof Error ? err.message : String(err)}）`);
    }
  }
  const removed = files.filter((file) => !existsSync(file));
  if (removed.length > 0) out.push(step("ok", "legacy_shortcut", `改名前の自動起動・ショートカットを消しました（${removed.join(" / ")}）。`));
  if (failed.length > 0) out.push(step("warn", "legacy_shortcut", `改名前の自動起動・ショートカットを消せませんでした: ${failed.join(" / ")}`, "エクスプローラーで手で消してください。"));
}

/**
 * 改名前（mxstudio）の導入が残したものを片付けて、MX Stage（mxstage）へ移す。何度実行しても同じ結果になる。
 * 導入（mode "install"）ではポートを確かめる前に、取り消し（mode "uninstall"）では記録を消す前に呼ぶ。
 * 1) ポートの改名前の橋渡しを止める（stopLegacyBridge。LLM のアプリが起動したものなら、導入はここで止まる）
 * 2) 各クライアントの設定から、改名前の導入が書いた mxstudio の登録を外す（控えを取る。利用者が書いた登録は残して知らせる）
 * 3) 改名前の導入が写した Skill を片付ける（retireLegacySkills）
 * 4) 導入では、利用者の Skill と公開前の検査の語の一覧を新しい置き場所へ写す（1 回だけ。中身は書き換えず、改名前の置き場所は残す）
 * 5) 改名前の自動起動とデスクトップのショートカットを消す
 * 6) 改名前の記録（setup.json）を setup.migrated.json に改める（次からは片付け済みと分かる）
 * 試験中（MXSTAGE_SETUP_TEST=1）は、--legacy-state-dir を指定したときだけ行う。
 * 返す: { blocked, migratedFrom }。blocked なら導入はそこで止める。migratedFrom は改名前の記録を移した置き場所
 */
async function migrateLegacy(opts, paths, out, { port, bridgeEntry, mode }) {
  const none = { blocked: false, migratedFrom: null };
  if (isTestGuard() && !opts.legacyStateDir) return none;
  const dry = opts.dryRun;
  const install = mode === "install";
  const legacyDir = legacyStateDirOf(opts);
  const statePath = path.join(legacyDir, "setup.json");
  const legacyState = readState(statePath);
  const leftovers = withoutSkippedClients(opts, findLegacyLeftovers(paths, legacyDir));
  const legacyBridge = Number.isInteger(port) && (await probeLegacyBridge(port)) !== null;
  const marker = path.join(paths.stateDir, LEGACY.migratedMarker);
  const copying = install && isDir(legacyDir) && !existsSync(marker);
  const pending = copying ? pendingLegacyCopies(paths, legacyDir) : { skills: [], terms: false };
  if (leftovers.length === 0 && !legacyBridge && pending.skills.length === 0 && !pending.terms) {
    if (copying && !dry) writeLegacyMarker(marker, legacyDir, []);
    return none;
  }
  const first = out.length;
  out.push(step("ok", "legacy", `改名前（mxstudio）の導入が残したものを片付けて、MX Stage（mxstage）に移します（改名前の置き場所: ${legacyDir}）。`));

  // 1) ポートの改名前の橋渡し
  if (legacyBridge && (await stopLegacyBridge(opts, port, [legacyState?.bridgeEntry, bridgeEntry], install, out))) return { blocked: true, migratedFrom: null };

  // 2) 各クライアントの登録（改名前の記録にある「置き換える前の設定」は、利用者のものなら戻す）
  const legacyEntry = typeof legacyState?.bridgeEntry === "string" ? legacyState.bridgeEntry : bridgeEntry;
  const lastWritten = lastWrittenEntries(legacyState);
  const previousKey = { claude_code: "claudeCode", claude_desktop: "claudeDesktop", antigravity: "antigravity", codex: "codex" };
  for (const item of leftovers.filter((l) => l.kind === "mcp")) {
    const previous = legacyState?.previous?.[previousKey[item.id]] ?? null;
    if (item.id === "codex") unregisterCodex(opts, paths, previous, legacyEntry, lastWritten, out, LEGACY.mcpName, "legacy_codex");
    else unregister(opts, paths, item.path, previous, legacyEntry, lastWritten, `legacy_${item.id}`, item.label, out, LEGACY.mcpName);
  }

  // 3) 改名前の導入が写した Skill（新しい導入が写し直す利用者の Skill は残す）
  const provided = new Set([...readSkillsIn(path.join(paths.stateDir, USER_SKILLS_DIR_NAME)).map((sk) => sk.name), ...pending.skills]);
  retireLegacySkills(opts, paths, legacyState, leftovers, install, provided, out);

  // 4) 利用者の Skill と公開前の検査の語の一覧
  if (copying) copyLegacyFiles(paths, legacyDir, pending, marker, dry, out);

  // 5) 自動起動とショートカット
  removeLegacyShortcuts(leftovers, dry, out);

  // 6) 改名前の記録
  if (legacyState) {
    if (dry) {
      out.push(step("skip", "legacy_state", `改名前の記録を setup.migrated.json に改めます（${legacyDir}）。--dry-run なので改めていません。`));
    } else if (out.slice(first).some((s) => s.level === "error")) {
      out.push(step("warn", "legacy_state", `片付けられなかったものがあるので、改名前の記録は残しました（${statePath}）。`, "上の NG の行を直してから、もう一度実行してください。"));
    } else {
      try {
        renameSync(statePath, path.join(legacyDir, "setup.migrated.json"));
        out.push(step("ok", "legacy_state", `改名前の記録を setup.migrated.json に改めました（${legacyDir}）。`, "改名前のフォルダ（控えを含む）は残してあります。MX Stage で動くのを確かめたら、フォルダごと消してかまいません。"));
      } catch (err) {
        out.push(step("warn", "legacy_state", `改名前の記録を改められませんでした: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }
  return { blocked: false, migratedFrom: legacyState && !dry ? legacyDir : null };
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
          "Claude の中で使っている最中のツールを切らないためです。Claude Code / Claude Desktop を終了すると止まります（Claude の設定からは、このあと MX Stage を外します）。",
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
          "Claude Code / Claude Desktop が起動したものなら、Claude を終了すると止まります（Claude の設定からは、このあと MX Stage を外します）。",
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
  if (opts.claudeDesktop) {
    // ふつうの版はいつも行を出す。Microsoft Store 版は、設定ファイルがあるときだけ
    for (const l of desktopLocations(paths)) {
      if (l.id !== "claude_desktop" && !existsSync(l.configPath)) continue;
      unregister(opts, paths, l.configPath, state?.previous?.[l.key], bridgeEntry, lastWritten, l.id, l.label, out);
    }
  } else {
    out.push(step("skip", "claude_desktop", "--no-claude-desktop なので、Claude Desktop の設定には触っていません。"));
  }
  // Antigravity は入れていない PC が多いので、設定ファイルがあるか、記録に入れたとあるときだけ行を出す
  if (opts.antigravity && (state?.installed?.antigravity || existsSync(paths.antigravityConfig))) {
    unregister(opts, paths, paths.antigravityConfig, state?.previous?.antigravity, bridgeEntry, lastWritten, "antigravity", "Antigravity", out);
  }
  // Codex も同じく、設定ファイルがあるか、記録に入れたとあるときだけ
  if (opts.codex && (state?.installed?.codex || existsSync(paths.codexConfig))) {
    unregisterCodex(opts, paths, state?.previous?.codex, bridgeEntry, lastWritten, out);
  }
  // IBM Bob も同じく、設定ファイルがあるか、記録に入れたとあるときだけ
  if (opts.bob && (state?.installed?.bob || existsSync(paths.bobConfig))) {
    unregister(opts, paths, paths.bobConfig, state?.previous?.bob, bridgeEntry, lastWritten, "bob", "IBM Bob", out);
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

  // --- 改名前（mxstudio）の導入が残したもの（登録・Skill の写し・ショートカット）も外す ---
  await migrateLegacy(opts, paths, out, { port, bridgeEntry, mode: "uninstall" });

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

/** 設定から mxstage を外す（name を渡すとその名前を外す。改名前の mxstudio の片付けに使う）。置き換える前の設定があれば控えから戻す */
function unregister(opts, paths, configPath, previous, bridgeEntry, lastWritten, id, label, out, name = MCP_NAME) {
  const read = readJsonFile(configPath);
  if (!read.exists) {
    out.push(step("ok", id, `${label} の設定ファイルはありません（${configPath}）。`));
    return;
  }
  if (read.error) {
    out.push(step("warn", id, `${label} の設定を読めないので触りません（${read.error}）。`));
    return;
  }
  const current = read.json?.mcpServers?.[name];
  if (!current) {
    out.push(step("ok", id, `${label} に ${name} の設定はありません。`));
    return;
  }
  if (!isOurEntry(current, bridgeEntry)) {
    out.push(step("warn", id, `${label} の ${name} は、この導入が作ったものではないようなので残します: ${JSON.stringify(redactEntry(current))}`, "外すなら手で消してください。"));
    return;
  }
  let restore = previous ? entryFromBackup(previous.backup, name) : null;
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
    out.push(step("skip", id, `${label} から ${name} を${restore ? "前の設定に戻します" : "外します"}（${configPath}）。--dry-run なので書いていません。`));
    return;
  }
  let backup = null;
  try {
    backup = backupFile(configPath, paths.backupDir);
    writeJsonFileAtomic(configPath, removeMcpServer(read.json, name, restore).next);
  } catch (err) {
    out.push(step("error", id, `${label} の設定を書けませんでした: ${err instanceof Error ? err.message : String(err)}`, backup ? `控え: ${backup}` : undefined));
    return;
  }
  out.push(step("ok", id, `${label} から ${name} を${restore ? "外し、前の設定に戻しました" : "外しました"}（${configPath}）。`, backup ? `書き換える前の控え: ${backup}` : undefined));
  if (id === "claude_desktop" || id === "claude_desktop_msix") out.push(step("warn", "claude_desktop_restart", "Claude Desktop は再起動するまで設定の変更を読みません。"));
}

/** Codex の設定（config.toml）から mxstage の表を外す（name を渡すとその名前の表）。置き換える前の設定があれば控えから戻す */
function unregisterCodex(opts, paths, previous, bridgeEntry, lastWritten, out, name = MCP_NAME, id = "codex") {
  const configPath = paths.codexConfig;
  if (!existsSync(configPath)) {
    out.push(step("ok", id, `Codex の設定ファイルはありません（${configPath}）。`));
    return;
  }
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    out.push(step("warn", id, `Codex の設定を読めないので触りません（${err instanceof Error ? err.message : String(err)}）。`));
    return;
  }
  const found = findCodexTable(text, name);
  if (found.start < 0) {
    out.push(step("ok", id, `Codex に ${name} の設定はありません。`));
    return;
  }
  if (found.entry?.unreadable || !isOurEntry(found.entry, bridgeEntry)) {
    out.push(step("warn", id, `Codex の ${name} は、この導入が作ったものではないようなので残します: ${JSON.stringify(redactEntry(found.entry))}`, "外すなら手で消してください。"));
    return;
  }
  let restore = null;
  if (previous) {
    try {
      const saved = findCodexTable(readFileSync(previous.backup, "utf8"), name);
      if (saved.block !== null && !saved.entry?.unreadable) {
        const kind = classifyPrevious(saved.entry, { bridgeEntry, lastWritten });
        if (kind.kind === "user") restore = saved.block.join("\n");
        else out.push(step("warn", id, `Codex の控えにある前の設定は、${kind.kind === "ours" ? "この導入が書いたもの" : "指しているファイルが見つからないもの"}なので戻しません。外すだけにします。`));
      }
    } catch {
      // 控えが無い・読めない
    }
    if (restore === null) out.push(step("warn", id, `Codex の前の設定を控えから戻せませんでした（${previous.backup ?? "控え無し"}）。外すだけにします。`));
  }
  if (opts.dryRun) {
    out.push(step("skip", id, `Codex から ${name} を${restore ? "前の設定に戻します" : "外します"}（${configPath}）。--dry-run なので書いていません。`));
    return;
  }
  let backup = null;
  try {
    backup = backupFile(configPath, paths.backupDir);
    writeTextFileAtomic(configPath, removeCodexTable(text, restore, name).next);
  } catch (err) {
    out.push(step("error", id, `Codex の設定を書けませんでした: ${err instanceof Error ? err.message : String(err)}`, backup ? `控え: ${backup}` : undefined));
    return;
  }
  out.push(step("ok", id, `Codex から ${name} を${restore ? "外し、前の設定に戻しました" : "外しました"}（${configPath}）。`, backup ? `書き換える前の控え: ${backup}` : undefined));
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
  // 橋渡しが 1 つ動いているか（/_mxstage/health で確かめる）。隣のポートに残っている古い版も知らせる
  const entryForProtocol = typeof state?.bridgeEntry === "string" ? state.bridgeEntry : resolveBridgeEntry(paths.repoRoot, opts.bridge).entry;
  const probe = await probeBridge(port);
  out.push(singleBridgeStep(port, probe, true, expectedPeerProtocol(entryForProtocol)));
  const codeStep = bridgeCodeStep(probe);
  if (codeStep) out.push(codeStep);
  out.push(buildStatusStep(paths.repoRoot));
  const others = await findOtherBridges(port);
  if (others.length > 0) out.push(otherBridgesStep(others));
  // 改名前（mxstudio）の導入が残したもの（試験中は --legacy-state-dir を指定したときだけ見る）
  if (!isTestGuard() || opts.legacyStateDir) {
    const legacy = legacyStatusStep(withoutSkippedClients(opts, findLegacyLeftovers(paths, legacyStateDirOf(opts))), (await probeLegacyBridge(port)) !== null, port);
    if (legacy) out.push(legacy);
  }

  const antigravity = antigravityWanted(opts, paths);
  const bob = bobWanted(opts, paths);
  const desktop = claudeDesktopWanted(opts);
  const desktopPresent = desktop.ok ? desktopLocations(paths).filter((l) => l.present) : [];
  const codeExtension = enabledDesktopExtension(opts, paths);
  for (const { id, label, configPath, extension } of [
    { id: "claude_code", label: "Claude Code", configPath: paths.claudeCodeConfig },
    ...desktopPresent.map((l) => ({ ...l, extension: findDesktopExtension(path.dirname(l.configPath)) })),
    ...(antigravity.ok ? [{ id: "antigravity", label: "Antigravity", configPath: paths.antigravityConfig }] : []),
    ...(bob.ok ? [{ id: "bob", label: "IBM Bob", configPath: paths.bobConfig }] : []),
  ]) {
    const read = readJsonFile(configPath);
    const entry = read.exists && !read.error ? read.json?.mcpServers?.[MCP_NAME] : undefined;
    if (id === "claude_code" && codeExtension) {
      // Claude Desktop の拡張機能（.mcpb）が有効: Code タブは拡張機能から受け取るので、Claude Code には登録しないのが正しい
      if (!entry) {
        out.push(step("ok", id, `Claude Code: 登録していません（Claude Desktop に拡張機能（.mcpb）の ${MCP_NAME} が入っていて有効なので（${codeExtension.id}）。Code タブは拡張機能から MX Stage を受け取ります）。`, CLAUDE_CODE_FORCE_HINT));
      } else {
        out.push(
          step(
            "warn",
            id,
            `Claude Code: ${JSON.stringify(redactEntry(entry))}。Claude Desktop にも拡張機能（.mcpb）の ${MCP_NAME} が入っていて有効なので（${codeExtension.id}）、Claude Desktop の Code タブではツールが二重に出ます。`,
            state?.claudeCodeForced === true
              ? "--claude-code で登録したもの（ターミナルの Claude Code 用）なら、このままでかまいません。"
              : "この導入が書いたものなら、導入をもう一度実行すると外します。手で書いたものなら claude mcp remove --scope user mxstage で外してください（ターミナルの Claude Code でも使うなら --claude-code）。",
          ),
        );
      }
      continue;
    }
    if (extension?.enabled) {
      // 拡張機能（.mcpb）で入っている。設定ファイルにも mxstage があれば二重になる
      if (entry) {
        out.push(
          step(
            "warn",
            id,
            `${label}: 拡張機能（.mcpb）の ${MCP_NAME} が有効で（${extension.id}）、設定ファイルにも ${MCP_NAME} があります（二重に登録されています）: ${JSON.stringify(redactEntry(entry))}`,
            "導入をもう一度実行すると、この導入が書いた分は設定ファイルから外します。手で書いたものなら、設定ファイルから消すか拡張機能を無効にしてください。",
          ),
        );
      } else {
        out.push(step("ok", id, `${label}: 拡張機能（.mcpb）の ${MCP_NAME} が入っていて有効です（${extension.id}。設定ファイルには登録していません）。`));
      }
      continue;
    }
    const disabled = extension ? `（拡張機能（.mcpb）の ${MCP_NAME} は入っていますが無効です: ${extension.id}）` : "";
    if (!read.exists) out.push(step("warn", id, `${label} の設定ファイルがありません（${configPath}）。${disabled}`));
    else if (read.error) out.push(step("warn", id, `${label} の設定を読めません（${read.error}）。`));
    else if (entry) out.push(step("ok", id, `${label}: ${JSON.stringify(redactEntry(entry))}${disabled}`));
    else out.push(step("warn", id, `${label} に ${MCP_NAME} の設定はありません。${disabled}`));
  }
  if (!desktop.ok) out.push(step("skip", "claude_desktop", `${desktop.reason}、Claude Desktop は見ていません。`));
  else if (desktopPresent.length === 0) out.push(step("skip", "claude_desktop", `Claude Desktop の設定フォルダが無いので（${path.dirname(paths.claudeDesktopConfig)}）、Claude Desktop は見ていません。`));
  if (!antigravity.ok) out.push(step("skip", "antigravity", `${antigravity.reason}、Antigravity は見ていません。`));
  if (!bob.ok) out.push(step("skip", "bob", `${bob.reason}、IBM Bob は見ていません。`));
  const codex = codexWanted(opts, paths);
  if (!codex.ok) out.push(step("skip", "codex", `${codex.reason}、Codex は見ていません。`));
  else if (!existsSync(paths.codexConfig)) out.push(step("warn", "codex", `Codex の設定ファイルがありません（${paths.codexConfig}）。`));
  else {
    let found = null;
    try {
      found = findCodexTable(readFileSync(paths.codexConfig, "utf8"));
    } catch (err) {
      out.push(step("warn", "codex", `Codex の設定を読めません（${err instanceof Error ? err.message : String(err)}）。`));
    }
    if (found?.block) out.push(step("ok", "codex", `Codex: ${JSON.stringify(redactEntry(found.entry))}`));
    else if (found) out.push(step("warn", "codex", `Codex に ${MCP_NAME} の設定はありません。`));
  }
  out.push(skillsStatusStep(paths, state));
  if (antigravity.ok) {
    out.push(skillsStatusStep(paths, state, { id: "antigravity_skills", label: "Antigravity の Skill", dir: paths.antigravitySkillsDir, record: "antigravitySkills" }));
  }
  if (codex.ok) out.push(skillsStatusStep(paths, state, { id: "codex_skills", label: "Codex の Skill", dir: paths.codexSkillsDir, record: "codexSkills" }));
  if (bob.ok) out.push(skillsStatusStep(paths, state, { id: "bob_skills", label: "IBM Bob の Skill", dir: paths.bobSkillsDir, record: "bobSkills" }));
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
  const title = mode === "uninstall" ? "MX Stage の取り消し" : mode === "status" ? "MX Stage の状態" : "MX Stage をこの PC に入れる";
  const lines = [title, ""];
  for (const s of steps) {
    lines.push(`[${LABEL[s.level]}] ${s.message}`);
    if (s.hint) lines.push(`         → ${s.hint}`);
  }
  const errors = steps.filter((s) => s.level === "error").length;
  const warns = steps.filter((s) => s.level === "warn").length;
  const undo = IS_WINDOWS ? `"${path.join(paths.repoRoot, "mxstage.cmd")}" --uninstall` : `node "${path.join(paths.repoRoot, "scripts", "setup-local.mjs")}" --uninstall`;
  lines.push("");
  if (dryRun && mode !== "status") {
    lines.push(`--dry-run なので、何も書き換えていません（上は実際に行う手順です。警告 ${warns} 件・NG ${errors} 件）。`);
  } else if (mode === "install") {
    if (errors === 0) {
      lines.push(warns === 0 ? "導入できました。" : `導入できました（警告 ${warns} 件。上の [警告] の行を読んでください）。`);
      if (result.appUrl) lines.push(`  作業画面: ${result.appUrl}${result.installed?.desktopShortcut ? "（デスクトップのショートカットからも開けます）" : ""}`);
      if (result.port) lines.push(`  橋渡し: ポート ${result.port} の 1 つだけ（作業画面と Claude Code / Claude Desktop / Antigravity / Codex / IBM Bob で共有します）`);
      if (result.installed?.claudeCode) lines.push("  Claude Code: 起動し直すと MX Stage のツールが使えます。");
      else if (result.installed?.claudeDesktopExtension) lines.push("  Claude Code: 登録していません（Claude Desktop の Code タブは拡張機能から MX Stage を受け取ります。ターミナルでも使うなら --claude-code）。");
      if (result.installed?.claudeDesktop || result.installed?.claudeDesktopMsix) lines.push("  Claude Desktop: いったん終了して開き直してください（再起動するまで設定を読みません）。");
      else if (result.installed?.claudeDesktopExtension) lines.push("  Claude Desktop: 拡張機能（.mcpb）の MX Stage を使います（設定ファイルには登録していません）。");
      if (result.installed?.antigravity) lines.push("  Antigravity: 新しい会話から MX Stage のツールが使えます（2.0・IDE・agy CLI 共通。出てこなければ開き直してください）。");
      if (result.installed?.codex) lines.push("  Codex: 新しい会話から MX Stage のツールが使えます（デスクトップ・CLI・IDE 拡張共通。出てこなければ開き直してください）。");
      if (result.installed?.bob) lines.push("  IBM Bob: 再起動すると MX Stage のツールが使えます。");
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
  // 改名前の名前（MXSTUDIO_CLAUDE_CLI）も、新しい名前が無いときだけ読む
  if (!opts.claudeCli && process.env[CLAUDE_CLI_ENV]) opts.claudeCli = process.env[CLAUDE_CLI_ENV];
  else if (!opts.claudeCli && process.env[LEGACY.claudeCliEnv]) opts.claudeCli = process.env[LEGACY.claudeCliEnv];
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
