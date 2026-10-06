// ステータスの変更の試験。
// 決まり（src/shared/status.ts と仮想 Maximo の写しが同じこと）、仮想 Maximo の changeStatus、
// 書き込みエンジン（属性として送らない・作成や更新を確かめた後に変える・履歴や改訂の要る注文書や移れないステータスは送らない・
// 戻せないステータスは人の確認が要る）を確かめる。

import { describe, expect, it } from "vitest";
import { MaximoClient } from "../../src/app/maximo/client";
import {
  assertSafePatchRequest,
  buildPatchRequest,
  buildStatusRequest,
  CommitInvariantError,
  executeCommit,
  planCommit,
  SKIP_HISTORY,
  SKIP_PO_REVISION,
  SKIP_STATUS_TRANSITION,
  validatePlans,
  writeLogEntry,
  type CommitChanges,
  type CommitPlan,
  type ExecuteCommitOptions,
} from "../../src/app/maximo/commit";
import { loadRecords } from "../../src/app/maximo/load";
import { getObjectStructureInfo } from "../../src/app/maximo/meta";
import { canChangeStatus, isIrreversibleStatus, STATUS_RULES, statusObjectKind, WO_TRANSITIONS } from "../../src/shared/status";
import { makeParentKey, type MaximoRecord, type ParentCommitPlan, type SheetMeta } from "../../src/shared/sheet";
import { createFakeMaximo, FAKE_STATUSFUL, FAKE_WO_TRANSITIONS, sampleSeed, type FakeMaximo, type FakeSeed } from "../fakes/fake-maximo";

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

/** 作業指示にステータスの日付・履歴の印・実績の日付・ステータスの履歴の子を足し、注文書の構造を加える */
function statusSeed(): FakeSeed {
  const seed = sampleSeed({
    woRecords: [
      { attrs: { siteid: "BEDFORD", wonum: "WO3001", description: "ポンプ点検", status: "WAPPR", historyflag: false } },
      { attrs: { siteid: "BEDFORD", wonum: "WO3002", description: "配管更新（済）", status: "CLOSE", historyflag: true } },
      { attrs: { siteid: "BEDFORD", wonum: "WO3003", description: "塗装", status: "COMP", historyflag: false } },
      { attrs: { siteid: "BEDFORD", wonum: "WO3004", description: "計器校正", status: "INPRG", historyflag: false } },
    ],
  });
  const wo = seed.objectStructures.MXAPIWO!;
  wo.attrs.statusdate = { type: "datetime", readOnly: true };
  wo.attrs.historyflag = { type: "boolean", readOnly: true };
  wo.attrs.actstart = { type: "datetime" };
  wo.attrs.actfinish = { type: "datetime" };
  wo.children!.wostatus = {
    idAttr: "wostatusid",
    attrs: {
      wostatusid: { type: "integer", readOnly: true },
      status: { type: "string", maxLength: 16 },
      changedate: { type: "datetime", readOnly: true },
      memo: { type: "string", maxLength: 50 },
    },
  };
  seed.objectStructures.MXAPIPO = {
    description: "Purchase Order",
    mbo: "PO",
    keyAttrs: ["siteid", "ponum", "revisionnum"],
    attrs: {
      siteid: { type: "string", maxLength: 8, required: true },
      ponum: { type: "string", maxLength: 12, required: true },
      revisionnum: { type: "integer", required: true },
      description: { type: "string", maxLength: 100 },
      status: { type: "string", maxLength: 16, hasList: true },
      statusdate: { type: "datetime", readOnly: true },
      historyflag: { type: "boolean", readOnly: true },
    },
    lists: { status: ["WAPPR", "APPR", "PNDREV", "INPRG", "CLOSE", "CAN", "REVISE"].map((value) => ({ value })) },
    records: [
      { attrs: { siteid: "BEDFORD", ponum: "PO100", revisionnum: 0, description: "ポンプ部品", status: "APPR", historyflag: false } },
      { attrs: { siteid: "BEDFORD", ponum: "PO101", revisionnum: 0, description: "配管材", status: "WAPPR", historyflag: false } },
    ],
  };
  return seed;
}

const WO_SELECT = ["DESCRIPTION", "STATUS", "ACTSTART", "ACTFINISH"];
const WO_GUARD: ExecuteCommitOptions["statusGuard"] = { kind: "WORKORDER", hasStatus: true, hasHistoryFlag: true };

interface Setup {
  fake: FakeMaximo;
  client: MaximoClient;
  meta: SheetMeta;
  records: MaximoRecord[];
}

