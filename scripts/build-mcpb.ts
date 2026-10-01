// Claude Desktop などに入れる拡張（.mcpb）を作る。
//   node --experimental-strip-types scripts/build-mcpb.ts   （npm run build:mcpb。先に npm run build で dist/app を作る）
//
// 中身（dist/mcpb/stage の下）:
//   manifest.json            MCPB の定義（mcpb/manifest.template.json に版とツールの一覧を入れる）
//   server/mxstage-bridge.mjs 橋渡しを esbuild で 1 つの ESM にしたもの（Node 20 以上。版を埋め込む。src/bridge/bundle.ts）
//   app/                     作業画面（dist/app の写し）
//   icon.png、LICENSE、THIRD_PARTY_NOTICES.md、README.md
// 出力: dist/mcpb/mxstage-<版>.mcpb（ZIP）と、その SHA-256（MCP Registry の server.json の fileSha256 に使う）。

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { build } from "esbuild";
import { TOOL_DEFS, TOOL_NAMES } from "../src/shared/toolDefs.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist", "mcpb");
const STAGE = join(OUT, "stage");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
const version = pkg.version;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!existsSync(join(ROOT, "dist", "app", "index.html"))) fail("dist/app がありません。先に npm run build を実行してください。");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(STAGE, "server"), { recursive: true });

// 1. 橋渡しを 1 つのファイルにする。依存（MCP の SDK・zod）も中に入れる。CommonJS の依存のために require を用意する
await build({
  entryPoints: [join(ROOT, "src", "bridge", "cli.ts")],
  outfile: join(STAGE, "server", "mxstage-bridge.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "eof",
  define: { __MXSTAGE_BUNDLE_VERSION__: JSON.stringify(version) },
  banner: { js: 'import { createRequire as __mxsCreateRequire } from "node:module"; const require = __mxsCreateRequire(import.meta.url);' },
  logLevel: "warning",
});

// 2. 作業画面と添えるファイル
cpSync(join(ROOT, "dist", "app"), join(STAGE, "app"), { recursive: true });
cpSync(join(ROOT, "public", "icon-512.png"), join(STAGE, "icon.png"));
for (const f of ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"]) cpSync(join(ROOT, f), join(STAGE, f));

// 3. manifest.json（ツールの一覧は TOOL_DEFS から。説明は 1 文目だけ）
const template = JSON.parse(readFileSync(join(ROOT, "mcpb", "manifest.template.json"), "utf8")) as Record<string, unknown>;
const firstSentence = (text: string) => {
  const m = /^(.+?[.!?])(\s|$)/.exec(text);
  return (m ? m[1] : text).replace(/\*\*/g, "");
};
const manifest = {
  ...template,
  version,
  tools: TOOL_NAMES.map((name) => ({ name, description: firstSentence(TOOL_DEFS[name].description) })),
};
writeFileSync(join(STAGE, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// 4. ZIP にする（ファイル名の区切りは / 。日付は固定して、同じ中身なら同じファイルになるようにする）
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function zip(files: { name: string; data: Buffer }[]): Buffer {
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const deflated = deflateRawSync(f.data, { level: 9 });
    const useDeflate = deflated.length < f.data.length;
    const body = useDeflate ? deflated : f.data;
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 のファイル名
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const files = listFiles(STAGE).map((full) => ({ name: relative(STAGE, full).split("\\").join("/"), data: readFileSync(full) }));
const archive = zip(files);
const outFile = join(OUT, `mxstage-${version}.mcpb`);
writeFileSync(outFile, archive);
const sha256 = createHash("sha256").update(archive).digest("hex");
writeFileSync(`${outFile}.sha256`, `${sha256}  mxstage-${version}.mcpb\n`);
process.stdout.write(`${relative(ROOT, outFile)}  ${(archive.length / 1024 / 1024).toFixed(1)} MB  ${files.length} files\nsha256 ${sha256}\n`);
