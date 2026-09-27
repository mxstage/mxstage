// 範囲決めの機械化（scope_options の中身）の試験。
// - 軸は構造の属性から機械的に選ぶ（同じ構造なら毎回同じ軸・同じ順）
// - Maximo を軽く走査して軸ごとの件数を数える。行はシートに残さない
// - 値の種類が多すぎる軸は候補から外し、skipped に出す

import { describe, expect, it } from "vitest";
import { MaximoClient } from "../../src/app/maximo/client";
import { getObjectStructureInfo } from "../../src/app/maximo/meta";
import { axesFor, pickScopeAxes } from "../../src/app/scope/axes";
import { keyPattern, scanScope } from "../../src/app/scope/scan";
import { createFakeMaximo, type FakeRecordSeed, type FakeSeed } from "../fakes/fake-maximo";

/** 工事管理に近い構造（キー・状態・分類・部署・種別・期間・自由記述・桁の長い列） */
function woSeed(records: FakeRecordSeed[] = []): FakeSeed {
  return {
    objectStructures: {
      EXT_WO: {
        description: "工事管理",
        keyAttrs: ["siteid", "wonum"],
        attrs: {
          siteid: { type: "string", maxLength: 8, required: true, title: "サイト" },
          wonum: { type: "string", maxLength: 25, required: true, title: "工事管理No." },
          status: { type: "string", maxLength: 16, title: "ステータス" },
          classstructureid: { type: "string", maxLength: 20, title: "分類" },
          persongroup: { type: "string", maxLength: 8, title: "担当グループ" },
          ext_deptname: { type: "string", maxLength: 30, title: "計上部署名" },
          worktype: { type: "string", maxLength: 5, title: "作業タイプ" },
          location: { type: "string", maxLength: 25, title: "ロケーション" },
          reportdate: { type: "datetime", title: "報告日" },
          schedstart: { type: "date", title: "予定開始日" },
          description: { type: "string", maxLength: 100, title: "説明" },
          ext_memo: { type: "string", maxLength: 200, title: "備考" },
          estdur: { type: "number", title: "予定時間" },
          ext_applied: { type: "boolean", title: "申請あり" },
        },
        records,
      },
    },
  };
}

function rows(): FakeRecordSeed[] {
  const out: FakeRecordSeed[] = [];
  const statuses = ["作成中", "作成中", "承認済み", "工事中"];
  for (let i = 0; i < 12; i++) {
    out.push({
      attrs: {
        siteid: "BEDFORD",
        wonum: `WO10${String(100 + i).padStart(4, "0")}`,
        status: statuses[i % statuses.length]!,
        classstructureid: i % 3 === 0 ? "1001" : "1002",
        persongroup: i % 2 === 0 ? "機械保全" : "電気保全",
        ext_deptname: "製造部",
        worktype: i % 4 === 0 ? "PM" : "CM",
        location: `P-25${String(i).padStart(2, "0")}`,
        reportdate: i < 6 ? "2026-04-01T09:00:00+09:00" : "2025-11-20T09:00:00+09:00",
        schedstart: null,
        description: `説明 ${i}`,
        estdur: i,
      },
    });
  }
  // 1 件だけ別サイト・別の番号の形
  out.push({ attrs: { siteid: "TKY", wonum: "RQ260416", status: "作成中", persongroup: null, reportdate: "2026-09-01T09:00:00+09:00" } });
  return out;
}

function clientFor(seed: FakeSeed) {
  const fake = createFakeMaximo(seed);
  return { fake, client: new MaximoClient({ baseUrl: fake.baseUrl, apiKey: () => fake.apiKey, via: "direct", fetchImpl: fake.fetch, sleep: async () => {} }) };
}

describe("絞り込みの軸を構造から機械的に選ぶ（pickScopeAxes）", () => {
  it("観点の順（状態→分類→担当・部署→種別→場所→期間→番号）に並べ、自由記述・桁の長い列・数値・真偽値は選ばない", async () => {
    const { client } = clientFor(woSeed());
    const info = await getObjectStructureInfo(client, "EXT_WO");
    const axes = pickScopeAxes(info, { max: 10 });
    expect(axes.map((a) => [a.name, a.kind, a.reason])).toEqual([
      ["STATUS", "value", "状態"],
      ["CLASSSTRUCTUREID", "value", "分類"],
      ["PERSONGROUP", "value", "担当・部署"],
      ["EXT_DEPTNAME", "value", "担当・部署"],
      ["WORKTYPE", "value", "種別"],
      ["LOCATION", "value", "場所"],
      ["SITEID", "value", "場所"],
      ["REPORTDATE", "date", "期間"],
      ["SCHEDSTART", "date", "期間"],
      ["WONUM", "key", "番号の規則"],
    ]);
    // 同じ構造なら何度呼んでも同じ（利用者への聞き方が毎回変わらない）
    expect(pickScopeAxes(info, { max: 10 })).toEqual(axes);
    const names = axes.map((a) => a.name);
    for (const excluded of ["DESCRIPTION", "EXT_MEMO", "ESTDUR", "EXT_APPLIED"]) expect(names).not.toContain(excluded);
  });

  it("max で数を絞る（既定 8）", async () => {
    const { client } = clientFor(woSeed());
    const info = await getObjectStructureInfo(client, "EXT_WO");
    expect(pickScopeAxes(info)).toHaveLength(8);
    expect(pickScopeAxes(info, { max: 3 }).map((a) => a.name)).toEqual(["STATUS", "CLASSSTRUCTUREID", "PERSONGROUP"]);
  });

  it("axes で名指しすれば、自動では選ばない列（真偽値など）も軸にできる", async () => {
    const { client } = clientFor(woSeed());
    const info = await getObjectStructureInfo(client, "EXT_WO");
    expect(axesFor(info, ["ext_applied", "reportdate", "NOSUCH"])).toEqual([
      { name: "EXT_APPLIED", kind: "value", reason: "指定", title: "申請あり" },
      { name: "REPORTDATE", kind: "date", reason: "期間", title: "報告日" },
    ]);
  });

  it("keyPattern は数字を # にする（番号の規則で絞れるように）", () => {
    expect(keyPattern("WO100906")).toBe("WO######");
    expect(keyPattern("RQ260416")).toBe("RQ######");
  });
});

