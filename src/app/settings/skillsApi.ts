// 設定の「Skill と辞書」が橋渡しに頼むこと（src/bridge/skillRoutes.ts の入口）。
// 接続先の Skill（共有フォルダに版を足していく）・この PC だけの Skill・AI の案を読み書きする。

import type { FolderInfo, Member } from "../dictionaries/client";
import { parseSkillList, type SkillList } from "./logic";

export const SKILL_ENDPOINTS = {
  list: "/_mxstage/skills",
  get: "/_mxstage/skills/get",
  places: "/_mxstage/skills/places",
  check: "/_mxstage/skills/check",
  save: "/_mxstage/skills/save",
  remove: "/_mxstage/skills/delete",
  revert: "/_mxstage/skills/revert",
  move: "/_mxstage/skills/move",
  discard: "/_mxstage/skills/discard",
} as const;

export type SkillPlace = "connection" | "pc";

export interface PlaceInfo {
  /** 作業画面の接続先（保存した接続先の ID・デモの ID・Maximo の URL） */
  scope: string;
  label: string;
  folder: FolderInfo;
  /** 届かなければ null */
  dictionaries: number | null;
  skills: number | null;
  drafts: number;
  members: number | null;
}

export interface SharedSkillSummary {
  name: string;
  description: string;
  version: string;
  place: SkillPlace;
  versionId: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SkillDraftSummary {
  name: string;
  description: string;
  version: string;
  createdAt: string;
  /** 同じ名前の Skill を直す案なら、そのときの版 */
  basedOn: string | null;
  /** 案の置き場の印（接続先の印、または pc） */
  draftScope: string;
}

export interface ConnectionSkillsListing {
  label: string;
  folder: FolderInfo;
  skills: SharedSkillSummary[];
  deleted: Array<{ name: string; at: string; by: string }>;
  problems: Array<{ name: string; level: "error" | "warn"; message: string }>;
  drafts: SkillDraftSummary[];
}

export interface SkillsListing extends SkillList {
  /** 今の接続先の Skill（接続していない・古い橋渡しなら null） */
  connection: ConnectionSkillsListing | null;
  /** 接続先の無い AI の案 */
  pcDrafts: SkillDraftSummary[];
}

export interface SkillDoc extends SharedSkillSummary {
  body: string;
}

export interface SkillVersion {
  id: string;
  at: string;
  by: string;
  byId: string;
  deleted: boolean;
  version: string | null;
}

export interface SkillCheck {
  errors: string[];
  warnings: string[];
  secrets: Array<{ line: number; kind: string; excerpt: string }>;
  bytes: number;
}

export interface SkillInput {
  name: string;
  description: string;
  body: string;
  version?: string;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string; message: string; status: number; body: Record<string, unknown> | null };

export class SkillsApi {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async call<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
    let res: Response;
    try {
      res = await this.fetchImpl(
        path,
        body === undefined
          ? { method: "GET", headers: { accept: "application/json" }, cache: "no-store" }
          : { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), cache: "no-store" },
      );
    } catch (e) {
      return { ok: false, error: "bridge_unreachable", message: e instanceof Error ? e.message : String(e), status: 0, body: null };
    }
    let json: Record<string, unknown> | null = null;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = null;
    }
    if (!res.ok || json === null || json.ok !== true) {
      return {
        ok: false,
        error: typeof json?.error === "string" ? json.error : `http_${res.status}`,
        message: typeof json?.message === "string" ? json.message : `HTTP ${res.status}`,
        status: res.status,
        body: json,
      };
    }
    return { ok: true, value: json as T };
  }

  async list(scope: string | null): Promise<ApiResult<SkillsListing>> {
    const res = await this.call<Record<string, unknown>>(scope === null ? SKILL_ENDPOINTS.list : `${SKILL_ENDPOINTS.list}?scope=${encodeURIComponent(scope)}`);
    if (!res.ok) return res;
    const base = parseSkillList(res.value);
    const connection = (res.value.connection ?? null) as ConnectionSkillsListing | null;
    const pcDrafts = Array.isArray(res.value.pcDrafts) ? (res.value.pcDrafts as SkillDraftSummary[]) : [];
    return { ok: true, value: { ...base, connection, pcDrafts } };
  }

  places(scopes: readonly string[]): Promise<ApiResult<{ places: PlaceInfo[]; member: Member }>> {
    const q = scopes.map((s) => `scope=${encodeURIComponent(s)}`).join("&");
    return this.call(`${SKILL_ENDPOINTS.places}?${q}`);
  }

  get(scope: string | null, place: "connection" | "pc" | "default", name: string): Promise<ApiResult<{ skill: SkillDoc | null; history: SkillVersion[]; problem?: string | null }>> {
    const q = new URLSearchParams({ place, name, ...(scope !== null ? { scope } : {}) });
    return this.call(`${SKILL_ENDPOINTS.get}?${q.toString()}`);
  }

  getDraft(draftScope: string, name: string): Promise<ApiResult<{ draft: SkillDraftSummary & { body: string } }>> {
    const q = new URLSearchParams({ place: "draft", draft: draftScope, name });
    return this.call(`${SKILL_ENDPOINTS.get}?${q.toString()}`);
  }

  check(scope: string | null, input: SkillInput): Promise<ApiResult<{ check: SkillCheck; otherCustomers: string[] }>> {
    return this.call(SKILL_ENDPOINTS.check, { scope, ...input });
  }

  save(req: {
    scope: string | null;
    place: SkillPlace;
    input: SkillInput;
    baseVersion?: string | null;
    force?: boolean;
    overwrite?: boolean;
    /** 案から保存するなら、その案の置き場の印（保存したら案を片づける） */
    draft?: string;
  }): Promise<ApiResult<{ skill: SkillDoc; created: boolean; warnings: string[] }>> {
    return this.call(SKILL_ENDPOINTS.save, {
      scope: req.scope,
      place: req.place,
      ...req.input,
      ...(req.baseVersion !== undefined ? { baseVersion: req.baseVersion } : {}),
      ...(req.force === true ? { force: true } : {}),
      ...(req.overwrite === true ? { overwrite: true } : {}),
      ...(req.draft !== undefined ? { draft: req.draft } : {}),
    });
  }

  remove(scope: string | null, place: SkillPlace, name: string): Promise<ApiResult<Record<string, never>>> {
    return this.call(SKILL_ENDPOINTS.remove, { scope, place, name });
  }

  revert(scope: string | null, place: SkillPlace, name: string, versionId: string): Promise<ApiResult<{ skill: SkillDoc }>> {
    return this.call(SKILL_ENDPOINTS.revert, { scope, place, name, versionId });
  }

  move(scope: string, name: string, force = false): Promise<ApiResult<{ skill: SkillDoc }>> {
    return this.call(SKILL_ENDPOINTS.move, { scope, place: "pc", name, ...(force ? { force: true } : {}) });
  }

  discard(draftScope: string, name: string): Promise<ApiResult<Record<string, never>>> {
    return this.call(SKILL_ENDPOINTS.discard, { draft: draftScope, name });
  }
}
