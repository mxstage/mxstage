// 保存した Maximo の接続先（名前・URL・環境・API キー）。橋渡しが預かり、作業画面には API キーを渡さない。
// - どの窓（PWA・普通のタブ・AI クライアントの中のブラウザ）で開いても、ここにある接続先で自動でつながる。
//   作業画面は接続先の ID だけを /mx に送り、橋渡しが API キーを付けて Maximo へ送る。
// - 置き場所は状態フォルダ（~/.config/mxstage）の connections.json。API キーは secretBox.ts で暗号化する
//   （Windows は DPAPI、macOS はキーチェーン）。
// - 一覧・保存・削除の入口（/_mxstage/connections）は作業画面（同一オリジン）からだけ受ける。キーそのものは返さない。

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoLangOfConnectionId, isReservedDemoHost } from "../shared/demo.ts";
import { SecretBox, SecretBoxError, type ProtectionKind, type SealedSecret } from "./secretBox.ts";

export const CONNECTIONS_FILE = "connections.json";
export const MAX_CONNECTIONS = 50;
export const CONNECTION_NAME_MAX = 128;
const API_KEY_MAX = 4096;
const API_KEY_RE = /^[\x21-\x7e]+$/;
const ID_RE = /^c_[0-9a-f]{16}$/;

export type ConnectionEnvironment = "production" | "test";

/** 作業画面に返す接続先（API キーを含めない） */
export interface ConnectionEntry {
  id: string;
  name: string;
  /** https://host[:port] */
  baseUrl: string;
  environment: ConnectionEnvironment | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface ConnectionList {
  connections: ConnectionEntry[];
  /** 最後に使った接続先（新しい窓はこれで自動でつなぐ）。デモの予約の ID（demo-ja など）のこともある */
  lastUsedId: string | null;
  /** API キーの守り方 */
  protection: ProtectionKind;
}

interface StoredConnection extends ConnectionEntry {
  apiKey: SealedSecret;
}

interface StoredFile {
  version: 1;
  lastUsedId: string | null;
  connections: StoredConnection[];
}

export interface SaveConnectionInput {
  /** 無ければ新しく作る */
  id?: string;
  name: string;
  baseUrl: string;
  environment: ConnectionEnvironment | null;
  /** 新しく作るときは必須。直すときは省けば前のキーのまま */
  apiKey?: string;
}

export type ConnectionProblem = "invalid_name" | "invalid_url" | "invalid_key" | "key_required" | "not_found" | "too_many" | "unavailable" | "unreadable";

export type SaveConnectionResult = { ok: true; connection: ConnectionEntry } | { ok: false; problem: ConnectionProblem };

export type ResolveResult = { ok: true; origin: string; apiKey: string } | { ok: false; problem: "not_found" | "unreadable" | "unavailable" };

/** https://host[:port] だけを受ける（/mx の X-Maximo-Base と同じ条件）。正規化したオリジンを返す。デモの予約のホストは受けない */
export function normalizeConnectionUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  if (isReservedDemoHost(u.hostname)) return null;
  return u.origin;
}

export interface ConnectionStoreOptions {
  /** 状態フォルダ（~/.config/mxstage） */
  dir: string;
  box?: SecretBox;
  now?: () => number;
}

export class ConnectionStore {
  private readonly dir: string;
  private readonly file: string;
  private readonly box: SecretBox;
  private readonly now: () => number;
  /** 開いた API キー（ID → キー）。ファイルが変わったら作り直す */
  private cache = new Map<string, { sealed: string; apiKey: string }>();

  constructor(opts: ConnectionStoreOptions) {
    this.file = join(opts.dir, CONNECTIONS_FILE);
    this.box = opts.box ?? new SecretBox({ dir: opts.dir });
    this.now = opts.now ?? Date.now;
    this.dir = opts.dir;
  }

  list(): ConnectionList {
    const stored = this.read();
    return {
      connections: stored.connections.map(publicEntry),
      // デモの ID は残す（落とし済みかは橋渡しの入口が見て決める。src/bridge/server.ts）
      lastUsedId: stored.connections.some((c) => c.id === stored.lastUsedId) || demoLangOfConnectionId(stored.lastUsedId) !== null ? stored.lastUsedId : null,
      protection: this.box.kind(),
    };
  }

