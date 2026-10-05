// デモのデータ（第 2 版）を全部作って確かめる: 日英で同じ乱数（ID・件数・日付が同じ）、英語に日本語が残らない、
// 文字列が属性の最大長に収まる、場所の階層（PRIMARY・ELEC）、Maximo を入れた日、回転資産と在庫、外注の場面、正解の参照先。

import { describe, expect, it } from "vitest";
import type { CellValue } from "../../src/shared/model";
import { EN_DUPLICATE_KEYS } from "../../dev/datasets/plants/en";
import { plantsSeed } from "../../dev/datasets/plants/index";
import { NOW } from "../../dev/datasets/plants/generate";
import { hasJapanese } from "../../dev/datasets/plants/text";

const ja = plantsSeed({ lang: "ja" });
const en = plantsSeed({ lang: "en" });
const ms = (v: CellValue | undefined): number => Date.parse(String(v));

describe("日英", () => {
  it("辞書に重複したキーが無く、訳し漏れも無い", () => {
    expect(EN_DUPLICATE_KEYS).toEqual([]);
    expect(en.data.missingTranslations).toEqual([]);
  });

  it("ID・件数・日付・ステータス・子の数が日英で同じ", () => {
    const keys = ["assetnum", "location", "wonum", "ticketid", "itemnum", "pmnum", "invusenum", "status", "reportdate", "statusdate", "actstart", "actfinish", "installdate", "worktype", "classstructureid", "parent", "curbaltotal", "vendor", "binnum", "type"];
    for (const [name, os] of Object.entries(ja.seed.objectStructures)) {
      if (os.recordsFrom || name === "MXAPIPERSON" || name === "MXAPILABOR" || name === "MXAPIPERSONGROUP") continue;
      const a = os.records ?? [];
      const b = en.seed.objectStructures[name]?.records ?? [];
      expect(b.length, name).toBe(a.length);
      const diffs: string[] = [];
      a.forEach((r, i) => {
        for (const k of keys) if (k in r.attrs && b[i]!.attrs[k] !== r.attrs[k]) diffs.push(`${name}[${i}].${k}: ${String(r.attrs[k])} / ${String(b[i]!.attrs[k])}`);
        for (const [c, rows] of Object.entries(r.children ?? {})) if ((b[i]!.children?.[c] ?? []).length !== rows.length) diffs.push(`${name}[${i}].${c}`);
      });
      expect(diffs.slice(0, 10), name).toEqual([]);
    }
    expect(en.data.problems.map((p) => [p.id, p.count])).toEqual(ja.data.problems.map((p) => [p.id, p.count]));
  });

  it("英語のデータ（見出し・値の一覧・記録）に日本語が残っていない", () => {
    const found: string[] = [];
    const scan = (v: unknown, where: string) => {
      if (typeof v === "string" && hasJapanese(v)) found.push(`${where}: ${v}`);
    };
    for (const [name, os] of Object.entries(en.seed.objectStructures)) {
      for (const [a, d] of Object.entries(os.attrs)) scan(d.title, `${name}.${a}.title`);
      for (const [k, list] of Object.entries(os.lists ?? {})) for (const it of list) scan(it.description, `${name}.list.${k}`);
      for (const r of os.records ?? []) {
        for (const [a, v] of Object.entries(r.attrs)) scan(v, `${name}.${a}`);
        for (const [c, rows] of Object.entries(r.children ?? {})) for (const row of rows) for (const [a, v] of Object.entries(row)) scan(v, `${name}.${c}.${a}`);
      }
    }
    expect(found.slice(0, 10)).toEqual([]);
  });
});

