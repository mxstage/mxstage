// 画面のルート解決。
// /app と /settings は同じドキュメントの中で history API により切り替える
// （全画面遷移すると、メモリ上の API キーと作業データが消えるため）。

export type Route = { kind: "app" } | { kind: "settings" } | { kind: "structures" } | { kind: "redirect"; to: string };

export const APP_PATH = "/app";
export const SETTINGS_PATH = "/settings";
/**
 * 設定画面のタブ。URL のハッシュで選ぶ（/settings#license）。
 * ハッシュはルート解決（pathname だけを見る）に影響しない。
 */
export const SETTINGS_TABS = ["connection", "license", "assistants", "skills", "language"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** 設定画面の、そのタブを開く URL */
export function settingsPath(tab: SettingsTab): string {
  return `${SETTINGS_PATH}#${tab}`;
}

/** URL のハッシュ（"#license" や "license"）から設定のタブを読む。知らないものは null */
export function settingsTabOf(hash: string): SettingsTab | null {
  const id = hash.replace(/^#/, "");
  return (SETTINGS_TABS as readonly string[]).includes(id) ? (id as SettingsTab) : null;
}
/** 読み込んだオブジェクト構造を見る画面 */
export const STRUCTURES_PATH = "/structures";
/** history.pushState は popstate を出さないので、自前のイベントで画面に知らせる */
export const NAVIGATE_EVENT = "mxstage:navigate";

export function resolveRoute(pathname: string): Route {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === APP_PATH) return { kind: "app" };
  if (p === SETTINGS_PATH) return { kind: "settings" };
  if (p === STRUCTURES_PATH) return { kind: "structures" };
  // / と未知のパスは作業画面へ
  return { kind: "redirect", to: APP_PATH };
}

/** 修飾キーなしの左クリックだけを SPA 内の遷移にする（新しいタブで開く操作はブラウザに任せる） */
export function isPlainLeftClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) window.history.replaceState(window.history.state, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}
