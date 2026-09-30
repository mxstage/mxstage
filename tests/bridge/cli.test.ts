// CLI を実際に起動して、MCP（stdio）として話せることと、標準出力を汚さないことを確かめる。
// 子プロセスには一時フォルダの隔離環境を渡す（鍵ファイルを本物の置き場所に作らない）。ポートは 19000 番台。

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDirectInvocation } from "../../src/bridge/cli.ts";
import { HELP_TEXT, parseArgs } from "../../src/bridge/options.ts";
import { DEFAULT_PORT } from "../../src/bridge/server.ts";
import { CliProcess, REPO_ROOT, createSandbox, findFreePort, stopAllCli } from "./support.ts";
import type { Sandbox } from "./support.ts";

describe("直接起動の判定", () => {
  const cliPath = join(REPO_ROOT, "src", "bridge", "cli.ts");
  const cliUrl = pathToFileURL(cliPath).href;

  it("起動したファイルが自分なら true、それ以外は false", () => {
    expect(isDirectInvocation(cliPath, cliUrl)).toBe(true);
    expect(isDirectInvocation(join(REPO_ROOT, "src", "bridge", "server.ts"), cliUrl)).toBe(false);
    expect(isDirectInvocation(undefined, cliUrl)).toBe(false);
  });

  it("ジャンクション（シンボリックリンク）経由で登録されていても起動する", async () => {
    // MCP の設定にリンク経由のパスが書かれていると、Node は import.meta.url を実体パスで作る。
    // リンク先は一時フォルダの中に作る（リポジトリへのリンクを作らない。後始末で辿って消す事故を避ける）
    const base = await mkdtemp(join(tmpdir(), "mxs-bridge-link-"));
    const real = join(base, "real");
    const link = join(base, "link");
    try {
      await mkdir(real);
      await writeFile(join(real, "cli.ts"), "", "utf8");
      await symlink(real, link, "junction");
      expect(isDirectInvocation(join(link, "cli.ts"), pathToFileURL(join(real, "cli.ts")).href)).toBe(true);
      expect(isDirectInvocation(join(link, "other.ts"), pathToFileURL(join(real, "cli.ts")).href)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("引数の解釈", () => {
  it("既定値", () => {
    const res = parseArgs([]);
    expect(res).toMatchObject({ kind: "run", options: { port: DEFAULT_PORT, open: false, insecure: false, mcp: true, allowHosts: [], devLicense: false } });
  });

  it("--dev-license（開発・試験用のキーを読む）", () => {
    expect(parseArgs(["--dev-license"])).toMatchObject({ kind: "run", options: { devLicense: true } });
  });

  it("--port と --open", () => {
    expect(parseArgs(["--port", "9000", "--open"])).toMatchObject({ kind: "run", options: { port: 9000, open: true } });
    expect(parseArgs(["--port=9000"])).toMatchObject({ kind: "run", options: { port: 9000 } });
    expect(parseArgs(["--open", "--no-open"])).toMatchObject({ kind: "run", options: { open: false } });
  });

  it("--allow-host はカンマ区切りと複数回指定を受ける", () => {
    expect(parseArgs(["--allow-host", "a.example,B.example", "--allow-host", "c.example"])).toMatchObject({
      kind: "run",
      options: { allowHosts: ["a.example", "b.example", "c.example"] },
    });
  });

  it("--help と --version", () => {
    expect(parseArgs(["--help"]).kind).toBe("help");
    expect(parseArgs(["--version"]).kind).toBe("version");
    expect(HELP_TEXT).toContain("--insecure");
    // ポートはずらさない（ずらすと作業タブの URL と Hub が分かれる）
    expect(HELP_TEXT).not.toContain("+1");
  });

  it("おかしな指定は説明付きで断る", () => {
    expect(parseArgs(["--port", "0"])).toMatchObject({ kind: "error" });
    expect(parseArgs(["--port", "あ"])).toMatchObject({ kind: "error" });
    expect(parseArgs(["--allow-host"])).toMatchObject({ kind: "error" });
    expect(parseArgs(["--nope"])).toMatchObject({ kind: "error" });
  });
});

let sandbox: Sandbox | null = null;

beforeEach(async () => {
  // 鍵ファイルと設定の置き場所を一時フォルダに向ける（本物の %LOCALAPPDATA% に作らない）
  sandbox = await createSandbox();
});

afterEach(async () => {
  await stopAllCli();
  await sandbox?.cleanup();
  sandbox = null;
});

describe("stdio の MCP サーバ", () => {
  it("initialize・tools/list・tools/call が通り、標準出力は JSON-RPC だけ", async () => {
    const box = sandbox as Sandbox;
    const port = await findFreePort();
    const cli = new CliProcess(["--port", String(port), "--no-open"], box);
    await cli.waitForStderr("listening on");

    const init = await cli.initialize(1);
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("mxstage");
    // Skill の入らないクライアント（Claude Desktop のチャット）にも、データを作業画面のシートに読み込む決まりが届く
    const instructions = (init.result as { instructions?: string }).instructions ?? "";
    expect(instructions).toContain("Always load Maximo data into work screen sheets");
    expect(instructions).toContain("get_skill");

    const list = await cli.call(2, "tools/list");
    const names = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    // 中継のツールもローカルで完結するツールも、同じ一覧に出る
    expect(names).toContain("get_status");
    expect(names).toContain("open_grid");
    expect(names).toContain("list_skills");
    expect(names).toContain("create_import_session");

    type ToolCallResult = { content: Array<{ type: string; text: string }>; structuredContent: Record<string, unknown>; isError?: boolean };
    const open = await cli.call(3, "tools/call", { name: "open_grid", arguments: {} });
    const grid = (open.result as { structuredContent: { appUrl: string; tabConnected: boolean } }).structuredContent;
    // open_grid はローカルの URL を返す（指定したポートのまま。ずらさない）
    expect(grid.appUrl).toBe(`http://127.0.0.1:${port}/app`);
    expect(grid.tabConnected).toBe(false);
    // 会話で最初のツール呼び出しには、基本手順の Skill を添える（Skill 機能の無いクライアントにも、どのツールから始めても届く）
    // 更新の知らせ（[MX Stage updates]）は、試験を動かしているリポジトリの状態（ビルドが古いなど）で付いたり付かなかったりするので外して比べる
    const withoutUpdates = (content: ToolCallResult["content"]) => content.filter((c) => !c.text.startsWith("[MX Stage updates]"));
    const firstContent = withoutUpdates((open.result as ToolCallResult).content);
    expect(firstContent).toHaveLength(2);
    expect(firstContent[1]!.text).toContain("MX Stage basic procedure and rules");
    expect(firstContent[1]!.text).toContain("# MX Stage basic procedure");
    expect(firstContent[1]!.text).toContain("save_skill");

    // タブが無いときの get_status は「つながっていない」と答える（エラーにしない）。2 回目からは添えない
    const status = await cli.call(4, "tools/call", { name: "get_status", arguments: {} });
    expect((status.result as { structuredContent: { tabConnected: boolean } }).structuredContent.tabConnected).toBe(false);
    expect(withoutUpdates((status.result as ToolCallResult).content)).toHaveLength(1);

    const skills = await cli.call(5, "tools/call", { name: "list_skills", arguments: {} });
    expect((skills.result as { structuredContent: { skills: unknown[] } }).structuredContent.skills.length).toBeGreaterThan(0);

    // チャットから利用者の Skill を保存すると、隔離環境の状態フォルダの skills/ に入り、すぐ get_skill で読める
    const saveArgs = { name: "permit-date-update", description: "mxstage で許可申請の完了日を一括で変えるときに使う。", body: "# 手順\n\nget_status から始め、get_diff で確かめてから request_commit する。" };
    const saved = (await cli.call(6, "tools/call", { name: "save_skill", arguments: saveArgs })).result as ToolCallResult;
    expect(saved.isError ?? false).toBe(false);
    expect(saved.structuredContent).toMatchObject({ saved: "permit-date-update", created: true, version: "0.1.0" });
    expect(existsSync(join(dirname(box.keyFile), "skills", "permit-date-update", "SKILL.md"))).toBe(true);
    const got = (await cli.call(7, "tools/call", { name: "get_skill", arguments: { name: "permit-date-update" } })).result as ToolCallResult;
    expect(got.structuredContent).toMatchObject({ name: "permit-date-update", origin: "user" });
    // 同じ名前を黙って上書きしない
    const again = (await cli.call(8, "tools/call", { name: "save_skill", arguments: saveArgs })).result as ToolCallResult;
    expect(again.isError).toBe(true);

    // 起動の知らせもポート番号も stderr に出す（stdout は MCP のもの）
    expect(cli.badLines).toEqual([]);
    expect(cli.stdout).not.toContain("listening");
    expect(cli.stderr).toContain(`listening on http://127.0.0.1:${port}`);
    // primary になった橋渡しが、隔離環境の中に鍵ファイルを作る。鍵の値はどこにも出さない
    expect(existsSync(box.keyFile)).toBe(true);
    const key = box.keyStore().current() as string;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(cli.stderr).not.toContain(key);
    expect(cli.stdout).not.toContain(key);
  }, 30_000);

  it("--help は説明を出して終わる", async () => {
    const cli = new CliProcess(["--help"], sandbox as Sandbox);
    const code = await cli.exited;
    expect(code).toBe(0);
    expect(cli.stdout).toContain("--port");
  }, 20_000);

  it("--version は版だけを出す", async () => {
    const cli = new CliProcess(["--version"], sandbox as Sandbox);
    const code = await cli.exited;
    expect(code).toBe(0);
    expect(cli.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 20_000);
});
