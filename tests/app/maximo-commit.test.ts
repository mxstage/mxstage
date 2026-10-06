import fc, { type Arbitrary } from "fast-check";
import { describe, expect, it } from "vitest";
import { MaximoClient, type FetchLike } from "../../src/app/maximo/client";
import {
  assertSafePatchRequest,
  buildPatchRequest,
  COMMIT_LIMITS,
  CommitInvariantError,
  executeCommit,
  planCommit,
  validatePlans,
  writeLogEntry,
  type CommitChanges,
  type CommitPlan,
  type CommitRowOutcome,
  type ExecuteCommitOptions,
  type PatchRequest,
} from "../../src/app/maximo/commit";
import { loadRecords } from "../../src/app/maximo/load";
import { getObjectStructureInfo } from "../../src/app/maximo/meta";
import type { CellValue, ColumnSchema } from "../../src/shared/model";
import { makeChildRowKey, makeParentKey, type MaximoRecord, type ParentCommitPlan, type SheetMeta } from "../../src/shared/sheet";
import { createFakeMaximo, sampleSeed, type FakeMaximo, type FakeRecord, type FakeRecordSeed } from "../fakes/fake-maximo";

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

const SELECT = [
  "DESCRIPTION",
  "STATUS",
  "ESTDUR",
  "CHANGEBY",
  "MULTIASSETLOCCI.MULTIID",
  "MULTIASSETLOCCI.ASSETNUM",
  "MULTIASSETLOCCI.LOCATION",
  "MULTIASSETLOCCI.ISPRIMARY",
  "MULTIASSETLOCCI.SEQUENCE",
];

interface Setup {
  fake: FakeMaximo;
  client: MaximoClient;
  meta: SheetMeta;
  records: MaximoRecord[];
}

async function setup(opts: { woRecords?: FakeRecordSeed[]; via?: "proxy" | "direct"; select?: string[]; fetchWrap?: (f: FetchLike) => FetchLike } = {}): Promise<Setup> {
  const fake = createFakeMaximo(sampleSeed(opts.woRecords ? { woRecords: opts.woRecords } : {}));
  const base: FetchLike = fake.fetch;
  const client = new MaximoClient({
    baseUrl: fake.baseUrl,
    apiKey: () => fake.apiKey,
    via: opts.via ?? "direct",
    fetchImpl: opts.fetchWrap ? opts.fetchWrap(base) : base,
    sleep: async () => {},
  });
  const info = await getObjectStructureInfo(client, "MXAPIWO");
  const select = opts.select ?? SELECT;
  const knownAttrs = new Set(info.columns.map((c) => c.name));
  const { records } = await loadRecords(client, { os: "MXAPIWO", select, keyColumns: info.keyColumns, childIdAttrs: info.childIdAttrs, knownAttrs });
  const names = new Set([...info.keyColumns, ...select]);
  const meta: SheetMeta = {
    name: "wo",
    source: { kind: "maximo", os: "MXAPIWO", select, where: [] },
    columns: info.columns.filter((c) => names.has(c.name)),
    keyColumns: info.keyColumns,
    childIdAttrs: info.childIdAttrs,
  };
  fake.state.requests.length = 0;
  return { fake, client, meta, records };
}

const pk = (wonum: string, site = "BEDFORD") => makeParentKey([site, wonum]);
const ck = (wonum: string, kind: string, id: CellValue) => makeChildRowKey(pk(wonum), kind, id);
const none = (): CommitChanges => ({ cells: [], addedRows: [], deletedRows: [] });
const woOf = (fake: FakeMaximo, wonum: string) => fake.find("mxapiwo", (r) => r.attrs.wonum === wonum)!;
const posts = (fake: FakeMaximo) => fake.state.requests.filter((r) => r.method === "POST");
const txIds = (_plan: ParentCommitPlan, i: number) => `tx-${i}`;

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (e) {
    if (e instanceof CommitInvariantError) return e.code;
    throw e;
  }
  return null;
}

/** WO1001 の説明・子 1002 の場所を変え、子 1003 を削除し、子を 1 件追加する。WO1002 の状態を変える */
function typicalChanges(): CommitChanges {
  return {
    cells: [
      { rowKey: ck("WO1001", "MULTIASSETLOCCI", 1002), col: "DESCRIPTION", value: "ポンプ点検（再）" },
      { rowKey: ck("WO1001", "MULTIASSETLOCCI", 1002), col: "MULTIASSETLOCCI.LOCATION", value: "L9" },
      // 値が変わらないセルは送らない
      { rowKey: ck("WO1001", "MULTIASSETLOCCI", 1002), col: "MULTIASSETLOCCI.ASSETNUM", value: "P-101" },
      { rowKey: ck("WO1002", "MULTIASSETLOCCI", 1005), col: "STATUS", value: "INPRG" },
    ],
    addedRows: [
      {
        rowKey: ck("WO1001", "MULTIASSETLOCCI", "new~1"),
        parentKey: pk("WO1001"),
        childName: "MULTIASSETLOCCI",
        values: {
          SITEID: "BEDFORD",
          WONUM: "WO1001",
          "MULTIASSETLOCCI.MULTIID": null,
          "MULTIASSETLOCCI.ASSETNUM": "P-900",
          "MULTIASSETLOCCI.LOCATION": "L1",
          "MULTIASSETLOCCI.ISPRIMARY": false,
          "MULTIASSETLOCCI.SEQUENCE": 4,
        },
      },
    ],
    deletedRows: [ck("WO1001", "MULTIASSETLOCCI", 1003)],
  };
}

async function run(s: Setup, plans: CommitPlan[], opts: Partial<ExecuteCommitOptions> & { canary?: boolean | "throw" } = {}) {
  const canaryCalls: CommitRowOutcome[] = [];
  const rows: CommitRowOutcome[] = [];
  const { canary = true, ...rest } = opts;
  const results = await executeCommit(s.client, plans, {
    waitForCanaryContinue: async (r) => {
      canaryCalls.push(r);
      if (canary === "throw") throw new Error("closed");
      return canary;
    },
    onRow: (r) => rows.push(r),
    meta: s.meta,
    makeTransactionId: txIds,
    ...rest,
  });
  return { results, canaryCalls, rows };
}

// ---------------------------------------------------------------------------
// planCommit
// ---------------------------------------------------------------------------

