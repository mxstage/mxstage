// 橋渡しに保存した Maximo の接続先（/_mxstage/connections。src/bridge/connections.ts）。
// - API キーは橋渡しが OS の保護付きで暗号化して預かる。作業画面はキーを受け取らず、接続先の ID だけを /mx に送る。
// - どの窓（PWA・普通のタブ・AI クライアントの中のブラウザ）で開いても、開いたときに自動でつなぐ（autoConnect）。
//   選ぶ順: この窓（ブラウザ）で前に選んだ接続先 → 橋渡しが覚えている最後に使った接続先 → 1 つしか無ければそれ。
// - 落とし済みのデモ（設定の「デモ」）は別の配列 demo で届く。前に選んでいればデモにもつなぐが、「1 つしか無ければそれ」には数えない。

import { demoLangOfConnectionId } from "../../shared/demo";
import { demoMessages } from "../demo/messages";
import type { Environment } from "../license/client";

export const CONNECTIONS_ENDPOINT = "/_mxstage/connections";
export const CONNECTIONS_REMOVE_ENDPOINT = "/_mxstage/connections/remove";
export const CONNECTIONS_USE_ENDPOINT = "/_mxstage/connections/use";
/** この窓（ブラウザ）で選んだ接続先を覚えておく localStorage のキー */
export const SELECTED_CONNECTION_KEY = "mxstage.maximo.connectionId";

export interface SavedConnection {
  id: string;
  name: string;
  /** https://host[:port] */
  baseUrl: string;
  environment: Environment | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export type ProtectionKind = "dpapi" | "keychain" | "file";

export interface SavedConnectionsSnapshot {
  /** loading: 読み込み中 / ready: 読めた / unavailable: 橋渡しが古い・つながらない */
  status: "loading" | "ready" | "unavailable";
  connections: readonly SavedConnection[];
  /** 落とし済みのデモ（予約の ID demo-ja・demo-en。常にテスト環境） */
  demo: readonly SavedConnection[];
  lastUsedId: string | null;
  protection: ProtectionKind | null;
}

export type SaveProblem = "invalid_name" | "invalid_url" | "invalid_key" | "key_required" | "not_found" | "too_many" | "unavailable" | "unreadable" | "bridge_unavailable";

export type SaveOutcome = { ok: true; connection: SavedConnection } | { ok: false; problem: SaveProblem };

export interface SaveConnectionInput {
  id?: string;
  name: string;
  baseUrl: string;
  environment: Environment | null;
  /** 直すときに省けば、保存してあるキーのまま */
  apiKey?: string;
}

export interface SelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isConnection(value: unknown): value is SavedConnection {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.baseUrl === "string" &&
    (v.environment === "production" || v.environment === "test" || v.environment === null) &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number" &&
    (typeof v.lastUsedAt === "number" || v.lastUsedAt === null)
  );
}

export class SavedConnectionsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly storage: SelectionStorage | null;
  private readonly now: () => number;
  private state: SavedConnectionsSnapshot = { status: "loading", connections: [], demo: [], lastUsedId: null, protection: null };
  private readonly listeners = new Set<() => void>();

  constructor(deps: { fetch?: typeof fetch; storage?: SelectionStorage | null; now?: () => number } = {}) {
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.storage = deps.storage ?? null;
    this.now = deps.now ?? Date.now;
  }

  snapshot(): SavedConnectionsSnapshot {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  find(id: string): SavedConnection | null {
    return this.state.connections.find((c) => c.id === id) ?? this.state.demo.find((c) => c.id === id) ?? null;
  }

  /** この窓で前に選んだ接続先の ID */
  selectedId(): string | null {
    try {
      return this.storage?.getItem(SELECTED_CONNECTION_KEY) || null;
    } catch {
      return null;
    }
  }

  private remember(id: string): void {
    try {
      this.storage?.setItem(SELECTED_CONNECTION_KEY, id);
    } catch {
      // 覚えられなくても、橋渡しの「最後に使った接続先」で選べる
    }
  }

  /** 開いたときにつなぐ接続先（無ければ null） */
  preferred(): SavedConnection | null {
    const list = this.state.connections;
    const mine = this.selectedId();
    return (mine !== null ? this.find(mine) : null) ?? (this.state.lastUsedId !== null ? this.find(this.state.lastUsedId) : null) ?? (list.length === 1 ? (list[0] ?? null) : null);
  }

  private apply(json: Record<string, unknown>): void {
    const connections = Array.isArray(json.connections) ? json.connections.filter(isConnection).filter((c) => demoLangOfConnectionId(c.id) === null) : [];
    // デモの名前は画面の言語で出す（橋渡しは英語の名前を返す）
    const demo = (Array.isArray(json.demo) ? json.demo.filter(isConnection) : []).flatMap((c) => {
      const lang = demoLangOfConnectionId(c.id);
      return lang === null ? [] : [{ ...c, name: demoMessages().connectionName[lang], environment: "test" as const }];
    });
    const protection = json.protection === "dpapi" || json.protection === "keychain" || json.protection === "file" ? json.protection : null;
    this.state = { status: "ready", connections, demo, lastUsedId: typeof json.lastUsedId === "string" ? json.lastUsedId : null, protection };
    this.emit();
  }

  private emit(): void {
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

  async refresh(): Promise<SavedConnectionsSnapshot> {
    const res = await this.call(CONNECTIONS_ENDPOINT);
    if (res?.status === 200) this.apply(res.json);
    else {
      this.state = { ...this.state, status: "unavailable" };
      this.emit();
    }
    return this.state;
  }

  /** 保存する（API キーは橋渡しへ 1 回だけ送り、手元に残さない） */
  async save(input: SaveConnectionInput): Promise<SaveOutcome> {
    const res = await this.call(CONNECTIONS_ENDPOINT, input);
    if (res === null || (res.status !== 200 && res.status !== 422)) return { ok: false, problem: "bridge_unavailable" };
    this.apply(res.json);
    if (res.status === 200 && isConnection(res.json.connection)) return { ok: true, connection: res.json.connection };
    const problem = typeof res.json.problem === "string" ? (res.json.problem as SaveProblem) : "bridge_unavailable";
    return { ok: false, problem };
  }

  async remove(id: string): Promise<boolean> {
    const res = await this.call(CONNECTIONS_REMOVE_ENDPOINT, { id });
    if (res?.status === 200) this.apply(res.json);
    return res?.status === 200 && res.json.removed === true;
  }

  /** この接続先を使う（この窓と、橋渡しの「最後に使った接続先」に覚える） */
  async markUsed(id: string): Promise<void> {
    this.remember(id);
    const res = await this.call(CONNECTIONS_USE_ENDPOINT, { id });
    if (res?.status === 200) this.apply(res.json);
  }
}
