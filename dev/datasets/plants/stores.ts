// 倉庫と在庫: 回転品目（電動機・インバータ・伝送器・調節弁）と予備品、資産の予備品の一覧（SPAREPART）、
// 在庫（INVENTORY・INVBALANCES・INVCOST）と払い出し（INVUSE）。在庫の数は払い出しと補充から計算するので、表どうしが噛み合う。

import { CAUSE_ITEMS, INSTRUMENTS, ITEMSETID, ITEM_TEMPLATES, ORGID, ROTATING_CLASSES, SPARE_PARTS } from "./catalog.ts";
import { NOW, type Asset, type Ids, type ItemsBuilt, type Problems, type Rec, type Row, type SiteContext, type WoDraft } from "./generate.ts";
import type { Text } from "./text.ts";
import { DAY, Rng, addMonths, atTime, fmt, jst, pad, round, seedOf, ymd } from "./util.ts";

export interface RotatingItem {
  itemnum: string;
  key: string;
  cls: string;
  desc: string;
  /** 単価（円） */
  cost: number;
  store: "STORE" | "ESTORE";
  /** 予備品の元にする資産（仕様を写す） */
  rep: Asset;
}

export interface RotatingBuilt {
  byKey: Map<string, RotatingItem>;
  byAsset: Map<string, RotatingItem>;
}

export interface StoresTruth {
  spares: number;
  issues: number;
}

const num = (rows: Row[] | null, attr: string): number | null => {
  const v = (rows ?? []).find((r) => r.assetattrid === attr)?.numvalue;
  return typeof v === "number" ? v : null;
};
const aln = (rows: Row[] | null, attr: string): string | null => {
  const v = (rows ?? []).find((r) => r.assetattrid === attr)?.alnvalue;
  return typeof v === "string" ? v : null;
};

/** 回転品目のキーと説明（言語によらないキーにする: 日英で同じ品目番号になる） */
function rotatingKey(a: Asset, tx: Text): { key: string; desc: string; cost: number } | null {
  const s = a.specsTrue;
  switch (a.pos.cls) {
    case "MOTOR": {
      const kw = a.pos.kw;
      const poles = num(s, "POLES");
      const volt = num(s, "RATED_VOLTAGE");
      if (kw === undefined || poles === null || volt === null) return null;
      return { key: `MOTOR|${kw}|${poles}|${volt}`, desc: `${tx.t("電動機")} ${volt}V ${poles}P ${kw}kW`, cost: Math.round((40_000 + 28_000 * kw ** 0.85) / 1000) * 1000 };
    }
    case "INV": {
      const kva = num(s, "RATED_KVA");
      const volt = num(s, "RATED_VOLTAGE");
      if (kva === null || volt === null) return null;
      return { key: `INV|${kva}|${volt}`, desc: `${tx.t("インバータ")} ${volt}V ${kva}kVA`, cost: Math.round((90_000 + 18_000 * kva ** 0.75) / 1000) * 1000 };
    }
    case "XMTR": {
      const t = a.pos.item?.t;
      const range = aln(s, "MEAS_RANGE");
      if (!t || !INSTRUMENTS[t] || range === null) return null;
      return { key: `XMTR|${t}|${range}`, desc: `${tx.t(INSTRUMENTS[t]!.n)} ${range}`, cost: 180_000 + (seedOf(t + range) % 12) * 10_000 };
    }
    case "CVALVE": {
      const bore = num(s, "BORE");
      const rating = aln(s, "PRESS_RATING");
      if (bore === null || rating === null) return null;
      return { key: `CVALVE|${bore}|${rating}`, desc: `${tx.t("調節弁")} ${bore}A ${rating}`, cost: Math.round((150_000 + bore * 4_000) / 1000) * 1000 };
    }
  }
  return null;
}

