// 公開するデモのファイル: Excel（作業画面の読み取りで読めるか・同じ入力から同じバイト列か・CRC）と、
// 偽の Maximo の種のファイルへの分け方（読み戻すと同じになるか）。

import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { allExcel, type DailyRowTruth } from "../../dev/demo/excel/builders";
import { buildDemoData } from "../../dev/demo/build";
import { DEMO_DATA_VERSION, DEMO_MANIFEST_SHA256 } from "../../src/shared/demo";
import { crc32, writeXlsx } from "../../dev/demo/excel/xlsx";
import { filesToSeed, seedToFiles } from "../../src/demo/format";
import { plantsSeed } from "../../dev/datasets/plants/index";
import { hasJapanese } from "../../dev/datasets/plants/text";
import { createFakeMaximo } from "../fakes/fake-maximo";

// 作業画面の Excel の読み取り（src/app）は、橋渡しの tsconfig では型を確かめられない書き方を含むので、実行時にだけ読み込む
interface Table { name: string; rows: Array<{ row: number; cells: unknown[] }> }
const { parseXlsx } = (await import(/* @vite-ignore */ new URL("../../src/app/imports/xlsx.ts", import.meta.url).href)) as { parseXlsx: (b: Uint8Array) => Promise<{ tables: Table[] }> };
const { headerCandidates } = (await import(/* @vite-ignore */ new URL("../../src/app/imports/table.ts", import.meta.url).href)) as { headerCandidates: (t: Table) => Array<{ row: number }> };
interface ShapeModule {
  shapeImport: (t: Table, opts: Record<string, unknown>) => unknown;
  buildShapedSheet: (shaped: unknown, opts: Record<string, unknown>) => { rows: Array<{ values: Record<string, unknown> }>; notes: Record<string, unknown> };
}
const shape = (await import(/* @vite-ignore */ new URL("../../src/app/imports/shape.ts", import.meta.url).href)) as ShapeModule;
const SRC = { kind: "excel", importId: "i", fileName: "f.xlsx", sheetName: "s", headerRow: 1 };

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

