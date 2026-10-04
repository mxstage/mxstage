// scripts/setup-local.mjs の試験。Node 標準の node:test で動かす。
//
//   npm run test:setup
//
// 実在の設定ファイル（~/.claude.json・Claude Desktop（Microsoft Store 版を含む）・Antigravity（~/.gemini）・Codex・IBM Bob（~/.bob）・スタートアップ・デスクトップ・~/.config/mxstage）には一切触らない。
// - 書き先はすべて一時フォルダに差し替える。
// - MXSTAGE_SETUP_TEST=1 を立てる。setup-local.mjs はこの印があると、書き先が一時フォルダでない・--port / --bridge /
//   --no-open が無いときは何もせずに止まり、本物の claude コマンドを**探しもしない**。
// - claude コマンドを試すときは、一時フォルダに置いた偽物（呼ばれた引数を記録し、差し替えた書き先に書く）を使う。
// - 最後の試験で、本物の設定ファイルとフォルダの更新時刻が、この試験の前後で変わっていないことを確かめる。
// 橋渡しの代わりに、/_mxstage/health と /ws だけを返す小さなサーバを使う。
// ポートは OS に割り当てさせる（利用者が 8788 で動かしている橋渡しに触れないため）。
// vitest の projects（tests/worker・tests/app・tests/bridge）には含まれないので、npx vitest run では動かない。

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  antigravityPaths,
  antigravityWanted,
  bobPaths,
  bobWanted,
  desktopLocations,
  findDesktopExtension,
  msixDesktopConfigs,
  buildCodexBlock,
  codexPaths,
  codexWanted,
  findCodexTable,
  findLegacyLeftovers,
  legacyStateDirOf,
  legacyStatusStep,
  removeCodexTable,
  tomlTableKey,
  tomlValue,
  upsertCodexTable,
  bridgeArgs,
  bridgeCodeStep,
  bridgeTestEnv,
  buildStatusStep,
  buildAntigravityEntry,
  buildCodeEntry,
  buildDesktopEntry,
  buildInternetShortcut,
  canUseClaudeCli,
  chooseClaudeCli,
  classifyPrevious,
  decidePort,
  entryFromBackup,
  expectedPeerProtocol,
  findBrowser,
  findOnPath,
  isBridgeCommandLine,
  isBridgeHealth,
  isInside,
  isOurEntry,
  isSameEntry,
  isServeBridgeCommandLine,
  isSetupShapedEntry,
  keyFileEnvStep,
  lastWrittenEntries,
  main,
  mergeMcpServer,
  missingTargets,
  nodeFlagsFor,
  parseArgs,
  planSkillInstall,
  planSkillRemoval,
  previousEntrySteps,
  probeBridge,
  quoteArgs,
  quoteForCmd,
  readJsonFile,
  readRepoSkills,
  realWriteLocations,
  redactArgs,
  redactEntry,
  redactUrl,
  rememberPrevious,
  removeMcpServer,
  resolveBridgeEntry,
  runPowerShell,
  singleBridgeStep,
  skillTargets,
  testSandboxProblem,
} from "../../scripts/setup-local.mjs";
import { buildIco, needsBuild, needsInstall, nodeVersionOk, npmEnv } from "../../scripts/setup-local.mjs";

// 試験中の印（setup-local.mjs の main() が見る）
process.env.MXSTAGE_SETUP_TEST = "1";

const IS_WINDOWS = process.platform === "win32";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SETUP_SCRIPT = path.join(REPO_ROOT, "scripts", "setup-local.mjs");

// ---------------------------------------------------------------------------
// 本物の設定ファイルとフォルダ（試験の最初に更新時刻を控え、最後の試験で比べる）
// ---------------------------------------------------------------------------

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 本物の書き先。owner は、試験とは関係なくそこを書き換えうるプログラム */
function realTargets() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const shell = { desktop: null, startup: null };
  if (IS_WINDOWS) {
    // Windows に聞く（読むだけ）。デスクトップが OneDrive に移されていることがあるため
    const ran = runPowerShell("@{ desktop = [Environment]::GetFolderPath('Desktop'); startup = [Environment]::GetFolderPath('Startup') } | ConvertTo-Json -Compress");
    try {
      const lines = ran.stdout.split(/\r?\n/).filter((l) => l.trim());
      Object.assign(shell, JSON.parse(lines[lines.length - 1] ?? "{}"));
    } catch {
      // 聞けなくても、決まった場所は見る
    }
  }
  const targets = [
    { path: path.join(home, ".claude.json"), type: "json", owner: "Claude Code" },
    process.env.CLAUDE_CONFIG_DIR ? { path: path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"), type: "json", owner: "Claude Code" } : null,
    { path: path.join(appData, "Claude", "claude_desktop_config.json"), type: "json", owner: "Claude Desktop" },
    { path: path.join(home, ".claude"), type: "dir", owner: "Claude Code" },
    { path: path.join(appData, "Claude"), type: "dir", owner: "Claude Desktop" },
    { path: path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup"), type: "dir", owner: "Windows" },
    shell.startup ? { path: shell.startup, type: "dir", owner: "Windows" } : null,
    { path: path.join(home, "Desktop"), type: "dir", owner: "Windows / OneDrive" },
    { path: path.join(home, "OneDrive", "Desktop"), type: "dir", owner: "Windows / OneDrive" },
    shell.desktop ? { path: shell.desktop, type: "dir", owner: "Windows / OneDrive" } : null,
    { path: path.join(home, ".gemini", "config", "mcp_config.json"), type: "json", owner: "Antigravity" },
    { path: path.join(home, ".gemini", "config", "skills"), type: "dir", owner: "Antigravity" },
    // 以前の導入が Skill を写していた場所（Gemini CLI の置き場所）
    { path: path.join(home, ".gemini", "skills"), type: "dir", owner: "Gemini CLI" },
    { path: path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "config.toml"), type: "toml", owner: "Codex" },
    { path: path.join(home, ".agents", "skills"), type: "dir", owner: "Codex などのエージェント" },
    { path: path.join(home, ".bob", "settings", "mcp.json"), type: "json", owner: "IBM Bob" },
    { path: path.join(home, ".bob", "skills"), type: "dir", owner: "IBM Bob" },
    // Microsoft Store 版の Claude Desktop（パッケージの中の設定。あるものだけ）
    ...msixDesktopConfigs(path.join(localAppData, "Packages")).map((c) => ({ path: c.configPath, type: "json", owner: "Claude Desktop（Microsoft Store 版）" })),
    // ほかに書くプログラムが無い場所。更新時刻が変わったらそれだけで失敗にする
    { path: path.join(home, ".config", "mxstage"), type: "strict", owner: null },
    // 導入の記録と控え。控えのフォルダが既にあると、中に控えが増えても親フォルダの更新時刻は変わらないので、別に見る
    { path: path.join(home, ".config", "mxstage", "setup.json"), type: "strict", owner: null },
    { path: path.join(home, ".config", "mxstage", "backup"), type: "strict", owner: null },
    // 本物の橋渡しが作る鍵。試験中に起動する橋渡しは一時フォルダの鍵を使うので、ここは変わらないはず
    { path: path.join(home, ".config", "mxstage", "bridge.key"), type: "strict", owner: null },
    // 改名前（mxstudio）の置き場所。移行は、試験では --legacy-state-dir の一時フォルダにしか触れないはず
    // （フォルダそのものは改名前の橋渡しがログを書くことがあるので、更新時刻が変わっても名前の増減だけを見る）
    { path: path.join(home, ".config", "mxstudio"), type: "dir", owner: "改名前の mxstudio の橋渡し（ログ）" },
    { path: path.join(home, ".config", "mxstudio", "setup.json"), type: "strict", owner: null },
    { path: path.join(home, ".config", "mxstudio", "skills"), type: "dir", owner: "改名前の mxstudio の橋渡し（save_skill）" },
    { path: path.join(home, ".config", "mxstudio", "publish-terms.txt"), type: "strict", owner: null },
    // それより前の版の置き場所（%LOCALAPPDATA%\mxstudio）。残っている PC があるので、ここも見る
    { path: path.join(localAppData, "mxstudio"), type: "strict", owner: null },
    { path: path.join(localAppData, "mxstudio", "setup.json"), type: "strict", owner: null },
    { path: path.join(localAppData, "mxstudio", "backup"), type: "strict", owner: null },
    { path: path.join(localAppData, "mxstudio", "bridge.key"), type: "strict", owner: null },
  ].filter(Boolean);
  const seen = new Set();
  return targets.filter((t) => {
    const key = path.resolve(t.path).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Codex の config.toml の [mcp_servers.mxstage] と、改名前の [mcp_servers.mxstudio] の表（読むだけ） */
function codexTableOf(file) {
  try {
    const text = readFileSync(file, "utf8");
    return JSON.stringify([findCodexTable(text).block, findCodexTable(text, "mxstudio").block]);
  } catch (err) {
    return err && err.code === "ENOENT" ? "(無い)" : "(読めない)";
  }
}

/** mcpServers.mxstage \u3068\u3001\u6539\u540D\u524D\u306E mcpServers.mxstudio \u3060\u3051\u3092\u8AAD\u3080\uFF08\u4E2D\u8EAB\u306F\u753B\u9762\u306B\u51FA\u3055\u305A\u3001\u6BD4\u3079\u308B\u3060\u3051\uFF09 */
function mxstageEntryOf(file) {
  for (let i = 0; i < 10; i++) {
    try {
      const json = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      return JSON.stringify([json?.mcpServers?.mxstage ?? null, json?.mcpServers?.mxstudio ?? null]);
    } catch (err) {
      if (err && err.code === "ENOENT") return "(無い)";
      sleepSync(50); // 持ち主のプログラムが書いている途中かもしれない
    }
  }
  return "(読めない)";
}

function snapshotReal(targets) {
  return targets.map((t) => {
    let st = null;
    try {
      st = statSync(t.path);
    } catch {
      // 無い
    }
    const snap = { ...t, exists: Boolean(st), mtimeMs: st ? st.mtimeMs : null };
    if (st && t.type === "json") {
      snap.entry = mxstageEntryOf(t.path);
      snap.tmp = existsSync(`${t.path}.mxstage.tmp`);
    }
    if (st && t.type === "toml") {
      snap.entry = codexTableOf(t.path);
      snap.tmp = existsSync(`${t.path}.mxstage.tmp`);
    }
    if (st && st.isDirectory()) {
      try {
        snap.names = readdirSync(t.path).filter((n) => /mxstage|mxstudio/i.test(n)).sort();
      } catch {
        snap.names = null;
      }
    }
    return snap;
  });
}

const REAL_TARGETS = realTargets();
const REAL_BEFORE = snapshotReal(REAL_TARGETS);

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

test("parseArgs: 既定は導入モードで、すべての手順を行う", () => {
  const opts = parseArgs([]);
  assert.equal(opts.mode, "install");
  assert.equal(opts.dryRun, false);
  assert.equal(opts.autostart, true);
  assert.equal(opts.open, true);
  assert.equal(opts.port, null);
  assert.equal(opts.claudeCli, null);
});

test("parseArgs: --uninstall と --status と --no-* が効く", () => {
  assert.equal(parseArgs(["--uninstall"]).mode, "uninstall");
  assert.equal(parseArgs(["--status"]).mode, "status");
  const opts = parseArgs(["--no-autostart", "--no-open", "--no-shortcut", "--dry-run", "--no-skills", "--claude-skills-dir", "x"]);
  assert.equal(opts.autostart, false);
  assert.equal(opts.open, false);
  assert.equal(opts.shortcut, false);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.skills, false);
  assert.equal(opts.claudeSkillsDir, "x");
  assert.equal(parseArgs([]).skills, true);
});

test("planSkillInstall / planSkillRemoval: 入れたままなら上書き・削除し、利用者が書き換えたものは控えを取るか残す", () => {
  const text = "---\nname: a\n---\n本文\n";
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  assert.equal(planSkillInstall(text, null, undefined), "install");
  assert.equal(planSkillInstall(text, text.replace(/\n/g, "\r\n"), undefined), "same", "改行の違いは同じ中身");
  assert.equal(planSkillInstall("---\nname: a\n---\n新しい本文\n", text, hash), "update", "前回入れた中身のままなら上書きしてよい");
  assert.equal(planSkillInstall("---\nname: a\n---\n新しい本文\n", `${text}メモ\n`, hash), "backup", "書き換えられていたら控えを取る");
  assert.equal(planSkillInstall(text, "別の Skill", undefined), "backup", "記録が無い同じ名前の別物も控えを取る");
  assert.equal(planSkillRemoval(null, hash), "absent");
  assert.equal(planSkillRemoval(text, hash), "remove");
  assert.equal(planSkillRemoval(`${text}メモ\n`, hash), "keep");
  assert.equal(planSkillRemoval(text, undefined), "keep", "記録が無ければ消さない");
});

test("導入で書き換えられていた Skill は、控えを取ってから置き換える", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-setup-skills-"));
  let port = null;
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    port = await freePort();
    const common = [...sandboxArgs(dir), "--no-autostart", "--no-shortcut", "--no-start", "--port", String(port), "--bridge", bridge];
    const skillsDir = path.join(dir, "claude-skills");
    const repoSkills = readRepoSkills(path.resolve(import.meta.dirname, "..", ".."));
    const target = path.join(skillsDir, repoSkills[0].name, "SKILL.md");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "利用者が自分で置いた同じ名前の Skill\n", "utf8");

    const run = await runJson(common);
    const backup = stepOf(run.json, "skills_backup");
    assert.equal(backup.length, 1, run.stdout);
    assert.equal(readFileSync(target, "utf8"), repoSkills[0].text, "置き換えた");
    const state = JSON.parse(readFileSync(path.join(dir, "state", "setup.json"), "utf8"));
    const saved = state.backups.find((b) => b.includes(`skill-${repoSkills[0].name}`));
    assert.ok(saved && isInside(dir, saved), "控えは記録の置き場所（一時フォルダ）の中");
    assert.equal(readFileSync(path.join(saved, "SKILL.md"), "utf8"), "利用者が自分で置いた同じ名前の Skill\n");
  } finally {
    if (port !== null) await stopFakeBridgeOn(port);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--no-skills なら Skill の置き場所を指定しなくても試験の囲いを通り、Skill を書かない", () => {
  const dir = path.join(os.tmpdir(), "mxs-noskills");
  const base = ["--no-open", "--no-install", "--no-build", "--port", "19002", "--bridge", "b.mjs"];
  const withoutSkillsDir = sandboxArgs(dir).filter((a, i, all) => a !== "--claude-skills-dir" && all[i - 1] !== "--claude-skills-dir");
  assert.match(testSandboxProblem(parseArgs([...withoutSkillsDir, ...base])) ?? "", /--claude-skills-dir がありません（Skill を入れないなら --no-skills）/);
  assert.equal(testSandboxProblem(parseArgs([...withoutSkillsDir, ...base, "--no-skills"])), null);
});

test("--no-antigravity なら Antigravity の設定フォルダを指定しなくても試験の囲いを通る", () => {
  const dir = path.join(os.tmpdir(), "mxs-noantigravity");
  const base = ["--no-open", "--no-install", "--no-build", "--port", "19002", "--bridge", "b.mjs"];
  const without = sandboxArgs(dir).filter((a, i, all) => a !== "--antigravity-dir" && all[i - 1] !== "--antigravity-dir");
  assert.match(testSandboxProblem(parseArgs([...without, ...base])) ?? "", /--antigravity-dir がありません（Antigravity に登録しないなら --no-antigravity）/);
  assert.equal(testSandboxProblem(parseArgs([...without, ...base, "--no-antigravity"])), null);
  const outside = parseArgs([...without, ...base, "--antigravity-dir", path.join(os.homedir(), ".gemini")]);
  assert.match(testSandboxProblem(outside) ?? "", /--antigravity-dir が/);
});

test("antigravityPaths / antigravityWanted / skillTargets: ~/.gemini があるときだけ Antigravity に登録し、Skill も写す", () => {
  const dir = path.join(os.tmpdir(), "mxs-ag-paths", ".gemini");
  const ag = antigravityPaths(dir);
  assert.equal(ag.antigravityConfig, path.join(dir, "config", "mcp_config.json"));
  // Skill は 2.0・IDE が読む config/skills。skills/ は Gemini CLI の置き場所で、以前の導入が写していた（片付ける先）
  assert.equal(ag.antigravitySkillsDir, path.join(dir, "config", "skills"));
  assert.equal(ag.antigravityLegacySkillsDir, path.join(dir, "skills"));
  const paths = { ...ag, claudeSkillsDir: path.join(dir, "..", "claude-skills") };
  const on = parseArgs([]);
  assert.equal(antigravityWanted(on, paths, () => true).ok, true);
  assert.match(antigravityWanted(on, paths, () => false).reason, /設定フォルダ.*が無い/);
  assert.match(antigravityWanted(parseArgs(["--no-antigravity"]), paths, () => true).reason, /--no-antigravity/);
  // Codex と IBM Bob の分は別の試験で見る（ここでは Antigravity の分だけ）
  const noCodex = parseArgs(["--no-codex", "--no-bob"]);
  assert.deepEqual(skillTargets(noCodex, paths, () => true).map((t) => [t.id, t.dir]), [
    ["skills", paths.claudeSkillsDir],
    ["antigravity_skills", ag.antigravitySkillsDir],
  ]);
  assert.deepEqual(skillTargets(on, paths, () => false).map((t) => t.id), ["skills"]);
  // Antigravity の mcp_config.json には type を書かない（stdio は command / args）
  assert.deepEqual(buildAntigravityEntry("C:\\node.exe", "C:\\r\\src\\bridge\\cli.mjs", 8788), { command: "C:\\node.exe", args: ["C:\\r\\src\\bridge\\cli.mjs", "--port", "8788"] });
});