/** 回転品目を作り、資産に品目を付け、施設ごとに予備品（倉庫・修理中）を作る */
export function buildRotating(ctxs: SiteContext[], items: ItemsBuilt, rng: Rng, problems: Problems, tx: Text): RotatingBuilt {
  const byKey = new Map<string, RotatingItem>();
  const byAsset = new Map<string, RotatingItem>();
  const counters = new Map<string, number>();
  for (const ctx of ctxs) {
    for (const a of ctx.assets) {
      if (a.duplicate || !ROTATING_CLASSES[a.pos.cls]) continue;
      const k = rotatingKey(a, tx);
      if (!k) continue;
      let item = byKey.get(k.key);
      if (!item) {
        const def = ROTATING_CLASSES[a.pos.cls]!;
        const n = (counters.get(def.prefix) ?? 0) + 1;
        counters.set(def.prefix, n);
        item = { itemnum: `${def.prefix}-${pad(n, 4)}`, key: k.key, cls: a.pos.cls, desc: k.desc, cost: k.cost, store: def.store === "E" ? "ESTORE" : "STORE", rep: a };
        byKey.set(k.key, item);
        items.cost.set(item.itemnum, item.cost);
        items.records.push({
          attrs: {
            itemnum: item.itemnum, itemsetid: ITEMSETID, description: item.desc, status: "ACTIVE", orderunit: "EA", issueunit: "EA", commoditygroup: def.commodity,
            rotating: true, lottype: "NOLOT", itemtype: "ITEM", inspectionrequired: false, itemid: items.records.length + 1,
          },
        });
      }
      byAsset.set(a.assetnum, item);
      a.itemnum = item.itemnum;
    }
  }
  // データ品質: 回転品目の印（ROTATING）が付いていない品目（資産は品目を指している）
  const rotRecords = items.records.filter((r) => r.attrs.rotating === true);
  for (let i = 0; i < 2 && rotRecords.length > 0; i++) {
    const r = rotRecords[(i * 7 + 3) % rotRecords.length]!;
    if (r.attrs.rotating === false) continue;
    r.attrs.rotating = false;
    problems.add("ITEM_ROTATING_FLAG_WRONG", "資産が使っている回転品目に回転資産（ROTATING）の印が無い", "ITEM.ROTATING");
  }

  for (const ctx of ctxs) {
    const r = rng.fork(ctx.site.siteid);
    // データ品質: 移した資産の一部に品目が付いていない
    for (const a of ctx.assets) {
      if (!a.itemnum) continue;
      if (ctx.legacy && a.install < ctx.goLive && r.chance(0.06)) {
        a.itemnum = null;
        if (ctx.inMaximo(a)) problems.add("ROT_ASSET_NO_ITEM", "回転資産の分類（電動機など）なのに品目（ITEMNUM）が付いていない", "ASSET.ITEMNUM");
      }
    }
    // 予備品: 稼働中の台数が多い品目ほど予備を持つ
    const counts = new Map<string, number>();
    for (const a of ctx.assets) {
      const it = byAsset.get(a.assetnum);
      if (!it || a.decom !== null || a.hidden) continue;
      counts.set(it.key, (counts.get(it.key) ?? 0) + 1);
    }
    let spareNo = 0;
    for (const [key, n] of counts) {
      const it = byKey.get(key)!;
      const spares = n >= 8 ? 2 : n >= 3 ? 1 : 0;
      for (let k = 0; k < spares; k++) {
        const rep = it.rep;
        const install = atTime(jst(r.int(2019, 2025), r.int(1, 12), r.int(1, 28)), 10);
        const repair = r.chance(0.07);
        const sentAt = repair ? atTime(NOW - r.int(30, 700) * DAY, 10) : null;
        const store = `${ctx.p}-${it.store}`;
        const a: Asset = {
          assetnum: String(ctx.site.assetBase + 800_000 + ++spareNo), pos: rep.pos, install, decom: null, desc: tx.spareDesc(it.desc), descJa: `予備品 ${it.key}`,
          tag: null, location: repair ? `${ctx.p}-REPAIR` : store, parent: null, serial: `${it.itemnum.slice(1, 3)}${String(ymd(install).y).slice(2)}-${r.int(10000, 99999)}`,
          maker: rep.makerTrue, vendor: "VND-SA", specs: (rep.specsTrue ?? []).map((row) => ({ ...row, assetspecid: ctx.ids.next("assetspecid"), changedate: fmt(install) })),
          meters: [], cls: rep.pos.cls, itemnum: it.itemnum, binnum: repair ? null : `${it.store === "ESTORE" ? "E" : "R"}-${pad(r.int(1, 12), 2)}-${pad(r.int(1, 6), 2)}`,
          spare: true, serialTrue: null, makerTrue: rep.makerTrue, specsTrue: null,
        };
        a.serialTrue = a.serial;
        ctx.assets.push(a);
        if (sentAt !== null && sentAt < NOW - 365 * DAY) problems.add("ROT_STUCK_IN_REPAIR", "修理に出した予備品が 1 年以上戻っていない（場所が修理中のまま）", "ASSET.LOCATION（REPAIR）");
      }
    }
  }
  // 資産の予備品の一覧（SPAREPART）。表に書き出す前に付ける
  const itemByNum = new Map(items.records.map((r) => [String(r.attrs.itemnum), r]));
  for (const ctx of ctxs) {
    for (const a of ctx.assets) {
      if (a.duplicate || a.spare || a.decom !== null) continue;
      const parts = SPARE_PARTS[a.pos.cls];
      if (!parts) continue;
      a.spareparts = [];
      for (const [key, qty] of parts) {
        const list = items.allByKey.get(key) ?? [];
        if (list.length === 0) continue;
        const itemnum = list[seedOf(`${a.assetnum}|${key}`) % list.length]!;
        a.spareparts.push({ sparepartid: ctx.ids.next("sparepartid"), itemnum, itemsetid: ITEMSETID, quantity: qty, description: itemByNum.get(itemnum)?.attrs.description ?? null, remarks: null });
        if (itemByNum.get(itemnum)?.attrs.status === "OBSOLETE" && ctx.inMaximo(a)) problems.add("SPAREPART_OBSOLETE_ITEM", "資産の予備品の一覧が廃止（OBSOLETE）の品目を指している", "ASSET.SPAREPART.ITEMNUM");
      }
    }
  }
  return { byKey, byAsset };
}

