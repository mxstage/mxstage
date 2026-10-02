// npm に公開するパッケージ（npx mxstage）を dist/npm に作る。
//   node --experimental-strip-types scripts/build-npm.ts   （npm run build:npm。先に npm run build:mcpb で dist/mcpb/stage を作る）
//
// 中身は .mcpb と同じ橋渡し（server/mxstage-bridge.mjs、依存は中に入っている）と作業画面（app/）に、
// npx から起動する入口（bin/mxstage.mjs）と package.json を足したもの。依存のパッケージは持たない。
// package.json の mcpName は MCP Registry の名前（server.json の name）と同じにする。Registry はこれで持ち主を確かめる。
// 公開は GitHub Actions（.github/workflows/publish-mcp-registry.yml）が Trusted Publishing で行う。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = join(ROOT, "dist", "mcpb", "stage");
const OUT = join(ROOT, "dist", "npm");

export const MCP_NAME = "io.github.mxstage/mxstage";

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
const manifest = JSON.parse(readFileSync(join(STAGE, "manifest.json"), "utf8")) as { version: string; description: string; keywords: string[] };
if (manifest.version !== pkg.version) {
  process.stderr.write(`dist/mcpb/stage の版（${manifest.version}）が package.json（${pkg.version}）と違います。先に npm run build:mcpb を実行してください。\n`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "bin"), { recursive: true });
for (const name of ["server", "app"]) cpSync(join(STAGE, name), join(OUT, name), { recursive: true });
for (const name of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.txt"]) cpSync(join(STAGE, name), join(OUT, name));

// 橋渡しは「直接起動されたときだけ動く」ので、入口から main を呼ぶ。作業画面は server/ の隣の app/ を使う（--app-dir は要らない）
writeFileSync(
  join(OUT, "bin", "mxstage.mjs"),
  [
    "#!/usr/bin/env node",
    "// npx mxstage の入口。本体は server/mxstage-bridge.mjs（Claude Desktop の拡張 .mcpb と同じもの）",
    'import { main } from "../server/mxstage-bridge.mjs";',
    "",
    "const code = await main(process.argv.slice(2));",
    "if (code !== 0) process.exit(code);",
    "",
  ].join("\n"),
);

const npmPackage = {
  name: "mxstage",
  version: pkg.version,
  description: manifest.description,
  mcpName: MCP_NAME,
  type: "module",
  bin: { mxstage: "bin/mxstage.mjs" },
  files: ["bin", "server", "app", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.txt"],
  engines: { node: ">=20" },
  license: "BUSL-1.1",
  author: "TSUNAGI <mxstage@tsunagi.app> (https://mxstage.tsunagi.app)",
  homepage: "https://mxstage.tsunagi.app",
  repository: { type: "git", url: "git+https://github.com/mxstage/mxstage.git" },
  bugs: { url: "https://github.com/mxstage/mxstage/issues", email: "mxstage@tsunagi.app" },
  keywords: [...new Set([...manifest.keywords, "mcp", "mcp-server", "model-context-protocol", "claude", "chatgpt"])],
};
writeFileSync(join(OUT, "package.json"), `${JSON.stringify(npmPackage, null, 2)}\n`);

if (!existsSync(join(OUT, "app", "index.html"))) {
  process.stderr.write("dist/npm/app/index.html がありません。\n");
  process.exit(1);
}
process.stdout.write(`${relative(ROOT, OUT)}  mxstage@${pkg.version}\n`);