describe("planCommit", () => {
  it("セル変更・削除・追加を親 1 件の計画にまとめる（変わらない値は送らない）", async () => {
    const { meta, records } = await setup();
    const plans = planCommit(meta, records, typicalChanges());
    const wo1 = records[0]!;
    const kids = wo1.children.MULTIASSETLOCCI!;
    expect(plans).toEqual([
      {
        parentKey: pk("WO1001"),
        href: wo1.href,
        expectedRowstamp: wo1.rowstamp,
        expectedChildIds: { MULTIASSETLOCCI: [1001, 1002, 1003] },
        expectedChildRowstamps: { MULTIASSETLOCCI: { "1002": kids[1]!.rowstamp, "1003": kids[2]!.rowstamp } },
        attrs: { DESCRIPTION: "ポンプ点検（再）" },
        children: {
          MULTIASSETLOCCI: [
            { action: "Change", idAttr: "MULTIID", id: 1002, attrs: { LOCATION: "L9" } },
            { action: "Delete", idAttr: "MULTIID", id: 1003 },
            { action: "Add", attrs: { ASSETNUM: "P-900", LOCATION: "L1", ISPRIMARY: false, SEQUENCE: 4 } },
          ],
        },
      },
      {
        parentKey: pk("WO1002"),
        href: records[1]!.href,
        expectedRowstamp: records[1]!.rowstamp,
        expectedChildIds: {},
        expectedChildRowstamps: {},
        // ステータスは属性として送らず、更新の後に changeStatus で変える
        attrs: {},
        children: {},
        status: { to: "INPRG", from: "APPR" },
      },
    ]);
  });

  it("変更が無ければ計画は空。削除する行へのセル変更と、追加して削除した行は送らない", async () => {
    const { meta, records } = await setup();
    expect(planCommit(meta, records, none())).toEqual([]);
    expect(planCommit(meta, records, { ...none(), cells: [{ rowKey: pk("WO1003"), col: "STATUS", value: "COMP" }] })).toEqual([]);

    const added = typicalChanges().addedRows[0]!;
    const plans = planCommit(meta, records, {
      cells: [
        { rowKey: ck("WO1001", "MULTIASSETLOCCI", 1003), col: "MULTIASSETLOCCI.LOCATION", value: "LX" },
        { rowKey: added.rowKey, col: "MULTIASSETLOCCI.LOCATION", value: "L7" },
      ],
      addedRows: [added],
      deletedRows: [ck("WO1001", "MULTIASSETLOCCI", 1003), added.rowKey],
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.children).toEqual({ MULTIASSETLOCCI: [{ action: "Delete", idAttr: "MULTIID", id: 1003 }] });
  });

  it("追加行へのセル変更は追加する属性に重ねる", async () => {
    const { meta, records } = await setup();
    const added = typicalChanges().addedRows[0]!;
    const plans = planCommit(meta, records, { cells: [{ rowKey: added.rowKey, col: "MULTIASSETLOCCI.LOCATION", value: "L7" }], addedRows: [added], deletedRows: [] });
    expect(plans[0]!.children.MULTIASSETLOCCI).toEqual([{ action: "Add", attrs: { ASSETNUM: "P-900", LOCATION: "L7", ISPRIMARY: false, SEQUENCE: 4 } }]);
  });

  it("I2: 読み込み時の子に無い ID・ID 不明の子・読み込んでいない種類の子は変更も削除もできない", async () => {
    const { meta, records } = await setup();
    const cell = (rowKey: string, col: string, value: CellValue) => ({ ...none(), cells: [{ rowKey, col, value }] });
    expect(codeOf(() => planCommit(meta, records, cell(ck("WO1001", "MULTIASSETLOCCI", 9999), "MULTIASSETLOCCI.LOCATION", "L1")))).toBe("I2");
    expect(codeOf(() => planCommit(meta, records, { ...none(), deletedRows: [ck("WO1001", "MULTIASSETLOCCI", 9999)] }))).toBe("I2");
    expect(codeOf(() => planCommit(meta, records, { ...none(), deletedRows: [ck("WO1001", "MULTIASSETLOCCI", "idx~0")] }))).toBe("I2");
    expect(codeOf(() => planCommit(meta, records, { ...none(), deletedRows: [ck("WO1001", "EXT_WOPERMIT", 1004)] }))).toBe("I2");
    // 子 1005 は WO1002 の子。WO1001 の子としては扱わない
    expect(codeOf(() => planCommit(meta, records, cell(ck("WO1001", "MULTIASSETLOCCI", 1005), "MULTIASSETLOCCI.LOCATION", "L1")))).toBe("I2");
    // ID を持たない子（idAttr null）は ID があっても変更できない
    const noId = structuredClone(records);
    for (const c of noId[0]!.children.MULTIASSETLOCCI!) c.idAttr = null;
    expect(codeOf(() => planCommit(meta, noId, cell(ck("WO1001", "MULTIASSETLOCCI", 1002), "MULTIASSETLOCCI.LOCATION", "L1")))).toBe("I2");
  });

  describe("I3: 削除件数の上限", () => {
    const bigMeta: SheetMeta = {
      name: "big",
      source: { kind: "maximo", os: "MXAPIWO", select: [], where: [] },
      columns: [
        { name: "SITEID", type: "string" },
        { name: "WONUM", type: "string" },
        { name: "DESCRIPTION", type: "string" },
        { name: "MULTIASSETLOCCI.ASSETNUM", type: "string", child: "MULTIASSETLOCCI" },
      ],
      keyColumns: ["SITEID", "WONUM"],
      childIdAttrs: { MULTIASSETLOCCI: "MULTIID" },
    };
    const bigRecords = (parents: number, children: number): MaximoRecord[] =>
      Array.from({ length: parents }, (_, i) => ({
        href: `https://maximo.test/maximo/api/os/mxapiwo/_P${i}`,
        rowstamp: "1",
        attrs: { SITEID: "BEDFORD", WONUM: `W${i}`, DESCRIPTION: "d" },
        children: {
          MULTIASSETLOCCI: Array.from({ length: children }, (_, j) => ({ idAttr: "MULTIID", id: i * 100 + j, rowstamp: "1", attrs: { MULTIID: i * 100 + j, ASSETNUM: `A${j}` } })),
        },
      }));
    const deletes = (parents: number, perParent: number) =>
      Array.from({ length: parents }, (_, i) => Array.from({ length: perParent }, (_, j) => makeChildRowKey(makeParentKey(["BEDFORD", `W${i}`]), "MULTIASSETLOCCI", i * 100 + j))).flat();

    it(`親あたり ${COMMIT_LIMITS.maxDeletesPerParent} 件を超えたら確認が必要`, () => {
      const records = bigRecords(1, 12);
      expect(codeOf(() => planCommit(bigMeta, records, { ...none(), deletedRows: deletes(1, 11) }))).toBe("I3");
      expect(planCommit(bigMeta, records, { ...none(), deletedRows: deletes(1, 10) })[0]!.children.MULTIASSETLOCCI).toHaveLength(10);
      expect(planCommit(bigMeta, records, { ...none(), deletedRows: deletes(1, 11) }, { deletesConfirmed: true })[0]!.children.MULTIASSETLOCCI).toHaveLength(11);
    });

    it(`全体で ${COMMIT_LIMITS.maxDeletesTotal} 件を超えたら確認が必要`, () => {
      expect(codeOf(() => planCommit(bigMeta, bigRecords(6, 9), { ...none(), deletedRows: deletes(6, 9) }))).toBe("I3");
      expect(planCommit(bigMeta, bigRecords(5, 10), { ...none(), deletedRows: deletes(5, 10) })).toHaveLength(5);
      expect(planCommit(bigMeta, bigRecords(6, 9), { ...none(), deletedRows: deletes(6, 9) }, { deletesConfirmed: true })).toHaveLength(6);
    });

    it(`I8: 1 計画は ${COMMIT_LIMITS.maxParentsPerPlan} 親まで`, () => {
      const cells = (n: number) => Array.from({ length: n }, (_, i) => ({ rowKey: makeParentKey(["BEDFORD", `W${i}`]), col: "DESCRIPTION", value: "x" }));
      expect(planCommit(bigMeta, bigRecords(200, 0), { ...none(), cells: cells(200) })).toHaveLength(200);
      expect(codeOf(() => planCommit(bigMeta, bigRecords(201, 0), { ...none(), cells: cells(201) }))).toBe("I8");
    });
  });

  it("I4: 追加する子に ID を付けない", async () => {
    const { meta, records } = await setup();
    const add = typicalChanges().addedRows[0]!;
    const withId = { ...add, values: { ...add.values, "MULTIASSETLOCCI.MULTIID": 5555 } };
    expect(codeOf(() => planCommit(meta, records, { ...none(), addedRows: [withId] }))).toBe("I4");
  });

  it("I5: キー列・readOnly・子の ID 属性・シートに無い列は送らない", async () => {
    const { meta, records } = await setup();
    const cell = (rowKey: string, col: string, value: CellValue) => ({ ...none(), cells: [{ rowKey, col, value }] });
    expect(codeOf(() => planCommit(meta, records, cell(pk("WO1003"), "WONUM", "WO9999")))).toBe("I5");
    expect(codeOf(() => planCommit(meta, records, cell(pk("WO1003"), "CHANGEBY", "ME")))).toBe("I5");
    expect(codeOf(() => planCommit(meta, records, cell(ck("WO1001", "MULTIASSETLOCCI", 1002), "MULTIASSETLOCCI.MULTIID", 7)))).toBe("I5");
    expect(codeOf(() => planCommit(meta, records, cell(pk("WO1003"), "WOPRIORITY", 1)))).toBe("I5");
    const ro: SheetMeta = { ...meta, columns: meta.columns.map((c) => (c.name === "MULTIASSETLOCCI.LOCATION" ? { ...c, readOnly: true } : c)) };
    expect(codeOf(() => planCommit(ro, records, cell(ck("WO1001", "MULTIASSETLOCCI", 1002), "MULTIASSETLOCCI.LOCATION", "L1")))).toBe("I5");
    const add = typicalChanges().addedRows[0]!;
    expect(codeOf(() => planCommit(ro, records, { ...none(), addedRows: [add] }))).toBe("I5");
  });

  it("I6: 送る属性の無い追加行は拒否する", async () => {
    const { meta, records } = await setup();
    const empty = { rowKey: ck("WO1001", "MULTIASSETLOCCI", "new~1"), parentKey: pk("WO1001"), childName: "MULTIASSETLOCCI", values: { SITEID: "BEDFORD", "MULTIASSETLOCCI.ASSETNUM": null, "MULTIASSETLOCCI.LOCATION": "" } };
    expect(codeOf(() => planCommit(meta, records, { ...none(), addedRows: [empty] }))).toBe("I6");
  });

  it("I7: href は読み込み時のものだけ。クエリ付きや URL でない href は拒否する", async () => {
    const { meta, records } = await setup();
    const change = { ...none(), cells: [{ rowKey: pk("WO1003"), col: "DESCRIPTION", value: "塗装（完了報告済み）" }] };
    for (const href of ["", "https://maximo.test/maximo/api/os/mxapiwo/_A?lean=1", "javascript:alert(1)"]) {
      const bad = records.map((r) => (r.attrs.WONUM === "WO1003" ? { ...r, href } : r));
      // href が空だと親キーは列から作るので、ここでは I7 で止まる
      expect(codeOf(() => planCommit(meta, bad, change))).toBe("I7");
    }
  });

  it("I7: 構造を渡すと、送信先はその構造のレコードだけ（シートを読み込んだ構造とは別の構造へ送らない）", async () => {
    const s = await setup();
    const change = { ...none(), cells: [{ rowKey: pk("WO1003"), col: "DESCRIPTION", value: "塗装（完了報告済み）" }] };
    const plans = planCommit(s.meta, s.records, change);
    const before = s.fake.writeCount();
    await expect(run(s, plans, { os: "MXAPIASSET" })).rejects.toMatchObject({ code: "I7" });
    await expect(run(s, plans, { os: "MX/../APIWO" })).rejects.toMatchObject({ code: "I7" });
    // 1 件も送っていない
    expect(s.fake.writeCount()).toBe(before);
    const ok = await run(s, plans, { os: "mxapiwo" });
    expect(ok.results[0]!.status).toBe("verified");
  });

  it("I10: 空（null・空文字）への変更は allowNull が無ければ拒否する", async () => {
    const { meta, records } = await setup();
    const toEmpty = (v: CellValue) => ({ ...none(), cells: [{ rowKey: pk("WO1003"), col: "DESCRIPTION", value: v }] });
    expect(codeOf(() => planCommit(meta, records, toEmpty(null)))).toBe("I10");
    expect(codeOf(() => planCommit(meta, records, toEmpty("")))).toBe("I10");
    expect(planCommit(meta, records, toEmpty(null), { allowNull: true })[0]!.attrs).toEqual({ DESCRIPTION: null });
    const childToNull = { ...none(), cells: [{ rowKey: ck("WO1001", "MULTIASSETLOCCI", 1002), col: "MULTIASSETLOCCI.LOCATION", value: null }] };
    expect(codeOf(() => planCommit(meta, records, childToNull))).toBe("I10");
    expect(planCommit(meta, records, childToNull, { allowNull: true })[0]!.children.MULTIASSETLOCCI).toEqual([{ action: "Change", idAttr: "MULTIID", id: 1002, attrs: { LOCATION: null } }]);
  });

  it("入力の矛盾（親の追加・親の削除・不明な親・同じ親の列に異なる値・子の列を別の行で変更）は止める", async () => {
    const { meta, records } = await setup();
    const input = (c: Partial<CommitChanges>) => codeOf(() => planCommit(meta, records, { ...none(), ...c }));
    expect(input({ addedRows: [{ rowKey: pk("WO9"), parentKey: pk("WO9"), childName: null, values: { WONUM: "WO9" } }] })).toBe("INPUT");
    expect(input({ deletedRows: [pk("WO1003")] })).toBe("INPUT");
    expect(input({ cells: [{ rowKey: pk("WO9"), col: "STATUS", value: "X" }] })).toBe("INPUT");
    expect(
      input({
        cells: [
          { rowKey: ck("WO1001", "MULTIASSETLOCCI", 1001), col: "STATUS", value: "APPR" },
          { rowKey: ck("WO1001", "MULTIASSETLOCCI", 1002), col: "STATUS", value: "INPRG" },
        ],
      }),
    ).toBe("INPUT");
    expect(input({ cells: [{ rowKey: pk("WO1003"), col: "MULTIASSETLOCCI.LOCATION", value: "L1" }] })).toBe("INPUT");
    expect(input({ cells: [{ rowKey: ck("WO1001", "MULTIASSETLOCCI", "new~3"), col: "MULTIASSETLOCCI.LOCATION", value: "L1" }] })).toBe("INPUT");
    const add = typicalChanges().addedRows[0]!;
    expect(input({ addedRows: [{ ...add, values: { ...add.values, WONUM: "WO1002" } }] })).toBe("INPUT");
    expect(input({ addedRows: [{ ...add, parentKey: pk("WO1002") }] })).toBe("INPUT");
  });

  it("追加行の行キーは新規の子（new~N）で、種類が一致し、重複しないものに限る（既存の子の削除が黙って捨てられないように）", async () => {
    const { meta, records } = await setup();
    const input = (c: Partial<CommitChanges>) => codeOf(() => planCommit(meta, records, { ...none(), ...c }));
    const add = typicalChanges().addedRows[0]!;
    const existing = ck("WO1001", "MULTIASSETLOCCI", 1003);
    // 既存の子の行キーを追加行に使い、同じ行キーを削除に入れても、削除を「追加の取り消し」として捨てない
    expect(input({ addedRows: [{ ...add, rowKey: existing }], deletedRows: [existing] })).toBe("INPUT");
    expect(input({ addedRows: [{ ...add, rowKey: ck("WO1001", "EXT_WOPERMIT", "new~1") }] })).toBe("INPUT");
    expect(input({ addedRows: [add, add] })).toBe("INPUT");
  });
});

// ---------------------------------------------------------------------------
// validatePlans / buildPatchRequest
// ---------------------------------------------------------------------------

describe("validatePlans（送信前の再検査）", () => {
  const basePlan = (over: Partial<ParentCommitPlan> = {}): ParentCommitPlan => ({
    parentKey: "p",
    href: "https://maximo.test/maximo/api/os/mxapiwo/_A",
    expectedRowstamp: "1",
    expectedChildIds: { MULTIASSETLOCCI: [11, 12] },
    attrs: {},
    children: {},
    ...over,
  });
  const vopts = { allowNull: false, deletesConfirmed: false, childIdAttrs: { multiassetlocci: "MULTIID" } };
  const check = (plan: ParentCommitPlan, extra: Partial<typeof vopts & { columns: ColumnSchema[]; keyColumns: string[] }> = {}) => codeOf(() => validatePlans([plan], { ...vopts, ...extra }));

  it("計画の不変条件を個別に検査する", () => {
    expect(check(basePlan({ attrs: { DESCRIPTION: "x" } }))).toBeNull();
    expect(check(basePlan({ children: { MULTIASSETLOCCI: [{ action: "Change", idAttr: "MULTIID", id: 99, attrs: { LOCATION: "L" } }] } }))).toBe("I2");
    expect(check(basePlan({ children: { MULTIASSETLOCCI: [{ action: "Delete", idAttr: "OTHERID", id: 11 }] } }))).toBe("I2");
    expect(check(basePlan({ children: { MULTIASSETLOCCI: [{ action: "Delete", idAttr: "MULTIID", id: null }] } }))).toBe("I2");
    expect(check(basePlan({ children: { MULTIASSETLOCCI: [{ action: "Add", attrs: { MULTIID: 5, ASSETNUM: "A" } }] } }))).toBe("I4");
    expect(check(basePlan({ children: { MULTIASSETLOCCI: [] } }))).toBe("I6");
    expect(check(basePlan({ children: { MULTIASSETLOCCI: [{ action: "Change", idAttr: "MULTIID", id: 11, attrs: {} }] } }))).toBe("I6");
    expect(check(basePlan({ href: "" }))).toBe("I7");
    expect(check(basePlan({ href: "https://maximo.test/maximo/api/os/mxapiwo/_A?x=1" }))).toBe("I7");
    expect(check(basePlan({ attrs: { _rowstamp: "2" } }))).toBe("I5");
    expect(check(basePlan({ attrs: { "bad name": 1 } }))).toBe("I5");
    expect(check(basePlan({ attrs: { DESCRIPTION: "" } }))).toBe("I10");
    expect(check(basePlan({ attrs: { DESCRIPTION: "" } }), { allowNull: true })).toBeNull();
    expect(check(basePlan({ children: { MULTIASSETLOCCI: [{ action: "Add", attrs: { ASSETNUM: null } }] } }), { allowNull: true })).toBe("I10");
    expect(codeOf(() => validatePlans([basePlan(), basePlan()], vopts))).toBe("INPUT");
    expect(codeOf(() => validatePlans(Array.from({ length: 201 }, (_, i) => basePlan({ parentKey: `p${i}` })), vopts))).toBe("I8");
  });

  it("列定義を渡すと readOnly・キー列・シートに無い列も拒否する（I5）", () => {
    const columns: ColumnSchema[] = [
      { name: "WONUM", type: "string" },
      { name: "DESCRIPTION", type: "string" },
      { name: "CHANGEBY", type: "string", readOnly: true },
      { name: "MULTIASSETLOCCI.LOCATION", type: "string", child: "MULTIASSETLOCCI" },
      { name: "MULTIASSETLOCCI.ASSETNUM", type: "string", child: "MULTIASSETLOCCI", readOnly: true },
    ];
    const withCols = { columns, keyColumns: ["WONUM"] };
    expect(check(basePlan({ attrs: { DESCRIPTION: "x" } }), withCols)).toBeNull();
    expect(check(basePlan({ attrs: { CHANGEBY: "x" } }), withCols)).toBe("I5");
    expect(check(basePlan({ attrs: { WONUM: "x" } }), withCols)).toBe("I5");
    // ステータスは属性として送らない（I12）
    expect(check(basePlan({ attrs: { STATUS: "x" } }), withCols)).toBe("I12");
    expect(check(basePlan({ children: { MULTIASSETLOCCI: [{ action: "Change", idAttr: "MULTIID", id: 11, attrs: { ASSETNUM: "A" } }] } }), withCols)).toBe("I5");
    expect(check(basePlan({ children: { MULTIASSETLOCCI: [{ action: "Add", attrs: { LOCATION: "L", SEQUENCE: 1 } }] } }), withCols)).toBe("I5");
  });
});

describe("buildPatchRequest", () => {
  it("POST + x-method-override: PATCH、patchtype: MERGE、属性名は小文字、子は _action 付き（追加は ID なし）", async () => {
    const { meta, records } = await setup();
    const plan = planCommit(meta, records, typicalChanges())[0]!;
    const req = buildPatchRequest(plan, "tx-1");
    expect(req).toEqual({
      url: `${records[0]!.href}?lean=1`,
      method: "POST",
      headers: {
        "x-method-override": "PATCH",
        patchtype: "MERGE",
        transactionid: "tx-1",
        batcherror: "1",
        properties: "*",
        "content-type": "application/json",
      },
      body: {
        description: "ポンプ点検（再）",
        multiassetlocci: [
          { multiid: 1002, location: "L9", _action: "Change" },
          { multiid: 1003, _action: "Delete" },
          { assetnum: "P-900", location: "L1", isprimary: false, sequence: 4 },
        ],
      },
    });
  });

  it("I1: MERGE・PATCH を外した要求、送信先の差し替えは送信前の検査で止める", async () => {
    const { meta, records } = await setup();
    const plan = planCommit(meta, records, typicalChanges())[0]!;
    const req = buildPatchRequest(plan, "tx-1");
    const tamper = (r: object) => r as unknown as PatchRequest;
    expect(codeOf(() => assertSafePatchRequest(tamper({ ...req, headers: { ...req.headers, patchtype: "REPLACE" } }), plan))).toBe("I1");
    const { patchtype: _omit, ...noMerge } = req.headers;
    expect(codeOf(() => assertSafePatchRequest(tamper({ ...req, headers: noMerge }), plan))).toBe("I1");
    expect(codeOf(() => assertSafePatchRequest(tamper({ ...req, headers: { ...req.headers, "x-method-override": "PUT" } }), plan))).toBe("I1");
    expect(codeOf(() => assertSafePatchRequest(tamper({ ...req, url: "https://evil.test/maximo/api/os/mxapiwo/_A?lean=1" }), plan))).toBe("I7");
    expect(codeOf(() => assertSafePatchRequest(tamper({ ...req, body: { ...req.body, multiassetlocci: [] } }), plan))).toBe("I6");
  });

  it("空の子配列・不正な transactionid・親属性と子の名前の衝突は組み立てない", () => {
    const plan: ParentCommitPlan = { parentKey: "p", href: "https://maximo.test/maximo/api/os/x/_A", expectedRowstamp: "1", expectedChildIds: {}, attrs: {}, children: { CHILD: [] } };
    expect(codeOf(() => buildPatchRequest(plan, "tx"))).toBe("I6");
    expect(codeOf(() => buildPatchRequest({ ...plan, children: {} }, "tx 1"))).toBe("INPUT");
    expect(codeOf(() => buildPatchRequest({ ...plan, attrs: { child: "x" }, children: { CHILD: [{ action: "Add", attrs: { A: 1 } }] } }, "tx"))).toBe("INPUT");
  });
});

// ---------------------------------------------------------------------------
// MERGE 無しで子が消える（負の試験。エンジンを使わず fake に直接送る）
// ---------------------------------------------------------------------------

describe("fake Maximo: MERGE の有無", () => {
  const send = (fake: FakeMaximo, wonum: string, headers: Record<string, string>, body: unknown) => {
    const wo = woOf(fake, wonum);
    return fake.fetch(`${fake.hrefOf("mxapiwo", wo.uid)}?lean=1`, {
      method: "POST",
      headers: { apikey: fake.apiKey, "x-method-override": "PATCH", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  };
  const ids = (fake: FakeMaximo, wonum: string) => woOf(fake, wonum).children.multiassetlocci!.map((c) => c.attrs.multiid);

  it("MERGE を付けずに子を 1 件だけ送ると、送らなかった子（主行を含む）が消える", async () => {
    const fake = createFakeMaximo(sampleSeed());
    expect(ids(fake, "WO1001")).toEqual([1001, 1002, 1003]);
    const res = await send(fake, "WO1001", {}, { multiassetlocci: [{ multiid: 1002, location: "L9", _action: "Change" }] });
    expect(res.status).toBeLessThan(300);
    expect(ids(fake, "WO1001")).toEqual([1002]);
  });

  it("MERGE を付けずに空の子配列を送ると子が全部消える（I6 の根拠）", async () => {
    const fake = createFakeMaximo(sampleSeed());
    await send(fake, "WO1001", {}, { multiassetlocci: [] });
    expect(ids(fake, "WO1001")).toEqual([]);
  });

  it("同じ本文でも MERGE を付ければ送らなかった子は残る", async () => {
    const fake = createFakeMaximo(sampleSeed());
    const before = structuredClone(woOf(fake, "WO1001").children.multiassetlocci!);
    const res = await send(fake, "WO1001", { patchtype: "MERGE" }, { multiassetlocci: [{ multiid: 1002, location: "L9", _action: "Change" }] });
    expect(res.status).toBeLessThan(300);
    const after = woOf(fake, "WO1001").children.multiassetlocci!;
    expect(after.map((c) => c.attrs.multiid)).toEqual([1001, 1002, 1003]);
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
    expect(after[1]!.attrs.location).toBe("L9");
  });

  it("apikey が無ければ 401、クエリの apikey は拒否、同じ transactionid は 409", async () => {
    const fake = createFakeMaximo(sampleSeed());
    const href = `${fake.hrefOf("mxapiwo", woOf(fake, "WO1003").uid)}?lean=1`;
    expect((await fake.fetch(href, { method: "GET" })).status).toBe(401);
    expect((await fake.fetch(`${href}&apikey=${fake.apiKey}`, { method: "GET", headers: { apikey: fake.apiKey } })).status).toBe(400);
    const h = { patchtype: "MERGE", transactionid: "t-1" };
    expect((await send(fake, "WO1003", h, { description: "塗装（1 回目）" })).status).toBeLessThan(300);
    const dup = await send(fake, "WO1003", h, { description: "塗装（2 回目）" });
    expect(dup.status).toBe(409);
    expect(woOf(fake, "WO1003").attrs.description).toBe("塗装（1 回目）");
  });
});

// ---------------------------------------------------------------------------
// executeCommit
// ---------------------------------------------------------------------------

describe("executeCommit", () => {
  it("precheck → PATCH+MERGE → verify で verified。カナリアは最初に送った 1 件の後に 1 回だけ待つ", async () => {
    const s = await setup();
    const { fake } = s;
    const before = structuredClone(fake.records("mxapiwo"));
    const plans = planCommit(s.meta, s.records, typicalChanges());
    const { results, canaryCalls, rows } = await run(s, plans);

    expect(results.map((r) => [r.rowKey, r.status, r.sent, r.transactionId])).toEqual([
      [pk("WO1001"), "verified", true, "tx-0"],
      [pk("WO1002"), "verified", true, "tx-1"],
    ]);
    expect(canaryCalls).toEqual([results[0]]);
    expect(rows).toEqual(results);

    const wo1 = woOf(fake, "WO1001");
    const b1 = before.find((r) => r.attrs.wonum === "WO1001")!;
    expect(wo1.attrs).toEqual({ ...b1.attrs, description: "ポンプ点検（再）" });
    const kids = wo1.children.multiassetlocci!;
    expect(kids.map((c) => c.attrs.multiid)).toEqual([1001, 1002, 1006]);
    // 触らない主行は値も _rowstamp も変わらない
    expect(kids[0]).toEqual(b1.children.multiassetlocci![0]);
    expect(kids[1]!.attrs).toEqual({ ...b1.children.multiassetlocci![1]!.attrs, location: "L9" });
    expect(kids[2]!.attrs).toEqual({ multiid: 1006, assetnum: "P-900", location: "L1", isprimary: false, sequence: 4 });
    expect(wo1.children.ext_wopermit).toEqual(b1.children.ext_wopermit);
    expect(woOf(fake, "WO1002").attrs.status).toBe("INPRG");
    expect(woOf(fake, "WO1002").children.multiassetlocci).toEqual(before.find((r) => r.attrs.wonum === "WO1002")!.children.multiassetlocci);
    for (const w of ["WO1003", "WO1004", "WO1005"]) expect(woOf(fake, w)).toEqual(before.find((r) => r.attrs.wonum === w));

    // 送り方: 親ごとに GET（precheck）→ POST → GET（verify）。中身の POST は href + ?lean=1 に MERGE で送る。
    // ステータスだけの変更（WO1002）は、href + ?action=wsmethod:changeStatus に MERGE なしで送る
    expect(fake.state.requests.map((r) => r.method)).toEqual(["GET", "POST", "GET", "GET", "POST", "GET"]);
    const p = posts(fake);
    expect(p[0]!.path).toBe(`${new URL(s.records[0]!.href).pathname}?lean=1`);
    expect(p[0]!.headers.patchtype).toBe("MERGE");
    expect(p[1]!.path).toBe(`${new URL(s.records[1]!.href).pathname}?action=wsmethod:changeStatus&lean=1`);
    expect(p[1]!.headers.patchtype).toBeUndefined();
    expect(p[1]!.body).toMatchObject({ status: "INPRG", memo: "MX Stage" });
    for (const r of p) expect(r.headers["x-method-override"]).toBe("PATCH");
    const pre = new URL(fake.state.requests[0]!.url);
    expect(pre.searchParams.get("oslc.select")).toBe("_rowstamp,description,multiassetlocci{multiid,_rowstamp,location,assetnum,isprimary,sequence}");
    for (const r of fake.state.requests) expect(r.url).not.toContain(fake.apiKey);
  });

  it("別の子オブジェクト（EXT_WOPERMIT の申請完了日）も同じ手順で反映できる", async () => {
    const s = await setup({ select: ["STATUS", "EXT_WOPERMIT.EXT_PERMITDATE", "EXT_WOPERMIT.EXT_AUTHORITY"] });
    const plans = planCommit(s.meta, s.records, { ...none(), cells: [{ rowKey: ck("WO1001", "EXT_WOPERMIT", 1004), col: "EXT_WOPERMIT.EXT_PERMITDATE", value: "2026-09-01" }] });
    expect(plans[0]!.children).toEqual({ EXT_WOPERMIT: [{ action: "Change", idAttr: "EXT_WOPERMITID", id: 1004, attrs: { EXT_PERMITDATE: "2026-09-01" } }] });
    const { results } = await run(s, plans);
    expect(results[0]!.status).toBe("verified");
    const k = woOf(s.fake, "WO1001").children.ext_wopermit![0]!;
    expect(k.attrs).toMatchObject({ ext_permitdate: "2026-09-01", ext_authority: "消防", ext_permittype: "届出" });
    expect(woOf(s.fake, "WO1001").children.multiassetlocci).toHaveLength(3);
  });

  it("proxy 経由でも同じ手順で反映できる", async () => {
    const s = await setup({ via: "proxy" });
    const { results } = await run(s, planCommit(s.meta, s.records, typicalChanges()));
    expect(results.map((r) => r.status)).toEqual(["verified", "verified"]);
    for (const r of s.fake.state.requests) {
      expect(r.url.startsWith("/mx/maximo/api/os/mxapiwo/")).toBe(true);
      expect(r.url).not.toContain(s.fake.apiKey);
    }
  });

  it("カナリアで続行しなければ残りは送らず skipped（確認が例外で終わっても同じ）", async () => {
    for (const canary of [false, "throw"] as const) {
      const s = await setup();
      const { results, canaryCalls } = await run(s, planCommit(s.meta, s.records, typicalChanges()), { canary });
      expect(results.map((r) => [r.status, r.sent])).toEqual([
        ["verified", true],
        ["skipped", false],
      ]);
      expect(canaryCalls).toHaveLength(1);
      expect(posts(s.fake)).toHaveLength(1);
      expect(woOf(s.fake, "WO1002").attrs.status).toBe("APPR");
    }
  });

  it("1 件だけならカナリアを待たない。計画が空なら何も送らない", async () => {
    const s = await setup();
    const one = planCommit(s.meta, s.records, { ...none(), cells: [{ rowKey: pk("WO1003"), col: "DESCRIPTION", value: "塗装（完了報告済み）" }] });
    const r1 = await run(s, one);
    expect(r1.results[0]!.status).toBe("verified");
    expect(r1.canaryCalls).toHaveLength(0);
    const r0 = await run(s, []);
    expect(r0.results).toEqual([]);
  });

  describe("precheck の衝突（送らない）", () => {
    it("読み込み後に親が更新されていれば conflict。次の親は送り、カナリアは実際に送った 1 件の後に待つ", async () => {
      const s = await setup();
      const changes = typicalChanges();
      changes.cells.push({ rowKey: pk("WO1003"), col: "DESCRIPTION", value: "塗装（完了報告済み）" });
      const plans = planCommit(s.meta, s.records, changes);
      s.fake.update("mxapiwo", woOf(s.fake, "WO1001").uid, (r) => {
        r.attrs.description = "他の人の変更";
      });
      const { results, canaryCalls } = await run(s, plans);
      expect(results.map((r) => [r.status, r.sent])).toEqual([
        ["conflict", false],
        ["verified", true],
        ["verified", true],
      ]);
      expect(results[0]!.message).toMatch(/_rowstamp/);
      expect(canaryCalls.map((c) => c.rowKey)).toEqual([pk("WO1002")]);
      expect(posts(s.fake)).toHaveLength(2);
      expect(woOf(s.fake, "WO1001").attrs.description).toBe("他の人の変更");
      expect(woOf(s.fake, "WO1001").children.multiassetlocci).toHaveLength(3);
    });

    it("子の集合が変わっていれば（親の _rowstamp が同じでも）conflict", async () => {
      const s = await setup();
      const plans = planCommit(s.meta, s.records, typicalChanges());
      s.fake.addChild("mxapiwo", woOf(s.fake, "WO1001").uid, "multiassetlocci", { assetnum: "X-1", isprimary: false }, { bumpRowstamp: false });
      const { results } = await run(s, plans);
      expect(results[0]!.status).toBe("conflict");
      expect(results[0]!.message).toMatch(/集合/);
      expect(posts(s.fake).every((p) => !p.path.includes(woOf(s.fake, "WO1001").uid))).toBe(true);
    });

    it("変更する子だけが他の人に更新されていれば（親の _rowstamp が同じでも）conflict", async () => {
      const s = await setup();
      const plans = planCommit(s.meta, s.records, typicalChanges());
      s.fake.update(
        "mxapiwo",
        woOf(s.fake, "WO1001").uid,
        (r) => {
          const c = r.children.multiassetlocci![1]!;
          c.attrs.location = "他の人";
          c.rowstamp += 1000;
        },
        { bumpRowstamp: false },
      );
      const { results } = await run(s, plans);
      expect(results[0]!.status).toBe("conflict");
      expect(results[0]!.message).toMatch(/子 MULTIASSETLOCCI が更新/);
      expect(woOf(s.fake, "WO1001").children.multiassetlocci![1]!.attrs.location).toBe("他の人");
    });

    it("読み込み時の _rowstamp が無い計画は照合できないので送らない", async () => {
      const s = await setup();
      const plans = planCommit(s.meta, s.records, typicalChanges()).map((p) => ({ ...p, expectedRowstamp: null }));
      const { results } = await run(s, plans, { stopOnFailure: false });
      expect(results.map((r) => r.status)).toEqual(["conflict", "conflict"]);
      expect(posts(s.fake)).toHaveLength(0);
    });

    it("レコードが消えていれば（404）conflict", async () => {
      const s = await setup();
      const plans = planCommit(s.meta, s.records, typicalChanges());
      const list = s.fake.records("mxapiwo");
      list.splice(list.indexOf(woOf(s.fake, "WO1001")), 1);
      const { results } = await run(s, plans);
      expect(results[0]).toMatchObject({ status: "conflict", httpStatus: 404, sent: false });
    });

    it("precheck の読み直しが reasonCode 付きで失敗すれば error（送らない）で、残りは skipped", async () => {
      const s = await setup();
      s.fake.state.failures.push({ method: "GET", kind: "status", status: 500, body: { Error: { reasonCode: "BMXAA0001E", message: "db", statusCode: "500" } } });
      const { results } = await run(s, planCommit(s.meta, s.records, typicalChanges()));
      expect(results.map((r) => [r.status, r.sent])).toEqual([
        ["error", false],
        ["skipped", false],
      ]);
      expect(results[0]!.reasonCode).toBe("BMXAA0001E");
      expect(posts(s.fake)).toHaveLength(0);
    });
  });

  describe("送信の結果", () => {
    it("409（transactionid の重複）で反映済みなら reconcile して verified", async () => {
      const s = await setup();
      s.fake.state.failures.push({ method: "POST", phase: "after", kind: "status", status: 409, body: { Error: { reasonCode: "BMXAA9549E", message: "dup", statusCode: "409" } } });
      const { results } = await run(s, planCommit(s.meta, s.records, typicalChanges()));
      expect(results[0]).toMatchObject({ status: "verified", httpStatus: 409, reasonCode: "BMXAA9549E", sent: true });
      expect(results[0]!.message).toMatch(/反映を確認/);
      expect(results[1]!.status).toBe("verified");
    });

    it("409 で未反映なら unknown（自動では再送しない）で、残りは skipped", async () => {
      const s = await setup();
      s.fake.state.transactionIds.add("tx-0");
      const { results } = await run(s, planCommit(s.meta, s.records, typicalChanges()));
      expect(results.map((r) => r.status)).toEqual(["unknown", "skipped"]);
      expect(results[0]).toMatchObject({ httpStatus: 409, reasonCode: "BMXAA9549E" });
      expect(results[0]!.message).toMatch(/未反映/);
      expect(posts(s.fake)).toHaveLength(1);
      expect(woOf(s.fake, "WO1001").attrs.description).toBe("ポンプ点検");
    });

    it("通信エラーで未反映なら unknown、再送しない", async () => {
      const s = await setup();
      s.fake.state.failures.push({ method: "POST", kind: "network" });
      const { results } = await run(s, planCommit(s.meta, s.records, typicalChanges()));
      expect(results.map((r) => [r.status, r.sent])).toEqual([
        ["unknown", true],
        ["skipped", false],
      ]);
      expect(results[0]!.message).toMatch(/通信エラー.*未反映/);
      expect(posts(s.fake)).toHaveLength(1);
      expect(woOf(s.fake, "WO1001").attrs.description).toBe("ポンプ点検");
    });

    it("通信エラーは、読み直しで反映済みに見えても unknown のまま（応答を受け取れていないため）", async () => {
      const s = await setup();
      s.fake.state.failures.push({ method: "POST", phase: "after", kind: "network" });
      const { results } = await run(s, planCommit(s.meta, s.records, typicalChanges()));
      expect(results[0]!.status).toBe("unknown");
      expect(results[0]!.message).toMatch(/反映済みに見える/);
      expect(results[1]!.status).toBe("skipped");
      expect(woOf(s.fake, "WO1001").attrs.description).toBe("ポンプ点検（再）");
    });

    it("タイムアウトも unknown", async () => {
      const s = await setup();
      // POST だけ応答を返さない fetch。クライアントのタイムアウト（5ms）で中断させる
      const hangPost: FetchLike = (url, init) =>
        init.method === "POST"
          ? new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
          : s.fake.fetch(url, init);
      const client = new MaximoClient({ baseUrl: s.fake.baseUrl, apiKey: () => s.fake.apiKey, via: "direct", fetchImpl: hangPost, sleep: async () => {}, timeoutMs: 5 });
      const { results } = await run({ ...s, client }, planCommit(s.meta, s.records, typicalChanges()));
      expect(results[0]!.status).toBe("unknown");
      expect(results[0]!.message).toMatch(/タイムアウト/);
    });

    it("reasonCode の無い 5xx は unknown", async () => {
      const s = await setup();
      s.fake.state.failures.push({ method: "POST", kind: "status", status: 502, body: {} });
      const { results } = await run(s, planCommit(s.meta, s.records, typicalChanges()));
      expect(results[0]).toMatchObject({ status: "unknown", httpStatus: 502 });
    });

    it("reasonCode 付きのエラーは error。既定では残りを skipped、stopOnFailure:false なら続ける", async () => {
      const long = "あ".repeat(101);
      const changes = (): CommitChanges => ({
        ...none(),
        cells: [
          { rowKey: pk("WO1003"), col: "DESCRIPTION", value: long },
          { rowKey: pk("WO1004"), col: "STATUS", value: "APPR" },
        ],
      });
      const s1 = await setup();
      const r1 = await run(s1, planCommit(s1.meta, s1.records, changes()));
      expect(r1.results.map((r) => r.status)).toEqual(["error", "skipped"]);
      expect(r1.results[0]).toMatchObject({ httpStatus: 400, reasonCode: "BMXAA_FAKE_LENGTH", sent: true });
      expect(r1.canaryCalls).toHaveLength(0);

      const s2 = await setup();
      const r2 = await run(s2, planCommit(s2.meta, s2.records, changes()), { stopOnFailure: false });
      expect(r2.results.map((r) => r.status)).toEqual(["error", "verified"]);
      expect(r2.canaryCalls).toHaveLength(1);
      expect(woOf(s2.fake, "WO1004").attrs.status).toBe("APPR");
    });

    it("2xx でも読み直した値が計画と違えば unknown（一致しない列名だけを書き、値は書かない）", async () => {
      const s = await setup();
      s.fake.state.failures.push({ method: "POST", kind: "status", status: 200, body: {} });
      const { results } = await run(s, planCommit(s.meta, s.records, typicalChanges()));
      expect(results[0]!.status).toBe("unknown");
      expect(results[0]!.message).toMatch(/DESCRIPTION/);
      expect(results[0]!.message).toMatch(/MULTIASSETLOCCI/);
      expect(results[0]!.message).not.toMatch(/ポンプ点検|L9|P-900/);
    });

    it("2xx の後の読み直しに失敗したら unknown", async () => {
      let posted = false;
      const s = await setup({
        fetchWrap: (f) => async (url, init) => {
          if (init.method === "POST") {
            posted = true;
            return f(url, init);
          }
          if (posted) throw new TypeError("down");
          return f(url, init);
        },
      });
      const { results } = await run(s, planCommit(s.meta, s.records, typicalChanges()));
      expect(results[0]).toMatchObject({ status: "unknown", sent: true });
      expect(results[0]!.message).toMatch(/送信後の読み直し/);
    });
  });

  describe("送信前の再検査（違反は何も送らずに例外）", () => {
    it("計画の不変条件（I2・I3・I5）を executeCommit でも検査する", async () => {
      const s = await setup();
      const plan = planCommit(s.meta, s.records, typicalChanges())[0]!;
      const badId: CommitPlan = { ...plan, children: { MULTIASSETLOCCI: [{ action: "Change", idAttr: "MULTIID", id: 9999, attrs: { LOCATION: "L" } }] } };
      await expect(run(s, [badId])).rejects.toMatchObject({ code: "I2" });
      const readOnly: CommitPlan = { ...plan, attrs: { CHANGEBY: "ME" }, children: {} };
      await expect(run(s, [readOnly])).rejects.toMatchObject({ code: "I5" });
      const key: CommitPlan = { ...plan, attrs: { WONUM: "X" }, children: {} };
      await expect(run(s, [key])).rejects.toMatchObject({ code: "I5" });
      const manyDeletes: CommitPlan = {
        ...plan,
        expectedChildIds: { MULTIASSETLOCCI: Array.from({ length: 11 }, (_, i) => i + 1) },
        expectedChildRowstamps: {},
        children: { MULTIASSETLOCCI: Array.from({ length: 11 }, (_, i) => ({ action: "Delete" as const, idAttr: "MULTIID", id: i + 1 })) },
      };
      await expect(run(s, [manyDeletes])).rejects.toMatchObject({ code: "I3" });
      expect(s.fake.state.requests).toHaveLength(0);
    });

    it("maxDeletesConfirmed で削除上限を超えた計画も実行できる（precheck で子の集合が合わなければ conflict）", async () => {
      const s = await setup();
      const plan = planCommit(s.meta, s.records, typicalChanges())[0]!;
      const manyDeletes: CommitPlan = {
        ...plan,
        expectedChildIds: { MULTIASSETLOCCI: Array.from({ length: 11 }, (_, i) => i + 1) },
        expectedChildRowstamps: {},
        attrs: {},
        children: { MULTIASSETLOCCI: Array.from({ length: 11 }, (_, i) => ({ action: "Delete" as const, idAttr: "MULTIID", id: i + 1 })) },
      };
      const { results } = await run(s, [manyDeletes], { maxDeletesConfirmed: true });
      expect(results[0]!.status).toBe("conflict");
      expect(posts(s.fake)).toHaveLength(0);
    });

    it("transactionid の重複・不正は、1 件も送らないうちに止める", async () => {
      const s = await setup();
      const plans = planCommit(s.meta, s.records, typicalChanges());
      await expect(run(s, plans, { makeTransactionId: () => "same" })).rejects.toMatchObject({ code: "INPUT" });
      await expect(run(s, plans, { makeTransactionId: (_p, i) => (i === 1 ? "bad id" : `ok-${i}`) })).rejects.toMatchObject({ code: "INPUT" });
      expect(s.fake.state.requests).toHaveLength(0);
    });

    it("I7: href がオブジェクト構造のレコードでない・コンテキストルートの外なら、1 件も送らないうちに止める", async () => {
      const s = await setup();
      const plans = planCommit(s.meta, s.records, typicalChanges());
      const second = (href: string): CommitPlan[] => [plans[0]!, { ...plans[1]!, href }];
      await expect(run(s, second("https://maximo.test/maximo/api/script/evil"))).rejects.toMatchObject({ code: "I7" });
      await expect(run(s, second("https://maximo.test/other/api/os/mxapiwo/_A"))).rejects.toMatchObject({ code: "I7" });
      await expect(run(s, second("https://maximo.test/maximo/api/os/mxapiwo/..;/_A"))).rejects.toMatchObject({ code: "I7" });
      expect(s.fake.state.requests).toHaveLength(0);
    });

    it("ID 属性が不明（null）とされた子への変更・削除、href の重複は拒否する", async () => {
      const s = await setup();
      const plans = planCommit(s.meta, s.records, typicalChanges());
      await expect(run(s, plans, { childIdAttrs: { ...s.meta.childIdAttrs, MULTIASSETLOCCI: null } })).rejects.toMatchObject({ code: "I2" });
      await expect(run(s, [plans[0]!, { ...plans[1]!, href: plans[0]!.href }])).rejects.toMatchObject({ code: "INPUT" });
      expect(s.fake.state.requests).toHaveLength(0);
    });
  });

  describe("応答を解釈できない・送る前に止まった", () => {
    it("2xx でも本文が {Error:{...}}（reasonCode 付き）なら error", async () => {
      const s = await setup();
      s.fake.state.failures.push({ method: "POST", kind: "status", status: 200, body: { Error: { reasonCode: "BMXAA4214E", message: "batch", statusCode: "400" } } });
      const { results } = await run(s, planCommit(s.meta, s.records, typicalChanges()));
      expect(results[0]).toMatchObject({ status: "error", httpStatus: 400, reasonCode: "BMXAA4214E", sent: true });
      expect(results[1]!.status).toBe("skipped");
    });

    it("JSON でない 2xx（中継のログイン画面など）は error ではなく、読み直して unknown", async () => {
      const s = await setup({
        fetchWrap: (f) => async (url, init) => (init.method === "POST" ? new Response("<html>login</html>", { status: 200 }) : f(url, init)),
      });
      const { results } = await run(s, planCommit(s.meta, s.records, typicalChanges()));
      expect(results[0]).toMatchObject({ status: "unknown", httpStatus: 200, sent: true });
      expect(results[0]!.message).toMatch(/未反映/);
      expect(results[1]!.status).toBe("skipped");
    });

    it("送信の直前に API キーが消えたら、送らずに error（sent:false）で残りは skipped", async () => {
      const s = await setup();
      let keyOn = true;
      const client = new MaximoClient({
        baseUrl: s.fake.baseUrl,
        apiKey: () => (keyOn ? s.fake.apiKey : ""),
        via: "direct",
        fetchImpl: async (url, init) => {
          const res = await s.fake.fetch(url, init);
          if (init.method === "GET") keyOn = false;
          return res;
        },
        sleep: async () => {},
      });
      const { results, canaryCalls } = await run({ ...s, client }, planCommit(s.meta, s.records, typicalChanges()));
      expect(results.map((r) => [r.status, r.sent])).toEqual([
        ["error", false],
        ["skipped", false],
      ]);
      expect(results[0]!.message).toMatch(/API key is not set/);
      expect(canaryCalls).toHaveLength(0);
      expect(posts(s.fake)).toHaveLength(0);
    });

    it("onRow が例外を投げたら残りは送らず skipped にして結果を返す", async () => {
      const s = await setup();
      let calls = 0;
      const results = await executeCommit(s.client, planCommit(s.meta, s.records, typicalChanges()), {
        waitForCanaryContinue: async () => true,
        onRow: () => {
          calls++;
          throw new Error("render failed");
        },
        meta: s.meta,
        makeTransactionId: txIds,
      });
      expect(results.map((r) => [r.status, r.sent])).toEqual([
        ["verified", true],
        ["skipped", false],
      ]);
      expect(calls).toBe(2);
      expect(posts(s.fake)).toHaveLength(1);
    });

    it("計画に子の _rowstamp があるのに、変更・削除する子の分が欠けていれば conflict", async () => {
      const s = await setup();
      const plan = planCommit(s.meta, s.records, typicalChanges())[0]!;
      const partial: CommitPlan = { ...plan, expectedChildRowstamps: { MULTIASSETLOCCI: { "1002": plan.expectedChildRowstamps!.MULTIASSETLOCCI!["1002"]! } } };
      const { results } = await run(s, [partial]);
      expect(results[0]!.status).toBe("conflict");
      expect(posts(s.fake)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 書き込みログ
// ---------------------------------------------------------------------------

describe("writeLogEntry", () => {
  const plan: ParentCommitPlan = {
    parentKey: makeParentKey(["BEDFORD", "WO1001"]),
    href: "https://maximo.test/maximo/api/os/mxapiwo/_A",
    expectedRowstamp: "1",
    expectedChildIds: { MULTIASSETLOCCI: [1002, 1003] },
    attrs: { DESCRIPTION: "§秘密の説明§", ESTDUR: 12345.678 },
    children: {
      MULTIASSETLOCCI: [
        { action: "Change", idAttr: "MULTIID", id: 1002, attrs: { LOCATION: "§LOC-SECRET§" } },
        { action: "Delete", idAttr: "MULTIID", id: 1003 },
        { action: "Add", attrs: { ASSETNUM: "§ASSET-SECRET§", SEQUENCE: 98765 } },
      ],
    },
  };
  const outcome: CommitRowOutcome = {
    rowKey: plan.parentKey,
    status: "error",
    httpStatus: 400,
    reasonCode: "BMXAA0031E",
    message: "値 §秘密の説明§ は長すぎる",
    transactionId: "tx-1",
    sent: true,
  };

  it("キー・件数・属性名・結果だけを残し、属性値やメッセージは入れない", () => {
    const entry = writeLogEntry(plan, outcome, Date.UTC(2026, 8, 16, 0, 0, 0));
    expect(entry).toEqual({
      at: "2026-09-16T00:00:00.000Z",
      parentKey: plan.parentKey,
      transactionId: "tx-1",
      ops: { change: 1, delete: 1, add: 1, attrs: ["DESCRIPTION", "ESTDUR", "MULTIASSETLOCCI.ASSETNUM", "MULTIASSETLOCCI.LOCATION", "MULTIASSETLOCCI.SEQUENCE"] },
      httpStatus: 400,
      reasonCode: "BMXAA0031E",
      result: "error",
    });
    const json = JSON.stringify(entry);
    expect(json).not.toContain("§");
    expect(json).not.toContain("12345");
    expect(json).not.toContain("98765");
    expect(json).not.toContain("1002");
    expect(json).not.toContain("長すぎる");
  });

  it("性質: どんな値を送る計画でも、ログに値が現れない", () => {
    const valueArb = fc.oneof(fc.string({ minLength: 1, maxLength: 12 }).map((s) => `§${s}§`), fc.constant(null));
    fc.assert(
      fc.property(valueArb, valueArb, valueArb, (a, b, c) => {
        const p: ParentCommitPlan = {
          ...plan,
          attrs: { DESCRIPTION: a },
          children: { MULTIASSETLOCCI: [{ action: "Change", idAttr: "MULTIID", id: 1002, attrs: { LOCATION: b } }, { action: "Add", attrs: { ASSETNUM: c } }] },
        };
        const json = JSON.stringify(writeLogEntry(p, { ...outcome, message: `${String(a)}${String(b)}` }));
        expect(json).not.toContain("§");
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// 性質試験: ランダムな変更 → 計画 → fake に適用 → 期待状態と一致
// ---------------------------------------------------------------------------

function maybe<T>(arb: Arbitrary<T>): Arbitrary<T | undefined> {
  return fc.option(arb, { nil: undefined });
}

const childSeedArb = fc.record({
  assetnum: fc.constantFrom("A-1", "A-2", "B-1"),
  location: fc.option(fc.constantFrom("L1", "L2"), { nil: null }),
  sequence: fc.integer({ min: 1, max: 9 }),
});

const childOpArb = fc.oneof(
  fc.record({ kind: fc.constant("keep" as const) }),
  fc.record({ kind: fc.constant("delete" as const) }),
  fc.record({
    kind: fc.constant("change" as const),
    assetnum: maybe(fc.constantFrom("A-1", "X-5")),
    location: maybe(fc.constantFrom("L1", "L3")),
    sequence: maybe(fc.integer({ min: 1, max: 9 })),
  }),
);

const parentArb = fc.record({
  description: fc.constantFrom("d1", "d2"),
  status: fc.constantFrom("WAPPR", "APPR"),
  estdur: fc.option(fc.constantFrom(1, 2.5), { nil: null }),
  hasPrimary: fc.boolean(),
  children: fc.array(childSeedArb, { maxLength: 4 }),
  newDescription: maybe(fc.constantFrom("d1", "更新後")),
  newStatus: maybe(fc.constantFrom("APPR", "INPRG")),
  newEstdur: maybe(fc.constantFrom(1, 4.5)),
  childOps: fc.array(childOpArb, { minLength: 4, maxLength: 4 }),
  adds: fc.array(
    fc.record({ assetnum: fc.constantFrom("N-1", "N-2"), location: fc.option(fc.constantFrom("L1", "L4"), { nil: null }), sequence: fc.integer({ min: 1, max: 9 }) }),
    { maxLength: 2 },
  ),
});

function sameAttrs(x: Record<string, CellValue>, y: Record<string, CellValue>): boolean {
  return Object.keys({ ...x, ...y }).every((k) => (x[k] ?? null) === (y[k] ?? null));
}

function canonicalRows(rows: Array<Record<string, CellValue>>): string[] {
  return rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]))).sort();
}

describe("性質: 計画を fake に適用すると期待状態と一致する", () => {
  it(
    "ランダムな親属性・子の変更/削除/追加 → planCommit → executeCommit → 変更していない属性・子（主行を含む）は不変",
    async () => {
      let sentPlans = 0;
      await fc.assert(
        fc.asyncProperty(fc.array(parentArb, { minLength: 1, maxLength: 3 }), fc.constantFrom("direct" as const, "proxy" as const), async (parents, via) => {
          const woRecords: FakeRecordSeed[] = parents.map((p, i) => ({
            attrs: { siteid: "BEDFORD", wonum: `WO${i + 1}`, description: p.description, status: p.status, estdur: p.estdur },
            children: {
              multiassetlocci: [
                ...(p.hasPrimary ? [{ assetnum: "PRI", location: "L0", isprimary: true, sequence: 0 }] : []),
                ...p.children.map((c) => ({ ...c, isprimary: false })),
              ],
            },
          }));
          const s = await setup({ woRecords, via });
          const { fake, meta, records } = s;
          const before: FakeRecord[] = structuredClone(fake.records("mxapiwo"));
          const expected: FakeRecord[] = structuredClone(before);
          const expectedAdds: Array<Array<Record<string, CellValue>>> = parents.map(() => []);
          const changes = none();

          parents.forEach((p, i) => {
            const wonum = `WO${i + 1}`;
            const parentKey = pk(wonum);
            const rec = records.find((r) => r.attrs.WONUM === wonum)!;
            const exp = expected.find((r) => r.attrs.wonum === wonum)!;
            const kids = rec.children.MULTIASSETLOCCI ?? [];
            const nonPrimary = kids.filter((k) => k.attrs.ISPRIMARY !== true);
            const deleted = new Set<CellValue>();

            nonPrimary.forEach((k, j) => {
              const op = p.childOps[j]!;
              const rowKey = makeChildRowKey(parentKey, "MULTIASSETLOCCI", k.id);
              const expChild = exp.children.multiassetlocci!.find((c) => c.attrs.multiid === k.id)!;
              if (op.kind === "delete") {
                changes.deletedRows.push(rowKey);
                deleted.add(k.id);
                exp.children.multiassetlocci = exp.children.multiassetlocci!.filter((c) => c !== expChild);
              } else if (op.kind === "change") {
                const edits: Array<[string, string, CellValue | undefined]> = [
                  ["MULTIASSETLOCCI.ASSETNUM", "assetnum", op.assetnum],
                  ["MULTIASSETLOCCI.LOCATION", "location", op.location],
                  ["MULTIASSETLOCCI.SEQUENCE", "sequence", op.sequence],
                ];
                for (const [col, attr, v] of edits) {
                  if (v === undefined) continue;
                  changes.cells.push({ rowKey, col, value: v });
                  expChild.attrs[attr] = v;
                }
              }
            });

            // 親の列の変更は、store と同じく残る全行（子行が無ければ親行）に同じ値で入れる
            const keptRows = kids.filter((k) => !deleted.has(k.id)).map((k) => makeChildRowKey(parentKey, "MULTIASSETLOCCI", k.id));
            const parentRows = keptRows.length > 0 ? keptRows : [parentKey];
            const parentEdits: Array<[string, string, CellValue | undefined]> = [
              ["DESCRIPTION", "description", p.newDescription],
              ["ESTDUR", "estdur", p.newEstdur],
            ];
            for (const [col, attr, v] of parentEdits) {
              if (v === undefined) continue;
              for (const rowKey of parentRows) changes.cells.push({ rowKey, col, value: v });
              exp.attrs[attr] = v;
            }

            p.adds.forEach((a, j) => {
              changes.addedRows.push({
                rowKey: makeChildRowKey(parentKey, "MULTIASSETLOCCI", `new~${j + 1}`),
                parentKey,
                childName: "MULTIASSETLOCCI",
                values: {
                  SITEID: "BEDFORD",
                  WONUM: wonum,
                  "MULTIASSETLOCCI.MULTIID": null,
                  "MULTIASSETLOCCI.ASSETNUM": a.assetnum,
                  "MULTIASSETLOCCI.LOCATION": a.location,
                  "MULTIASSETLOCCI.ISPRIMARY": false,
                  "MULTIASSETLOCCI.SEQUENCE": a.sequence,
                },
              });
              expectedAdds[i]!.push({ assetnum: a.assetnum, location: a.location, isprimary: false, sequence: a.sequence });
            });
          });

          const plans = planCommit(meta, records, changes);

          // 計画そのもの: MERGE、空配列なし、Change/Delete は読み込み時の ID、Add は ID なし、主行は触らない
          for (const plan of plans) {
            const req = buildPatchRequest(plan, "tx-check");
            expect(req.headers.patchtype).toBe("MERGE");
            const primaryIds = new Set(
              records
                .find((r) => r.href === plan.href)!
                .children.MULTIASSETLOCCI?.filter((c) => c.attrs.ISPRIMARY === true)
                .map((c) => String(c.id)) ?? [],
            );
            const items = (req.body.multiassetlocci ?? []) as Array<Record<string, unknown>>;
            if ("multiassetlocci" in req.body) expect(items.length).toBeGreaterThan(0);
            for (const item of items) {
              if (item._action === undefined) {
                expect(item).not.toHaveProperty("multiid");
              } else {
                expect(plan.expectedChildIds.MULTIASSETLOCCI!.map(String)).toContain(String(item.multiid));
                expect(primaryIds.has(String(item.multiid))).toBe(false);
              }
            }
          }

          const results = await executeCommit(s.client, plans, { waitForCanaryContinue: async () => true, meta, makeTransactionId: txIds });
          expect(results.map((r) => r.status)).toEqual(plans.map(() => "verified"));
          sentPlans += plans.length;
          expect(posts(fake)).toHaveLength(plans.length);
          expect(posts(fake).every((r) => r.headers.patchtype === "MERGE")).toBe(true);

          const after = fake.records("mxapiwo");
          parents.forEach((_p, i) => {
            const wonum = `WO${i + 1}`;
            const a = after.find((r) => r.attrs.wonum === wonum)!;
            const b = before.find((r) => r.attrs.wonum === wonum)!;
            const e = expected.find((r) => r.attrs.wonum === wonum)!;
            expect(a.attrs).toEqual(e.attrs);
            if (!plans.some((pl) => pl.parentKey === pk(wonum))) expect(a).toEqual(b);

            const beforeIds = new Set(b.children.multiassetlocci!.map((c) => c.attrs.multiid));
            const kept = a.children.multiassetlocci!.filter((c) => beforeIds.has(c.attrs.multiid));
            const byId = (rows: Array<Record<string, CellValue>>) => [...rows].sort((x, y) => Number(x.multiid) - Number(y.multiid));
            expect(byId(kept.map((c) => c.attrs))).toEqual(byId(e.children.multiassetlocci!.map((c) => c.attrs)));
            for (const c of kept) {
              const bc = b.children.multiassetlocci!.find((x) => x.attrs.multiid === c.attrs.multiid)!;
              // 値の変わっていない子（主行を含む）は _rowstamp も変わらない
              if (sameAttrs(c.attrs, bc.attrs)) expect(c.rowstamp).toBe(bc.rowstamp);
              if (bc.attrs.isprimary === true) expect(c).toEqual(bc);
            }
            const added = a.children.multiassetlocci!
              .filter((c) => !beforeIds.has(c.attrs.multiid))
              .map((c) => {
                const { multiid: _id, ...rest } = c.attrs;
                return rest;
              });
            expect(canonicalRows(added)).toEqual(canonicalRows(expectedAdds[i]!));
            // 読み込んでいない子は触らない
            expect(a.children.ext_wopermit).toEqual(b.children.ext_wopermit);
          });
        }),
        { numRuns: 60 },
      );
      // 生成した変更が空の計画ばかりで性質が空振りしていないこと
      expect(sentPlans).toBeGreaterThan(20);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// 新規作成（追加した親の行）
// ---------------------------------------------------------------------------

describe("新規作成", () => {
  const newWo = (wonum: string, extra: Record<string, CellValue> = {}): CommitChanges["addedRows"][number] => ({
    rowKey: pk(wonum),
    parentKey: pk(wonum),
    childName: null,
    values: { SITEID: "BEDFORD", WONUM: wonum, DESCRIPTION: "新しい作業", STATUS: null, ESTDUR: 2, CHANGEBY: null, ...extra },
  });
  const newChild = (wonum: string, n: number, location: string): CommitChanges["addedRows"][number] => ({
    rowKey: makeChildRowKey(pk(wonum), "MULTIASSETLOCCI", `new~${n}`),
    parentKey: pk(wonum),
    childName: "MULTIASSETLOCCI",
    values: { SITEID: "BEDFORD", WONUM: wonum, DESCRIPTION: "新しい作業", ESTDUR: 2, "MULTIASSETLOCCI.LOCATION": location, "MULTIASSETLOCCI.MULTIID": null },
  });
  const run = (s: Setup, plans: CommitPlan[]) => executeCommit(s.client, plans, { waitForCanaryContinue: async () => true, meta: s.meta, os: "MXAPIWO", makeTransactionId: txIds });

  it("計画: キーを含む値の入った親の列と、追加した子だけ。href は持たない", async () => {
    const { meta, records } = await setup();
    const plans = planCommit(meta, records, { ...none(), addedRows: [newWo("WO9001"), newChild("WO9001", 1, "L1")] });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      parentKey: pk("WO9001"),
      href: "",
      create: { keys: { SITEID: "BEDFORD", WONUM: "WO9001" } },
      attrs: { SITEID: "BEDFORD", WONUM: "WO9001", DESCRIPTION: "新しい作業", ESTDUR: 2 },
      children: { MULTIASSETLOCCI: [{ action: "Add", attrs: { LOCATION: "L1" } }] },
    });
    expect(plans[0]!.attrs).not.toHaveProperty("CHANGEBY");
  });

  it("一覧へ x-method-override なしで POST し、キーで探し直して確かめ、作ったレコードの href を返す", async () => {
    const s = await setup();
    const plans = planCommit(s.meta, s.records, { ...none(), addedRows: [newWo("WO9001"), newChild("WO9001", 1, "L1")] });
    const [r] = await run(s, plans);
    expect(r).toMatchObject({ rowKey: pk("WO9001"), status: "verified", sent: true });
    const rec = woOf(s.fake, "WO9001");
    expect(rec.attrs).toMatchObject({ siteid: "BEDFORD", description: "新しい作業", estdur: 2 });
    expect(rec.children.multiassetlocci?.map((c) => c.attrs.location)).toEqual(["L1"]);
    expect(r!.createdHref).toBe(s.fake.hrefOf("mxapiwo", rec.uid));
    const [post] = posts(s.fake);
    expect(post!.path).toBe("/maximo/api/os/mxapiwo?lean=1");
    expect(post!.headers).not.toHaveProperty("x-method-override");
    expect(post!.headers).not.toHaveProperty("patchtype");
    expect(post!.body).toEqual({ siteid: "BEDFORD", wonum: "WO9001", description: "新しい作業", estdur: 2, multiassetlocci: [{ location: "L1" }] });
  });

  it("同じキーのレコードが Maximo にもうあれば送らない（conflict）", async () => {
    const s = await setup();
    const plans = planCommit(s.meta, s.records, { ...none(), addedRows: [newWo("WO9001")] });
    s.fake.state.os.mxapiwo!.records.push({ uid: "_X", rowstamp: 1, attrs: { siteid: "BEDFORD", wonum: "WO9001" }, children: {} });
    const [r] = await run(s, plans);
    expect(r).toMatchObject({ status: "conflict", sent: false });
    expect(posts(s.fake)).toHaveLength(0);
  });

  it("送った後の通信エラーは、キーで探して作られていても unknown（応答を受け取れていない）。Maximo の誤りは error", async () => {
    const s = await setup();
    s.fake.state.failures.push({ method: "POST", phase: "after", kind: "network" });
    const [r] = await run(s, planCommit(s.meta, s.records, { ...none(), addedRows: [newWo("WO9001")] }));
    expect(r).toMatchObject({ status: "unknown", sent: true });
    expect(woOf(s.fake, "WO9001")).toBeDefined();

    const t = await setup();
    const [e] = await run(t, planCommit(t.meta, t.records, { ...none(), addedRows: [newWo("WO9002", { ESTDUR: "x" as unknown as number })] }));
    expect(e).toMatchObject({ status: "error", sent: true, reasonCode: "BMXAA_FAKE_TYPE" });
  });

  it("409（同じ transactionid）は、キーで探して作られていれば verified", async () => {
    const s = await setup();
    const plans = planCommit(s.meta, s.records, { ...none(), addedRows: [newWo("WO9001")] });
    // 前の送信で作られていたが応答を受け取れなかった、という状況を作る
    s.fake.state.os.mxapiwo!.records.push({ uid: "_Y", rowstamp: 1, attrs: { siteid: "BEDFORD", wonum: "WO9001", description: "新しい作業", estdur: 2 }, children: {} });
    s.fake.state.transactionIds.add("tx-0");
    // 送る前の確かめでは見つからないことにする（前の送信の直後に同じ計画を流した場合）
    const realFetch = s.fake.fetch;
    let gets = 0;
    const client = new MaximoClient({
      baseUrl: s.fake.baseUrl,
      apiKey: () => s.fake.apiKey,
      via: "direct",
      fetchImpl: async (input, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET" && gets++ === 0) return new Response(JSON.stringify({ member: [] }), { status: 200, headers: { "content-type": "application/json" } });
        return realFetch(input, init);
      },
      sleep: async () => {},
    });
    const [r] = await executeCommit(client, plans, { waitForCanaryContinue: async () => true, meta: s.meta, os: "MXAPIWO", makeTransactionId: txIds });
    expect(r).toMatchObject({ status: "verified", httpStatus: 409 });
    expect(r!.createdHref).toBe(s.fake.hrefOf("mxapiwo", "_Y"));
  });

  it("キー列の空・構造の分からないシート・取り消した親の下の子は送らない", async () => {
    const { meta, records } = await setup();
    expect(codeOf(() => planCommit(meta, records, { ...none(), addedRows: [newWo("WO9001", { SITEID: null })] }))).toBe("INPUT");
    const imported: SheetMeta = { ...meta, source: { kind: "excel", fileName: "a.xlsx", sheetName: "s" } as SheetMeta["source"] };
    expect(codeOf(() => planCommit(imported, records, { ...none(), addedRows: [newWo("WO9001")] }))).toBe("INPUT");
    const cancelled = planCommit(meta, records, { ...none(), addedRows: [newWo("WO9001"), newChild("WO9001", 1, "L1")], deletedRows: [pk("WO9001")] });
    expect(cancelled).toEqual([]);
  });

  it("作る計画は送信先を持たず、子は追加だけ（validatePlans）", async () => {
    const { meta, records } = await setup();
    const [plan] = planCommit(meta, records, { ...none(), addedRows: [newWo("WO9001")] });
    const opts = { allowNull: false, deletesConfirmed: false };
    expect(() => validatePlans([plan!], opts)).not.toThrow();
    expect(codeOf(() => validatePlans([{ ...plan!, href: "https://maximo.test/maximo/api/os/mxapiwo/_A" }], opts))).toBe("I7");
    expect(codeOf(() => validatePlans([{ ...plan!, children: { MULTIASSETLOCCI: [{ action: "Delete", idAttr: "MULTIID", id: 1 }] } }], opts))).toBe("I2");
    expect(codeOf(() => validatePlans([{ ...plan!, create: { keys: { SITEID: "BEDFORD", WONUM: "OTHER" } } }], opts))).toBe("INPUT");
  });
});
