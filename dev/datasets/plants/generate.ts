// ごみ焼却施設 3 か所の保全データを、Maximo の標準の表（小文字の属性名）の形で作る。
// 同じオプションなら毎回同じデータになる（種付きの乱数だけを使い、現在時刻を見ない）。

import type { CellValue } from "../../../src/shared/model";
import {
  ATTRS, CAUSE_REMEDIES, CAUSES, CLASSES, CLASS_MAKERS, COMPANIES, CRAFTS, FAILURE_CLASSES, FAILURE_TREE, GIVEN_NAMES, INSTRUMENTS,
  ITEMSETID, ITEM_TEMPLATES, MEASURE_UNITS, METERS, MODEL_PREFIX, ORGID, ORG_DESCRIPTION, OVERHAUL_CLASSES, PM_PROGRAMS, PROBLEMS,
  REMEDIES, ROLES, SITES, SURNAMES, SYSTEMS, VALVES,
  type AttrDef, type ChildDef, type ClassDef, type ItemDef, type PmProgram, type SiteCode, type SiteDef, type UnitDef,
} from "./catalog.ts";
import { DAY, HOUR, Rng, addMonths, atTime, fmt, jst, pad, round, seedOf, toFullWidth, toHalfKana, weekday, ymd } from "./util.ts";

export type Row = Record<string, CellValue>;
export interface Rec {
  attrs: Row;
  children?: Record<string, Row[]>;
}

export interface PlantsOptions {
  /** 作る施設（既定は 3 か所すべて） */
  sites?: SiteCode[];
  /** 作業指示・メーターの読み・SR をこの日以降だけ作る（試験で小さくするため。資産の更新の履歴は変えない） */
  historyFrom?: string;
  /** 乱数の種（既定 "mxstage-plants"） */
  seed?: string;
}

export interface DataProblem {
  id: string;
  title: string;
  /** どの表のどの属性に出るか */
  where: string;
  count: number;
}

export interface PlantsData {
  tables: Record<string, Rec[]>;
  problems: DataProblem[];
  /** 表 → サイト（サイトの無い表は "-"）→ 件数 */
  counts: Record<string, Record<string, number>>;
  /** データの基準日（これより後の実績は無い） */
  asOf: string;
}

/** データの基準日時（2026-09-30 17:00 日本時間） */
export const NOW = jst(2026, 9, 30, 17, 0);

const CLASS_BY_ID = new Map<string, ClassDef>(CLASSES.map((c) => [c.id, c]));
const ATTR_BY_ID = new Map<string, AttrDef>(ATTRS.map((a) => [a.id, a]));
const CLASS_CSID = new Map<string, string>(CLASSES.map((c, i) => [c.id, String(1001 + i)]));

// ---------------------------------------------------------------------------
// 内部の形
// ---------------------------------------------------------------------------

interface Loc {
  location: string;
  description: string;
  type: string;
  parent: string | null;
  cls: string | null;
  siteid: SiteCode;
  specs?: Array<[string, CellValue]>;
}

/** 機能位置（場所）と、そこに据える資産の系列 */
interface Position {
  site: SiteDef;
  loc: string;
  unitLoc: string;
  line: number;
  tag: string;
  desc: string;
  item: ItemDef | null;
  cls: string;
  priority: number;
  start: number;
  /** 子の定義（電動機など） */
  child?: ChildDef;
  parentPos?: Position;
  kw?: number;
  /** 稼働率（メーターの読みに使う） */
  util: number;
  gens: Asset[];
}

interface Asset {
  assetnum: string;
  pos: Position;
  install: number;
  decom: number | null;
  desc: string;
  tag: string | null;
  location: string;
  parent: string | null;
  serial: string | null;
  maker: string | null;
  vendor: string | null;
  specs: Row[] | null;
  meters: Row[];
  cls: string | null;
  duplicate?: boolean;
  installNull?: boolean;
}

interface Person {
  personid: string;
  last: string;
  first: string;
  role: string;
  title: string;
  craft: string;
  site: SiteCode | null;
  from: number;
  to: number;
  dept: string;
}

interface WoDraft {
  site: SiteDef;
  report: number;
  attrs: Row;
  statuses: Array<[string, number, string]>;
  failure: Array<[string, string]>;
  parentRef?: WoDraft;
  sr?: SrDraft;
  wonum?: string;
}

interface SrDraft {
  site: SiteDef;
  report: number;
  attrs: Row;
  statuses: Array<[string, number, string]>;
  wo?: WoDraft;
  ticketid?: string;
}

class Ids {
  private counters = new Map<string, number>();
  next(name: string, start = 1): number {
    const v = (this.counters.get(name) ?? start - 1) + 1;
    this.counters.set(name, v);
    return v;
  }
}

