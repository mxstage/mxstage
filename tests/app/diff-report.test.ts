// 差分レポート（Excel）の試験。作ったブックを、取り込みと同じ xlsx の読み取り（parseXlsx）で読み戻して確かめる。
// 変更・追加・削除が 1 行ずつ載ること、変更前・変更後・作者・根拠が残ること、式として解釈されないこと、ZIP の CRC が合うことを見る。

import { afterEach, describe, expect, it } from "vitest";
import { diffReportFileName, diffReportSheets, diffReportXlsx } from "../../src/app/commit/diffReport";
import { buildXlsx, columnLetter, crc32, safeSheetNames } from "../../src/app/commit/xlsxWriter";
import { parseXlsx } from "../../src/app/imports/xlsx";
import { Workspace } from "../../src/app/store/workspace";
import { setLocale } from "../../src/shared/i18n";
import type { ColumnSchema } from "../../src/shared/model";
import { makeChildRowKey, makeParentKey, type SheetMeta, type SheetRow } from "../../src/shared/sheet";

const SHEET = "assets";
const CH = "ASSETSPEC";
const P1 = makeParentKey(["KITA", "1000001"]);
const P2 = makeParentKey(["KITA", "1000002"]);
const C11 = makeChildRowKey(P1, CH, 501);
const C21 = makeChildRowKey(P2, CH, 601);

const COLUMNS: ColumnSchema[] = [
  { name: "SITEID", type: "string", title: "サイト" },
  { name: "ASSETNUM", type: "string", title: "資産" },
  { name: "DESCRIPTION", type: "string", title: "説明" },
  { name: `${CH}.ASSETSPECID`, type: "integer", child: CH },
  { name: `${CH}.ASSETATTRID`, type: "string", child: CH, title: "属性" },
  { name: `${CH}.NUMVALUE`, type: "number", child: CH, title: "数値" },
];

function meta(): SheetMeta {
  return {
    name: SHEET,
    source: { kind: "maximo", os: "MXAPIASSET", select: ["*"], where: [], baseUrl: "https://maximo.example.com" },
    columns: COLUMNS,
    keyColumns: ["SITEID", "ASSETNUM"],
    childIdAttrs: { [CH]: "ASSETSPECID" },
  };
}

function rows(): SheetRow[] {
  const p1 = { SITEID: "KITA", ASSETNUM: "1000001", DESCRIPTION: "1号炉 押込送風機" };
  const p2 = { SITEID: "KITA", ASSETNUM: "1000002", DESCRIPTION: "=HYPERLINK(\"x\")" };
  return [
    { rowKey: C11, parentKey: P1, childName: CH, values: { ...p1, [`${CH}.ASSETSPECID`]: 501, [`${CH}.ASSETATTRID`]: "KW", [`${CH}.NUMVALUE`]: null } },
    { rowKey: C21, parentKey: P2, childName: CH, values: { ...p2, [`${CH}.ASSETSPECID`]: 601, [`${CH}.ASSETATTRID`]: "RPM", [`${CH}.NUMVALUE`]: 1450 } },
  ];
}

function workspace(): Workspace {
  const ws = new Workspace("作業");
  ws.createSheet(meta(), rows());
  ws.applyEdits(SHEET, [{ rowKey: C11, col: `${CH}.NUMVALUE`, value: 55, reason: "銘板の写真（調査票 12 行目）" }], { author: "llm", reason: "仕様の欠けを調査票から補う" });
  ws.addRows(SHEET, [{ [`${CH}.ASSETATTRID`]: "VOLT", [`${CH}.NUMVALUE`]: 400 }], { author: "llm", parentRowKey: C11, reason: "電圧の行が無い" });
  ws.deleteRows(SHEET, [C21], { author: "user", reason: "重複した仕様" });
  return ws;
}

afterEach(() => setLocale("en"));