/** 品目のキーから、この資産に合う品目を 1 つ決める（乱数を使わず、資産番号から決める） */
function pickItem(items: ItemsBuilt, key: string, salt: string, stocked: Set<string>): string | null {
  const list = (items.allByKey.get(key) ?? []).filter((i) => stocked.has(i));
  if (list.length === 0) return null;
  return list[seedOf(salt) % list.length]!;
}

interface Issue {
  date: number;
  itemnum: string;
  qty: number;
  wo: WoDraft | null;
}

/** 在庫・払い出し・予備品の在庫を作り、表に書き出す */
export function buildStores(
  ctxs: SiteContext[], items: ItemsBuilt, rotating: RotatingBuilt, rng: Rng, problems: Problems, tx: Text, ids: Ids,
  push: (t: string, r: Rec) => void, inMaximoWo: (w: WoDraft) => boolean,
): StoresTruth {
  for (const r of items.records) push("ITEM", r);
  const itemById = new Map(items.records.map((r) => [String(r.attrs.itemnum), r]));
  let spares = 0;
  let issueCount = 0;
  for (const ctx of ctxs) {
    const r = rng.fork(ctx.site.siteid);
    const p = ctx.p;
    const mark = p === "KT" ? "KT形" : p === "MN" ? "MN形" : "HG形";
    // ---- 在庫を持つ品目（回転品目以外） ----
    const stocked = new Set<string>();
    const storeOf = new Map<string, string>();
    for (const it of items.records) {
      if (it.attrs.rotating === true || rotatingNum(it, rotating)) continue;
      const itemnum = String(it.attrs.itemnum);
      // 火格子片は施設の炉の形のものだけ（説明は言語で変わるので、正本の寸法の表で判定する）
      const sizeJa = sizeOfItem(itemnum);
      if (sizeJa !== null && /[A-Z]{2}形/.test(sizeJa) && !sizeJa.includes(mark)) continue;
      if (!r.chance(itemnum.startsWith("Z-") ? 0.6 : 0.75)) continue;
      stocked.add(itemnum);
      const commodity = String(it.attrs.commoditygroup);
      storeOf.set(itemnum, `${p}-${commodity === "ELEC" || commodity === "INST" ? "ESTORE" : "STORE"}`);
    }
    // ---- 払い出し（Maximo を入れた後の完了した作業指示） ----
    const issues: Issue[] = [];
    for (const w of ctx.wos) {
      if (!inMaximoWo(w) || w.materials === undefined) continue;
      if (w.attrs.status !== "COMP" && w.attrs.status !== "CLOSE") continue;
      const date = Date.parse(String(w.attrs.actstart));
      const salt = String(w.attrs.assetnum ?? w.attrs.location);
      const needs = w.materials.length > 0 ? w.materials : (CAUSE_ITEMS[w.truth?.cause ?? ""] ?? []);
      for (const [key, qty] of needs) {
        if (key === "GREASE") continue;
        const itemnum = pickItem(items, key, `${salt}|${key}`, stocked);
        if (!itemnum) continue;
        issues.push({ date, itemnum, qty, wo: w });
      }
    }
    // グリースは月に 1 回、保全班にまとめて払い出す
    for (let t = addMonths(atTime(ctx.goLive, 9), 0); t < NOW; t = addMonths(t, 1)) {
      for (const itemnum of items.allByKey.get("GREASE") ?? []) {
        if (stocked.has(itemnum) && r.chance(0.7)) issues.push({ date: t + r.int(0, 20) * DAY, itemnum, qty: r.int(1, 4), wo: null });
      }
    }
    issues.sort((a, b) => a.date - b.date);

    // ---- 在庫の行（使った量から発注点・最大在庫を決め、払い出しと補充で残高を出す） ----
    const years = (NOW - ctx.goLive) / (365.25 * DAY);
    const recent = NOW - 3 * 365.25 * DAY;
    const usage = new Map<string, number>();
    for (const i of issues) if (i.date >= recent) usage.set(i.itemnum, (usage.get(i.itemnum) ?? 0) + i.qty);
    const valueOf = (itemnum: string) => ((usage.get(itemnum) ?? 0) / Math.min(3, years)) * (items.cost.get(itemnum) ?? 0);
    const ranked = [...stocked].sort((a, b) => valueOf(b) - valueOf(a) || a.localeCompare(b));
    const abcOf = new Map<string, string>(ranked.map((it, i) => [it, i < ranked.length * 0.1 ? "A" : i < ranked.length * 0.35 ? "B" : "C"]));
    const unitCost = new Map<string, number>();
    const issueCost = new Map<Issue, number>();
    const stocktake = jst(2026, 3, 31, 12);
    for (const itemnum of ranked) {
      const annual = (usage.get(itemnum) ?? 0) / Math.min(3, years);
      const delivery = r.int(14, 75);
      const min = annual > 0 ? Math.ceil((annual * delivery * 1.5) / 365) : r.int(0, 2);
      const max = min + Math.max(2, Math.ceil(annual / 3), r.int(2, 6));
      const cost = items.cost.get(itemnum) ?? 0;
      unitCost.set(itemnum, round(cost * r.real(0.95, 1.08), -1));
      // 残高の推移（Maximo を入れたときの残高から始める）
      let bal = r.int(min, max);
      let pending: { at: number; qty: number } | null = null;
      let last: number | null = null;
      for (const i of issues) {
        if (i.itemnum !== itemnum) continue;
        if (pending && pending.at <= i.date) {
          bal += pending.qty;
          pending = null;
        }
        const q = Math.min(i.qty, bal);
        if (q <= 0) continue;
        bal -= q;
        i.qty = q;
        issueCost.set(i, unitCost.get(itemnum)!);
        last = i.date;
        if (bal <= min && !pending) pending = { at: i.date + delivery * DAY, qty: Math.max(1, max - bal) };
      }
      if (pending && pending.at <= NOW) bal += pending.qty;
      const status = String(itemById.get(itemnum)?.attrs.status ?? "ACTIVE");
      let minlevel = min;
      if (r.chance(0.03)) {
        minlevel = max + r.int(1, 5);
        problems.add("INV_MIN_OVER_MAX", "在庫の発注点（MINLEVEL）が最大在庫（MAXLEVEL）を超える", "INVENTORY.MINLEVEL / MAXLEVEL");
      }
      if (status === "OBSOLETE" && bal > 0) problems.add("INV_OBSOLETE_STOCK", "廃止（OBSOLETE）の品目に在庫が残っている", "INVENTORY.CURBALTOTAL / ITEM.STATUS");
      // データ品質（在庫）
      let abc = abcOf.get(itemnum)!;
      if (r.chance(0.05)) {
        abc = abc === "A" ? "C" : "A";
        problems.add("INV_ABC_STALE", "ABC 分類が使用金額と合っていない（見直していない）", "INVENTORY.ABCTYPE");
      }
      const noBin = r.chance(0.03);
      if (noBin) problems.add("INV_NO_BIN", "既定の棚（BINNUM）が空", "INVENTORY.BINNUM");
      const staleCount = ctx.legacy && r.chance(0.06);
      if (staleCount) problems.add("INV_STALE_COUNT", "実地棚卸が 2 年以上前のまま", "INVBALANCES.PHYSCNTDATE");
      const zeroCost = r.chance(0.02);
      if (zeroCost) problems.add("INV_ZERO_COST", "平均単価が 0", "INVENTORY.AVGCOST / INVCOST.AVGCOST");
      const noVendor = r.chance(0.05);
      if (noVendor) problems.add("INV_NO_VENDOR", "購入先（VENDOR）が空", "INVENTORY.VENDOR");
      const bin = `${storeOf.get(itemnum)!.endsWith("ESTORE") ? "E" : r.pick(["A", "B", "C", "D"])}-${pad(r.int(1, 20), 2)}-${pad(r.int(1, 6), 2)}`;
      const avg = zeroCost ? 0 : tx.money(unitCost.get(itemnum)!, 2);
      push("INVENTORY", {
        attrs: {
          itemnum, itemsetid: ITEMSETID, siteid: ctx.site.siteid, orgid: ORGID, location: storeOf.get(itemnum)!, binnum: noBin ? null : bin,
          category: "STK", status, minlevel, maxlevel: max, orderqty: Math.max(1, max - min), orderunit: itemById.get(itemnum)?.attrs.orderunit ?? null,
          issueunit: itemById.get(itemnum)?.attrs.issueunit ?? null, abctype: abc, curbaltotal: bal, avgcost: avg, vendor: noVendor ? null : r.pick(["VND-SA", "VND-SA", "VND-MA", "VND-EA"]),
          deliverytime: delivery, lastissuedate: last === null ? null : fmt(last), inventoryid: ids.next("inventoryid"),
        },
        children: {
          invbalances: [{
            invbalancesid: ids.next("invbalancesid"), binnum: bin, lotnum: null, curbal: bal, physcnt: bal,
            physcntdate: fmt(staleCount ? jst(r.int(2019, 2023), 3, 31, 12) : stocktake), conditioncode: null,
          }],
          invcost: [{ invcostid: ids.next("invcostid"), conditioncode: null, avgcost: avg, lastcost: tx.money(round(cost * r.real(0.98, 1.12), -1), 2), stdcost: tx.money(cost, 2) }],
        },
      });
    }

    // ---- 回転品目の在庫（倉庫にある予備品の台数と同じ） ----
    const spareAssets = ctx.assets.filter((a) => a.spare);
    spares += spareAssets.length;
    const byItemStore = new Map<string, Asset[]>();
    for (const a of spareAssets) {
      if (a.location.endsWith("-REPAIR")) continue;
      const k = `${a.itemnum}|${a.location}`;
      (byItemStore.get(k) ?? byItemStore.set(k, []).get(k)!).push(a);
    }
    for (const it of rotating.byKey.values()) {
      const store = `${p}-${it.store}`;
      const here = byItemStore.get(`${it.itemnum}|${store}`) ?? [];
      const hasSpare = spareAssets.some((a) => a.itemnum === it.itemnum);
      if (!hasSpare) continue;
      let bal = here.length;
      if (r.chance(0.1)) {
        bal = Math.max(0, bal + r.pick([-1, 1]));
        problems.add("ROT_BALANCE_MISMATCH", "回転品目の在庫数が、倉庫にある予備品（資産）の台数と合わない", "INVENTORY.CURBALTOTAL / ASSET.LOCATION");
      }
      const bins = new Map<string, number>();
      for (const a of here) bins.set(a.binnum ?? "", (bins.get(a.binnum ?? "") ?? 0) + 1);
      if (bins.size === 0) bins.set(`${it.store === "ESTORE" ? "E" : "R"}-01-01`, 0);
      let first = true;
      const balances = [...bins.entries()].map(([bin, n]) => {
        const curbal = first ? n + (bal - here.length) : n;
        first = false;
        return { invbalancesid: ids.next("invbalancesid"), binnum: bin, lotnum: null, curbal: Math.max(0, curbal), physcnt: Math.max(0, curbal), physcntdate: fmt(stocktake), conditioncode: null };
      });
      const cost = tx.money(it.cost, 2);
      push("INVENTORY", {
        attrs: {
          itemnum: it.itemnum, itemsetid: ITEMSETID, siteid: ctx.site.siteid, orgid: ORGID, location: store, binnum: balances[0]!.binnum,
          category: "STK", status: "ACTIVE", minlevel: 0, maxlevel: Math.max(1, here.length), orderqty: 1, orderunit: "EA", issueunit: "EA",
          abctype: "A", curbaltotal: bal, avgcost: cost, vendor: "VND-SA", deliverytime: r.int(60, 150), lastissuedate: null, inventoryid: ids.next("inventoryid"),
        },
        children: { invbalances: balances, invcost: [{ invcostid: ids.next("invcostid"), conditioncode: null, avgcost: cost, lastcost: cost, stdcost: cost }] },
      });
    }

    // ---- 払い出しの記録（INVUSE） ----
    let seq = 0;
    const byWo = new Map<WoDraft | null, Issue[]>();
    const grease: Issue[] = [];
    for (const i of issues) {
      if (!issueCost.has(i)) continue;
      if (i.wo === null) grease.push(i);
      else (byWo.get(i.wo) ?? byWo.set(i.wo, []).get(i.wo)!).push(i);
    }
    const docs: Array<{ date: number; lines: Issue[]; wo: WoDraft | null }> = [...byWo.entries()].map(([wo, lines]) => ({ date: lines[0]!.date, lines, wo }));
    // グリースは月ごとに 1 枚
    const byMonth = new Map<string, Issue[]>();
    for (const g of grease) {
      const { y, m } = ymd(g.date);
      const k = `${y}-${pad(m, 2)}`;
      (byMonth.get(k) ?? byMonth.set(k, []).get(k)!).push(g);
    }
    for (const lines of byMonth.values()) docs.push({ date: lines[0]!.date, lines, wo: null });
    docs.sort((a, b) => a.date - b.date);
    for (const d of docs) {
      const invusenum = `${p}${pad(++seq, 6)}`;
      const store = storeOf.get(d.lines[0]!.itemnum)!;
      const { y, m } = ymd(d.date);
      const description = d.wo ? (tx.lang === "ja" ? `作業指示 ${d.wo.wonum} への払出` : `Issue to work order ${d.wo.wonum}`) : (tx.lang === "ja" ? `グリース ${y}年${m}月分 払出（保全班）` : `Grease issue for ${tx.monthName(m)} ${y} (maintenance team)`);
      push("INVUSE", {
        attrs: {
          invusenum, siteid: ctx.site.siteid, orgid: ORGID, description, fromstoreloc: store, usetype: "ISSUE", status: "COMPLETE", statusdate: fmt(d.date),
          invuseid: ids.next("invuseid"), changeby: d.wo ? String(d.wo.attrs.lead ?? "MAXADMIN") : "MAXADMIN",
        },
        children: {
          invuseline: d.lines.map((i, k) => {
            const unit = tx.money(issueCost.get(i)!, 2);
            return {
              invuselineid: ids.next("invuselineid"), invuselinenum: k + 1, itemnum: i.itemnum, itemsetid: ITEMSETID, quantity: i.qty, unitcost: unit, linecost: round(unit * i.qty, 2),
              refwo: d.wo?.wonum ?? null, assetnum: d.wo ? (d.wo.attrs.assetnum ?? null) : null, location: d.wo ? (d.wo.attrs.location ?? null) : null, usetype: "ISSUE", actualdate: fmt(i.date),
            };
          }),
        },
      });
      issueCount++;
    }

  }
  return { spares, issues: issueCount };
}

function rotatingNum(it: Rec, rotating: RotatingBuilt): boolean {
  const n = String(it.attrs.itemnum);
  for (const r of rotating.byKey.values()) if (r.itemnum === n) return true;
  return false;
}

// 品目番号 → 正本の寸法（火格子片の「KT形」の判定に使う）
const SIZE_BY_ITEM = (() => {
  const out = new Map<string, string>();
  const counters = new Map<string, number>();
  for (const tpl of ITEM_TEMPLATES) {
    for (const size of tpl.sizes) {
      const n = (counters.get(tpl.prefix) ?? 0) + 1;
      counters.set(tpl.prefix, n);
      out.set(`${tpl.prefix}-${pad(n, 4)}`, size);
    }
  }
  return out;
})();
function sizeOfItem(itemnum: string): string | null {
  return SIZE_BY_ITEM.get(itemnum) ?? null;
}
