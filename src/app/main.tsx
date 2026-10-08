// 画面のエントリ。作業画面 /app と設定 /settings とオブジェクト構造 /structures を 1 つの SPA として描く。
import "@glideapps/glide-data-grid/dist/index.css";
// 書体は同梱する（外部 CDN を使わない）。Carbon の生産的な文字（productive type）は 400 と 600 だけを使う。
// 日本語は IBM Plex Sans JP を分割しない 1 ファイルで読む（分割版は 1 つの太さで 123 ファイルになる）。
// 日本語の書体は大きいので Service Worker の先読みから外し、初めて使ったときに保存する（pwa/cacheRules.ts）
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans-jp/japanese-400.css";
import "@fontsource/ibm-plex-sans-jp/japanese-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles/carbon.scss";
import "./styles/app.css";
import "./styles/editors.css";

import { createRoot } from "react-dom/client";
import { createServices } from "./boot/services";
import { browserServiceWorker, registerServiceWorker } from "./pwa/register";
import { Root } from "./ui/Root";

const services = createServices();
const el = document.getElementById("root");
if (el) createRoot(el).render(<Root services={services} />);

// PWA: 画面のファイル（HTML/JS/CSS/アイコン）だけを保存して、2 回目からはネットワーク無しでも立ち上がるようにする。
// Maximo の応答やツールの結果は保存しない（判断は pwa/cacheRules.ts）。
// 開発サーバ（vite dev）には sw.js が無いので登録しない。
if (import.meta.env.PROD) {
  const container = browserServiceWorker();
  if (container) void registerServiceWorker({ container, onUpdate: (message) => services.toasts.show(message) });
}