describe("xlsxWriter", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("names columns like Excel", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });

  it("makes sheet names valid and unique", () => {
    expect(safeSheetNames(["a/b", "A_B", "x".repeat(40), ""])).toEqual(["a_b", "A_B_2", "x".repeat(31), "Sheet"]);
  });

  it("round-trips strings, numbers and empty cells through the import reader", async () => {
    const bytes = buildXlsx([{ name: "S", rows: [{ cells: ["a&<b>", 1.5, null, "改行\nあり"] }, { cells: ["=1+1"] }] }]);
    const wb = await parseXlsx(bytes);
    expect(wb.tables[0]!.name).toBe("S");
    expect(wb.tables[0]!.rows.map((r) => r.cells)).toEqual([
      ["a&<b>", 1.5, null, "改行\nあり"],
      ["=1+1"],
    ]);
  });
});

describe("diff report", () => {
  it("lists every change with before, after, author and reason", async () => {
    setLocale("ja");
    const wb = await parseXlsx(diffReportXlsx({ workspace: workspace(), sheet: SHEET, environment: "テスト", now: Date.UTC(2026, 9, 5) }));
    expect(wb.tables.map((t) => t.name)).toEqual(["概要", "差分"]);

    const changes = wb.tables[1]!.rows.map((r) => r.cells);
    expect(changes[0]).toEqual(["No.", "サイト", "資産", "子オブジェクト", "子の ID", "種類", "列", "属性名", "変更前", "変更後", "作者", "根拠", "時刻"]);
    const body = changes.slice(1);
    const changed = body.find((r) => r[5] === "変更")!;
    expect(changed.slice(1, 11)).toEqual(["KITA", "1000001", CH, "501", "変更", "数値", `${CH}.NUMVALUE`, "（空）", 55, "AI アシスタント"]);
    expect(changed[11]).toBe("銘板の写真（調査票 12 行目）");

    const added = body.filter((r) => r[5] === "追加行");
    expect(added.map((r) => [r[7], r[9]])).toEqual(
      expect.arrayContaining([
        [`${CH}.ASSETATTRID`, "VOLT"],
        [`${CH}.NUMVALUE`, 400],
      ]),
    );
    expect(added.every((r) => r[4] === "（新規）" && r[11] === "電圧の行が無い")).toBe(true);

    const deleted = body.find((r) => r[5] === "削除行")!;
    expect(deleted.slice(1, 3)).toEqual(["KITA", "1000002"]);
    expect(deleted[10]).toBe("利用者");
    expect(deleted[11]).toBe("重複した仕様");

    const summary = new Map(wb.tables[0]!.rows.map((r) => [r.cells[0], r.cells[1]]));
    expect(summary.get("Maximo")).toBe("https://maximo.example.com");
    expect(summary.get("環境")).toBe("テスト");
    expect(summary.get("オブジェクト構造")).toBe("MXAPIASSET");
    expect(summary.get("変更セル")).toBe(1);
    expect(summary.get("削除行")).toBe(1);
  });

  it("writes cell text as values, never as formulas", () => {
    const ws = workspace();
    ws.applyEdits(SHEET, [{ rowKey: C11, col: "DESCRIPTION", value: "=cmd|' /C calc'!A0" }], { author: "llm", reason: "x" });
    const bytes = diffReportXlsx({ workspace: ws, sheet: SHEET });
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("<f>");
    expect(text).toContain("=cmd|&apos;".replace("&apos;", "'"));
  });

  it("adds the write log only after a commit", () => {
    setLocale("en");
    const ws = workspace();
    expect(diffReportSheets({ workspace: ws, sheet: SHEET }).length).toBe(2);
    const log = [{ at: "2026-10-05T01:00:00.000Z", parentKey: P1, transactionId: "t1", ops: { change: 1, delete: 0, add: 1, attrs: ["ASSETSPEC.NUMVALUE"] }, httpStatus: 200, reasonCode: null, result: "verified" as const }];
    const sheets = diffReportSheets({ workspace: ws, sheet: SHEET, writeLog: log });
    expect(sheets.map((s) => s.name)).toEqual(["Summary", "Changes", "Write log"]);
    expect(sheets[2]!.rows[1]!.cells[1]).toBe("KITA / 1000001");
  });

  it("makes a safe file name", () => {
    expect(diffReportFileName("仕様 / 北部", new Date(2026, 9, 5, 9, 8, 7))).toBe("mxstage-diff-仕様_北部-20261005-090807.xlsx");
  });
});
