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