test("bridgeCodeStep / buildStatusStep: 動いている橋渡しの古さ（health の stale）と、作業画面のビルドの古さを出す", () => {
  assert.equal(bridgeCodeStep({ state: "down", health: null }), null);
  assert.equal(bridgeCodeStep({ state: "bridge", health: { name: "mxstage-bridge", version: "0.1.0", protocol: 1 } }), null, "stale を載せない古い版には何も言わない");
  assert.equal(bridgeCodeStep({ state: "bridge", health: { name: "mxstage-bridge", version: "0.1.0", protocol: 1, stale: false } }).level, "ok");
  const stale = bridgeCodeStep({ state: "bridge", health: { name: "mxstage-bridge", version: "0.1.0", protocol: 1, stale: true } });
  assert.equal(stale.level, "warn");
  assert.match(stale.hint, /起動し直して/);

  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-buildstatus-"));
  try {
    assert.equal(buildStatusStep(dir).level, "warn", "ビルドが無い");
    mkdirSync(path.join(dir, "dist", "app"), { recursive: true });
    writeFileSync(path.join(dir, "dist", "app", "index.html"), "<html>", "utf8");
    assert.equal(buildStatusStep(dir).level, "ok");
    mkdirSync(path.join(dir, "src", "app"), { recursive: true });
    const later = new Date(Date.now() + 60_000);
    writeFileSync(path.join(dir, "src", "app", "main.tsx"), "x", "utf8");
    utimesSync(path.join(dir, "src", "app", "main.tsx"), later, later);
    const s = buildStatusStep(dir);
    assert.equal(s.level, "warn");
    assert.match(s.message, /src\/app/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Antigravity: 入っていれば登録し Skill も写す（ほかのサーバは残す）。取り消しで外して Skill も消す。入っていなければ触らない", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-antigravity-"));
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    const port = await freePort();
    const common = [...sandboxArgs(dir), "--no-start", "--no-autostart", "--no-shortcut", "--port", String(port), "--bridge", bridge];
    const geminiDir = path.join(dir, "gemini");
    const agConfig = path.join(geminiDir, "config", "mcp_config.json");
    const agSkills = path.join(geminiDir, "config", "skills");
    const repoSkills = readRepoSkills(path.resolve(import.meta.dirname, "..", ".."));

    // --- Antigravity が入っていない（~/.gemini が無い）: 何も作らない ---
    const absent = await runJson(common);
    assert.equal(absent.code, 0, absent.stdout);
    assert.equal(stepOf(absent.json, "antigravity")[0].level, "skip");
    assert.equal(existsSync(geminiDir), false, "入れていない PC に ~/.gemini を作らない");
    assert.equal(stepOf(absent.json, "antigravity_skills").length, 0);

    // --- 入っている: ほかのサーバ（利用者の設定）を残して 1 ブロックだけ足す ---
    const other = { command: "npx", args: ["chrome-devtools-mcp@latest"] };
    mkdirSync(path.dirname(agConfig), { recursive: true });
    writeFileSync(agConfig, JSON.stringify({ mcpServers: { "chrome-devtools-mcp": other } }, null, 2), "utf8");
    mkdirSync(path.join(agSkills, "cloudflare"), { recursive: true });
    writeFileSync(path.join(agSkills, "cloudflare", "SKILL.md"), "---\nname: cloudflare\n---\n利用者の Skill\n", "utf8");

    const first = await runJson(common);
    assert.equal(first.code, 0, first.stdout);
    const written = JSON.parse(readFileSync(agConfig, "utf8"));
    assert.deepEqual(written.mcpServers["chrome-devtools-mcp"], other, "ほかの MCP サーバを消していない");
    assert.deepEqual(written.mcpServers.mxstage, { command: process.execPath, args: [bridge, "--port", String(port)] });
    assert.equal(stepOf(first.json, "antigravity")[0].level, "ok");
    assert.ok(first.json.result.installed.antigravity);
    for (const skill of repoSkills) {
      assert.equal(readFileSync(path.join(agSkills, skill.name, "SKILL.md"), "utf8"), skill.text, `${skill.name} を Antigravity にも入れた`);
    }
    assert.equal(stepOf(first.json, "antigravity_skills")[0].level, "ok");
    const state = JSON.parse(readFileSync(path.join(dir, "state", "setup.json"), "utf8"));
    assert.deepEqual(state.installed.antigravitySkills.map((sk) => sk.name), repoSkills.map((sk) => sk.name));
    assert.equal(state.previous.antigravity, null, "前に MX Stage は無かったので戻す先は無い");

    // 写した先を記録する（橋渡しが写しの古さを見るのに使う）
    assert.deepEqual(state.skillDirs, { skills: path.join(dir, "claude-skills"), antigravitySkills: agSkills });

    // --- 状態を見る ---
    const status = await runJson([...common, "--status"]);
    assert.equal(stepOf(status.json, "antigravity")[0].level, "ok");
    assert.equal(stepOf(status.json, "antigravity_skills")[0].level, "ok");
    assert.match(stepOf(status.json, "antigravity_skills")[0].message, /元と同じ中身/);

    // 写しが古い・まだ配っていない Skill があれば、中身を比べて名前を出す
    const copy = path.join(agSkills, repoSkills[0].name, "SKILL.md");
    writeFileSync(copy, `${repoSkills[0].text}\n古い写し\n`, "utf8");
    mkdirSync(path.join(dir, "state", "skills", "new-flow"), { recursive: true });
    writeFileSync(path.join(dir, "state", "skills", "new-flow", "SKILL.md"), "---\nname: new-flow\ndescription: \"新しい手順\"\n---\n\n# 新しい手順\n", "utf8");
    const stale = await runJson([...common, "--status"]);
    for (const id of ["skills", "antigravity_skills"]) {
      const s = stepOf(stale.json, id)[0];
      assert.equal(s.level, "warn", id);
      assert.match(s.message, /まだ配っていない: new-flow/, id);
      assert.match(s.hint, /導入をもう一度実行/, id);
    }
    assert.match(stepOf(stale.json, "antigravity_skills")[0].message, new RegExp(`中身が元と違う: ${repoSkills[0].name}`));
    assert.doesNotMatch(stepOf(stale.json, "skills")[0].message, /中身が元と違う/);
    // 導入し直せば揃う
    assert.equal(await quietMain(common), 0);
    for (const id of ["skills", "antigravity_skills"]) assert.equal(stepOf((await runJson([...common, "--status"])).json, id)[0].level, "ok", id);
    rmSync(path.join(dir, "state", "skills", "new-flow"), { recursive: true, force: true });
    assert.equal(await quietMain(common), 0);

    // --- もう一度（冪等）---
    const again = await runJson(common);
    assert.match(stepOf(again.json, "antigravity")[0].message, /既に同じ設定/);
    assert.deepEqual(JSON.parse(readFileSync(agConfig, "utf8")), written, "2 回目は何も変えない");

    // --- 取り消し ---
    assert.equal(await quietMain([...common, "--uninstall"]), 0);
    const after = JSON.parse(readFileSync(agConfig, "utf8"));
    assert.equal("mxstage" in after.mcpServers, false, "Antigravity から外れる");
    assert.deepEqual(after.mcpServers["chrome-devtools-mcp"], other);
    for (const skill of repoSkills) assert.equal(existsSync(path.join(agSkills, skill.name)), false, `${skill.name} は消す`);
    assert.equal(existsSync(path.join(agSkills, "cloudflare", "SKILL.md")), true, "利用者の Skill は消さない");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Antigravity の Skill の置き場所が変わった: 前の場所（~/.gemini/skills）の写しを片付けて config/skills に写す。取り消しは前回写した場所から消す", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-agmove-"));
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    const port = await freePort();
    const common = [...sandboxArgs(dir), "--no-start", "--no-autostart", "--no-shortcut", "--port", String(port), "--bridge", bridge];
    const geminiDir = path.join(dir, "gemini");
    const newDir = path.join(geminiDir, "config", "skills");
    const oldDir = path.join(geminiDir, "skills");
    const repoSkills = readRepoSkills(path.resolve(import.meta.dirname, "..", ".."));
    const name = repoSkills[0].name;
    const statePath = path.join(dir, "state", "setup.json");
    mkdirSync(geminiDir, { recursive: true });
    assert.equal(await quietMain(common), 0);

    // 以前の導入の跡にする: 写しは前の場所にあり、記録に写した先（skillDirs）が無い
    const asBefore = () => {
      for (const sk of repoSkills) {
        mkdirSync(path.join(oldDir, sk.name), { recursive: true });
        renameSync(path.join(newDir, sk.name, "SKILL.md"), path.join(oldDir, sk.name, "SKILL.md"));
        rmSync(path.join(newDir, sk.name), { recursive: true, force: true });
      }
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      delete state.skillDirs;
      writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    };
    asBefore();
    mkdirSync(path.join(oldDir, "gemini-own"), { recursive: true });
    writeFileSync(path.join(oldDir, "gemini-own", "SKILL.md"), "---\nname: gemini-own\n---\n", "utf8");

    // 状態を見ると、新しい場所にはまだ無いと出る
    assert.match(stepOf((await runJson([...common, "--status"])).json, "antigravity_skills")[0].message, new RegExp(`まだ配っていない: .*${name}`));

    const moved = await runJson(common);
    assert.equal(moved.code, 0, moved.stdout);
    assert.equal(readFileSync(path.join(newDir, name, "SKILL.md"), "utf8"), repoSkills[0].text, "新しい場所に写す");
    assert.equal(existsSync(path.join(oldDir, name)), false, "前の場所の写しは消す");
    assert.equal(existsSync(path.join(oldDir, "gemini-own", "SKILL.md")), true, "この導入が入れていない Skill には触らない");
    assert.match(stepOf(moved.json, "antigravity_skills_moved")[0].message, /前の場所の写しを消しました/);
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).skillDirs.antigravitySkills, newDir);

    // 前の場所で書き換えられていた写しは残して知らせる
    asBefore();
    writeFileSync(path.join(oldDir, name, "SKILL.md"), `${repoSkills[0].text}\n手で直した\n`, "utf8");
    const kept = await runJson(common);
    assert.equal(kept.code, 0, kept.stdout);
    // ほかの Skill の写しは消すので ok の段も出る。書き換えた写しは warn の段で知らせる
    assert.ok(stepOf(kept.json, "antigravity_skills_moved").some((s) => s.level === "warn" && s.message.includes(name)));
    assert.equal(existsSync(path.join(oldDir, name, "SKILL.md")), true);
    assert.equal(readFileSync(path.join(newDir, name, "SKILL.md"), "utf8"), repoSkills[0].text);
    rmSync(path.join(oldDir, name), { recursive: true, force: true });

    // 取り消しは、前回の導入が写した場所から消す（写す先が変わる前の記録なら、前の場所）
    asBefore();
    assert.equal(await quietMain([...common, "--uninstall"]), 0);
    assert.equal(existsSync(path.join(oldDir, name)), false, "前の場所の写しを消す");
    assert.equal(existsSync(path.join(oldDir, "gemini-own", "SKILL.md")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--no-codex なら Codex の書き先を指定しなくても試験の囲いを通る。--no-skills なら Skill の置き場所は要らない", () => {
  const dir = path.join(os.tmpdir(), "mxs-nocodex");
  const base = ["--port", "19001", "--bridge", path.join(dir, "b.mjs")];
  const drop = (flag) => (a, i, all) => a !== flag && all[i - 1] !== flag;
  const without = sandboxArgs(dir).filter(drop("--codex-dir")).filter(drop("--agents-skills-dir"));
  assert.match(testSandboxProblem(parseArgs([...without, ...base])) ?? "", /--codex-dir がありません（Codex に登録しないなら --no-codex）/);
  assert.match(testSandboxProblem(parseArgs([...without, ...base])) ?? "", /--agents-skills-dir がありません/);
  assert.equal(testSandboxProblem(parseArgs([...without, ...base, "--no-codex"])), null);
  const noSkillsDir = sandboxArgs(dir).filter(drop("--agents-skills-dir")).filter(drop("--claude-skills-dir"));
  assert.equal(testSandboxProblem(parseArgs([...noSkillsDir, ...base, "--no-skills"])), null);
  assert.equal(parseArgs(["--no-codex"]).codex, false);
  assert.equal(parseArgs([]).codex, true);
});

test("codexPaths / codexWanted / skillTargets: ~/.codex があるときだけ Codex に登録し、Skill は ~/.agents/skills に写す", () => {
  const dir = path.join(os.tmpdir(), "mxs-codex-paths", "codex");
  assert.equal(codexPaths(dir).codexConfig, path.join(dir, "config.toml"));
  const on = parseArgs([]);
  const paths = { ...codexPaths(dir), codexSkillsDir: path.join(os.tmpdir(), "agents-skills"), claudeSkillsDir: "x", antigravityDir: "none" };
  assert.equal(codexWanted(on, paths, () => true).ok, true);
  assert.match(codexWanted(on, paths, () => false).reason, /設定フォルダ.*が無い/);
  assert.match(codexWanted(parseArgs(["--no-codex"]), paths, () => true).reason, /--no-codex/);
  const targets = skillTargets(on, paths, (p) => p === dir);
  assert.deepEqual(
    targets.map((t) => [t.id, t.dir]),
    [
      ["skills", "x"],
      ["codex_skills", paths.codexSkillsDir],
    ],
  );
});

test("Codex の config.toml: MX Stage の表だけを足す・置き換える・外す（ほかの表・コメント・改行コードは変えない）", () => {
  const base = [
    "# 利用者の設定",
    'model = "gpt-5"',
    "",
    "[mcp_servers.node_repl]",
    "command = 'C:/x/node.exe'",
    'args = ["a"]',
    "",
    "[mcp_servers.node_repl.env]",
    'X = "1"',
    "",
    "[windows]",
    'sandbox = "elevated"',
    "",
  ].join("\r\n");
  const block = buildCodexBlock("C:\\Program Files\\nodejs\\node.exe", "C:\\r\\src\\bridge\\cli.ts", 8788);
  assert.equal(
    block,
    [
      "[mcp_servers.mxstage]",
      'command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"',
      `args = [${bridgeArgs("C:\\r\\src\\bridge\\cli.ts", 8788).map((a) => JSON.stringify(a)).join(", ")}]`,
      "startup_timeout_sec = 30",
    ].join("\n"),
  );
  const added = upsertCodexTable(base, block);
  assert.ok(added.startsWith(base.trimEnd()), "前の行はそのまま");
  assert.equal(added.includes("\n") && !/[^\r]\n/.test(added), true, "改行は CRLF のまま");
  const found = findCodexTable(added);
  assert.deepEqual(found.entry, { command: "C:\\Program Files\\nodejs\\node.exe", args: bridgeArgs("C:\\r\\src\\bridge\\cli.ts", 8788) });
  assert.equal(upsertCodexTable(added, block), added, "2 回目は変えない");
  assert.equal(removeCodexTable(added).next, base, "外すと元に戻る");
  assert.equal(removeCodexTable(base).changed, false);

  // 利用者が手で書いた MX Stage（複数行の配列・env 付き）: 読めて、置き換え、外すときは元の表に戻せる
  const user = ["[mcp_servers.mxstage]", 'command = "npx"', "args = [", '  "mxstage-mcp",', "]", "", "[mcp_servers.mxstage.env]", 'TOKEN = "secret"', "", "[windows]", 'sandbox = "x"', ""].join("\n");
  const userFound = findCodexTable(user);
  assert.deepEqual(userFound.entry, { command: "npx", args: ["mxstage-mcp"], env: { TOKEN: "" } });
  const replaced = upsertCodexTable(user, block);
  assert.equal(findCodexTable(replaced).block.join("\n"), block);
  assert.match(replaced, /\[windows\]/, "後ろの表は残す");
  assert.equal(removeCodexTable(replaced, userFound.block.join("\n")).next, user);

  // 表ではない書き方の MX Stage には触らない（呼び出し側が otherForm を見て止まる）
  assert.equal(findCodexTable('mcp_servers.mxstage.command = "x"\n').otherForm, true);
  assert.equal(findCodexTable('[mcp_servers]\nmxstage = { command = "x" }\n').otherForm, true);
  assert.equal(findCodexTable('[mcp_servers.mxstage.env]\nA = "1"\n').otherForm, true);
  assert.equal(findCodexTable(added).otherForm, false);

  // 見出しと値の読み取り
  assert.deepEqual(tomlTableKey('[mcp_servers."mxstage"]'), ["mcp_servers", "mxstage"]);
  assert.deepEqual(tomlTableKey("[projects.'c:/users/x']"), ["projects", "c:/users/x"]);
  assert.equal(tomlTableKey("[[array]]"), null);
  assert.deepEqual(tomlValue('[\n "a", \'b\' ,\n 3]'), ["a", "b", 3]);
  assert.equal(tomlValue('"x" # コメント'), "x");
  assert.equal(tomlValue('"x" y'), undefined);
});

test("Codex: 入っていれば config.toml に登録し ~/.agents/skills に Skill を写す（ほかの表は残す）。利用者の前の設定は取り消しで戻す。入っていなければ触らない", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-codex-"));
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    const port = await freePort();
    const common = [...sandboxArgs(dir), "--no-start", "--no-autostart", "--no-shortcut", "--port", String(port), "--bridge", bridge];
    const codexDir = path.join(dir, "codex");
    const config = path.join(codexDir, "config.toml");
    const agentsSkills = path.join(dir, "agents-skills");
    const repoSkills = readRepoSkills(path.resolve(import.meta.dirname, "..", ".."));

    // --- Codex が入っていない（~/.codex が無い）: 何も作らない ---
    const absent = await runJson(common);
    assert.equal(absent.code, 0, absent.stdout);
    assert.equal(stepOf(absent.json, "codex")[0].level, "skip");
    assert.equal(existsSync(codexDir), false, "入れていない PC に ~/.codex を作らない");
    assert.equal(existsSync(agentsSkills), false, "~/.agents/skills も作らない");

    // --- 入っている: 利用者の設定（ほかの表と、手で書いた MX Stage）がある ---
    const userBlock = ['[mcp_servers.mxstage]', 'command = "npx"', 'args = ["mxstage-mcp"]'].join("\r\n");
    const original = ["# 利用者の設定", 'model = "gpt-5"', "", "[mcp_servers.node_repl]", 'command = "node"', "", userBlock, "", "[windows]", 'sandbox = "elevated"', ""].join("\r\n");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(config, original, "utf8");

    const first = await runJson(common);
    assert.equal(first.code, 0, first.stdout);
    assert.equal(stepOf(first.json, "codex")[0].level, "ok");
    assert.match(stepOf(first.json, "codex")[0].message, /前の MX Stage の設定を置き換えました/);
    assert.ok(first.json.result.installed.codex);
    const written = readFileSync(config, "utf8");
    const found = findCodexTable(written);
    assert.deepEqual(found.entry, { command: process.execPath, args: [bridge, "--port", String(port)] });
    assert.match(written, /\[mcp_servers\.node_repl\]\r\ncommand = "node"/, "ほかの MCP サーバは残す");
    assert.match(written, /\[windows\]\r\nsandbox = "elevated"/, "後ろの表も残す");
    for (const skill of repoSkills) {
      assert.equal(readFileSync(path.join(agentsSkills, skill.name, "SKILL.md"), "utf8"), skill.text, `${skill.name} を ~/.agents/skills にも入れた`);
    }
    const state = JSON.parse(readFileSync(path.join(dir, "state", "setup.json"), "utf8"));
    assert.deepEqual(state.installed.codexSkills.map((sk) => sk.name), repoSkills.map((sk) => sk.name));
    assert.ok(state.previous.codex?.backup, "利用者の前の MX Stage を戻す先として控えごと覚える");

    // --- 状態を見る・もう一度（冪等）---
    const status = await runJson([...common, "--status"]);
    assert.equal(stepOf(status.json, "codex")[0].level, "ok");
    assert.equal(stepOf(status.json, "codex_skills")[0].level, "ok");
    const again = await runJson(common);
    assert.match(stepOf(again.json, "codex")[0].message, /既に同じ設定/);
    assert.equal(readFileSync(config, "utf8"), written, "2 回目は何も変えない");

    // --- 取り消し: MX Stage の表を利用者の前の設定に戻し、Skill を消す ---
    assert.equal(await quietMain([...common, "--uninstall"]), 0);
    assert.equal(readFileSync(config, "utf8"), original, "元の config.toml に戻る");
    for (const skill of repoSkills) assert.equal(existsSync(path.join(agentsSkills, skill.name)), false, `${skill.name} は消す`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseArgs: --port は 2 通りの書き方を受けて整数にする。--claude-cli を受ける", () => {
  assert.equal(parseArgs(["--port", "8080"]).port, 8080);
  assert.equal(parseArgs(["--port=8080"]).port, 8080);
  assert.equal(parseArgs(["--claude-cli", "C:\\tmp\\claude.cmd"]).claudeCli, "C:\\tmp\\claude.cmd");
});

test("parseArgs: 知らない引数と不正なポートは断る", () => {
  assert.match(parseArgs(["--nope"]).error, /知らない引数/);
  assert.match(parseArgs(["--port", "0"]).error, /--port/);
  assert.match(parseArgs(["--port", "abc"]).error, /--port/);
  assert.match(parseArgs(["--bridge"]).error, /値が必要/);
});

// ---------------------------------------------------------------------------
// MCP の設定を足す・外す
// ---------------------------------------------------------------------------

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const ENTRY = "C:\\repo\\src\\bridge\\cli.ts";
const JS_ENTRY = "C:\\repo\\dist\\bridge\\cli.js";

test("buildCodeEntry: claude mcp add が書くのと同じ形にする（.ts には型を外す指定を付ける）", () => {
  assert.deepEqual(buildCodeEntry(NODE, ENTRY, 7777), {
    type: "stdio",
    command: NODE,
    args: ["--experimental-strip-types", ENTRY, "--port", "7777"],
    env: {},
  });
  assert.deepEqual(buildCodeEntry(NODE, JS_ENTRY, 7777).args, [JS_ENTRY, "--port", "7777"]);
});

test("buildDesktopEntry: Claude Desktop には type を書かない", () => {
  assert.deepEqual(buildDesktopEntry(NODE, ENTRY, 7777), { command: NODE, args: ["--experimental-strip-types", ENTRY, "--port", "7777"] });
});

test("bridgeArgs: 画面だけ動かすときは --no-mcp を入口の後ろに置く", () => {
  assert.deepEqual(bridgeArgs(ENTRY, 8788, ["--no-mcp"]), ["--experimental-strip-types", ENTRY, "--no-mcp", "--port", "8788"]);
  assert.deepEqual(nodeFlagsFor(JS_ENTRY), []);
});

test("isSameEntry: command と args が同じなら同じ（type・env の違いは見ない）", () => {
  const a = buildCodeEntry(NODE, ENTRY, 7777);
  assert.equal(isSameEntry(a, buildDesktopEntry(NODE, ENTRY, 7777)), true);
  assert.equal(isSameEntry(a, buildCodeEntry(NODE, ENTRY, 7778)), false);
  assert.equal(isSameEntry(a, null), false);
  assert.equal(isSameEntry(a, { type: "http", url: "https://example.test/mcp" }), false);
});

