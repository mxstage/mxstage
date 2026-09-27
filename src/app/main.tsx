// 画面のエントリ。作業画面 /app と API 設定画面 /settings を 1 つの SPA として描く。
import "@glideapps/glide-data-grid/dist/index.css";
// 書体は同梱する（外部 CDN を使わない）。日本語は Barlow に無いので OS の字体で出る
import "@fontsource/barlow/latin-400.css";
import "@fontsource/barlow/latin-500.css";
import "@fontsource/barlow/latin-700.css";
import "@fontsource/barlow-condensed/latin-400.css";
import "@fontsource/barlow-condensed/latin-600.css";
import "./styles/app.css";

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
