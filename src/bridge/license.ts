// ライセンスキーの保存と確かめ、本番の Maximo の環境の割り当て。
// 本番の Maximo への書き込み（作業画面の「Maximo に反映」）にだけライセンスが要る。本番かどうかは、
// 接続ごとに利用者が申告する（作業画面）。確かめるのはこの PC の中だけで、外へは通信しない。
//
// 置き場所は状態フォルダ（~/.config/mxstage）:
//   - license.key         貼り付けたキー（空白を除いたもの）
//   - license-envs.json   本番に使った環境（接続先）の一覧。ライセンスの ID ごと
// 不正なキーでは、保存してある正しいキーを上書きしない。

import { createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLicenseKey, payloadState } from "../shared/license.ts";
import type { LicenseKeyProblem, LicensePayload, LicenseState } from "../shared/license.ts";
import { LICENSE_PUBLIC_KEYS, REVOKED_LICENSES } from "../shared/licenseKeys.ts";
import type { LicensePublicKey } from "../shared/licenseKeys.ts";
import { normalizeScope } from "../shared/scope.ts";

export const LICENSE_FILE = "license.key";
export const LICENSE_ENVS_FILE = "license-envs.json";
/** "1" のとき、決済の試験用の鍵（s1）で署名したキーも受け付ける */
export const LICENSE_TEST_ENV = "MXSTAGE_LICENSE_TEST";

/** キーを受け付けなかった理由（作業画面と LLM に出す文は呼び出し側が決める） */
export type LicenseProblem = LicenseKeyProblem | "signature" | "unknown_key" | "test_key" | "expired" | "revoked";

/** 作業画面に返す状態。キーとメールは入れない */
export interface LicenseStatus {
  state: LicenseState;
  /** state が invalid のときの理由 */
  problem?: LicenseProblem;
  licenseId?: string;
  org?: string;
  envsLicensed?: number;
  envsInUse?: number;
  /** 本番に使った接続先（normalizeScope したもの） */
  boundScopes?: string[];
  issuedAt?: string;
  expiresAt?: string;
  /** 決済の試験用の鍵で署名したキー */
  test?: boolean;
}

export type SaveResult = { ok: true; status: LicenseStatus } | { ok: false; problem: LicenseProblem; status: LicenseStatus };

export type AuthorizeProblem = "no_license" | "invalid" | "expired" | "revoked" | "envs_exceeded" | "bad_scope";
export type AuthorizeResult =
  | { ok: true; status: LicenseStatus; scope: string; newlyBound: boolean }
  | { ok: false; problem: AuthorizeProblem; status: LicenseStatus };

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
}

interface BoundEnv {
  scope: string;
  boundAt: string;
}

interface EnvsFile {
  version: 1;
  licenseId: string;
  scopes: BoundEnv[];
}

type Checked =
  | { ok: true; key: string; payload: LicensePayload; state: "valid" | "expired" | "revoked"; test: boolean }
  | { ok: false; problem: LicenseProblem };

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
  private readonly dir: string;
  private readonly allowTestKeys: boolean;
  private readonly keys: Readonly<Record<string, LicensePublicKey>>;
  private readonly revoked: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly keyObjects = new Map<string, KeyObject>();

  constructor(opts: LicenseStoreOptions) {
    this.dir = opts.dir;
    this.allowTestKeys = opts.allowTestKeys === true;
    this.keys = opts.keys ?? LICENSE_PUBLIC_KEYS;
    this.revoked = opts.revoked ?? REVOKED_LICENSES;
    this.now = opts.now ?? Date.now;
  }

  private get keyFile(): string {
    return join(this.dir, LICENSE_FILE);
  }

  private get envsFile(): string {
    return join(this.dir, LICENSE_ENVS_FILE);
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

  private checkSaved(): Checked | null {
    const text = readText(this.keyFile);
    if (text === null || text.trim() === "") return null;
    return this.check(text);
  }

  /** そのライセンスで本番に使った環境。別のライセンスの一覧・壊れた一覧は無いものとして扱う */
  private readEnvs(licenseId: string): BoundEnv[] {
    const text = readText(this.envsFile);
    if (text === null) return [];
    try {
      const parsed = JSON.parse(text) as Partial<EnvsFile>;
      if (parsed.version !== 1 || parsed.licenseId !== licenseId || !Array.isArray(parsed.scopes)) return [];
      return parsed.scopes.filter((s) => typeof s?.scope === "string" && s.scope !== "" && typeof s.boundAt === "string");
    } catch {
      return [];
    }
  }

  private statusOf(checked: Checked | null): LicenseStatus {
    if (checked === null) return { state: "none" };
    if (!checked.ok) return { state: "invalid", problem: checked.problem };
    const { payload } = checked;
    const scopes = this.readEnvs(payload.lic).map((s) => s.scope);
    return {
      state: checked.state,
      licenseId: payload.lic,
      org: payload.org,
      envsLicensed: payload.envs,
      envsInUse: scopes.length,
      boundScopes: scopes,
      issuedAt: new Date(payload.iat * 1000).toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      ...(checked.test ? { test: true } : {}),
    };
  }

  /** 保存してあるキーの状態 */
  status(): LicenseStatus {
    return this.statusOf(this.checkSaved());
  }

  /**
   * キーを保存する。署名が正しく、期限内で取り消されていないキーだけを保存する
   * （正しくないキーで、保存してある正しいキーを上書きしない）。
   * 本番に使った環境の一覧はライセンスの ID ごとに数えるので、更新したキー（同じ ID）では引き継ぎ、別のライセンスでは数え直す。
   */
  save(text: string): SaveResult {
    const checked = this.check(text);
    if (!checked.ok) return { ok: false, problem: checked.problem, status: this.status() };
    if (checked.state !== "valid") return { ok: false, problem: checked.state, status: this.status() };
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.keyFile, `${checked.key}\n`);
    return { ok: true, status: this.statusOf(checked) };
  }

  /**
   * 本番の環境（接続先）をライセンスに結びつける。作業画面が本番に反映する直前に呼ぶ。
   * 既に結びついている接続先は数を増やさない。ライセンスの環境の数を超えるときは断る。
   */
  authorize(baseUrl: string): AuthorizeResult {
    const scope = normalizeScope(baseUrl);
    const checked = this.checkSaved();
    const current = this.statusOf(checked);
    let protocol = "";
    try {
      protocol = new URL(scope).protocol;
    } catch {
      protocol = "";
    }
    if (protocol !== "https:" && protocol !== "http:") return { ok: false, problem: "bad_scope", status: current };
    if (checked === null) return { ok: false, problem: "no_license", status: current };
    if (!checked.ok) return { ok: false, problem: "invalid", status: current };
    if (checked.state !== "valid") return { ok: false, problem: checked.state, status: current };
    const bound = this.readEnvs(checked.payload.lic);
    if (bound.some((s) => s.scope === scope)) return { ok: true, status: current, scope, newlyBound: false };
    if (bound.length >= checked.payload.envs) return { ok: false, problem: "envs_exceeded", status: current };
    const file: EnvsFile = { version: 1, licenseId: checked.payload.lic, scopes: [...bound, { scope, boundAt: new Date(this.now()).toISOString() }] };
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.envsFile, `${JSON.stringify(file, null, 2)}\n`);
    return { ok: true, status: this.statusOf(checked), scope, newlyBound: true };
  }
}
