// 公開するデモのファイル（dist/demo-data/v<版>/ の中身）をメモリの上で作る。書き出しは scripts/demo-build.ts。
// 試験（tests/dev/demo-files.test.ts）も同じものを作り、目録の SHA-256 が製品に埋め込んだ値（src/shared/demo.ts）と合うかを確かめる。

import type { FakeSeed } from "../../src/demo/fakeMaximo.ts";
import { DEMO_FORMAT, seedToFiles, sha256, type DemoManifest, type ManifestFile } from "../../src/demo/format.ts";
import { DATASET_VERSION } from "../datasets/plants/index.ts";
import type { PlantsData } from "../datasets/plants/generate.ts";
import type { Lang } from "../datasets/plants/text.ts";
import { allExcel } from "./excel/builders.ts";
import { writeXlsx } from "./excel/xlsx.ts";

export const DEMO_MAX_FILE = 25 * 1024 * 1024;

export interface DemoBuild {
  /** 版のフォルダからの相対パス → 中身 */
  files: Map<string, Uint8Array>;
  manifest: DemoManifest;
  manifestBytes: Uint8Array;
  manifestSha256: string;
  /** 言語 → 正解（公開しない） */
  truth: Record<string, Record<string, unknown>>;
  /** 言語 → 入口のページに出す Excel */
  excelLinks: Record<string, Array<{ path: string; title: string; fileName: string; bytes: number }>>;
  /** 言語 → 構造ごとの記録（読み戻しの確かめ用） */
  records: Record<string, { osdefs: Uint8Array; records: Array<{ os: string; count: number; bytes: Uint8Array }> }>;
}

export function buildDemoData(inputs: Array<{ lang: Lang; seed: FakeSeed; data: PlantsData }>): DemoBuild {
  const manifest: DemoManifest = { format: DEMO_FORMAT, version: DATASET_VERSION, asOf: "", languages: {} };
  const out: DemoBuild = { files: new Map(), manifest, manifestBytes: new Uint8Array(), manifestSha256: "", truth: {}, excelLinks: {}, records: {} };
  for (const { lang, seed, data } of inputs) {
    if (data.missingTranslations.length > 0) throw new Error(`英語の辞書に無い日本語が ${data.missingTranslations.length} 件あります: ${data.missingTranslations.slice(0, 5).join(" / ")}`);
    manifest.asOf = data.asOf;
    const files: ManifestFile[] = [];
    const put = (rel: string, bytes: Uint8Array, extra: Omit<ManifestFile, "path" | "bytes" | "sha256">) => {
      if (bytes.length > DEMO_MAX_FILE) throw new Error(`${rel} が 25 MiB を超えます（${bytes.length} バイト）`);
      out.files.set(rel, bytes);
      files.push({ path: rel, bytes: bytes.length, sha256: sha256(bytes), ...extra });
    };
    const split = seedToFiles(seed);
    out.records[lang] = split;
    put(`${lang}/osdefs.json.gz`, split.osdefs, { kind: "osdefs" });
    for (const r of split.records) put(`${lang}/os/${r.os}.ndjson.gz`, r.bytes, { kind: "records", os: r.os, records: r.count });

    const truth: Record<string, unknown> = { problems: data.problems, counts: data.counts };
    out.excelLinks[lang] = [];
    for (const x of allExcel(data)) {
      const bytes = writeXlsx(x.sheets, { title: x.title, creator: "MX Stage demo (fictional data)", lang });
      const rel = `${lang}/excel/${x.id}.xlsx`;
      put(rel, bytes, { kind: "excel", title: x.title, fileName: x.fileName });
      out.excelLinks[lang]!.push({ path: `v${DATASET_VERSION}/${rel}`, title: x.title, fileName: x.fileName, bytes: bytes.length });
      truth[x.id] = x.truth;
    }
    out.truth[lang] = truth;
    manifest.languages[lang] = { files };
  }
  out.manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`, "utf8");
  out.manifestSha256 = sha256(out.manifestBytes);
  return out;
}
