#!/usr/bin/env node
// 公開（git push）の前に、客先の情報を含むコミットやファイルが無いかを調べる。
// 探す語はリポジトリの外（~/.config/mxstudio/publish-terms.txt）に置く（一覧そのものが客先の情報なので）。
// - pre-push フック（.githooks/pre-push）から呼ばれると、送ろうとしているコミット（送り先にまだ無いもの）を全部調べ、
//   1 つでも当たれば送らない。語の一覧が無いときも送らない（調べずに通さない）。
// - 手で動かすと、今のブランチの履歴（--all ならすべてのブランチとタグ、--worktree なら作業中のファイルも）を調べる。
// 調べるのは、各コミットのファイルの中身（テキストだけ）・ファイルのパス・コミットの説明文。
// Node の標準機能だけで動く（依存を足さない）。
//
//   node scripts/check-publish.mjs                 今のブランチの履歴
//   node scripts/check-publish.mjs --all           すべてのブランチとタグの履歴
//   node scripts/check-publish.mjs --worktree      今のブランチの履歴と、作業中のファイル（まだコミットしていない変更）
//   node scripts/check-publish.mjs --pre-push <送り先の名前>   pre-push フック用（送る範囲を標準入力から読む）
//   --terms <パス>   語の一覧（既定: 環境変数 MXSTUDIO_PUBLISH_TERMS か ~/.config/mxstudio/publish-terms.txt）
//
// 終了コード: 0 = 当たりなし、1 = 当たりあり（送らない）、2 = 語の一覧が無い・引数が不正など（送らない）。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** 画面に出す当たりの数の上限（残りは件数だけ出す） */
const MAX_REPORT = 50;
/** 作業中のファイルで読む大きさの上限（これより大きいファイルはパスだけ調べる） */
const MAX_WORKTREE_BYTES = 5 * 1024 * 1024;

export function defaultTermsPath(env = process.env, home = os.homedir()) {
  const fromEnv = typeof env.MXSTUDIO_PUBLISH_TERMS === "string" ? env.MXSTUDIO_PUBLISH_TERMS.trim() : "";
  return fromEnv !== "" ? fromEnv : path.join(home, ".config", "mxstudio", "publish-terms.txt");
}

/**
 * 語の一覧を読む。1 行に 1 つの正規表現（先頭に「i:」で大文字小文字を区別しない）。「#」で始まる行と空行は読み飛ばす。
 * 返すのは { terms: [{ label, re }], errors }（読めない行は errors に理由を入れる）
 */
export function parseTerms(text) {
  const terms = [];
  const errors = [];
  text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) return;
      const ignoreCase = line.startsWith("i:");
      const source = ignoreCase ? line.slice(2) : line;
      try {
        terms.push({ label: line, re: new RegExp(source, ignoreCase ? "i" : "") });
      } catch (err) {
        errors.push(`${i + 1} 行目「${line}」は正規表現として読めません（${err instanceof Error ? err.message : String(err)}）`);
      }
    });
  return { terms, errors };
}

/** テキストの中で当たった語と行（1 始まり） */
export function findTerms(text, terms) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const t of terms) if (t.re.test(line)) hits.push({ line: i + 1, term: t.label });
  });
  return hits;
}

/** 中身がテキストか（NUL を含むものは画像などとして中身を調べない） */
export function isText(buf) {
  return !buf.subarray(0, 8000).includes(0);
}

/**
 * pre-push フックの標準入力（1 行に「送る側の参照 送る側の SHA 送り先の参照 送り先の SHA」）を読む。
 * 消すだけの送信（送る側の SHA が 0 だけ）は調べるものが無いので除く
 */
export function parsePrePushInput(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 4 && !/^0+$/.test(p[1]))
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }));
}

