// 設定の「デモ」が使う、橋渡しの /_mxstage/demo（src/bridge/demo.ts）の窓口。

import {
  DEMO_CLOSE_PATH,
  DEMO_DOWNLOAD_PATH,
  DEMO_EXCEL_PREFIX,
  DEMO_LANGS,
  DEMO_PATH,
  DEMO_REMOVE_PATH,
  DEMO_RESET_PATH,
  isDemoExcelId,
  isDemoLang,
  type DemoExcelEntry,
  type DemoLang,
  type DemoLanguageStatus,
  type DemoStatus,
} from "../../shared/demo";

/** 橋渡しの答え。disabled: --no-demo / unavailable: 古い橋渡し・つながらない */
export type DemoState = { kind: "ready"; status: DemoStatus; error: string | null } | { kind: "disabled" } | { kind: "unavailable" };

function parseLanguage(v: unknown): DemoLanguageStatus | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if (s.state !== "none" && s.state !== "downloading" && s.state !== "ready" && s.state !== "failed") return null;
  return {
    state: s.state,
    totalBytes: typeof s.totalBytes === "number" ? s.totalBytes : null,
    receivedBytes: typeof s.receivedBytes === "number" ? s.receivedBytes : 0,
    error: typeof s.error === "string" ? s.error : null,
  };
}

function parseExcel(v: unknown): DemoExcelEntry[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((e): DemoExcelEntry[] => {
    if (!e || typeof e !== "object") return [];
    const x = e as Record<string, unknown>;
    return isDemoExcelId(x.id) && typeof x.title === "string" && typeof x.fileName === "string" && typeof x.bytes === "number" && typeof x.sha256 === "string"
      ? [{ id: x.id, title: x.title, fileName: x.fileName, bytes: x.bytes, sha256: x.sha256 }]
      : [];
  });
}

export function parseDemoStatus(v: unknown): DemoStatus | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  const langs = s.languages as Record<string, unknown> | undefined;
  if (typeof s.version !== "number" || typeof s.dataHost !== "string" || !langs || typeof langs !== "object") return null;
  const languages = {} as Record<DemoLang, DemoLanguageStatus>;
  for (const lang of DEMO_LANGS) {
    const parsed = parseLanguage(langs[lang]);
    if (parsed === null) return null;
    languages[lang] = parsed;
  }
  const loaded = s.loaded as Record<string, unknown> | null | undefined;
  const excelRaw = (s.excel ?? {}) as Record<string, unknown>;
  const excel: DemoStatus["excel"] = {};
  for (const lang of DEMO_LANGS) if (excelRaw[lang] !== undefined) excel[lang] = parseExcel(excelRaw[lang]);
  return {
    version: s.version,
    dataHost: s.dataHost,
    languages,
    loaded:
      loaded && isDemoLang(loaded.language) && typeof loaded.loadedAt === "number" && typeof loaded.lastUsedAt === "number"
        ? { language: loaded.language, loadedAt: loaded.loadedAt, lastUsedAt: loaded.lastUsedAt }
        : null,
    loading: isDemoLang(s.loading) ? s.loading : null,
    idleUnloadMs: typeof s.idleUnloadMs === "number" ? s.idleUnloadMs : 0,
    excel,
  };
}

export interface DemoApi {
  status(): Promise<DemoState>;
  download(lang: DemoLang): Promise<DemoState>;
  reset(): Promise<DemoState>;
  close(): Promise<DemoState>;
  remove(lang: DemoLang): Promise<DemoState>;
  /** ダウンロードのリンクに使う URL */
  excelUrl(lang: DemoLang, id: string): string;
}

export function createDemoApi(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): DemoApi {
  const call = async (path: string, body?: unknown): Promise<DemoState> => {
    try {
      const res = await fetchImpl(body === undefined ? `${path}?t=${Date.now()}` : path, {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        credentials: "same-origin",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.status === 404 && json?.error === "demo_disabled") return { kind: "disabled" };
      const status = parseDemoStatus(json);
      if (status === null) return { kind: "unavailable" };
      return { kind: "ready", status, error: res.ok ? null : typeof json?.error === "string" ? json.error.replace(/^demo_/, "") : "unreadable" };
    } catch {
      return { kind: "unavailable" };
    }
  };
  const excelUrl = (lang: DemoLang, id: string) => `${DEMO_EXCEL_PREFIX}${lang}/${encodeURIComponent(id)}.xlsx`;
  return {
    status: () => call(DEMO_PATH),
    download: (lang) => call(DEMO_DOWNLOAD_PATH, { language: lang }),
    reset: () => call(DEMO_RESET_PATH, {}),
    close: () => call(DEMO_CLOSE_PATH, {}),
    remove: (lang) => call(DEMO_REMOVE_PATH, { language: lang }),
    excelUrl,
  };
}
