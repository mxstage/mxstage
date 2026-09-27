// 公開の前の検査（scripts/check-publish.mjs）の試験。
// 一時フォルダに試験用の git リポジトリと語の一覧を作って動かす（本物のリポジトリと ~/.config/mxstudio には触れない）。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultTermsPath, findTerms, isText, parseArgs, parsePrePushInput, parseTerms, run } from "../../scripts/check-publish.mjs";

const SCRIPT = path.resolve(import.meta.dirname, "..", "..", "scripts", "check-publish.mjs");
const ZERO = "0".repeat(40);

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** 試験用のリポジトリ（架空の客先名「ACME 化学」とサイト「ZZQ」を客先の情報とみなす） */
function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mxs-publish-"));
  const repo = path.join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "試験");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "core.autocrlf", "false");
  const terms = path.join(dir, "publish-terms.txt");
  writeFileSync(terms, "# 試験の語\n\nACME化学\n\\bZZQ\\b\ni:secret-host\n", "utf8");
  const commit = (files, message) => {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
      writeFileSync(path.join(repo, name), content);
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", message);
    return git(repo, "rev-parse", "HEAD");
  };
  return { dir, repo, terms, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function cli(repo, args, input) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, input, encoding: "utf8", windowsHide: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("parseTerms: 注釈と空行を読み飛ばし、i: で大文字小文字を区別しない。読めない行は理由を返す", () => {
  const { terms, errors } = parseTerms("\uFEFF# 注釈\n\nACME\ni:Secret\n[壊れた\n");
  assert.deepEqual(
    terms.map((t) => t.label),
    ["ACME", "i:Secret"],
  );
  assert.equal(terms[1].re.test("SECRET"), true);
  assert.equal(terms[0].re.test("acme"), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /5 行目/);
});

test("findTerms・isText・parsePrePushInput・parseArgs・defaultTermsPath", () => {
  const { terms } = parseTerms("\\bZZQ\\b\n");
  assert.deepEqual(findTerms("a\nsite ZZQ\nZZQX", terms), [{ line: 2, term: "\\bZZQ\\b" }]);
  assert.equal(isText(Buffer.from("abc")), true);
  assert.equal(isText(Buffer.from([0x89, 0x50, 0x00, 0x47])), false);
  const sha = "a".repeat(40);
  assert.deepEqual(parsePrePushInput(`refs/heads/main ${sha} refs/heads/main ${ZERO}\nrefs/heads/old ${ZERO} refs/heads/old ${sha}\n`), [
    { localRef: "refs/heads/main", localSha: sha, remoteRef: "refs/heads/main", remoteSha: ZERO },
  ]);
  assert.deepEqual(parseArgs(["--pre-push", "origin", "https://example.invalid/r.git"]), { all: false, worktree: false, prePush: true, remote: "origin", terms: null });
  assert.match(parseArgs(["--nope"]).error, /知らない引数/);
  assert.equal(defaultTermsPath({ MXSTUDIO_PUBLISH_TERMS: " C:\\t\\x.txt " }, "C:\\h"), "C:\\t\\x.txt");
  assert.equal(defaultTermsPath({}, "C:\\h"), path.join("C:\\h", ".config", "mxstudio", "publish-terms.txt"));
});

test("履歴のどこかのコミットに客先の情報があれば止め、どのコミットのどのファイルかを出す。履歴を作り直せば通る", () => {
  const r = makeRepo();
  try {
    r.commit({ "README.md": "# 架空の道具\n" }, "最初");
    const dirty = r.commit({ "docs/plan.md": "客先: ACME化学\nサイト ZZQ\n" }, "計画");
    r.commit({ "docs/plan.md": "客先: （伏せる）\n" }, "客先名を消す");
    const found = cli(r.repo, ["--terms", r.terms]);
    assert.equal(found.code, 1, found.out);
    assert.match(found.out, new RegExp(`${dirty.slice(0, 7)} docs/plan\\.md:1  「ACME化学」`));
    assert.match(found.out, /docs\/plan\.md:2  「\\bZZQ\\b」/);
    // 今の中身だけで最初のコミットを作り直すと、古いコミットは調べる範囲に入らない
    const root = git(r.repo, "commit-tree", "HEAD^{tree}", "-m", "公開用の最初のコミット");
    git(r.repo, "update-ref", "refs/heads/main", root);
    const clean = cli(r.repo, ["--terms", r.terms]);
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /\[OK\]/);
  } finally {
    r.cleanup();
  }
});

