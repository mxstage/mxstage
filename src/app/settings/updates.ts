// 設定の「更新」が使う、橋渡しの /_mxstage/updates（src/bridge/updates.ts）の窓口。

export const UPDATES_ENDPOINT = "/_mxstage/updates";
export const UPDATES_CHECK_ENDPOINT = "/_mxstage/updates/check";
export const UPDATES_INSTALL_ENDPOINT = "/_mxstage/updates/install";

export type InstallKind = "git" | "bundle";
export type UpdatePhase = "idle" | "checking" | "waiting" | "applying" | "downloading" | "restart_needed" | "error";

export interface UpdateStatus {
  current: string;
  kind: InstallKind;
  autoUpdate: boolean;
  lastCheckAt: number | null;
  latest: { version: string; pageUrl: string; publishedAt: string | null } | null;
  available: boolean;
  phase: UpdatePhase;
  error: string | null;
  downloaded: string | null;
}

function parseStatus(v: unknown): UpdateStatus | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if (typeof s.current !== "string" || (s.kind !== "git" && s.kind !== "bundle") || typeof s.autoUpdate !== "boolean") return null;
  const latest = s.latest && typeof s.latest === "object" ? (s.latest as Record<string, unknown>) : null;
  return {
    current: s.current,
    kind: s.kind,
    autoUpdate: s.autoUpdate,
    lastCheckAt: typeof s.lastCheckAt === "number" ? s.lastCheckAt : null,
    latest:
      latest && typeof latest.version === "string" && typeof latest.pageUrl === "string"
        ? { version: latest.version, pageUrl: latest.pageUrl, publishedAt: typeof latest.publishedAt === "string" ? latest.publishedAt : null }
        : null,
    available: s.available === true,
    phase: typeof s.phase === "string" ? (s.phase as UpdatePhase) : "idle",
    error: typeof s.error === "string" ? s.error : null,
    downloaded: typeof s.downloaded === "string" ? s.downloaded : null,
  };
}

async function call(fetchImpl: typeof fetch, path: string, body?: unknown): Promise<UpdateStatus | null> {
  try {
    const res = await fetchImpl(body === undefined ? `${path}?t=${Date.now()}` : path, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!res.ok) return null;
    return parseStatus(await res.json());
  } catch {
    return null;
  }
}

export interface UpdatesApi {
  status(): Promise<UpdateStatus | null>;
  setAutoUpdate(on: boolean): Promise<UpdateStatus | null>;
  check(): Promise<UpdateStatus | null>;
  install(): Promise<UpdateStatus | null>;
}

export function createUpdatesApi(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): UpdatesApi {
  return {
    status: () => call(fetchImpl, UPDATES_ENDPOINT),
    setAutoUpdate: (on) => call(fetchImpl, UPDATES_ENDPOINT, { autoUpdate: on }),
    check: () => call(fetchImpl, UPDATES_CHECK_ENDPOINT, {}),
    install: () => call(fetchImpl, UPDATES_INSTALL_ENDPOINT, {}),
  };
}
