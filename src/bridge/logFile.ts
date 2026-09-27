// 橋渡しの記録をファイルにも残す。
//
// なぜ要るか: 橋渡しのログは stderr にしか出ておらず、Claude Desktop / Claude Code が終了すると残らない。
// 「Claude が落ちた」「新しいセッションでエラーになった」といった後追いの調査ができないため、
// 同じ内容を <状態フォルダ>/bridge.log にも書く。
//
// 書いてよいのは、起動・役割・接続の状態とエラーの文言だけ。**API キー・作業データ・行の値は書かない。**

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/** これを超えたら 1 つ前（bridge.log.1）に送る */
export const LOG_MAX_BYTES = 512 * 1024;
export const LOG_FILE_NAME = "bridge.log";

export interface BridgeLoggerOptions {
  /** 鍵ファイルと同じ場所（既定 ~/.config/mxstudio） */
  stateDir: string;
  /** 画面（stderr）への出力。試験で差し替える */
  write?: (text: string) => void;
  now?: () => Date;
}

/**
 * stderr とファイルの両方に 1 行書く関数を返す。
 * ファイルに書けない（権限・容量）ときも橋渡しは動かし続ける（記録だけ諦める）。
 */
export function createBridgeLogger(opts: BridgeLoggerOptions): (line: string) => void {
  const write = opts.write ?? ((text: string) => void process.stderr.write(text));
  const now = opts.now ?? (() => new Date());
  const path = join(opts.stateDir, LOG_FILE_NAME);
  let fileBroken = false;
  return (line: string) => {
    write(`${line}\n`);
    if (fileBroken) return;
    try {
      mkdirSync(opts.stateDir, { recursive: true });
      try {
        if (statSync(path).size >= LOG_MAX_BYTES) renameSync(path, `${path}.1`);
      } catch {
        // まだ無い / 入れ替えられない場合はそのまま足す
      }
      appendFileSync(path, `${now().toISOString()} ${line}\n`, "utf8");
    } catch {
      // 一度でも書けなければ以後は試さない（毎行の失敗で遅くしない）
      fileBroken = true;
    }
  };
}