function git(cwd, args, opts = {}) {
  // 中身を Buffer のまま受け取るときは encoding を付けない（付けると入力の文字列もその名前で変換しようとする）
  const r = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    input: opts.input === undefined ? undefined : Buffer.from(opts.input, "utf8"),
    ...(opts.buffer ? {} : { encoding: "utf8" }),
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} が失敗しました: ${String(r.stderr ?? "").trim()}`);
  return r.stdout;
}

/** 調べるコミット（新しい順） */
export function commitsToCheck(cwd, mode) {
  const list = (args, input) =>
    git(cwd, args, input !== undefined ? { input } : {})
      .split(/\r?\n/)
      .filter(Boolean);
  if (mode.kind === "pre-push") {
    const seen = new Set();
    for (const p of mode.pushes) {
      // 送り先に既にあるコミットは調べ直さない（まだ一度も取得していない送り先なら、履歴を全部調べる）
      const args = ["rev-list", p.localSha];
      if (mode.remote) args.push("--not", `--remotes=${mode.remote}`);
      for (const c of list(args)) seen.add(c);
    }
    return Array.from(seen);
  }
  return list(["rev-list", mode.all ? "--all" : "HEAD"]);
}

/** blob をまとめて読む（git cat-file --batch）。SHA → Buffer */
function readBlobs(cwd, shas) {
  const out = new Map();
  if (shas.length === 0) return out;
  const buf = git(cwd, ["cat-file", "--batch"], { input: `${shas.join("\n")}\n`, buffer: true });
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const header = buf.subarray(at, nl).toString("utf8").split(" ");
    at = nl + 1;
    if (header[1] === "missing" || header.length < 3) continue;
    const size = Number(header[2]);
    out.set(header[0], buf.subarray(at, at + size));
    at += size + 1;
  }
  return out;
}

/**
 * コミットを調べる。同じ中身のファイル（blob）は 1 回だけ読む。
 * 返すのは当たりの並び: { commit, path, line, term }（line が 0 はパスそのもの、-1 はコミットの説明文）
 */
export function scanCommits(cwd, commits, terms) {
  const hits = [];
  const blobPlaces = new Map(); // blob SHA → [{ commit, path }]
  const pathHits = new Set();
  for (const commit of commits) {
    const entries = git(cwd, ["ls-tree", "-r", "-z", commit]).split("\0").filter(Boolean);
    for (const entry of entries) {
      const tab = entry.indexOf("\t");
      const [, type, sha] = entry.slice(0, tab).split(" ");
      const file = entry.slice(tab + 1);
      if (type !== "blob") continue;
      const places = blobPlaces.get(sha) ?? [];
      places.push({ commit, path: file });
      blobPlaces.set(sha, places);
      for (const h of findTerms(file, terms)) {
        const key = `${file}\0${h.term}`;
        if (pathHits.has(key)) continue;
        pathHits.add(key);
        hits.push({ commit, path: file, line: 0, term: h.term });
      }
    }
  }
  const blobs = readBlobs(cwd, Array.from(blobPlaces.keys()));
  for (const [sha, places] of blobPlaces) {
    const buf = blobs.get(sha);
    if (!buf || !isText(buf)) continue;
    const found = findTerms(buf.toString("utf8"), terms);
    if (found.length === 0) continue;
    // 同じ中身が複数のコミットにあれば、いちばん古いコミット（rev-list の最後）で知らせる
    const where = places[places.length - 1];
    for (const h of found) hits.push({ commit: where.commit, path: where.path, line: h.line, term: h.term, also: places.length - 1 });
  }
  if (commits.length > 0) {
    const log = git(cwd, ["log", "--no-walk", "--stdin", "--format=%H%x1f%B%x1e"], { input: `${commits.join("\n")}\n` });
    for (const record of log.split("\x1e")) {
      const [commit, message] = record.replace(/^\s+/, "").split("\x1f");
      if (!commit || message === undefined) continue;
      for (const h of findTerms(message, terms)) hits.push({ commit: commit.trim(), path: "（コミットの説明文）", line: -1, term: h.term });
    }
  }
  return hits;
}

/** 作業中のファイル（まだコミットしていないものも含む。.gitignore で外したものは除く）を調べる */
export function scanWorktree(cwd, terms) {
  const hits = [];
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const files = git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
  for (const file of files) {
    for (const h of findTerms(file, terms)) hits.push({ commit: null, path: file, line: 0, term: h.term });
    const full = path.join(root, file);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // 消したファイル
    }
    if (!st.isFile() || st.size > MAX_WORKTREE_BYTES) continue;
    const buf = readFileSync(full);
    if (!isText(buf)) continue;
    for (const h of findTerms(buf.toString("utf8"), terms)) hits.push({ commit: null, path: file, line: h.line, term: h.term });
  }
  return hits;
}

export function parseArgs(argv) {
  const opts = { all: false, worktree: false, prePush: false, remote: null, terms: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") opts.all = true;
    else if (a === "--worktree") opts.worktree = true;
    else if (a === "--pre-push") {
      opts.prePush = true;
      // フックは送り先の名前と URL を渡す。名前だけ使う
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) opts.remote = argv[++i];
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) i++;
    } else if (a === "--terms") {
      opts.terms = argv[++i] ?? null;
      if (!opts.terms) return { error: "--terms にはパスが要ります。" };
    } else return { error: `知らない引数です: ${a}` };
  }
  return opts;
}

function where(h) {
  const at = h.line > 0 ? `${h.path}:${h.line}` : h.path;
  const commit = h.commit ? `${h.commit.slice(0, 7)} ` : "作業中 ";
  const also = h.also ? `（同じ中身がほかに ${h.also} か所）` : "";
  return `  ${commit}${at}  「${h.term}」${also}`;
}

/** 実行する。{ code, lines } を返す（画面に出すのは呼び出し側） */
export function run(argv, { cwd = process.cwd(), env = process.env, stdin = "" } = {}) {
  const opts = parseArgs(argv);
  if (opts.error) return { code: 2, lines: [`[NG] ${opts.error}`] };
  const termsPath = opts.terms ?? defaultTermsPath(env);
  if (!existsSync(termsPath)) {
    return {
      code: 2,
      lines: [
        `[NG] 客先の語の一覧がありません（${termsPath}）。一覧が無いまま送ると確かめようがないので、送りません。`,
        "     一覧の書き方は docs/publish.md にあります。",
      ],
    };
  }
  const { terms, errors } = parseTerms(readFileSync(termsPath, "utf8"));
  if (errors.length > 0) return { code: 2, lines: ["[NG] 客先の語の一覧に読めない行があります。直してから、もう一度実行してください。", ...errors.map((e) => `  ${e}`)] };
  if (terms.length === 0) return { code: 2, lines: [`[NG] 客先の語の一覧（${termsPath}）に語がありません。送りません。`] };

  let commits;
  let hits;
  try {
    const mode = opts.prePush ? { kind: "pre-push", remote: opts.remote, pushes: parsePrePushInput(stdin) } : { kind: "history", all: opts.all };
    commits = commitsToCheck(cwd, mode);
    hits = scanCommits(cwd, commits, terms);
    if (opts.worktree) hits.push(...scanWorktree(cwd, terms));
  } catch (err) {
    return { code: 2, lines: [`[NG] 調べられませんでした: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const scope = opts.prePush ? "送るコミット" : opts.all ? "すべてのブランチとタグのコミット" : "今のブランチのコミット";
  const lines = [`公開の前の検査: ${scope} ${commits.length} 件${opts.worktree ? "と作業中のファイル" : ""}を、語 ${terms.length} 個で調べました（${termsPath}）。`];
  if (hits.length === 0) {
    lines.push("[OK] 客先の情報は見つかりませんでした。");
    return { code: 0, lines };
  }
  lines.push(`[NG] 客先の情報が ${hits.length} か所で見つかりました。${opts.prePush ? "送りません。" : ""}`);
  lines.push(...hits.slice(0, MAX_REPORT).map(where));
  if (hits.length > MAX_REPORT) lines.push(`  ほか ${hits.length - MAX_REPORT} か所`);
  lines.push(
    "直し方: 当たったところを消すか架空の名前に置き換えてコミットし直してください。",
    "        古いコミットに残っているときは、そのコミットを送らないよう履歴を作り直します（docs/publish.md）。",
  );
  return { code: 1, lines };
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  const argv = process.argv.slice(2);
  // pre-push のときだけ標準入力を読む（手で動かしたときに入力待ちで止まらないように）
  const stdin = argv.includes("--pre-push") ? readFileSync(0, "utf8") : "";
  const result = run(argv, { stdin });
  const text = result.lines.join("\n");
  if (result.code === 0) console.log(text);
  else console.error(text);
  process.exitCode = result.code;
}
