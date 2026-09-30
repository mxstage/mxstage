import { defineConfig } from "vitest/config";

// app: ブラウザ側の純ロジック（シート・差分・書き込みエンジン等）と画面の部品を試験する
// bridge: ローカルの橋渡し（Node のプロセス。HTTP・WebSocket・MCP の往復）
export default defineConfig({
  test: {
    projects: [
      {
        // 文言は日本語に固定して始める（tests/app/setup.ts）
        test: { name: "app", include: ["tests/app/**/*.test.ts"], environment: "happy-dom", setupFiles: ["tests/app/setup.ts"] },
      },
      {
        // bridge: ローカルの橋渡し（Node の素のランタイムで動かす）
        test: { name: "bridge", include: ["tests/bridge/**/*.test.ts"], environment: "node" },
      },
    ],
  },
});