async function setup(os = "MXAPIWO", select = WO_SELECT): Promise<Setup> {
  const fake = createFakeMaximo(statusSeed());
  const client = new MaximoClient({ baseUrl: fake.baseUrl, apiKey: () => fake.apiKey, via: "direct", fetchImpl: fake.fetch, sleep: async () => {} });
  const info = await getObjectStructureInfo(client, os);
  const knownAttrs = new Set(info.columns.map((c) => c.name));
  const { records } = await loadRecords(client, { os, select, keyColumns: info.keyColumns, childIdAttrs: info.childIdAttrs, knownAttrs });
  const names = new Set([...info.keyColumns, ...select]);
  const meta: SheetMeta = {
    name: "s",
    source: { kind: "maximo", os, select, where: [] },
    columns: info.columns.filter((c) => names.has(c.name)),
    keyColumns: info.keyColumns,
    childIdAttrs: info.childIdAttrs,
  };
  fake.state.requests.length = 0;
  return { fake, client, meta, records };
}

const pk = (wonum: string) => makeParentKey(["BEDFORD", wonum]);
const none = (): CommitChanges => ({ cells: [], addedRows: [], deletedRows: [] });
const edit = (wonum: string, col: string, value: string | null): CommitChanges["cells"][number] => ({ rowKey: pk(wonum), col, value });
const woOf = (fake: FakeMaximo, wonum: string) => fake.find("mxapiwo", (r) => r.attrs.wonum === wonum)!;
const posts = (fake: FakeMaximo) => fake.state.requests.filter((r) => r.method === "POST");
const txIds = (_plan: ParentCommitPlan, i: number) => `tx-${i}`;
const newWo = (wonum: string, extra: Record<string, string | number | null> = {}): CommitChanges["addedRows"][number] => ({
  rowKey: pk(wonum),
  parentKey: pk(wonum),
  childName: null,
  values: { SITEID: "BEDFORD", WONUM: wonum, DESCRIPTION: "過去の点検", STATUS: null, ACTSTART: null, ACTFINISH: null, ...extra },
});

function run(s: Setup, plans: CommitPlan[], opts: Partial<ExecuteCommitOptions> = {}) {
  return executeCommit(s.client, plans, {
    waitForCanaryContinue: async () => true,
    meta: s.meta,
    os: s.meta.source.kind === "maximo" ? s.meta.source.os : "MXAPIWO",
    makeTransactionId: txIds,
    statusGuard: WO_GUARD,
    irreversibleConfirmed: true,
    ...opts,
  });
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (e) {
    if (e instanceof CommitInvariantError) return e.code;
    throw e;
  }
  return null;
}

// ---------------------------------------------------------------------------

