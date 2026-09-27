// 橋渡しの入口。1 つのプロセスで次の 4 つを兼ねる。
//   1. 画面（dist/app）を http://127.0.0.1:<ポート> で配る
//   2. Claude と stdio の MCP サーバとして話す
//   3. ブラウザのタブと同一オリジンの WebSocket でつながり、ツール呼び出しを中継する
//   4. Maximo を直接呼ぶ（ブラウザの CORS 制約を回避する）
//
// 橋渡しは PC に 1 つにする（Claude Code・Claude Desktop・自動起動がそれぞれ起動しても Hub を分けない）。
//   - ポートを取れたら primary として 1〜4 を受け持つ。
//   - ポートを既に mxstudio の橋渡しが使っていたら client になり、2 のツール呼び出しをその橋渡しへ渡す。
//   - ポートを別のアプリが使っていたら、ずらさずに終了コード 1 で終わる。
//   役割決めと引き継ぎは src/bridge/coordinator.ts。
//
// stdio は MCP のものなので、標準出力には MCP のメッセージ以外を書かない。ログは stderr と
// <状態フォルダ>/bridge.log（既定 ~/.config/mxstudio）に書く。Claude が終了しても後から原因を追えるようにするため。
// API キー・作業データは console にもファイルにも書かない。

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { BridgeKeyStore, defaultBridgeKeyPath } from "./bridgeKey.ts";
import { BridgeCoordinator, CLIENT_WATCH_INTERVAL_MS } from "./coordinator.ts";
import { createBridgeLogger } from "./logFile.ts";
import { buildBridgeMcpServer } from "./mcp.ts";
import { userSkillsDirOf } from "./skills.ts";
import { HELP_TEXT, parseArgs } from "./options.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** src/bridge から見たリポジトリの根 */
const ROOT = resolve(HERE, "..", "..");

export function bridgeVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 既定のブラウザで開く（標準入出力は渡さない） */
export function openInBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : process.platform === "darwin"
        ? { file: "open", args: [url] }
        : { file: "xdg-open", args: [url] };
  try {
    // windowsHide: cmd /c start のために黒いコンソール窓を一瞬出さない
    const child = spawn(command.file, command.args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // 開けなくても橋渡しは動く
  }
}

/** 起動の入口では鍵ファイルの場所がまだ決まっていないので、stderr だけに書く */
function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === "help") {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`${bridgeVersion()}\n`);
    return 0;
  }
  if (parsed.kind === "error") {
    log(parsed.message);
    log("--help で使い方を表示します。");
    return 2;
  }

  const opts = parsed.options;
  // ここから先は、後から原因を追えるようにファイルにも残す（API キー・作業データは書かない）
  const keyPath = defaultBridgeKeyPath();
  const record = createBridgeLogger({ stateDir: dirname(keyPath) });
  const onFatal = (kind: string) => (e: unknown) => {
    record(`${kind}: ${e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)}`);
    process.exit(1);
  };
  process.on("uncaughtException", onFatal("予期しない例外で終了しました"));
  process.on("unhandledRejection", onFatal("処理されなかった拒否で終了しました"));
  const root = opts.appDir ? resolve(opts.appDir) : join(ROOT, "dist", "app");
  // 画面が未ビルドだと、open_grid で案内した URL が 404 の JSON になり原因が分からない。起動時に 1 行知らせる
  if (!existsSync(join(root, "index.html"))) {
    record(`警告: 作業画面が見つかりません（${root}）。先に npm run build を実行してください。`);
  }
  const version = bridgeVersion();
  // 利用者の Skill は橋渡しの状態フォルダ（~/.config/mxstudio）の下。リポジトリの外なので更新でも消えない
  const userSkillsDir = userSkillsDirOf(dirname(keyPath));
  const coordinator = new BridgeCoordinator({
    port: opts.port,
    root,
    allowedHosts: opts.allowHosts,
    insecure: opts.insecure,
    // 鍵ファイルの場所は環境変数 MXSTUDIO_BRIDGE_KEY_FILE で差し替えられる（値はログに出さない）
    keyStore: new BridgeKeyStore(keyPath),
    version,
    userSkillsDir,
    // MCP を話さないプロセスは client として残らないので、見張りは MCP を話すときだけ
    watchIntervalMs: opts.mcp ? CLIENT_WATCH_INTERVAL_MS : 0,
    log: record,
  });

  const started = await coordinator.start();
  switch (started.kind) {
    case "error":
      record(started.message);
      return 1;
    case "conflict":
      // 黙ってポートをずらさない（ずれると作業タブの URL と Hub が分かれる）
      record(started.message);
      return 1;
    case "primary":
      // 実際に使ったポートを 1 行だけ出す（stdout は MCP のもの）
      record(`mxstudio bridge ${version} listening on ${started.bridge.origin} (app: ${started.bridge.origin}/app)`);
      break;
    case "client":
      if (!opts.mcp) {
        // 画面の配信だけを頼まれたが、既に同じポートで橋渡しが配っている。やることは無い
        record(`mxstudio bridge ${version}: ポート ${coordinator.port} では既に mxstudio の橋渡し（${started.health.version.slice(0, 40)}）が動いています。そちらを使います。`);
        await coordinator.close();
        return 0;
      }
      record(`mxstudio bridge ${version} relaying to ${coordinator.origin} (primary ${started.health.version.slice(0, 40)}; app: ${coordinator.origin}/app)`);
      record("既に動いている mxstudio の橋渡しにツール呼び出しを渡します（この PC の Hub は 1 つです）。");
      break;
  }
  if (opts.insecure) record("警告: --insecure が指定されています。Maximo の証明書を検証しません（このプロセスが primary のときだけ有効です）。");

  const stdio = opts.mcp
    ? serveStdio(() => buildBridgeMcpServer({ origin: coordinator.origin, hub: coordinator.hub, tickets: coordinator.tickets, version, userSkillsDir }), {
        onerror: () => record("MCP の接続でエラーが発生しました。"),
      })
    : null;

  if (opts.open) openInBrowser(`${coordinator.origin}/app`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    record("mxstudio bridge stopping");
    void stdio?.close().catch(() => undefined);
    void coordinator.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // MCP クライアントが stdin を閉じたら終わる
  if (opts.mcp) process.stdin.on("close", stop);

  return 0;
}

/**
 * このファイルが直接起動されたか（試験から import しても起動しない）。
 * Node は起動したファイルの実体パス（ジャンクション・シンボリックリンクを辿った先）で import.meta.url を作るが、
 * process.argv[1] は渡されたパスのまま。文字列で比べると、リンク経由で登録された MCP 設定では
 * 何もせず終了コード 0 で抜け、MCP クライアントには理由の分からない切断に見える。実体パス同士で比べる。
 */
export function isDirectInvocation(argv1: string | undefined, selfUrl: string): boolean {
  if (!argv1) return false;
  const self = fileURLToPath(selfUrl);
  try {
    // native は Windows で大文字小文字も実際の綴りにそろえる
    return realpathSync.native(argv1) === realpathSync.native(self);
  } catch {
    return resolve(argv1) === resolve(self);
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  const code = await main(process.argv.slice(2));
  if (code !== 0) process.exit(code);
}
