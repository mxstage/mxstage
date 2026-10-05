// 公開するデモのファイル: Excel（作業画面の読み取りで読めるか・同じ入力から同じバイト列か・CRC）と、
// 偽の Maximo の種のファイルへの分け方（読み戻すと同じになるか）。

import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { allExcel } from "../../dev/demo/excel/builders";
import { crc32, writeXlsx } from "../../dev/demo/excel/xlsx";
import { filesToSeed, seedToFiles } from "../../src/demo/format";
import { plantsSeed } from "../../dev/datasets/plants/index";
import { hasJapanese } from "../../dev/datasets/plants/text";
import { createFakeMaximo } from "../fakes/fake-maximo";

// 作業画面の Excel の読み取り（src/app）は、橋渡しの tsconfig では型を確かめられない書き方を含むので、実行時にだけ読み込む
interface Table { name: string; rows: Array<{ row: number; cells: unknown[] }> }
const { parseXlsx } = (await import(/* @vite-ignore */ new URL("../../src/app/imports/xlsx.ts", import.meta.url).href)) as { parseXlsx: (b: Uint8Array) => Promise<{ tables: Table[] }> };
const { headerCandidates } = (await import(/* @vite-ignore */ new URL("../../src/app/imports/table.ts", import.meta.url).href)) as { headerCandidates: (t: Table) => Array<{ row: number }> };

const sets = { ja: plantsSeed({ lang: "ja" }), en: plantsSeed({ lang: "en" }) };
const files = { ja: allExcel(sets.ja.data), en: allExcel(sets.en.data) };

/** ZIP の各ファイルの CRC が中身と合うか */
function checkZip(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  let n = 0;
  while (dv.getUint32(at, true) === 0x04034b50) {
    const crc = dv.getUint32(at + 14, true);
    const size = dv.getUint32(at + 18, true);
    const nameLen = dv.getUint16(at + 26, true);
    const extra = dv.getUint16(at + 28, true);
    const data = bytes.subarray(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size);
    expect(crc32(new Uint8Array(inflateRawSync(data)))).toBe(crc);
    at += 30 + nameLen + extra + size;
    n++;
  }
  return n;
}

describe.each(["ja", "en"] as const)("Excel のサンプル（%s）", (lang) => {
  it("5 種あり、作業画面の読み取りで読め、見出しの行が見つかる", async () => {
    expect(files[lang].map((f) => f.id)).toEqual(["purchase-orders", "legacy-register", "repair-log", "east-register", "star-chart"]);
    for (const f of files[lang]) {
      const bytes = writeXlsx(f.sheets, { title: f.title, creator: "test", lang });
      expect(checkZip(bytes)).toBeGreaterThan(8);
      const wb = await parseXlsx(bytes);
      expect(wb.tables.length, f.id).toBe(f.sheets.length);
      const t = wb.tables[0]!;
      expect(t.rows.length, f.id).toBeGreaterThan(10);
      expect(headerCandidates(t).length, f.id).toBeGreaterThan(0);
      if (lang === "en") for (const s of f.sheets) for (const row of s.rows) for (const c of row) {
        const v = c !== null && typeof c === "object" ? c.v : c;
        if (typeof v === "string") expect(hasJapanese(v), `${f.id}: ${v}`).toBe(false);
      }
    }
  });

  it("同じ入力から同じバイト列になる", () => {
    const f = files[lang][0]!;
    const a = writeXlsx(f.sheets, { title: f.title, creator: "x", lang });
    const b = writeXlsx(allExcel(sets[lang].data)[0]!.sheets, { title: f.title, creator: "x", lang });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("発注リスト: 日付のセルは ISO の日付になり、金額は数値と文字が混じる", async () => {
    const f = files[lang].find((x) => x.id === "purchase-orders")!;
    const wb = await parseXlsx(writeXlsx(f.sheets, { title: f.title, creator: "x", lang }));
    const t = wb.tables[0]!;
    const cells = t.rows.flatMap((r) => r.cells);
    expect(cells.some((v) => typeof v === "string" && /^20\d\d-\d\d-\d\d/.test(v))).toBe(true);
    expect(cells.some((v) => typeof v === "number" && v > 1000)).toBe(true);
    expect(cells.some((v) => typeof v === "string" && (lang === "ja" ? /千円|万円/.test(v) : /\$|k$/.test(v)))).toBe(true);
    const truth = f.truth as { rows: Array<{ kind: string; wonums: string[] }> };
    expect(truth.rows.filter((r) => r.kind === "WO").length).toBeGreaterThan(60);
    expect(truth.rows.some((r) => r.kind === "ANNUAL" && r.wonums.length > 1)).toBe(true);
    expect(truth.rows.some((r) => r.kind === "NOWO" && r.wonums.length === 0)).toBe(true);
  });

  it("修理記録: 故障コードの無い作業指示を指す行がある", () => {
    const f = files[lang].find((x) => x.id === "repair-log")!;
    const rows = (f.truth as { rows: Array<{ failurecodeMissing: boolean }> }).rows;
    expect(rows.filter((r) => r.failurecodeMissing).length).toBeGreaterThan(30);
  });

  it("東部の台帳: 更新・増設・仕様の変更・名前の変更・撤去・Maximo の方が新しい行がある", () => {
    const f = files[lang].find((x) => x.id === "east-register")!;
    const kinds = new Set((f.truth as { rows: Array<{ kind: string }> }).rows.map((r) => r.kind));
    for (const k of ["SAME", "REPLACED", "ADDED", "SPEC_CHANGED", "RENAMED", "REMOVED", "MAXIMO_NEWER"]) expect(kinds.has(k), k).toBe(true);
  });

  it("星取表: 印は Maximo を入れる前の年度だけで、○◎●△★ を使う", () => {
    const f = files[lang].find((x) => x.id === "star-chart")!;
    const rows = (f.truth as { rows: Array<{ fy: number; symbols: string }> }).rows;
    expect(rows.length).toBeGreaterThan(500);
    for (const r of rows) {
      expect(r.fy).toBeLessThan(2018);
      expect(r.symbols).toMatch(/^[○◎●△★]+$/);
    }
    expect(new Set(rows.flatMap((r) => r.symbols.split(""))).size).toBe(5);
  });
});

describe("公開するデータのファイル", () => {
  it("分けたファイルを読み戻すと、同じ偽の Maximo になる", async () => {
    const small = plantsSeed({ lang: "en", sites: ["HIGASHI"], historyFrom: "2026-06-01T00:00:00+09:00", baseUrl: "https://maximo.test" });
    const { osdefs, records } = seedToFiles(small.seed);
    const back = filesToSeed(osdefs, records);
    back.baseUrl = "https://maximo.test";
    expect(JSON.stringify(back.objectStructures)).toBe(JSON.stringify(small.seed.objectStructures));
    const fake = createFakeMaximo(back);
    const res = await fake.fetch("https://maximo.test/maximo/api/os/mxapiasset?lean=1&oslc.select=assetnum&collectioncount=1", { headers: { apikey: fake.apiKey } });
    const body = (await res.json()) as { responseInfo: { totalCount: number } };
    expect(body.responseInfo.totalCount).toBe(small.seed.objectStructures.MXAPIASSET!.records!.length);
  });
});