describe.each([["ja", ja], ["en", en]] as const)("データの形（%s）", (_lang, set) => {
  const os = set.seed.objectStructures;
  const recs = (name: string) => os[name]?.records ?? [];

  it("文字列は属性の最大長に収まり、型が合う", () => {
    const bad: string[] = [];
    for (const [name, def] of Object.entries(os)) {
      for (const r of def.records ?? []) {
        for (const [a, v] of Object.entries(r.attrs)) {
          const d = def.attrs[a];
          if (!d) {
            bad.push(`${name}.${a} は定義に無い`);
            continue;
          }
          if (typeof v === "string" && d.maxLength !== undefined && v.length > d.maxLength) bad.push(`${name}.${a} ${v.length}>${d.maxLength}: ${v}`);
        }
        for (const [c, rows] of Object.entries(r.children ?? {})) {
          const cd = def.children?.[c];
          for (const row of rows) for (const [a, v] of Object.entries(row)) {
            const d = cd?.attrs[a];
            if (typeof v === "string" && d?.maxLength !== undefined && v.length > d.maxLength) bad.push(`${name}.${c}.${a} ${v.length}>${d.maxLength}`);
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it("場所の階層: 子ありの印が正しく、PRIMARY と ELEC の親が実在して根に届く", () => {
    for (const sys of ["PRIMARY", "ELEC"]) {
      const parent = new Map<string, CellValue>();
      const flag = new Map<string, CellValue>();
      for (const l of recs("MXAPIOPERLOC")) {
        for (const h of l.children?.lochierarchy ?? []) {
          if (h.systemid !== sys) continue;
          parent.set(`${l.attrs.siteid}|${l.attrs.location}`, h.parent ?? null);
          flag.set(`${l.attrs.siteid}|${l.attrs.location}`, h.children ?? null);
        }
      }
      expect(parent.size, sys).toBeGreaterThan(sys === "PRIMARY" ? 1000 : 100);
      const hasChild = new Set<string>();
      for (const [key, p] of parent) if (p !== null) hasChild.add(`${key.split("|")[0]}|${p}`);
      for (const [key, f] of flag) expect(f, `${sys} children ${key}`).toBe(hasChild.has(key));
      for (const [key, p] of parent) {
        const site = key.split("|")[0];
        let cur: CellValue = p;
        let steps = 0;
        while (cur !== null) {
          expect(parent.has(`${site}|${cur}`), `${sys} parent ${String(cur)} of ${key}`).toBe(true);
          cur = parent.get(`${site}|${cur}`) ?? null;
          expect(++steps).toBeLessThan(10);
        }
      }
    }
  });

  it("Maximo を入れる前の作業指示・SR・メーターの読みは無い（北部・南部は 2018-04）", () => {
    const goLive: Record<string, number> = { KITA: Date.parse("2018-04-01T00:00:00+09:00"), MINAMI: Date.parse("2018-04-01T00:00:00+09:00"), HIGASHI: Date.parse("2021-04-01T00:00:00+09:00") };
    for (const w of recs("MXAPIWODETAIL")) expect(ms(w.attrs.reportdate)).toBeGreaterThanOrEqual(goLive[String(w.attrs.siteid)]!);
    for (const s of recs("MXAPISR")) expect(ms(s.attrs.reportdate)).toBeGreaterThanOrEqual(goLive[String(s.attrs.siteid)]!);
    for (const m of recs("MXAPIMETERREADING")) expect(ms(m.attrs.readingdate)).toBeGreaterThanOrEqual(goLive[String(m.attrs.siteid)]!);
    // 入れる前に撤去した資産は Maximo に無い
    for (const a of recs("MXAPIASSET")) if (a.attrs.status === "DECOMMISSIONED") expect(ms(a.attrs.statusdate)).toBeGreaterThanOrEqual(goLive[String(a.attrs.siteid)]!);
  });

  it("回転資産: 予備品は倉庫か修理中にあり、品目は回転品目。在庫数は倉庫の予備品の台数と合う（問題として入れた分を除く）", () => {
    const rotating = new Set(recs("MXAPIITEM").filter((i) => i.attrs.rotating === true).map((i) => i.attrs.itemnum));
    const spares = recs("MXAPIASSET").filter((a) => String(a.attrs.assetnum).slice(1, 2) === "8");
    expect(spares.length).toBeGreaterThan(50);
    for (const s of spares) expect(String(s.attrs.location)).toMatch(/-(STORE|ESTORE|REPAIR)$/);
    const count = new Map<string, number>();
    for (const s of spares) if (!String(s.attrs.location).endsWith("REPAIR")) count.set(`${s.attrs.siteid}|${s.attrs.itemnum}|${s.attrs.location}`, (count.get(`${s.attrs.siteid}|${s.attrs.itemnum}|${s.attrs.location}`) ?? 0) + 1);
    let mismatch = 0;
    let checked = 0;
    for (const inv of recs("MXAPIINVENTORY")) {
      const id = String(inv.attrs.itemnum);
      if (!/^R(MT|IV|XM|CV)-/.test(id)) continue;
      checked++;
      expect(rotating.has(id) || set.data.problems.some((p) => p.id === "ITEM_ROTATING_FLAG_WRONG"), id).toBe(true);
      const n = count.get(`${inv.attrs.siteid}|${id}|${inv.attrs.location}`) ?? 0;
      if (n !== inv.attrs.curbaltotal) mismatch++;
    }
    expect(checked).toBeGreaterThan(30);
    expect(mismatch).toBe(set.data.problems.find((p) => p.id === "ROT_BALANCE_MISMATCH")?.count ?? 0);
  });

  it("在庫の残高は棚の残高の合計。払い出しは実在する作業指示と品目を指す", () => {
    for (const inv of recs("MXAPIINVENTORY")) {
      const sum = (inv.children?.invbalances ?? []).reduce((n, b) => n + Number(b.curbal), 0);
      expect(sum, String(inv.attrs.itemnum)).toBe(inv.attrs.curbaltotal);
    }
    const wonums = new Set(recs("MXAPIWODETAIL").map((w) => w.attrs.wonum));
    const items = new Set(recs("MXAPIITEM").map((i) => i.attrs.itemnum));
    for (const u of recs("MXAPIINVUSE")) {
      for (const l of u.children?.invuseline ?? []) {
        if (l.refwo !== null) expect(wonums.has(l.refwo), String(l.refwo)).toBe(true);
        expect(items.has(l.itemnum)).toBe(true);
      }
    }
  });

  it("外注: 2026 年度上半期は COMP で金額が空、過去は入力済み。実機で計算する費用は読み取り専用", () => {
    const wo = os.MXAPIWODETAIL!;
    for (const a of ["estservcost", "estatapprservcost", "actservcost"]) expect(wo.attrs[a]!.readOnly, a).toBe(true);
    for (const a of ["ext_ponum", "ext_assessamt", "ext_orderamt", "ext_acceptamt", "ext_podate", "ext_acceptdate", "ext_legal", "ext_dept"]) expect(wo.attrs[a]!.readOnly, a).toBeUndefined();
    const current = set.data.truth.orders.filter((o) => o.kind === "WO" && o.current);
    expect(current.length).toBeGreaterThan(60);
    for (const o of current) {
      const w = o.wo!;
      expect(w.attrs.status, String(w.wonum)).not.toBe("CLOSE");
      expect(w.attrs.ext_ponum).toBeNull();
      if (!o.prefilled) expect(w.attrs.ext_orderamt).toBeNull();
    }
    const past = recs("MXAPIWODETAIL").filter((w) => w.attrs.ext_ponum !== null && ms(w.attrs.reportdate) < Date.parse("2026-04-01T00:00:00+09:00"));
    expect(past.length).toBeGreaterThan(500);
  });

  it("正解が指す作業指示・資産が Maximo のデータにある", () => {
    const wonums = new Set(recs("MXAPIWODETAIL").map((w) => w.attrs.wonum));
    const assets = new Set(recs("MXAPIASSET").map((a) => a.attrs.assetnum));
    for (const o of set.data.truth.orders) for (const w of o.wos) expect(wonums.has(w.wonum ?? ""), `order ${o.ponum}`).toBe(true);
    for (const r of set.data.truth.repairs) expect(wonums.has(r.wo.wonum ?? ""), "repair").toBe(true);
    for (const l of set.data.truth.legacy) expect(assets.has(l.assetnum)).toBe(l.inMaximo);
    for (const x of set.data.truth.ledger) {
      if (x.kind === "REPLACED") expect(assets.has(x.old!.assetnum)).toBe(true);
      else if (x.kind === "ADDED") expect(assets.has(x.asset.assetnum)).toBe(false);
      else expect(assets.has(x.asset.assetnum)).toBe(true);
    }
    // 星取表の出来事は Maximo を入れる前だけ
    for (const e of set.data.truth.history) expect(e.date).toBeLessThan(set.data.truth.goLive[e.site]!);
    expect(set.data.truth.history.length).toBeGreaterThan(10_000);
  });

  it("基準日より後の実績は無い", () => {
    for (const w of recs("MXAPIWODETAIL")) {
      for (const h of w.children?.wostatus ?? []) expect(ms(h.changedate)).toBeLessThanOrEqual(NOW);
      if (w.attrs.actfinish !== null) expect(ms(w.attrs.actfinish)).toBeLessThanOrEqual(NOW);
    }
  });
});
