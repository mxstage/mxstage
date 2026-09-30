// 作業画面のライセンス。橋渡しの入口（/_mxstage/license）でキーを読み書きし、接続先ごとの環境（本番／テスト）を決める。
// - 有償なのは本番の Maximo への「Maximo に反映」だけ。本番でも読み込み・Skill づくり・編集はライセンス無しでできる。
// - 接続先がキーの本番の接続先に含まれていれば、その接続先は本番（利用者が変えられない）。
// - キーに無い接続先は、利用者が接続のときに本番かテストかを申告する（localStorage の mxstage.maximo.environments）。
// - 反映の直前には、橋渡しでもう一度確かめる（authorize）。確かめられなければ本番には書かない。

import { licenseHostOf } from "../../shared/license";
import type { AuthorizeProblem, LicenseEntry, LicenseProblem } from "../../shared/license";
import { normalizeScope } from "../../shared/scope";

export type Environment = "production" | "test";

/** 接続先ごとの申告を覚えておく localStorage のキー */
export const ENVIRONMENTS_STORAGE_KEY = "mxstage.maximo.environments";
export const LICENSE_ENDPOINT = "/_mxstage/license";
export const LICENSE_REMOVE_ENDPOINT = "/_mxstage/license/remove";
export const LICENSE_AUTHORIZE_ENDPOINT = "/_mxstage/license/authorize";
/** 期限が近いと知らせる日数 */
export const EXPIRY_WARNING_DAYS = 30;

export interface EnvironmentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LicenseSnapshot {
  /** loading: 読み込み中 / ready: 読めた / unavailable: 橋渡しがライセンスを扱えない・つながらない */
  status: "loading" | "ready" | "unavailable";
  licenses: readonly LicenseEntry[];
  /** 変わるたびに増える（反映の可否の計算をやり直す目印） */
  version: number;
}

export type LicenseSaveOutcome = { ok: true; license: LicenseEntry } | { ok: false; problem: LicenseProblem | "unavailable" };
export type AuthorizeOutcome = { ok: true; license: LicenseEntry } | { ok: false; problem: AuthorizeProblem | "unavailable"; licensedHosts: string[] };

/** 反映の関門（src/app/commit/controller.ts）が使う口 */
export interface LicenseGate {
  snapshot(): LicenseSnapshot;
  subscribe(listener: () => void): () => void;
  /** 期限内のキーのうち、接続先を本番の接続先に持つもの */
  licenseFor(baseUrl: string): LicenseEntry | null;
  /** 接続先の環境。キーにあれば本番、無ければ利用者の申告、申告も無ければ null */
  environmentOf(baseUrl: string): Environment | null;
  /** 本番に反映する直前に、橋渡しでもう一度確かめる */
  authorize(baseUrl: string): Promise<AuthorizeOutcome>;
}

export interface LicenseClientDeps {
  fetch?: typeof fetch;
  storage?: EnvironmentStorage | null;
  now?: () => number;
}

function isEntry(value: unknown): value is LicenseEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (v.state === "valid" || v.state === "expired" || v.state === "revoked" || v.state === "invalid") && typeof v.licenseId === "string";
}

function entriesOf(value: unknown): LicenseEntry[] | null {
  return Array.isArray(value) && value.every(isEntry) ? (value as LicenseEntry[]) : null;
}

/** 期限までの日数（切り上げ。期限が無ければ null） */
export function daysUntilExpiry(entry: LicenseEntry, now: number): number | null {
  if (entry.expiresAt === undefined) return null;
  const at = Date.parse(entry.expiresAt);
  return Number.isNaN(at) ? null : Math.ceil((at - now) / 86_400_000);
}

export class LicenseClient implements LicenseGate {
  private readonly fetchImpl: typeof fetch;
  private readonly storage: EnvironmentStorage | null;
  private readonly now: () => number;
  private state: LicenseSnapshot = { status: "loading", licenses: [], version: 0 };
  private readonly listeners = new Set<() => void>();

  constructor(deps: LicenseClientDeps = {}) {
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.storage = deps.storage ?? null;
    this.now = deps.now ?? Date.now;
  }