  async save(input: SaveConnectionInput): Promise<SaveConnectionResult> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name === "" || name.length > CONNECTION_NAME_MAX) return { ok: false, problem: "invalid_name" };
    const baseUrl = typeof input.baseUrl === "string" ? normalizeConnectionUrl(input.baseUrl) : null;
    if (baseUrl === null) return { ok: false, problem: "invalid_url" };
    const environment = input.environment === "production" || input.environment === "test" ? input.environment : null;
    const apiKey = input.apiKey;
    if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey === "" || apiKey.length > API_KEY_MAX || !API_KEY_RE.test(apiKey))) {
      return { ok: false, problem: "invalid_key" };
    }

    const stored = this.read();
    const now = this.now();
    const existing = input.id === undefined ? undefined : stored.connections.find((c) => c.id === input.id);
    if (input.id !== undefined && !existing) return { ok: false, problem: "not_found" };
    if (!existing && apiKey === undefined) return { ok: false, problem: "key_required" };
    if (!existing && stored.connections.length >= MAX_CONNECTIONS) return { ok: false, problem: "too_many" };

    const id = existing?.id ?? `c_${randomBytes(8).toString("hex")}`;
    let sealed: SealedSecret | undefined = existing?.apiKey;
    if (apiKey !== undefined) {
      try {
        sealed = await this.box.seal(apiKey, id);
      } catch (e) {
        return { ok: false, problem: e instanceof SecretBoxError ? e.code : "unavailable" };
      }
    }
    if (!sealed) return { ok: false, problem: "key_required" };
    const entry: StoredConnection = {
      id,
      name,
      baseUrl,
      environment,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt ?? null,
      apiKey: sealed,
    };
    // 書き込みの直前に読み直す（暗号化の間にほかの窓が変えたかもしれない）
    const latest = this.read();
    const others = latest.connections.filter((c) => c.id !== id);
    this.write({ ...latest, connections: existing ? latest.connections.map((c) => (c.id === id ? entry : c)) : [...others, entry] });
    if (apiKey !== undefined) this.cache.set(id, { sealed: sealed.data, apiKey });
    return { ok: true, connection: publicEntry(entry) };
  }

  remove(id: string): boolean {
    const stored = this.read();
    if (!stored.connections.some((c) => c.id === id)) return false;
    this.cache.delete(id);
    this.write({ version: 1, lastUsedId: stored.lastUsedId === id ? null : stored.lastUsedId, connections: stored.connections.filter((c) => c.id !== id) });
    return true;
  }

  /** この接続先を使った（新しい窓はこれを選ぶ） */
  use(id: string): ConnectionEntry | null {
    const stored = this.read();
    const found = stored.connections.find((c) => c.id === id);
    if (!found) return null;
    const updated = { ...found, lastUsedAt: this.now() };
    this.write({ ...stored, lastUsedId: id, connections: stored.connections.map((c) => (c.id === id ? updated : c)) });
    return publicEntry(updated);
  }

  /** デモを使った（新しい窓はデモにつなぐ）。予約の ID だけを受ける */
  useDemo(id: string): boolean {
    if (demoLangOfConnectionId(id) === null) return false;
    const stored = this.read();
    this.write({ ...stored, lastUsedId: id });
    return true;
  }

  /** /mx が使う。接続先の Maximo のオリジンと API キー */
  async resolve(id: string): Promise<ResolveResult> {
    if (!ID_RE.test(id)) return { ok: false, problem: "not_found" };
    const found = this.read().connections.find((c) => c.id === id);
    if (!found) return { ok: false, problem: "not_found" };
    const cached = this.cache.get(id);
    if (cached && cached.sealed === found.apiKey.data) return { ok: true, origin: found.baseUrl, apiKey: cached.apiKey };
    try {
      const apiKey = await this.box.open(found.apiKey, id);
      this.cache.set(id, { sealed: found.apiKey.data, apiKey });
      return { ok: true, origin: found.baseUrl, apiKey };
    } catch (e) {
      return { ok: false, problem: e instanceof SecretBoxError ? e.code : "unreadable" };
    }
  }

  private read(): StoredFile {
    if (!existsSync(this.file)) return { version: 1, lastUsedId: null, connections: [] };
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoredFile>;
      const connections = Array.isArray(v.connections) ? v.connections.filter(isStored) : [];
      return { version: 1, lastUsedId: typeof v.lastUsedId === "string" ? v.lastUsedId : null, connections };
    } catch {
      return { version: 1, lastUsedId: null, connections: [] };
    }
  }

  private write(data: StoredFile): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Windows ではパーミッションを付けられない（キーは DPAPI で守る）
    }
    renameSync(tmp, this.file);
  }
}

function publicEntry(c: StoredConnection | ConnectionEntry): ConnectionEntry {
  return { id: c.id, name: c.name, baseUrl: c.baseUrl, environment: c.environment, createdAt: c.createdAt, updatedAt: c.updatedAt, lastUsedAt: c.lastUsedAt };
}

function isStored(v: unknown): v is StoredConnection {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  const key = c.apiKey as Record<string, unknown> | undefined;
  return (
    typeof c.id === "string" &&
    ID_RE.test(c.id) &&
    typeof c.name === "string" &&
    typeof c.baseUrl === "string" &&
    (c.environment === "production" || c.environment === "test" || c.environment === null) &&
    typeof c.createdAt === "number" &&
    typeof c.updatedAt === "number" &&
    (typeof c.lastUsedAt === "number" || c.lastUsedAt === null) &&
    !!key &&
    typeof key.iv === "string" &&
    typeof key.tag === "string" &&
    typeof key.data === "string"
  );
}
