// 橋渡し同士の認証に使う鍵（利用者ごとのファイル）。
// - 置き場所: どの OS でも ~/.config/mxstudio/bridge.key（Windows は %USERPROFILE%\.config\mxstudio\bridge.key。パーミッション 600）。
//   Windows で %LOCALAPPDATA% に置かないのは、Claude Desktop（MSIX パッケージ）が起動した橋渡しの書き込みが
//   パッケージ専用の場所（%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Local）に振り替えられ、
//   ログイン時の自動起動（パッケージの外）の橋渡しと別々の鍵を持ってしまうため。ホーム直下は振り替えられない。
//   環境変数 MXSTUDIO_BRIDGE_KEY_FILE で差し替えられる（試験で本物の置き場所に作らないため）。
// - primary（ポートを取れた橋渡し）が、無ければ 256 ビットの乱数で作る。client は読むだけ。
// - 照合は定数時間で行う。鍵の値は console にもエラー文にも出さない。

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** 鍵ファイルの場所を差し替える環境変数 */
export const BRIDGE_KEY_FILE_ENV = "MXSTUDIO_BRIDGE_KEY_FILE";

/** 内部経路（/_mxstudio/*）で鍵を載せるヘッダ（小文字） */
export const BRIDGE_KEY_HEADER = "x-mxstudio-bridge-key";

/** 鍵の長さ（バイト）。16 進で 64 文字になる */
export const BRIDGE_KEY_BYTES = 32;

const KEY_PATTERN = /^[0-9a-f]{64}$/;

export interface KeyPathInputs {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** 鍵ファイルの既定の場所 */
export function defaultBridgeKeyPath(inputs: KeyPathInputs = {}): string {
  const env = inputs.env ?? process.env;
  const override = env[BRIDGE_KEY_FILE_ENV];
  if (typeof override === "string" && override.trim() !== "") return resolve(override.trim());
  return join(inputs.home ?? homedir(), ".config", "mxstudio", "bridge.key");
}

/** ファイルの中身を鍵として読む。形が正しくなければ null */
function parseKey(text: string): string | null {
  const value = text.trim().toLowerCase();
  return KEY_PATTERN.test(value) ? value : null;
}

function readKeyFile(path: string): string | null {
  try {
    return parseKey(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** 他の利用者に読める権限が付いていたら 600 に絞る（Windows では意味が無いので何もしない） */
function tightenMode(path: string): void {
  if (process.platform === "win32") return;
  try {
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  } catch {
    // 絞れなくても鍵は使える
  }
}

/** 同じ値か（長さが違っても時間で見分けられないように、ハッシュをそろえてから比べる） */
export function keysEqual(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b) && presented.length === expected.length;
}

/**
 * 鍵ファイル 1 つを受け持つ。値はメモリに持ち、照合に失敗したときだけ読み直す
 * （別の橋渡しが作り直した場合に追随するため）。
 */
export class BridgeKeyStore {
  readonly path: string;
  private cached: string | null = null;
  private lastReloadAt = 0;

  constructor(path: string) {
    this.path = path;
  }

  /** 読み取るだけ（client 用）。無ければ null */
  load(): string | null {
    const value = readKeyFile(this.path);
    if (value !== null) this.cached = value;
    return value;
  }

  /** 持っている値（まだ読んでいなければ読む） */
  current(): string | null {
    return this.cached ?? this.load();
  }

  /**
   * 無ければ作る（primary 用）。既にあればその値を使う。
   * 同時に作ろうとしても、排他的に作れた 1 つだけが書き、他はそれを読む。
   * 作れなければ例外（呼び出し側は、中継なしで動き続ける）。
   */
  ensure(): string {
    const existing = readKeyFile(this.path);
    if (existing !== null) {
      tightenMode(this.path);
      this.cached = existing;
      return existing;
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fresh = randomBytes(BRIDGE_KEY_BYTES).toString("hex");
    try {
      writeFileSync(this.path, `${fresh}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // 他の橋渡しが先に作った。形が壊れているときだけ上書きする
      const raced = readKeyFile(this.path);
      if (raced !== null) {
        this.cached = raced;
        return raced;
      }
      writeFileSync(this.path, `${fresh}\n`, { encoding: "utf8", flag: "w", mode: 0o600 });
    }
    tightenMode(this.path);
    const written = readKeyFile(this.path);
    if (written === null) throw new Error("鍵ファイルを書けませんでした");
    this.cached = written;
    return written;
  }

  /** 提示された値が鍵と一致するか（定数時間）。一致しなければ 1 秒に 1 回まで読み直して比べ直す */
  verify(presented: string | undefined): boolean {
    if (typeof presented !== "string" || presented.length === 0 || presented.length > 256) return false;
    const value = presented.trim().toLowerCase();
    const current = this.cached;
    if (current !== null && keysEqual(value, current)) return true;
    const now = Date.now();
    if (now - this.lastReloadAt < 1_000) return false;
    this.lastReloadAt = now;
    const reloaded = readKeyFile(this.path);
    if (reloaded === null || reloaded === current) return false;
    this.cached = reloaded;
    return keysEqual(value, reloaded);
  }
}
