// 開発用の大きなデータ（dev/datasets/plants）の整合を確かめる。全部を作ると重いので、小さい施設と、
// 期間を絞った古い施設で確かめる（資産・場所・PM は全部、作業指示・SR・メーターの読みは期間の分だけ）。

import { describe, expect, it } from "vitest";
import type { CellValue } from "../../src/shared/model";
import { createFakeMaximo } from "../fakes/fake-maximo";
import { generatePlants, plantsSeed, type PlantsData } from "../../dev/datasets/plants/index";
import { NOW } from "../../dev/datasets/plants/generate";

const higashi = plantsSeed({ sites: ["HIGASHI"], baseUrl: "https://maximo.test" });
const kita = generatePlants({ sites: ["KITA"], historyFrom: "2025-10-01T00:00:00+09:00" });

const ms = (v: CellValue | undefined): number => Date.parse(String(v));
const rows = (d: PlantsData, t: string) => d.tables[t] ?? [];

const ORDER: Record<string, string[]> = {
  WAPPR: ["APPR", "CAN"],
  APPR: ["INPRG", "WMATL", "CAN"],
  WMATL: ["APPR"],
  INPRG: ["COMP"],
  COMP: ["CLOSE"],
};

describe.each([
  ["HIGASHI（全期間）", higashi.data],
  ["KITA（直近 1 年）", kita],
])("plants データの整合: %s", (_name, data) => {
  it("資産の場所・親・分類の仕様が実在する", () => {
    const locs = new Set(rows(data, "LOCATIONS").map((r) => `${r.attrs.siteid}|${r.attrs.location}`));
    const assets = new Set(rows(data, "ASSET").map((r) => `${r.attrs.siteid}|${r.attrs.assetnum}`));
    const classSpecs = new Map(rows(data, "CLASSSTRUCTURE").map((r) => [r.attrs.classstructureid ?? null, new Set((r.children?.classspec ?? []).map((s) => s.assetattrid ?? null))]));
    expect(assets.size).toBe(rows(data, "ASSET").length);
    for (const a of rows(data, "ASSET")) {
      expect(locs.has(`${a.attrs.siteid}|${a.attrs.location}`), `location of ${a.attrs.assetnum}`).toBe(true);
      if (a.attrs.parent !== null) expect(assets.has(`${a.attrs.siteid}|${a.attrs.parent}`), `parent of ${a.attrs.assetnum}`).toBe(true);
      const specs = a.children?.assetspec ?? [];
      if (specs.length > 0) {
        const allowed = classSpecs.get(a.attrs.classstructureid ?? null);
        expect(allowed, `class of ${a.attrs.assetnum}`).toBeDefined();
        for (const s of specs) expect(allowed!.has(s.assetattrid ?? null), `${a.attrs.assetnum} ${s.assetattrid}`).toBe(true);
      }
      if (a.attrs.status === "DECOMMISSIONED") expect(a.attrs.isrunning).toBe(false);
    }
  });

  it("場所の階層の親が実在し、施設の根に届く", () => {
    const parent = new Map<string, CellValue>();
    for (const l of rows(data, "LOCATIONS")) for (const h of l.children?.lochierarchy ?? []) parent.set(`${l.attrs.siteid}|${l.attrs.location}`, h.parent ?? null);
    for (const [key, p] of parent) {
      const site = key.split("|")[0];
      let cur: CellValue = p;
      let steps = 0;
      while (cur !== null) {
        expect(parent.has(`${site}|${cur}`), `parent ${String(cur)} of ${key}`).toBe(true);
        cur = parent.get(`${site}|${cur}`) ?? null;
        expect(++steps).toBeLessThan(10);
      }
    }
  });

  it("作業指示の日付の順序とステータスの履歴が合う", () => {
    const wos = rows(data, "WORKORDER");
    expect(wos.length).toBeGreaterThan(100);
    const wonums = new Set(wos.map((w) => w.attrs.wonum));
    const srs = new Set(rows(data, "SR").map((s) => s.attrs.ticketid));
    for (const w of wos) {
      const a = w.attrs;
      const hist = w.children?.wostatus ?? [];
      expect(hist[0]?.status, String(a.wonum)).toBe("WAPPR");
      expect(hist[hist.length - 1]?.status, String(a.wonum)).toBe(a.status);
      for (let i = 1; i < hist.length; i++) {
        expect(ORDER[String(hist[i - 1]!.status)], `${a.wonum} ${hist[i - 1]!.status}→${hist[i]!.status}`).toContain(hist[i]!.status);
        expect(ms(hist[i]!.changedate)).toBeGreaterThanOrEqual(ms(hist[i - 1]!.changedate));
      }
      expect(ms(hist[hist.length - 1]!.changedate)).toBeLessThanOrEqual(NOW);
      expect(ms(hist[0]!.changedate)).toBe(ms(a.reportdate));
      if (a.actstart !== null) expect(ms(a.actstart)).toBeGreaterThanOrEqual(ms(a.reportdate));
      if (a.actfinish !== null) expect(ms(a.actfinish)).toBeGreaterThanOrEqual(ms(a.actstart));
      if (a.status === "COMP" || a.status === "CLOSE") expect(a.actfinish, String(a.wonum)).not.toBeNull();
      if (a.schedstart !== null) expect(ms(a.schedfinish)).toBeGreaterThanOrEqual(ms(a.schedstart));
      if (a.parent !== null) expect(wonums.has(a.parent)).toBe(true);
      if (a.origrecordid !== null) expect(srs.has(a.origrecordid)).toBe(true);
    }
  });

  it("PM・作業指示・SR が指す資産・場所・作業計画が実在する", () => {
    const locs = new Set(rows(data, "LOCATIONS").map((r) => r.attrs.location));
    const assets = new Set(rows(data, "ASSET").map((r) => r.attrs.assetnum));
    const jps = new Set(rows(data, "JOBPLAN").map((r) => r.attrs.jpnum));
    const pms = new Set(rows(data, "PM").map((r) => r.attrs.pmnum));
    for (const t of ["PM", "WORKORDER", "SR"]) {
      for (const r of rows(data, t)) {
        if (r.attrs.assetnum !== null) expect(assets.has(r.attrs.assetnum), `${t} asset ${r.attrs.assetnum}`).toBe(true);
        if (r.attrs.location !== null) expect(locs.has(r.attrs.location), `${t} location ${r.attrs.location}`).toBe(true);
        if (r.attrs.jpnum !== undefined && r.attrs.jpnum !== null) expect(jps.has(r.attrs.jpnum)).toBe(true);
        if (t === "WORKORDER" && r.attrs.pmnum !== null) expect(pms.has(r.attrs.pmnum)).toBe(true);
      }
    }
  });

  it("仕込んだデータ品質の問題に件数がある", () => {
    expect(data.problems.length).toBeGreaterThan(10);
    for (const p of data.problems) expect(p.count).toBeGreaterThan(0);
  });
});