/** ZIP の中の 1 つのファイルを文字列で読む */
function zipEntry(bytes: Uint8Array, name: string): string {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (dv.getUint32(at, true) === 0x04034b50) {
    const size = dv.getUint32(at + 18, true);
    const nameLen = dv.getUint16(at + 26, true);
    const extra = dv.getUint16(at + 28, true);
    const entry = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const data = bytes.subarray(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size);
    if (entry === name) return new TextDecoder().decode(inflateRawSync(data));
    at += 30 + nameLen + extra + size;
  }
  throw new Error(`${name} not found`);
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

  it.runIf(lang === "ja")("作業日報: A4 縦の帳票を 1 日 1 枚並べ、常駐の委託・業者の修繕・Maximo に無い修理が混ざる", () => {
    const f = files.ja.find((x) => x.id === "repair-log")!;
    expect(f.title).toContain("作業日報");
    const truth = f.truth as { rows: DailyRowTruth[]; reports: Record<string, number> };
    expect(Object.keys(truth.reports)).toEqual(["4月", "5月", "6月", "7月", "8月", "9月"]);
    for (const n of Object.values(truth.reports)) expect(n).toBeGreaterThanOrEqual(20);
    const rows = truth.rows;
    expect(rows.some((r) => r.contract === "SPOT" && r.ponum !== undefined && r.vendor !== undefined)).toBe(true);
    expect(rows.filter((r) => r.kind === "NEW" && r.fresh !== undefined).length).toBeGreaterThan(10);
    expect(rows.some((r) => r.kind === "PM" && r.wonum !== undefined)).toBe(true);
    // 同じ修理が 2 行に分かれる（「同上」）
    const resident = rows.filter((r) => r.contract === "RESIDENT" && r.kind === "WO").map((r) => `${r.report}|${r.wonum}`);
    expect(resident.length).toBeGreaterThan(new Set(resident).size);
    // 印刷: A4 縦、1 枚ごとに改ページ、印刷範囲
    const bytes = writeXlsx(f.sheets, { title: f.title, creator: "test", lang: "ja" });
    const sheet = zipEntry(bytes, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain('<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>');
    expect(sheet).toContain(`<rowBreaks count="${truth.reports["4月"]! - 1}"`);
    expect(zipEntry(bytes, "xl/workbook.xml")).toContain('<definedName name="_xlnm.Print_Area" localSheetId="0">');
  });

  it.runIf(lang === "en")("修理記録（英語）にも、日本語の作業日報と同じ Maximo に無い修理（日付・資産・故障の正解が同じ）がある", () => {
    type Fresh = { date: string; assetnum: string; prob: string; cause: string; remedy: string; description: string };
    const newOf = (l: "ja" | "en") =>
      ((files[l].find((x) => x.id === "repair-log")!.truth as { rows: Array<{ kind?: string; fresh?: Fresh }> }).rows)
        .filter((r) => r.kind === "NEW" && r.fresh !== undefined)
        .map((r) => r.fresh!);
    const key = (f: Fresh) => `${f.date}|${f.assetnum}|${f.prob}|${f.cause}|${f.remedy}`;
    const en = newOf("en");
    expect(en.length).toBeGreaterThan(10);
    expect(en.map(key).sort()).toEqual(newOf("ja").map(key).sort());
    // サイトの英語の例と同じ行（4 月の 1 号炉 脱硝の調節弁の作動渋い）
    expect(en.find((f) => f.date === "2026-04-06" && f.assetnum === "1000598")).toMatchObject({ description: "Line 1 SCR DeNOx Control Valve No.1 sticking", prob: "STUCK", cause: "LUBE", remedy: "LUBRIC" });
    // 英語の文に日本語が混ざらない
    for (const f of en) expect(f.description).not.toMatch(/[぀-ヿ一-鿿]/);
  });

  it.runIf(lang === "en")("修理記録（英語）は表のまま（帳票の書式も印刷の設定も無い）", () => {
    const f = files.en.find((x) => x.id === "repair-log")!;
    const bytes = writeXlsx(f.sheets, { title: f.title, creator: "test", lang: "en" });
    expect(zipEntry(bytes, "xl/worksheets/sheet1.xml")).not.toContain("pageSetup");
    expect(zipEntry(bytes, "xl/styles.xml")).toContain('<cellXfs count="11">');
  });

  it.runIf(lang === "ja")("作業日報は帳票の読み取り（form）で 1 明細 1 行になり、正解の行と同じ行を指す", async () => {
    const f = files.ja.find((x) => x.id === "repair-log")!;
    const truth = (f.truth as { rows: DailyRowTruth[] }).rows;
    const wb = await parseXlsx(writeXlsx(f.sheets, { title: f.title, creator: "test", lang: "ja" }));
    let total = 0;
    for (const t of wb.tables) {
      const built = shape.buildShapedSheet(
        shape.shapeImport(t, {
          form: { start: ["作業日報", "作業報告書"], fields: { NO: "No.", CONTRACT: "委託契約工事名", VENDOR: "受注者", WORKDATE: "作業日" }, items: { header: "作業内容", until: ["特記事項"] } },
          fillDown: { columns: ["作業区分"], mode: "blank", ditto: true },
        }),
        { name: "x", source: SRC },
      );
      const want = truth.filter((r) => r.sheet === t.name);
      expect(built.rows.map((r) => r.values.SOURCE_ROW), t.name).toEqual(want.map((r) => r.row));
      for (const r of built.rows) {
        expect(r.values.CONTRACT, t.name).toBeTruthy();
        expect(r.values.WORKDATE, t.name).toBeTruthy();
        expect(r.values.作業区分, t.name).not.toBe("〃");
      }
      expect(built.notes.forms).toBe(new Set(want.map((r) => r.report)).size);
      total += built.rows.length;
    }
    expect(total).toBe(truth.length);
  });

  it.runIf(lang === "ja")("作業日報の 6 か月分を 1 回で読むと、正解の行がすべて SHEET 付きでそろう", async () => {
    const f = files.ja.find((x) => x.id === "repair-log")!;
    const truth = (f.truth as { rows: DailyRowTruth[] }).rows;
    const wb = await parseXlsx(writeXlsx(f.sheets, { title: f.title, creator: "test", lang: "ja" }));
    const mod = shape as ShapeModule & { shapeImportMany: (t: Table[], o: Record<string, unknown>) => unknown };
    const built = shape.buildShapedSheet(
      mod.shapeImportMany(wb.tables, { form: { start: ["作業日報", "作業報告書"], fields: { WORKDATE: "作業日" }, items: { header: "作業内容", until: ["特記事項"] } } }),
      { name: "x", source: SRC },
    );
    expect(built.rows.map((r) => `${String(r.values.SHEET)}:${String(r.values.SOURCE_ROW)}`)).toEqual(truth.map((r) => `${r.sheet}:${r.row}`));
  });

  it("星取表は unpivot で印 1 つ・号機 1 つが 1 行になり、正解の印の数と合う", async () => {
    const f = files[lang].find((x) => x.id === "star-chart")!;
    const truth = (f.truth as { rows: Array<{ sheet: string; row: number; col: string; symbols: string; locs: string[] }> }).rows;
    const wb = await parseXlsx(writeXlsx(f.sheets, { title: f.title, creator: "test", lang }));
    const count = new Map<string, number>();
    for (const t of wb.tables) {
      const built = shape.buildShapedSheet(
        shape.shapeImport(t, {
          headerRow: 4,
          fillDown: { columns: ["A", "B", "C", "D", "E", "F"], mode: "blank", ditto: false },
          unpivot: { columns: ["H:S"], labelRow: 6, labelColumn: "FY", valueColumn: "MARK", keepEmpty: false, tokens: ["○", "◎", "●", "△", "★"], repeat: { countColumn: "E", labels: ["A", "B", "C", "D", "E", "F"], column: "UNIT" } },
        }),
        { name: "x", source: SRC },
      );
      for (const r of built.rows) count.set(`${t.name}|${String(r.values.SOURCE_CELL)}`, (count.get(`${t.name}|${String(r.values.SOURCE_CELL)}`) ?? 0) + 1);
    }
    for (const r of truth) expect(count.get(`${r.sheet}|${r.col}${r.row}`), `${r.sheet} ${r.col}${r.row}`).toBe(r.symbols.length * Math.max(1, r.locs.length));
  });

  it.runIf(lang === "en")("修理記録（英語）は fillDown（merged）で、結合した日付がすべての行に入る", async () => {
    const f = files.en.find((x) => x.id === "repair-log")!;
    const wb = await parseXlsx(writeXlsx(f.sheets, { title: f.title, creator: "test", lang: "en" }));
    for (const t of wb.tables) {
      const built = shape.buildShapedSheet(shape.shapeImport(t, { headerRow: 3, fillDown: { columns: ["A"], mode: "merged", ditto: false } }), { name: "x", source: SRC });
      expect(built.rows.length).toBeGreaterThan(20);
      for (const r of built.rows) expect(r.values.Date, t.name).toMatch(/^2026-\d\d-\d\d$/);
    }
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
  it("作ったデータの目録の版と SHA-256 が、製品に埋め込んだ値（src/shared/demo.ts）と同じ（データを変えたら埋め込みも直して公開する）", () => {
    const built = buildDemoData([{ lang: "ja", ...sets.ja }, { lang: "en", ...sets.en }]);
    expect(built.manifest.version).toBe(DEMO_DATA_VERSION);
    expect(built.manifestSha256).toBe(DEMO_MANIFEST_SHA256);
  });

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
