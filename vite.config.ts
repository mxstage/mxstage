import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { BUILD_MARKER, PRECACHE_MARKER, buildIdFrom, findModuleSyntax, precacheList, replaceMarker } from "./src/app/pwa/cacheRules";

// 画面（SPA）と Service Worker のビルド設定。
// 開発サーバ（npm run dev:app）は、中継・Maximo の代理・取り込みをこのパソコンの橋渡し（ポート 8788）へ渡す。
const BRIDGE = "http://127.0.0.1:8788";
const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/**
 * ビルドの出力の一覧を sw.js に差し込む（先読みするファイルと、その版）。
 * 差し込めなければビルドを止める。黙って失敗すると、オフラインで立ち上がらない PWA が出荷される。
 */
function swPrecachePlugin(): Plugin {
  return {
    name: "mxstudio-sw-precache",
    apply: "build",
    // index.html は vite 自身の plugin が出力するので、その後で一覧を作る
    enforce: "post",
    generateBundle(_options, bundle) {
      const sw = bundle["sw.js"];
      if (!sw || sw.type !== "chunk") {
        this.error("sw.js が出力されていません（rollupOptions.input の sw を確認してください）");
        return;
      }
      // publicDir の中身（manifest・アイコン）はバンドルに現れないので、cacheRules の STATIC_PRECACHE で補う
      const urls = precacheList(Object.keys(bundle));
      sw.code = replaceMarker(sw.code, PRECACHE_MARKER, urls);
      sw.code = replaceMarker(sw.code, BUILD_MARKER, buildIdFrom(urls));
      // 古典スクリプトとして登録するので、import / export が残っていたら止める
      const found = findModuleSyntax(sw.code);
      if (found !== null) this.error(`sw.js に import / export が残っています（共有チャンクができています）: ${found}`);
    },
  };
}

export default defineConfig({
  root: "src/app",
  // manifest とアイコンはリポジトリ直下の public/ に置き、そのまま dist/app に写す
  publicDir: path("./public"),
  plugins: [react(), swPrecachePlugin()],
  // Carbon の Sass（styles/carbon.scss）。Carbon の中から出る非推奨の警告は出さない
  css: { preprocessorOptions: { scss: { quietDeps: true } } },
  build: {
    outDir: "../../dist/app",
    emptyOutDir: true,
    rollupOptions: {
      input: { index: path("./src/app/index.html"), sw: path("./src/app/sw.ts") },
      // Service Worker は URL が変わると別物になるので、ハッシュを付けず /sw.js に固定する
      output: { entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js") },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/mx": BRIDGE,
      // "/import" だけだと画面のソース（/imports/index.ts）まで橋渡しへ渡してしまう
      "/import/": BRIDGE,
      "/_mxstudio": BRIDGE,
      "/ws": { target: BRIDGE, ws: true },
    },
  },
});
