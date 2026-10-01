// 保存する API キーの暗号化（橋渡しの中だけ）。
// - API キーは AES-256-GCM で暗号化して connections.json に置く。暗号化の鍵（マスター鍵・32 バイトの乱数）は OS に守らせる:
//     Windows: DPAPI（CurrentUser）で包んで connections.key に置く。同じ Windows の利用者でないと開けない（別の PC・別の利用者に写しても読めない）
//     macOS:   キーチェーン（サービス名 "MX Stage"）に置き、connections.key にはその印だけを書く
//     そのほか: connections.key（パーミッション 600）にそのまま置く（OS の保護は無い）
// - マスター鍵は最初に使うときに 1 回だけ開き、プロセスのメモリに置く。鍵・API キーをログにもエラー文にも出さない。
// - OS の道具（PowerShell・security）には鍵を標準入力で渡す（コマンドラインに載せない。ほかのプロセスから見えるため）。

import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SECRET_KEY_FILE = "connections.key";
/** キーチェーンの項目（macOS） */
export const KEYCHAIN_SERVICE = "MX Stage";
export const KEYCHAIN_ACCOUNT = "connections-master-key";

export type ProtectionKind = "dpapi" | "keychain" | "file";

/** 暗号文（すべて base64） */
export interface SealedSecret {
  iv: string;
  tag: string;
  data: string;
}

/** OS の道具を動かす口（試験で差し替える）。標準出力を返す。失敗したら例外 */
export type CommandRunner = (command: string, args: readonly string[], input: string) => Promise<string>;

export class SecretBoxError extends Error {
  readonly code: "unavailable" | "unreadable";
  constructor(code: "unavailable" | "unreadable", message: string) {
    super(message);
    this.name = "SecretBoxError";
    this.code = code;
  }
}

const COMMAND_TIMEOUT_MS = 30_000;

/** 既定の口。出力が大きすぎる・時間がかかりすぎるものは失敗にする */
export const runCommand: CommandRunner = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timeout"));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      out += d;
      if (out.length > 64 * 1024) child.kill();
    });
    // 標準エラーは読み捨てる（中身を外に出さない）
    child.stderr.resume();
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`exit ${code ?? "?"}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });

/** DPAPI に渡すおまけの値（同じ利用者のほかのアプリが DPAPI で包んだものと取り違えないため） */
const DPAPI_ENTROPY = "mxstage-connections";
const PS_PREFIX = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" + `$e=[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}');` + "$d=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());";
const PS_PROTECT = `${PS_PREFIX}[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($d,$e,'CurrentUser'))`;
const PS_UNPROTECT = `${PS_PREFIX}[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($d,$e,'CurrentUser'))`;
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

interface KeyFile {
  version: 1;
  kind: ProtectionKind;
  /** dpapi: 包んだマスター鍵（base64）。file: マスター鍵（base64）。keychain: 無し */
  value?: string;
}

export interface SecretBoxOptions {
  /** 状態フォルダ（~/.config/mxstage） */
  dir: string;
  /** 既定は process.platform */
  platform?: NodeJS.Platform;
  run?: CommandRunner;
}

export class SecretBox {
  private readonly file: string;
  private readonly platform: NodeJS.Platform;
  private readonly run: CommandRunner;
  private master: Buffer | null = null;
  private opening: Promise<Buffer> | null = null;

  constructor(opts: SecretBoxOptions) {
    this.file = join(opts.dir, SECRET_KEY_FILE);
    this.platform = opts.platform ?? process.platform;
    this.run = opts.run ?? runCommand;
  }

  /** この PC で使う守り方 */
  kind(): ProtectionKind {
    if (this.platform === "win32") return "dpapi";
    if (this.platform === "darwin") return "keychain";
    return "file";
  }

  async seal(plain: string, aad: string): Promise<SealedSecret> {
    const key = await this.masterKey(true);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  async open(sealed: SealedSecret, aad: string): Promise<string> {
    const key = await this.masterKey(false);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretBoxError("unreadable", "The saved API key cannot be decrypted on this PC.");
    }
  }

  /** マスター鍵。create が true なら、無ければ作る */
  private async masterKey(create: boolean): Promise<Buffer> {
    if (this.master) return this.master;
    if (!this.opening) {
      this.opening = this.load(create).finally(() => {
        this.opening = null;
      });
    }
    const key = await this.opening;
    this.master = key;
    return key;
  }

  private async load(create: boolean): Promise<Buffer> {
    const existing = this.readKeyFile();
    if (existing) return this.unwrap(existing);
    if (!create) throw new SecretBoxError("unreadable", "No key to decrypt saved API keys was found on this PC.");
    const key = randomBytes(32);
    const kind = this.kind();
    let record: KeyFile;
    try {
      if (kind === "dpapi") {
        const wrapped = (await this.run("powershell.exe", [...PS_ARGS, PS_PROTECT], key.toString("base64"))).trim();
        if (!/^[A-Za-z0-9+/=]+$/.test(wrapped)) throw new Error("bad output");
        record = { version: 1, kind, value: wrapped };
      } else if (kind === "keychain") {
        // security -i は標準入力のコマンドを読む（鍵をコマンドラインに載せない）。16 進なので引用符は要らない
        await this.run("/usr/bin/security", ["-i"], `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w ${key.toString("hex")}\n`);
        record = { version: 1, kind };
      } else {
        record = { version: 1, kind, value: key.toString("base64") };
      }
    } catch {
      throw new SecretBoxError("unavailable", "The OS could not protect the key for saved API keys.");
    }
    this.writeKeyFile(record);
    return key;
  }

  private async unwrap(record: KeyFile): Promise<Buffer> {
    try {
      let key: Buffer;
      if (record.kind === "dpapi") {
        if (this.platform !== "win32" || !record.value) throw new Error("not here");
        key = Buffer.from((await this.run("powershell.exe", [...PS_ARGS, PS_UNPROTECT], record.value)).trim(), "base64");
      } else if (record.kind === "keychain") {
        if (this.platform !== "darwin") throw new Error("not here");
        key = Buffer.from((await this.run("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"], "")).trim(), "hex");
      } else {
        key = Buffer.from(record.value ?? "", "base64");
      }
      if (key.length !== 32) throw new Error("bad key");
      return key;
    } catch {
      throw new SecretBoxError("unreadable", "The saved API keys cannot be decrypted on this PC (they were saved by another user or PC).");
    }
  }

  private readKeyFile(): KeyFile | null {
    if (!existsSync(this.file)) return null;
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8")) as Partial<KeyFile>;
      if (v.version === 1 && (v.kind === "dpapi" || v.kind === "keychain" || v.kind === "file")) return v as KeyFile;
    } catch {
      // 壊れていれば読めないものとして扱う（作り直すと、保存済みのキーが開けなくなるので上書きしない）
    }
    throw new SecretBoxError("unreadable", `${SECRET_KEY_FILE} is damaged.`);
  }

  private writeKeyFile(record: KeyFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Windows ではパーミッションを付けられない（DPAPI が守る）
    }
    renameSync(tmp, this.file);
  }
}
