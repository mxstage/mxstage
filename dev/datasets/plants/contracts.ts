// 外注: 作業指示の業者（VENDOR）と、発注の独自属性（EXT_PONUM・査定・発注・検収の金額・日付・法規対応・部署）。
// Maximo を入れた後から 2026 年 3 月までの分は入力済み、2026 年度上半期（4〜9 月）の分は未入力で、発注リスト（Excel）にだけある。
// 実機では計算で決まる標準の費用（ESTSERVCOST など）は読み取り専用にし、過去の分だけ値を持たせる。

import type { SiteCode } from "./catalog.ts";
import { NOW, type SiteContext, type WoDraft } from "./generate.ts";
import type { Text } from "./text.ts";
import { DAY, Rng, fmt, jst, pad, ymd } from "./util.ts";

export interface OrderTruth {
  /** WO: 作業指示 1 件の発注 / CHANGE: 変更契約（同じ作業指示の 2 行目）/ ANNUAL: 年間の委託（多くの作業指示）/ NOWO: 作業指示の無い購入 / CANCELLED: 取消 */
  kind: "WO" | "CHANGE" | "ANNUAL" | "NOWO" | "CANCELLED";
  site: SiteCode;
  wo: WoDraft | null;
  wos: WoDraft[];
  vendor: string;
  ponum: string;
  /** 円 */
  assess: number;
  order: number;
  accept: number | null;
  podate: number;
  compdate: number | null;
  acceptdate: number | null;
  legal: boolean;
  /** 担当（作業指示の監督者の PERSONID） */
  buyer: string | null;
  dept: string;
  /** 2026 年度上半期（Maximo には未入力） */
  current: boolean;
  /** Maximo に先に入っている間違った値・業者 */
  prefilled?: "WRONG_ORDERAMT" | "WRONG_VENDOR";
  /** 発注リストに載っていない（手続き中） */
  unlisted?: boolean;
  /** NOWO・ANNUAL の件名の元（日本語の正本のキー） */
  label?: string;
}

const FY2026 = jst(2026, 4, 1);

/** 作業計画（外注）→ 業者 */
function vendorFor(w: WoDraft, ctx: SiteContext, rng: Rng): string {
  const jp = w.prog?.jp ?? "";
  if (!w.prog) {
    const craft = w.contractorCraft ?? "MECH";
    return craft === "ELEC" ? "VND-EA" : craft === "INST" ? "VND-IA" : rng.pick(["VND-MA", "VND-MB"]);
  }
  if (["LINE-OH", "BOILER-1Y", "GRATE-OH", "REFR-OH", "SCR-1Y"].includes(jp)) return ctx.site.epc;
  if (jp === "TURB-1Y" || jp === "TURB-4Y") return "MKR-TB";
  if (jp === "GEN-1Y") return "MKR-EA";
  if (jp === "CRANE-1Y" || jp === "GRAB-OH") return "MKR-CR";
  if (jp === "ELEC-1Y" || jp === "EGEN-1Y") return "VND-EA";
  if (jp === "ANLZ-1Y") return w.asset?.maker ?? "MKR-AN";
  if (jp === "DCS-1Y") return "MKR-IA";
  if (jp === "ELEV-1M" || jp === "ELEV-1Y") return "MKR-EV";
  if (jp === "FIRE-6M") return "VND-SA";
  if (jp === "WB-2Y") return "MKR-WB";
  return rng.pick(["VND-MA", "VND-MB"]);
}

function deptOf(w: WoDraft): string {
  const craft = w.prog?.craft ?? w.contractorCraft ?? "MECH";
  return craft === "ELEC" || craft === "INST" ? "EIC" : "FAC";
}

