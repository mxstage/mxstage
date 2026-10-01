// セルの編集を助ける仕組みの試験: 日付の書き方とオフセット、値の一覧（Maximo の getlist・マスタのシート）、スキーマの hasList。

import { describe, expect, it } from "vitest";
import { formatColumnValue } from "../../src/app/grid/cellStyle";
import { filterItems, isInList, masterListFor, maximoListTarget, mayHaveMaximoList } from "../../src/app/grid/valueLists";
import { MaximoClient } from "../../src/app/maximo/client";
import { getObjectStructureInfo, parseJsonSchema } from "../../src/app/maximo/meta";
import { fetchValueList, parseValueList, ValueListService } from "../../src/app/maximo/valueList";
import type { MaximoConnection } from "../../src/app/runtime/contracts";
import { browserOffset, coerceValue, formatDateForDisplay, normalizeDateInput, parseDateInput } from "../../src/app/store/values";
import { Workspace } from "../../src/app/store/workspace";
import type { CellValue, ColumnSchema } from "../../src/shared/model";
import { makeChildRowKey, makeParentKey, type MaximoRecord, type SheetMeta, type SheetRow } from "../../src/shared/sheet";
import { createFakeMaximo, sampleSeed } from "../fakes/fake-maximo";

// ---------------------------------------------------------------------------
// 日付
// ---------------------------------------------------------------------------

