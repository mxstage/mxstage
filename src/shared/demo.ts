// Maximo が無くても試せるデモ（架空のごみ焼却施設 3 か所、日本語・英語）。橋渡しと作業画面が共に使う決まりごと。
// - データは製品に入れず、Cloudflare Pages に置いた静的なファイル（docs/demo-ops.md）を、利用者が設定の「デモ」で選んだときだけ落とす。
// - 落としたファイルは目録（manifest.json）の SHA-256 で確かめる。目録の SHA-256 はここに埋め込む（データを変えたら製品の版も上げる）。
// - デモの接続先は予約の ID（demo-ja・demo-en）と、DNS に出ない予約のオリジン（*.mxstage.invalid）で表す。
//   橋渡しはこの ID を手元の仮想 Maximo（src/bridge/demo.ts）にしかつながない。普通の接続先としては保存も中継もできない。

export type DemoLang = "ja" | "en";
export const DEMO_LANGS: readonly DemoLang[] = ["ja", "en"];

/** データの置き場所（静的なファイルだけ。何も送らない） */
export const DEMO_DATA_URL = "https://mxstage-demo.pages.dev";
/** この製品が使うデータの版（置き場所の v<版>/） */
export const DEMO_DATA_VERSION = 3;
/** v<版>/manifest.json の SHA-256（npm run demo:build が最後に出す値） */
export const DEMO_MANIFEST_SHA256 = "aab5f962882b9fb1d6405904922f6494b4484a91de65cfc16bd67e92d9630ce6";

/** 予約の接続先 ID（保存した接続先の ID は c_<16 桁>なので重ならない） */
export const DEMO_CONNECTION_IDS: Readonly<Record<DemoLang, string>> = { ja: "demo-ja", en: "demo-en" };
/** 予約の Maximo のオリジン（.invalid は DNS で引けない。RFC 2606） */
export const DEMO_ORIGINS: Readonly<Record<DemoLang, string>> = {
  ja: "https://demo-ja.mxstage.invalid",
  en: "https://demo-en.mxstage.invalid",
};
const RESERVED_DOMAIN = "mxstage.invalid";

/** サンプルの Excel（置き場所の v<版>/<言語>/excel/<id>.xlsx） */
export const DEMO_EXCEL_IDS = ["purchase-orders", "legacy-register", "repair-log", "east-register", "star-chart"] as const;
export type DemoExcelId = (typeof DEMO_EXCEL_IDS)[number];

export function isDemoLang(value: unknown): value is DemoLang {
  return value === "ja" || value === "en";
}

export function isDemoExcelId(value: unknown): value is DemoExcelId {
  return typeof value === "string" && (DEMO_EXCEL_IDS as readonly string[]).includes(value);
}

/** 予約の接続先 ID ならその言語 */
export function demoLangOfConnectionId(id: string | null | undefined): DemoLang | null {
  for (const lang of DEMO_LANGS) if (DEMO_CONNECTION_IDS[lang] === id) return lang;
  return null;
}

/** デモのオリジン（末尾の / は問わない）ならその言語 */
export function demoLangOfBaseUrl(baseUrl: string | null | undefined): DemoLang | null {
  if (typeof baseUrl !== "string") return null;
  const trimmed = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  for (const lang of DEMO_LANGS) if (DEMO_ORIGINS[lang] === trimmed) return lang;
  return null;
}

/** 予約のホスト（普通の接続先として保存・中継しない） */
export function isReservedDemoHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/\.$/, "");
  return h === RESERVED_DOMAIN || h.endsWith(`.${RESERVED_DOMAIN}`);
}

/** 1 つの言語のデータの状態 */
export interface DemoLanguageStatus {
  /** none: 落としていない / downloading: 落としている / ready: 落とし済み / failed: 落とせなかった */
  state: "none" | "downloading" | "ready" | "failed";
  /** 落とす大きさ（目録を読むまでは null） */
  totalBytes: number | null;
  receivedBytes: number;
  /** failed のときの理由（英語のコード） */
  error: string | null;
}

export interface DemoExcelEntry {
  id: DemoExcelId;
  title: string;
  fileName: string;
  bytes: number;
  sha256: string;
}

/** GET /_mxstage/demo の応答 */
export interface DemoStatus {
  version: number;
  /** 置き場所のホスト（画面に出す） */
  dataHost: string;
  languages: Record<DemoLang, DemoLanguageStatus>;
  /** メモリに載せている言語（無ければ null） */
  loaded: { language: DemoLang; loadedAt: number; lastUsedAt: number } | null;
  /** 読み込み中の言語 */
  loading: DemoLang | null;
  /** 使わないまま過ぎたらメモリから放す時間（ミリ秒） */
  idleUnloadMs: number;
  /** 落とし済みの言語の Excel */
  excel: Partial<Record<DemoLang, DemoExcelEntry[]>>;
}

/** 橋渡しの入口 */
export const DEMO_PATH = "/_mxstage/demo";
export const DEMO_DOWNLOAD_PATH = "/_mxstage/demo/download";
export const DEMO_RESET_PATH = "/_mxstage/demo/reset";
export const DEMO_CLOSE_PATH = "/_mxstage/demo/close";
export const DEMO_REMOVE_PATH = "/_mxstage/demo/remove";
/** GET /_mxstage/demo/excel/<言語>/<id>.xlsx */
export const DEMO_EXCEL_PREFIX = "/_mxstage/demo/excel/";