describe("ステータスの決まり", () => {
  it("仮想 Maximo の写しは src/shared/status.ts と同じ（仮想 Maximo は値を import できないため写している）", () => {
    expect(FAKE_STATUSFUL).toEqual(STATUS_RULES);
    expect(FAKE_WO_TRANSITIONS).toEqual(WO_TRANSITIONS);
  });

  it("作業指示の移り方。完了からはクローズだけ、クローズ・取消からはどこへも移れない。作業指示以外と知らないステータスは null（Maximo に任せる）", () => {
    expect(canChangeStatus("WORKORDER", "WAPPR", "COMP")).toBe(true);
    expect(canChangeStatus("WORKORDER", " inprg ", "comp")).toBe(true);
    expect(canChangeStatus("WORKORDER", "COMP", "INPRG")).toBe(false);
    expect(canChangeStatus("WORKORDER", "COMP", "CLOSE")).toBe(true);
    expect(canChangeStatus("WORKORDER", "CLOSE", "COMP")).toBe(false);
    expect(canChangeStatus("WORKORDER", "CAN", "WAPPR")).toBe(false);
    expect(canChangeStatus("WORKORDER", "XYZ", "COMP")).toBeNull();
    expect(canChangeStatus("PO", "APPR", "CLOSE")).toBeNull();
    expect(canChangeStatus(null, "WAPPR", "COMP")).toBeNull();
  });

  it("構造の属性から、決まりを当てるオブジェクトを見分ける（STATUS が無ければ null）", () => {
    expect(statusObjectKind(["SITEID", "WONUM", "STATUS"])).toBe("WORKORDER");
    expect(statusObjectKind(["siteid", "ponum", "revisionnum", "status"])).toBe("PO");
    expect(statusObjectKind(["PONUM", "STATUS"])).toBeNull();
    expect(statusObjectKind(["TICKETID", "STATUS"])).toBe("SR");
    expect(statusObjectKind(["WONUM", "DESCRIPTION"])).toBeNull();
    expect(statusObjectKind(["ASSETNUM", "STATUS"])).toBeNull();
  });

  it("戻せないステータス", () => {
    for (const s of ["CLOSE", " close ", "CAN", "CLOSED", "CANCELLED", "DECOMMISSIONED"]) expect(isIrreversibleStatus(s)).toBe(true);
    for (const s of ["COMP", "INPRG", "WAPPR", "APPR", "OPERATING"]) expect(isIrreversibleStatus(s)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("仮想 Maximo のステータスの変更", () => {
  const post = (fake: FakeMaximo, href: string, query: string, body: unknown, headers: Record<string, string> = {}) =>
    fake.fetch(`${href}?lean=1${query}`, {
      method: "POST",
      headers: { apikey: fake.apiKey, "x-method-override": "PATCH", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const change = (fake: FakeMaximo, wonum: string, body: Record<string, unknown>) => post(fake, fake.hrefOf("mxapiwo", woOf(fake, wonum).uid), "&action=wsmethod:changeStatus", body);
  const patch = (fake: FakeMaximo, wonum: string, body: Record<string, unknown>) => post(fake, fake.hrefOf("mxapiwo", woOf(fake, wonum).uid), "", body, { patchtype: "MERGE" });
  const reason = async (res: Response) => ((await res.json()) as { Error?: { reasonCode?: string } }).Error?.reasonCode;

  it("WAPPR → COMP → CLOSE。ステータスの日付と履歴の子が残り、クローズで履歴になって中身もステータスも変えられない", async () => {
    const fake = createFakeMaximo(statusSeed());
    expect((await change(fake, "WO3001", { status: "COMP", memo: "MX Stage" })).status).toBe(204);
    const wo = woOf(fake, "WO3001");
    expect(wo.attrs).toMatchObject({ status: "COMP", historyflag: false });
    expect(typeof wo.attrs.statusdate).toBe("string");
    expect(wo.children.wostatus!.map((c) => [c.attrs.status, c.attrs.memo])).toEqual([["COMP", "MX Stage"]]);

    expect((await change(fake, "WO3001", { status: "CLOSE" })).status).toBe(204);
    expect(woOf(fake, "WO3001").attrs).toMatchObject({ status: "CLOSE", historyflag: true });
    const p = await patch(fake, "WO3001", { description: "直したい" });
    expect(p.status).toBe(400);
    expect(await reason(p)).toBe("BMXAA4105E");
    const c = await change(fake, "WO3001", { status: "COMP" });
    expect(c.status).toBe(400);
    expect(await reason(c)).toBe("BMXAA4105E");
    expect(woOf(fake, "WO3001").attrs.description).toBe("ポンプ点検");
  });

  it("移れないステータス・一覧に無いステータス・未来の日付・前の変更より前の日付は断る", async () => {
    const fake = createFakeMaximo(statusSeed());
    const back = await change(fake, "WO3003", { status: "INPRG" });
    expect(back.status).toBe(400);
    expect(await reason(back)).toBe("BMXAA4590E");
    const unknown = await change(fake, "WO3001", { status: "DONE" });
    expect(unknown.status).toBe(400);
    expect(await reason(unknown)).toBe("BMXAA4590E");
    const future = await change(fake, "WO3001", { status: "INPRG", date: "2099-01-01T00:00:00Z" });
    expect(await reason(future)).toBe("BMXAA4599E");
    expect((await change(fake, "WO3001", { status: "INPRG" })).status).toBe(204);
    const earlier = await change(fake, "WO3001", { status: "COMP", date: "2001-01-01T00:00:00Z" });
    expect(await reason(earlier)).toBe("BMXAA4598E");
    expect(woOf(fake, "WO3001").attrs.status).toBe("INPRG");
  });

  it("ステータスは属性として変えられない。作ると初めのステータス（WAPPR）になる", async () => {
    const fake = createFakeMaximo(statusSeed());
    const p = await patch(fake, "WO3001", { status: "COMP" });
    expect(await reason(p)).toBe("BMXAA_FAKE_STATUS_ATTR");
    const create = (body: unknown) =>
      fake.fetch(`${fake.baseUrl}/maximo/api/os/mxapiwo?lean=1`, { method: "POST", headers: { apikey: fake.apiKey, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(await reason(await create({ siteid: "BEDFORD", wonum: "WO9001", status: "COMP" }))).toBe("BMXAA_FAKE_STATUS_ATTR");
    expect((await create({ siteid: "BEDFORD", wonum: "WO9001" })).status).toBe(201);
    expect(woOf(fake, "WO9001").attrs).toMatchObject({ status: "WAPPR", historyflag: false });
  });

  it("承認済みの注文書は、改訂しないと中身を変えられない", async () => {
    const fake = createFakeMaximo(statusSeed());
    const po = (n: string) => fake.find("mxapipo", (r) => r.attrs.ponum === n)!;
    const appr = await post(fake, fake.hrefOf("mxapipo", po("PO100").uid), "", { description: "x" }, { patchtype: "MERGE" });
    expect(appr.status).toBe(400);
    expect(await reason(appr)).toBe("BMXAA3889E");
    expect((await post(fake, fake.hrefOf("mxapipo", po("PO101").uid), "", { description: "x" }, { patchtype: "MERGE" })).status).toBe(204);
  });
});

// ---------------------------------------------------------------------------

describe("計画: ステータスは属性に入れず、作成・更新の後に変える", () => {
  it("STATUS の変更は plan.status になり、attrs に入らない。中身と一緒でもよい", async () => {
    const s = await setup();
    const plans = planCommit(s.meta, s.records, { ...none(), cells: [edit("WO3001", "STATUS", "INPRG"), edit("WO3001", "DESCRIPTION", "ポンプ点検（着手）"), edit("WO3004", "STATUS", "COMP")] });
    expect(plans.map((p) => [p.parentKey, p.attrs, p.status])).toEqual([
      [pk("WO3001"), { DESCRIPTION: "ポンプ点検（着手）" }, { to: "INPRG", from: "WAPPR" }],
      [pk("WO3004"), {}, { to: "COMP", from: "INPRG" }],
    ]);
  });

  it("新しいレコードの STATUS は作った後に変える（作るときには送らない）", async () => {
    const s = await setup();
    const [plan] = planCommit(s.meta, s.records, { ...none(), addedRows: [newWo("WO9001", { STATUS: "COMP", ACTSTART: "2015-06-01T09:00:00+09:00", ACTFINISH: "2015-06-01T17:00:00+09:00" })] });
    expect(plan!.attrs).not.toHaveProperty("STATUS");
    expect(plan!.attrs).toMatchObject({ ACTSTART: "2015-06-01T09:00:00+09:00", ACTFINISH: "2015-06-01T17:00:00+09:00" });
    expect(plan!.status).toEqual({ to: "COMP", from: null });
  });

  it("ステータスは空にできない", async () => {
    const s = await setup();
    let err: unknown;
    try {
      planCommit(s.meta, s.records, { ...none(), cells: [edit("WO3001", "STATUS", null)] }, { allowNull: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CommitInvariantError);
    expect((err as CommitInvariantError).hint).toBe("statusEmpty");
  });

  it("戻せないステータス（CLOSE・CAN）は、確認が無ければ I11 で止まる", async () => {
    const s = await setup();
    const changes = { ...none(), cells: [edit("WO3003", "STATUS", "CLOSE"), edit("WO3001", "STATUS", "CAN"), edit("WO3004", "STATUS", "COMP")] };
    expect(codeOf(() => planCommit(s.meta, s.records, changes))).toBe("I11");
    expect(planCommit(s.meta, s.records, changes, { irreversibleConfirmed: true })).toHaveLength(3);
    // COMP だけなら確認は要らない
    expect(codeOf(() => planCommit(s.meta, s.records, { ...none(), cells: [edit("WO3004", "STATUS", "COMP")] }))).toBeNull();
  });

  it("validatePlans: 属性の STATUS は I12。irreversibleConfirmed: false のときだけ戻せないステータスを I11 で止める", async () => {
    const s = await setup();
    const [plan] = planCommit(s.meta, s.records, { ...none(), cells: [edit("WO3003", "STATUS", "CLOSE")] }, { irreversibleConfirmed: true });
    expect(codeOf(() => validatePlans([plan!], { allowNull: false, deletesConfirmed: false }))).toBeNull();
    expect(codeOf(() => validatePlans([plan!], { allowNull: false, deletesConfirmed: false, irreversibleConfirmed: false }))).toBe("I11");
    expect(codeOf(() => validatePlans([{ ...plan!, attrs: { STATUS: "CLOSE" } }], { allowNull: false, deletesConfirmed: false }))).toBe("I12");
  });

  it("要求: 本文に status を入れた PATCH は I12。ステータスの変更は changeStatus の action に、日付を付けずに送る", async () => {
    const s = await setup();
    const [plan] = planCommit(s.meta, s.records, { ...none(), cells: [edit("WO3001", "DESCRIPTION", "x")] });
    const req = buildPatchRequest(plan!, "tx-1");
    expect(codeOf(() => assertSafePatchRequest({ ...req, body: { ...req.body, status: "COMP" } }, plan!))).toBe("I12");

    const path = new URL(s.records[0]!.href).pathname;
    expect(buildStatusRequest(path, { to: "COMP", from: "WAPPR" }, "tx-1-st")).toEqual({
      url: `${path}?action=wsmethod:changeStatus&lean=1`,
      method: "POST",
      headers: { "x-method-override": "PATCH", transactionid: "tx-1-st", "content-type": "application/json" },
      body: { status: "COMP", memo: "MX Stage" },
    });
    expect(codeOf(() => buildStatusRequest(path, { to: "COMP&x=1", from: null }, "tx"))).toBe("INPUT");
    expect(codeOf(() => buildStatusRequest("/maximo/api/os/mxapiwo", { to: "COMP", from: null }, "tx"))).toBe("I7");
  });
});

// ---------------------------------------------------------------------------

describe("反映: ステータスの変更", () => {
  it("中身とステータス: 中身を PATCH+MERGE（status なし）で送って確かめてから、changeStatus を送り、読み直して確かめる", async () => {
    const s = await setup();
    const plans = planCommit(s.meta, s.records, {
      ...none(),
      cells: [edit("WO3001", "DESCRIPTION", "ポンプ点検（着手）"), edit("WO3001", "ACTSTART", "2026-10-01T08:30:00+09:00"), edit("WO3001", "STATUS", "INPRG")],
    });
    const [r] = await run(s, plans);
    expect(r).toMatchObject({ rowKey: pk("WO3001"), status: "verified", sent: true, transactionId: "tx-0" });
    expect(woOf(s.fake, "WO3001").attrs).toMatchObject({ description: "ポンプ点検（着手）", actstart: "2026-10-01T08:30:00+09:00", status: "INPRG" });
    expect(woOf(s.fake, "WO3001").children.wostatus!.map((c) => c.attrs.status)).toEqual(["INPRG"]);

    expect(s.fake.state.requests.map((q) => q.method)).toEqual(["GET", "POST", "GET", "POST", "GET"]);
    const [content, status] = posts(s.fake);
    expect(content!.body).toEqual({ description: "ポンプ点検（着手）", actstart: "2026-10-01T08:30:00+09:00" });
    expect(content!.headers.patchtype).toBe("MERGE");
    expect(status!.path).toContain("action=wsmethod:changeStatus");
    expect(status!.headers.transactionid).toBe("tx-0-st");
    expect(status!.body).toEqual({ status: "INPRG", memo: "MX Stage" });
    // 送る前の確かめでステータスと履歴の印も読む
    expect(new URL(s.fake.state.requests[0]!.url).searchParams.get("oslc.select")).toBe("_rowstamp,description,actstart,status,historyflag");
    expect(writeLogEntry(plans[0]!, r!)).toMatchObject({ ops: { attrs: ["ACTSTART", "DESCRIPTION"], status: "INPRG" }, result: "verified" });
  });

  it("履歴（クローズ）・移れないステータスの行は送らずに skipped。他の行は続ける", async () => {
    const s = await setup();
    const plans = planCommit(s.meta, s.records, {
      ...none(),
      cells: [edit("WO3002", "DESCRIPTION", "配管更新（直し）"), edit("WO3003", "STATUS", "INPRG"), edit("WO3004", "DESCRIPTION", "計器校正（再）")],
    });
    const results = await run(s, plans);
    expect(results.map((r) => [r.rowKey, r.status, r.reasonCode ?? null, r.sent])).toEqual([
      [pk("WO3002"), "skipped", SKIP_HISTORY, false],
      [pk("WO3003"), "skipped", SKIP_STATUS_TRANSITION, false],
      [pk("WO3004"), "verified", null, true],
    ]);
    expect(results[0]!.message).toContain("CLOSE");
    expect(results[1]!.message).toContain("COMP");
    expect(posts(s.fake)).toHaveLength(1);
    expect(woOf(s.fake, "WO3002").attrs.description).toBe("配管更新（済）");
    expect(woOf(s.fake, "WO3003").attrs.status).toBe("COMP");
  });

  it("COMP の作業指示は中身を直せる（履歴ではない）", async () => {
    const s = await setup();
    const [r] = await run(s, planCommit(s.meta, s.records, { ...none(), cells: [edit("WO3003", "ACTFINISH", "2026-09-30T17:00:00+09:00")] }));
    expect(r).toMatchObject({ status: "verified" });
    expect(woOf(s.fake, "WO3003").attrs).toMatchObject({ status: "COMP", actfinish: "2026-09-30T17:00:00+09:00" });
  });

  it("新しい作業指示: status を送らずに作り、確かめてから COMP に変える。実績の日付は属性として残る", async () => {
    const s = await setup();
    const plans = planCommit(s.meta, s.records, { ...none(), addedRows: [newWo("WO9001", { STATUS: "COMP", ACTSTART: "2015-06-01T09:00:00+09:00", ACTFINISH: "2015-06-01T17:00:00+09:00" })] });
    const [r] = await run(s, plans);
    const rec = woOf(s.fake, "WO9001");
    expect(r).toMatchObject({ rowKey: pk("WO9001"), status: "verified", sent: true, createdHref: s.fake.hrefOf("mxapiwo", rec.uid) });
    expect(rec.attrs).toMatchObject({ status: "COMP", actstart: "2015-06-01T09:00:00+09:00", actfinish: "2015-06-01T17:00:00+09:00" });
    const [create, status] = posts(s.fake);
    expect(create!.path).toBe("/maximo/api/os/mxapiwo?lean=1");
    expect(create!.body).not.toHaveProperty("status");
    expect(status!.path).toBe(`${new URL(s.fake.hrefOf("mxapiwo", rec.uid)).pathname}?action=wsmethod:changeStatus&lean=1`);
  });

  it("作った後にステータスだけ変えられなければ error。作ったレコードの href は返す（行を付け替えるため）", async () => {
    const s = await setup();
    const [r] = await run(s, planCommit(s.meta, s.records, { ...none(), addedRows: [newWo("WO9002", { STATUS: "DONE" })] }));
    const rec = woOf(s.fake, "WO9002");
    expect(r).toMatchObject({ status: "error", sent: true, reasonCode: "BMXAA4590E", createdHref: s.fake.hrefOf("mxapiwo", rec.uid) });
    expect(r!.message).toContain("DONE");
    expect(rec.attrs.status).toBe("WAPPR");
  });

  it("changeStatus の応答が届かなくても、読み直して変わっていれば unknown（変わったことを伝える）", async () => {
    const s = await setup();
    // changeStatus を Maximo が処理した後に、通信が切れる
    const client = new MaximoClient({
      baseUrl: s.fake.baseUrl,
      apiKey: () => s.fake.apiKey,
      via: "direct",
      fetchImpl: async (input, init) => {
        const res = await s.fake.fetch(input, init);
        if (String(input).includes("changeStatus")) throw new TypeError("network error");
        return res;
      },
      sleep: async () => {},
    });
    const [r] = await run({ ...s, client }, planCommit(s.meta, s.records, { ...none(), cells: [edit("WO3004", "STATUS", "COMP")] }));
    expect(r).toMatchObject({ status: "unknown", sent: true });
    expect(woOf(s.fake, "WO3004").attrs.status).toBe("COMP");
  });

  it("承認済みの注文書は送らずに skipped（改訂が要る）。承認待ちは直せる", async () => {
    const s = await setup("MXAPIPO", ["DESCRIPTION", "STATUS"]);
    const key = (n: string) => makeParentKey(s.meta.keyColumns.map((k) => ({ SITEID: "BEDFORD", PONUM: n, REVISIONNUM: 0 })[k as "SITEID"]));
    const plans = planCommit(s.meta, s.records, { ...none(), cells: [{ rowKey: key("PO100"), col: "DESCRIPTION", value: "ポンプ部品（追加）" }, { rowKey: key("PO101"), col: "DESCRIPTION", value: "配管材（追加）" }] });
    expect(plans).toHaveLength(2);
    const results = await run(s, plans, { statusGuard: { kind: "PO", hasStatus: true, hasHistoryFlag: true } });
    expect(results.map((r) => [r.status, r.reasonCode ?? null])).toEqual([
      ["skipped", SKIP_PO_REVISION],
      ["verified", null],
    ]);
    expect(posts(s.fake)).toHaveLength(1);
  });
});