test("mergeMcpServer: ほかのサーバとほかの設定を残したまま 1 ブロックだけ足す", () => {
  const before = {
    numStartups: 12,
    projects: { "C:\\work": {} },
    mcpServers: { other: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer KEEP" } } },
  };
  const entry = buildCodeEntry(NODE, ENTRY, 7777);
  const { next, previous, changed } = mergeMcpServer(before, "mxstage", entry);
  assert.equal(changed, true);
  assert.equal(previous, null);
  assert.equal(next.numStartups, 12);
  assert.deepEqual(next.projects, { "C:\\work": {} });
  assert.deepEqual(next.mcpServers.other, before.mcpServers.other);
  assert.deepEqual(next.mcpServers.mxstage, entry);
  // 元のオブジェクトは変えない
  assert.equal("mxstage" in before.mcpServers, false);
});

test("mergeMcpServer: 同じ内容なら changed は false（何度実行しても書き換えない）", () => {
  const entry = buildCodeEntry(NODE, ENTRY, 7777);
  const { changed } = mergeMcpServer({ mcpServers: { mxstage: entry } }, "mxstage", entry);
  assert.equal(changed, false);
});

test("mergeMcpServer: mcpServers が無い設定にも足せる", () => {
  const entry = buildDesktopEntry(NODE, ENTRY, 7777);
  const { next } = mergeMcpServer({ preferences: { a: 1 } }, "mxstage", entry);
  assert.deepEqual(next.preferences, { a: 1 });
  assert.deepEqual(next.mcpServers.mxstage, entry);
});

test("removeMcpServer: 外す・前の設定に戻す・ほかは残す", () => {
  const ours = buildCodeEntry(NODE, ENTRY, 7777);
  const before = { mcpServers: { other: { type: "http" }, mxstage: ours } };
  const removed = removeMcpServer(before, "mxstage", null);
  assert.equal(removed.changed, true);
  assert.equal("mxstage" in removed.next.mcpServers, false);
  assert.deepEqual(removed.next.mcpServers.other, { type: "http" });

  const old = { type: "http", url: "https://example.test/mcp" };
  const restored = removeMcpServer(before, "mxstage", old);
  assert.deepEqual(restored.next.mcpServers.mxstage, old);

  const none = removeMcpServer({ mcpServers: {} }, "mxstage", null);
  assert.equal(none.changed, false);
});

test("isOurEntry: 橋渡しを起動している設定だけを自分のものと見なす", () => {
  assert.equal(isOurEntry(buildCodeEntry(NODE, ENTRY, 7777), ENTRY), true);
  assert.equal(isOurEntry({ type: "http", url: "https://example.test/mcp" }, ENTRY), false);
  assert.equal(isOurEntry({ command: "node", args: ["C:\\other\\thing.mjs"] }, ENTRY), false);
});

test("redactEntry: ヘッダと環境変数の値を伏せる（トークンを画面にも記録にも出さない）", () => {
  const red = redactEntry({ type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer SECRET" }, env: { TOKEN: "SECRET" } });
  assert.equal(red.headers.Authorization, "<伏せ>");
  assert.equal(red.env.TOKEN, "<伏せ>");
  assert.equal(JSON.stringify(red).includes("SECRET"), false);
  assert.equal(red.url, "https://example.test/mcp");
});

test("canUseClaudeCli: claude コマンドに任せてよいのは、書き先がちょうど既定の .claude.json のときだけ", () => {
  const def = path.join(os.homedir(), ".claude.json");
  assert.equal(canUseClaudeCli(def, def), true);
  // 別の場所の .claude.json（試験で差し替えたとき）は claude コマンドでは書かない（本物を書き換えてしまうため）
  assert.equal(canUseClaudeCli(path.join(os.tmpdir(), "x", ".claude.json"), def), false);
  assert.equal(canUseClaudeCli(path.join(os.tmpdir(), "claude-code.json"), def), false);
  assert.equal(canUseClaudeCli(def, null), false);
});

test("redactUrl / redactArgs: 秘密リンクのトークン・クエリ・利用者情報・トークンらしい引数を伏せる", () => {
  assert.equal(redactUrl("https://example.test/mcp"), "https://example.test/mcp");
  const link = redactUrl("https://mxstage.example.workers.dev/w/Zx81kQ2vN7pLr4TtY9uWc3/app?key=SECRETQ#frag");
  assert.equal(link.includes("Zx81kQ2vN7pLr4TtY9uWc3"), false);
  assert.equal(link.includes("SECRETQ"), false);
  assert.ok(link.startsWith("https://mxstage.example.workers.dev/w/"));
  assert.equal(redactUrl("https://user:pw-SECRET@example.test/mcp").includes("SECRET"), false);
  assert.equal(redactUrl("これは URL ではない"), "<伏せ>");

  const args = redactArgs(["--experimental-strip-types", "C:\\repo\\src\\bridge\\cli.ts", "--port", "8788", "--token", "abc", "--api-key=xyz", "Bearer qwe", "sk0123456789abcdefghijklmnop", "https://h.test/p?k=SECRETZ"]);
  assert.deepEqual(args.slice(0, 5), ["--experimental-strip-types", "C:\\repo\\src\\bridge\\cli.ts", "--port", "8788", "--token"]);
  const joined = JSON.stringify(args);
  for (const secret of ["abc", "xyz", "qwe", "sk0123456789abcdefghijklmnop", "SECRETZ"]) assert.equal(joined.includes(secret), false, secret);

  const red = redactEntry({ type: "http", url: "https://h.test/mcp/Zx81kQ2vN7pLr4TtY9uWc3" });
  assert.equal(JSON.stringify(red).includes("Zx81kQ2vN7pLr4TtY9uWc3"), false);
});

test("rememberPrevious: 利用者の設定は戻す先として覚え、この導入が前に書いた設定は覚えない", () => {
  const ours = buildCodeEntry(NODE, ENTRY, 7777);
  const cloud = { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer SECRET" } };
  // 何も無かった
  assert.deepEqual(rememberPrevious({}, "claudeCode", null, null, ENTRY), { claudeCode: null });
  // 利用者の設定（トークンは写さない）
  const rec = rememberPrevious({}, "claudeCode", cloud, "C:\\bak\\a.bak", ENTRY);
  assert.equal(rec.claudeCode.backup, "C:\\bak\\a.bak");
  assert.equal(JSON.stringify(rec).includes("SECRET"), false);
  // 記録を無くしてから入れ直した（置き換える相手が自分の古い設定）: 戻す先にしない
  assert.deepEqual(rememberPrevious({}, "claudeCode", ours, "C:\\bak\\b.bak", ENTRY), { claudeCode: null });
  // 既に覚えている戻す先は、自分の設定を書き直すだけなら消さない
  assert.deepEqual(rememberPrevious(rec, "claudeCode", ours, "C:\\bak\\c.bak", ENTRY), rec);
});

test("rememberPrevious: 指しているファイルが無い登録（壊れた登録）は戻す先として覚えない", () => {
  const gone = path.join(os.tmpdir(), "mxs-no-such-dir", "server.mjs");
  const broken = { type: "stdio", command: process.execPath, args: [gone], env: {} };
  assert.deepEqual(rememberPrevious({}, "claudeCode", broken, "C:\\bak\\d.bak", ENTRY), { claudeCode: null });
  // 既に覚えている利用者の設定は消さない
  const rec = { claudeCode: { backup: "C:\\bak\\a.bak", entry: { type: "http" } } };
  assert.deepEqual(rememberPrevious(rec, "claudeCode", broken, "C:\\bak\\e.bak", ENTRY), rec);
});

test("isSetupShapedEntry: この導入が書く形なら、入口の場所が違っても（消えていても）自分のものと見なす", () => {
  assert.equal(isSetupShapedEntry(buildCodeEntry(NODE, "D:\\old\\mxstage\\src\\bridge\\cli.ts", 8788)), true);
  assert.equal(isSetupShapedEntry({ command: "/usr/bin/node", args: ["/home/a/mxstage/bin/mxstage-bridge.mjs", "--port", "8788"] }), true);
  assert.equal(isSetupShapedEntry({ command: "node", args: ["C:\\work\\server.mjs", "--port", "8788"] }), false);
  assert.equal(isSetupShapedEntry({ command: "npx", args: ["-y", "some-mcp"] }), false);
  assert.equal(isSetupShapedEntry({ type: "http", url: "https://example.test/mcp" }), false);
});

test("lastWrittenEntries: 前回の記録から、そのとき書いた設定を組み立て直す", () => {
  assert.deepEqual(lastWrittenEntries({ nodePath: NODE, bridgeEntry: ENTRY, port: 7777 }), [buildCodeEntry(NODE, ENTRY, 7777)]);
  assert.deepEqual(lastWrittenEntries({}), []);
  assert.deepEqual(lastWrittenEntries(null), []);
});

test("findOnPath: PATH（Windows は PATHEXT も）から探し、PATH が無ければ「分からない」を返す", () => {
  const dirA = path.join(os.tmpdir(), "mxs-a");
  const dirB = path.join(os.tmpdir(), "mxs-b");
  const target = path.join(dirB, IS_WINDOWS ? "tool.EXE" : "tool");
  const env = { PATH: [dirA, dirB].join(path.delimiter), PATHEXT: ".COM;.EXE" };
  assert.equal(findOnPath("tool", env, (p) => p === target), target);
  assert.equal(findOnPath("nothing", env, () => false), null);
  assert.equal(findOnPath("tool", {}, () => true), undefined);
});

test("missingTargets: command と args が指すファイルのうち、無いものを返す（URL の設定と相対パスは問わない）", () => {
  const here = path.join(os.tmpdir(), "mxs-here", "server.mjs");
  const gone = path.join(os.tmpdir(), "mxs-gone", "server.mjs");
  const exe = path.join(os.tmpdir(), "mxs-here", "node.exe");
  const exists = (p) => p === here || p === exe;
  const found = () => "found";
  assert.deepEqual(missingTargets({ command: exe, args: [here, "--port", "8788"] }, exists, found), []);
  assert.deepEqual(missingTargets({ command: exe, args: [gone] }, exists, found), [gone]);
  const noExe = path.join(os.tmpdir(), "mxs-gone", "node.exe");
  assert.deepEqual(missingTargets({ command: noExe, args: [here] }, exists, found), [noExe]);
  // 名前だけのコマンドは PATH から。見つからなければ無い、分からなければ問わない
  assert.equal(missingTargets({ command: "nodez", args: [] }, exists, () => null).length, 1);
  assert.deepEqual(missingTargets({ command: "node", args: [] }, exists, () => undefined), []);
  // 相対パス・フラグ・拡張子の無い値は問わない
  assert.deepEqual(missingTargets({ command: exe, args: ["src/bridge/cli.ts", "--app-dir", "dist"] }, exists, found), []);
  // URL の設定はファイルを指さない
  assert.deepEqual(missingTargets({ type: "http", url: "https://example.test/mcp" }, exists, found), []);
  // 形が壊れている
  assert.equal(missingTargets({ type: "stdio" }, exists, found).length, 1);
  assert.equal(missingTargets("node", exists, found).length, 1);
});

test("classifyPrevious: 無い / この導入のもの / 壊れた登録 / 利用者の設定 を見分ける", () => {
  const gone = path.join(os.tmpdir(), "mxs-gone", "server.mjs");
  assert.equal(classifyPrevious(null).kind, "none");
  assert.equal(classifyPrevious(buildCodeEntry(NODE, ENTRY, 7777), { bridgeEntry: ENTRY }).kind, "ours");
  // 前回の記録と同じ（入口のパスに bridge を含まない場所でも）
  const custom = buildCodeEntry(process.execPath, path.join(os.tmpdir(), "mxs-x", "fake.mjs"), 19001);
  assert.equal(classifyPrevious(custom, { lastWritten: [custom] }).kind, "ours");
  const broken = classifyPrevious({ command: process.execPath, args: [gone] });
  assert.equal(broken.kind, "broken");
  assert.deepEqual(broken.missing, [gone]);
  assert.equal(classifyPrevious({ type: "http", url: "https://example.test/mcp" }).kind, "user");
  assert.equal(classifyPrevious({ command: process.execPath, args: [fileURLToPath(import.meta.url)] }).kind, "user");
});

test("previousEntrySteps: 記録しなかったときは、その理由を画面に出す（秘密は伏せる）", () => {
  const gone = path.join(os.tmpdir(), "mxs-gone", "server.mjs");
  const broken = { command: process.execPath, args: [gone, "--token", "SECRET-XYZ"] };
  const [line] = previousEntrySteps("claude_code", broken, { kind: "broken", missing: [gone] }, "C:\\bak\\x.bak");
  assert.equal(line.level, "warn");
  assert.match(line.message, /戻す先としては記録しません/);
  assert.ok(line.message.includes(gone));
  assert.equal(JSON.stringify(line).includes("SECRET-XYZ"), false);
  assert.match(line.hint, /x\.bak/);
  const [ours] = previousEntrySteps("claude_code", buildCodeEntry(NODE, ENTRY, 1), { kind: "ours", missing: [] }, null);
  assert.match(ours.message, /前回この導入が書いたもの/);
  assert.match(ours.message, /記録しません/);
  assert.deepEqual(previousEntrySteps("claude_code", null, { kind: "none", missing: [] }, null), []);
});

test("isBridgeCommandLine: 入口の絶対パスを含むときだけ橋渡しと見なす（ファイル名だけでは止めない）", { skip: !IS_WINDOWS && "Windows のパスで試す" }, () => {
  const line = `"C:\\Program Files\\nodejs\\node.exe" --experimental-strip-types C:\\Repo\\src\\bridge\\cli.ts --no-mcp --port 8788`;
  assert.equal(isBridgeCommandLine(line, "C:\\repo\\src\\bridge\\cli.ts"), true);
  assert.equal(isBridgeCommandLine(`node C:\\other-tool\\cli.ts --port 8788`, "C:\\repo\\src\\bridge\\cli.ts"), false);
  assert.equal(isBridgeCommandLine(`node C:\\mxstage-notes\\run.mjs`, "C:\\repo\\src\\bridge\\cli.ts"), false);
  assert.equal(isBridgeCommandLine("", "C:\\repo\\src\\bridge\\cli.ts"), false);
  assert.equal(isBridgeCommandLine(line, null), false);
  // 画面用（--no-mcp 付き）か、Claude が MCP サーバとして起動したものか
  assert.equal(isServeBridgeCommandLine(line, "C:\\repo\\src\\bridge\\cli.ts"), true);
  const claudeLaunched = `"C:\\Program Files\\nodejs\\node.exe" --experimental-strip-types C:\\Repo\\src\\bridge\\cli.ts --port 8788`;
  assert.equal(isBridgeCommandLine(claudeLaunched, "C:\\repo\\src\\bridge\\cli.ts"), true);
  assert.equal(isServeBridgeCommandLine(claudeLaunched, "C:\\repo\\src\\bridge\\cli.ts"), false);
  assert.equal(isServeBridgeCommandLine(`node C:\\repo\\src\\bridge\\cli.ts --no-mcpx --port 8788`, "C:\\repo\\src\\bridge\\cli.ts"), false);
  assert.equal(isServeBridgeCommandLine(`node C:\\other\\cli.ts --no-mcp --port 8788`, "C:\\repo\\src\\bridge\\cli.ts"), false);
});

test("runPowerShell: 日本語のパスが化けずに返る（OneDrive の「デスクトップ」・日本語のユーザー名）", { timeout: 60_000, skip: !IS_WINDOWS && "Windows だけ" }, () => {
  const value = "C:\\Users\\山田\\OneDrive\\デスクトップ";
  const ran = runPowerShell("@{ v = $env:MXS_V } | ConvertTo-Json -Compress", { MXS_V: value });
  assert.equal(ran.ok, true, ran.stderr);
  const lines = ran.stdout.split(/\r?\n/).filter((l) => l.trim());
  assert.equal(JSON.parse(lines[lines.length - 1]).v, value);
});

test("nodeFlagsFor: この node が知らない指定は付けない（Claude から起動できなくなるため）", () => {
  assert.deepEqual(nodeFlagsFor(ENTRY, () => true), ["--experimental-strip-types"]);
  assert.deepEqual(nodeFlagsFor(ENTRY, () => false), []);
});

// ---------------------------------------------------------------------------
// 試験の囲い（本物に触れない仕組み）
// ---------------------------------------------------------------------------

test("chooseClaudeCli: 試験中は本物の claude を探さず、一時フォルダの偽物だけを使う", () => {
  const def = path.join(os.homedir(), ".claude.json");
  const mustNotLocate = () => {
    throw new Error("試験中に claude コマンドを探した");
  };
  const fake = path.join(os.tmpdir(), "mxs-fake", "claude.cmd");
  // 書き先が既定の ~/.claude.json でも、試験中は探さない
  assert.deepEqual(chooseClaudeCli({ configPath: def, defaultConfigPath: def, guard: true, locate: mustNotLocate }), { exe: null, source: "guard" });
  assert.deepEqual(chooseClaudeCli({ explicit: fake, configPath: def, defaultConfigPath: def, guard: true, locate: mustNotLocate }), { exe: path.resolve(fake), source: "explicit" });
  // 一時フォルダの外を指定されても使わない（本物かもしれない）
  assert.equal(chooseClaudeCli({ explicit: "C:\\Users\\someone\\.local\\bin\\claude.exe", configPath: def, defaultConfigPath: def, guard: true, locate: mustNotLocate }).exe, null);

  // ふだん: 書き先を差し替えたら探さない
  assert.deepEqual(chooseClaudeCli({ configPath: path.join(os.tmpdir(), "x.json"), defaultConfigPath: def, locate: mustNotLocate }), { exe: null, source: "redirected" });
  // ふだん: 既定の書き先なら、指定があればそれ、無ければ探す
  assert.equal(chooseClaudeCli({ explicit: fake, configPath: def, defaultConfigPath: def, locate: mustNotLocate }).exe, path.resolve(fake));
  assert.deepEqual(chooseClaudeCli({ configPath: def, defaultConfigPath: def, locate: () => "C:\\bin\\claude.exe" }), { exe: "C:\\bin\\claude.exe", source: "path" });
});

test("bridgeTestEnv: 試験中に起動する橋渡しの鍵ファイルを、記録の置き場所（一時フォルダ）に向ける", () => {
  const paths = { stateDir: path.join(os.tmpdir(), "mxs-key", "state") };
  assert.deepEqual(bridgeTestEnv(paths, { MXSTAGE_SETUP_TEST: "1" }), { MXSTAGE_BRIDGE_KEY_FILE: path.join(paths.stateDir, "bridge.key") });
  // ふだんは何も足さない（本物の橋渡しと同じ既定の場所を使う）
  assert.deepEqual(bridgeTestEnv(paths, {}), {});
  // 既に差し替えてあれば、それを使う
  assert.deepEqual(bridgeTestEnv(paths, { MXSTAGE_SETUP_TEST: "1", MXSTAGE_BRIDGE_KEY_FILE: path.join(os.tmpdir(), "k") }), {});
});

test("keyFileEnvStep: ふだんの導入で MXSTAGE_BRIDGE_KEY_FILE が設定されていたら、鍵が食い違うと警告する（値は出さない）", () => {
  const secretPath = path.join(os.tmpdir(), "mxs-key-SECRETPATH", "bridge.key");
  const warn = keyFileEnvStep({ MXSTAGE_BRIDGE_KEY_FILE: secretPath });
  assert.equal(warn.level, "warn");
  assert.equal(warn.id, "bridge_key_env");
  assert.match(warn.hint, /認証に失敗/);
  assert.equal(JSON.stringify(warn).includes("SECRETPATH"), false);
  assert.equal(keyFileEnvStep({}), null);
  assert.equal(keyFileEnvStep({ MXSTAGE_BRIDGE_KEY_FILE: " " }), null);
  // 試験中は、囲いが一時フォルダの鍵に向けるので警告しない
  assert.equal(keyFileEnvStep({ MXSTAGE_SETUP_TEST: "1", MXSTAGE_BRIDGE_KEY_FILE: secretPath }), null);
});

test("testSandboxProblem: 書き先が一時フォルダの外・--port / --bridge / --no-open が無いときは止める", () => {
  const dir = path.join(os.tmpdir(), "mxs-guard");
  const ok = parseArgs([...sandboxArgs(dir), "--port", "19001", "--bridge", path.join(dir, "b.mjs")]);
  assert.equal(testSandboxProblem(ok), null);
  const missing = parseArgs(["--no-open", "--port", "19001", "--bridge", "b.mjs", "--state-dir", path.join(dir, "s")]);
  assert.match(testSandboxProblem(missing), /--claude-code-config がありません/);
  assert.match(testSandboxProblem(missing), /--desktop-dir がありません/);
  const outside = parseArgs([...sandboxArgs(dir), "--port", "19001", "--bridge", "b.mjs", "--claude-code-config", path.join(os.homedir(), ".claude.json")]);
  assert.match(testSandboxProblem(outside), /--claude-code-config が一時フォルダ/);
  assert.match(testSandboxProblem(parseArgs([...sandboxArgs(dir), "--bridge", "b.mjs"])), /--port がありません/);
  assert.match(testSandboxProblem(parseArgs([...sandboxArgs(dir), "--bridge", "b.mjs", "--port", "8788"])), /8788/);
  assert.match(testSandboxProblem(parseArgs([...sandboxArgs(dir), "--port", "19001"])), /--bridge がありません/);
  const withOpen = parseArgs([...sandboxArgs(dir).filter((a) => a !== "--no-open"), "--port", "19001", "--bridge", "b.mjs"]);
  assert.match(testSandboxProblem(withOpen), /--no-open/);
  const realCli = parseArgs([...sandboxArgs(dir), "--port", "19001", "--bridge", "b.mjs", "--claude-cli", path.join(os.homedir(), ".local", "bin", "claude.exe")]);
  assert.match(testSandboxProblem(realCli), /--claude-cli が一時フォルダの外/);
  assert.equal(isInside(os.tmpdir(), os.tmpdir()), false);
  assert.equal(isInside(os.tmpdir(), path.join(os.tmpdir(), "a")), true);

  // npm install / npm run build は本物のリポジトリを書き換えるので、試験中は必ず止める
  const withNpm = parseArgs([...sandboxArgs(dir).filter((a) => a !== "--no-install" && a !== "--no-build"), "--port", "19001", "--bridge", "b.mjs"]);
  assert.match(testSandboxProblem(withNpm), /--no-install がありません/);
  assert.match(testSandboxProblem(withNpm), /--no-build がありません/);
});

test("testSandboxProblem: TEMP がホームフォルダに向いていても、本物の書き先（~/.claude.json・デスクトップなど）は拒む", () => {
  // 一時フォルダがホームそのものだった場合を作る（実際のファイルには触らない。判定だけ）
  const home = path.join(os.tmpdir(), "mxs-fakehome");
  const env = { APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local") };
  const real = realWriteLocations(env, home, home);
  const args = [
    "--no-open",
    "--no-install",
    "--no-build",
    "--port",
    "19001",
    "--bridge",
    "b.mjs",
    "--state-dir",
    path.join(home, ".config", "mxstage"),
    "--claude-code-config",
    path.join(home, ".claude.json"),
    "--claude-desktop-config",
    path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
    "--startup-dir",
    path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"),
    "--desktop-dir",
    path.join(home, "OneDrive", "Desktop"),
    "--antigravity-dir",
    path.join(home, ".gemini"),
    "--codex-dir",
    path.join(home, ".codex"),
    "--agents-skills-dir",
    path.join(home, ".agents", "skills"),
    "--bob-dir",
    path.join(home, ".bob"),
    "--claude-desktop-packages-dir",
    path.join(home, "AppData", "Local", "Packages"),
  ];
  const problem = testSandboxProblem(parseArgs(args), home, real);
  for (const flag of [
    "--state-dir",
    "--claude-code-config",
    "--claude-desktop-config",
    "--startup-dir",
    "--desktop-dir",
    "--antigravity-dir",
    "--codex-dir",
    "--agents-skills-dir",
    "--bob-dir",
    "--claude-desktop-packages-dir",
  ]) {
    assert.match(problem, new RegExp(`${flag} が本物の書き先です`), flag);
  }
  // ホームの中でも、本物の書き先でない場所は通す
  const ok = parseArgs([...sandboxArgs(path.join(home, "work")), "--port", "19001", "--bridge", "b.mjs"]);
  assert.equal(testSandboxProblem(ok, home, real), null);
  // 改名前の置き場所（~/.config/mxstudio）と、それより前の版の置き場所（%LOCALAPPDATA%\mxstudio）も、残っている PC があるので拒む
  for (const old of [path.join(home, ".config", "mxstudio"), path.join(home, "AppData", "Local", "mxstudio")]) {
    const legacy = parseArgs([...sandboxArgs(path.join(home, "work")), "--port", "19001", "--bridge", "b.mjs", "--state-dir", old]);
    assert.match(testSandboxProblem(legacy, home, real) ?? "", /--state-dir が本物の書き先です/, old);
  }
  // CLAUDE_CONFIG_DIR が一時フォルダの外なら、その .claude.json も本物として拒む。中なら試験の差し替えなので含めない
  assert.ok(realWriteLocations({ CLAUDE_CONFIG_DIR: "D:\\cfg" }, "C:\\h", "C:\\t").some((p) => p === path.join("D:\\cfg", ".claude.json")));
  assert.equal(realWriteLocations({ CLAUDE_CONFIG_DIR: path.join(home, "cfg") }, "C:\\h", home).some((p) => p.includes("cfg")), false);
  // CODEX_HOME も同じ決め方
  assert.ok(realWriteLocations({ CODEX_HOME: "D:\\codex" }, "C:\\h", "C:\\t").includes("D:\\codex"));
  assert.equal(realWriteLocations({ CODEX_HOME: path.join(home, "cx") }, "C:\\h", home).some((p) => p.includes("cx")), false);
});

test("main: 試験中に書き先を差し替え忘れたら、何もせずに終了コード 2 で止まる", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-guardmain-"));
  try {
    // 万一囲いが効かなくても書き換えないように --dry-run と --no-* も付ける
    const base = ["--dry-run", "--no-start", "--no-autostart", "--no-shortcut", "--no-install", "--no-build", "--bridge", path.join(dir, "b.mjs"), "--port", "19001"];
    const withoutDesktop = sandboxArgs(dir).filter((a, i, all) => a !== "--claude-desktop-config" && all[i - 1] !== "--claude-desktop-config");
    const run = await runMain([...withoutDesktop, ...base]);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /MXSTAGE_SETUP_TEST/);
    assert.match(run.stderr, /--claude-desktop-config がありません/);
    assert.equal(run.stdout, "", "手順を 1 つも実行していない");
    assert.deepEqual(readdirSync(dir), [], "一時フォルダにも何も作っていない");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ファイルまわり
// ---------------------------------------------------------------------------

test("readJsonFile: 壊れた JSON は error を返す（書き換えを諦めるため）", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-json-"));
  try {
    const broken = path.join(dir, "broken.json");
    writeFileSync(broken, "{ これは JSON ではない", "utf8");
    assert.ok(readJsonFile(broken).error);

    const array = path.join(dir, "array.json");
    writeFileSync(array, "[1,2,3]", "utf8");
    assert.ok(readJsonFile(array).error);

    const empty = path.join(dir, "empty.json");
    writeFileSync(empty, "", "utf8");
    assert.deepEqual(readJsonFile(empty).json, {});

    assert.equal(readJsonFile(path.join(dir, "ない.json")).exists, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("entryFromBackup: 控えから、その名前の設定だけを読み直す", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-bak-"));
  try {
    const backup = path.join(dir, ".claude.json.bak");
    writeFileSync(backup, JSON.stringify({ mcpServers: { mxstage: { type: "http", url: "https://example.test/mcp" } } }), "utf8");
    assert.deepEqual(entryFromBackup(backup, "mxstage"), { type: "http", url: "https://example.test/mcp" });
    assert.equal(entryFromBackup(backup, "ない"), null);
    assert.equal(entryFromBackup(path.join(dir, "ない.bak"), "mxstage"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveBridgeEntry: 候補を順に探し、--bridge が無いファイルなら missing を返す", () => {
  const repo = "C:\\repo";
  const only = path.join(repo, "src", "bridge", "index.ts");
  const found = resolveBridgeEntry(repo, null, (p) => p === only);
  assert.equal(found.entry, only);

  const none = resolveBridgeEntry(repo, null, () => false);
  assert.equal(none.entry, null);

  const explicit = resolveBridgeEntry(repo, "custom\\bridge.mjs", () => false);
  assert.equal(explicit.entry, null);
  assert.equal(explicit.explicit, true);
  assert.ok(explicit.missing.endsWith(path.join("custom", "bridge.mjs")));
});

test("findBrowser: Chrome があれば Chrome、無ければ Edge、どちらも無ければ null", () => {
  const chrome = path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  assert.deepEqual(findBrowser((p) => p === chrome), { kind: "chrome", exe: chrome });
  const edge = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe");
  assert.deepEqual(findBrowser((p) => p === edge), { kind: "edge", exe: edge });
  assert.equal(findBrowser(() => false), null);
});

test("buildInternetShortcut と引用", () => {
  assert.equal(buildInternetShortcut("http://127.0.0.1:7777/app"), "[InternetShortcut]\r\nURL=http://127.0.0.1:7777/app\r\n");
  assert.equal(quoteArgs(["C:\\Program Files\\node.exe", "--serve"]), '"C:\\Program Files\\node.exe" --serve');
  assert.equal(quoteForCmd("C:\\tmp\\a.exe"), "C:\\tmp\\a.exe");
  assert.equal(quoteForCmd("C:\\Program Files\\a.exe"), '"C:\\Program Files\\a.exe"');
});

// ---------------------------------------------------------------------------
// 偽の橋渡し・偽の claude コマンド
// ---------------------------------------------------------------------------

/** 偽の橋渡し（取り決めどおり）。/_mxstage/health と /ws だけに応える */
const FAKE_BRIDGE = `import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
createServer((req, res) => {
  if (req.url === "/_mxstage/health") {
    res.writeHead(200, { "content-type": "application/json" });
    // keyFile: 起動したときに受け取った鍵ファイルの場所（本物の橋渡しはここに鍵を作る。試験で本物の場所に向いていないかを見る）
    // protocol: 本物（src/bridge/peer.ts）と同じく取り決めの版を返す。FAKE_PROTOCOL を書き換えて版違いを作れる
    res.end(JSON.stringify({ ok: true, name: "mxstage-bridge", protocol: Number(process.env.FAKE_PROTOCOL ?? "1"), pid: process.pid, keyFile: process.env.MXSTAGE_BRIDGE_KEY_FILE ?? null }));
    return;
  }
  // 本物（src/bridge/server.ts）と同じ: /ws は 426 と upgrade_required を返す
  if (req.url === "/ws") {
    res.writeHead(426, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "upgrade_required", message: "WebSocket で接続してください。" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "not_found" }));
}).listen(port, "127.0.0.1");
`;

/** 古い版の偽の橋渡し（/_mxstage/health が無い） */
const LEGACY_BRIDGE = FAKE_BRIDGE.replace('req.url === "/_mxstage/health"', 'req.url === "/_no_health_in_legacy"');

/**
 * 偽の client 役の橋渡し。ポートが塞がっている間は待ち、空いたら引き継いで応える
 * （本物の橋渡しは、primary が終了すると client がポートを引き継ぐ）。
 */
const TAKEOVER_BRIDGE = `import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const handler = (req, res) => {
  res.writeHead(req.url === "/_mxstage/health" ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify(req.url === "/_mxstage/health" ? { name: "mxstage-bridge", pid: process.pid } : { ok: false }));
};
function tryListen() {
  const server = createServer(handler);
  server.once("error", () => setTimeout(tryListen, 500));
  server.listen(port, "127.0.0.1");
}
tryListen();
`;

/**
 * 偽の claude コマンド。呼ばれた引数を 1 行ずつ記録し、`mcp add` / `mcp remove` を差し替えた書き先（configPath）に反映する。
 * Windows では .cmd（setup-local.mjs は .cmd をシェル経由で呼ぶ）、それ以外は sh のスクリプト。
 */
function makeFakeClaude(dir, configPath) {
  mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "fake-claude.log");
  const script = path.join(dir, "fake-claude.mjs");
  writeFileSync(
    script,
    [
      'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
      `const CONFIG = ${JSON.stringify(configPath)};`,
      `const LOG = ${JSON.stringify(log)};`,
      "const args = process.argv.slice(2);",
      'appendFileSync(LOG, JSON.stringify(args) + "\\n");',
      'const read = () => (existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8") || "{}") : {});',
      "const write = (json) => writeFileSync(CONFIG, JSON.stringify(json, null, 2));",
      'if (args[0] === "mcp" && args[1] === "remove") { const j = read(); if (j.mcpServers) delete j.mcpServers[args[4]]; write(j); process.exit(0); }',
      'if (args[0] === "mcp" && args[1] === "add") {',
      '  const j = read(); const name = args[4]; const sep = args.indexOf("--"); j.mcpServers = j.mcpServers || {};',
      '  if (j.mcpServers[name]) { console.error("already exists"); process.exit(1); }',
      '  j.mcpServers[name] = { type: "stdio", command: args[sep + 1], args: args.slice(sep + 2), env: {} }; write(j); process.exit(0);',
      "}",
      "process.exit(1);",
      "",
    ].join("\n"),
    "utf8",
  );
  let exe;
  if (IS_WINDOWS) {
    exe = path.join(dir, "claude.cmd");
    writeFileSync(exe, `@"${process.execPath}" "${script}" %*\r\n`, "utf8");
  } else {
    exe = path.join(dir, "claude");
    writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, "utf8");
    chmodSync(exe, 0o755);
  }
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  return { exe, log, calls };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** main() を動かし、画面に出したものを受け取る（試験の出力は汚さない） */
async function runMain(argv) {
  const log = console.log;
  const error = console.error;
  const stdout = [];
  const stderr = [];
  console.log = (...a) => stdout.push(a.join(" "));
  console.error = (...a) => stderr.push(a.join(" "));
  try {
    const code = await main(argv);
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** --json を付けて動かし、結果（steps・result）を読む */
async function runJson(argv) {
  const run = await runMain([...argv, "--json"]);
  return { ...run, json: run.stdout ? JSON.parse(run.stdout) : null };
}

async function quietMain(argv) {
  return (await runMain(argv)).code;
}

const stepOf = (json, id) => json.steps.filter((s) => s.id === id);

/** 一時フォルダに差し替えた共通の引数 */
function sandboxArgs(dir, extra = []) {
  return [
    "--no-open",
    // 本物のリポジトリで npm install / npm run build を動かさない（試験の囲いが求める）
    "--no-install",
    "--no-build",
    "--state-dir",
    path.join(dir, "state"),
    "--claude-code-config",
    path.join(dir, "claude-code.json"),
    "--claude-desktop-config",
    path.join(dir, "claude_desktop_config.json"),
    "--startup-dir",
    path.join(dir, "startup"),
    "--desktop-dir",
    path.join(dir, "desktop"),
    "--claude-skills-dir",
    path.join(dir, "claude-skills"),
    // フォルダは作らない（Antigravity を入れていない PC と同じ。作った試験だけが Antigravity に登録する）
    "--antigravity-dir",
    path.join(dir, "gemini"),
    // Codex も同じ（~/.codex を作った試験だけが登録し、~/.agents/skills に Skill を写す）
    "--codex-dir",
    path.join(dir, "codex"),
    "--agents-skills-dir",
    path.join(dir, "agents-skills"),
    // IBM Bob も同じ（~/.bob を作った試験だけが登録する）
    "--bob-dir",
    path.join(dir, "bob"),
    ...extra,
  ];
}

/**
 * 試験の途中で失敗したときに、導入が裏で起動した偽の橋渡し（detached で残る）を止める。
 * 偽の橋渡しは /_mxstage/health に自分の pid を載せるので、それを止める（本物の橋渡しは pid を返さないので触れない）。
 */
async function stopFakeBridgeOn(port) {
  try {
    const probe = await probeBridge(port, 500);
    if (probe.state === "bridge" && Number.isInteger(probe.health?.pid) && probe.health.pid !== process.pid) process.kill(probe.health.pid);
  } catch {
    // もう止まっている
  }
}

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

// ---------------------------------------------------------------------------
// 橋渡しが 1 つ動いているかを /_mxstage/health で確かめる
// ---------------------------------------------------------------------------

test("isBridgeHealth / singleBridgeStep: /_mxstage/health の応答で「橋渡しが 1 つ動いている」と出す", () => {
  assert.equal(isBridgeHealth({ name: "mxstage-bridge" }), true);
  assert.equal(isBridgeHealth({ name: "other" }), false);
  assert.equal(isBridgeHealth(null), false);
  assert.equal(isBridgeHealth([]), false);

  const ok = singleBridgeStep(8788, { state: "bridge", health: { name: "mxstage-bridge", pid: 1234 }, legacy: false });
  assert.equal(ok.level, "ok");
  assert.match(ok.message, /1 つ動いています/);
  assert.match(ok.message, /\/_mxstage\/health/);
  assert.match(ok.message, /プロセス 1234/);
  assert.match(ok.hint, /中継/);

  const legacy = singleBridgeStep(8788, { state: "bridge", health: null, legacy: true });
  assert.equal(legacy.level, "warn");
  assert.match(legacy.message, /古い版/);

  assert.equal(singleBridgeStep(8788, { state: "other", health: null }).level, "warn");
  assert.equal(singleBridgeStep(8788, { state: "down", health: null }).level, "warn");
  assert.equal(singleBridgeStep(8788, { state: "down", health: null }, false).level, "skip");
});

test("decidePort: 橋渡しが居れば使い、空いていれば使い、ほかのものが使っていれば busy（ずらさない）", async () => {
  const bridge = async () => ({ state: "bridge", health: { name: "mxstage-bridge" }, legacy: false });
  const down = async () => ({ state: "down", health: null, legacy: false });
  assert.deepEqual(await decidePort(19001, bridge, async () => false), { port: 19001, reused: true, busy: false, health: { name: "mxstage-bridge" }, legacy: false });
  assert.deepEqual(await decidePort(19001, down, async () => true), { port: 19001, reused: false, busy: false, health: null, legacy: false });
  const busy = await decidePort(19001, async () => ({ state: "other", health: null, legacy: false }), async () => false);
  assert.equal(busy.busy, true);
  assert.equal(busy.port, 19001, "隣のポートへずらさない");
  // 橋渡しでないものが 127.0.0.1 に応えているなら、127.0.0.1 だけの待ち受けが通っても（0.0.0.0 で待ち受けているプログラムなど）使わない
  const answeredButBindable = await decidePort(19001, async () => ({ state: "other", health: null, legacy: false }), async () => true);
  assert.equal(answeredButBindable.busy, true);
});

test("expectedPeerProtocol / singleBridgeStep: 動いている橋渡しと取り決めの版（protocol）が違えば警告する", () => {
  const entry = path.join(REPO_ROOT, "src", "bridge", "cli.ts");
  // このリポジトリの本物の peer.ts から読める（数だけを見る）
  assert.ok(Number.isInteger(expectedPeerProtocol(entry)), "src/bridge/peer.ts の BRIDGE_PEER_PROTOCOL を読める");
  assert.equal(expectedPeerProtocol(ENTRY, () => "export const BRIDGE_PEER_PROTOCOL = 3;\n"), 3);
  assert.equal(expectedPeerProtocol(ENTRY, () => "// 無い"), null);
  assert.equal(
    expectedPeerProtocol(ENTRY, () => {
      throw new Error("ENOENT");
    }),
    null,
  );
  assert.equal(expectedPeerProtocol(null), null);

  const health = (protocol) => ({ state: "bridge", health: { name: "mxstage-bridge", version: "0.1.0", protocol }, legacy: false });
  assert.equal(singleBridgeStep(8788, health(1), true, 1).level, "ok");
  const mismatch = singleBridgeStep(8788, health(1), true, 2);
  assert.equal(mismatch.level, "warn");
  assert.match(mismatch.message, /取り決めの版が違います/);
  assert.match(mismatch.hint, /中継できず/);
  // 分からないときは比べない
  assert.equal(singleBridgeStep(8788, health(1), true, null).level, "ok");
  assert.equal(singleBridgeStep(8788, health(undefined), true, 2).level, "ok");
});

test("probeBridge: 今の橋渡し・古い版・ほかのもの・何も無い、を見分ける", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-probe-"));
  const children = [];
  const servers = [];
  try {
    const current = path.join(dir, "fake-bridge.mjs");
    const legacy = path.join(dir, "legacy-bridge.mjs");
    writeFileSync(current, FAKE_BRIDGE, "utf8");
    writeFileSync(legacy, LEGACY_BRIDGE, "utf8");
    const [pCurrent, pLegacy, pOther, pDown] = [await freePort(), await freePort(), await freePort(), await freePort()];
    children.push(spawn(process.execPath, [current, "--port", String(pCurrent)], { stdio: "ignore", windowsHide: true }));
    children.push(spawn(process.execPath, [legacy, "--port", String(pLegacy)], { stdio: "ignore", windowsHide: true }));
    const other = createHttpServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
    });
    servers.push(other);
    await new Promise((resolve) => other.listen(pOther, "127.0.0.1", resolve));
    assert.ok(await waitFor(async () => (await probeBridge(pCurrent)).state === "bridge"));
    assert.ok(await waitFor(async () => (await probeBridge(pLegacy)).state === "bridge"));

    const a = await probeBridge(pCurrent);
    assert.equal(a.legacy, false);
    assert.equal(a.health.name, "mxstage-bridge");
    assert.equal(a.health.pid, children[0].pid);
    const b = await probeBridge(pLegacy);
    assert.equal(b.legacy, true);
    assert.equal(b.health, null);
    assert.equal((await probeBridge(pOther)).state, "other");
    assert.equal((await probeBridge(pDown)).state, "down");
  } finally {
    for (const child of children) child.kill();
    for (const server of servers) server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 導入と取り消しをひと通り（偽の橋渡しと一時フォルダで）
// ---------------------------------------------------------------------------

test("導入 → もう一度導入 → 取り消し（設定は壊れず、前の設定に戻る。橋渡しは 1 つと確かめる）", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-setup-"));
  let port = null;
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    const codeConfig = path.join(dir, "claude-code.json");
    const desktopConfig = path.join(dir, "claude_desktop_config.json");
    const oldEntry = { type: "http", url: "https://mxstage.example.workers.dev/mcp", headers: { Authorization: "Bearer OLD-PAT" } };
    const otherEntry = { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer KEEP-ME" } };
    writeFileSync(codeConfig, JSON.stringify({ numStartups: 3, mcpServers: { other: otherEntry, mxstage: oldEntry } }, null, 2), "utf8");
    writeFileSync(desktopConfig, JSON.stringify({ preferences: { sidebarMode: "epitaxy" } }, null, 2), "utf8");

    // 利用者の Skill（状態フォルダの skills の下）。既定と同じ名前のものは入れない
    const userSkillsDir = path.join(dir, "state", "skills");
    const userSkillText = '---\nname: my-flow\ndescription: "業務の手順"\nmetadata:\n  version: "0.1.0"\n---\n\n# 業務の手順\n';
    const putUserSkill = () => {
      mkdirSync(path.join(userSkillsDir, "my-flow"), { recursive: true });
      writeFileSync(path.join(userSkillsDir, "my-flow", "SKILL.md"), userSkillText, "utf8");
    };
    putUserSkill();
    mkdirSync(path.join(userSkillsDir, "mxstage-workbench"), { recursive: true });
    writeFileSync(path.join(userSkillsDir, "mxstage-workbench", "SKILL.md"), userSkillText.replace("my-flow", "mxstage-workbench"), "utf8");

    port = await freePort();
    const common = [...sandboxArgs(dir), "--no-autostart", "--no-shortcut", "--port", String(port), "--bridge", bridge];

    // --- 導入 ---
    const first = await runJson(common);
    assert.equal(first.code, 0, first.stdout);

    const afterInstall = JSON.parse(readFileSync(codeConfig, "utf8"));
    assert.deepEqual(afterInstall.mcpServers.other, otherEntry, "ほかの MCP サーバを消していない");
    assert.equal(afterInstall.numStartups, 3, "MCP 以外の設定を消していない");
    assert.equal(afterInstall.mcpServers.mxstage.command, process.execPath);
    assert.deepEqual(afterInstall.mcpServers.mxstage.args, [bridge, "--port", String(port)]);

    const afterDesktop = JSON.parse(readFileSync(desktopConfig, "utf8"));
    assert.deepEqual(afterDesktop.preferences, { sidebarMode: "epitaxy" });
    assert.deepEqual(afterDesktop.mcpServers.mxstage.args, [bridge, "--port", String(port)]);

    const state = JSON.parse(readFileSync(path.join(dir, "state", "setup.json"), "utf8"));
    assert.equal(state.port, port);
    assert.equal(state.bridgeEntry, bridge);
    assert.equal(JSON.stringify(state).includes("OLD-PAT"), false, "記録にトークンを書いていない");
    assert.equal(state.previous.claudeCode.entry.headers.Authorization, "<伏せ>");
    assert.ok(existsSync(state.previous.claudeCode.backup), "書き換える前の控えがある");
    assert.equal(first.stdout.includes("OLD-PAT"), false, "画面にもトークンを出さない");

    // 橋渡しが 1 つ動いていることを /_mxstage/health で確かめて出す。「2 つ動く」警告はもう出さない
    const single = stepOf(first.json, "bridge_single");
    assert.equal(single.length, 1);
    assert.equal(single[0].level, "ok");
    assert.match(single[0].message, /1 つ動いています/);
    assert.equal(stepOf(first.json, "two_bridges").length, 0);
    assert.equal(first.json.steps.some((s) => /隣のポートで別に動きます/.test(s.message)), false);

    const probe = await probeBridge(port);
    assert.equal(probe.state, "bridge", "橋渡しが起動している");
    assert.equal(probe.legacy, false);
    assert.ok(isInside(dir, probe.health.keyFile), `試験中に起動した橋渡しの鍵ファイルは一時フォルダの中: ${probe.health.keyFile}`);

    // --- 状態を見る（何も書き換えない）---
    const status = await runJson([...common, "--status"]);
    assert.equal(stepOf(status.json, "bridge_single")[0].level, "ok");
    assert.deepEqual(JSON.parse(readFileSync(codeConfig, "utf8")), afterInstall);

    // --- もう一度（冪等）---
    assert.equal(await quietMain(common), 0);
    const again = JSON.parse(readFileSync(codeConfig, "utf8"));
    assert.deepEqual(again, afterInstall, "2 回目は何も変えない");

    // --- Skill（Claude Code の置き場所を一時フォルダに差し替えている）---
    const skillsDir = path.join(dir, "claude-skills");
    const repoSkills = readRepoSkills(path.resolve(import.meta.dirname, "..", ".."));
    assert.ok(repoSkills.length >= 1, "リポジトリの Skill（アプリ既定）を読めている");
    for (const skill of repoSkills) {
      assert.equal(readFileSync(path.join(skillsDir, skill.name, "SKILL.md"), "utf8"), skill.text, `${skill.name} を入れた`);
    }
    // 利用者の Skill も入る。既定と同じ名前のものは入れず、既定の中身のまま
    assert.equal(readFileSync(path.join(skillsDir, "my-flow", "SKILL.md"), "utf8"), userSkillText.replace(/\r\n/g, "\n"));
    assert.deepEqual(
      state.installed.skills.map((sk) => [sk.name, sk.origin]),
      [...repoSkills.map((sk) => [sk.name, "default"]), ["my-flow", "user"]],
    );
    assert.equal(stepOf(first.json, "skills")[0].level, "ok");
    assert.match(stepOf(first.json, "skills")[0].message, /利用者の Skill: my-flow/);
    assert.match(stepOf(first.json, "skills")[0].hint, /SKILL\.md/);
    assert.doesNotMatch(stepOf(first.json, "skills")[0].hint, /カスタマイズ > スキル/, "ZIP の手作業は案内しない");
    assert.equal(stepOf(first.json, "user_skills")[0].level, "warn");
    assert.match(stepOf(first.json, "user_skills")[0].message, /アプリ既定と同じ名前/);

    // 利用者が Skill を消したら、次の導入で Claude Code からも消える（書き換えていなければ）
    rmSync(path.join(userSkillsDir, "my-flow"), { recursive: true, force: true });
    const retired = await runJson(common);
    assert.equal(retired.code, 0, retired.stdout);
    assert.equal(existsSync(path.join(skillsDir, "my-flow")), false, "消えた利用者の Skill を片付ける");
    assert.match(stepOf(retired.json, "skills_retired")[0].message, /my-flow/);
    putUserSkill();
    assert.equal(await quietMain(common), 0);
    assert.equal(existsSync(path.join(skillsDir, "my-flow", "SKILL.md")), true, "置き直せば入る");
    assert.equal(stepOf(status.json, "skills")[0].level, "ok");

    // --- 取り消し ---
    // 利用者が書き換えた Skill は残し、入れたままのものは消す
    const edited = path.join(skillsDir, repoSkills[0].name, "SKILL.md");
    writeFileSync(edited, `${repoSkills[0].text}\n利用者のメモ\n`, "utf8");
    assert.equal(await quietMain([...common, "--uninstall"]), 0);
    assert.equal(existsSync(edited), true, "書き換えられた Skill は残す");
    for (const skill of repoSkills.slice(1)) assert.equal(existsSync(path.join(skillsDir, skill.name)), false, `${skill.name} は消す`);
    assert.equal(existsSync(path.join(skillsDir, "my-flow")), false, "入れたままの利用者の Skill は消す");
    assert.equal(existsSync(path.join(userSkillsDir, "my-flow", "SKILL.md")), true, "利用者の Skill の元は消さない");
    const afterUninstall = JSON.parse(readFileSync(codeConfig, "utf8"));
    assert.deepEqual(afterUninstall.mcpServers.mxstage, oldEntry, "置き換える前の設定に戻る（トークンごと）");
    assert.deepEqual(afterUninstall.mcpServers.other, otherEntry);
    const desktopAfterUninstall = JSON.parse(readFileSync(desktopConfig, "utf8"));
    assert.equal("mxstage" in (desktopAfterUninstall.mcpServers ?? {}), false, "Claude Desktop からは外れる");
    assert.deepEqual(desktopAfterUninstall.preferences, { sidebarMode: "epitaxy" });
    assert.equal(existsSync(path.join(dir, "state", "setup.json")), false, "記録は消える");

    if (IS_WINDOWS) {
      const after = await probeBridge(port);
      assert.equal(after.state, "down", "橋渡しは止まっている");
    }
  } finally {
    // 途中で失敗したとき・Windows 以外（取り消しで止められない）で、裏で起動した橋渡しを残さない
    if (port !== null) await stopFakeBridgeOn(port);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("壊れた既存登録（指すファイルが無い）は戻す先として記録せず、画面にそう出し、取り消しでは外すだけ", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-broken-"));
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    const codeConfig = path.join(dir, "claude-code.json");
    const desktopConfig = path.join(dir, "claude_desktop_config.json");
    const gone = path.join(dir, "消したリポジトリ", "server.mjs");
    const brokenCode = { type: "stdio", command: process.execPath, args: [gone, "--token", "SECRET-XYZ"], env: {} };
    const missingExe = path.join(dir, "no-such-node", "node.exe");
    const brokenDesktop = { command: missingExe, args: [] };
    const other = { type: "http", url: "https://example.test/mcp" };
    writeFileSync(codeConfig, JSON.stringify({ mcpServers: { other, mxstage: brokenCode } }), "utf8");
    writeFileSync(desktopConfig, JSON.stringify({ mcpServers: { mxstage: brokenDesktop } }), "utf8");
    const port = await freePort();
    const args = [...sandboxArgs(dir), "--no-start", "--no-autostart", "--no-shortcut", "--port", String(port), "--bridge", bridge];

    const install = await runJson(args);
    assert.equal(install.code, 0, install.stdout);
    const state = JSON.parse(readFileSync(path.join(dir, "state", "setup.json"), "utf8"));
    assert.equal(state.previous.claudeCode, null, "Claude Code の壊れた登録を戻す先として記録していない");
    assert.equal(state.previous.claudeDesktop, null, "Claude Desktop の壊れた登録も記録していない");

    const codePrev = stepOf(install.json, "claude_code_prev");
    assert.equal(codePrev.length, 1);
    assert.equal(codePrev[0].level, "warn");
    assert.match(codePrev[0].message, /戻す先としては記録しません/);
    assert.ok(codePrev[0].message.includes(gone), "見つからないファイルを出す");
    const desktopPrev = stepOf(install.json, "claude_desktop_prev");
    assert.ok(desktopPrev[0].message.includes(missingExe));
    assert.equal(install.stdout.includes("SECRET-XYZ"), false, "壊れた登録の秘密も画面に出さない");
    assert.equal(JSON.stringify(state).includes("SECRET-XYZ"), false);

    assert.equal(await quietMain([...args, "--uninstall"]), 0);
    const code = JSON.parse(readFileSync(codeConfig, "utf8"));
    assert.equal("mxstage" in code.mcpServers, false, "壊れた登録には戻さず、外すだけ");
    assert.deepEqual(code.mcpServers.other, other);
    const desktop = JSON.parse(readFileSync(desktopConfig, "utf8"));
    assert.equal("mxstage" in desktop.mcpServers, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("古い版の導入が壊れた登録を記録していても、取り消しではそこに戻さない", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-oldrec-"));
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    const port = await freePort();
    const codeConfig = path.join(dir, "claude-code.json");
    const ours = buildCodeEntry(process.execPath, bridge, port);
    writeFileSync(codeConfig, JSON.stringify({ mcpServers: { mxstage: ours } }), "utf8");
    // 古い版の導入が残した記録と控え（控えの中身は、今は無いファイルを指す登録）
    const backupDir = path.join(dir, "state", "backup");
    mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, "claude-code.json.old.bak");
    const gone = path.join(dir, "gone", "server.mjs");
    writeFileSync(backup, JSON.stringify({ mcpServers: { mxstage: { command: process.execPath, args: [gone] } } }), "utf8");
    writeFileSync(
      path.join(dir, "state", "setup.json"),
      JSON.stringify({ version: 1, bridgeEntry: bridge, nodePath: process.execPath, port, previous: { claudeCode: { backup, entry: { command: process.execPath } } } }),
      "utf8",
    );

    const run = await runJson([...sandboxArgs(dir), "--uninstall", "--port", String(port), "--bridge", bridge]);
    assert.equal(run.code, 0, run.stdout);
    const code = JSON.parse(readFileSync(codeConfig, "utf8"));
    assert.equal("mxstage" in code.mcpServers, false, "壊れた登録に戻していない");
    assert.ok(stepOf(run.json, "claude_code").some((s) => s.level === "warn" && /戻しません/.test(s.message)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ポートを橋渡しではないものが使っていると、ずらさずに NG で止まり、何も書き換えない", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-busy-"));
  const other = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("not a bridge");
  });
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    const codeConfig = path.join(dir, "claude-code.json");
    const before = JSON.stringify({ mcpServers: {} });
    writeFileSync(codeConfig, before, "utf8");
    const port = await freePort();
    await new Promise((resolve) => other.listen(port, "127.0.0.1", resolve));

    const run = await runJson([...sandboxArgs(dir), "--no-autostart", "--no-shortcut", "--port", String(port), "--bridge", bridge]);
    assert.equal(run.code, 1);
    const portStep = stepOf(run.json, "port");
    assert.equal(portStep[0].level, "error");
    assert.match(portStep[0].hint, /ずらしません/);
    assert.equal(run.json.steps.some((s) => s.id === "bridge_start"), false, "橋渡しを起動しない");
    assert.equal(readFileSync(codeConfig, "utf8"), before, "設定は変わらない");
    assert.equal(existsSync(path.join(dir, "claude_desktop_config.json")), false);
    assert.equal(existsSync(path.join(dir, "state", "setup.json")), false, "記録も書かない");
  } finally {
    other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("古い版の橋渡し（/_mxstage/health が無い）が動いていると、そう知らせる", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-legacy-"));
  let child = null;
  try {
    const legacy = path.join(dir, "legacy-bridge.mjs");
    writeFileSync(legacy, LEGACY_BRIDGE, "utf8");
    const port = await freePort();
    child = spawn(process.execPath, [legacy, "--port", String(port)], { stdio: "ignore", windowsHide: true });
    assert.ok(await waitFor(async () => (await probeBridge(port)).state === "bridge"));

    const run = await runJson([...sandboxArgs(dir), "--status", "--port", String(port), "--bridge", legacy]);
    const single = stepOf(run.json, "bridge_single");
    assert.equal(single[0].level, "warn");
    assert.match(single[0].message, /古い版/);
  } finally {
    child?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude コマンドは差し替えられる（一時フォルダの偽物で登録し、呼ばれた引数を確かめる）", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-fakecli-"));
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    const codeConfig = path.join(dir, ".claude.json");
    const cloud = { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer CLOUD-PAT" } };
    writeFileSync(codeConfig, JSON.stringify({ mcpServers: { mxstage: cloud } }, null, 2), "utf8");
    const fake = makeFakeClaude(path.join(dir, "bin"), codeConfig);
    const port = await freePort();

    const run = await runJson([
      ...sandboxArgs(dir),
      "--claude-code-config",
      codeConfig,
      "--claude-cli",
      fake.exe,
      "--no-start",
      "--no-autostart",
      "--no-shortcut",
      "--port",
      String(port),
      "--bridge",
      bridge,
    ]);
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(fake.calls(), [
      ["mcp", "remove", "--scope", "user", "mxstage"],
      ["mcp", "add", "--scope", "user", "mxstage", "--", process.execPath, bridge, "--port", String(port)],
    ]);
    const after = JSON.parse(readFileSync(codeConfig, "utf8"));
    assert.equal(isSameEntry(after.mcpServers.mxstage, buildCodeEntry(process.execPath, bridge, port)), true);
    assert.match(stepOf(run.json, "claude_code")[0].message, /claude コマンド/);
    const state = JSON.parse(readFileSync(path.join(dir, "state", "setup.json"), "utf8"));
    assert.ok(state.previous.claudeCode.backup, "置き換える前の利用者の設定は戻す先として記録する");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "試験中は、PATH に claude があり書き先が既定の場所（CLAUDE_CONFIG_DIR）でも、claude コマンドを呼ばない（子プロセスで確かめる）",
  { timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-noclaude-"));
    try {
      const bridge = path.join(dir, "fake-bridge.mjs");
      writeFileSync(bridge, FAKE_BRIDGE, "utf8");
      const home = path.join(dir, "home");
      const configDir = path.join(dir, "claude-config");
      mkdirSync(home);
      mkdirSync(configDir);
      const codeConfig = path.join(configDir, ".claude.json");
      writeFileSync(codeConfig, "{}", "utf8");
      const bin = path.join(dir, "bin");
      const fake = makeFakeClaude(bin, codeConfig);
      const systemRoot = process.env.SystemRoot || "C:\\Windows";
      const pathDirs = IS_WINDOWS
        ? [bin, path.dirname(process.execPath), path.join(systemRoot, "System32"), path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")]
        : [bin, path.dirname(process.execPath), "/usr/bin", "/bin"];
      // 利用者のホーム・設定の場所も一時フォルダに向ける（万一既定の場所を使っても本物に届かない）
      const env = {
        PATH: pathDirs.join(path.delimiter),
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
        SystemRoot: systemRoot,
        windir: process.env.windir ?? systemRoot,
        ComSpec: process.env.ComSpec ?? path.join(systemRoot, "System32", "cmd.exe"),
        TEMP: os.tmpdir(),
        TMP: os.tmpdir(),
        TMPDIR: os.tmpdir(),
        USERPROFILE: home,
        HOME: home,
        APPDATA: path.join(home, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(home, "AppData", "Local"),
        CLAUDE_CONFIG_DIR: configDir,
        MXSTAGE_SETUP_TEST: "1",
      };
      if (IS_WINDOWS) {
        // 対照: この PATH なら claude として偽物が見つかる（場所を調べるだけで、claude は呼ばない）
        const where = spawnSync("where", ["claude"], { env, encoding: "utf8", windowsHide: true });
        const first = (where.stdout ?? "").split(/\r?\n/).find((l) => l.trim());
        assert.equal(first?.toLowerCase(), fake.exe.toLowerCase());
      }
      const port = await freePort();
      const run = spawnSync(
        process.execPath,
        [
          SETUP_SCRIPT,
          "--json",
          ...sandboxArgs(dir),
          "--claude-code-config",
          codeConfig,
          "--no-start",
          "--no-autostart",
          "--no-shortcut",
          "--no-install",
          "--no-build",
          "--port",
          String(port),
          "--bridge",
          bridge,
        ],
        { env, cwd: REPO_ROOT, encoding: "utf8", timeout: 50_000, windowsHide: true },
      );
      assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
      assert.deepEqual(fake.calls(), [], "claude コマンド（偽物）は 1 回も呼ばれていない");
      const json = JSON.parse(run.stdout);
      assert.equal(json.paths.claudeCodeConfigDefault.toLowerCase(), codeConfig.toLowerCase(), "書き先は、この環境での既定の場所だった");
      assert.doesNotMatch(stepOf(json, "claude_code")[0].message, /claude コマンド/, "自分で書いた");
      const after = JSON.parse(readFileSync(codeConfig, "utf8"));
      assert.equal(isSameEntry(after.mcpServers.mxstage, buildCodeEntry(process.execPath, bridge, port)), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("記録を無くしてから入れ直しても、取り消しで古い自分の設定に「戻さない」", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-relost-"));
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    const codeConfig = path.join(dir, "claude-code.json");
    writeFileSync(codeConfig, JSON.stringify({ mcpServers: { other: { type: "http", url: "https://example.test/mcp" } } }), "utf8");
    const [portA, portB] = [await freePort(), await freePort()];
    const base = ["--no-start", "--no-autostart", "--no-shortcut", "--bridge", bridge];

    assert.equal(await quietMain(sandboxArgs(dir, [...base, "--port", String(portA)])), 0);
    rmSync(path.join(dir, "state", "setup.json"));
    const second = await runJson(sandboxArgs(dir, [...base, "--port", String(portB)]));
    assert.equal(second.code, 0);
    const state = JSON.parse(readFileSync(path.join(dir, "state", "setup.json"), "utf8"));
    assert.equal(state.previous.claudeCode, null, "自分の古い設定（ポート A）を戻す先として覚えていない");
    assert.match(stepOf(second.json, "claude_code_prev")[0].message, /前回この導入が書いたもの/, "記録しないことを画面に出す");

    assert.equal(await quietMain(sandboxArgs(dir, [...base, "--uninstall", "--port", String(portB)])), 0);
    const after = JSON.parse(readFileSync(codeConfig, "utf8"));
    assert.equal("mxstage" in after.mcpServers, false, "外れる（ポート A の設定に戻っていない）");
    assert.deepEqual(after.mcpServers.other, { type: "http", url: "https://example.test/mcp" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "記録が無くても、ポートで待ち受けている橋渡しを確かめてから止める／同じファイル名でも別の場所のプロセスは止めない",
  { timeout: 180_000, skip: !IS_WINDOWS && "プロセスの確認は Windows だけ" },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-stop-"));
    const children = [];
    try {
      const bridge = path.join(dir, "fake-bridge.mjs");
      writeFileSync(bridge, FAKE_BRIDGE, "utf8");
      // 同じファイル名で別の場所にある、無関係なプロセス（止めてはいけない）
      mkdirSync(path.join(dir, "other"));
      const decoy = path.join(dir, "other", "fake-bridge.mjs");
      writeFileSync(decoy, FAKE_BRIDGE, "utf8");

      const [port, decoyPort] = [await freePort(), await freePort()];
      children.push(spawn(process.execPath, [bridge, "--no-mcp", "--port", String(port)], { stdio: "ignore", windowsHide: true }));
      children.push(spawn(process.execPath, [decoy, "--no-mcp", "--port", String(decoyPort)], { stdio: "ignore", windowsHide: true }));
      assert.ok(await waitFor(async () => (await probeBridge(port)).state === "bridge"));
      assert.ok(await waitFor(async () => (await probeBridge(decoyPort)).state === "bridge"));

      // 記録（setup.json）は無い。入口は bridge。decoy のポートを指定しても止めない
      assert.equal(await quietMain(sandboxArgs(dir, ["--uninstall", "--bridge", bridge, "--port", String(decoyPort)])), 0);
      assert.equal((await probeBridge(decoyPort)).state, "bridge", "入口が違うプロセスは止めない");

      // 入口が一致するプロセスは、記録が無くてもポートから見つけて止める
      assert.equal(await quietMain(sandboxArgs(dir, ["--uninstall", "--bridge", bridge, "--port", String(port)])), 0);
      assert.equal((await probeBridge(port)).state, "down", "ポートで待ち受けている橋渡しを止めた");
    } finally {
      for (const child of children) child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "取り消しで橋渡しを止めたあと、別の橋渡し（Claude が起動した client 役）がポートを引き継いだら、止めずに知らせる",
  { timeout: 180_000, skip: !IS_WINDOWS && "プロセスの確認は Windows だけ" },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-takeover-"));
    let client = null;
    let port = null;
    try {
      const bridge = path.join(dir, "fake-bridge.mjs");
      writeFileSync(bridge, FAKE_BRIDGE, "utf8");
      const clientScript = path.join(dir, "client", "fake-bridge.mjs");
      mkdirSync(path.dirname(clientScript));
      writeFileSync(clientScript, TAKEOVER_BRIDGE, "utf8");
      port = await freePort();
      const args = [...sandboxArgs(dir), "--no-autostart", "--no-shortcut", "--bridge", bridge, "--port", String(port)];

      assert.equal(await quietMain(args), 0);
      const primary = await probeBridge(port);
      assert.equal(primary.state, "bridge");
      client = spawn(process.execPath, [clientScript, "--port", String(port)], { stdio: "ignore", windowsHide: true });
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      const run = await runJson([...args, "--uninstall"]);
      assert.equal(run.code, 0, run.stdout);
      assert.equal(stepOf(run.json, "bridge_stop")[0].level, "ok", "画面用の橋渡しは止めた");
      const takeover = stepOf(run.json, "bridge_takeover");
      assert.equal(takeover.length, 1, JSON.stringify(run.json.steps));
      assert.match(takeover[0].message, new RegExp(`プロセス ${client.pid}`));
      const after = await probeBridge(port);
      assert.equal(after.health?.pid, client.pid, "引き継いだ橋渡しは止めていない");
    } finally {
      client?.kill();
      // 途中で失敗して、導入が起動した画面用の偽の橋渡しが残っていれば止める
      if (port !== null) await stopFakeBridgeOn(port);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Claude Code / Claude Desktop が起動した橋渡し（--no-mcp なし）がポートを持っていたら、導入はそう出し、取り消しでも止めない",
  { timeout: 120_000, skip: !IS_WINDOWS && "プロセスの確認は Windows だけ" },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-claudeowned-"));
    let claudeBridge = null;
    try {
      const bridge = path.join(dir, "fake-bridge.mjs");
      writeFileSync(bridge, FAKE_BRIDGE, "utf8");
      const port = await freePort();
      // Claude の登録と同じ形（node <入口> --port <番号>。--no-mcp が無い）で起動したもの
      claudeBridge = spawn(process.execPath, [bridge, "--port", String(port)], { stdio: "ignore", windowsHide: true });
      assert.ok(await waitFor(async () => (await probeBridge(port)).state === "bridge"));
      const args = [...sandboxArgs(dir), "--no-autostart", "--no-shortcut", "--bridge", bridge, "--port", String(port)];

      const install = await runJson(args);
      assert.equal(install.code, 0, install.stdout);
      const started = stepOf(install.json, "bridge_start");
      assert.equal(started.length, 1, JSON.stringify(install.json.steps));
      assert.match(started[0].message, new RegExp(`Claude Code / Claude Desktop が起動したもの（プロセス ${claudeBridge.pid}）`));
      const state = JSON.parse(readFileSync(path.join(dir, "state", "setup.json"), "utf8"));
      assert.equal(state.bridgePid, null, "Claude が起動した橋渡しの番号は記録しない");

      const uninstall = await runJson([...args, "--uninstall"]);
      assert.equal(uninstall.code, 0, uninstall.stdout);
      const stop = stepOf(uninstall.json, "bridge_stop");
      assert.equal(stop[0].level, "warn");
      assert.match(stop[0].message, /止めていません/);
      assert.equal((await probeBridge(port)).health?.pid, claudeBridge.pid, "Claude が起動した橋渡しは動いたまま");
      assert.equal(claudeBridge.exitCode, null);
    } finally {
      claudeBridge?.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// 改名前（mxstudio）からの移行
// ---------------------------------------------------------------------------

/** 改名前の偽の橋渡し。/_mxstudio/health に mxstudio-bridge と応え、ポートが塞がっていれば空くまで待って引き継ぐ */
const RENAMED_BRIDGE = `import { createServer } from "node:http";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const handler = (req, res) => {
  if (req.url === "/_mxstudio/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "mxstudio-bridge", protocol: 1, pid: process.pid }));
    return;
  }
  if (req.url === "/ws") {
    res.writeHead(426, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "upgrade_required" }));
    return;
  }
  // 改名前の橋渡しは、知らない経路に画面の HTML を返す
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>mxstudio</title>");
};
function tryListen() {
  const server = createServer(handler);
  server.once("error", () => setTimeout(tryListen, 200));
  server.listen(port, "127.0.0.1");
}
tryListen();
`;

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

test("parseArgs / legacyStateDirOf: --legacy-state-dir を受け、無ければ ~/.config/mxstudio", () => {
  assert.equal(parseArgs([]).legacyStateDir, null);
  assert.equal(parseArgs(["--legacy-state-dir", "x"]).legacyStateDir, "x");
  assert.equal(legacyStateDirOf(parseArgs([]), path.join("C:", "home")), path.join("C:", "home", ".config", "mxstudio"));
  assert.equal(legacyStateDirOf(parseArgs(["--legacy-state-dir", path.join(os.tmpdir(), "old")])), path.join(os.tmpdir(), "old"));
});

test("testSandboxProblem: --legacy-state-dir も一時フォルダの中で、本物の置き場所（~/.config/mxstudio）は拒む", () => {
  const tmp = path.join(os.tmpdir(), "mxs-guard");
  const base = { ...parseArgs([]), stateDir: path.join(tmp, "s"), claudeCodeConfig: path.join(tmp, "a.json"), claudeDesktopConfig: path.join(tmp, "b.json"), startupDir: path.join(tmp, "st"), desktopDir: path.join(tmp, "d"), skills: false, antigravity: false, codex: false, bob: false, port: 1234, bridge: "x", open: false, install: false, build: false };
  assert.equal(testSandboxProblem(base, os.tmpdir(), []), null);
  assert.match(testSandboxProblem({ ...base, legacyStateDir: path.join(os.homedir(), "elsewhere") }, os.tmpdir(), []) ?? "", /--legacy-state-dir が一時フォルダ/);
  const real = path.join(tmp, ".config", "mxstudio");
  assert.match(testSandboxProblem({ ...base, legacyStateDir: real }, os.tmpdir(), [real]) ?? "", /--legacy-state-dir が本物の書き先/);
  assert.ok(realWriteLocations({}, path.join("C:", "home"), os.tmpdir()).includes(path.join("C:", "home", ".config", "mxstudio")));
});

test("findLegacyLeftovers / legacyStatusStep: 改名前の登録・既定の Skill の写し・ショートカット・記録を見つける（何も書き換えない）", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-leftovers-"));
  try {
    const paths = {
      claudeCodeConfig: path.join(dir, "claude-code.json"),
      claudeDesktopConfig: path.join(dir, "desktop.json"),
      ...antigravityPaths(path.join(dir, "gemini")),
      ...codexPaths(path.join(dir, "codex")),
      claudeSkillsDir: path.join(dir, "claude-skills"),
      codexSkillsDir: path.join(dir, "agents-skills"),
      startupDir: path.join(dir, "startup"),
      desktopDir: path.join(dir, "desktop"),
    };
    const legacyDir = path.join(dir, "legacy");
    assert.deepEqual(findLegacyLeftovers(paths, legacyDir), []);
    assert.equal(legacyStatusStep([], false, 8788), null);

    writeFileSync(paths.claudeCodeConfig, JSON.stringify({ mcpServers: { mxstudio: { command: "node" }, mxstage: { command: "node" } } }), "utf8");
    writeFileSync(paths.claudeDesktopConfig, "{ 壊れた JSON", "utf8");
    mkdirSync(paths.codexDir, { recursive: true });
    writeFileSync(paths.codexConfig, '[mcp_servers.mxstudio]\ncommand = "node"\n', "utf8");
    mkdirSync(path.join(paths.claudeSkillsDir, "mxstudio-workbench"), { recursive: true });
    writeFileSync(path.join(paths.claudeSkillsDir, "mxstudio-workbench", "SKILL.md"), "x", "utf8");
    mkdirSync(paths.startupDir, { recursive: true });
    writeFileSync(path.join(paths.startupDir, "mxstudio-bridge.lnk"), "x", "utf8");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(path.join(legacyDir, "setup.json"), "{}", "utf8");
    const before = readFileSync(paths.claudeCodeConfig, "utf8");

    const found = findLegacyLeftovers(paths, legacyDir);
    assert.deepEqual(
      found.map((l) => [l.kind, l.id ?? path.basename(l.path)]),
      [
        ["state", "setup.json"],
        ["mcp", "claude_code"],
        ["mcp", "codex"],
        ["skill", "SKILL.md"],
        ["shortcut", "mxstudio-bridge.lnk"],
      ],
      "読めない設定（Claude Desktop）は見ない",
    );
    assert.equal(readFileSync(paths.claudeCodeConfig, "utf8"), before, "何も書き換えない");
    const status = legacyStatusStep(found, true, 8788);
    assert.equal(status.level, "warn");
    assert.match(status.message, /ポート 8788 で動いている改名前の橋渡し/);
    assert.match(status.message, /Claude Code の登録/);
    assert.match(status.hint, /mxstage\.cmd/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("改名前（mxstudio）の導入が残したものを片付けて移す（登録・Skill の写し・ショートカット・利用者の Skill・語の一覧）。2 回目は何も変えず、取り消しでも外す", { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-migrate-"));
  let port = null;
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    port = await freePort();
    const oldEntry = path.join(dir, "old-repo", "src", "bridge", "cli.ts");
    const legacyCode = { type: "stdio", command: process.execPath, args: [oldEntry, "--port", String(port)], env: {} };
    const legacyDesktop = { command: process.execPath, args: [oldEntry, "--port", String(port)] };
    const otherEntry = { type: "http", url: "https://example.test/mcp" };
    const someoneElse = { command: "npx", args: ["-y", "someone-elses-mxstudio"] };
    const codeConfig = path.join(dir, "claude-code.json");
    const desktopConfig = path.join(dir, "claude_desktop_config.json");
    const antigravityConfig = path.join(dir, "gemini", "config", "mcp_config.json");
    const codexConfig = path.join(dir, "codex", "config.toml");
    writeFileSync(codeConfig, JSON.stringify({ mcpServers: { other: otherEntry, mxstudio: legacyCode } }, null, 2), "utf8");
    writeFileSync(desktopConfig, JSON.stringify({ mcpServers: { mxstudio: legacyDesktop } }, null, 2), "utf8");
    mkdirSync(path.dirname(antigravityConfig), { recursive: true });
    // 利用者が自分で書いた同じ名前の登録（改名前の導入のものではない）は残す
    writeFileSync(antigravityConfig, JSON.stringify({ mcpServers: { mxstudio: someoneElse } }, null, 2), "utf8");
    mkdirSync(path.dirname(codexConfig), { recursive: true });
    writeFileSync(
      codexConfig,
      ["[mcp_servers.other]", 'command = "other"', "", "[mcp_servers.mxstudio]", `command = ${JSON.stringify(process.execPath)}`, `args = [${JSON.stringify(oldEntry)}, "--port", "${port}"]`, ""].join("\n"),
      "utf8",
    );

    // 改名前の導入が写した Skill（Antigravity は前の置き場所 ~/.gemini/skills に写していた）
    const defaultText = "---\nname: mxstudio-workbench\ndescription: old\n---\n\n# old\n";
    const userText = '---\nname: my-flow\ndescription: "業務の手順"\n---\n\n# 業務の手順\n';
    const claudeSkills = path.join(dir, "claude-skills");
    const oldGeminiSkills = path.join(dir, "gemini", "skills");
    const agentsSkills = path.join(dir, "agents-skills");
    const put = (root, name, text) => {
      mkdirSync(path.join(root, name), { recursive: true });
      writeFileSync(path.join(root, name, "SKILL.md"), text, "utf8");
    };
    put(claudeSkills, "mxstudio-workbench", defaultText);
    put(claudeSkills, "my-flow", userText);
    put(oldGeminiSkills, "mxstudio-workbench", defaultText);
    put(oldGeminiSkills, "my-flow", userText);
    put(agentsSkills, "mxstudio-workbench", `${defaultText}\n利用者のメモ\n`);
    const recorded = [
      { name: "mxstudio-workbench", sha256: sha256(defaultText), origin: "default" },
      { name: "my-flow", sha256: sha256(userText), origin: "user" },
    ];

    // 改名前の記録・利用者の Skill・語の一覧
    const legacyDir = path.join(dir, "legacy");
    put(path.join(legacyDir, "skills"), "my-flow", userText);
    writeFileSync(path.join(legacyDir, "publish-terms.txt"), "客先の名前\n", "utf8");
    writeFileSync(
      path.join(legacyDir, "setup.json"),
      JSON.stringify({
        version: 1,
        nodePath: process.execPath,
        bridgeEntry: oldEntry,
        port,
        installed: { skills: recorded, antigravitySkills: recorded, codexSkills: [recorded[0]] },
        skillDirs: { skills: claudeSkills, antigravitySkills: oldGeminiSkills, codexSkills: agentsSkills },
        previous: { claudeCode: null, claudeDesktop: null, antigravity: null, codex: null },
      }),
      "utf8",
    );
    // 改名前の自動起動とデスクトップのショートカット
    mkdirSync(path.join(dir, "startup"), { recursive: true });
    mkdirSync(path.join(dir, "desktop"), { recursive: true });
    writeFileSync(path.join(dir, "startup", "mxstudio-bridge.lnk"), "x", "utf8");
    writeFileSync(path.join(dir, "desktop", "mxstudio.url"), "x", "utf8");

    const common = [...sandboxArgs(dir), "--legacy-state-dir", legacyDir, "--no-autostart", "--no-shortcut", "--port", String(port), "--bridge", bridge];

    // --- 導入（移行）---
    const first = await runJson(common);
    assert.equal(first.code, 0, first.stdout);
    const ids = first.json.steps.map((s) => s.id);
    assert.ok(ids.indexOf("legacy") < ids.indexOf("port"), "ポートを確かめる前に移す");
    const level = (id) => stepOf(first.json, id).map((s) => s.level);
    assert.deepEqual(level("legacy_claude_code"), ["ok"]);
    assert.deepEqual(level("legacy_claude_desktop"), ["ok"]);
    assert.deepEqual(level("legacy_antigravity"), ["warn"], "利用者の登録は残して知らせる");
    assert.deepEqual(level("legacy_codex"), ["ok"]);
    assert.deepEqual(level("legacy_codex_skills"), ["warn"], "書き換えられた写しは残して知らせる");
    assert.deepEqual(level("legacy_copy"), ["ok"]);
    assert.deepEqual(level("legacy_shortcut"), ["ok"]);
    assert.deepEqual(level("legacy_state"), ["ok"]);

    const code = JSON.parse(readFileSync(codeConfig, "utf8"));
    assert.equal("mxstudio" in code.mcpServers, false, "Claude Code から改名前の登録を外す");
    assert.deepEqual(code.mcpServers.other, otherEntry, "ほかの登録は残す");
    assert.deepEqual(code.mcpServers.mxstage.args, [bridge, "--port", String(port)]);
    const desktop = JSON.parse(readFileSync(desktopConfig, "utf8"));
    assert.equal("mxstudio" in desktop.mcpServers, false);
    assert.ok(desktop.mcpServers.mxstage);
    const antigravity = JSON.parse(readFileSync(antigravityConfig, "utf8"));
    assert.deepEqual(antigravity.mcpServers.mxstudio, someoneElse, "利用者の登録は残す");
    assert.ok(antigravity.mcpServers.mxstage);
    const codexText = readFileSync(codexConfig, "utf8");
    assert.equal(findCodexTable(codexText, "mxstudio").start, -1, "Codex からも外す");
    assert.ok(findCodexTable(codexText).block, "Codex に mxstage を登録する");
    assert.match(codexText, /\[mcp_servers\.other\]\ncommand = "other"/, "ほかの表は残す");

    // Skill: 改名前の既定は消し、利用者の Skill は新しい導入が写し直す。前の置き場所の写しは片付ける
    assert.equal(existsSync(path.join(claudeSkills, "mxstudio-workbench")), false);
    assert.equal(readFileSync(path.join(claudeSkills, "my-flow", "SKILL.md"), "utf8"), userText);
    assert.ok(existsSync(path.join(claudeSkills, "mxstage-workbench", "SKILL.md")), "新しい既定の Skill が入る");
    assert.equal(existsSync(path.join(oldGeminiSkills, "mxstudio-workbench")), false);
    assert.equal(existsSync(path.join(oldGeminiSkills, "my-flow")), false);
    assert.ok(existsSync(path.join(dir, "gemini", "config", "skills", "my-flow", "SKILL.md")), "Antigravity には今の置き場所に写す");
    assert.ok(existsSync(path.join(agentsSkills, "mxstudio-workbench", "SKILL.md")), "書き換えられた写しは消さない");

    // 利用者の Skill と語の一覧を新しい置き場所へ写し、改名前の置き場所は残す
    const stateDir = path.join(dir, "state");
    assert.equal(readFileSync(path.join(stateDir, "skills", "my-flow", "SKILL.md"), "utf8"), userText);
    assert.equal(readFileSync(path.join(stateDir, "publish-terms.txt"), "utf8"), "客先の名前\n");
    assert.ok(existsSync(path.join(stateDir, "migrated-from-mxstudio.json")), "写し終えた印");
    assert.ok(existsSync(path.join(legacyDir, "skills", "my-flow", "SKILL.md")), "改名前の置き場所は消さない");
    assert.equal(existsSync(path.join(legacyDir, "setup.json")), false);
    assert.ok(existsSync(path.join(legacyDir, "setup.migrated.json")), "改名前の記録は改める");
    assert.equal(existsSync(path.join(dir, "startup", "mxstudio-bridge.lnk")), false);
    assert.equal(existsSync(path.join(dir, "desktop", "mxstudio.url")), false);
    const state = JSON.parse(readFileSync(path.join(stateDir, "setup.json"), "utf8"));
    assert.equal(state.migratedFrom, legacyDir);

    // --- もう一度（何も変えない。残したものは知らせ続ける。写したあとに消した Skill を写し直さない）---
    rmSync(path.join(stateDir, "skills", "my-flow"), { recursive: true, force: true });
    const configsBefore = [codeConfig, desktopConfig, antigravityConfig, codexConfig].map((f) => readFileSync(f, "utf8"));
    const again = await runJson(common);
    assert.equal(again.code, 0, again.stdout);
    const configsAfter = [codeConfig, desktopConfig, antigravityConfig, codexConfig].map((f) => readFileSync(f, "utf8"));
    assert.deepEqual(configsAfter, configsBefore);
    assert.equal(existsSync(path.join(stateDir, "skills", "my-flow")), false, "消した利用者の Skill を写し直さない");
    assert.deepEqual(stepOf(again.json, "legacy_copy"), []);
    assert.deepEqual(stepOf(again.json, "legacy_antigravity").map((s) => s.level), ["warn"]);
    assert.deepEqual(stepOf(again.json, "legacy_skill_copies").map((s) => s.level), ["warn"]);
    assert.equal(JSON.parse(readFileSync(path.join(stateDir, "setup.json"), "utf8")).migratedFrom, legacyDir, "移した元を覚え続ける");

    // --- 状態を見る ---
    const status = await runJson([...common, "--status"]);
    const legacyStatus = stepOf(status.json, "legacy");
    assert.equal(legacyStatus.length, 1);
    assert.match(legacyStatus[0].message, /Antigravity の登録/);

    // --- 取り消し（改名前の登録が戻っていても外す）---
    const code2 = JSON.parse(readFileSync(codeConfig, "utf8"));
    writeFileSync(codeConfig, JSON.stringify({ ...code2, mcpServers: { ...code2.mcpServers, mxstudio: legacyCode } }, null, 2), "utf8");
    const removed = await runJson([...common, "--uninstall"]);
    assert.equal(removed.code, 0, removed.stdout);
    const codeAfter = JSON.parse(readFileSync(codeConfig, "utf8"));
    assert.deepEqual(Object.keys(codeAfter.mcpServers), ["other"], "mxstage も mxstudio も外す");
  } finally {
    if (port !== null) await stopFakeBridgeOn(port);
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "ポートの改名前の橋渡し: 画面用（--no-mcp）なら止めて移す。LLM のアプリが起動したもの・引き継いだものがいれば、何も書き換えずに止まる",
  { timeout: 180_000, skip: !IS_WINDOWS && "プロセスの確認は Windows だけ" },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-renamed-"));
    const children = [];
    let port = null;
    try {
      const bridge = path.join(dir, "fake-bridge.mjs");
      writeFileSync(bridge, FAKE_BRIDGE, "utf8");
      const renamed = path.join(dir, "old-repo", "src", "bridge", "cli.mjs");
      mkdirSync(path.dirname(renamed), { recursive: true });
      writeFileSync(renamed, RENAMED_BRIDGE, "utf8");
      const legacyDir = path.join(dir, "legacy");
      mkdirSync(legacyDir, { recursive: true });
      const codeConfig = path.join(dir, "claude-code.json");
      const spawnRenamed = (extra) => {
        const child = spawn(process.execPath, [renamed, ...extra, "--port", String(port)], { stdio: "ignore", windowsHide: true });
        children.push(child);
        return child;
      };
      const resetLegacy = () => {
        writeFileSync(path.join(legacyDir, "setup.json"), JSON.stringify({ version: 1, nodePath: process.execPath, bridgeEntry: renamed, port }), "utf8");
        writeFileSync(codeConfig, JSON.stringify({ mcpServers: { mxstudio: { type: "stdio", command: process.execPath, args: [renamed, "--port", String(port)], env: {} } } }, null, 2), "utf8");
      };
      const legacyUp = async () => (await fetch(`http://127.0.0.1:${port}/_mxstudio/health`).then((r) => r.json()).catch(() => null))?.name === "mxstudio-bridge";
      port = await freePort();
      const args = [...sandboxArgs(dir), "--legacy-state-dir", legacyDir, "--no-autostart", "--no-shortcut", "--no-skills", "--no-antigravity", "--no-codex", "--port", String(port), "--bridge", bridge];

      // 1) LLM のアプリが起動したもの（--no-mcp なし）: 止めずに、何も書き換えずに止まる
      resetLegacy();
      const owned = spawnRenamed([]);
      assert.ok(await waitFor(legacyUp));
      const blocked = await runJson(args);
      assert.equal(blocked.code, 1, blocked.stdout);
      const stop = stepOf(blocked.json, "legacy_bridge");
      assert.equal(stop[0].level, "error");
      assert.match(stop[0].message, new RegExp(`プロセス ${owned.pid}`));
      assert.match(stop[0].hint, /LLM のアプリをすべて終了/);
      assert.ok(await legacyUp(), "止めていない");
      assert.ok("mxstudio" in JSON.parse(readFileSync(codeConfig, "utf8")).mcpServers, "設定は書き換えていない");
      assert.equal(existsSync(path.join(dir, "state", "setup.json")), false, "記録も書かない");
      owned.kill();
      assert.ok(await waitFor(async () => !(await legacyUp())));

      // 2) 画面用（--no-mcp）を止めたあと、LLM のアプリが起動した改名前の橋渡しが引き継いだ: 止まる
      resetLegacy();
      const serve = spawnRenamed(["--no-mcp"]);
      assert.ok(await waitFor(legacyUp));
      const client = spawnRenamed([]);
      const takenOver = await runJson(args);
      assert.equal(takenOver.code, 1, takenOver.stdout);
      assert.match(stepOf(takenOver.json, "legacy_bridge")[0].message, /引き継ぎました/);
      assert.ok(await waitFor(async () => serve.exitCode !== null), "画面用の改名前の橋渡しは止めた");
      assert.ok("mxstudio" in JSON.parse(readFileSync(codeConfig, "utf8")).mcpServers, "設定は書き換えていない");
      client.kill();
      assert.ok(await waitFor(async () => !(await legacyUp())));

      // 3) 画面用（--no-mcp）だけ: 止めて移し、新しい橋渡しを起動する
      resetLegacy();
      const alone = spawnRenamed(["--no-mcp"]);
      assert.ok(await waitFor(legacyUp));
      const migrated = await runJson(args);
      assert.equal(migrated.code, 0, migrated.stdout);
      assert.equal(stepOf(migrated.json, "legacy_bridge")[0].level, "ok");
      assert.ok(await waitFor(async () => alone.exitCode !== null), "改名前の橋渡しは止まった");
      assert.equal((await probeBridge(port)).health?.name, "mxstage-bridge", "新しい橋渡しがポートを持つ");
      const code = JSON.parse(readFileSync(codeConfig, "utf8"));
      assert.equal("mxstudio" in code.mcpServers, false);
      assert.ok(code.mcpServers.mxstage);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      if (port !== null) await stopFakeBridgeOn(port);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("動いている橋渡しの取り決めの版（protocol）が、このリポジトリの橋渡しと違えば --status で警告する", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-protocol-"));
  let child = null;
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    // 入口と同じフォルダの peer.ts が「このリポジトリの取り決めの版」
    writeFileSync(path.join(dir, "peer.ts"), "export const BRIDGE_PEER_PROTOCOL = 2;\n", "utf8");
    const port = await freePort();
    child = spawn(process.execPath, [bridge, "--no-mcp", "--port", String(port)], { stdio: "ignore", windowsHide: true, env: { ...process.env, FAKE_PROTOCOL: "1" } });
    assert.ok(await waitFor(async () => (await probeBridge(port)).state === "bridge"));

    const run = await runJson([...sandboxArgs(dir), "--status", "--port", String(port), "--bridge", bridge]);
    const single = stepOf(run.json, "bridge_single");
    assert.equal(single[0].level, "warn", JSON.stringify(single));
    assert.match(single[0].message, /動いている橋渡し: 1/);
    assert.match(single[0].message, /このリポジトリ: 2/);
  } finally {
    child?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "自動起動とデスクトップのショートカットを作り、取り消しで消す（日本語のフォルダ名でも。中身も確かめる）",
  { timeout: 180_000, skip: !IS_WINDOWS && "ショートカットは Windows だけ" },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-lnk-"));
    try {
      // OneDrive の「デスクトップ」や日本語のユーザー名を想定して、フォルダ名に日本語を使う
      mkdirSync(path.join(dir, "リポジトリ"));
      const bridge = path.join(dir, "リポジトリ", "fake-bridge.mjs");
      writeFileSync(bridge, FAKE_BRIDGE, "utf8");
      const startupDir = path.join(dir, "スタートアップ");
      const desktopDir = path.join(dir, "デスクトップ");
      mkdirSync(startupDir);
      mkdirSync(desktopDir);
      const port = await freePort();
      const args = [...sandboxArgs(dir), "--startup-dir", startupDir, "--desktop-dir", desktopDir, "--bridge", bridge, "--port", String(port)];
      assert.equal(await quietMain([...args, "--no-start"]), 0);

      const startup = path.join(startupDir, "mxstage-bridge.lnk");
      assert.ok(existsSync(startup), "スタートアップにショートカットがある");
      const read = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
        input: "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:MXS_LNK); @{ target = $s.TargetPath; args = $s.Arguments; style = $s.WindowStyle } | ConvertTo-Json -Compress\n",
        encoding: "utf8",
        env: { ...process.env, MXS_LNK: startup },
        windowsHide: true,
      });
      const lnk = JSON.parse(read.stdout.trim().split(/\r?\n/).pop());
      assert.equal(lnk.target.toLowerCase(), process.execPath.toLowerCase());
      assert.ok(lnk.args.includes(bridge) && lnk.args.includes("--no-mcp") && lnk.args.includes(`--port ${port}`), lnk.args);
      assert.equal(lnk.style, 7, "最小化で起動する");

      const desktopLnk = path.join(desktopDir, "mxstage.lnk");
      const desktopUrl = path.join(desktopDir, "mxstage.url");
      assert.ok(existsSync(desktopLnk) || existsSync(desktopUrl), "デスクトップにショートカットがある");
      if (existsSync(desktopUrl)) assert.match(readFileSync(desktopUrl, "utf8"), new RegExp(`URL=http://127\\.0\\.0\\.1:${port}/app`));

      assert.equal(await quietMain([...args, "--uninstall"]), 0);
      assert.equal(existsSync(startup), false, "自動起動は消える");
      assert.equal(existsSync(desktopLnk) || existsSync(desktopUrl), false, "デスクトップのショートカットも消える");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("--dry-run では何も書き換えない", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-dry-"));
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    const codeConfig = path.join(dir, "claude-code.json");
    const before = JSON.stringify({ mcpServers: { other: { type: "http" } } }, null, 2);
    writeFileSync(codeConfig, before, "utf8");
    const port = await freePort();
    const code = await quietMain([...sandboxArgs(dir), "--dry-run", "--port", String(port), "--bridge", bridge]);
    assert.equal(code, 0);
    assert.equal(readFileSync(codeConfig, "utf8"), before, "設定ファイルは変わらない");
    assert.equal(existsSync(path.join(dir, "state", "setup.json")), false, "記録も書かない");
    assert.equal((await probeBridge(port)).state, "down", "橋渡しも起動しない");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("橋渡しの入口が無いときは、何も書き換えずに NG で終わる", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-nobridge-"));
  try {
    const codeConfig = path.join(dir, "claude-code.json");
    const before = JSON.stringify({ mcpServers: {} }, null, 2);
    writeFileSync(codeConfig, before, "utf8");
    const port = await freePort();
    const code = await quietMain([...sandboxArgs(dir), "--bridge", path.join(dir, "ない-bridge.mjs"), "--port", String(port)]);
    assert.equal(code, 1);
    assert.equal(readFileSync(codeConfig, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Claude Desktop（Microsoft Store 版・拡張機能・--no-claude-desktop）と IBM Bob
// ---------------------------------------------------------------------------

/**
 * 偽の Claude Desktop の拡張機能を、設定フォルダ（userData）に置く（Claude Desktop 2.16120 の置き方に合わせる）。
 * index: extensions-installations.json に載せるか / settings: Claude Extensions Settings\<id>.json を置くか
 */
function putDesktopExtension(userDataDir, { id = "local.mcpb.kazuhiro-muto.mxstage", name = "mxstage", enabled = true, index = true, settings = true } = {}) {
  const extDir = path.join(userDataDir, "Claude Extensions", id);
  mkdirSync(extDir, { recursive: true });
  writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify({ manifest_version: "0.3", name, version: "0.2.0", author: { name: "Kazuhiro Muto" } }), "utf8");
  if (index) {
    const indexPath = path.join(userDataDir, "extensions-installations.json");
    const current = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : { extensions: {} };
    current.extensions[id] = { id, version: "0.2.0", hash: "x", installedAt: "2026-10-01T00:00:00.000Z", manifest: { name, version: "0.2.0" }, source: "local" };
    writeFileSync(indexPath, JSON.stringify(current, null, 2), "utf8");
  }
  if (settings) {
    mkdirSync(path.join(userDataDir, "Claude Extensions Settings"), { recursive: true });
    writeFileSync(path.join(userDataDir, "Claude Extensions Settings", `${id}.json`), JSON.stringify({ isEnabled: enabled }), "utf8");
  }
  return id;
}

test("msixDesktopConfigs / desktopLocations: Microsoft Store 版はパッケージ（Claude_<発行元 ID>）の中に設定フォルダがあるものだけを探す", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-msixpaths-"));
  try {
    const packages = path.join(dir, "Packages");
    const roaming = (name) => path.join(packages, name, "LocalCache", "Roaming");
    mkdirSync(path.join(roaming("Claude_pzs8sxrjxfjjc"), "Claude"), { recursive: true });
    // 一度も起動していない（設定フォルダが無い）・3P 版の設定フォルダだけ・名前の形が違う・ほかのアプリ
    mkdirSync(path.join(roaming("Claude_abcdefghijklm"), "Claude-3p"), { recursive: true });
    mkdirSync(path.join(roaming("Claude-3p_x"), "Claude"), { recursive: true });
    mkdirSync(path.join(roaming("Microsoft.WindowsTerminal_8wekyb3d8bbwe"), "Claude"), { recursive: true });
    const found = msixDesktopConfigs(packages);
    assert.deepEqual(found, [{ packageName: "Claude_pzs8sxrjxfjjc", configPath: path.join(roaming("Claude_pzs8sxrjxfjjc"), "Claude", "claude_desktop_config.json") }]);
    assert.deepEqual(msixDesktopConfigs(null), [], "探す場所が無ければ探さない");
    assert.deepEqual(msixDesktopConfigs(path.join(dir, "無い")), []);

    const standard = path.join(dir, "Roaming", "Claude", "claude_desktop_config.json");
    const locations = desktopLocations({ claudeDesktopConfig: standard, claudeDesktopMsixConfigs: found });
    assert.deepEqual(
      locations.map((l) => [l.id, l.key, l.installedKey, l.present]),
      [
        ["claude_desktop", "claudeDesktop", "claudeDesktop", false],
        ["claude_desktop_msix", "claudeDesktopMsix:Claude_pzs8sxrjxfjjc", "claudeDesktopMsix", true],
      ],
    );
    assert.match(locations[1].label, /Microsoft Store 版/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findDesktopExtension: 拡張機能（.mcpb）の MX Stage を manifest の name で探し、有効かどうかを設定の isEnabled で見る", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-ext-"));
  try {
    const at = (name) => {
      const d = path.join(dir, name);
      mkdirSync(d, { recursive: true });
      return d;
    };
    assert.equal(findDesktopExtension(at("none")), null, "拡張機能を 1 つも入れていない");

    const enabled = at("enabled");
    putDesktopExtension(enabled, { id: "ant.dir.gh.tomtom.tomtom-mcp", name: "tomtom-mcp" });
    assert.equal(findDesktopExtension(enabled), null, "ほかの拡張機能は見ない");
    putDesktopExtension(enabled);
    assert.deepEqual(findDesktopExtension(enabled), { id: "local.mcpb.kazuhiro-muto.mxstage", enabled: true });

    const disabled = at("disabled");
    putDesktopExtension(disabled, { enabled: false });
    assert.deepEqual(findDesktopExtension(disabled), { id: "local.mcpb.kazuhiro-muto.mxstage", enabled: false });

    // 設定が無い・読めないときは無効と見なす（ふつうに登録する。取り違えても二重になるだけ）
    const noSettings = at("no-settings");
    putDesktopExtension(noSettings, { settings: false });
    assert.deepEqual(findDesktopExtension(noSettings), { id: "local.mcpb.kazuhiro-muto.mxstage", enabled: false });
    const brokenSettings = at("broken-settings");
    putDesktopExtension(brokenSettings);
    writeFileSync(path.join(brokenSettings, "Claude Extensions Settings", "local.mcpb.kazuhiro-muto.mxstage.json"), "{ 壊れた", "utf8");
    assert.equal(findDesktopExtension(brokenSettings).enabled, false);

    // 一覧（extensions-installations.json）が無くても、展開したフォルダの manifest.json から見つける（id の形には頼らない）
    const dirOnly = at("dir-only");
    putDesktopExtension(dirOnly, { id: "ant.dir.gh.mxstage.mxstage", index: false });
    assert.deepEqual(findDesktopExtension(dirOnly), { id: "ant.dir.gh.mxstage.mxstage", enabled: true });

    // 一覧に載っていても、展開したフォルダが無ければ入っていない（消したあとの残り）
    const stale = at("stale");
    putDesktopExtension(stale);
    rmSync(path.join(stale, "Claude Extensions"), { recursive: true, force: true });
    assert.equal(findDesktopExtension(stale), null);

    // 無効なものと有効なものがあれば、有効なものを返す
    const both = at("both");
    putDesktopExtension(both, { id: "local.dxt.kazuhiro-muto.mxstage", enabled: false });
    putDesktopExtension(both, { id: "local.mcpb.kazuhiro-muto.mxstage", enabled: true });
    assert.deepEqual(findDesktopExtension(both), { id: "local.mcpb.kazuhiro-muto.mxstage", enabled: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude Desktop の Microsoft Store 版: パッケージの中の設定にも登録し（控えを取る）、状態に出し、取り消しで外す", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-msix-"));
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    const port = await freePort();
    const packages = path.join(dir, "Packages");
    const msixDir = path.join(packages, "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude");
    const msixConfig = path.join(msixDir, "claude_desktop_config.json");
    const standardConfig = path.join(dir, "claude_desktop_config.json");
    const other = { command: "npx", args: ["other-mcp"] };
    mkdirSync(msixDir, { recursive: true });
    writeFileSync(msixConfig, JSON.stringify({ mcpServers: { other }, preferences: { sidebarMode: "chat" } }, null, 2), "utf8");
    writeFileSync(standardConfig, JSON.stringify({ mcpServers: { other } }, null, 2), "utf8");
    // 設定フォルダの無いパッケージ（一度も起動していない）
    const unused = path.join(packages, "Claude_abcdefghijklm", "LocalCache", "Roaming");
    mkdirSync(unused, { recursive: true });
    const common = [...sandboxArgs(dir, ["--claude-desktop-packages-dir", packages]), "--no-start", "--no-autostart", "--no-shortcut", "--port", String(port), "--bridge", bridge];

    const first = await runJson(common);
    assert.equal(first.code, 0, first.stdout);
    const expected = { command: process.execPath, args: [bridge, "--port", String(port)] };
    const written = JSON.parse(readFileSync(msixConfig, "utf8"));
    assert.deepEqual(written.mcpServers.mxstage, expected, "Microsoft Store 版の設定に登録する");
    assert.deepEqual(written.mcpServers.other, other, "ほかのサーバは残す");
    assert.deepEqual(written.preferences, { sidebarMode: "chat" });
    assert.deepEqual(JSON.parse(readFileSync(standardConfig, "utf8")).mcpServers.mxstage, expected, "ふつうの版の設定にも登録する");
    const msixStep = stepOf(first.json, "claude_desktop_msix");
    assert.equal(msixStep.length, 1);
    assert.equal(msixStep[0].level, "ok");
    assert.match(msixStep[0].message, /Microsoft Store 版・Claude_pzs8sxrjxfjjc/);
    assert.ok(first.json.result.installed.claudeDesktop && first.json.result.installed.claudeDesktopMsix);
    assert.equal(stepOf(first.json, "claude_desktop_restart").length, 1, "再起動の案内は 1 回だけ");
    assert.equal(existsSync(path.join(unused, "Claude")), false, "設定フォルダの無いパッケージには作らない");

    // 控えは置き場所ごとに取る（同じファイル名でも上書きしない）
    const state = JSON.parse(readFileSync(path.join(dir, "state", "setup.json"), "utf8"));
    const desktopBackups = state.backups.filter((b) => path.basename(b).startsWith("claude_desktop_config.json."));
    assert.equal(desktopBackups.length, 2, state.backups.join("\n"));
    const backedUp = desktopBackups.map((b) => JSON.parse(readFileSync(b, "utf8")));
    assert.ok(backedUp.some((j) => j.preferences?.sidebarMode === "chat"), "Microsoft Store 版の控え");
    assert.ok(backedUp.some((j) => j.preferences === undefined), "ふつうの版の控え");
    assert.equal(state.previous["claudeDesktopMsix:Claude_pzs8sxrjxfjjc"], null, "前に MX Stage は無かったので戻す先は無い");

    // --- 状態を見る ---
    const status = await runJson([...common, "--status"]);
    assert.equal(stepOf(status.json, "claude_desktop")[0].level, "ok");
    assert.equal(stepOf(status.json, "claude_desktop_msix")[0].level, "ok");

    // --- もう一度（冪等）---
    const again = await runJson(common);
    assert.match(stepOf(again.json, "claude_desktop_msix")[0].message, /既に同じ設定/);
    assert.equal(stepOf(again.json, "claude_desktop_restart").length, 0, "書き換えていなければ再起動の案内は出さない");

    // --- 取り消し ---
    assert.equal(await quietMain([...common, "--uninstall"]), 0);
    const after = JSON.parse(readFileSync(msixConfig, "utf8"));
    assert.equal("mxstage" in after.mcpServers, false, "Microsoft Store 版からも外す");
    assert.deepEqual(after.mcpServers.other, other);
    assert.equal("mxstage" in JSON.parse(readFileSync(standardConfig, "utf8")).mcpServers, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude Desktop が入っていない（設定フォルダが無い）なら、何も作らない", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-nodesktop-"));
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    const port = await freePort();
    const desktopDir = path.join(dir, "Roaming", "Claude");
    const common = [...sandboxArgs(dir, ["--claude-desktop-config", path.join(desktopDir, "claude_desktop_config.json")]), "--no-start", "--no-autostart", "--no-shortcut", "--port", String(port), "--bridge", bridge];
    const install = await runJson(common);
    assert.equal(install.code, 0, install.stdout);
    const s = stepOf(install.json, "claude_desktop");
    assert.equal(s.length, 1);
    assert.equal(s[0].level, "skip");
    assert.match(s[0].message, /設定フォルダが無い/);
    assert.equal(stepOf(install.json, "claude_desktop_restart").length, 0);
    assert.equal(install.json.result.installed.claudeDesktop, false);
    assert.equal(existsSync(desktopDir), false, "入れていない PC に %APPDATA%\\Claude を作らない");
    assert.equal(stepOf((await runJson([...common, "--status"])).json, "claude_desktop")[0].level, "skip");
    assert.equal(await quietMain([...common, "--uninstall"]), 0);
    assert.equal(existsSync(desktopDir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "Claude Desktop に拡張機能（.mcpb）の MX Stage が入っていて有効なら、設定ファイルには登録せず、前にこの導入が書いた登録だけを外す",
  { timeout: 120_000 },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-mcpb-"));
    try {
      const bridge = path.join(dir, "fake-bridge.mjs");
      writeFileSync(bridge, FAKE_BRIDGE, "utf8");
      const port = await freePort();
      const desktopConfig = path.join(dir, "claude_desktop_config.json");
      const other = { command: "npx", args: ["other-mcp"] };
      writeFileSync(desktopConfig, JSON.stringify({ mcpServers: { other } }, null, 2), "utf8");
      const common = [...sandboxArgs(dir), "--no-start", "--no-autostart", "--no-shortcut", "--port", String(port), "--bridge", bridge];
      const readDesktop = () => JSON.parse(readFileSync(desktopConfig, "utf8"));

      // まだ拡張機能が無い: ふつうに登録する
      assert.equal(await quietMain(common), 0);
      assert.ok(readDesktop().mcpServers.mxstage, "登録した");

      // 拡張機能を入れた（有効）: この導入が書いた登録を外す
      const id = putDesktopExtension(dir);
      const second = await runJson(common);
      assert.equal(second.code, 0, second.stdout);
      assert.equal("mxstage" in readDesktop().mcpServers, false, "設定ファイルからは外す");
      assert.deepEqual(readDesktop().mcpServers.other, other, "ほかのサーバは残す");
      const s = stepOf(second.json, "claude_desktop")[0];
      assert.equal(s.level, "ok");
      assert.match(s.message, /拡張機能（\.mcpb）/);
      assert.match(s.message, new RegExp(id.replace(/\./g, "\\.")));
      assert.match(s.message, /外しました/);
      assert.match(s.hint, /控え/);
      assert.equal(second.json.result.installed.claudeDesktopExtension, id);
      assert.equal(second.json.result.installed.claudeDesktop, false);
      assert.equal(stepOf(second.json, "claude_desktop_restart").length, 1, "外したので再起動を案内する");
      const printed = await runMain(common);
      assert.match(printed.stdout, /拡張機能（\.mcpb）の MX Stage を使います/);

      // もう一度: 何も変えない
      const before = readFileSync(desktopConfig, "utf8");
      const third = await runJson(common);
      assert.equal(readFileSync(desktopConfig, "utf8"), before);
      assert.equal(stepOf(third.json, "claude_desktop")[0].level, "ok");
      assert.doesNotMatch(stepOf(third.json, "claude_desktop")[0].message, /外しました/);
      assert.equal(stepOf(third.json, "claude_desktop_restart").length, 0);

      // 状態を見る
      const status = await runJson([...common, "--status"]);
      assert.equal(stepOf(status.json, "claude_desktop")[0].level, "ok");
      assert.match(stepOf(status.json, "claude_desktop")[0].message, /拡張機能（\.mcpb）の mxstage が入っていて有効/);

      // 利用者が手で書いた mxstage は外さずに知らせる（二重になる）
      const userEntry = { command: "npx", args: ["-y", "some-mxstage-wrapper"] };
      writeFileSync(desktopConfig, JSON.stringify({ mcpServers: { other, mxstage: userEntry } }, null, 2), "utf8");
      const kept = await runJson(common);
      assert.equal(kept.code, 0, kept.stdout);
      assert.deepEqual(readDesktop().mcpServers.mxstage, userEntry, "利用者の設定は残す");
      assert.equal(stepOf(kept.json, "claude_desktop")[0].level, "warn");
      assert.match(stepOf(kept.json, "claude_desktop")[0].message, /この導入が書いたものではない/);
      const doubled = await runJson([...common, "--status"]);
      assert.equal(stepOf(doubled.json, "claude_desktop")[0].level, "warn");
      assert.match(stepOf(doubled.json, "claude_desktop")[0].message, /二重/);

      // 拡張機能を無効にした: 設定ファイルに登録する（無効の拡張機能があることも出す）
      writeFileSync(desktopConfig, JSON.stringify({ mcpServers: { other } }, null, 2), "utf8");
      putDesktopExtension(dir, { enabled: false });
      const disabled = await runJson(common);
      assert.equal(disabled.code, 0, disabled.stdout);
      assert.deepEqual(readDesktop().mcpServers.mxstage, { command: process.execPath, args: [bridge, "--port", String(port)] });
      assert.match(stepOf(disabled.json, "claude_desktop")[0].hint, /無効/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Claude Desktop に拡張機能（.mcpb）の MX Stage が有効なら、Claude Code にも登録しない（Code タブで二重になるため）。--claude-code で登録し、次回も引き継ぐ",
  { timeout: 180_000 },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-mcpb-code-"));
    try {
      const bridge = path.join(dir, "fake-bridge.mjs");
      writeFileSync(bridge, FAKE_BRIDGE, "utf8");
      const port = await freePort();
      const codeConfig = path.join(dir, "claude-code.json");
      const other = { type: "http", url: "https://example.test/mcp" };
      writeFileSync(codeConfig, JSON.stringify({ numStartups: 2, mcpServers: { other } }, null, 2), "utf8");
      const common = [...sandboxArgs(dir), "--no-start", "--no-autostart", "--no-shortcut", "--port", String(port), "--bridge", bridge];
      const readCode = () => JSON.parse(readFileSync(codeConfig, "utf8"));
      const expected = { command: process.execPath, args: [bridge, "--port", String(port)] };
      const statePath = path.join(dir, "state", "setup.json");

      // 拡張機能が無い: これまでどおり登録する
      const plain = await runJson(common);
      assert.equal(plain.code, 0, plain.stdout);
      assert.equal(readCode().mcpServers.mxstage.command, expected.command);
      assert.deepEqual(readCode().mcpServers.mxstage.args, expected.args);
      assert.equal(plain.json.result.installed.claudeCode, true);

      // 拡張機能を入れた（有効）: 前にこの導入が書いた登録を外す（控えを取る）
      const id = putDesktopExtension(dir);
      const skipped = await runJson(common);
      assert.equal(skipped.code, 0, skipped.stdout);
      assert.equal("mxstage" in readCode().mcpServers, false, "Claude Code からは外す");
      assert.deepEqual(readCode().mcpServers.other, other, "ほかのサーバは残す");
      assert.equal(readCode().numStartups, 2, "ほかの設定も残す");
      const s = stepOf(skipped.json, "claude_code");
      assert.equal(s.length, 1);
      assert.equal(s[0].level, "ok");
      assert.match(s[0].message, /Code タブは拡張機能から MX Stage を受け取ります/);
      assert.match(s[0].message, /ターミナルの Claude Code では MX Stage を使えません/);
      assert.match(s[0].message, /外しました/);
      assert.match(s[0].message, new RegExp(id.replace(/\./g, "\\.")));
      assert.match(s[0].hint, /控え/);
      assert.match(s[0].hint, /--claude-code/);
      assert.equal(skipped.json.result.installed.claudeCode, false);
      assert.ok(JSON.parse(readFileSync(statePath, "utf8")).backups.some((b) => path.basename(b).startsWith("claude-code.json.")), "外す前に控えを取った");
      assert.equal(stepOf(skipped.json, "skills")[0].level, "ok", "Skill はこれまでどおり写す");
      assert.match((await runMain(common)).stdout, /Claude Code: 登録していません/);

      // 状態を見る: 登録していないのが正しいと出す
      const status = await runJson([...common, "--status"]);
      assert.equal(stepOf(status.json, "claude_code")[0].level, "ok");
      assert.match(stepOf(status.json, "claude_code")[0].message, /登録していません/);

      // --claude-code: 拡張機能が有効でも登録し、二重になることを知らせる。次回（付けなくても）引き継ぐ
      const forced = await runJson([...common, "--claude-code"]);
      assert.equal(forced.code, 0, forced.stdout);
      assert.deepEqual(readCode().mcpServers.mxstage.args, expected.args, "--claude-code なら登録する");
      assert.equal(forced.json.result.installed.claudeCode, true);
      assert.equal(stepOf(forced.json, "claude_code_duplicate")[0].level, "warn");
      assert.equal(JSON.parse(readFileSync(statePath, "utf8")).claudeCodeForced, true);
      const keep = await runJson(common);
      assert.equal(keep.code, 0, keep.stdout);
      assert.ok(readCode().mcpServers.mxstage, "前回 --claude-code を付けたので、付けなくても外さない");
      assert.match(stepOf(keep.json, "claude_code_duplicate")[0].message, /前回 --claude-code/);
      const forcedStatus = await runJson([...common, "--status"]);
      assert.equal(stepOf(forcedStatus.json, "claude_code")[0].level, "warn");
      assert.match(stepOf(forcedStatus.json, "claude_code")[0].message, /二重/);
      assert.match(stepOf(forcedStatus.json, "claude_code")[0].hint, /--claude-code で登録したもの/);

      // 取り消すと引き継ぎも消える（記録ごと消える）。次の導入では登録しない
      assert.equal(await quietMain([...common, "--uninstall"]), 0);
      assert.equal("mxstage" in readCode().mcpServers, false);
      assert.equal(await quietMain(common), 0);
      assert.equal("mxstage" in readCode().mcpServers, false);

      // 利用者が手で書いた mxstage は残して知らせる（Code タブで二重になる）
      const userEntry = { type: "http", url: "https://mxstage.example.test/mcp", headers: { Authorization: "Bearer USER-TOKEN" } };
      writeFileSync(codeConfig, JSON.stringify({ mcpServers: { other, mxstage: userEntry } }, null, 2), "utf8");
      const user = await runJson(common);
      assert.equal(user.code, 0, user.stdout);
      assert.deepEqual(readCode().mcpServers.mxstage, userEntry, "利用者の設定は残す");
      assert.equal(stepOf(user.json, "claude_code")[0].level, "warn");
      assert.match(stepOf(user.json, "claude_code")[0].message, /この導入が書いたものではない/);
      assert.equal(user.stdout.includes("USER-TOKEN"), false, "トークンは出さない");
      const userStatus = await runJson([...common, "--status"]);
      assert.equal(stepOf(userStatus.json, "claude_code")[0].level, "warn");
      assert.match(stepOf(userStatus.json, "claude_code")[0].message, /二重/);

      // --no-claude-desktop なら Claude Desktop を見ないので、これまでどおり Claude Code に登録する
      writeFileSync(codeConfig, JSON.stringify({ mcpServers: { other } }, null, 2), "utf8");
      const noDesktop = await runJson([...common, "--no-claude-desktop"]);
      assert.equal(noDesktop.code, 0, noDesktop.stdout);
      assert.deepEqual(readCode().mcpServers.mxstage.args, expected.args);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("--no-claude-desktop: Claude Desktop の設定に触らない（試験の囲いでも --claude-desktop-config が要らない）", { timeout: 120_000 }, async () => {
  assert.equal(parseArgs(["--no-claude-desktop"]).claudeDesktop, false);
  assert.equal(parseArgs([]).claudeDesktop, true);
  assert.equal(parseArgs([]).claudeCode, false);
  assert.equal(parseArgs(["--claude-code"]).claudeCode, true);
  const drop = (flag) => (a, i, all) => a !== flag && all[i - 1] !== flag;
  const guardDir = path.join(os.tmpdir(), "mxs-nodesktop-guard");
  const base = ["--port", "19001", "--bridge", path.join(guardDir, "b.mjs")];
  const without = sandboxArgs(guardDir).filter(drop("--claude-desktop-config"));
  assert.match(testSandboxProblem(parseArgs([...without, ...base])) ?? "", /--claude-desktop-config がありません（Claude Desktop に登録しないなら --no-claude-desktop）/);
  assert.equal(testSandboxProblem(parseArgs([...without, ...base, "--no-claude-desktop"])), null);
  // Microsoft Store 版を探すフォルダも、一時フォルダの外・本物の場所は拒む
  const outside = parseArgs([...sandboxArgs(guardDir), ...base, "--claude-desktop-packages-dir", path.join(os.homedir(), "AppData", "Local", "Packages")]);
  assert.match(testSandboxProblem(outside) ?? "", /--claude-desktop-packages-dir が/);

  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-nodesktop-flag-"));
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    const port = await freePort();
    const desktopConfig = path.join(dir, "claude_desktop_config.json");
    const original = JSON.stringify({ mcpServers: { other: { command: "npx", args: ["x"] } } }, null, 2);
    writeFileSync(desktopConfig, original, "utf8");
    const common = [...sandboxArgs(dir), "--no-start", "--no-autostart", "--no-shortcut", "--port", String(port), "--bridge", bridge];

    const skipped = await runJson([...common, "--no-claude-desktop"]);
    assert.equal(skipped.code, 0, skipped.stdout);
    assert.equal(readFileSync(desktopConfig, "utf8"), original, "書き換えない");
    assert.equal(stepOf(skipped.json, "claude_desktop")[0].level, "skip");
    assert.match(stepOf(skipped.json, "claude_desktop")[0].message, /--no-claude-desktop/);
    assert.equal(stepOf((await runJson([...common, "--no-claude-desktop", "--status"])).json, "claude_desktop")[0].level, "skip");

    // ふつうに入れたあと、--no-claude-desktop で取り消すと Claude Desktop の分は残す
    assert.equal(await quietMain(common), 0);
    const registered = readFileSync(desktopConfig, "utf8");
    assert.ok(JSON.parse(registered).mcpServers.mxstage);
    const un = await runJson([...common, "--no-claude-desktop", "--uninstall"]);
    assert.equal(un.code, 0, un.stdout);
    assert.equal(readFileSync(desktopConfig, "utf8"), registered, "--no-claude-desktop の取り消しでは触らない");
    assert.equal(stepOf(un.json, "claude_desktop")[0].level, "skip");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--no-bob / bobPaths / bobWanted / skillTargets: ~/.bob があるときだけ IBM Bob に登録し、Skill は ~/.bob/skills に写す", () => {
  assert.equal(parseArgs(["--no-bob"]).bob, false);
  assert.equal(parseArgs([]).bob, true);
  assert.equal(parseArgs(["--bob-dir", "x"]).bobDir, "x");
  const dir = path.join(os.tmpdir(), "mxs-bob-paths", ".bob");
  const bp = bobPaths(dir);
  assert.equal(bp.bobConfig, path.join(dir, "settings", "mcp.json"));
  assert.equal(bp.bobSkillsDir, path.join(dir, "skills"));
  const on = parseArgs([]);
  assert.equal(bobWanted(on, bp, () => true).ok, true);
  assert.match(bobWanted(on, bp, () => false).reason, /IBM Bob の設定フォルダ.*が無い/);
  assert.match(bobWanted(parseArgs(["--no-bob"]), bp, () => true).reason, /--no-bob/);
  const paths = { ...bp, claudeSkillsDir: "x", antigravityDir: "none", codexDir: "none" };
  assert.deepEqual(
    skillTargets(on, paths, (p) => p === dir).map((t) => [t.id, t.dir]),
    [
      ["skills", "x"],
      ["bob_skills", bp.bobSkillsDir],
    ],
  );
  assert.deepEqual(skillTargets(parseArgs(["--no-bob"]), paths, () => true).map((t) => t.id).includes("bob_skills"), false);

  // 試験の囲い: --no-bob なら --bob-dir は要らない。本物の ~/.bob は拒む
  const guardDir = path.join(os.tmpdir(), "mxs-nobob");
  const base = ["--port", "19001", "--bridge", path.join(guardDir, "b.mjs")];
  const without = sandboxArgs(guardDir).filter((a, i, all) => a !== "--bob-dir" && all[i - 1] !== "--bob-dir");
  assert.match(testSandboxProblem(parseArgs([...without, ...base])) ?? "", /--bob-dir がありません（IBM Bob に登録しないなら --no-bob）/);
  assert.equal(testSandboxProblem(parseArgs([...without, ...base, "--no-bob"])), null);
  assert.match(testSandboxProblem(parseArgs([...without, ...base, "--bob-dir", path.join(os.homedir(), ".bob")])) ?? "", /--bob-dir が/);
});

test("IBM Bob: 入っていれば ~/.bob/settings/mcp.json に登録し Skill も写す（ほかのサーバは残す）。状態に出し、取り消しで外す。入っていなければ・--no-bob なら触らない", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-bob-"));
  try {
    const bridge = path.join(dir, "fake-bridge.mjs");
    writeFileSync(bridge, FAKE_BRIDGE, "utf8");
    const port = await freePort();
    const common = [...sandboxArgs(dir), "--no-start", "--no-autostart", "--no-shortcut", "--port", String(port), "--bridge", bridge];
    const bobDir = path.join(dir, "bob");
    const bobConfig = path.join(bobDir, "settings", "mcp.json");
    const bobSkills = path.join(bobDir, "skills");
    const repoSkills = readRepoSkills(REPO_ROOT);

    // --- IBM Bob が入っていない（~/.bob が無い）: 何も作らない ---
    const absent = await runJson(common);
    assert.equal(absent.code, 0, absent.stdout);
    assert.equal(stepOf(absent.json, "bob")[0].level, "skip");
    assert.equal(existsSync(bobDir), false, "入れていない PC に ~/.bob を作らない");
    assert.equal(stepOf(absent.json, "bob_skills").length, 0);
    assert.equal(stepOf((await runJson([...common, "--status"])).json, "bob")[0].level, "skip");

    // --- 入っている: ほかのサーバ（利用者の設定）を残して 1 ブロックだけ足す ---
    const other = { command: "npx", args: ["-y", "@ibm/maximo-mcp"], disabled: false, alwaysAllow: [] };
    mkdirSync(path.dirname(bobConfig), { recursive: true });
    writeFileSync(bobConfig, JSON.stringify({ mcpServers: { other } }, null, 2), "utf8");
    mkdirSync(path.join(bobSkills, "bob-own"), { recursive: true });
    writeFileSync(path.join(bobSkills, "bob-own", "SKILL.md"), "---\nname: bob-own\n---\n利用者の Skill\n", "utf8");

    // --no-bob なら、入っていても触らない
    const before = readFileSync(bobConfig, "utf8");
    const off = await runJson([...common, "--no-bob"]);
    assert.equal(off.code, 0, off.stdout);
    assert.equal(readFileSync(bobConfig, "utf8"), before);
    assert.match(stepOf(off.json, "bob")[0].message, /--no-bob/);
    assert.equal(existsSync(path.join(bobSkills, repoSkills[0].name)), false);

    const first = await runJson(common);
    assert.equal(first.code, 0, first.stdout);
    const written = JSON.parse(readFileSync(bobConfig, "utf8"));
    assert.deepEqual(written.mcpServers.other, other, "ほかの MCP サーバを消していない");
    assert.deepEqual(written.mcpServers.mxstage, { command: process.execPath, args: [bridge, "--port", String(port)] }, "Claude Desktop と同じ stdio の形");
    const s = stepOf(first.json, "bob")[0];
    assert.equal(s.level, "ok");
    assert.match(s.hint, /IBM Bob を再起動/);
    assert.match(s.hint, /控え/);
    assert.ok(first.json.result.installed.bob);
    for (const skill of repoSkills) {
      assert.equal(readFileSync(path.join(bobSkills, skill.name, "SKILL.md"), "utf8"), skill.text, `${skill.name} を IBM Bob にも入れた`);
    }
    assert.equal(stepOf(first.json, "bob_skills")[0].level, "ok");
    const state = JSON.parse(readFileSync(path.join(dir, "state", "setup.json"), "utf8"));
    assert.deepEqual(state.installed.bobSkills.map((sk) => sk.name), repoSkills.map((sk) => sk.name));
    assert.equal(state.skillDirs.bobSkills, bobSkills);
    assert.equal(state.previous.bob, null);
    assert.match((await runMain(common)).stdout, /IBM Bob: 再起動すると/);

    // --- 状態を見る・もう一度（冪等）---
    const status = await runJson([...common, "--status"]);
    assert.equal(stepOf(status.json, "bob")[0].level, "ok");
    assert.equal(stepOf(status.json, "bob_skills")[0].level, "ok");
    const again = await runJson(common);
    assert.match(stepOf(again.json, "bob")[0].message, /既に同じ設定/);
    assert.deepEqual(JSON.parse(readFileSync(bobConfig, "utf8")), written);

    // --- 取り消し ---
    const un = await runJson([...common, "--uninstall"]);
    assert.equal(un.code, 0, un.stdout);
    const after = JSON.parse(readFileSync(bobConfig, "utf8"));
    assert.equal("mxstage" in after.mcpServers, false, "IBM Bob から外れる");
    assert.deepEqual(after.mcpServers.other, other);
    for (const skill of repoSkills) assert.equal(existsSync(path.join(bobSkills, skill.name)), false, `${skill.name} は消す`);
    assert.equal(existsSync(path.join(bobSkills, "bob-own", "SKILL.md")), true, "利用者の Skill は消さない");
    assert.equal(stepOf(un.json, "bob")[0].level, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 最後に: 本物の設定ファイルとフォルダに触れていない（この試験の前後で更新時刻を比べる）
// ---------------------------------------------------------------------------

test("Node は 22.6 以上だけを受け付ける（橋渡しは --experimental-strip-types で動く）", () => {
  for (const v of ["22.6.0", "22.19.0", "v22.6.0", "23.0.0", "24.1.2"]) assert.equal(nodeVersionOk(v), true, v);
  for (const v of ["22.5.1", "22.0.0", "20.18.0", "18.20.4", ""]) assert.equal(nodeVersionOk(v), false, v);
});

test("更新のあとは、依存を入れ直し・画面をビルドし直す（もとの方が新しいときだけ）", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-fresh-"));
  try {
    const at = (rel, seconds) => {
      const file = path.join(dir, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "x", "utf8");
      const t = new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
      utimesSync(file, t, t);
    };
    // 何も無い
    assert.match(needsInstall(dir) ?? "", /node_modules/);
    assert.match(needsBuild(dir) ?? "", /dist\/app/);

    // 入れてビルドした直後（もとの方が古い）
    at("package-lock.json", 10);
    at("src/app/main.tsx", 10);
    at("skills/a/SKILL.md", 10);
    at("node_modules/.package-lock.json", 20);
    at("dist/app/index.html", 30);
    assert.equal(needsInstall(dir), null);
    assert.equal(needsBuild(dir), null);

    // git pull で画面のもとと既定の Skill が新しくなった
    at("src/app/main.tsx", 40);
    at("skills/a/SKILL.md", 40);
    assert.match(needsBuild(dir) ?? "", /src\/app/);
    assert.match(needsBuild(dir) ?? "", /skills/);
    assert.equal(needsInstall(dir), null);

    // 依存の一覧が新しくなった
    at("package-lock.json", 50);
    assert.match(needsInstall(dir) ?? "", /package-lock\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildIco: public の PNG をそのまま詰めた .ico を作る（ショートカットがブラウザのアイコンにならないように）", () => {
  const pngs = ["favicon-32.png", "icon-192.png"].map((f) => readFileSync(path.join(REPO_ROOT, "public", f)));
  const ico = buildIco(pngs);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
  assert.deepEqual([ico.readUInt8(6), ico.readUInt8(22)], [32, 192]);
  const offset = ico.readUInt32LE(6 + 12);
  assert.deepEqual(ico.subarray(offset, offset + pngs[0].length), pngs[0]);
  assert.equal(ico.length, 6 + 32 + pngs[0].length + pngs[1].length);
  assert.throws(() => buildIco([readFileSync(path.join(REPO_ROOT, "public", "icon-512.png"))]));
});

test("npmEnv:npm には IBM のテレメトリを止める変数を渡し、ほかの環境変数はそのまま渡す", () => {
  const env = npmEnv({ PATH: "x", IBM_TELEMETRY_DISABLED: "false" });
  assert.equal(env.IBM_TELEMETRY_DISABLED, "true");
  assert.equal(env.PATH, "x");
  assert.equal(npmEnv().IBM_TELEMETRY_DISABLED, "true");
});

test("本物の ~/.claude.json・Claude Desktop（Microsoft Store 版を含む）・Antigravity・Codex・IBM Bob・スタートアップ・デスクトップ・~/.config/mxstage・改名前の ~/.config/mxstudio に触れていない（更新時刻を比べる）", (t) => {
  const after = snapshotReal(REAL_TARGETS);
  const problems = [];
  const notes = [];
  for (const before of REAL_BEFORE) {
    const now = after.find((a) => a.path === before.path);
    if (before.exists !== now.exists) {
      problems.push(`${before.path}: ${before.exists ? "あった" : "無かった"} → ${now.exists ? "ある" : "無い"}`);
      continue;
    }
    if (!before.exists) continue;
    if ((before.type === "json" || before.type === "toml") && (before.entry !== now.entry || now.tmp)) {
      problems.push(`${before.path}: MX Stage の設定が変わった、または書きかけの一時ファイルがある`);
      continue;
    }
    if (before.names !== undefined && JSON.stringify(before.names) !== JSON.stringify(now.names)) {
      problems.push(`${before.path}: 名前に mxstage か mxstudio を含むファイルが増減した（${JSON.stringify(before.names)} → ${JSON.stringify(now.names)}）`);
      continue;
    }
    if (before.mtimeMs === now.mtimeMs) continue;
    if (before.type === "strict") {
      problems.push(`${before.path}: 更新時刻が変わった（ほかに書くプログラムの無い場所）`);
      continue;
    }
    // 更新時刻は変わったが、MX Stage に関わる中身は同じ。持ち主（試験の外で動いているプログラム）の書き込みと見なして知らせる
    notes.push(`${before.path}: 更新時刻が変わりました（${new Date(before.mtimeMs).toISOString()} → ${new Date(now.mtimeMs).toISOString()}）。MX Stage に関わる中身は同じなので、${before.owner} 自身の書き込みと見なします。`);
  }
  for (const note of notes) t.diagnostic(note);
  t.diagnostic(`比べた場所: ${REAL_BEFORE.length} 件（うち存在 ${REAL_BEFORE.filter((b) => b.exists).length} 件）・更新時刻が同じ: ${REAL_BEFORE.filter((b) => b.exists && after.find((a) => a.path === b.path).mtimeMs === b.mtimeMs).length} 件`);
  assert.deepEqual(problems, [], problems.join("\n"));
});
