// 橋渡しの辞書と共有フォルダの入口（src/bridge/dictionaryRoutes.ts）を呼ぶ。作業画面と同じオリジンにだけ送る。

import type { DictionaryEntry, DictionaryMeta } from "../../shared/dictionary";
import type { SaveOp } from "./sheet";

export const DICTIONARY_ENDPOINTS = {
  list: "/_mxstage/dictionaries",
  get: "/_mxstage/dictionaries/get",
  create: "/_mxstage/dictionaries/create",
  save: "/_mxstage/dictionaries/save",
  revert: "/_mxstage/dictionaries/revert",
  folder: "/_mxstage/shared-folder",
  pick: "/_mxstage/shared-folder/pick",
  open: "/_mxstage/shared-folder/open",
  member: "/_mxstage/member",
} as const;

export type SyncKind = "onedrive-business" | "onedrive" | "sharepoint" | "box" | "google-drive" | "dropbox" | "network" | "local";

export interface FolderInfo {
  path: string | null;
  sync: SyncKind | null;
  reachable: boolean;
  writable: boolean;
}

export interface Member {
  id: string;
  name: string;
}

export interface DictionarySummary extends DictionaryMeta {
  count: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface HistoryItem {
  saveId: string;
  at: string;
  by: string;
  byId: string;
  added: number;
  changed: number;
  deleted: number;
  sample: string | null;
  revertible: boolean;
}

export interface DictionaryProblem {
  file: string;
  line: number | null;
  message: string;
  by: string | null;
}

export interface DictionaryListing {
  folder: FolderInfo;
  member: Member;
  dictionaries: DictionarySummary[];
  /** 変わったかを見分ける印（共有フォルダに届かなければ null） */
  version: string | null;
}

export interface DictionaryState {
  folder?: FolderInfo;
  dictionary: DictionaryMeta;
  entries: DictionaryEntry[];
  history: HistoryItem[];
  problems: DictionaryProblem[];
  version: string;
}

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: string; message: string; status: number };

export interface ProjectInfo {
  name: string;
  connections: Array<{ name: string; baseUrl: string; environment: "production" | "test" | null }>;
}

export class DictionaryClient {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async call<T>(path: string, init?: { body: unknown }): Promise<BridgeResult<T>> {
    let res: Response;
    try {
      res = await this.fetchImpl(
        path,
        init === undefined
          ? { method: "GET", headers: { accept: "application/json" }, cache: "no-store" }
          : { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(init.body), cache: "no-store" },
      );
    } catch (e) {
      return { ok: false, error: "bridge_unreachable", message: e instanceof Error ? e.message : String(e), status: 0 };
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (!res.ok || body === null || body.ok !== true) {
      return {
        ok: false,
        error: typeof body?.error === "string" ? body.error : `http_${res.status}`,
        message: typeof body?.message === "string" ? body.message : `HTTP ${res.status}`,
        status: res.status,
      };
    }
    return { ok: true, value: body as T };
  }

  list(scope: string): Promise<BridgeResult<DictionaryListing>> {
    return this.call(`${DICTIONARY_ENDPOINTS.list}?scope=${encodeURIComponent(scope)}`);
  }

  get(scope: string, id: string): Promise<BridgeResult<DictionaryState>> {
    return this.call(`${DICTIONARY_ENDPOINTS.get}?scope=${encodeURIComponent(scope)}&id=${encodeURIComponent(id)}`);
  }

  create(scope: string, name: string, kind: "alias" | "code" | "value" = "alias", description?: string): Promise<BridgeResult<DictionaryState>> {
    return this.call(DICTIONARY_ENDPOINTS.create, { body: { scope, name, kind, ...(description !== undefined ? { description } : {}) } });
  }

  save(scope: string, id: string, ops: readonly SaveOp[]): Promise<BridgeResult<DictionaryState & { saveId: string; ids: string[] }>> {
    return this.call(DICTIONARY_ENDPOINTS.save, { body: { scope, id, ops } });
  }

  revert(scope: string, id: string, saveId: string): Promise<BridgeResult<DictionaryState & { reverted: number; skipped: number }>> {
    return this.call(DICTIONARY_ENDPOINTS.revert, { body: { scope, id, saveId } });
  }

  setFolder(scope: string, path: string | null, project?: ProjectInfo): Promise<BridgeResult<DictionaryListing>> {
    return this.call(DICTIONARY_ENDPOINTS.folder, { body: { scope, path, ...(project ? { project } : {}) } });
  }

  pickFolder(): Promise<BridgeResult<{ path: string | null }>> {
    return this.call(DICTIONARY_ENDPOINTS.pick, { body: {} });
  }

  openFolder(scope: string): Promise<BridgeResult<Record<string, never>>> {
    return this.call(DICTIONARY_ENDPOINTS.open, { body: { scope } });
  }

  member(): Promise<BridgeResult<{ member: Member }>> {
    return this.call(DICTIONARY_ENDPOINTS.member);
  }

  setMemberName(name: string): Promise<BridgeResult<{ member: Member }>> {
    return this.call(DICTIONARY_ENDPOINTS.member, { body: { name } });
  }
}
