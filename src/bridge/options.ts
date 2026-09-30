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
}

export type ParseResult =
  | { kind: "run"; options: BridgeOptions }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export const HELP_TEXT = `mxstage bridge — Maximo のデータ整備を、この PC の中だけで中継します。

使い方:
  node --experimental-strip-types src/bridge/cli.ts [オプション]

オプション:
  --port <番号>      待ち受けるポート（既定 ${DEFAULT_PORT}。ずらしません。
                     既に MX Stage の橋渡しが使っていればそちらに中継し、
                     別のアプリが使っていれば終了コード 1 で終わります）
  --open             既定のブラウザで作業画面を開く
  --no-open          ブラウザを開かない（既定）
  --allow-host <名>  つないでよい Maximo のホスト（カンマ区切り。複数回指定可。既定は無制限）
  --insecure         自己署名証明書の Maximo を受け入れる（この接続だけ検証を切ります）
  --app-dir <パス>   画面（dist/app）の場所
  --no-mcp           stdio の MCP サーバとして話さない（画面の配信だけ）
  --version          版を表示する
  --help             この説明を表示する

待ち受けるのは 127.0.0.1 だけです。API キーは呼び出しごとにヘッダで受け取り、
ディスクにもログにも書きません。

橋渡しは PC に 1 つです。後から起動した橋渡しは、先に動いている橋渡しに
ツール呼び出しを渡します。先の橋渡しが終了すると、残った橋渡しが引き継ぎます。
橋渡し同士は利用者ごとの鍵ファイルで確かめ合います
（~/.config/mxstage/bridge.key。Windows では %USERPROFILE%\\.config\\mxstage\\bridge.key。
環境変数 ${BRIDGE_KEY_FILE_ENV} で場所を変えられます）。`;

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** argv（process.argv.slice(2) の部分）を解釈する */
export function parseArgs(argv: readonly string[]): ParseResult {
  const options: BridgeOptions = { port: DEFAULT_PORT, open: false, allowHosts: [], insecure: false, mcp: true, appDir: null };

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
        if (!Number.isInteger(port) || port < 1 || port > 65_535) return { kind: "error", message: "--port には 1〜65535 の整数を指定してください。" };
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
        if (v === null) return { kind: "error", message: "--allow-host にはホスト名を指定してください。" };
        options.allowHosts.push(...splitList(v));
        break;
      }
      case "--insecure":
        options.insecure = true;
        break;
      case "--no-mcp":
        options.mcp = false;
        break;
      case "--app-dir": {
        const v = next();
        if (v === null) return { kind: "error", message: "--app-dir にはフォルダのパスを指定してください。" };
        options.appDir = v;
        break;
      }
      default:
        return { kind: "error", message: `知らないオプションです: ${name}` };
    }
  }
  return { kind: "run", options };
}
