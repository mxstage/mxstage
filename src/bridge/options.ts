// CLI の引数解釈。値は数と文字列だけで、ファイルにも環境にも書き戻さない。

import { BRIDGE_KEY_FILE_ENV } from "./bridgeKey.ts";
import { DEFAULT_PORT } from "./server.ts";

export interface BridgeOptions {
  port: number;
  /** 既定のブラウザで作業画面を開くか（既定は開かない） */
  open: boolean;
  /** Maximo の宛先ホストの許可リスト（空なら無制限） */
  allowHosts: string[];
  /** 自己署名証明書の Maximo に届かせる */
  insecure: boolean;
  /** stdio で MCP サーバとして話すか（既定は話す） */
  mcp: boolean;
  /** 画面の配信元。既定は dist/app */
  appDir: string | null;
  /**
   * MX Stage の開発・試験用。決済の試験用の鍵で作ったキーを受け付け、リポジトリの開発用のキー
   * （dev/fake-maximo.license.key。偽の Maximo https://127.0.0.1:9797 だけに使える）を読む
   */
  devLicense: boolean;
}

export type ParseResult =
  | { kind: "run"; options: BridgeOptions }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export const HELP_TEXT = `mxstage bridge — relays IBM Maximo data work on this PC only.

Usage:
  node --experimental-strip-types src/bridge/cli.ts [options]

Options:
  --port <number>    Port to listen on (default ${DEFAULT_PORT}; never shifted.
                     If an MX Stage bridge already uses it, relays to that bridge;
                     if another application uses it, exits with code 1)
  --open             Open the work screen in the default browser
  --no-open          Do not open a browser (default)
  --allow-host <h>   Maximo hosts that may be reached (comma-separated; can be repeated; default: any)
  --insecure         Accept a Maximo with a self-signed certificate (turns off verification for that connection only)
  --app-dir <path>   Location of the work screen files (dist/app)
  --no-mcp           Do not act as a stdio MCP server (serve the work screen only)
  --dev-license      For developing and testing MX Stage: accept test license keys and read the development
                     key for the fake Maximo (https://127.0.0.1:9797) (npm run dev:bridge adds it)
  --version          Show the version
  --help             Show this help

Listens on 127.0.0.1 only. API keys arrive in a header with each request and are
never written to disk or logs.

There is one bridge per PC. A bridge started later passes tool calls to the bridge
already running; when that one exits, a remaining bridge takes over.
Bridges verify each other with a per-user key file
(~/.config/mxstage/bridge.key; on Windows %USERPROFILE%\\.config\\mxstage\\bridge.key;
the environment variable ${BRIDGE_KEY_FILE_ENV} changes the location).`;

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** argv（process.argv.slice(2) の部分）を解釈する */
export function parseArgs(argv: readonly string[]): ParseResult {
  const options: BridgeOptions = { port: DEFAULT_PORT, open: false, allowHosts: [], insecure: false, mcp: true, appDir: null, devLicense: false };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] as string;
    const eq = raw.indexOf("=");
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : null;
    const next = (): string | null => {
      if (inline !== null) return inline;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return null;
      i += 1;
      return v;
    };

    switch (name) {
      case "--help":
      case "-h":
        return { kind: "help" };
      case "--version":
      case "-v":
        return { kind: "version" };
      case "--port": {
        const v = next();
        const port = v === null ? NaN : Number(v);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) return { kind: "error", message: "--port needs an integer from 1 to 65535." };
        options.port = port;
        break;
      }
      case "--open":
        options.open = true;
        break;
      case "--no-open":
        options.open = false;
        break;
      case "--allow-host": {
        const v = next();
        if (v === null) return { kind: "error", message: "--allow-host needs a host name." };
        options.allowHosts.push(...splitList(v));
        break;
      }
      case "--insecure":
        options.insecure = true;
        break;
      case "--no-mcp":
        options.mcp = false;
        break;
      case "--dev-license":
        options.devLicense = true;
        break;
      case "--app-dir": {
        const v = next();
        if (v === null) return { kind: "error", message: "--app-dir needs a folder path." };
        options.appDir = v;
        break;
      }
      default:
        return { kind: "error", message: `Unknown option: ${name}` };
    }
  }
  return { kind: "run", options };
}