/** 外注の作業指示に業者・発注を付ける。発注リスト（Excel）の正解を返す */
export function applyOutsourcing(ctxs: SiteContext[], rng: Rng, tx: Text): OrderTruth[] {
  const out: OrderTruth[] = [];
  for (const ctx of ctxs) {
    const r = rng.fork(ctx.site.siteid);
    const seqByFy = new Map<number, number>();
    const ponum = (podate: number) => {
      const { y, m } = ymd(podate);
      const fy = m >= 4 ? y : y - 1;
      const n = (seqByFy.get(fy) ?? 0) + 1;
      seqByFy.set(fy, n);
      return `${ctx.p}${String(fy).slice(2)}-${pad(n, 4)}`;
    };
    const parentVendor = new Map<WoDraft, string>();
    const annual = new Map<string, WoDraft[]>();
    // 報告日の順に処理する（発注番号が日付の順になる）
    const wos = [...ctx.wos].sort((a, b) => a.report - b.report);
    for (const w of wos) {
      if (w.report < ctx.goLive) continue;
      const contractorPm = w.prog?.contractor === true;
      const contractorCm = !w.prog && (w.contractorCraft ?? null) !== null;
      if (!contractorPm && !contractorCm) continue;
      // 炉の定期整備の子は親の業者（発注は親で 1 つ）
      if (w.parentRef) {
        const v = parentVendor.get(w.parentRef);
        if (v) w.attrs.vendor = v;
        continue;
      }
      const vendor = vendorFor(w, ctx, r);
      w.attrs.vendor = vendor;
      parentVendor.set(w, vendor);
      const current = w.report >= FY2026;
      const legal = w.prog?.law === true;
      const dept = deptOf(w);
      if (w.prog?.contract === "annual") {
        // 年間の委託: 作業指示ごとの金額は無い（契約番号だけ）
        const { y, m } = ymd(w.report);
        const fy = m >= 4 ? y : y - 1;
        const k = `${w.prog.jp}|${fy}`;
        if (!annual.has(k)) annual.set(k, []);
        annual.get(k)!.push(w);
        w.attrs.ext_legal = current ? null : legal;
        w.attrs.ext_dept = current ? null : dept;
        continue;
      }
      // 金額（円）: 人数 × 時間 × 単価 ＋ 部品・諸経費
      const rate = r.int(7000, 12000);
      const hours = w.prog ? w.prog.dur * w.prog.crew : Math.max(2, Number(w.attrs.estlabhrs ?? 4));
      const assess = Math.max(30_000, Math.round((hours * rate * r.real(1.1, 1.6)) / 1000) * 1000);
      const order = Math.round((assess * r.real(0.85, 0.98)) / 1000) * 1000;
      const changed = current && r.chance(0.05);
      const accept = changed ? Math.round((order * r.real(1.05, 1.2)) / 1000) * 1000 : order;
      const actStart = typeof w.attrs.actstart === "string" ? Date.parse(w.attrs.actstart) : null;
      const actFinish = typeof w.attrs.actfinish === "string" ? Date.parse(w.attrs.actfinish) : null;
      let podate = w.report + r.int(2, 10) * DAY;
      if (actStart !== null && podate > actStart - DAY) podate = Math.max(w.report + DAY, actStart - DAY);
      const acceptdate = actFinish !== null ? actFinish + r.int(5, 25) * DAY : null;
      const done = w.attrs.status === "COMP" || w.attrs.status === "CLOSE";
      const accepted = done && acceptdate !== null && acceptdate <= NOW;
      const cancelled = w.attrs.status === "CAN";
      const po = ponum(podate);
      const truth: OrderTruth = {
        kind: cancelled ? "CANCELLED" : "WO", site: ctx.site.siteid, wo: w, wos: [w], vendor, ponum: po, assess, order, accept: accepted ? accept : null,
        podate, compdate: done ? actFinish : null, acceptdate: accepted ? acceptdate : null, legal, buyer: typeof w.attrs.supervisor === "string" ? w.attrs.supervisor : null,
        dept, current,
      };
      w.order = truth;
      if (!current) {
        // 過去の分は入力済み（標準の費用は Maximo が計算した値として持たせる）
        if (cancelled) continue;
        w.attrs.ext_ponum = po;
        w.attrs.ext_assessamt = tx.money(assess);
        w.attrs.ext_orderamt = tx.money(order);
        w.attrs.ext_acceptamt = accepted ? tx.money(accept) : null;
        w.attrs.ext_podate = fmt(podate).slice(0, 10);
        w.attrs.ext_acceptdate = accepted ? fmt(acceptdate!).slice(0, 10) : null;
        w.attrs.ext_legal = legal;
        w.attrs.ext_dept = dept;
        w.attrs.estservcost = tx.money(assess);
        w.attrs.estatapprservcost = w.attrs.status === "WAPPR" ? null : tx.money(order);
        w.attrs.actservcost = accepted ? tx.money(accept) : 0;
        continue;
      }
      // 2026 年度上半期: 検収と金額の入力を待つので、完了しても CLOSE にせず COMP のまま
      if (w.attrs.status === "CLOSE") {
        w.statuses.pop();
        const last = w.statuses[w.statuses.length - 1]!;
        w.attrs.status = last[0];
        w.attrs.statusdate = fmt(last[1]);
        w.attrs.historyflag = false;
      }
      w.attrs.actservcost = 0;
      out.push(truth);
      if (changed) out.push({ ...truth, kind: "CHANGE", ponum: `${po}-1`, assess: accept, order: accept, podate: Math.min(NOW, (actStart ?? podate) + r.int(3, 20) * DAY) });
      // Maximo に先に入っている間違い（見積を発注額の欄に入れた・業者違い）
      const p = r.next();
      if (!cancelled && p < 0.05) {
        w.attrs.ext_orderamt = tx.money(assess);
        truth.prefilled = "WRONG_ORDERAMT";
      } else if (!cancelled && p < 0.08) {
        w.attrs.vendor = vendor === "VND-MA" ? "VND-MB" : vendor === "VND-MB" ? "VND-MA" : "VND-SA";
        truth.prefilled = "WRONG_VENDOR";
      } else if (p < 0.1) {
        truth.unlisted = true;
      }
    }
    // 年間の委託（2026 年度）: 発注リストに 1 行。作業指示には契約番号を入れる
    for (const [k, list] of annual) {
      const [jp, fyText] = k.split("|");
      const fy = Number(fyText);
      const first = list[0]!;
      const po = `${ctx.p}${String(fy).slice(2)}-A${pad(Number(seedOfJp(jp!)), 2)}`;
      const hours = list.reduce((s, w) => s + (w.prog ? w.prog.dur * w.prog.crew : 0), 0);
      const assess = Math.max(200_000, Math.round((hours * 9000 * (fy === 2026 ? 2 : 1)) / 10_000) * 10_000);
      const order = Math.round((assess * r.real(0.88, 0.97)) / 10_000) * 10_000;
      if (fy < 2026) {
        for (const w of list) w.attrs.ext_ponum = po;
        continue;
      }
      out.push({
        kind: "ANNUAL", site: ctx.site.siteid, wo: null, wos: list, vendor: String(first.attrs.vendor), ponum: po, assess, order, accept: null,
        podate: jst(2026, 4, 1), compdate: null, acceptdate: null, legal: first.prog?.law === true, buyer: typeof first.attrs.supervisor === "string" ? first.attrs.supervisor : null,
        dept: deptOf(first), current: true, label: jp!,
      });
    }
    // 作業指示の無い購入（消耗品）
    const buys: Array<[string, string, number]> = [["ろ布 交換用 購入", "VND-SA", 1_850_000], ["消石灰 購入（4〜9月分）", "VND-SA", 3_600_000], ["作業服・保護具 購入", "VND-SA", 420_000]];
    for (const [label, vendor, amount] of buys) {
      const podate = jst(2026, r.int(4, 8), r.int(1, 28), 10);
      out.push({
        kind: "NOWO", site: ctx.site.siteid, wo: null, wos: [], vendor, ponum: ponum(podate), assess: amount, order: Math.round((amount * 0.95) / 1000) * 1000,
        accept: Math.round((amount * 0.95) / 1000) * 1000, podate, compdate: podate + 14 * DAY, acceptdate: podate + 21 * DAY, legal: false, buyer: null, dept: "GEN",
        current: true, label,
      });
    }
  }
  return out;
}

function seedOfJp(jp: string): number {
  return ["ELEC-1Y", "ANLZ-1Y", "DCS-1Y", "ELEV-1M", "ELEV-1Y", "FIRE-6M"].indexOf(jp) + 1;
}
