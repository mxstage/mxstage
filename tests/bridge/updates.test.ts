// 新しい版の確認と入れ替え（src/bridge/updates.ts）。GitHub と git は偽物にする。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELEASES_LATEST_URL, UpdateManager, compareVersions, parseLatestRelease, type RunCommand } from "../../src/bridge/updates.ts";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mxs-upd-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MCPB = Buffer.from("fake mcpb contents");
const SHA = createHash("sha256").update(MCPB).digest("hex");
const BASE = "https://github.com/mxstage/mxstage/releases/download/v0.3.0";

function release(tag = "v0.3.0") {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: "2026-10-10T00:00:00Z",
    assets: [
      { name: "mxstage-0.3.0.mcpb", browser_download_url: `${BASE}/mxstage-0.3.0.mcpb` },
      { name: "mxstage-0.3.0.mcpb.sha256", browser_download_url: `${BASE}/mxstage-0.3.0.mcpb.sha256` },
    ],
  };
}

function fakeGitHub(opts: { tag?: string; sha?: string } = {}) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url === RELEASES_LATEST_URL) return new Response(JSON.stringify(release(opts.tag)), { status: 200 });
    if (url.endsWith(".sha256")) return new Response(`${opts.sha ?? SHA}  mxstage-0.3.0.mcpb\n`, { status: 200 });
    if (url.endsWith(".mcpb")) return new Response(MCPB, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

/** git と導入の偽物。git の答えを差し替えられる */
function fakeRun(answers: Record<string, string> = {}) {
  const calls: string[] = [];
  const run: RunCommand = async (file, args) => {
    const line = `${file.endsWith("git") ? "git" : "node"} ${args.join(" ")}`;
    calls.push(line);
    if (args[0] === "remote") return answers.origin ?? "https://github.com/mxstage/mxstage.git\n";
    if (args[0] === "rev-parse") return answers.branch ?? "main\n";
    if (args[0] === "status") return answers.status ?? "";
    return "";
  };
  return { run, calls };
}

function manager(over: Partial<ConstructorParameters<typeof UpdateManager>[0]> = {}) {
  const dir = tempDir();
  mkdirSync(join(dir, ".git"));
  return new UpdateManager({ dir, current: "0.2.2", kind: "git", repoRoot: dir, isBusy: () => false, isPrimary: () => true, ...over });
}

describe("版の比べ方と GitHub の応答", () => {
  it("番号で比べる", () => {
    expect(compareVersions("0.2.10", "0.2.9")).toBeGreaterThan(0);
    expect(compareVersions("v0.3.0", "0.3.0")).toBe(0);
    expect(compareVersions("0.2.2", "1.0.0")).toBeLessThan(0);
  });

  it("正式なリリースと、mxstage のリリースの URL だけを使う", () => {
    expect(parseLatestRelease(release())).toMatchObject({ version: "0.3.0", mcpbUrl: `${BASE}/mxstage-0.3.0.mcpb` });
    expect(parseLatestRelease({ ...release(), prerelease: true })).toBeNull();
    expect(parseLatestRelease({ ...release(), tag_name: "nightly" })).toBeNull();
    const evil = { ...release(), assets: [{ name: "x.mcpb", browser_download_url: "https://evil.example.com/x.mcpb" }] };
    expect(parseLatestRelease(evil)?.mcpbUrl).toBeNull();
  });
});

describe("自動の更新", () => {
  it("既定はオフで、オフの間は外へ問い合わせない", async () => {
    const { fetchImpl, urls } = fakeGitHub();
    const m = manager({ fetch: fetchImpl });
    expect(m.status().autoUpdate).toBe(false);
    await m.tick();
    expect(urls).toEqual([]);
  });

  it("オンにするとすぐ確かめ、作業中でなければ git で入れ替えて起動し直す", async () => {
    const { fetchImpl } = fakeGitHub();
    const { run, calls } = fakeRun();
    const restart = vi.fn();
    const m = manager({ fetch: fetchImpl, run, restart });
    const s = await m.setAutoUpdate(true);
    expect(s).toMatchObject({ autoUpdate: true, available: true, latest: { version: "0.3.0" } });
    await m.tick();
    expect(calls).toContain("git fetch --no-tags origin refs/tags/v0.3.0:refs/tags/v0.3.0");
    expect(calls).toContain("git merge --ff-only v0.3.0");
    expect(calls.some((c) => c.includes("setup-local.mjs --json --no-open"))).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("作業中は入れ替えない（作業が終わってから）", async () => {
    const { fetchImpl } = fakeGitHub();
    const { run, calls } = fakeRun();
    let busy = true;
    const restart = vi.fn();
    const m = manager({ fetch: fetchImpl, run, restart, isBusy: () => busy });
    await m.setAutoUpdate(true);
    await m.tick();
    expect(calls).toEqual([]);
    busy = false;
    await m.tick();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("1 日たつまでは問い合わせ直さない", async () => {
    let now = 1_000_000;
    const { fetchImpl, urls } = fakeGitHub({ tag: "v0.2.2" });
    const m = manager({ fetch: fetchImpl, now: () => now });
    await m.setAutoUpdate(true);
    await m.tick();
    expect(urls.filter((u) => u === RELEASES_LATEST_URL)).toHaveLength(1);
    now += 24 * 60 * 60 * 1000;
    await m.tick();
    expect(urls.filter((u) => u === RELEASES_LATEST_URL)).toHaveLength(2);
    expect(m.status().available).toBe(false);
  });

  it("main 以外・手元の変更・別の取得元の写しは触らない", async () => {
    for (const [answers, code] of [
      [{ branch: "feature\n" }, "not_main"],
      [{ status: " M src/x.ts\n" }, "local_changes"],
      [{ origin: "https://github.com/someone/fork.git\n" }, "other_origin"],
    ] as const) {
      const { fetchImpl } = fakeGitHub();
      const { run, calls } = fakeRun(answers);
      const restart = vi.fn();
      const dir = tempDir();
      // .git が無いと not_git になるので作っておく
      mkdirSync(join(dir, ".git"));
      const m = new UpdateManager({ dir, current: "0.2.2", kind: "git", repoRoot: dir, isBusy: () => false, isPrimary: () => true, fetch: fetchImpl, run, restart });
      await m.check();
      const s = await m.install();
      expect(s).toMatchObject({ phase: "error", error: code });
      expect(calls.some((c) => c.startsWith("git merge"))).toBe(false);
      expect(restart).not.toHaveBeenCalled();
    }
  });

  it("primary でない橋渡しは何もしない", async () => {
    const { fetchImpl, urls } = fakeGitHub();
    const m = manager({ fetch: fetchImpl, isPrimary: () => false });
    await m.setAutoUpdate(true);
    urls.length = 0;
    await m.tick();
    expect(urls).toEqual([]);
  });
});

describe("Claude Desktop の拡張機能（.mcpb）", () => {
  it("自分では入れ替えず、押したらダウンロードして SHA-256 を確かめ、置き場所を開く", async () => {
    const { fetchImpl } = fakeGitHub();
    const reveal = vi.fn();
    const m = manager({ kind: "bundle", fetch: fetchImpl, reveal });
    await m.setAutoUpdate(true);
    await m.tick();
    expect(m.status().downloaded).toBeNull();
    const s = await m.install();
    expect(s.downloaded).not.toBeNull();
    expect(readFileSync(s.downloaded as string)).toEqual(MCPB);
    expect(reveal).toHaveBeenCalledWith(s.downloaded);
  });

  it("SHA-256 が合わなければ捨てる", async () => {
    const { fetchImpl } = fakeGitHub({ sha: "0".repeat(64) });
    const m = manager({ kind: "bundle", fetch: fetchImpl });
    await m.check();
    const s = await m.install();
    expect(s).toMatchObject({ phase: "error", error: "checksum_mismatch", downloaded: null });
    expect(existsSync(join(tempDir(), "updates"))).toBe(false);
  });
});
