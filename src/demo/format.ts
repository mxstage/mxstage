// 公開するデモのデータの形（Cloudflare Pages に置く静的なファイル）と、その読み書き。
//   v<版>/manifest.json            目録（ファイルごとの大きさ・SHA-256・件数）。製品はこの SHA-256 を埋め込んで確かめる
//   v<版>/<言語>/osdefs.json.gz     オブジェクト構造の定義と値の一覧（records を除いた偽の Maximo の種）
//   v<版>/<言語>/os/<構造>.ndjson.gz 記録（1 行に 1 件の JSON）
//   v<版>/<言語>/excel/<id>.xlsx    Excel のサンプル
// 中身は JSON とただの Excel だけで、コードは含めない。

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { FakeOsSeed, FakeRecordSeed, FakeSeed } from "./fakeMaximo.ts";

export const DEMO_FORMAT = 1;

export interface ManifestFile {
  /** 版のフォルダからの相対パス（例 "ja/os/MXAPIASSET.ndjson.gz"） */
  path: string;
  kind: "osdefs" | "records" | "excel";
  bytes: number;
  sha256: string;
  /** records: オブジェクト構造と件数 */
  os?: string;
  records?: number;
  /** excel: 利用者に見せる名前と、保存するときのファイル名 */
  title?: string;
  fileName?: string;
}

export interface DemoManifest {
  format: number;
  version: number;
  /** データの基準日時 */
  asOf: string;
  languages: Record<string, { files: ManifestFile[] }>;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 偽の Maximo の種を、公開するファイルに分ける（定義と、構造ごとの記録） */
export function seedToFiles(seed: FakeSeed): { osdefs: Uint8Array; records: Array<{ os: string; count: number; bytes: Uint8Array }> } {
  const defs: Record<string, Omit<FakeOsSeed, "records">> = {};
  const records: Array<{ os: string; count: number; bytes: Uint8Array }> = [];
  for (const [name, os] of Object.entries(seed.objectStructures)) {
    const { records: recs, ...def } = os;
    defs[name] = def;
    if (os.recordsFrom || !recs) continue;
    const text = recs.map((r) => JSON.stringify(r)).join("\n");
    records.push({ os: name, count: recs.length, bytes: gzipSync(Buffer.from(text, "utf8"), { level: 9 }) });
  }
  return { osdefs: gzipSync(Buffer.from(JSON.stringify({ objectStructures: defs }), "utf8"), { level: 9 }), records };
}

/** 公開したファイルから偽の Maximo の種を組み立て直す */
export function filesToSeed(osdefs: Uint8Array, records: Array<{ os: string; bytes: Uint8Array }>): FakeSeed {
  const parsed = JSON.parse(gunzipSync(osdefs).toString("utf8")) as { objectStructures: Record<string, FakeOsSeed> };
  const seed: FakeSeed = { logRequests: false, objectStructures: parsed.objectStructures };
  for (const r of records) {
    const text = gunzipSync(r.bytes).toString("utf8");
    const list: FakeRecordSeed[] = text.length === 0 ? [] : text.split("\n").map((line) => JSON.parse(line) as FakeRecordSeed);
    const def = seed.objectStructures[r.os];
    if (!def) throw new Error(`records for unknown object structure ${r.os}`);
    def.records = list;
  }
  return seed;
}
