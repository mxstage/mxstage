// リポジトリ全体の決まり（版の一致・LICENSE・改名前の名前の残り方）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../../src/app/boot/version.ts";
import { LicenseStore, readDevLicenses } from "../../src/bridge/license.ts";

const ROOT = join(import.meta.dirname, "..", "..");

/**
 * 改名前の名前（mxstudio）を残してよいファイル。0.2.0 で MX Stage（mxstage）に改名したので、
 * 残してよいのは、古い名前で残っているものを見つけて移す処理と、その試験だけ。
 */
const LEGACY_NAME_ALLOWED = new Set([
  // 移行の処理
  "scripts/setup-local.mjs",
  "scripts/check-publish.mjs",
  "src/bridge/legacy.ts",
  "src/bridge/peer.ts",
  "src/bridge/coordinator.ts",
  "src/bridge/bridgeKey.ts",
  "src/bridge/cli.ts",
  "src/app/boot/migrate.ts",
  "src/app/boot/services.ts",
  "src/app/pwa/cacheRules.ts",
  // 改名の経緯（利用者向けの変更履歴）
  "CHANGELOG.md",
  // その試験
  "tests/app/migrate.test.ts",
  "tests/app/pwa.test.ts",
  "tests/bridge/legacy.test.ts",
  "tests/bridge/repo.test.ts",
  "tests/setup/check-publish.test.mjs",
  "tests/setup/setup-local.test.mjs",
]);

/** git が管理している（または管理に入る予定の）ファイル。.gitignore で外したものは含めない */
function repoFiles(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && existsSync(join(ROOT, f)));
}

describe("リポジトリ全体の決まり", () => {
  it("版は package.json・package-lock.json・作業画面（APP_VERSION）でそろっている", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { name: string; version: string };
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as { name: string; version: string; packages: Record<string, { name?: string; version?: string }> };
    expect(pkg.name).toBe("mxstage");
    expect(APP_VERSION).toBe(pkg.version);
    expect([lock.name, lock.version]).toEqual([pkg.name, pkg.version]);
    expect([lock.packages[""]?.name, lock.packages[""]?.version]).toEqual([pkg.name, pkg.version]);
  });

  it("Claude の plugin（plugin/）は版が package.json とそろい、Anthropic のディレクトリの検査に通る形をしている", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    const manifest = JSON.parse(readFileSync(join(ROOT, "plugin", ".claude-plugin", "plugin.json"), "utf8")) as Record<string, unknown>;
    // ディレクトリはコミットごとに取り込むので、リリースのたびに版を上げる
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.name).toBe("mxstage"); // 一度出したら変えない
    expect(manifest.license).toBe("BUSL-1.1");
    // README は 40 語以上（コードブロックの中は数えない）
    const readme = readFileSync(join(ROOT, "plugin", "README.md"), "utf8").replace(/```[\s\S]*?```/g, "");
    expect(readme.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
    // Skill（Markdown）と JSON だけ。実行するもの・バイナリ・.mcpb は入れない（入れると審査で止まる）
    const files = repoFiles().filter((f) => f.startsWith("plugin/"));
    expect(files.length).toBeGreaterThan(0);
    // アイコンはディレクトリの一覧に出る（最初に申請したときの 1 回だけ取り込まれる）。.mcpb と同じ public/icon-512.png
    for (const f of files) expect(f === "plugin/.claude-plugin/icon.png" || /\.(md|json)$/.test(f), f).toBe(true);
    expect(readFileSync(join(ROOT, "plugin", ".claude-plugin", "icon.png")).equals(readFileSync(join(ROOT, "public", "icon-512.png")))).toBe(true);
    for (const f of files.filter((f) => f.endsWith("/SKILL.md"))) {
      const text = readFileSync(join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
      const name = /^---\nname: ([a-z0-9-]+)\n/.exec(text)?.[1];
      expect(f).toBe(`plugin/skills/${name}/SKILL.md`);
      expect(text).toMatch(/^description: ".+"$/m);
    }
    const marketplace = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf8")) as { plugins: { name: string; source: string }[] };
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: "mxstage", source: "./plugin" })]);
  });

  it("LICENSE は BSL 1.1 の原文のまま（Terms と Covenants は SPDX の BUSL-1.1 と同じ）で、変更先は Apache 2.0", () => {
    const license = readFileSync(join(ROOT, "LICENSE"), "utf8").replace(/\r\n/g, "\n");
    // Parameters だけが MX Stage のもの。Terms から後ろは一字も変えない（BSL の Covenants の 4）
    const terms = license.slice(license.indexOf("\nTerms\n") + 1);
    expect(createHash("sha256").update(terms, "utf8").digest("hex")).toBe("418989f0e58e9be45720f11d0bba6bf7ff7b61da68753918b784754dc22b011b");
    expect(license.startsWith("Business Source License 1.1\n\nParameters\n")).toBe(true);
    expect(license).toMatch(/^Change License: {7}Apache License, Version 2\.0$/m);
    expect(license).toMatch(/^Licensor: {13}TSUNAGI$/m);
    expect(license).not.toMatch(/\[[A-Z ]+\]/); // 仮の欄が残っていない
    expect(license).toMatch(/^Licensed Work: {8}MX Stage 0\.2\.0 or later\.$/m);
    // 有償なのは本番の Maximo への書き込みだけ。本番の切り替えに向けて準備中の移行先も本番に含める
    const grant = license.replace(/\s+/g, " ");
    expect(grant).toContain("provided that you do not use it to create, change or delete data held in a Production Maximo Environment. Reading data from a Production Maximo Environment is permitted.");
    expect(grant).toContain("or that is being prepared to replace such an instance (for example, the target of a migration or upgrade before go-live)");
    expect(grant).toContain("migration rehearsals, is not a Production Maximo Environment, even if it holds a copy of production data.");
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { license: string };
    expect(pkg.license).toBe("BUSL-1.1");
  });

  it("リポジトリの開発用のキーは試験用の鍵（s1）で署名したもので、偽の Maximo（https://127.0.0.1:9797）にしか使えない", () => {
    const keys = readDevLicenses(ROOT);
    expect(keys.length).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), "mxs-devkey-"));
    try {
      // 製品の公開鍵で確かめる。試験の設定のときだけ有効で、ふだんの製品では使えない（本番用の鍵のキーを入れてはいけない）
      const dev = new LicenseStore({ dir, allowTestKeys: true, bundled: keys });
      for (const entry of dev.list()) {
        expect(entry).toMatchObject({ state: "valid", test: true, bundled: true, hosts: ["https://127.0.0.1:9797"] });
      }
      expect(new LicenseStore({ dir, bundled: keys }).list().every((e) => e.state === "invalid" && e.problem === "test_key")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("改名前の名前（mxstudio）は、移行の処理とその試験にだけ残っている", () => {
    const files = repoFiles();
    expect(files.length).toBeGreaterThan(50);
    // 画像などのバイナリも、バイト列のまま探す（大文字小文字は問わない）
    const offenders = files.filter((f) => !LEGACY_NAME_ALLOWED.has(f) && /mxstudio/i.test(readFileSync(join(ROOT, f)).toString("latin1")));
    expect(offenders).toEqual([]);
    // 許した場所が消えたり改名されたりしたら、一覧も直す
    const missing = [...LEGACY_NAME_ALLOWED].filter((f) => !files.includes(f));
    expect(missing).toEqual([]);
  });
});
