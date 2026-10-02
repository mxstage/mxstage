// 作業を別の窓からこの窓へ移す（作業画面の「この窓に移す」）。橋渡しの /_mxstage/handoff を使う（src/bridge/handoff.ts）。
// 作業のある窓が作業を送り、この窓で作り直したら done を送る。送り元の窓は作業を空にする。

import { Workspace, type WorkspaceJSON } from "../store";
import { HANDOFF_ENDPOINTS } from "./runtime";

export type HandoffFailure = "no_source" | "committing" | "loading" | "timeout" | "too_large" | "invalid" | "unavailable";

export type FetchWorkResult = { ok: true; token: string; workspace: Workspace } | { ok: false; reason: HandoffFailure };

function failureOf(error: unknown): HandoffFailure {
  switch (error) {
    case "no_source":
    case "committing":
    case "loading":
    case "too_large":
      return error;
    case "handoff_timeout":
      return "timeout";
    default:
      return "unavailable";
  }
}

/** 作業のある窓から作業を受け取り、この窓用に作り直す（まだ送り元は空にしない） */
export async function fetchWorkFromOtherWindow(tabId: string, opts: { fetch?: typeof fetch; now?: () => number } = {}): Promise<FetchWorkResult> {
  const fetchImpl = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let json: Record<string, unknown> | null;
  try {
    const res = await fetchImpl(HANDOFF_ENDPOINTS.start, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabId }),
      cache: "no-store",
    });
    const v: unknown = await res.json().catch(() => null);
    json = v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (!json || json.ok !== true || typeof json.token !== "string") return { ok: false, reason: failureOf(json?.error) };
  try {
    const workspace = Workspace.fromJSON(json.workspace as WorkspaceJSON, opts.now ? { now: opts.now } : {});
    return { ok: true, token: json.token, workspace };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/** 再読み込みのあいだ預けた作業の合言葉を置く sessionStorage のキー（同じタブの再読み込みでだけ残る） */
export const PARKED_TOKEN_KEY = "mxstage.parkedWork";

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 再読み込みの前に、作業を橋渡しのメモリに預ける（ファイルには書かない。10 分で消える）。
 * 預けられたら true（合言葉はこのタブの sessionStorage に置く）
 */
export async function parkWork(workspace: Workspace, storage: SessionStorageLike | null, opts: { fetch?: typeof fetch } = {}): Promise<boolean> {
  if (storage === null) return false;
  const fetchImpl = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  try {
    const res = await fetchImpl(HANDOFF_ENDPOINTS.park, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(workspace.toJSON()), cache: "no-store" });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; token?: unknown } | null;
    if (!res.ok || json?.ok !== true || typeof json.token !== "string") return false;
    storage.setItem(PARKED_TOKEN_KEY, json.token);
    return true;
  } catch {
    return false;
  }
}

export type UnparkResult = { kind: "none" } | { kind: "restored"; workspace: Workspace } | { kind: "lost" };

/** 開いたときに、再読み込みの前に預けた作業を受け取る（無ければ none、預けたのに受け取れなければ lost） */
export async function unparkWork(storage: SessionStorageLike | null, opts: { fetch?: typeof fetch; now?: () => number } = {}): Promise<UnparkResult> {
  let token: string | null = null;
  try {
    token = storage?.getItem(PARKED_TOKEN_KEY) ?? null;
    storage?.removeItem(PARKED_TOKEN_KEY);
  } catch {
    token = null;
  }
  if (token === null) return { kind: "none" };
  const fetchImpl = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  try {
    const res = await fetchImpl(HANDOFF_ENDPOINTS.unpark, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }), cache: "no-store" });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; workspace?: unknown } | null;
    if (!res.ok || json?.ok !== true) return { kind: "lost" };
    return { kind: "restored", workspace: Workspace.fromJSON(json.workspace as WorkspaceJSON, opts.now ? { now: opts.now } : {}) };
  } catch {
    return { kind: "lost" };
  }
}

/** この窓で作り直し終えた。送り元の窓に作業を空にさせる */
export async function confirmWorkMoved(token: string, tabId: string, opts: { fetch?: typeof fetch } = {}): Promise<boolean> {
  const fetchImpl = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  try {
    const res = await fetchImpl(HANDOFF_ENDPOINTS.done, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, tabId }),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}
