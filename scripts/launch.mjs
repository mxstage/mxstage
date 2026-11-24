#!/usr/bin/env node
// MX Stage の起動の台本（launcher）。導入（scripts/setup-local.mjs）がこのファイルを状態フォルダ（~/.config/mxstage/launch.mjs）に写し、
// Claude などの MCP の設定とログイン時の自動起動は、橋渡しの入口ではなくこのファイルを起動する。
// どの版を起こすかは、同じフォルダの versions.json で決める（起動のたびに 1 回だけ読む）:
//   1. 用意済みの版（ready）があり、中身がそろっていれば、それを今の版（current）にしてから起こす。
//      版が切り替わるのは、ここ（起動のとき）だけ。動いている橋渡しは止めない。
//   2. 今の版（current）の中身がそろっていれば、それを起こす。
//   3. どちらも無ければ、導入したフォルダ（seed。%USERPROFILE%\mxstage の clone）の入口を起こす。
// 版ごとのフォルダ（v/<commit>）を分けるのは、新しい版を用意する間も、動いている版のファイル（node_modules・dist/app）を
// 書き換えないため（Windows では動いているプロセスのファイルを入れ替えられないことがあり、作業画面の配信も途中で変わってしまう）。
// 新しい版の用意は橋渡しの mxstage_update（src/bridge/selfUpdate.ts）が行い、ready に書くだけ。
//
// Node の標準機能だけで動く（依存を持たない。版のフォルダの外に置くので、どの版が動いていても置き換えられる）。
// 入口（.ts）を同じプロセスで読み込むので、--experimental-strip-types を付けて起動する（導入がそう登録する）。
//
//   node --experimental-strip-types launch.mjs [橋渡しの引数]   どれかの版の橋渡しを起こす
//   node launch.mjs --launcher-check                            起こす版を JSON で出すだけ（何も書き換えない）

import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** どの版を起こすかの記録（状態フォルダの直下） */
export const VERSIONS_FILE = "versions.json";
/** 版ごとのフォルダを置くところ（状態フォルダの下）。パスが長くなりすぎないよう短い名前にする */
export const VERSIONS_DIR = "v";
/** 用意が終わった版のフォルダに置く印（版・commit・用意した時刻）。これが無いフォルダは起こさない */
export const READY_MARKER = ".mxstage-ready.json";
/** 版のフォルダの中の橋渡しの入口 */
export const VERSION_ENTRY = ["src", "bridge", "cli.ts"];
/** 版のフォルダの中の作業画面 */
export const VERSION_APP = ["dist", "app", "index.html"];
/** 橋渡しに「この台本から起こされた」と知らせる環境変数（値は台本の絶対パス） */
export const LAUNCHER_ENV = "MXSTAGE_LAUNCHER";
/** 起こす版を出すだけの引数 */
const CHECK_FLAG = "--launcher-check";

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 版の記録を読む。無い・壊れているときは空の記録 */
export function readVersions(stateDir) {
  const empty = { schema: 1, seed: null, current: null, ready: null, previous: null, lastPrepare: null, lastCheck: null };
  try {
    const v = JSON.parse(readFileSync(path.join(stateDir, VERSIONS_FILE), "utf8"));
    if (!v || typeof v !== "object") return empty;
    return {
      ...empty,
      ...v,
      seed: seedOf(v.seed),
      current: refOf(v.current),
      ready: refOf(v.ready),
      previous: refOf(v.previous),
    };
  } catch {
    return empty;
  }
}

/** 版の記録を書く（途中で切れても壊れないよう、別の名前に書いてから置き換える） */
export function writeVersions(stateDir, state) {
  mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, VERSIONS_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

function refOf(v) {
  if (!v || typeof v !== "object" || typeof v.dir !== "string" || typeof v.commit !== "string") return null;
  return {
    commit: v.commit,
    dir: v.dir,
    version: typeof v.version === "string" ? v.version : null,
    preparedAt: typeof v.preparedAt === "number" ? v.preparedAt : null,
  };
}

function seedOf(v) {
  if (!v || typeof v !== "object" || typeof v.entry !== "string") return null;
  return { entry: v.entry, root: typeof v.root === "string" ? v.root : null };
}

/** 版のフォルダの入口 */
export function versionEntry(dir) {
  return path.join(dir, ...VERSION_ENTRY);
}

/** 版のフォルダの中身がそろっているか（入口・作業画面・用意が終わった印） */
export function versionComplete(dir, exists = isFile) {
  if (typeof dir !== "string" || dir === "") return false;
  return exists(versionEntry(dir)) && exists(path.join(dir, ...VERSION_APP)) && exists(path.join(dir, READY_MARKER));
}

/**
 * どの版を起こすかを決める（書き換えはしない。promoted のときは next を書いてから起こす）。
 * 戻り値: { entry, root, source: "ready" | "current" | "seed", promoted, next } / 起こせる版が無ければ { entry: null, … }
 */
export function chooseLaunch(state, exists = isFile) {
  if (state.ready && versionComplete(state.ready.dir, (p) => exists(p))) {
    const next = { ...state, previous: state.current ?? state.previous ?? null, current: state.ready, ready: null };
    return { entry: versionEntry(state.ready.dir), root: state.ready.dir, source: "ready", promoted: true, next };
  }
  if (state.current && versionComplete(state.current.dir, (p) => exists(p))) {
    return { entry: versionEntry(state.current.dir), root: state.current.dir, source: "current", promoted: false, next: state };
  }
  if (state.seed && exists(state.seed.entry)) {
    return { entry: state.seed.entry, root: state.seed.root ?? path.resolve(path.dirname(state.seed.entry), "..", ".."), source: "seed", promoted: false, next: state };
  }
  return { entry: null, root: null, source: null, promoted: false, next: state };
}

async function main(argv) {
  const self = fileURLToPath(import.meta.url);
  const stateDir = path.dirname(self);
  const state = readVersions(stateDir);
  if (argv.includes(CHECK_FLAG)) {
    const chosen = chooseLaunch(state);
    process.stdout.write(`${JSON.stringify({ ok: chosen.entry !== null, entry: chosen.entry, root: chosen.root, source: chosen.source })}\n`);
    return chosen.entry !== null ? 0 : 1;
  }
  const chosen = chooseLaunch(state);
  if (chosen.entry === null) {
    process.stderr.write(
      `MX Stage: 起こせる版がありません（${path.join(stateDir, VERSIONS_FILE)}）。MX Stage を入れたフォルダで node scripts/setup-local.mjs を実行してください。\n` +
        `MX Stage: no version to start. Run node scripts/setup-local.mjs in the MX Stage folder.\n`,
    );
    return 1;
  }
  if (chosen.promoted) {
    try {
      writeVersions(stateDir, chosen.next);
    } catch {
      // 書けなくても、用意済みの版で起こす（次の起動でもう一度書く）
    }
  }
  process.env[LAUNCHER_ENV] = self;
  // 入口は「直接起動されたときだけ動く」ので、main を呼ぶ（npx の入口 bin/mxstage.mjs と同じ）。
  // main を持たない入口（試験の偽の橋渡しなど）は、読み込んだ時点で動く
  const mod = await import(pathToFileURL(chosen.entry).href);
  if (typeof mod.main === "function") {
    const code = await mod.main(argv);
    if (typeof code === "number" && code !== 0) process.exit(code);
  }
  return 0;
}

/** 直接起動されたか（試験や導入から import しても起動しない）。リンク経由でも比べられるよう実体パスで比べる */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const code = await main(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}