describe("日付の書き方（values.ts）", () => {
  it("YYYY-MM-DD・YYYY/MM/DD・1 桁の月日・時刻（T か空白、秒・秒未満・オフセットは任意）を読む", () => {
    expect(parseDateInput("2026/10/01")).toMatchObject({ y: 2026, mo: 10, d: 1, hasTime: false, tz: null });
    expect(parseDateInput("2026/1/5")).toMatchObject({ y: 2026, mo: 1, d: 5 });
    expect(parseDateInput(" 2026-10-01 9:05 ")).toMatchObject({ hh: 9, mi: 5, ss: 0, hasTime: true, tz: null });
    expect(parseDateInput("2026/10/01 09:05:30")).toMatchObject({ hh: 9, mi: 5, ss: 30 });
    expect(parseDateInput("2026-10-01T09:05:30.120+0900")).toMatchObject({ frac: "120", tz: "+09:00" });
    expect(parseDateInput("2026-10-01T09:05z")).toMatchObject({ tz: "Z" });
    // 区切りの混在・日付の順の違い・ありえない日付は読まない
    for (const bad of ["2026-10/01", "01/10/2026", "2026.10.01", "2026/02/30", "2026/13/01", "2026/10/01 24:00", "2026/10/01 9", "2026/10/01+09:00", "20261001"]) {
      expect(parseDateInput(bad), bad).toBeNull();
    }
  });

  it("ISO 8601 にそろえる。オフセット付きの ISO 8601 は書かれたまま、オフセットの無い時刻には指定のオフセットを付ける", () => {
    expect(normalizeDateInput("2026/1/5", "+09:00")).toBe("2026-01-05");
    expect(normalizeDateInput("2026-10-01", "+09:00")).toBe("2026-10-01");
    expect(normalizeDateInput("2026/10/01 9:30", "+09:00")).toBe("2026-10-01T09:30:00+09:00");
    expect(normalizeDateInput("2026-10-01T09:30", "-05:00")).toBe("2026-10-01T09:30:00-05:00");
    expect(normalizeDateInput("2026/10/01 09:30:15.5", "Z")).toBe("2026-10-01T09:30:15.5Z");
    // 参考にした値にもオフセットが無いときは付けない
    expect(normalizeDateInput("2026/10/01 09:30", null)).toBe("2026-10-01T09:30:00");
    // 指定が無ければブラウザのタイムゾーンのその日時のオフセット
    expect(normalizeDateInput("2026/10/01 09:30", undefined)).toBe(`2026-10-01T09:30:00${browserOffset({ y: 2026, mo: 10, d: 1, hh: 9, mi: 30 })}`);
    expect(browserOffset({ y: 2026, mo: 1, d: 1, hh: 0, mi: 0 })).toMatch(/^[+-]\d{2}:\d{2}$/);
    // 書かれたオフセットはそのまま（ISO でない書き方なら形だけそろえる）
    expect(normalizeDateInput("2026-10-01T09:30:00+0900", "Z")).toBe("2026-10-01T09:30:00+0900");
    expect(normalizeDateInput("2026/10/01 09:30 +09", "Z")).toBe("2026-10-01T09:30:00+09:00");
    expect(normalizeDateInput("10/01/2026", "Z")).toBeNull();
  });

  it("coerceValue は日付の列でも日時の列でも新しい書き方を受け、案内は英語だけ", () => {
    const date: ColumnSchema = { name: "D", type: "date" };
    const dt: ColumnSchema = { name: "T", type: "datetime" };
    expect(coerceValue(date, "2026/10/01")).toEqual({ ok: true, value: "2026-10-01" });
    expect(coerceValue(dt, "2026/10/01 08:00", { dateOffset: "+09:00" })).toEqual({ ok: true, value: "2026-10-01T08:00:00+09:00" });
    expect(coerceValue(dt, "2026-10-01T08:00:00+09:00", { dateOffset: "Z" })).toEqual({ ok: true, value: "2026-10-01T08:00:00+09:00" });
    const bad = coerceValue(dt, "tomorrow");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.message).toContain("YYYY/MM/DD");
      expect(bad.message).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  it("画面には読みやすい形で出す（オフセットは出さず、値のオフセットの時刻のまま）", () => {
    expect(formatDateForDisplay("date", "2026-04-01T00:00:00+09:00")).toBe("2026-04-01");
    expect(formatDateForDisplay("date", "2026-04-01T13:00:00+09:00")).toBe("2026-04-01 13:00");
    expect(formatDateForDisplay("datetime", "2026-04-01T09:30:00+09:00")).toBe("2026-04-01 09:30");
    expect(formatDateForDisplay("datetime", "2026-04-01T09:30:05-05:00")).toBe("2026-04-01 09:30:05");
    expect(formatDateForDisplay("datetime", "2026-04-01T09:30:00.500Z")).toBe("2026-04-01 09:30:00.5");
    expect(formatDateForDisplay("datetime", "2026-04-01")).toBe("2026-04-01");
    expect(formatDateForDisplay("datetime", "not a date")).toBe("not a date");
    expect(formatDateForDisplay("datetime", null)).toBe("");
    expect(formatColumnValue({ type: "datetime" }, "2026-04-01T09:30:00+09:00")).toBe("2026-04-01 09:30");
    expect(formatColumnValue({ type: "string" }, "2026-04-01T09:30:00+09:00")).toBe("2026-04-01T09:30:00+09:00");
  });
});

describe("日時に付けるオフセット（Workspace）", () => {
  const P1 = makeParentKey(["W1"]);
  const P2 = makeParentKey(["W2"]);
  const P3 = makeParentKey(["W3"]);
  const columns: ColumnSchema[] = [
    { name: "WONUM", type: "string" },
    { name: "REPORTDATE", type: "datetime" },
    { name: "SCHEDSTART", type: "datetime" },
    { name: "TARGDATE", type: "date" },
  ];
  function setup(source: SheetMeta["source"]): Workspace {
    const ws = new Workspace("test");
    const meta: SheetMeta = { name: "wo", source, columns, keyColumns: ["WONUM"], childIdAttrs: {} };
    const rows: SheetRow[] = [
      { rowKey: P1, parentKey: P1, childName: null, values: { WONUM: "W1", REPORTDATE: "2026-04-01T09:00:00-05:00", SCHEDSTART: null, TARGDATE: null } },
      { rowKey: P2, parentKey: P2, childName: null, values: { WONUM: "W2", REPORTDATE: null, SCHEDSTART: null, TARGDATE: "2026-04-01T00:00:00-05:00" } },
      { rowKey: P3, parentKey: P3, childName: null, values: { WONUM: "W3", REPORTDATE: "2026-04-02T10:00:00+09:00", SCHEDSTART: null, TARGDATE: null } },
    ];
    ws.createSheet(meta, rows);
    return ws;
  }
  const value = (ws: Workspace, rowKey: string, col: string): CellValue | undefined => ws.cell("wo", rowKey, col)?.value;

  it("セルの元の値のオフセット → 同じ列の値のオフセット → ブラウザのタイムゾーンの順に使う（Maximo のシート）", () => {
    const ws = setup({ kind: "maximo", os: "MXAPIWO", select: ["*"], where: [] });
    const res = ws.applyEdits(
      "wo",
      [
        { rowKey: P1, col: "REPORTDATE", value: "2026/10/01 08:00" },
        { rowKey: P3, col: "REPORTDATE", value: "2026/10/01 08:00" },
        { rowKey: P2, col: "REPORTDATE", value: "2026/10/01 08:00" },
        { rowKey: P1, col: "SCHEDSTART", value: "2026/10/01 08:00" },
        { rowKey: P1, col: "TARGDATE", value: "2026/10/1" },
      ],
      { author: "user" },
    );
    expect(res.conflicts).toEqual([]);
    expect(value(ws, P1, "REPORTDATE")).toBe("2026-10-01T08:00:00-05:00");
    expect(value(ws, P3, "REPORTDATE")).toBe("2026-10-01T08:00:00+09:00");
    // 元の値が無い行は、同じ列で最初に見つかった値のオフセット
    expect(value(ws, P2, "REPORTDATE")).toBe("2026-10-01T08:00:00-05:00");
    // 列に時刻付きの値が無ければブラウザのタイムゾーン
    expect(value(ws, P1, "SCHEDSTART")).toBe(`2026-10-01T08:00:00${browserOffset({ y: 2026, mo: 10, d: 1, hh: 8, mi: 0 })}`);
    expect(value(ws, P1, "TARGDATE")).toBe("2026-10-01");
  });

  it("Excel のシートで列に時刻付きの値が無ければ、オフセットを付けない。追加行も同じ規則", () => {
    const ws = setup({ kind: "excel", importId: "i1", fileName: "a.xlsx", sheetName: "S", headerRow: 1 });
    ws.applyEdits("wo", [{ rowKey: P1, col: "SCHEDSTART", value: "2026/10/01 08:00" }], { author: "user" });
    expect(value(ws, P1, "SCHEDSTART")).toBe("2026-10-01T08:00:00");
    const added = ws.addRows("wo", [{ WONUM: "W9", REPORTDATE: "2026/10/02 7:00" }], { author: "llm" });
    expect(added.conflicts).toEqual([]);
    expect(value(ws, makeParentKey(["W9"]), "REPORTDATE")).toBe("2026-10-02T07:00:00-05:00");
  });
});

// ---------------------------------------------------------------------------
// スキーマの hasList
// ---------------------------------------------------------------------------

describe("jsonschemas の hasList", () => {
  it("hasList:true の属性だけ ColumnSchema.hasList を立てる（子の属性も）", () => {
    const info = parseJsonSchema("MXAPIWO", {
      properties: {
        status: { type: "string", maxLength: 16, hasList: true, title: "Status" },
        description: { type: "string", maxLength: 100 },
        wpmaterial: { type: "array", items: { type: "object", properties: { itemnum: { type: "string", hasList: "true" }, wpitemid: { type: "integer" } } } },
      },
    });
    const byName = new Map(info.columns.map((c) => [c.name, c]));
    expect(byName.get("STATUS")?.hasList).toBe(true);
    expect(byName.get("DESCRIPTION")?.hasList).toBeUndefined();
    expect(byName.get("WPMATERIAL.ITEMNUM")?.hasList).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Maximo の getlist
// ---------------------------------------------------------------------------

function connect() {
  const fake = createFakeMaximo(sampleSeed());
  const client = new MaximoClient({ baseUrl: fake.baseUrl, apiKey: () => fake.apiKey, via: "direct", fetchImpl: fake.fetch, sleep: async () => {} });
  const conn: MaximoConnection = { info: { baseUrl: fake.baseUrl, via: "direct", connectionName: "t", userName: "MAXADMIN", connectedAt: 0 }, client };
  let current: MaximoConnection | null = conn;
  const connection = { current: () => current, subscribe: () => () => undefined, set: (on: boolean) => void (current = on ? conn : null) };
  const listGets = () => fake.state.requests.filter((r) => r.path.includes("getlist~"));
  return { fake, client, connection, listGets };
}

describe("getlist（maximo/valueList.ts）", () => {
  it("member の value / 属性名の値 / description を一覧にする（重複は 1 つ）", () => {
    expect(
      parseValueList(
        {
          member: [
            { value: "APPR", description: "Approved", maxvalue: "APPR" },
            { value: "APPR", description: "dup" },
            { location: "BR300", description: "Boiler room", href: "x" },
            { _rowstamp: "1", siteid: "BEDFORD" },
            "junk",
          ],
        },
        "LOCATION",
      ),
    ).toEqual([{ value: "APPR", description: "Approved" }, { value: "BR300", description: "Boiler room" }, { value: "BEDFORD" }]);
    expect(parseValueList(null, "X")).toEqual([]);
  });

  it("行の href に getlist~<属性> を付けて取り、nextPage をたどる。子の列は子の href に付ける", async () => {
    const { fake, client, listGets } = connect();
    const href = fake.hrefOf("MXAPIWO", fake.records("MXAPIWO")[0]!.uid);
    const items = await fetchValueList(client, href, "STATUS");
    expect(items.map((i) => i.value)).toEqual(["WAPPR", "APPR", "INPRG", "COMP", "CLOSE", "CAN"]);
    expect(items[0]).toEqual({ value: "WAPPR", description: "承認待ち" });
    expect(listGets()[0]!.path).toMatch(/^\/maximo\/api\/os\/mxapiwo\/_R1\/getlist~status\?lean=1&oslc\.pageSize=\d+$/);
    // 上限で打ち切る
    const few = await fetchValueList(client, href, "STATUS", { maxItems: 3 });
    expect(few).toHaveLength(3);
    // nextPage をたどる（2 件ずつ 3 ページ）
    const before = listGets().length;
    const paged = await fetchValueList(client, href, "STATUS", { pageSize: 2 });
    expect(paged.map((i) => i.value)).toEqual(items.map((i) => i.value));
    expect(listGets().length - before).toBe(3);
    const childId = fake.records("MXAPIWO")[0]!.children.ext_wopermit![0]!.attrs.ext_wopermitid;
    const child = await fetchValueList(client, `${href}/ext_wopermit/${String(childId)}`, "EXT_PERMITTYPE");
    expect(child.map((i) => i.value)).toEqual(["届出", "許可"]);
    await expect(fetchValueList(client, href, "DESCRIPTION")).rejects.toThrow();
    await expect(fetchValueList(client, href, "a b")).rejects.toThrow();
  });

  it("ValueListService は (接続先, 構造, 列) ごとに覚え、同時の要求を 1 回にまとめ、失敗は none として覚える", async () => {
    const { fake, connection, listGets } = connect();
    const service = new ValueListService({ connection });
    const href = fake.hrefOf("MXAPIWO", fake.records("MXAPIWO")[0]!.uid);
    const target = { os: "MXAPIWO", col: "STATUS", href, attr: "STATUS" };
    expect(service.peek("MXAPIWO", "STATUS")).toBeUndefined();
    const [a, b] = await Promise.all([service.load(target), service.load({ ...target, href: fake.hrefOf("MXAPIWO", "_R2") })]);
    expect(a).toEqual(b);
    expect(a.status).toBe("ready");
    expect(listGets()).toHaveLength(1);
    expect(service.peek("MXAPIWO", "STATUS")?.status).toBe("ready");
    await service.load(target);
    expect(listGets()).toHaveLength(1);

    const none = await service.load({ os: "MXAPIWO", col: "DESCRIPTION", href, attr: "DESCRIPTION" });
    expect(none).toEqual({ status: "none" });
    await service.load({ os: "MXAPIWO", col: "DESCRIPTION", href, attr: "DESCRIPTION" });
    expect(listGets()).toHaveLength(2);

    // 別の接続先で読み込んだシートの列・未接続では取りに行かない
    expect(await service.load({ ...target, col: "X", baseUrl: "https://other.example.com" })).toEqual({ status: "none" });
    connection.set(false);
    expect(await service.load({ ...target, col: "Y" })).toEqual({ status: "none" });
    expect(service.peek("MXAPIWO", "STATUS")).toBeUndefined();
    expect(listGets()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// どの列で一覧を出すか（grid/valueLists.ts）
// ---------------------------------------------------------------------------

describe("一覧の出どころ（grid/valueLists.ts）", () => {
  const CH = "EXT_WOPERMIT";
  const P1 = makeParentKey(["BEDFORD", "WO1"]);
  const C1 = makeChildRowKey(P1, CH, 11);
  const columns: ColumnSchema[] = [
    { name: "SITEID", type: "string", maxLength: 8 },
    { name: "WONUM", type: "string", maxLength: 12 },
    { name: "STATUS", type: "string", maxLength: 16, hasList: true },
    { name: "ASSETNUM", type: "string", maxLength: 25 },
    { name: "DESCRIPTION", type: "string", maxLength: 100 },
    { name: `${CH}.EXT_PERMITTYPE`, type: "string", maxLength: 40, child: CH, hasList: true },
  ];
  const records: MaximoRecord[] = [
    {
      href: "https://mx.example.com/maximo/api/os/mxapiwo/_A",
      rowstamp: "1",
      attrs: { SITEID: "BEDFORD", WONUM: "WO1", STATUS: "WAPPR", ASSETNUM: "P-1" },
      children: { [CH]: [{ idAttr: "EXT_WOPERMITID", id: 11, rowstamp: "2", attrs: { EXT_WOPERMITID: 11 }, href: "https://mx.example.com/maximo/api/os/mxapiwo/_A/ext_wopermit/11" }] },
    },
  ];
  function setup(): Workspace {
    const ws = new Workspace("t");
    ws.createSheet(
      { name: "wo", source: { kind: "maximo", os: "MXAPIWO", select: ["*"], where: [], baseUrl: "https://mx.example.com" }, columns, keyColumns: ["SITEID", "WONUM"], childIdAttrs: { [CH]: "EXT_WOPERMITID" } },
      [{ rowKey: C1, parentKey: P1, childName: CH, values: { SITEID: "BEDFORD", WONUM: "WO1", STATUS: "WAPPR", ASSETNUM: "P-1", DESCRIPTION: "x", [`${CH}.EXT_PERMITTYPE`]: "届出" } }],
      records,
    );
    const assetCols: ColumnSchema[] = [
      { name: "ASSETNUM", type: "string" },
      { name: "DESCRIPTION", type: "string" },
    ];
    const ak = (n: string) => makeParentKey([n]);
    ws.createSheet(
      { name: "assets", source: { kind: "maximo", os: "MXASSET", select: ["*"], where: [] }, columns: assetCols, keyColumns: ["ASSETNUM"], childIdAttrs: {}, link: { sheet: "wo", from: "ASSETNUM", to: "ASSETNUM" } },
      ["P-2", "P-1", "P-2"].map((n, i) => ({ rowKey: ak(`${n}-${i}`), parentKey: ak(`${n}-${i}`), childName: null, values: { ASSETNUM: n, DESCRIPTION: `pump ${n}` } })),
    );
    return ws;
  }

  it("引いて読み込んだマスタのシートの突合列の値を、説明を添えて重複なく並べる", () => {
    const ws = setup();
    expect(masterListFor(ws, "wo", "ASSETNUM")).toEqual({
      sheet: "assets",
      items: [
        { value: "P-1", description: "pump P-1" },
        { value: "P-2", description: "pump P-2" },
      ],
    });
    expect(masterListFor(ws, "wo", "STATUS")).toBeNull();
    expect(masterListFor(ws, "assets", "ASSETNUM")).toBeNull();
  });

  it("Maximo の一覧はスキーマの印（hasList）で決め、印が無いスキーマでは短い文字列の列だけ試す", () => {
    const col = (n: string) => columns.find((c) => c.name === n)!;
    expect(mayHaveMaximoList(col("STATUS"), columns)).toBe(true);
    expect(mayHaveMaximoList(col("ASSETNUM"), columns)).toBe(false);
    const noFlags = columns.map(({ hasList: _, ...c }) => c);
    expect(mayHaveMaximoList(noFlags.find((c) => c.name === "ASSETNUM")!, noFlags)).toBe(true);
    expect(mayHaveMaximoList(noFlags.find((c) => c.name === "DESCRIPTION")!, noFlags)).toBe(false);
    expect(mayHaveMaximoList({ name: "D", type: "date", hasList: true }, columns)).toBe(false);
  });

  it("getlist を付けるのは行の href（子の列は子の href）。追加した行は同じシートの別の行の href を使う", () => {
    const ws = setup();
    const sheet = ws.getSheet("wo");
    const row = sheet.row(C1)!;
    expect(maximoListTarget(sheet, row, columns[2]!)).toEqual({ os: "MXAPIWO", col: "STATUS", href: records[0]!.href, attr: "STATUS", baseUrl: "https://mx.example.com" });
    expect(maximoListTarget(sheet, row, columns[5]!)).toMatchObject({ col: `${CH}.EXT_PERMITTYPE`, href: `${records[0]!.href}/ext_wopermit/11`, attr: "EXT_PERMITTYPE" });
    expect(maximoListTarget(sheet, null, columns[2]!)?.href).toBe(records[0]!.href);
    expect(maximoListTarget(ws.getSheet("assets"), null, { name: "ASSETNUM", type: "string" })).toBeNull();
  });

  it("候補の絞り込みと、一覧にある値かの判定（大文字小文字・全角半角は問わない）", () => {
    const items = [{ value: "APPR", description: "承認済み" }, { value: "WAPPR", description: "承認待ち" }, { value: "COMP", description: "完了" }];
    expect(filterItems(items, "appr").map((i) => i.value)).toEqual(["APPR", "WAPPR"]);
    expect(filterItems(items, "完了").map((i) => i.value)).toEqual(["COMP"]);
    expect(filterItems(items, "ＣＯＭＰ").map((i) => i.value)).toEqual(["COMP"]);
    expect(filterItems(items, "")).toBe(items);
    expect(isInList(items, "appr")).toBe(true);
    expect(isInList(items, "")).toBe(true);
    expect(isInList(items, "APP")).toBe(false);
  });
});

describe("偽の Maximo の値の一覧（開発・試験用）", () => {
  it("jsonschemas に hasList を出し、読み込んだ列に印が付く", async () => {
    const { client } = connect();
    const info = await getObjectStructureInfo(client, "MXAPIWO");
    expect(info.columns.find((c) => c.name === "STATUS")?.hasList).toBe(true);
    expect(info.columns.find((c) => c.name === "EXT_WOPERMIT.EXT_PERMITTYPE")?.hasList).toBe(true);
    expect(info.columns.find((c) => c.name === "DESCRIPTION")?.hasList).toBeUndefined();
  });
});