describe("plants の偽の Maximo", () => {
  const fake = createFakeMaximo(higashi.seed);
  const get = async (path: string) => {
    const res = await fake.fetch(`https://maximo.test/maximo/api/${path}`, { headers: { apikey: fake.apiKey } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("値の一覧（lists）がある属性の値は、すべて一覧の中にある", () => {
    for (const [name, os] of Object.entries(higashi.seed.objectStructures)) {
      const recs = os.records ?? [];
      for (const [key, list] of Object.entries(os.lists ?? {})) {
        const allowed = new Set(list.map((i) => i.value));
        const [child, attr] = key.includes(".") ? key.split(".") : [null, key];
        for (const r of recs) {
          const values = child ? (r.children?.[child] ?? []).map((c) => c[attr!]) : [r.attrs[attr!]];
          for (const v of values) if (v !== null && v !== undefined) expect(allowed.has(String(v)), `${name}.${key} = ${String(v)}`).toBe(true);
        }
      }
    }
  });

  it("標準の構造名で読め、子・絞り込み・ページ送り・getlist が使える", async () => {
    const meta = await get("apimeta?lean=1");
    const names = (meta.body as unknown as Array<{ name: string }>).map((x) => x.name);
    for (const n of ["MXAPIASSET", "MXAPIOPERLOC", "MXAPIWODETAIL", "MXAPIWO", "MXAPISR", "MXAPIPM", "MXAPIJOBPLAN", "MXAPIDOMAIN", "MXAPIINTOBJECT"]) expect(names).toContain(n);
    const where = encodeURIComponent('siteid="HIGASHI" and worktype in ["CM","EM"] and reportdate>="2024-01-01" and description="%号炉%"');
    const page = await get(`os/mxapiwodetail?lean=1&oslc.select=wonum,status,wostatus{status,changedate},failurereport{type,failurecode}&oslc.where=${where}&oslc.orderBy=-wonum&oslc.pageSize=50&collectioncount=1`);
    expect(page.status).toBe(200);
    const info = page.body.responseInfo as { totalCount: number; nextPage?: unknown };
    expect(info.totalCount).toBeGreaterThan(50);
    expect(info.nextPage).toBeDefined();
    const members = page.body.member as Array<Record<string, unknown>>;
    expect(members).toHaveLength(50);
    expect(Array.isArray(members[0]!.wostatus)).toBe(true);
    // MXAPIWO は同じ行（子なし）
    const wo = await get(`os/mxapiwo?lean=1&oslc.select=wonum&oslc.where=${where}&collectioncount=1`);
    expect((wo.body.responseInfo as { totalCount: number }).totalCount).toBe(info.totalCount);
    const href = String(members[0]!.href);
    const id = href.slice(href.lastIndexOf("/") + 1);
    const list = await get(`os/mxapiwodetail/${id}/getlist~status?lean=1`);
    expect((list.body.member as Array<{ value: string }>).map((m) => m.value)).toContain("CLOSE");
  });

  it("書き込むと、覚えておいた絞り込みの結果を捨てる（MXAPIWO からも見える）", async () => {
    const q = (os: string) => get(`os/${os}?lean=1&oslc.select=wonum&oslc.where=${encodeURIComponent('description="%書き込み確認%"')}&collectioncount=1`);
    expect(((await q("mxapiwo")).body.responseInfo as { totalCount: number }).totalCount).toBe(0);
    // 履歴（CLOSE・CAN）の作業指示は中身を変えられないので、仕掛かりのものに書く
    const target = fake.records("MXAPIWODETAIL").find((r) => r.attrs.historyflag !== true && !["CLOSE", "CAN"].includes(String(r.attrs.status)))!;
    const res = await fake.fetch(`${fake.hrefOf("mxapiwodetail", target.uid)}?lean=1`, {
      method: "POST",
      headers: { apikey: fake.apiKey, "x-method-override": "PATCH", patchtype: "MERGE", "content-type": "application/json" },
      body: JSON.stringify({ description: "書き込み確認" }),
    });
    expect(res.status).toBe(204);
    expect(((await q("mxapiwo")).body.responseInfo as { totalCount: number }).totalCount).toBe(1);
    expect(((await q("mxapiwodetail")).body.responseInfo as { totalCount: number }).totalCount).toBe(1);
  });
});