test("--pre-push: 送り先にまだ無いコミットだけを調べ、当たれば送らない。消すだけの送信は通す", () => {
  const r = makeRepo();
  try {
    const clean = r.commit({ "a.txt": "ok\n" }, "最初");
    const dirty = r.commit({ "b.txt": "host: SECRET-HOST.example\n" }, "足す");
    const blocked = cli(r.repo, ["--terms", r.terms, "--pre-push", "origin", "https://example.invalid/r.git"], `refs/heads/main ${dirty} refs/heads/main ${ZERO}\n`);
    assert.equal(blocked.code, 1, blocked.out);
    assert.match(blocked.out, /送りません/);
    assert.match(blocked.out, /b\.txt:1  「i:secret-host」/);
    const ok = cli(r.repo, ["--terms", r.terms, "--pre-push", "origin"], `refs/heads/main ${clean} refs/heads/main ${ZERO}\n`);
    assert.equal(ok.code, 0, ok.out);
    const deletion = cli(r.repo, ["--terms", r.terms, "--pre-push", "origin"], `(delete) ${ZERO} refs/heads/old ${dirty}\n`);
    assert.equal(deletion.code, 0, deletion.out);
  } finally {
    r.cleanup();
  }
});

test("ファイルのパスとコミットの説明文も調べる。画像などテキストでないファイルの中身は読まない", () => {
  const r = makeRepo();
  try {
    r.commit({ "ZZQ/readme.txt": "ok\n", "img.bin": Buffer.from([0, 1, 2, ...Buffer.from("ACME化学")]) }, "ACME化学 向けの調整");
    const out = cli(r.repo, ["--terms", r.terms]);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /ZZQ\/readme\.txt  「\\bZZQ\\b」/, "パス");
    assert.match(out.out, /（コミットの説明文）  「ACME化学」/, "説明文");
    assert.doesNotMatch(out.out, /img\.bin/, "テキストでないファイルの中身は読まない");
  } finally {
    r.cleanup();
  }
});

test("--worktree: まだコミットしていないファイルも調べる（.gitignore で外したものは除く）", () => {
  const r = makeRepo();
  try {
    r.commit({ ".gitignore": "local/\n", "a.txt": "ok\n" }, "最初");
    writeFileSync(path.join(r.repo, "draft.md"), "ACME化学 の件\n");
    mkdirSync(path.join(r.repo, "local"));
    writeFileSync(path.join(r.repo, "local", "memo.txt"), "ZZQ\n");
    assert.equal(cli(r.repo, ["--terms", r.terms]).code, 0, "履歴だけなら通る");
    const out = cli(r.repo, ["--terms", r.terms, "--worktree"]);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /作業中 draft\.md:1  「ACME化学」/);
    assert.doesNotMatch(out.out, /memo\.txt/);
  } finally {
    r.cleanup();
  }
});

test("語の一覧が無い・空・読めないときは、調べずに通さない（終了コード 2）", () => {
  const r = makeRepo();
  try {
    r.commit({ "a.txt": "ok\n" }, "最初");
    const missing = cli(r.repo, ["--terms", path.join(r.dir, "none.txt")]);
    assert.equal(missing.code, 2);
    assert.match(missing.out, /語の一覧がありません/);
    writeFileSync(r.terms, "# 注釈だけ\n");
    assert.equal(cli(r.repo, ["--terms", r.terms]).code, 2);
    writeFileSync(r.terms, "[壊れた\n");
    assert.match(cli(r.repo, ["--terms", r.terms]).out, /読めない行/);
    // run を直接呼んでも同じ（標準入力を読まない）
    assert.equal(run(["--terms", path.join(r.dir, "none.txt")], { cwd: r.repo }).code, 2);
  } finally {
    r.cleanup();
  }
});
