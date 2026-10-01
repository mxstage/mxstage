// 公開の前の検査をまとめて流す（npm run release:check）。どれかが失敗したら、そこで止まって終了コード 1。
//   1. 型検査・試験・導入の試験
//   2. 画面のビルドと .mcpb の作成（scripts/build-mcpb.ts）
//   3. .mcpb の橋渡しを空いたポートで起動し、MCP の initialize と tools/list が通ること、
//      実装していないツールが無いこと、最初の呼び出しに基本手順が付くことを確かめる
//   4. 客先の情報が送るものに入っていないこと（scripts/check-publish.mjs --worktree）
// 本物の状態フォルダ（~/.config/mxstage）とふだんのポート 8788 には触れない。

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SMOKE_PORT = 8796;

function step(title: string, command: string): void {
  process.stdout.write(`\n== ${title}\n$ ${command}\n`);
  const r = spawnSync(command, { cwd: ROOT, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    process.stderr.write(`\n失敗: ${title}\n`);
    process.exit(1);
  }
}

async function smokeTestBundle(): Promise<void> {
  process.stdout.write(`\n== .mcpb の橋渡しを起動して確かめる（ポート ${SMOKE_PORT}）\n`);
  const stateDir = mkdtempSync(join(tmpdir(), "mxs-release-"));
  const stage = join(ROOT, "dist", "mcpb", "stage");
  const child = spawn(process.execPath, [join(stage, "server", "mxstage-bridge.mjs"), "--port", String(SMOKE_PORT), "--app-dir", join(stage, "app")], {
    cwd: stage,
    env: { ...process.env, MXSTAGE_BRIDGE_KEY_FILE: join(stateDir, "bridge.key") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: { id?: number; result?: Record<string, unknown> }[] = [];
  let buffer = "";
  child.stdout.on("data", (d: Buffer) => {
    buffer += d.toString("utf8");
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) messages.push(JSON.parse(line) as (typeof messages)[number]);
    }
  });
  const send = (o: unknown) => child.stdin.write(`${JSON.stringify(o)}\n`);
  const waitFor = async (id: number) => {
    for (let t = 0; t < 100; t++) {
      const m = messages.find((x) => x.id === id);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`MCP の応答（id ${id}）が 10 秒以内に返りませんでした`);
  };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "release-check", version: "0" } } });
    const init = await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await waitFor(2);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "open_grid", arguments: {} } });
    const call = await waitFor(3);

    const serverInfo = init.result?.serverInfo as { name?: string; version?: string } | undefined;
    const tools = ((list.result?.tools ?? []) as { name: string }[]).map((t) => t.name);
    const texts = ((call.result?.content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("\n");
    const problems = [
      serverInfo?.name === "mxstage" ? null : `serverInfo.name が mxstage ではない（${serverInfo?.name}）`,
      tools.length > 0 ? null : "tools/list が空",
      ...["import_rows", "export_sheet"].filter((n) => tools.includes(n)).map((n) => `実装していないツール ${n} が載っている`),
      /MX Stage basic procedure/.test(texts) ? null : "最初の呼び出しに基本手順が付いていない",
    ].filter((p): p is string => p !== null);
    if (problems.length > 0) throw new Error(problems.join(" / "));
    process.stdout.write(`ok: ${serverInfo?.name} ${serverInfo?.version}、ツール ${tools.length} 個、最初の呼び出しに基本手順が付く\n`);
  } finally {
    child.kill();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

step("型検査", "npm run typecheck");
step("試験", "npx vitest run");
step("導入の試験", "npm run test:setup");
step("画面のビルド", "npm run build");
step(".mcpb の作成", "npm run build:mcpb");
try {
  await smokeTestBundle();
} catch (e) {
  process.stderr.write(`\n失敗: .mcpb の橋渡し: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
step("客先の情報の検査", "node scripts/check-publish.mjs --worktree");
process.stdout.write("\nすべて通りました。\n");
