// ライセンスキーの保存と確かめ、本番の Maximo への反映の許可。
// 有償なのは本番の Maximo への書き込み（作業画面の「Maximo に反映」）だけ。1 ライセンス = 1 本番環境で、
// キーの中に本番の接続先（別名を 3 つまで）が署名付きで書いてある。接続先がキーと合えば、何人・何台の PC でも使える。
// 確かめるのはこの PC の中だけで、外へは通信しない。
//
// 置き場所は状態フォルダ（~/.config/mxstage）の licenses/<ライセンスの ID>.key。本番環境が 2 つあれば 2 つのキーを置く。
// 情報システム部門がまとめて配るときも、このフォルダにキーのファイルを置けばよい。
// 正しくないキーでは、保存してある正しいキーを上書きしない。

import { createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { licenseHostOf, parseLicenseKey, payloadState } from "../shared/license.ts";
import type { AuthorizeProblem, LicenseEntry, LicensePayload, LicenseProblem } from "../shared/license.ts";
import { LICENSE_PUBLIC_KEYS, REVOKED_LICENSES } from "../shared/licenseKeys.ts";
import type { LicensePublicKey } from "../shared/licenseKeys.ts";

export type { AuthorizeProblem, LicenseEntry, LicenseProblem } from "../shared/license.ts";

/** キーを置くフォルダ（状態フォルダの下） */
export const LICENSES_DIR_NAME = "licenses";
/** "1" のとき、決済の試験用の鍵（s1）で署名したキーも受け付ける */
export const LICENSE_TEST_ENV = "MXSTAGE_LICENSE_TEST";
/** 置けるキーの数の上限 */
export const MAX_LICENSES = 50;

export type SaveResult = { ok: true; license: LicenseEntry } | { ok: false; problem: LicenseProblem };

export type AuthorizeResult =
  | { ok: true; host: string; license: LicenseEntry }
  | { ok: false; problem: AuthorizeProblem; host: string | null; licensedHosts: string[] };

export interface LicenseStoreOptions {
  /** 状態フォルダ（~/.config/mxstage） */
  dir: string;
  /** 決済の試験用の鍵も受け付けるか（MXSTAGE_LICENSE_TEST=1） */
  allowTestKeys?: boolean;
  /** 公開鍵（試験で差し替える） */
  keys?: Readonly<Record<string, LicensePublicKey>>;
  revoked?: ReadonlySet<string>;
  /** 今の時刻（ミリ秒。試験で差し替える） */
  now?: () => number;
  /** ファイルに置かずに使うキー（開発用。--dev-license のときリポジトリの dev/*.license.key を読む） */
  bundled?: readonly string[];
}

type Checked =
  | { ok: true; key: string; payload: LicensePayload; state: "valid" | "expired" | "revoked"; test: boolean }
  | { ok: false; problem: LicenseProblem };

const LICENSE_FILE_PATTERN = /^([A-Za-z0-9_-]{1,100})\.key$/;

/** 開発用のキーを置くフォルダ（リポジトリの根から）と、ファイル名の終わり */
export const DEV_LICENSE_DIR = "dev";
export const DEV_LICENSE_SUFFIX = ".license.key";

/** リポジトリの開発用のキー（dev/*.license.key）を読む。試験用の鍵のキーだけで、偽の Maximo にだけ使える */
export function readDevLicenses(repoRoot: string, log?: (line: string) => void): string[] {
  const folder = join(repoRoot, DEV_LICENSE_DIR);
  let names: string[] = [];
  try {
    names = readdirSync(folder).filter((n) => n.endsWith(DEV_LICENSE_SUFFIX)).sort();
  } catch {
    names = [];
  }
  const keys = names.map((n) => readText(join(folder, n))).filter((t): t is string => t !== null && t.trim() !== "");
  log?.(`開発用のライセンスキーを ${keys.length} 件読みました（${folder}）。試験用の鍵のキーも受け付けます。`);
  return keys;
}

/** 環境変数から、決済の試験用の鍵を受け付けるかを読む */
export function licenseTestKeysAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[LICENSE_TEST_ENV] ?? "").trim() === "1";
}