  snapshot(): LicenseSnapshot {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(status: LicenseSnapshot["status"], licenses: readonly LicenseEntry[]): void {
    this.state = { status, licenses, version: this.state.version + 1 };
    for (const l of [...this.listeners]) l();
  }

  private async call(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> } | null> {
    try {
      const res = await this.fetchImpl(body === undefined ? `${path}?t=${this.now()}` : path, {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        credentials: "same-origin",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const json: unknown = await res.json().catch(() => null);
      return json !== null && typeof json === "object" ? { status: res.status, json: json as Record<string, unknown> } : null;
    } catch {
      return null;
    }
  }

  /** 置いてあるキーを読み直す */
  async refresh(): Promise<void> {
    const res = await this.call(LICENSE_ENDPOINT);
    const licenses = res?.status === 200 ? entriesOf(res.json.licenses) : null;
    if (licenses === null) this.set("unavailable", []);
    else this.set("ready", licenses);
  }

  /** キーを保存する（貼り付けた文字列のまま渡す。確かめるのは橋渡し） */
  async save(key: string): Promise<LicenseSaveOutcome> {
    const res = await this.call(LICENSE_ENDPOINT, { key });
    const licenses = res === null ? null : entriesOf(res.json.licenses);
    if (licenses !== null) this.set("ready", licenses);
    if (res !== null && res.status === 200 && isEntry(res.json.license)) return { ok: true, license: res.json.license };
    if (res !== null && res.status === 422 && typeof res.json.problem === "string") return { ok: false, problem: res.json.problem as LicenseProblem };
    return { ok: false, problem: "unavailable" };
  }

  /** キーを外す */
  async remove(licenseId: string): Promise<boolean> {
    const res = await this.call(LICENSE_REMOVE_ENDPOINT, { licenseId });
    const licenses = res === null ? null : entriesOf(res.json.licenses);
    if (licenses !== null) this.set("ready", licenses);
    return res?.status === 200 && res.json.removed === true;
  }

  licenseFor(baseUrl: string): LicenseEntry | null {
    const host = licenseHostOf(baseUrl);
    if (host === null) return null;
    return this.state.licenses.find((e) => e.state === "valid" && (e.hosts ?? []).includes(host)) ?? null;
  }

  async authorize(baseUrl: string): Promise<AuthorizeOutcome> {
    const res = await this.call(LICENSE_AUTHORIZE_ENDPOINT, { baseUrl });
    if (res !== null && res.status === 200 && isEntry(res.json.license)) return { ok: true, license: res.json.license };
    const licensedHosts = Array.isArray(res?.json.licensedHosts) ? (res.json.licensedHosts as unknown[]).filter((h): h is string => typeof h === "string") : [];
    if (res !== null && res.status === 403 && typeof res.json.problem === "string") return { ok: false, problem: res.json.problem as AuthorizeProblem, licensedHosts };
    return { ok: false, problem: "unavailable", licensedHosts };
  }

  // -------------------------------------------------------------------------
  // 接続先ごとの申告
  // -------------------------------------------------------------------------

  private declarations(): Record<string, Environment> {
    try {
      const raw = this.storage?.getItem(ENVIRONMENTS_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, Environment] => e[1] === "production" || e[1] === "test"));
    } catch {
      return {};
    }
  }

  /** 利用者が申告した環境（無ければ null） */
  declared(baseUrl: string): Environment | null {
    return this.declarations()[normalizeScope(baseUrl)] ?? null;
  }

  /** 接続先の環境を申告する（キーの本番の接続先に含まれる接続先は、申告に関わらず本番） */
  declare(baseUrl: string, environment: Environment): void {
    const all = { ...this.declarations(), [normalizeScope(baseUrl)]: environment };
    try {
      this.storage?.setItem(ENVIRONMENTS_STORAGE_KEY, JSON.stringify(all));
    } catch {
      // 保存できなくても、次の接続でもう一度選んでもらうだけ
    }
    this.set(this.state.status, this.state.licenses);
  }

  environmentOf(baseUrl: string): Environment | null {
    if (this.licenseFor(baseUrl) !== null) return "production";
    return this.declared(baseUrl);
  }
}
