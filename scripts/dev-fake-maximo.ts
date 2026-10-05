// 開発用の偽の Maximo。仮想の Maximo（src/demo/fakeMaximo.ts）を https://127.0.0.1:9797 で動かし、
// 作業画面から通しで確かめたり、画面を撮影したりするのに使う。本物の Maximo には一切つながない。
//
//   npm run dev:fake-maximo              偽の Maximo（https://127.0.0.1:9797、API キーは画面に出す）
//   npm run dev:fake-maximo -- --dataset plants [--lang en]
//                                        ごみ焼却施設 3 か所の大きなデータ（dev/datasets/plants。中身は dev/README.md。既定は日本語）
//   npm run dev:bridge                   開発用の橋渡し（http://127.0.0.1:8790/app。自己署名を受け入れる）
//
// 橋渡しの Maximo への中継は https だけを受けるので、自己署名の証明書をその場で作る（openssl を使う）。
// 作った証明書は一時フォルダに置き、次からも使う。ポート 8788 はデモの橋渡しが使うので、開発では使わない。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countsTable, plantsSeed } from "../dev/datasets/plants/index.ts";
import { createFakeMaximo, sampleSeed, withDefinitions, type FakeMaximo } from "../src/demo/fakeMaximo.ts";

const DEFAULT_PORT = 9797;

function parsePort(argv: readonly string[]): number {
  const at = argv.indexOf("--port");
  const port = at >= 0 ? Number(argv[at + 1]) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port には 1〜65535 の整数を指定してください。");
  return port;
}

function parseDataset(argv: readonly string[]): "sample" | "plants" {
  const at = argv.indexOf("--dataset");
  if (at < 0) return "sample";
  const v = argv[at + 1];
  if (v === "plants" || v === "sample") return v;
  throw new Error("--dataset には plants か sample を指定してください。");
}

function parseLang(argv: readonly string[]): "ja" | "en" {
  const at = argv.indexOf("--lang");
  if (at < 0) return "ja";
  const v = argv[at + 1];
  if (v === "ja" || v === "en") return v;
  throw new Error("--lang には ja か en を指定してください。");
}

/** 既定の小さなデータ（試験の偽物と同じ。日付・真偽値の編集を試せるよう値を足す） */
function sampleFake(baseUrl: string): FakeMaximo {
  const fake = createFakeMaximo(withDefinitions(sampleSeed({ baseUrl })));
  // 日付・日時・真偽値の編集を画面で試せるよう、作業指示に値を入れておく（試験の偽物の既定の値は変えない）
  fake.records("MXAPIWO").forEach((rec, i) => {
    fake.update("MXAPIWO", rec.uid, (r) => {
      r.attrs.reportdate = `2026-09-${String(10 + i).padStart(2, "0")}T${String((i % 3) + 8).padStart(2, "0")}:30:00+09:00`;
      r.attrs.targstartdate = `2026-10-${String(1 + i * 3).padStart(2, "0")}T00:00:00+09:00`;
      r.attrs.ext_flag = i % 2 === 0;
    });
  });
  return fake;
}

/** 127.0.0.1 の自己署名の証明書（無ければ openssl で作る） */
function certificate(): { key: Buffer; cert: Buffer } {
  const dir = join(tmpdir(), "mxstage-dev-fake-maximo");
  const keyFile = join(dir, "key.pem");
  const certFile = join(dir, "cert.pem");
  if (!existsSync(keyFile) || !existsSync(certFile)) {
    mkdirSync(dir, { recursive: true });
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "365", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile],
      { stdio: "ignore" },
    );
  }
  return { key: readFileSync(keyFile), cert: readFileSync(certFile) };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function main(): void {
  const argv = process.argv.slice(2);
  const port = parsePort(argv);
  const dataset = parseDataset(argv);
  const lang = parseLang(argv);
  const baseUrl = `https://127.0.0.1:${port}`;
  let fake: FakeMaximo;
  let summary = "";
  if (dataset === "plants") {
    const t0 = performance.now();
    const { seed, data } = plantsSeed({ baseUrl, lang });
    const t1 = performance.now();
    summary = [
      `  データ: ごみ焼却施設 3 か所（ORGID KANKYO、${lang === "ja" ? "日本語" : "英語"}、基準日 ${data.asOf}）。生成 ${((t1 - t0) / 1000).toFixed(1)} 秒`,
      "  件数（オブジェクト構造ごと。MXAPIWO は MXAPIWODETAIL と同じ行）:",
      countsTable(seed),
      `  仕込んだデータ品質の問題: ${data.problems.length} 種類（dev/README.md）`,
    ].join("\n");
    fake = createFakeMaximo(seed);
    summary += `\n  メモリ ${Math.round(process.memoryUsage().rss / 1e6)} MB、起動まで ${((performance.now() - t0) / 1000).toFixed(1)} 秒`;
  } else {
    fake = sampleFake(baseUrl);
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = performance.now();
    const method = (req.method ?? "GET").toUpperCase();
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === "host" || name === "connection" || name === "content-length") continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    // 偽の Maximo は本文を文字列で受け取る（Buffer のままだと本文が無いものとして 400 を返す）
    const body = method === "GET" || method === "HEAD" ? undefined : (await readBody(req)).toString("utf8");
    const response = await fake.fetch(`${baseUrl}${req.url ?? "/"}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    const out = Buffer.from(await response.arrayBuffer());
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      outHeaders[name] = value;
    });
    res.writeHead(response.status, { ...outHeaders, "content-length": String(out.length) });
    res.end(out);
    process.stdout.write(`${new Date().toISOString()} ${method} ${(req.url ?? "/").split("?")[0]} → ${response.status} ${Math.round(performance.now() - started)}ms\n`);
  };

  const server = createServer(certificate(), (req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(err instanceof Error ? err.message : String(err));
    });
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(
      [
        `偽の Maximo: ${baseUrl}`,
        `  API キー: ${fake.apiKey}`,
        `  オブジェクト構造: ${Object.keys(fake.state.os).map((s) => s.toUpperCase()).join(", ")}`,
        ...(summary ? [summary] : []),
        "  作業画面（npm run dev:bridge のあと http://127.0.0.1:8790/app）の接続先にこの URL と API キーを入れてください。",
        "  止めるときは Ctrl+C。",
        "",
      ].join("\n"),
    );
  });
}

main();