/** 一時ファイルに書いてから置き換える（途中で止まっても元のファイルを壊さない） */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 一時ファイルが残っても、元のファイルは書き換わっていない
    }
    throw err;
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export class LicenseStore {
  private readonly folder: string;
  private readonly allowTestKeys: boolean;
  private readonly keys: Readonly<Record<string, LicensePublicKey>>;
  private readonly revoked: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly keyObjects = new Map<string, KeyObject>();
  private readonly bundled: readonly string[];

  constructor(opts: LicenseStoreOptions) {
    this.bundled = opts.bundled ?? [];
    this.folder = join(opts.dir, LICENSES_DIR_NAME);
    this.allowTestKeys = opts.allowTestKeys === true;
    this.keys = opts.keys ?? LICENSE_PUBLIC_KEYS;
    this.revoked = opts.revoked ?? REVOKED_LICENSES;
    this.now = opts.now ?? Date.now;
  }

  private publicKey(kid: string): KeyObject | null {
    const cached = this.keyObjects.get(kid);
    if (cached) return cached;
    const entry = this.keys[kid];
    if (!entry) return null;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: entry.x }, format: "jwk" });
    this.keyObjects.set(kid, key);
    return key;
  }

  /** キーを読み、署名・鍵・期限・取り消しを確かめる */
  private check(text: string): Checked {
    const parsed = parseLicenseKey(text);
    if (!parsed.ok) return { ok: false, problem: parsed.problem };
    const { payload } = parsed;
    const entry = this.keys[payload.kid];
    if (!entry) return { ok: false, problem: "unknown_key" };
    if (entry.test && !this.allowTestKeys) return { ok: false, problem: "test_key" };
    let good = false;
    try {
      const key = this.publicKey(payload.kid);
      good = key !== null && verify(null, new TextEncoder().encode(parsed.signingInput), key, parsed.signature);
    } catch {
      good = false;
    }
    if (!good) return { ok: false, problem: "signature" };
    return { ok: true, key: parsed.key, payload, state: payloadState(payload, Math.floor(this.now() / 1000), this.revoked), test: entry.test };
  }

  private entryOf(licenseId: string, checked: Checked): LicenseEntry {
    if (!checked.ok) return { state: "invalid", problem: checked.problem, licenseId };
    const { payload } = checked;
    return {
      state: checked.state,
      licenseId: payload.lic,
      org: payload.org,
      hosts: [...payload.hosts],
      issuedAt: new Date(payload.iat * 1000).toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      ...(checked.test ? { test: true } : {}),
    };
  }

  /** ファイルに置いてあるキーと、開発用に読んだキー */
  private all(): { licenseId: string; checked: Checked; bundled: boolean }[] {
    const files = this.saved().map((s) => ({ ...s, bundled: false }));
    const bundled = this.bundled.map((text) => {
      const checked = this.check(text);
      return { licenseId: checked.ok ? checked.payload.lic : "bundled", checked, bundled: true };
    });
    return [...files, ...bundled];
  }

  /** 置いてあるキー（ファイル名のライセンスの ID と、確かめた結果） */
  private saved(): { licenseId: string; checked: Checked }[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.folder).sort();
    } catch {
      return [];
    }
    const out: { licenseId: string; checked: Checked }[] = [];
    for (const name of names) {
      const m = LICENSE_FILE_PATTERN.exec(name);
      if (!m) continue;
      const text = readText(join(this.folder, name));
      if (text === null) continue;
      const checked = this.check(text);
      // ファイル名と中身のライセンスの ID が違うものは、手で置き間違えたもの。中身の ID で扱う
      out.push({ licenseId: checked.ok ? checked.payload.lic : m[1]!, checked });
    }
    return out;
  }

  /** 置いてあるキーの状態（ライセンスの ID の順。開発用に読んだキーは最後） */
  list(): LicenseEntry[] {
    return this.all().map((s) => ({ ...this.entryOf(s.licenseId, s.checked), ...(s.bundled ? { bundled: true } : {}) }));
  }

  /**
   * キーを保存する。署名が正しく、期限内で取り消されていないキーだけを保存する。
   * 同じライセンス（更新したキー）は新しいほうで置き換え、古いキーでは置き換えない。
   */
  save(text: string): SaveResult {
    const checked = this.check(text);
    if (!checked.ok) return { ok: false, problem: checked.problem };
    if (checked.state !== "valid") return { ok: false, problem: checked.state };
    const saved = this.saved();
    const same = saved.find((s) => s.licenseId === checked.payload.lic);
    if (same && same.checked.ok && same.checked.payload.iat > checked.payload.iat) return { ok: false, problem: "older" };
    if (!same && saved.length >= MAX_LICENSES) return { ok: false, problem: "too_many" };
    mkdirSync(this.folder, { recursive: true });
    writeAtomic(join(this.folder, `${checked.payload.lic}.key`), `${checked.key}\n`);
    return { ok: true, license: this.entryOf(checked.payload.lic, checked) };
  }

  /** キーを外す（置いていなければ何もしない）。外したら true */
  remove(licenseId: string): boolean {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(licenseId)) return false;
    const file = join(this.folder, `${licenseId}.key`);
    if (readText(file) === null) return false;
    rmSync(file, { force: true });
    return true;
  }

  /**
   * 本番の接続先に反映してよいか。接続先のホストが、期限内のキーの本番の接続先に含まれていればよい。
   * 作業画面が本番に反映する直前に呼ぶ。
   */
  authorize(baseUrl: string): AuthorizeResult {
    const host = licenseHostOf(baseUrl);
    const saved = this.all().filter((s): s is { licenseId: string; checked: Extract<Checked, { ok: true }>; bundled: boolean } => s.checked.ok);
    const licensedHosts = [...new Set(saved.filter((s) => s.checked.state === "valid").flatMap((s) => s.checked.payload.hosts))];
    if (host === null) return { ok: false, problem: "bad_scope", host: null, licensedHosts };
    const matching = saved.filter((s) => s.checked.payload.hosts.includes(host));
    const valid = matching.find((s) => s.checked.state === "valid");
    if (valid) return { ok: true, host, license: this.entryOf(valid.licenseId, valid.checked) };
    if (matching.length > 0) return { ok: false, problem: matching.some((s) => s.checked.state === "revoked") ? "revoked" : "expired", host, licensedHosts };
    return { ok: false, problem: saved.length === 0 ? "no_license" : "not_licensed", host, licensedHosts };
  }
}