describe("Maximo を軽く走査して件数を数える（scanScope）", () => {
  it("軸ごとの候補値と件数・期間・番号の形を返し、行は返さない", async () => {
    const { fake, client } = clientFor(woSeed(rows()));
    const info = await getObjectStructureInfo(client, "EXT_WO");
    const axes = pickScopeAxes(info, { max: 10 });
    const res = await scanScope(client, info, axes, { limit: 5 });

    expect(res.scanned).toBe(13);
    expect(res.total).toBe(13);
    expect(res.truncated).toBe(false);
    const byName = new Map(res.axes.map((a) => [a.name, a]));
    expect(byName.get("STATUS")?.values).toEqual([
      { value: "作成中", count: 7 },
      { value: "工事中", count: 3 },
      { value: "承認済み", count: 3 },
    ]);
    expect(byName.get("PERSONGROUP")).toMatchObject({ distinct: 2, emptyCount: 1 });
    expect(byName.get("REPORTDATE")).toMatchObject({ min: "2025-11-20", max: "2026-09-01" });
    expect(byName.get("REPORTDATE")?.buckets).toEqual([
      { value: "2026-09", count: 1 },
      { value: "2026-04", count: 6 },
      { value: "2025-11", count: 6 },
    ]);
    expect(byName.get("WONUM")?.patterns).toEqual([
      { pattern: "WO######", count: 12, example: "WO100100" },
      { pattern: "RQ######", count: 1, example: "RQ260416" },
    ]);
    // 走査は軸の列だけを読む（説明や備考は読まない）。1 ページを大きく取る
    const scan = fake.state.requests.filter((r) => r.path.includes("/os/ext_wo"));
    expect(scan).toHaveLength(1);
    const query = decodeURIComponent(scan[0]!.path);
    expect(query).toContain("oslc.pageSize=1000");
    expect(query).toContain("status");
    expect(query).not.toContain("ext_memo");
  });

  it("where で絞った中の分布を返す", async () => {
    const { client } = clientFor(woSeed(rows()));
    const info = await getObjectStructureInfo(client, "EXT_WO");
    const axes = axesFor(info, ["STATUS", "WORKTYPE"]);
    const res = await scanScope(client, info, axes, { where: [{ attr: "SITEID", op: "eq", value: "BEDFORD" }], limit: 5 });
    expect(res.scanned).toBe(12);
    expect(res.axes.find((a) => a.name === "WORKTYPE")?.values).toEqual([
      { value: "CM", count: 9 },
      { value: "PM", count: 3 },
    ]);
  });

  it("値の種類が多すぎる軸は候補から外して skipped に出す", async () => {
    const many: FakeRecordSeed[] = [];
    for (let i = 0; i < 250; i++) many.push({ attrs: { siteid: "BEDFORD", wonum: `WO${String(i).padStart(6, "0")}`, location: `L-${i}`, status: "作成中" } });
    const { client } = clientFor(woSeed(many));
    const info = await getObjectStructureInfo(client, "EXT_WO");
    const res = await scanScope(client, info, axesFor(info, ["LOCATION", "STATUS"]), { limit: 5 });
    expect(res.axes.map((a) => a.name)).toEqual(["STATUS"]);
    expect(res.skipped).toEqual([{ name: "LOCATION", title: "ロケーション", reason: "場所", distinct: 250 }]);
  });

  it("上限で打ち切ったら truncated にする（偏った標本だと分かるように）", async () => {
    const many: FakeRecordSeed[] = [];
    for (let i = 0; i < 30; i++) many.push({ attrs: { siteid: "BEDFORD", wonum: `WO${String(i).padStart(6, "0")}`, status: i < 10 ? "作成中" : "承認済み" } });
    const { client } = clientFor(woSeed(many));
    const info = await getObjectStructureInfo(client, "EXT_WO");
    const res = await scanScope(client, info, axesFor(info, ["STATUS"]), { maxScan: 10 });
    expect(res).toMatchObject({ scanned: 10, total: 30, truncated: true });
    expect(res.axes[0]!.values).toEqual([{ value: "作成中", count: 10 }]);
  });
});