class Problems {
  readonly list = new Map<string, DataProblem>();
  add(id: string, title: string, where: string, n = 1): void {
    const p = this.list.get(id);
    if (p) p.count += n;
    else this.list.set(id, { id, title, where, count: n });
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function generatePlants(opts: PlantsOptions = {}): PlantsData {
  const root = new Rng(seedOf(opts.seed ?? "mxstage-plants"));
  const historyFrom = opts.historyFrom ? Date.parse(opts.historyFrom) : Number.NEGATIVE_INFINITY;
  const sites = SITES.filter((s) => !opts.sites || opts.sites.includes(s.siteid));
  const ids = new Ids();
  const problems = new Problems();
  const t: Record<string, Rec[]> = {};
  const push = (table: string, rec: Rec) => (t[table] ??= []).push(rec);

  const items = buildItems(root.fork("items"), problems);
  for (const r of items.records) push("ITEM", r);
  buildOrgTables(push, sites);

  const contractors = buildContractors(root.fork("contractors"));
  // Maximo の管理者（PM からの作業指示の生成・メーターの取り込みの変更者）
  const admins: Person[] = [
    { personid: "MAXADMIN", last: "MAXADMIN", first: "", role: "SYS", title: "システム管理者", craft: "OPER", site: null, from: jst(2005, 4, 1), to: jst(2099, 1, 1), dept: "情報システム" },
    { personid: "MXINTADM", last: "MXINTADM", first: "", role: "SYS", title: "連携用ユーザー", craft: "OPER", site: null, from: jst(2005, 4, 1), to: jst(2099, 1, 1), dept: "情報システム" },
  ];
  const allPersons: Person[] = [...admins, ...contractors];
  const wos: WoDraft[] = [];
  const srs: SrDraft[] = [];

  for (const site of sites) {
    const rng = root.fork(`site-${site.siteid}`);
    const ctx = new SiteContext(site, rng, ids, problems, historyFrom, contractors);
    ctx.build();
    for (const l of ctx.locs) push("LOCATIONS", locRecord(l, ids));
    for (const a of ctx.assets) push("ASSET", assetRecord(a, site, ids));
    for (const r of ctx.meterReadings) push("METERREADING", { attrs: r });
    for (const r of ctx.pms) push("PM", { attrs: r });
    for (const r of ctx.inventory(items.records, ids)) push("INVENTORY", r);
    allPersons.push(...ctx.persons);
    wos.push(...ctx.wos);
    srs.push(...ctx.srs);
    for (const g of ctx.personGroups()) push("PERSONGROUP", g);
  }

  for (const p of allPersons) {
    push("PERSON", { attrs: personAttrs(p) });
    push("LABOR", {
      attrs: { laborcode: p.personid, personid: p.personid, orgid: ORGID, worksite: p.site, status: p.to > NOW ? "ACTIVE" : "INACTIVE", laborid: ids.next("laborid") },
      children: { laborcraftrate: [{ laborcraftrateid: ids.next("laborcraftrateid"), craft: p.craft, skilllevel: p.role.endsWith("L") || p.role === "MGR" ? "FIRSTCLASS" : "SECONDCLASS", defaultcraft: true, orgid: ORGID }] },
    });
  }

  numberWorkOrders(wos, srs, ids, push);
  // 部品を使う作業計画（品目のキー → 代表の品目）
  for (const r of buildJobPlans(items.byKey, ids)) push("JOBPLAN", r);

  const counts: PlantsData["counts"] = {};
  for (const [table, recs] of Object.entries(t)) {
    const c: Record<string, number> = {};
    for (const r of recs) {
      const s = typeof r.attrs.siteid === "string" ? r.attrs.siteid : "-";
      c[s] = (c[s] ?? 0) + 1;
    }
    counts[table] = c;
  }
  return { tables: t, problems: [...problems.list.values()], counts, asOf: fmt(NOW) };
}

// ---------------------------------------------------------------------------
// 組織全体の表（分類・仕様の属性・単位・故障コード・メーター・会社・職種・ドメイン）
// ---------------------------------------------------------------------------

function buildOrgTables(push: (t: string, r: Rec) => void, sites: SiteDef[]): void {
  push("ORGANIZATION", {
    attrs: { orgid: ORGID, description: ORG_DESCRIPTION, active: true, basecurrency1: "JPY", itemsetid: ITEMSETID, companysetid: "COMPSET1", clearingacct: "9999-000" },
    children: { site: sites.map((s, i) => ({ siteuid: i + 1, siteid: s.siteid, description: s.description, active: true, orgid: ORGID })) },
  });
  for (const [id, desc] of MEASURE_UNITS) push("MEASUREUNIT", { attrs: { measureunitid: id, description: desc, orgid: null, abbreviation: id } });
  for (const a of ATTRS) {
    push("ASSETATTRIBUTE", { attrs: { assetattrid: a.id, description: a.desc, datatype: a.type, measureunitid: a.unit ?? null, orgid: ORGID, domainid: null } });
  }
  let specId = 1;
  CLASSES.forEach((c) => {
    const csid = CLASS_CSID.get(c.id)!;
    const children = CLASSES.some((x) => x.parent === c.id);
    const path: string[] = [];
    for (let cur: ClassDef | undefined = c; cur; cur = cur.parent ? CLASS_BY_ID.get(cur.parent) : undefined) path.unshift(cur.id);
    push("CLASSSTRUCTURE", {
      attrs: {
        classstructureid: csid, classificationid: c.id, description: c.desc, parent: c.parent ? CLASS_CSID.get(c.parent)! : null,
        hierarchypath: path.join(" \\ "), haschildren: children, orgid: ORGID, siteid: null, genassetdesc: false, useclassindesc: false, type: null,
      },
      children: {
        classspec: (c.specs ?? []).map((a, i) => ({
          classspecid: specId++, assetattrid: a, measureunitid: ATTR_BY_ID.get(a)?.unit ?? null, displaysequence: (i + 1) * 10, classstructureid: csid, orgid: ORGID,
        })),
        classusewith: c.useWith.map((o, i) => ({ classusewithid: Number(csid) * 10 + i, objectname: o, description: o === "ASSET" ? "資産" : "場所", toplevel: c.parent === null })),
      },
    });
  });
  // 故障コード
  for (const [code, d] of Object.entries(FAILURE_CLASSES)) push("FAILURECODE", { attrs: { failurecode: code, description: `${d}（故障クラス）`, orgid: ORGID } });
  for (const [code, d] of Object.entries(PROBLEMS)) push("FAILURECODE", { attrs: { failurecode: code, description: d, orgid: ORGID } });
  for (const [code, d] of Object.entries(CAUSES)) push("FAILURECODE", { attrs: { failurecode: code, description: d, orgid: ORGID } });
  for (const [code, d] of Object.entries(REMEDIES)) push("FAILURECODE", { attrs: { failurecode: code, description: d, orgid: ORGID } });
  let fl = 1;
  for (const [cls, problems] of Object.entries(FAILURE_TREE)) {
    const clsId = fl++;
    push("FAILURELIST", { attrs: { failurelist: clsId, failurecode: cls, parent: null, type: null, orgid: ORGID } });
    for (const [prob, causes] of Object.entries(problems)) {
      const probId = fl++;
      push("FAILURELIST", { attrs: { failurelist: probId, failurecode: prob, parent: clsId, type: "PROBLEM", orgid: ORGID } });
      for (const cause of [...causes, "UNKNOWN"]) {
        const causeId = fl++;
        push("FAILURELIST", { attrs: { failurelist: causeId, failurecode: cause, parent: probId, type: "CAUSE", orgid: ORGID } });
        for (const rem of CAUSE_REMEDIES[cause] ?? ["REPAIR"]) {
          push("FAILURELIST", { attrs: { failurelist: fl++, failurecode: rem, parent: causeId, type: "REMEDY", orgid: ORGID } });
        }
      }
    }
  }
  for (const m of METERS) push("METER", { attrs: { metername: m.name, description: m.desc, metertype: m.type, measureunitid: m.unit, readingtype: m.type === "CONTINUOUS" ? "ACTUAL" : null, rollover: null, domainid: null } });
  for (const c of COMPANIES) push("COMPANIES", { attrs: { company: c.company, name: c.name, type: c.type, orgid: ORGID, currencycode: "JPY", disabled: false } });
  for (const [craft, d] of CRAFTS) push("CRAFT", { attrs: { craft, description: d, orgid: ORGID } });
  for (const d of DOMAINS) push("MAXDOMAIN", domainRecord(d));
}

export interface DomainDef {
  domainid: string;
  description: string;
  type: "SYNONYM" | "ALN";
  length: number;
  values: Array<[string, string, string?]>;
}

/** ドメイン（値の一覧）。SYNONYM は [内部値, 値, 説明]、ALN は [値, 説明] */
export const DOMAINS: DomainDef[] = [
  { domainid: "WOSTATUS", description: "作業指示のステータス", type: "SYNONYM", length: 16, values: [["WAPPR", "WAPPR", "承認待ち"], ["APPR", "APPR", "承認済み"], ["WSCH", "WSCH", "スケジュール待ち"], ["WMATL", "WMATL", "資材待ち"], ["WPCOND", "WPCOND", "作業条件待ち"], ["INPRG", "INPRG", "作業中"], ["COMP", "COMP", "完了"], ["CLOSE", "CLOSE", "クローズ"], ["CAN", "CAN", "キャンセル"]] },
  { domainid: "LOCASSETSTATUS", description: "資産・場所のステータス", type: "SYNONYM", length: 20, values: [["NOT READY", "NOT READY", "準備中"], ["OPERATING", "OPERATING", "稼働中"], ["DECOMMISSIONED", "DECOMMISSIONED", "撤去済み"]] },
  { domainid: "SRSTATUS", description: "サービス要求のステータス", type: "SYNONYM", length: 10, values: [["NEW", "NEW", "新規"], ["QUEUED", "QUEUED", "受付済み"], ["INPROG", "INPROG", "対応中"], ["PENDING", "PENDING", "保留中"], ["RESOLVED", "RESOLVED", "解決済み"], ["CLOSED", "CLOSED", "クローズ"]] },
  { domainid: "ITEMSTATUS", description: "品目のステータス", type: "SYNONYM", length: 16, values: [["PLANNING", "PLANNING", "計画中"], ["PENDING", "PENDING", "保留中"], ["ACTIVE", "ACTIVE", "有効"], ["PENDOBS", "PENDOBS", "廃止予定"], ["OBSOLETE", "OBSOLETE", "廃止"]] },
  { domainid: "LOCTYPE", description: "場所のタイプ", type: "SYNONYM", length: 16, values: [["OPERATING", "OPERATING", "運転"], ["STOREROOM", "STOREROOM", "倉庫"], ["COURIER", "COURIER", "運送業者"], ["LABOR", "LABOR", "作業員"], ["REPAIR", "REPAIR", "修理工場"], ["SALVAGE", "SALVAGE", "撤去品置場"], ["VENDOR", "VENDOR", "購入先"], ["HOLDING", "HOLDING", "保留"]] },
  { domainid: "PMSTATUS", description: "PM のステータス", type: "SYNONYM", length: 16, values: [["ACTIVE", "ACTIVE", "有効"], ["INACTIVE", "INACTIVE", "無効"], ["DRAFT", "DRAFT", "ドラフト"]] },
  { domainid: "JOBPLANSTATUS", description: "作業計画のステータス", type: "SYNONYM", length: 16, values: [["DRAFT", "DRAFT", "ドラフト"], ["ACTIVE", "ACTIVE", "有効"], ["INACTIVE", "INACTIVE", "無効"], ["PNDREV", "PNDREV", "改訂待ち"], ["REVISED", "REVISED", "改訂済み"]] },
  { domainid: "PERSONSTATUS", description: "担当者のステータス", type: "SYNONYM", length: 16, values: [["ACTIVE", "ACTIVE", "有効"], ["INACTIVE", "INACTIVE", "無効"]] },
  { domainid: "LABORSTATUS", description: "作業員のステータス", type: "SYNONYM", length: 16, values: [["ACTIVE", "ACTIVE", "有効"], ["INACTIVE", "INACTIVE", "無効"]] },
  { domainid: "METERTYPE", description: "メーターのタイプ", type: "SYNONYM", length: 16, values: [["CONTINUOUS", "CONTINUOUS", "累積"], ["GAUGE", "GAUGE", "計測値"], ["CHARACTERISTIC", "CHARACTERISTIC", "特性値"]] },
  { domainid: "FREQUNIT", description: "頻度の単位", type: "ALN", length: 8, values: [["DAYS", "日"], ["WEEKS", "週"], ["MONTHS", "月"], ["YEARS", "年"]] },
  { domainid: "ABCTYPE", description: "ABC 分類", type: "ALN", length: 1, values: [["A", "重要度 高"], ["B", "重要度 中"], ["C", "重要度 低"]] },
  { domainid: "CATEGORY", description: "在庫区分", type: "SYNONYM", length: 4, values: [["STK", "STK", "在庫品"], ["NS", "NS", "非在庫品"], ["SP", "SP", "特別注文品"]] },
  { domainid: "DATATYPE", description: "属性のデータ型", type: "SYNONYM", length: 8, values: [["ALN", "ALN", "英数字"], ["NUMERIC", "NUMERIC", "数値"], ["TABLE", "TABLE", "表"]] },
  { domainid: "COMPTYPE", description: "会社のタイプ", type: "ALN", length: 1, values: [["C", "運送業者"], ["M", "製造元"], ["V", "購入先"]] },
];

function domainRecord(d: DomainDef): Rec {
  const children: Record<string, Row[]> = {};
  if (d.type === "SYNONYM") {
    children.synonymdomain = d.values.map(([maxvalue, value, desc], i) => ({ synonymdomainid: seedOf(d.domainid) % 100000 * 100 + i, maxvalue, value, description: desc ?? null, defaults: true, orgid: null, siteid: null }));
  } else {
    children.alndomain = d.values.map(([value, desc], i) => ({ alndomainid: seedOf(d.domainid) % 100000 * 100 + i, value, description: desc ?? null, orgid: null, siteid: null }));
  }
  return { attrs: { domainid: d.domainid, description: d.description, domaintype: d.type, maxtype: "UPPER", length: d.length, internal: d.type === "SYNONYM" }, children };
}

// ---------------------------------------------------------------------------
// 部品
// ---------------------------------------------------------------------------

interface ItemsBuilt {
  records: Rec[];
  byKey: Map<string, string>;
}

function buildItems(rng: Rng, problems: Problems): ItemsBuilt {
  const records: Rec[] = [];
  const byKey = new Map<string, string>();
  const counters = new Map<string, number>();
  for (const tpl of ITEM_TEMPLATES) {
    for (const size of tpl.sizes) {
      const n = (counters.get(tpl.prefix) ?? 0) + 1;
      counters.set(tpl.prefix, n);
      const itemnum = `${tpl.prefix}-${pad(n, 4)}`;
      if (!byKey.has(tpl.key)) byKey.set(tpl.key, itemnum);
      const cost = round(rng.real(tpl.cost[0], tpl.cost[1]), -2);
      const status = rng.weighted<string>([["ACTIVE", 92], ["PENDOBS", 4], ["OBSOLETE", 4]]);
      records.push({
        attrs: {
          itemnum, itemsetid: ITEMSETID, description: `${tpl.desc} ${size}`, status, orderunit: tpl.unit, issueunit: tpl.unit, commoditygroup: tpl.commodity,
          rotating: false, lottype: "NOLOT", itemtype: "ITEM", inspectionrequired: false, itemid: records.length + 1,
        },
      });
    }
  }
  // データ品質: 同じ品目が別の品目番号・表記の揺れで重複して登録されている
  const dups: Array<[string, (d: string) => string]> = [
    ["BRG-0002", (d) => toHalfKana("ベアリング") + d.replace("玉軸受", "")],
    ["BRG-0003", (d) => d.replace("ZZ", "-ZZ")],
    ["BRG-0005", (d) => d.replace(" ", "　")],
    ["MSL-0003", (d) => d.replace("メカニカルシール", "ﾒｶﾆｶﾙｼｰﾙ")],
    ["GSK-0004", (d) => `${d.replace("JIS10K", "10K")}  `],
    ["VBT-0003", (d) => toFullWidth(d)],
    ["FUS-0002", (d) => d.replace("ヒューズ", "ﾋｭｰｽﾞ")],
    ["GRS-0001", (d) => d.replace("リチウム系", "リチウム")],
    ["TCK-0002", (d) => d.replace("熱電対 K", "K熱電対")],
    ["CGS-0001", (d) => `${d} `],
  ];
  let dupNo = 0;
  for (const [src, alter] of dups) {
    const base = records.find((r) => r.attrs.itemnum === src);
    if (!base) continue;
    dupNo++;
    records.push({ attrs: { ...base.attrs, itemnum: `Z-${pad(dupNo, 4)}`, description: alter(String(base.attrs.description)), itemid: records.length + 1, status: "ACTIVE" } });
    problems.add("ITEM_DUPLICATE", "同じ部品が別の品目番号・別の表記で重複して登録されている", "ITEM.ITEMNUM / DESCRIPTION（Z- で始まる品目）");
  }
  return { records, byKey };
}

// ---------------------------------------------------------------------------
// 作業計画
// ---------------------------------------------------------------------------

function buildJobPlans(itemByKey: Map<string, string>, ids: Ids): Rec[] {
  return PM_PROGRAMS.map((p) => ({
    attrs: {
      jpnum: p.jp, description: p.desc, status: "ACTIVE", orgid: ORGID, siteid: null, pluscrevnum: 0, jpduration: p.dur,
      jobplanid: ids.next("jobplanid"), interruptible: false, templatetype: null, laborcode: null, crewid: null,
    },
    children: {
      jobtask: p.tasks.map((desc, i) => ({ jobtaskid: ids.next("jobtaskid"), jptask: (i + 1) * 10, description: desc, orgid: ORGID, siteid: null })),
      joblabor: [{ joblaborid: ids.next("joblaborid"), craft: p.contractor ? "CONTR" : p.craft, skilllevel: null, quantity: p.crew, laborhrs: p.dur, orgid: ORGID }],
      jobmaterial: (p.materials ?? []).flatMap(([key, qty]) => {
        const itemnum = itemByKey.get(key);
        return itemnum ? [{ jobmaterialid: ids.next("jobmaterialid"), itemnum, itemsetid: ITEMSETID, itemqty: qty, orgid: ORGID }] : [];
      }),
    },
  }));
}

// ---------------------------------------------------------------------------
// 人
// ---------------------------------------------------------------------------

const usedIds = new Set<string>();

function makePersonId(last: string, first: string): string {
  const base = `${first[0]}${last}`.toUpperCase();
  let id = base;
  for (let n = 2; usedIds.has(id); n++) id = `${base}${n}`;
  usedIds.add(id);
  return id;
}

function buildContractors(rng: Rng): Person[] {
  usedIds.clear();
  const out: Person[] = [];
  for (const c of COMPANIES.filter((x) => x.company.startsWith("VND-"))) {
    const craft = c.company === "VND-EA" ? "ELEC" : c.company === "VND-IA" ? "INST" : "MECH";
    for (let i = 0; i < 3; i++) {
      const [lj, lr] = rng.pick(SURNAMES);
      const [fj, fr] = rng.pick(GIVEN_NAMES);
      out.push({ personid: makePersonId(lr, fr), last: lj, first: fj, role: "CONTR", title: "協力会社 作業責任者", craft, site: null, from: jst(2005, 4, 1), to: jst(2099, 1, 1), dept: c.name });
    }
  }
  return out;
}

function personAttrs(p: Person): Row {
  return {
    personid: p.personid, displayname: `${p.last} ${p.first}`, lastname: p.last, firstname: p.first, status: p.to > NOW ? "ACTIVE" : "INACTIVE",
    title: p.title, department: p.dept, locationsite: p.site, locationorg: ORGID, employeetype: p.role === "CONTR" ? "協力会社" : p.role === "SYS" ? "システム" : "職員",
    statusdate: fmt(p.to > NOW ? p.from : p.to),
  };
}

// ---------------------------------------------------------------------------
// 1 施設ぶん
// ---------------------------------------------------------------------------

class SiteContext {
  readonly locs: Loc[] = [];
  readonly positions: Position[] = [];
  readonly assets: Asset[] = [];
  readonly meterReadings: Row[] = [];
  readonly pms: Row[] = [];
  readonly persons: Person[] = [];
  readonly wos: WoDraft[] = [];
  readonly srs: SrDraft[] = [];
  private readonly site: SiteDef;
  private readonly rng: Rng;
  private readonly ids: Ids;
  private readonly problems: Problems;
  private readonly historyFrom: number;
  private readonly contractors: Person[];
  private readonly start: number;
  private readonly unitLocs: Array<{ loc: string; desc: string; line: number; system: string; unit: string }> = [];
  private readonly lineLocs: Array<{ loc: string; line: number; desc: string }> = [];
  private assetSeq = 0;
  private pmSeq = 0;

  constructor(site: SiteDef, rng: Rng, ids: Ids, problems: Problems, historyFrom: number, contractors: Person[]) {
    this.site = site;
    this.rng = rng;
    this.ids = ids;
    this.problems = problems;
    this.historyFrom = historyFrom;
    this.contractors = contractors;
    this.start = jst(site.start.y, site.start.m, 1);
  }

  build(): void {
    this.buildLocations();
    this.buildAssets();
    this.buildPeople();
    this.buildMeters();
    this.buildPmsAndWork();
    this.buildCorrective();
    this.injectAssetProblems();
  }

  private get p(): string {
    return this.site.prefix;
  }

  private lineName(line: number): string {
    return line === 0 ? "共通" : `${line}号炉`;
  }

  // ---- 場所 ----

  private addLoc(l: Omit<Loc, "siteid">): void {
    this.locs.push({ ...l, siteid: this.site.siteid });
  }

  private buildLocations(): void {
    const s = this.site;
    const p = this.p;
    this.addLoc({
      location: p, description: s.description, type: "OPERATING", parent: null, cls: "LOC-PLANT",
      specs: [["CAPACITY_TD", s.tonPerLine * s.lines], ["LINES", s.lines], ["COMMISSIONED", `${s.start.y}年${s.start.m}月`], ["FURNACE_TYPE", "全連続燃焼式ストーカ炉"]],
    });
    for (let line = 0; line <= s.lines; line++) {
      const lloc = `${p}-${line === 0 ? "CM" : `L${line}`}`;
      this.addLoc({ location: lloc, description: line === 0 ? `${s.description} 共通設備` : `${line}号炉`, type: "OPERATING", parent: p, cls: line === 0 ? "LOC-SYSTEM" : "LOC-LINE", ...(line === 0 ? {} : { specs: [["CAPACITY_TD", s.tonPerLine]] }) });
      if (line > 0) this.lineLocs.push({ loc: lloc, line, desc: `${line}号炉` });
      for (const sys of SYSTEMS) {
        const units = sys.units.filter((u) => u.perLine === line > 0 && (!u.only || u.only.includes(s.siteid)));
        if (units.length === 0) continue;
        const sloc = `${p}-${line}-${sys.code}`;
        this.addLoc({ location: sloc, description: `${this.lineName(line)} ${sys.name}`, type: "OPERATING", parent: lloc, cls: "LOC-SYSTEM" });
        for (const u of units) {
          const uloc = `${sloc}-${u.code}`;
          const udesc = `${this.lineName(line)} ${u.name}`;
          this.addLoc({ location: uloc, description: udesc, type: "OPERATING", parent: sloc, cls: "LOC-UNIT" });
          this.unitLocs.push({ loc: uloc, desc: udesc, line, system: sys.code, unit: u.code });
          this.buildPositions(uloc, line, sys.band, u);
        }
      }
    }
    this.addLoc({ location: `${p}-STORE`, description: `${s.description} 部品倉庫`, type: "STOREROOM", parent: null, cls: "LOC-STORE" });
    this.addLoc({ location: `${p}-SALVAGE`, description: `${s.description} 撤去品置場`, type: "SALVAGE", parent: null, cls: null });
  }

  private readonly tagCounters = new Map<string, number>();

  private nextTagNo(line: number, band: number, t: string): number {
    const k = `${line}|${band}|${t}`;
    const n = (this.tagCounters.get(k) ?? 0) + 1;
    this.tagCounters.set(k, n);
    return band + n;
  }

  private buildPositions(uloc: string, line: number, band: number, u: UnitDef): void {
    const s = this.site;
    const items: ItemDef[] = [...u.items];
    // 計器と弁を機能位置として足す
    for (const tok of (u.x ?? "").split(" ").filter(Boolean)) {
      const t = tok.slice(0, 2);
      const n = Number(tok.slice(2));
      const inst = INSTRUMENTS[t]!;
      for (let i = 0; i < n; i++) items.push({ t, c: "XMTR", n: `${u.name} ${inst.n}`, p: { MEAS_TYPE: inst.type, MEAS_RANGE: inst.ranges } });
    }
    for (const tok of (u.v ?? "").split(" ").filter(Boolean)) {
      const t = tok.slice(0, 2);
      const n = Number(tok.slice(2));
      const v = VALVES[t]!;
      for (let i = 0; i < n; i++) items.push({ t, c: v.c, n: `${u.name} ${v.n}`, p: t === "MV" ? { ACTUATOR: "電動" } : {} });
    }
    const instCount = new Map<string, number>();
    for (const item of items) {
      if (item.only && !item.only.includes(s.siteid)) continue;
      const qty = item.q === -1 ? s.lines + 1 : (item.q ?? 1);
      const added = item.added?.[s.siteid];
      const startMs = added !== undefined && added > s.start.y ? jst(added, this.rng.int(4, 10), 1) : this.start;
      let no = item.ab ? this.nextTagNo(line, band, item.t) : 0;
      for (let k = 0; k < qty; k++) {
        if (!item.ab) no = this.nextTagNo(line, band, item.t);
        const suffix = item.ab ? String.fromCharCode(65 + k) : "";
        const tag = `${line}-${item.t}-${no}${suffix}`;
        const loc = `${this.p}-${tag}`;
        let name = item.n;
        if (item.ab) name = `${item.n} ${suffix}号機`;
        else if (item.c === "XMTR" || item.c === "CVALVE" || item.c === "MOV") {
          const c = (instCount.get(item.n) ?? 0) + 1;
          instCount.set(item.n, c);
          name = `${item.n} No.${c}`;
        } else if (item.c === "FBAG") name = `${item.n}（第${k + 1}室）`;
        else if (qty > 1) name = `${item.n} No.${k + 1}`;
        const desc = line === 0 ? name : `${this.lineName(line)} ${name}`;
        this.addLoc({ location: loc, description: desc, type: "OPERATING", parent: uloc, cls: "LOC-POS" });
        const priority = item.pr ?? (item.c === "XMTR" || item.c === "CVALVE" || item.c === "MOV" ? 3 : line > 0 ? 2 : 3);
        const util = this.utilOf(item, !!item.ab);
        const pos: Position = { site: s, loc, unitLoc: uloc, line, tag, desc, item, cls: item.c, priority, start: startMs, util, gens: [] };
        this.positions.push(pos);
        const children: ChildDef[] = [...(item.ch ?? [])];
        if (item.m) children.unshift({ t: "M", c: "MOTOR", n: "電動機", kw: item.m });
        if (item.inv) children.push({ t: "IV", c: "INV", n: "インバータ" });
        let motorKw: number | undefined;
        for (const ch of children) {
          const kw = ch.kw ? pickMotorKw(this.rng, ch.kw) : ch.c === "INV" ? motorKw : undefined;
          if (ch.c === "MOTOR" && ch.t === "M") motorKw = kw;
          this.positions.push({
            site: s, loc, unitLoc: uloc, line, tag: `${line}-${ch.t}-${no}${suffix}`, desc: `${desc} ${ch.n}`, item: null, cls: ch.c,
            priority, start: startMs, child: ch, parentPos: pos, util, gens: [], ...(kw !== undefined ? { kw } : {}),
          });
        }
      }
    }
  }

  private utilOf(item: ItemDef, ab: boolean): number {
    if (/消火|補助加圧|非常用/.test(item.n)) return 0.004;
    if (item.c === "CRANE") return this.rng.real(0.45, 0.7);
    if (ab) return this.rng.real(0.4, 0.6);
    if (/換気|空調|エアカーテン/.test(item.n)) return this.rng.real(0.5, 0.9);
    return this.rng.real(0.8, 0.95);
  }

  // ---- 資産（更新の世代を含む） ----

  private buildAssets(): void {
    for (const pos of this.positions) {
      const cls = CLASS_BY_ID.get(pos.cls)!;
      let t = pos.start - this.rng.int(20, 150) * DAY;
      if (pos.start > this.start) t = pos.start;
      for (;;) {
        const life = cls.life ? this.rng.real(cls.life[0], cls.life[1] + 0.99) : Infinity;
        const end = Number.isFinite(life) ? atTime(t + life * 365.25 * DAY, 10) : Infinity;
        const a = this.newAsset(pos, t, end <= NOW ? end : null);
        pos.gens.push(a);
        if (end > NOW) break;
        t = end;
      }
    }
    // 子の資産の親（いま稼働中の親）
    for (const pos of this.positions) {
      if (!pos.parentPos) continue;
      for (const a of pos.gens) {
        if (a.decom !== null) continue;
        const parent = pos.parentPos.gens.find((g) => g.decom === null);
        a.parent = parent ? parent.assetnum : null;
      }
    }
  }

  private newAsset(pos: Position, install: number, decom: number | null): Asset {
    const s = this.site;
    const rng = this.rng;
    const assetnum = String(s.assetBase + ++this.assetSeq);
    const makers = CLASS_MAKERS[pos.cls];
    const original = install <= this.start;
    const maker = makers ? rng.pick(makers) : s.epc;
    const vendor = original ? s.epc : rng.pick(["VND-MA", "VND-MB", "VND-EA", "VND-IA", "VND-SA"]);
    const iy = ymd(install).y;
    const serial = `${(MODEL_PREFIX[pos.cls] ?? "X").slice(0, 2)}${String(iy).slice(2)}-${rng.int(10000, 99999)}`;
    const a: Asset = {
      assetnum, pos, install, decom, desc: pos.desc, tag: pos.tag, location: pos.loc, parent: null, serial, maker, vendor, specs: null, meters: [], cls: pos.cls,
    };
    if (decom !== null) {
      if (rng.chance(0.88)) a.location = `${this.p}-SALVAGE`;
      else this.problems.add("DECOM_AT_POSITION", "撤去済み（DECOMMISSIONED）の資産が機能位置に残ったまま（同じ位置に稼働中の資産と 2 台）", "ASSET.LOCATION / STATUS");
    }
    a.specs = this.makeSpecs(a, iy);
    this.assets.push(a);
    return a;
  }

  private makeSpecs(a: Asset, iy: number): Row[] {
    const cls = CLASS_BY_ID.get(a.pos.cls)!;
    const rng = this.rng;
    const p = a.pos.item?.p ?? {};
    const kw = a.pos.kw;
    const s = this.site;
    const out: Row[] = [];
    const poles = kw !== undefined ? (kw > 90 ? 4 : rng.pick([2, 4, 4, 4, 6])) : 4;
    (cls.specs ?? []).forEach((attrId, i) => {
      const def = ATTR_BY_ID.get(attrId)!;
      let v: CellValue = null;
      const given = p[attrId];
      switch (attrId) {
        case "MODEL":
          v = `${MODEL_PREFIX[a.pos.cls] ?? "X"}-${rng.int(100, 999)}${rng.pick(["", "", "A", "B", "S", "E"])}`;
          break;
        case "MFG_YEAR":
          v = iy - (rng.chance(0.3) ? 1 : 0);
          break;
        case "RATED_POWER":
          v = kw ?? null;
          break;
        case "RATED_VOLTAGE":
          if (a.pos.cls === "MOTOR" || a.pos.cls === "INV") v = (kw ?? 0) >= 200 ? 6600 : (kw ?? 0) < 0.75 ? 200 : 400;
          else if (a.pos.cls === "BRKR") v = a.pos.item?.n === "受電遮断器" ? s.receiveV : 6600;
          else if (a.pos.cls === "GEN") v = 6600;
          else v = typeof given === "number" ? given : 400;
          break;
        case "RATED_CURRENT":
          if (kw !== undefined) {
            const volt = kw >= 200 ? 6600 : kw < 0.75 ? 200 : 400;
            v = round((kw * 1000) / (1.732 * volt * 0.88 * 0.9), 1);
          } else v = rng.pick([600, 1200, 2000]);
          break;
        case "POLES":
          v = poles;
          break;
        case "RATED_SPEED":
          if (a.pos.cls === "TURBINE") v = rng.pick([6000, 7500, 8500]);
          else if (a.pos.cls === "GEN") v = 1500;
          else v = ({ 2: 2950, 4: 1470, 6: 980 } as Record<number, number>)[poles]! - rng.int(0, 25);
          break;
        case "FRAME_NO":
          v = kw === undefined ? null : kw < 2 ? "90L" : kw < 6 ? "112M" : kw < 12 ? "132M" : kw < 20 ? "160L" : kw < 40 ? "200L" : kw < 80 ? "250M" : kw < 170 ? "315M" : "400";
          break;
        case "RATED_KVA":
          if (a.pos.cls === "INV") v = kw !== undefined ? Math.ceil(kw * 1.3) : rng.int(20, 200);
          else if (a.pos.cls === "GEN") v = Math.round(s.turbineKw / 0.85 / 100) * 100;
          else if (a.pos.item?.n === "主変圧器") v = s.receiveV > 6600 ? 10000 : 5000;
          break;
        case "PRIMARY_V":
          v = a.pos.item?.n === "主変圧器" ? s.receiveV : 6600;
          break;
        case "SECONDARY_V":
          v = a.pos.item?.n === "主変圧器" && s.receiveV > 6600 ? 6600 : 420;
          break;
        case "BREAKER_TYPE":
          v = a.pos.item?.n === "受電遮断器" && s.receiveV > 6600 ? "GCB" : "VCB";
          break;
        case "OUTPUT_KW":
          v = s.turbineKw;
          break;
        case "STEAM_PRESS":
          v = s.siteid === "KITA" ? 3.0 : 4.0;
          break;
        case "STEAM_TEMP":
          v = s.siteid === "KITA" ? 300 : 400;
          break;
        case "STEAM_FLOW":
          v = round(s.tonPerLine * 0.14 + rng.real(-0.5, 0.5), 1);
          break;
        case "GAS_FLOW":
          v = Math.round((s.tonPerLine * 330 + rng.int(-1500, 1500)) / 100) * 100;
          break;
        case "BAG_COUNT":
          v = a.pos.cls === "FBAG" ? rng.int(60, 80) : rng.int(380, 480);
          break;
      }
      if (v === null && given !== undefined) {
        if (Array.isArray(given)) v = typeof given[0] === "number" ? round(rng.real(given[0] as number, given[1] as number), digitsOf(def)) : rng.pick(given as string[]);
        else v = given;
      }
      if (v === null && def.def) {
        if (typeof def.def[0] === "number") {
          const [min, max, d] = def.def as [number, number, number];
          v = round(rng.real(min, max), d);
        } else v = rng.pick(def.def as string[]);
      }
      const row: Row = {
        assetspecid: this.ids.next("assetspecid"), assetattrid: attrId, classstructureid: CLASS_CSID.get(a.pos.cls)!, displaysequence: (i + 1) * 10,
        alnvalue: def.type === "ALN" ? (v === null ? null : String(v)) : null, numvalue: def.type === "NUMERIC" && typeof v === "number" ? v : null,
        measureunitid: def.unit ?? null, changedate: fmt(a.install), changeby: "MAXADMIN",
      };
      out.push(row);
    });
    return out;
  }

  // ---- 人 ----

  private readonly byRole = new Map<string, Person[]>();

  private buildPeople(): void {
    const rng = this.rng.fork("people");
    for (const role of ROLES) {
      const slots = Math.max(1, Math.round(role.base + role.perLine * this.site.lines));
      const list: Person[] = [];
      for (let slot = 0; slot < slots; slot++) {
        let from = this.start - rng.int(0, 4) * 365 * DAY;
        while (from < NOW + 365 * DAY) {
          const tenure = role.supervisor ? rng.real(3, 7) : rng.real(5, 16);
          const to = from + tenure * 365.25 * DAY;
          const [lj, lr] = rng.pick(SURNAMES);
          const [fj, fr] = rng.pick(GIVEN_NAMES);
          const person: Person = {
            personid: makePersonId(lr, fr), last: lj, first: fj, role: role.role, title: role.title, craft: role.craft, site: this.site.siteid,
            from: Math.max(from, jst(2004, 4, 1)), to: to > NOW ? jst(2099, 1, 1) : atTime(to, 17), dept: `${this.site.description} ${role.craft === "OPER" ? "運転係" : role.craft === "MECH" ? "機械係" : role.craft === "CIVIL" ? "管理係" : "電気計装係"}`,
          };
          if (person.from <= NOW) list.push(person);
          from = to + rng.int(0, 30) * DAY;
          if (to > NOW) break;
        }
      }
      this.byRole.set(role.role, list);
      this.persons.push(...list);
    }
  }

  private personAt(role: string, ms: number): string {
    const list = this.byRole.get(role) ?? [];
    const active = list.filter((p) => p.from <= ms && p.to > ms);
    const pool = active.length > 0 ? active : list;
    return this.rng.pick(pool).personid;
  }

  private supervisorFor(craft: string, ms: number): string {
    return this.personAt(craft === "ELEC" || craft === "INST" ? "ELECL" : craft === "OPER" ? "OPERL" : "MECHL", ms);
  }

  private leadFor(craft: string, ms: number, contractor: boolean): string {
    if (contractor) {
      const pool = this.contractors.filter((c) => c.craft === (craft === "INST" ? "INST" : craft === "ELEC" ? "ELEC" : "MECH"));
      return this.rng.pick(pool.length > 0 ? pool : this.contractors).personid;
    }
    return this.personAt(craft === "CONTR" ? "MECH" : craft, ms);
  }

  private group(craft: string): string {
    const c = craft === "CONTR" ? "MECH" : craft;
    return `${this.p}-${c}`;
  }

  personGroups(): Rec[] {
    return CRAFTS.filter(([c]) => c !== "CONTR").map(([craft, desc]) => {
      const members = this.persons.filter((p) => p.craft === craft && p.to > NOW);
      return {
        attrs: { persongroup: this.group(craft), description: `${this.site.description} ${desc}班`, siteid: null, orgid: ORGID },
        children: {
          persongroupteam: members.map((m, i) => ({ persongroupteamid: this.ids.next("persongroupteamid"), respparty: m.personid, resppartygroupseq: i + 1, groupdefault: i === 0, useforsite: this.site.siteid, usefororg: ORGID })),
        },
      };
    });
  }

  // ---- メーター ----

  private buildMeters(): void {
    const rng = this.rng.fork("meters");
    const operators = this.byRole.get("OPER") ?? [];
    for (const a of this.assets) {
      const cls = CLASS_BY_ID.get(a.pos.cls)!;
      for (const m of cls.meters ?? []) {
        const meterId = this.ids.next("assetmeterid");
        const end = a.decom ?? NOW;
        let reading = 0;
        let lastDate: number | null = null;
        let t = addMonths(atTime(Math.max(a.install, this.start), 9), 1);
        let lastReading: number | null = null;
        if (m === "VIBRATION") {
          a.meters.push({ assetmeterid: meterId, metername: m, active: a.decom === null, lastreading: String(round(rng.real(0.8, 6.5), 1)), lastreadingdate: fmt(atTime(end - rng.int(1, 30) * DAY, 10)), measureunitid: "MM/S" });
          continue;
        }
        while (t <= end) {
          const hours = 720 * a.pos.util * rng.real(0.85, 1.05);
          const delta = m === "RUNHOURS" ? (a.pos.util < 0.01 ? rng.int(1, 3) : Math.round(hours)) : m === "STARTS" ? (a.pos.cls === "EGEN" ? rng.int(1, 2) : rng.int(0, 2)) : m === "CRANECYCLE" ? Math.round(hours * rng.real(15, 25)) : round((this.site.turbineKw / 1000) * hours * rng.real(0.55, 0.8), 1);
          reading = round(reading + delta, 1);
          if (t >= this.historyFrom) {
            this.meterReadings.push({
              meterreadingid: this.ids.next("meterreadingid"), assetnum: a.assetnum, siteid: this.site.siteid, orgid: ORGID, metername: m,
              reading, delta, readingdate: fmt(t), inspector: operators.length > 0 ? this.personAt("OPER", t) : null, enterby: "MXINTADM", isdelta: false,
            });
          }
          lastDate = t;
          lastReading = reading;
          t = addMonths(t, 1);
        }
        a.meters.push({
          assetmeterid: meterId, metername: m, active: a.decom === null, lastreading: lastReading === null ? null : String(lastReading),
          lastreadingdate: lastDate === null ? null : fmt(lastDate), measureunitid: METERS.find((x) => x.name === m)!.unit,
        });
      }
    }
  }

  // ---- PM と予防保全の作業指示 ----

  private buildPmsAndWork(): void {
    const rng = this.rng.fork("pm");
    // 資産の PM（機能位置の系列ごと）
    for (const pos of this.positions) {
      for (const prog of PM_PROGRAMS) {
        if (prog.overhaulOnly || !prog.cls.includes(pos.cls)) continue;
        if (prog.critical && pos.priority !== 1) continue;
        if (prog.minKw !== undefined && (pos.kw ?? 0) < prog.minKw) continue;
        this.assetPm(rng, pos, prog);
      }
    }
    // 場所の PM
    for (const prog of PM_PROGRAMS) {
      for (const c of prog.cls) {
        if (c === "LOC-UNIT") for (const u of this.unitLocs) this.locationPm(rng, prog, u.loc, u.desc, "OPER");
        else if (c === "LOC-LINE") for (const l of this.lineLocs) this.lineOverhaulPm(rng, prog, l.loc, l.line, l.desc);
        else if (c.startsWith("LOC:")) {
          const [sys, unit] = c.slice(4).split("-");
          for (const u of this.unitLocs.filter((x) => x.system === sys && x.unit === unit)) this.locationPm(rng, prog, u.loc, u.desc, prog.craft);
        }
      }
    }
  }

  private newPmNum(): string {
    return `${this.p}${pad(++this.pmSeq, 5)}`;
  }

  /** 期日の列（start から freq ごと、NOW + 先行日数まで） */
  private dues(prog: { freq: number; unit: string }, start: number, end: number): number[] {
    const months = prog.unit === "YEARS" ? prog.freq * 12 : prog.freq;
    const out: number[] = [];
    for (let k = 0; ; k++) {
      const d = addMonths(start, months * k);
      if (d > end) break;
      out.push(weekday(d));
    }
    return out;
  }

  private firstDue(rng: Rng, prog: PmProgram, from: number): number {
    const months = prog.unit === "YEARS" ? prog.freq * 12 : prog.freq;
    return weekday(atTime(addMonths(from, rng.int(1, Math.max(1, months))) + rng.int(0, 27) * DAY, 9));
  }

  private assetPm(rng: Rng, pos: Position, prog: PmProgram): void {
    const pmnum = this.newPmNum();
    const lead = 14 * DAY;
    const replaced = pos.gens.length > 1;
    const stale = replaced && rng.chance(0.1);
    const first = this.firstDue(rng, prog, Math.max(pos.gens[0]!.install, this.start));
    const end = stale ? pos.gens[0]!.decom! : NOW + lead;
    let lastComp: string | null = null;
    let lastStart: number | null = null;
    let next: number | null = null;
    for (const due of this.dues(prog, first, end + 400 * DAY)) {
      if (due - lead > NOW || due > end) {
        next = due;
        break;
      }
      const asset = pos.gens.find((g) => g.install <= due && (g.decom === null || g.decom > due));
      if (!asset) continue;
      const wo = this.pmWork(rng, prog, due, asset, pos.loc, pmnum);
      if (wo) {
        const fin = wo.attrs.actfinish;
        if (typeof fin === "string") lastComp = fin;
        lastStart = due;
      }
    }
    const current = stale ? pos.gens[0]! : pos.gens[pos.gens.length - 1]!;
    if (stale) this.problems.add("PM_DECOMMISSIONED_ASSET", "PM が撤去済みの資産を指したまま（更新後の資産に付け替えていない。次回日が過去のまま止まっている）", "PM.ASSETNUM / NEXTDATE");
    this.pms.push(this.pmRow(pmnum, prog, current.assetnum, pos.loc, `${current.desc} ${shortDesc(prog)}`, next, lastComp, lastStart, current.decom === null || stale ? "ACTIVE" : "INACTIVE"));
  }

  private pmRow(pmnum: string, prog: PmProgram, assetnum: string | null, location: string, desc: string, next: number | null, lastComp: string | null, lastStart: number | null, status: string): Row {
    return {
      pmnum, siteid: this.site.siteid, orgid: ORGID, description: clip(desc, 100), status, assetnum, location, jpnum: prog.jp,
      frequency: prog.freq, frequnit: prog.unit, worktype: prog.worktype, leadtime: 14, nextdate: next === null ? null : fmt(next),
      lastcompdate: lastComp, laststartdate: lastStart === null ? null : fmt(lastStart),
      ownergroup: this.group(prog.craft), priority: prog.law ? 1 : 2, usetargetdate: true, pmid: this.ids.next("pmid"),
    };
  }

  private locationPm(rng: Rng, prog: PmProgram, loc: string, desc: string, craft: string): void {
    const pmnum = this.newPmNum();
    const lead = 14 * DAY;
    let lastComp: string | null = null;
    let lastStart: number | null = null;
    let next: number | null = null;
    for (const due of this.dues(prog, this.firstDue(rng, prog, this.start), NOW + 400 * DAY)) {
      if (due - lead > NOW) {
        next = due;
        break;
      }
      const wo = this.pmWork(rng, { ...prog, craft }, due, null, loc, pmnum, desc);
      if (wo && typeof wo.attrs.actfinish === "string") lastComp = wo.attrs.actfinish;
      lastStart = due;
    }
    this.pms.push(this.pmRow(pmnum, prog, null, loc, `${desc} ${shortDesc(prog)}`, next, lastComp, lastStart, "ACTIVE"));
  }

  private lineOverhaulPm(rng: Rng, prog: PmProgram, loc: string, line: number, desc: string): void {
    const pmnum = this.newPmNum();
    let lastComp: string | null = null;
    let next: number | null = null;
    let lastStartOh: number | null = null;
    // 春（5 月）と秋（11 月）。炉ごとに 2〜3 週ずらす
    const offset = (line - 1) * 21 * DAY;
    for (let y = ymd(this.start).y; y <= 2027; y++) {
      for (const m of [5, 11]) {
        const due = weekday(atTime(jst(y, m, 8) + offset, 9));
        if (due < this.start + 120 * DAY) continue;
        if (due - 30 * DAY > NOW) {
          next ??= due;
          continue;
        }
        const parent = this.pmWork(rng, prog, due, null, loc, pmnum, desc, 30 * DAY);
        if (!parent) continue;
        lastStartOh = due;
        if (typeof parent.attrs.actfinish === "string") lastComp = parent.attrs.actfinish;
        const spring = m === 5;
        for (const pos of this.positions) {
          if (pos.line !== line || !OVERHAUL_CLASSES.includes(pos.cls)) continue;
          const childProg = PM_PROGRAMS.find((x) => x.overhaulOnly && x.cls.includes(pos.cls) && (!x.critical || pos.priority === 1));
          if (!childProg) continue;
          if (childProg.unit === "YEARS" && childProg.freq === 1 && !spring && childProg.jp !== "JP-DAMPER-OH") continue;
          if (childProg.jp === "JP-DAMPER-OH" && spring) continue;
          if (childProg.freq === 2 && (spring || y % 2 !== 0)) continue;
          const asset = pos.gens.find((g) => g.install <= due && (g.decom === null || g.decom > due));
          if (!asset) continue;
          const childDue = due + rng.int(1, 12) * DAY;
          const child = this.pmWork(rng, childProg, childDue, asset, pos.loc, null, undefined, undefined, parent);
          if (child) child.parentRef = parent;
        }
      }
    }
    this.pms.push(this.pmRow(pmnum, prog, null, loc, `${desc} ${shortDesc(prog)}`, next, lastComp, lastStartOh, "ACTIVE"));
  }

  /** 予防保全・点検・校正の作業指示を 1 件作る */
  private pmWork(rng: Rng, prog: PmProgram, due: number, asset: Asset | null, location: string, pmnum: string | null, locDesc?: string, leadOverride?: number, parent?: WoDraft): WoDraft | null {
    const lead = leadOverride ?? 14 * DAY;
    const report = parent ? parent.report : atTime(due - lead, 6, 0);
    if (due < this.historyFrom) return null;
    const durH = prog.dur;
    const law = prog.law === true;
    const desc = clip(`${law ? "【法定】" : ""}${asset ? asset.desc : (locDesc ?? "")} ${shortDesc(prog).replace("【法定】", "")}`, 100);
    const cancel = law ? 0.003 : prog.jp === "JP-LINE-OH" ? 0 : prog.worktype === "INSP" && prog.freq === 1 && prog.unit === "MONTHS" ? 0.06 : 0.03;
    const life = this.lifecycle(rng, report, due, durH, { cancel, startDelayDays: law ? [0, 3] : [0, 14], kind: "PM" });
    const crew = prog.crew;
    const wo: WoDraft = {
      site: this.site,
      report,
      statuses: life.hist,
      failure: [],
      attrs: {
        siteid: this.site.siteid, orgid: ORGID, description: desc, worktype: prog.worktype, status: life.status, statusdate: fmt(life.hist[life.hist.length - 1]![1]),
        reportdate: fmt(report), reportedby: "MAXADMIN", targstartdate: fmt(due), targcompdate: fmt(due + calendarMs(durH)),
        schedstart: fmt(due), schedfinish: fmt(due + calendarMs(durH)), actstart: life.actStart === null ? null : fmt(life.actStart),
        actfinish: life.actFinish === null ? null : fmt(life.actFinish), wopriority: law ? 1 : asset ? Math.min(3, asset.pos.priority + 1) : 3,
        assetnum: asset ? asset.assetnum : null, location, pmnum, jpnum: prog.jp, failurecode: asset ? (CLASS_BY_ID.get(asset.pos.cls)?.failure ?? null) : null,
        problemcode: null, estdur: durH, estlabhrs: round(durH * crew, 1), actlabhrs: life.actHours === null ? 0 : round(life.actHours * crew, 1),
        supervisor: this.supervisorFor(prog.craft, due), lead: life.status === "WAPPR" ? null : this.leadFor(prog.craft, due, prog.contractor === true),
        ownergroup: this.group(prog.craft), woclass: "WORKORDER", historyflag: life.status === "CLOSE" || life.status === "CAN", istask: false,
        parent: null, origrecordid: null, origrecordclass: null, description_longdescription: null, downtime: false,
      },
    };
    if (prog.jp === "JP-LINE-OH") wo.attrs.downtime = true;
    if (parent) wo.parentRef = parent;
    this.wos.push(wo);
    return wo;
  }

  /** ステータスの履歴と実績の日時 */
  private lifecycle(
    rng: Rng, report: number, start: number, durH: number,
    o: { cancel: number; startDelayDays: [number, number]; kind: "PM" | "CM" | "EM" },
  ): { status: string; hist: Array<[string, number, string]>; actStart: number | null; actFinish: number | null; actHours: number | null } {
    const by = o.kind === "PM" ? "MAXADMIN" : this.personAt("OPERL", report);
    const sup = this.supervisorFor("MECH", report);
    const hist: Array<[string, number, string]> = [["WAPPR", report, by]];
    const done = (status: string) => ({ status, hist, actStart: null, actFinish: null, actHours: null });
    if (rng.chance(o.cancel)) {
      const at = Math.min(NOW - HOUR, report + rng.int(1, 20) * DAY);
      if (at > report) {
        hist.push(["CAN", at, sup]);
        return done("CAN");
      }
    }
    const approve = report + (o.kind === "EM" ? rng.int(5, 40) * 60_000 : o.kind === "CM" ? rng.int(1, 48) * HOUR : rng.int(1, 4) * DAY);
    if (approve > NOW) return done("WAPPR");
    hist.push(["APPR", approve, sup]);
    let actStart = Math.max(start + rng.int(o.startDelayDays[0], o.startDelayDays[1]) * DAY, approve + HOUR);
    if (o.kind !== "EM") actStart = weekday(atTime(actStart, rng.pick([8, 9, 9, 10, 13])));
    if (actStart < approve + HOUR) actStart = approve + HOUR;
    if (o.kind === "CM" && rng.chance(0.08)) {
      const wm = approve + rng.int(1, 3) * HOUR;
      if (wm < NOW) {
        hist.push(["WMATL", wm, sup]);
        actStart = Math.max(actStart, wm + rng.int(7, 45) * DAY);
        actStart = weekday(atTime(actStart, 9));
        if (actStart > NOW) return done("WMATL");
        hist.push(["APPR", actStart - 2 * HOUR, sup]);
      }
    }
    if (actStart > NOW) return done("APPR");
    const lead = this.personAt("MECH", actStart);
    hist.push(["INPRG", actStart, lead]);
    // データ品質: 着手したまま何か月も閉じていない作業指示
    if (report < NOW - 180 * DAY && rng.chance(0.01)) {
      this.problems.add("WO_STALE_OPEN", "半年以上前に着手したまま完了・クローズしていない作業指示（INPRG のまま）", "WORKORDER.STATUS / ACTFINISH");
      return { status: "INPRG", hist, actStart, actFinish: null, actHours: null };
    }
    const actHours = round(durH * rng.real(0.7, 1.5), 1);
    const actFinish = actStart + calendarMs(actHours);
    if (actFinish > NOW) return { status: "INPRG", hist, actStart, actFinish: null, actHours: null };
    hist.push(["COMP", actFinish, lead]);
    const close = actFinish + rng.int(1, 30) * DAY;
    if (close > NOW || rng.chance(0.02)) return { status: "COMP", hist, actStart, actFinish, actHours };
    hist.push(["CLOSE", close, sup]);
    return { status: "CLOSE", hist, actStart, actFinish, actHours };
  }

  // ---- 故障（是正保全・緊急保全）と運転員の SR ----

  private buildCorrective(): void {
    const rng = this.rng.fork("cm");
    for (const a of this.assets) {
      if (a.duplicate) continue;
      const cls = CLASS_BY_ID.get(a.pos.cls)!;
      if (!cls.cmRate || !cls.failure) continue;
      const end = Math.min(a.decom ?? NOW, NOW);
      const tree = FAILURE_TREE[cls.failure]!;
      for (let t = Math.max(a.install, this.start); t < end; t += 30 * DAY) {
        const ageYears = (t - a.install) / (365.25 * DAY);
        const bathtub = ageYears < 1 ? 1.6 : ageYears > 10 ? 1 + (ageYears - 10) * 0.08 : 1;
        const n = rng.poisson((cls.cmRate * CM_SCALE * bathtub * 30) / 365);
        for (let k = 0; k < n; k++) {
          const at = t + rng.int(0, 29) * DAY + rng.int(0, 23) * HOUR + rng.int(0, 59) * 60_000;
          if (at >= end || at < this.historyFrom) continue;
          this.failure(rng, a, at, tree);
        }
      }
    }
    // WO にならなかった運転員の連絡（照明・清掃・問い合わせなど）
    const rngSr = this.rng.fork("sr-only");
    for (const u of this.unitLocs) {
      for (let t = Math.max(this.start, this.historyFrom); t < NOW; t += 30 * DAY) {
        const n = rngSr.poisson(0.12);
        for (let k = 0; k < n; k++) {
          const at = t + rngSr.int(0, 29) * DAY + rngSr.int(0, 23) * HOUR;
          if (at >= NOW) continue;
          this.standaloneSr(rngSr, u.loc, u.desc, at);
        }
      }
    }
  }

  private failure(rng: Rng, a: Asset, at: number, tree: Record<string, string[]>): void {
    const fcls = CLASS_BY_ID.get(a.pos.cls)!.failure!;
    const prob = rng.pick(Object.keys(tree));
    const causes = [...tree[prob]!, "UNKNOWN"];
    const cause = rng.chance(0.08) ? "UNKNOWN" : rng.pick(causes.slice(0, -1));
    const remedy = rng.pick(CAUSE_REMEDIES[cause] ?? ["REPAIR"]);
    const emergency = (a.pos.priority === 1 && rng.chance(0.35)) || rng.chance(0.06);
    const kind = emergency ? "EM" : "CM";
    const fromSr = rng.chance(0.55);
    const srReport = at;
    const report = fromSr ? at + rng.int(10, 600) * 60_000 : at;
    const durH = round(rng.real(1, emergency ? 8 : 16), 1);
    const start = emergency ? report + rng.int(10, 90) * 60_000 : report + rng.int(1, 21) * DAY;
    const life = this.lifecycle(rng, report, start, durH, { cancel: 0.03, startDelayDays: [0, 3], kind });
    const craft = ["MOTOR", "INV", "TRANSF", "BRKR", "SWGR", "GEN", "UPS", "EGEN"].includes(a.pos.cls) ? "ELEC" : ["XMTR", "ANLZ", "DCS", "CVALVE"].includes(a.pos.cls) ? "INST" : ["HVAC", "ELEV"].includes(a.pos.cls) ? "CIVIL" : "MECH";
    const pdesc = PROBLEMS[prob]!;
    // データ品質: 故障コードの欠け、自由記述だけの問題
    const r = rng.next();
    const codeMode = r < 0.12 ? "none" : r < 0.22 ? "freetext" : r < 0.27 ? "problemOnly" : "full";
    const longNote = `${fmt(at).slice(0, 16).replace("T", " ")} 運転員より連絡。${operatorText(rng, a.desc, prob)}`;
    const description = codeMode === "freetext" ? clip(`${a.desc} ${freeTextTitle(rng, prob)}`, 100) : clip(`${emergency ? "【緊急】" : ""}${a.desc} ${pdesc}`, 100);
    const location = rng.chance(0.03) ? a.pos.unitLoc : a.pos.loc;
    if (location !== a.pos.loc) this.problems.add("WO_LOCATION_MISMATCH", "作業指示の場所が資産の機能位置と違う（装置の場所を入れている）", "WORKORDER.LOCATION");
    const completed = life.status === "COMP" || life.status === "CLOSE";
    const wo: WoDraft = {
      site: this.site,
      report,
      statuses: life.hist,
      failure: [],
      attrs: {
        siteid: this.site.siteid, orgid: ORGID, description, worktype: kind, status: life.status, statusdate: fmt(life.hist[life.hist.length - 1]![1]),
        reportdate: fmt(report), reportedby: this.personAt("OPER", report), targstartdate: fmt(start), targcompdate: fmt(start + calendarMs(durH)),
        schedstart: life.status === "WAPPR" ? null : fmt(start), schedfinish: life.status === "WAPPR" ? null : fmt(start + calendarMs(durH)),
        actstart: life.actStart === null ? null : fmt(life.actStart), actfinish: life.actFinish === null ? null : fmt(life.actFinish),
        wopriority: emergency ? 1 : rng.pick([2, 2, 3]), assetnum: a.assetnum, location, pmnum: null, jpnum: null,
        failurecode: codeMode === "none" || codeMode === "freetext" ? null : fcls, problemcode: codeMode === "full" || codeMode === "problemOnly" ? prob : null,
        estdur: durH, estlabhrs: round(durH * 2, 1), actlabhrs: life.actHours === null ? 0 : round(life.actHours * 2, 1),
        supervisor: this.supervisorFor(craft, report), lead: life.status === "WAPPR" ? null : this.leadFor(craft, report, rng.chance(0.2)),
        ownergroup: this.group(craft), woclass: "WORKORDER", historyflag: life.status === "CLOSE" || life.status === "CAN", istask: false,
        parent: null, origrecordid: null, origrecordclass: null,
        description_longdescription: codeMode === "freetext" ? `${longNote}\n${completed ? `処置: ${remedyText(rng, cause, remedy)}` : ""}`.trim() : completed && rng.chance(0.5) ? `${longNote}\n処置: ${REMEDIES[remedy]}。` : null,
        downtime: emergency,
      },
    };
    if (codeMode === "none") this.problems.add("WO_NO_FAILURE_CODE", "是正・緊急保全の作業指示に故障コード（故障クラス・問題）が無い", "WORKORDER.FAILURECODE / PROBLEMCODE");
    if (codeMode === "freetext") this.problems.add("WO_FREETEXT_ONLY", "故障の内容が件名・長い説明の自由記述だけで、故障コードも故障報告も無い", "WORKORDER.DESCRIPTION / DESCRIPTION_LONGDESCRIPTION");
    if (codeMode === "problemOnly") this.problems.add("WO_PROBLEM_ONLY", "問題コードはあるが故障クラスが空（故障報告の原因・処置も無い）", "WORKORDER.FAILURECODE / FAILUREREPORT");
    if (codeMode === "full") {
      wo.failure.push(["PROBLEM", prob]);
      if (completed) {
        wo.failure.push(["CAUSE", cause]);
        wo.failure.push(["REMEDY", remedy]);
      }
    }
    if (completed && rng.chance(0.06)) {
      wo.attrs.actlabhrs = 0;
      this.problems.add("WO_NO_LABOR_HOURS", "完了した是正保全の作業指示に実績工数が無い（0）", "WORKORDER.ACTLABHRS");
    }
    this.wos.push(wo);
    if (fromSr) {
      const sr = this.makeSr(rng, srReport, a.desc, operatorText(rng, a.desc, prob), a.assetnum, a.pos.loc, life.status, life.actFinish, emergency ? 1 : 3);
      sr.wo = wo;
      wo.sr = sr;
    }
  }

  private makeSr(rng: Rng, at: number, subject: string, text: string, assetnum: string | null, location: string, woStatus: string | null, woFinish: number | null, priority: number): SrDraft {
    const op = this.personAt("OPER", at);
    const lead = this.personAt("OPERL", at);
    const hist: Array<[string, number, string]> = [["NEW", at, op]];
    let status = "NEW";
    const queued = at + rng.int(5, 120) * 60_000;
    if (queued < NOW) {
      hist.push(["QUEUED", queued, lead]);
      status = "QUEUED";
    }
    let finish: number | null = null;
    if (woStatus !== null && woStatus !== "WAPPR" && queued < NOW) {
      const inprog = queued + rng.int(10, 120) * 60_000;
      if (inprog < NOW) {
        hist.push(["INPROG", inprog, lead]);
        status = "INPROG";
      }
      if ((woStatus === "COMP" || woStatus === "CLOSE") && woFinish !== null) {
        hist.push(["RESOLVED", woFinish + HOUR, lead]);
        status = "RESOLVED";
        finish = woFinish + HOUR;
        const closed = woFinish + rng.int(1, 14) * DAY;
        if (closed < NOW) {
          hist.push(["CLOSED", closed, lead]);
          status = "CLOSED";
        }
      }
      if (woStatus === "CAN") {
        const closed = Math.min(NOW - HOUR, queued + rng.int(1, 10) * DAY);
        hist.push(["CLOSED", closed, lead]);
        status = "CLOSED";
      }
    }
    const sr: SrDraft = {
      site: this.site,
      report: at,
      statuses: hist,
      attrs: {
        class: "SR", siteid: this.site.siteid, orgid: ORGID, description: clip(subject.length > 0 ? `${subject} ${text.split("。")[0]}` : text, 100),
        description_longdescription: text, status, statusdate: fmt(hist[hist.length - 1]![1]), reportedby: op, affectedperson: op, reportdate: fmt(at),
        assetnum, assetsiteid: assetnum ? this.site.siteid : null, location, internalpriority: priority, reportedpriority: priority,
        ownergroup: this.group("OPER"), actualstart: hist.length > 2 ? fmt(hist[2]![1]) : null, actualfinish: finish === null ? null : fmt(finish),
      },
    };
    this.srs.push(sr);
    return sr;
  }

  private standaloneSr(rng: Rng, loc: string, desc: string, at: number): void {
    const [text, withAsset] = rng.pick(SR_ONLY_TEXTS);
    const sr = this.makeSr(rng, at, "", `${desc}：${text}`, null, loc, null, null, 3);
    // WO にしなかった連絡は、運転員が対応して閉じる（直近のものは未対応のまま）
    const done = at + rng.int(1, 72) * HOUR;
    if (done < NOW - 3 * DAY) {
      sr.statuses.push(["RESOLVED", done, this.personAt("OPERL", at)]);
      const closed = done + rng.int(1, 10) * DAY;
      if (closed < NOW) sr.statuses.push(["CLOSED", closed, this.personAt("OPERL", at)]);
      const last = sr.statuses[sr.statuses.length - 1]!;
      sr.attrs.status = last[0];
      sr.attrs.statusdate = fmt(last[1]);
      sr.attrs.actualfinish = fmt(done);
    }
    if (!withAsset) this.problems.add("SR_NO_ASSET", "資産・機能位置を特定しない運転員の連絡（場所が装置レベルだけ）", "SR.ASSETNUM");
  }

  // ---- 資産のデータ品質の問題 ----

  private injectAssetProblems(): void {
    const rng = this.rng.fork("dq");
    const s = this.site;
    const legacy = s.siteid !== "HIGASHI";
    const operating = this.assets.filter((a) => a.decom === null);
    for (const a of this.assets) {
      // 仕様の欠け（旧台帳から移行した古い施設ほど多い）
      if (a.specs && a.specs.length > 0) {
        const r = rng.next();
        if (r < (legacy ? 0.09 : 0.03)) {
          a.specs = [];
          this.problems.add("SPEC_MISSING_ALL", "分類はあるが仕様（ASSETSPEC）が 1 行も無い", "ASSET.ASSETSPEC");
        } else if (r < (legacy ? 0.25 : 0.1)) {
          const n = rng.int(1, Math.max(1, Math.floor(a.specs.length / 2)));
          for (let i = 0; i < n; i++) {
            const row = rng.pick(a.specs);
            row.alnvalue = null;
            row.numvalue = null;
          }
          this.problems.add("SPEC_BLANK_VALUES", "仕様の行はあるが値が空（一部の属性）", "ASSETSPEC.ALNVALUE / NUMVALUE");
        }
        for (const row of a.specs) {
          // 単位の不統一
          if (row.assetattrid === "FLOW" && typeof row.numvalue === "number" && rng.chance(0.12)) {
            row.numvalue = round(row.numvalue * 16.667, 1);
            row.measureunitid = "L/MIN";
            this.problems.add("SPEC_UNIT_MIXED", "同じ属性で単位が混在（流量 m3/h と L/min、出力 kW と W、圧力 MPa と kPa）", "ASSETSPEC.MEASUREUNITID / NUMVALUE");
          } else if (row.assetattrid === "RATED_POWER" && typeof row.numvalue === "number" && rng.chance(0.04)) {
            row.numvalue = round(row.numvalue * 1000, 0);
            row.measureunitid = "W";
            this.problems.add("SPEC_UNIT_MIXED", "同じ属性で単位が混在（流量 m3/h と L/min、出力 kW と W、圧力 MPa と kPa）", "ASSETSPEC.MEASUREUNITID / NUMVALUE");
          } else if ((row.assetattrid === "DESIGN_PRESS" || row.assetattrid === "SET_PRESS") && typeof row.numvalue === "number" && rng.chance(0.1)) {
            row.numvalue = round(row.numvalue * 1000, 0);
            row.measureunitid = "KPA";
            this.problems.add("SPEC_UNIT_MIXED", "同じ属性で単位が混在（流量 m3/h と L/min、出力 kW と W、圧力 MPa と kPa）", "ASSETSPEC.MEASUREUNITID / NUMVALUE");
          } else if (ATTR_BY_ID.get(String(row.assetattrid))?.type === "NUMERIC" && typeof row.numvalue === "number" && row.assetattrid !== "MFG_YEAR" && rng.chance(0.02)) {
            // 数値の属性なのに、単位付きの文字（全角を含む）を英数字の欄に入れている
            row.alnvalue = rng.chance(0.5) ? toFullWidth(`${row.numvalue}`) + (row.measureunitid ?? "") : `${row.numvalue}${String(row.measureunitid ?? "").toLowerCase()}`;
            row.numvalue = null;
            this.problems.add("SPEC_NUMBER_AS_TEXT", "数値の仕様が数値の欄ではなく英数字の欄に単位付きの文字で入っている", "ASSETSPEC.ALNVALUE / NUMVALUE");
          }
        }
      }
      // 分類の無い資産（仕様も無い）
      if (legacy && a.install <= this.start && rng.chance(0.015)) {
        a.cls = null;
        a.specs = [];
        this.problems.add("ASSET_NO_CLASS", "資産に分類（CLASSSTRUCTUREID）が無い", "ASSET.CLASSSTRUCTUREID");
      }
      // タグ番号の揺れ
      const r = rng.next();
      if (a.tag === null) continue;
      if (r < 0.015) {
        a.tag = a.tag.toLowerCase();
        this.problems.add("TAG_FORMAT", "タグ番号（ASSETTAG）が命名規則（<炉>-<種別>-<番号><号機>）に合わない", "ASSET.ASSETTAG");
      } else if (r < 0.035) {
        a.tag = a.tag.replace(/-/g, "");
        this.problems.add("TAG_FORMAT", "タグ番号（ASSETTAG）が命名規則（<炉>-<種別>-<番号><号機>）に合わない", "ASSET.ASSETTAG");
      } else if (r < 0.05) {
        a.tag = toFullWidth(a.tag);
        this.problems.add("TAG_FULLWIDTH", "タグ番号・説明に全角英数字が混じる", "ASSET.ASSETTAG / DESCRIPTION");
      } else if (r < 0.06) {
        a.tag = `${a.tag} `;
        this.problems.add("TRAILING_SPACE", "値の末尾に空白がある", "ASSET.ASSETTAG / DESCRIPTION / SERIALNUM");
      } else if (r < 0.075 && legacy) {
        a.tag = a.tag.replace(/^\d-/, "");
        this.problems.add("TAG_FORMAT", "タグ番号（ASSETTAG）が命名規則（<炉>-<種別>-<番号><号機>）に合わない", "ASSET.ASSETTAG");
      } else if (r < 0.08 && a.pos.line > 0 && s.lines > 1) {
        a.tag = a.tag.replace(/^\d/, String((a.pos.line % s.lines) + 1));
        this.problems.add("TAG_LINE_MISMATCH", "タグ番号の炉番号が資産の機能位置の炉と食い違う", "ASSET.ASSETTAG / LOCATION");
      } else if (r < 0.1 && legacy) {
        a.tag = null;
        this.problems.add("TAG_MISSING", "タグ番号（ASSETTAG）が空", "ASSET.ASSETTAG");
      }
      // 説明の揺れ
      const d = rng.next();
      if (d < 0.03 && /\d号炉/.test(a.desc)) {
        a.desc = a.desc.replace(/(\d)号炉/, (_, n: string) => toFullWidth(n) + "号炉");
        this.problems.add("TAG_FULLWIDTH", "タグ番号・説明に全角英数字が混じる", "ASSET.ASSETTAG / DESCRIPTION");
      } else if (d < 0.05 && /\d号炉/.test(a.desc)) {
        a.desc = a.desc.replace(/(\d)号炉 /, "No.$1炉 ");
        this.problems.add("DESC_LINE_NOTATION", "炉の表記が揺れる（1号炉 / No.1炉 / １号炉）", "ASSET.DESCRIPTION / LOCATIONS.DESCRIPTION");
      } else if (d < 0.07 && /[ァ-ヴー]/.test(a.desc)) {
        a.desc = toHalfKana(a.desc);
        this.problems.add("DESC_HALFWIDTH_KANA", "説明に半角カナが混じる", "ASSET.DESCRIPTION");
      } else if (d < 0.085) {
        a.desc = `${a.desc}${rng.pick([" ", "  ", "　"])}`;
        this.problems.add("TRAILING_SPACE", "値の末尾に空白がある", "ASSET.ASSETTAG / DESCRIPTION / SERIALNUM");
      }
      // 製造番号
      if (legacy && a.install <= this.start + 365 * DAY) {
        const sr = rng.next();
        if (sr < 0.06) {
          a.serial = rng.pick(["不明", "-", "N/A", "ﾌﾒｲ", "なし"]);
          this.problems.add("SERIAL_PLACEHOLDER", "製造番号が「不明」「-」「N/A」などの仮の値", "ASSET.SERIALNUM");
        } else if (sr < 0.1) {
          a.serial = null;
        }
      }
    }
    // 重複して登録された資産（旧台帳からの移行で二重に取り込んだ）
    if (legacy) {
      for (const a of operating) {
        if (a.pos.child || !rng.chance(0.02)) continue;
        const dup: Asset = {
          ...a, assetnum: String(s.assetBase + 900_000 + ++this.assetSeq), specs: [], meters: [], serial: null, duplicate: true, installNull: true,
          desc: rng.chance(0.5) ? toFullWidth(a.desc).replace(/　/g, " ") : `${a.desc} `, parent: a.parent,
        };
        this.assets.push(dup);
        this.problems.add("ASSET_DUPLICATE", "同じ機能位置・同じタグの稼働中の資産が二重に登録されている（説明の表記違い・仕様なし・設置日なし）", "ASSET（ASSETNUM が 9 で始まる 2 桁目）");
      }
    }
    // 分類の無い機能位置、説明の揺れ
    for (const l of this.locs) {
      if (l.cls === "LOC-POS" && rng.chance(legacy ? 0.08 : 0.02)) {
        l.cls = null;
        this.problems.add("LOCATION_NO_CLASS", "機能位置（場所）に分類が無い", "LOCATIONS.CLASSSTRUCTUREID");
      }
      if (l.cls !== "LOC-PLANT" && /\d号炉/.test(l.description) && rng.chance(0.03)) {
        l.description = rng.chance(0.5) ? l.description.replace(/(\d)号炉/, "No.$1炉") : l.description.replace(/(\d)号炉/, (_, n: string) => toFullWidth(n) + "号炉");
        this.problems.add("DESC_LINE_NOTATION", "炉の表記が揺れる（1号炉 / No.1炉 / １号炉）", "ASSET.DESCRIPTION / LOCATIONS.DESCRIPTION");
      }
      if (rng.chance(0.01)) {
        l.description = `${l.description} `;
        this.problems.add("TRAILING_SPACE", "値の末尾に空白がある", "ASSET.ASSETTAG / DESCRIPTION / SERIALNUM");
      }
    }
    // 設置日の無い資産
    for (const a of this.assets) {
      if (!a.duplicate && legacy && a.install <= this.start && rng.chance(0.02)) {
        a.installNull = true;
        this.problems.add("ASSET_NO_INSTALLDATE", "設置日（INSTALLDATE）が空", "ASSET.INSTALLDATE");
      }
    }
  }

  // ---- 在庫 ----

  inventory(items: Rec[], ids: Ids): Rec[] {
    const rng = this.rng.fork("inventory");
    const out: Rec[] = [];
    const mark = this.p === "KT" ? "KT形" : this.p === "MN" ? "MN形" : "HG形";
    for (const it of items) {
      const desc = String(it.attrs.description);
      if (/[A-Z]{2}形/.test(desc) && !desc.includes(mark)) continue;
      if (!rng.chance(String(it.attrs.itemnum).startsWith("Z-") ? 0.6 : 0.75)) continue;
      const min = rng.int(0, 10);
      const max = min + rng.int(2, 20);
      const bins = rng.chance(0.15) ? 2 : 1;
      const balances: Row[] = [];
      let total = 0;
      for (let b = 0; b < bins; b++) {
        const curbal = rng.int(0, max);
        total += curbal;
        balances.push({
          invbalancesid: ids.next("invbalancesid"), binnum: `${rng.pick(["A", "B", "C", "D"])}-${pad(rng.int(1, 20), 2)}-${pad(rng.int(1, 6), 2)}`, lotnum: null,
          curbal, physcnt: curbal, physcntdate: fmt(jst(2026, 3, 31, 12)), conditioncode: null,
        });
      }
      const status = String(it.attrs.status);
      let minlevel = min;
      if (rng.chance(0.03)) {
        minlevel = max + rng.int(1, 5);
        this.problems.add("INV_MIN_OVER_MAX", "在庫の発注点（MINLEVEL）が最大在庫（MAXLEVEL）を超える", "INVENTORY.MINLEVEL / MAXLEVEL");
      }
      if (status === "OBSOLETE" && total > 0) this.problems.add("INV_OBSOLETE_STOCK", "廃止（OBSOLETE）の品目に在庫が残っている", "INVENTORY.CURBALTOTAL / ITEM.STATUS");
      out.push({
        attrs: {
          itemnum: it.attrs.itemnum ?? null, itemsetid: ITEMSETID, siteid: this.site.siteid, orgid: ORGID, location: `${this.p}-STORE`, binnum: balances[0]!.binnum ?? null,
          category: "STK", status, minlevel, maxlevel: max, orderqty: Math.max(1, max - min), orderunit: it.attrs.orderunit ?? null, issueunit: it.attrs.issueunit ?? null,
          abctype: rng.weighted<string>([["A", 15], ["B", 35], ["C", 50]]), curbaltotal: total, avgcost: round(rng.real(500, 300000), -1),
          lastissuedate: rng.chance(0.85) ? fmt(NOW - rng.int(1, 900) * DAY) : null, inventoryid: ids.next("inventoryid"),
        },
        children: { invbalances: balances },
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

/** 故障の件数の倍率（分類の cmRate に掛ける） */
const CM_SCALE = 2.5;

const MOTOR_SIZES = [0.2, 0.4, 0.75, 1.5, 2.2, 3.7, 5.5, 7.5, 11, 15, 18.5, 22, 30, 37, 45, 55, 75, 90, 110, 132, 160, 200, 250, 315, 400];

function pickMotorKw(rng: Rng, [min, max]: [number, number]): number {
  const options = MOTOR_SIZES.filter((k) => k >= min && k <= max);
  return options.length > 0 ? rng.pick(options) : min;
}

function digitsOf(def: AttrDef): number {
  return Array.isArray(def.def) && typeof def.def[0] === "number" ? (def.def[2] as number) : 1;
}

function calendarMs(h: number): number {
  if (h <= 10) return h * HOUR;
  if (h <= 100) return Math.ceil(h / 8) * DAY;
  return Math.ceil(h / 24) * DAY;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function shortDesc(prog: PmProgram): string {
  const law = prog.desc.startsWith("【法定】");
  const body = prog.desc.replace("【法定】", "");
  const i = body.indexOf(" ");
  return `${law ? "【法定】" : ""}${i >= 0 ? body.slice(i + 1) : body}`;
}

const SR_PHRASES: Record<string, string[]> = {
  LEAK: ["から漏れがあります。", "の下に液だまりがあります。", "フランジ部からにじみがあります。"],
  VIB: ["の振動が大きいです。", "が普段より揺れています。", "の振動値が上がっています。"],
  NOISE: ["から異音がします。", "からキーキー音がします。", "の音がいつもと違います。"],
  LOWPERF: ["の能力が落ちているようです。", "の吐出が弱いです。", "の効きが悪いです。"],
  OVERHEAT: ["の温度が高いです。", "の軸受が熱くなっています。"],
  NOSTART: ["が起動しません。", "の起動指令が通りません。"],
  TRIP: ["がトリップしました。", "が停止しました。", "が故障停止しました。"],
  JAM: ["が噛み込んで停止しました。", "に異物が詰まって止まりました。"],
  WEAR: ["の摩耗が進んでいます。", "に焼損が見られます。"],
  BREAK: ["が破損しています。", "のチェーンが切れました。"],
  MEANDER: ["が蛇行しています。"],
  MALFUNC: ["の動作がおかしいです。", "が指令どおりに動きません。"],
  WIREDMG: ["のワイヤに素線切れがあります。"],
  GRABDMG: ["のバケットの爪が欠けています。"],
  STUCK: ["が動きません。", "が固着しています。"],
  CRACK: ["に亀裂があります。"],
  FALLASH: ["の落じんが多いです。"],
  CLOG: ["が詰まっています。", "の閉塞警報が出ました。"],
  PRESSDROP: ["の差圧が上がっています。"],
  DRIFT: ["の指示がおかしいです。", "の値がふらつきます。", "の指示が現場と合いません。"],
  INSUL: ["の絶縁が下がっています。"],
  DAMAGE: ["が焼損しています。", "が壊れています。"],
  ALARM: ["の警報が出ています。", "で異常警報が出ました。"],
  NOSIGNAL: ["の信号が来ていません。", "が中央で表示されません。"],
};

function operatorText(rng: Rng, assetDesc: string, prob: string): string {
  const phrase = rng.pick(SR_PHRASES[prob] ?? ["に不具合があります。"]);
  return `${assetDesc.trim()}${phrase}${rng.pick(["確認をお願いします。", "点検願います。", "至急見てください。", ""])}`;
}

function freeTextTitle(rng: Rng, prob: string): string {
  const map: Record<string, string[]> = {
    LEAK: ["漏れ有", "もれ 要確認", "にじみあり"], VIB: ["振動 要確認", "ゆれ大", "振動ｱﾘ"], NOISE: ["異音", "変な音がする", "音 要確認"],
    TRIP: ["停止した", "トリップ", "止まった件"], DRIFT: ["指示不良?", "値おかしい"], CLOG: ["詰まり", "つまり除去"],
  };
  return rng.pick(map[prob] ?? ["不具合", "調子悪い", "要点検", "不調"]);
}

function remedyText(rng: Rng, cause: string, remedy: string): string {
  return `${CAUSES[cause] ?? ""}と思われる。${REMEDIES[remedy] ?? ""}を実施。${rng.pick(["様子見。", "復旧。", "運転再開。", ""])}`;
}

const SR_ONLY_TEXTS: Array<[string, boolean]> = [
  ["照明が切れています。", false], ["床に灰がこぼれているので清掃をお願いします。", false], ["点検口の扉が閉まりにくいです。", false],
  ["手すりの塗装がはがれています。", false], ["現場の表示札が読めなくなっています。", false], ["雨漏りしています。", false],
  ["換気が弱い気がします。", false], ["工具の置き場を決めてほしいです。", false], ["監視カメラの映像が暗いです。", false],
];

// ---------------------------------------------------------------------------
// 表の行への変換
// ---------------------------------------------------------------------------

function locRecord(l: Loc, ids: Ids): Rec {
  const children: Record<string, Row[]> = {};
  if (l.type === "OPERATING") {
    children.lochierarchy = [{ lochierarchyid: ids.next("lochierarchyid"), systemid: "PRIMARY", parent: l.parent, children: false, siteid: l.siteid, orgid: ORGID }];
  }
  if (l.specs && l.cls) {
    const csid = CLASS_CSID.get(l.cls)!;
    children.locationspec = l.specs.map(([attr, v], i) => {
      const def = ATTR_BY_ID.get(attr)!;
      return {
        locationspecid: ids.next("locationspecid"), assetattrid: attr, classstructureid: csid, displaysequence: (i + 1) * 10,
        alnvalue: def.type === "ALN" ? String(v) : null, numvalue: def.type === "NUMERIC" ? v : null, measureunitid: def.unit ?? null,
      };
    });
  }
  return {
    attrs: {
      location: l.location, siteid: l.siteid, orgid: ORGID, description: l.description, type: l.type, status: "OPERATING",
      classstructureid: l.cls ? CLASS_CSID.get(l.cls)! : null, locationsid: ids.next("locationsid"), disabled: false, changeby: "MAXADMIN",
    },
    children,
  };
}

function assetRecord(a: Asset, site: SiteDef, ids: Ids): Rec {
  const decom = a.decom !== null;
  return {
    attrs: {
      assetnum: a.assetnum, siteid: site.siteid, orgid: ORGID, description: a.desc, assettag: a.tag ?? null, location: a.location, parent: a.parent,
      status: decom ? "DECOMMISSIONED" : "OPERATING", statusdate: fmt(decom ? a.decom! : a.install), installdate: a.installNull ? null : fmt(a.install),
      serialnum: a.serial, manufacturer: a.duplicate ? null : a.maker, vendor: a.duplicate ? null : a.vendor, priority: a.pos.priority,
      classstructureid: a.cls ? CLASS_CSID.get(a.cls)! : null, failurecode: a.cls ? (CLASS_BY_ID.get(a.cls)?.failure ?? null) : null,
      isrunning: !decom, assetid: ids.next("assetid"), changeby: "MAXADMIN", changedate: fmt(decom ? a.decom! : a.install),
    },
    children: { assetspec: a.specs ?? [], assetmeter: a.meters },
  };
}

/** 作業指示と SR に番号を振る（組織で 1 つの連番。報告日の順） */
function numberWorkOrders(wos: WoDraft[], srs: SrDraft[], ids: Ids, push: (t: string, r: Rec) => void): void {
  const order = wos.map((w, i) => ({ w, i })).sort((a, b) => a.w.report - b.w.report || a.i - b.i);
  order.forEach(({ w }, i) => {
    w.wonum = String(100_001 + i);
  });
  const srOrder = srs.map((s, i) => ({ s, i })).sort((a, b) => a.s.report - b.s.report || a.i - b.i);
  srOrder.forEach(({ s }, i) => {
    s.ticketid = String(10_001 + i);
  });
  for (const { w } of order) {
    w.attrs.wonum = w.wonum!;
    w.attrs.workorderid = Number(w.wonum) - 100_000;
    if (w.parentRef) w.attrs.parent = w.parentRef.wonum!;
    if (w.sr) {
      w.attrs.origrecordid = w.sr.ticketid!;
      w.attrs.origrecordclass = "SR";
    }
    const failurereport = w.failure.map(([type, code], k) => ({ failurereportid: ids.next("failurereportid"), type, failurecode: code, linenum: k + 1, assetnum: w.attrs.assetnum ?? null }));
    push("WORKORDER", {
      attrs: w.attrs,
      children: {
        wostatus: w.statuses.map(([status, at, by]) => ({ wostatusid: ids.next("wostatusid"), status, changedate: fmt(at), changeby: by, memo: null })),
        failurereport,
      },
    });
  }
  for (const { s } of srOrder) {
    s.attrs.ticketid = s.ticketid!;
    s.attrs.ticketuid = Number(s.ticketid);
    push("SR", {
      attrs: s.attrs,
      children: {
        tkstatus: s.statuses.map(([status, at, by]) => ({ tkstatusid: ids.next("tkstatusid"), status, changedate: fmt(at), changeby: by })),
        relatedrecord: s.wo ? [{ relatedrecordid: ids.next("relatedrecordid"), relatedreckey: s.wo.wonum!, relatedrecclass: "WORKORDER", relatetype: "FOLLOWUP", relatedrecsiteid: s.site.siteid }] : [],
      },
    });
  }
}
