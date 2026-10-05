// デモのデータを作り、Cloudflare Pages に置くファイルを dist/demo-data に書き出す（形は src/demo/format.ts）。
// 正解（Excel の場面の答え・データ品質の問題の一覧）は dist/demo-data-truth に書き出し、公開しない。
//
//   npm run demo:build            日本語と英語の両方
//   npm run demo:build -- --lang en
//
// 公開は docs/demo-ops.md の手順で（wrangler pages deploy dist/demo-data --project-name mxstage-demo）。

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildDemoData } from "../dev/demo/build.ts";
import { filesToSeed } from "../src/demo/format.ts";
import { DATASET_VERSION, plantsSeed } from "../dev/datasets/plants/index.ts";
import type { Lang } from "../dev/datasets/plants/text.ts";
import { createFakeMaximo } from "../src/demo/fakeMaximo.ts";
import { DEMO_DATA_VERSION, DEMO_MANIFEST_SHA256 } from "../src/shared/demo.ts";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "dist", "demo-data");
const TRUTH = join(ROOT, "dist", "demo-data-truth");

function write(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function parseLangs(argv: string[]): Lang[] {
  const at = argv.indexOf("--lang");
  if (at < 0) return ["ja", "en"];
  const v = argv[at + 1];
  if (v !== "ja" && v !== "en") throw new Error("--lang には ja か en を指定してください。");
  return [v];
}

async function main(): Promise<void> {
  const langs = parseLangs(process.argv.slice(2));
  const vdir = join(OUT, `v${DATASET_VERSION}`);
  rmSync(vdir, { recursive: true, force: true });
  const t0 = performance.now();
  const inputs = langs.map((lang) => ({ lang, ...plantsSeed({ lang }) }));
  const built = buildDemoData(inputs);
  for (const [rel, bytes] of built.files) write(join(vdir, rel), bytes);
  for (const [lang, truth] of Object.entries(built.truth)) write(join(TRUTH, `v${DATASET_VERSION}`, lang, "truth.json"), JSON.stringify(truth, null, 1));

  // 読み戻して、同じ件数の偽の Maximo になることを確かめる
  for (const { lang, seed } of inputs) {
    const split = built.records[lang]!;
    const fake = createFakeMaximo(filesToSeed(split.osdefs, split.records));
    for (const [name, os] of Object.entries(seed.objectStructures)) {
      if (os.recordsFrom) continue;
      const n = fake.records(name).length;
      if (n !== (os.records ?? []).length) throw new Error(`${lang} ${name}: 読み戻した件数 ${n} ≠ ${(os.records ?? []).length}`);
    }
    const files = built.manifest.languages[lang]!.files;
    const total = files.reduce((n, f) => n + f.bytes, 0);
    process.stdout.write(`${lang}: ${files.length} ファイル、${(total / 1e6).toFixed(1)} MB\n`);
  }

  write(join(vdir, "manifest.json"), built.manifestBytes);
  write(join(OUT, "index.html"), landingPage(built.excelLinks));
  write(join(OUT, "_headers"), HEADERS);
  write(join(OUT, "robots.txt"), "User-agent: *\nDisallow: /v\n");
  process.stdout.write(`manifest: v${DATASET_VERSION}/manifest.json sha256 ${built.manifestSha256}（${((performance.now() - t0) / 1000).toFixed(1)} 秒）\n`);
  // 製品に埋め込んだ値（src/shared/demo.ts）と違えば、公開の前に直す
  if (langs.length === 2 && (built.manifestSha256 !== DEMO_MANIFEST_SHA256 || DATASET_VERSION !== DEMO_DATA_VERSION)) {
    process.stdout.write(`注意: 製品に埋め込んだ値と違います（src/shared/demo.ts は v${DEMO_DATA_VERSION} ${DEMO_MANIFEST_SHA256}）。公開するなら DEMO_MANIFEST_SHA256 を直してください。\n`);
  }
  process.stdout.write(`出力: ${OUT}\n正解（公開しない）: ${TRUTH}\n`);
}

// Pages の応答ヘッダ: データは版のフォルダごとに変わらないので長くキャッシュしてよい。作業画面から直接も読めるように CORS を許す
const HEADERS = `/v*
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=86400
  X-Content-Type-Options: nosniff
/v*/manifest.json
  Content-Type: application/json; charset=utf-8
/*.ndjson.gz
  Content-Type: application/gzip
/*.json.gz
  Content-Type: application/gzip
/*.xlsx
  Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
/
  Cache-Control: public, max-age=600
`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function landingPage(links: Record<string, Array<{ path: string; title: string; fileName: string; bytes: number }>>): string {
  const list = (lang: string) =>
    (links[lang] ?? []).map((l) => `<li><a href="${esc(l.path)}" download="${esc(l.fileName)}">${esc(l.title)}</a> <span class="size">${Math.round(l.bytes / 1024)} KB</span></li>`).join("\n        ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MX Stage demo data</title>
<meta name="robots" content="noindex">
<style>
:root { --bg: #ffffff; --fg: #161616; --muted: #525252; --line: #e0e0e0; --link: #0f62fe; }
@media (prefers-color-scheme: dark) { :root { --bg: #161616; --fg: #f4f4f4; --muted: #c6c6c6; --line: #393939; --link: #78a9ff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Meiryo", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 1.6rem; margin: 0 0 8px; }
h2 { font-size: 1.15rem; margin: 32px 0 8px; border-top: 1px solid var(--line); padding-top: 24px; }
p, li { color: var(--fg); }
.muted, .size { color: var(--muted); font-size: 0.9rem; }
a { color: var(--link); }
ul { padding-left: 1.2rem; }
</style>
</head>
<body>
<main>
  <h1>MX Stage demo data</h1>
  <p>Fictional maintenance data for three waste-to-energy plants, used by the built-in demo of <a href="https://mxstage.tsunagi.app">MX Stage</a>. MX Stage downloads it only when you choose the demo, and runs it on your own PC. Nothing here is real.</p>
  <h2 lang="en">Sample Excel files (English)</h2>
  <ul lang="en">
        ${list("en")}
  </ul>
  <h2 lang="ja">サンプルの Excel（日本語）</h2>
  <p lang="ja">MX Stage のデモ（架空のごみ焼却施設 3 か所）で、Maximo のデータと突き合わせて試すためのファイルです。データはすべて架空です。</p>
  <ul lang="ja">
        ${list("ja")}
  </ul>
  <p class="muted">Contact: mxstage@tsunagi.app</p>
</main>
</body>
</html>
`;
}

await main();
