// ごみ焼却施設 3 か所の保全データを、Maximo の標準の表（小文字の属性名）の形で作る。
// 同じオプションなら毎回同じデータになる（種付きの乱数だけを使い、現在時刻を見ない）。
// 判定はすべて日本語の正本（catalog.ts）で行い、表に書く文だけを text.ts で言語（日本語・英語）にする。
// 日英で引く乱数は同じなので、ID・件数・数値・日付は言語によらず同じになる（金額と人の ID を除く）。

import type { CellValue } from "../../../src/shared/model";
import {
  ATTRS, CAUSES, CAUSE_REMEDIES, CLASSES, CLASS_MAKERS, COMPANIES, CRAFTS, DEPTS, FAILURE_CLASSES, FAILURE_TREE, INSTRUMENTS,
  ITEMSETID, ITEM_TEMPLATES, LEDGER_CUTOFF, MEASURE_UNITS, METERS, MODEL_PREFIX, ORGID, ORG_DESCRIPTION, OVERHAUL_CLASSES, PM_PROGRAMS, PROBLEMS,
  REMEDIES, ROLES, SITES, SYSTEMS, VALVES,
  type AttrDef, type ChildDef, type ClassDef, type ItemDef, type PmProgram, type SiteCode, type SiteDef, type UnitDef,
} from "./catalog.ts";
import { applyOutsourcing, type OrderTruth } from "./contracts.ts";
import { buildRotating, buildStores, type StoresTruth } from "./stores.ts";
import { Text, type Lang } from "./text.ts";
import { DAY, HOUR, Rng, addMonths, atTime, fmt, jst, pad, round, seedOf, weekday, ymd } from "./util.ts";

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
  /** 文の言語（既定 ja）。ID・件数・数値は言語によらず同じ */
  lang?: Lang;
}

export interface DataProblem {
  id: string;
  title: string;
  /** どの表のどの属性に出るか */
  where: string;
  count: number;
}

export interface PlantsData {
  lang: Lang;
  tables: Record<string, Rec[]>;
  problems: DataProblem[];
  /** 表 → サイト（サイトの無い表は "-"）→ 件数 */
  counts: Record<string, Record<string, number>>;
  /** データの基準日（これより後の実績は無い） */
  asOf: string;
  /** Excel の場面の正解（公開するデータには入れない） */
  truth: PlantsTruth;
  /** 英語の辞書に無かった日本語（英語のとき。空でなければ訳し漏れ） */
  missingTranslations: string[];
}

/** データの基準日時（2026-09-30 17:00 日本時間） */
export const NOW = jst(2026, 9, 30, 17, 0);

/** 公開するデータの版（中身を変えたら上げる） */
export const DATASET_VERSION = 2;

export const CLASS_BY_ID = new Map<string, ClassDef>(CLASSES.map((c) => [c.id, c]));
export const ATTR_BY_ID = new Map<string, AttrDef>(ATTRS.map((a) => [a.id, a]));
export const CLASS_CSID = new Map<string, string>(CLASSES.map((c, i) => [c.id, String(1001 + i)]));

// ---------------------------------------------------------------------------
// 内部の形
// ---------------------------------------------------------------------------

export interface Loc {
  location: string;
  description: string;
  type: string;
  parent: string | null;
  cls: string | null;
  siteid: SiteCode;
  specs?: Array<[string, CellValue]>;
  /** 炉（0 は共通。施設・倉庫は無し） */
  line?: number;
  /** データ品質: 階層（PRIMARY）に入っていない */
  noHierarchy?: boolean;
  /** 電気の系統（ELEC）の親 */
  elecParent?: string | null;
}

/** 生成のときだけ使う品目の定義（計器・弁は名前を組み立てる） */
type GenItem = ItemDef & { nOut?: string };

/** 機能位置（場所）と、そこに据える資産の系列 */
export interface Position {
  site: SiteDef;
  loc: string;
  unitLoc: string;
  line: number;
  /** 設備系統のコード（例 "50"）と装置のコード（例 "FD"） */
  system: string;
  unit: string;
  tag: string;
  /** 出力の言語の説明と、判定に使う日本語の説明 */
  desc: string;
  descJa: string;
  item: GenItem | null;
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
  /** 後から足した（東部の台帳だけにある）機能位置 */
  added?: boolean;
}

export interface Asset {
  assetnum: string;
  pos: Position;
  install: number;
  decom: number | null;
  desc: string;
  descJa: string;
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
  /** 品目（回転資産） */
  itemnum?: string | null;
  binnum?: string | null;
  /** 予備品（倉庫・修理中にある回転資産） */
  spare?: boolean;
  /** 資産の予備品（SPAREPART の子） */
  spareparts?: Row[];
  /** 正しい値（Excel の場面の正解。データ品質の問題を入れる前） */
  serialTrue: string | null;
  makerTrue: string | null;
  specsTrue: Row[] | null;
  /** 東部の台帳: Maximo には入っていない資産（更新・増設が台帳にだけある） */
  hidden?: boolean;
  /** 東部の台帳: 撤去済みだが Maximo では稼働中のまま */
  stale?: boolean;
  /** Maximo の変更日を上書きする（台帳より Maximo が新しい） */
  changedOverride?: number;
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

export interface FailureTruth {
  prob: string;
  cause: string;
  remedy: string;
  codeMode: "none" | "freetext" | "problemOnly" | "full";
  emergency: boolean;
}

export interface WoDraft {
  site: SiteDef;
  report: number;
  attrs: Row;
  statuses: Array<[string, number, string]>;
  failure: Array<[string, string]>;
  parentRef?: WoDraft;
  sr?: SrDraft;
  wonum?: string;
  /** 予防保全なら元の PM の計画 */
  prog?: PmProgram;
  asset?: Asset | null;
  /** 場所の説明（資産の無い作業指示） */
  locDesc?: string;
  /** 是正・緊急保全の本当の故障（故障コードを空にしても残す） */
  truth?: FailureTruth;
  /** 外注の是正保全なら業者の職種 */
  contractorCraft?: string | null;
  /** 部品の払い出し（品目のキー, 数量）。空の配列は「交換した部品を原因から決める」 */
  materials?: Array<[string, number]>;
  /** 外注の発注（contracts.ts） */
  order?: OrderTruth;
}

export interface SrDraft {
  site: SiteDef;
  report: number;
  attrs: Row;
  statuses: Array<[string, number, string]>;
  wo?: WoDraft;
  ticketid?: string;
}

export class Ids {
  private counters = new Map<string, number>();
  next(name: string, start = 1): number {
    const v = (this.counters.get(name) ?? start - 1) + 1;
    this.counters.set(name, v);
    return v;
  }
}

export class Problems {
  readonly list = new Map<string, DataProblem>();
  add(id: string, title: string, where: string, n = 1): void {
    const p = this.list.get(id);
    if (p) p.count += n;
    else this.list.set(id, { id, title, where, count: n });
  }
}

/** 人の ID（同じ生成の中で重ならないように番号を付ける） */
class PersonIds {
  private used = new Set<string>();
  make(last: string, first: string): string {
    const base = `${first[0]}${last}`.toUpperCase();
    let id = base;
    for (let n = 2; this.used.has(id); n++) id = `${base}${n}`;
    this.used.add(id);
    return id;
  }
}

// ---------------------------------------------------------------------------
// 正解（Excel の場面）
// ---------------------------------------------------------------------------

/** 星取表の 1 つの出来事（Maximo を入れる前の実績と予定） */
export interface HistoryEvent {
  site: SiteCode;
  loc: string;
  /** その時の資産（据えてあった資産）。いま撤去済みなら Maximo には居ない */
  assetnum: string;
  cls: string;
  date: number;
  kind: "INSP" | "PM" | "CAL" | "CM" | "EM" | "CP";
  jp: string | null;
  law: boolean;
  /** 予定だけ（取消・未実施） */
  planned: boolean;
}

/** 旧台帳（Maximo を入れる直前の時点）の 1 台 */
export interface LegacyAssetTruth {
  site: SiteCode;
  assetnum: string;
  pos: Position;
  install: number;
  decom: number | null;
  serial: string;
  maker: string | null;
  model: string | null;
  mfgYear: number | null;
  /** Maximo に入っているか（入れる前に撤去したものは入っていない） */
  inMaximo: boolean;
}

/** 修理記録（北部 2026 年度上半期）の 1 件 */
export interface RepairTruth {
  wo: WoDraft;
}

/** 東部の機器台帳（Excel）と Maximo のずれ */
export interface LedgerTruth {
  kind: "REPLACED" | "ADDED" | "SPEC_CHANGED" | "RENAMED" | "REMOVED" | "MAXIMO_NEWER";
  /** 台帳の行の資産（REPLACED は新しい資産、ほかは対象の資産） */
  asset: Asset;
  /** REPLACED: Maximo にある古い資産 */
  old?: Asset;
  date: number;
  /** SPEC_CHANGED: [属性, 古い値, 新しい値] */
  spec?: [string, number, number];
  /** RENAMED: 新しい説明 */
  newDesc?: string;
  /** MAXIMO_NEWER: 台帳に残っている古い製造番号 */
  oldSerial?: string;
}

export interface PlantsTruth {
  goLive: Record<string, number>;
  history: HistoryEvent[];
  legacy: LegacyAssetTruth[];
  orders: OrderTruth[];
  repairs: RepairTruth[];
  ledger: LedgerTruth[];
  stores: StoresTruth;
  positions: Position[];
  locs: Loc[];
  persons: Map<string, { last: string; first: string; display: string }>;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function generatePlants(opts: PlantsOptions = {}): PlantsData {
  const lang: Lang = opts.lang ?? "ja";
  const tx = new Text(lang);
  const root = new Rng(seedOf(opts.seed ?? "mxstage-plants"));
  const historyFrom = opts.historyFrom ? Date.parse(opts.historyFrom) : Number.NEGATIVE_INFINITY;
  const sites = SITES.filter((s) => !opts.sites || opts.sites.includes(s.siteid));
  const ids = new Ids();
  const problems = new Problems();
  const personIds = new PersonIds();
  const t: Record<string, Rec[]> = {};
  const push = (table: string, rec: Rec) => (t[table] ??= []).push(rec);

  const items = buildItems(root.fork("items"), problems, tx);
  buildOrgTables(push, sites, tx);

  const contractors = buildContractors(root.fork("contractors"), personIds, tx);
  // Maximo の管理者（PM からの作業指示の生成・メーターの取り込みの変更者）
  const admins: Person[] = [
    { personid: "MAXADMIN", last: "MAXADMIN", first: "", role: "SYS", title: tx.t("システム管理者"), craft: "OPER", site: null, from: jst(2005, 4, 1), to: jst(2099, 1, 1), dept: tx.t("情報システム") },
    { personid: "MXINTADM", last: "MXINTADM", first: "", role: "SYS", title: tx.t("連携用ユーザー"), craft: "OPER", site: null, from: jst(2005, 4, 1), to: jst(2099, 1, 1), dept: tx.t("情報システム") },
  ];
  const allPersons: Person[] = [...admins, ...contractors];

  const ctxs: SiteContext[] = [];
  for (const site of sites) {
    const ctx = new SiteContext(site, root.fork(`site-${site.siteid}`), ids, problems, historyFrom, contractors, tx, personIds);
    ctx.build();
    ctxs.push(ctx);
    allPersons.push(...ctx.persons);
  }

  // 回転品目と予備品（全施設の資産から品目を決める）
  const rotating = buildRotating(ctxs, items, root.fork("rotating"), problems, tx);
  // 外注（業者・発注・金額。2026 年度上半期の分は未入力）
  const orders = applyOutsourcing(ctxs, root.fork("outsourcing"), tx);
  // 東部の機器台帳だけにある変更（Maximo の資産は 2025 年度から止まっている）
  const ledger: LedgerTruth[] = [];
  for (const ctx of ctxs) ledger.push(...ctx.ledgerDrift(root.fork(`ledger-${ctx.site.siteid}`)));

  // ---- Maximo の表に書き出す ----
  const goLive: Record<string, number> = {};
  const assetMap = new Map<string, string>();
  for (const ctx of ctxs) {
    goLive[ctx.site.siteid] = ctx.goLive;
    for (const [from, to] of ctx.assetMap) assetMap.set(from, to);
  }
  const mapAsset = (v: CellValue | undefined): CellValue => (typeof v === "string" ? (assetMap.get(v) ?? v) : (v ?? null));

  for (const ctx of ctxs) {
    const parents = new Set<string>();
    const elecParents = new Set<string>();
    for (const l of ctx.locs) {
      if (l.parent && !l.noHierarchy) parents.add(l.parent);
      if (l.elecParent) elecParents.add(l.elecParent);
    }
    for (const l of ctx.locs) push("LOCATIONS", locRecord(l, ids, parents, elecParents));
    for (const a of ctx.assets) {
      if (!ctx.inMaximo(a)) continue;
      push("ASSET", assetRecord(a, ctx, ids, mapAsset));
    }
    for (const r of ctx.meterReadings) if (ctx.assetVisible(String(r.assetnum))) push("METERREADING", { attrs: r });
    for (const r of ctx.pms) push("PM", { attrs: { ...r, assetnum: mapAsset(r.assetnum) } });
    for (const g of ctx.personGroups()) push("PERSONGROUP", g);
  }

  for (const p of allPersons) {
    push("PERSON", { attrs: personAttrs(p, tx) });
    push("LABOR", {
      attrs: { laborcode: p.personid, personid: p.personid, orgid: ORGID, worksite: p.site, status: p.to > NOW ? "ACTIVE" : "INACTIVE", laborid: ids.next("laborid") },
      children: { laborcraftrate: [{ laborcraftrateid: ids.next("laborcraftrateid"), craft: p.craft, skilllevel: p.role.endsWith("L") || p.role === "MGR" ? "FIRSTCLASS" : "SECONDCLASS", defaultcraft: true, orgid: ORGID }] },
    });
  }

  // 作業指示・SR は Maximo を入れた後の分だけ
  const inMaximoWo = (w: WoDraft) => w.report >= goLive[w.site.siteid]!;
  const wos = ctxs.flatMap((c) => c.wos);
  const srs = ctxs.flatMap((c) => c.srs);
  numberWorkOrders(wos.filter(inMaximoWo), srs.filter((s) => s.report >= goLive[s.site.siteid]!), ids, push, mapAsset);

  // 在庫・払い出し・予備品の在庫（作業指示の番号が要る）
  const stores = buildStores(ctxs, items, rotating, root.fork("stores"), problems, tx, ids, push, inMaximoWo);

  // 部品を使う作業計画（品目のキー → 代表の品目）
  for (const r of buildJobPlans(items.byKey, ids, tx)) push("JOBPLAN", r);

  const counts: PlantsData["counts"] = {};
  for (const [table, recs] of Object.entries(t)) {
    const c: Record<string, number> = {};
    for (const r of recs) {
      const s = typeof r.attrs.siteid === "string" ? r.attrs.siteid : "-";
      c[s] = (c[s] ?? 0) + 1;
    }
    counts[table] = c;
  }

  // ---- 正解 ----
  const history: HistoryEvent[] = [];
  const legacy: LegacyAssetTruth[] = [];
  const repairs: RepairTruth[] = [];
  for (const ctx of ctxs) {
    history.push(...ctx.historyEvents());
    legacy.push(...ctx.legacyAssets());
    if (ctx.site.siteid === "KITA") {
      const from = jst(2026, 4, 1);
      for (const w of ctx.wos) if (w.truth && w.report >= from && (w.attrs.worktype === "CM" || w.attrs.worktype === "EM")) repairs.push({ wo: w });
    }
  }
  const persons = new Map<string, { last: string; first: string; display: string }>();
  for (const p of allPersons) persons.set(p.personid, { last: p.last, first: p.first, display: tx.personDisplay(p.last, p.first) });

  return {
    lang,
    tables: t,
    problems: [...problems.list.values()].map((p) => ({ ...p, title: tx.t(p.title) })),
    counts,
    asOf: fmt(NOW),
    truth: { goLive, history, legacy, orders, repairs, ledger, stores, positions: ctxs.flatMap((c) => c.positions), locs: ctxs.flatMap((c) => c.locs), persons },
    missingTranslations: [...tx.missing].sort(),
  };
}

// ---------------------------------------------------------------------------
// 組織全体の表（分類・仕様の属性・単位・故障コード・メーター・会社・職種・ドメイン）
// ---------------------------------------------------------------------------

function buildOrgTables(push: (t: string, r: Rec) => void, sites: SiteDef[], tx: Text): void {
  push("ORGANIZATION", {
    attrs: { orgid: ORGID, description: tx.t(ORG_DESCRIPTION), active: true, basecurrency1: tx.currency, itemsetid: ITEMSETID, companysetid: "COMPSET1", clearingacct: "9999-000" },
    children: { site: sites.map((s, i) => ({ siteuid: i + 1, siteid: s.siteid, description: tx.t(s.description), active: true, orgid: ORGID })) },
  });
  for (const [id, desc] of MEASURE_UNITS) push("MEASUREUNIT", { attrs: { measureunitid: id, description: tx.t(desc), orgid: null, abbreviation: id } });
  for (const a of ATTRS) {
    push("ASSETATTRIBUTE", { attrs: { assetattrid: a.id, description: tx.t(a.desc), datatype: a.type, measureunitid: a.unit ?? null, orgid: ORGID, domainid: null } });
  }
  let specId = 1;
  CLASSES.forEach((c) => {
    const csid = CLASS_CSID.get(c.id)!;
    const children = CLASSES.some((x) => x.parent === c.id);
    const path: string[] = [];
    for (let cur: ClassDef | undefined = c; cur; cur = cur.parent ? CLASS_BY_ID.get(cur.parent) : undefined) path.unshift(cur.id);
    push("CLASSSTRUCTURE", {
      attrs: {
        classstructureid: csid, classificationid: c.id, description: tx.t(c.desc), parent: c.parent ? CLASS_CSID.get(c.parent)! : null,
        hierarchypath: path.join(" \\ "), haschildren: children, orgid: ORGID, siteid: null, genassetdesc: false, useclassindesc: false, type: null,
      },
      children: {
        classspec: (c.specs ?? []).map((a, i) => ({
          classspecid: specId++, assetattrid: a, measureunitid: ATTR_BY_ID.get(a)?.unit ?? null, displaysequence: (i + 1) * 10, classstructureid: csid, orgid: ORGID,
        })),
        classusewith: c.useWith.map((o, i) => ({ classusewithid: Number(csid) * 10 + i, objectname: o, description: tx.t(o === "ASSET" ? "資産" : "場所"), toplevel: c.parent === null })),
      },
    });
  });
  // 故障コード
  for (const [code, d] of Object.entries(FAILURE_CLASSES)) push("FAILURECODE", { attrs: { failurecode: code, description: tx.failureClassDesc(tx.t(d)), orgid: ORGID } });
  for (const [code, d] of Object.entries(PROBLEMS)) push("FAILURECODE", { attrs: { failurecode: code, description: tx.t(d), orgid: ORGID } });
  for (const [code, d] of Object.entries(CAUSES)) push("FAILURECODE", { attrs: { failurecode: code, description: tx.t(d), orgid: ORGID } });
  for (const [code, d] of Object.entries(REMEDIES)) push("FAILURECODE", { attrs: { failurecode: code, description: tx.t(d), orgid: ORGID } });
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
  for (const m of METERS) push("METER", { attrs: { metername: m.name, description: tx.t(m.desc), metertype: m.type, measureunitid: m.unit, readingtype: m.type === "CONTINUOUS" ? "ACTUAL" : null, rollover: null, domainid: null } });
  for (const c of COMPANIES) push("COMPANIES", { attrs: { company: c.company, name: tx.t(c.name), type: c.type, orgid: ORGID, currencycode: tx.currency, disabled: false } });
  for (const [craft, d] of CRAFTS) push("CRAFT", { attrs: { craft, description: tx.t(d), orgid: ORGID } });
  for (const d of DOMAINS) push("MAXDOMAIN", domainRecord(d, tx));
}

export interface DomainDef {
  domainid: string;
  description: string;
  type: "SYNONYM" | "ALN";
  length: number;
  values: Array<[string, string, string?]>;
}

/** ドメイン（値の一覧）。SYNONYM は [内部値, 値, 説明]、ALN は [値, 説明]。説明は日本語の正本 */
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
  { domainid: "INVUSESTATUS", description: "在庫使用のステータス", type: "SYNONYM", length: 16, values: [["ENTERED", "ENTERED", "入力済み"], ["STAGED", "STAGED", "準備済み"], ["SHIPPED", "SHIPPED", "出荷済み"], ["COMPLETE", "COMPLETE", "完了"], ["CANCELLED", "CANCELLED", "取消"]] },
  { domainid: "EXTDEPT", description: "発注の担当部署（独自）", type: "ALN", length: 8, values: DEPTS.map(([v, d]) => [v, d] as [string, string]) },
];

function domainRecord(d: DomainDef, tx: Text): Rec {
  const children: Record<string, Row[]> = {};
  if (d.type === "SYNONYM") {
    children.synonymdomain = d.values.map(([maxvalue, value, desc], i) => ({ synonymdomainid: seedOf(d.domainid) % 100000 * 100 + i, maxvalue, value, description: desc ? tx.t(desc) : null, defaults: true, orgid: null, siteid: null }));
  } else {
    children.alndomain = d.values.map(([value, desc], i) => ({ alndomainid: seedOf(d.domainid) % 100000 * 100 + i, value, description: desc ? tx.t(desc) : null, orgid: null, siteid: null }));
  }
  return { attrs: { domainid: d.domainid, description: tx.t(d.description), domaintype: d.type, maxtype: "UPPER", length: d.length, internal: d.type === "SYNONYM" }, children };
}

// ---------------------------------------------------------------------------
// 部品
// ---------------------------------------------------------------------------

export interface ItemsBuilt {
  records: Rec[];
  /** 品目のキー → 最初の品目番号 */
  byKey: Map<string, string>;
  /** 品目のキー → そのキーの品目番号すべて */
  allByKey: Map<string, string[]>;
  /** 品目番号 → 単価（円） */
  cost: Map<string, number>;
}

function buildItems(rng: Rng, problems: Problems, tx: Text): ItemsBuilt {
  const records: Rec[] = [];
  const byKey = new Map<string, string>();
  const allByKey = new Map<string, string[]>();
  const cost = new Map<string, number>();
  const counters = new Map<string, number>();
  for (const tpl of ITEM_TEMPLATES) {
    for (const size of tpl.sizes) {
      const n = (counters.get(tpl.prefix) ?? 0) + 1;
      counters.set(tpl.prefix, n);
      const itemnum = `${tpl.prefix}-${pad(n, 4)}`;
      if (!byKey.has(tpl.key)) byKey.set(tpl.key, itemnum);
      if (!allByKey.has(tpl.key)) allByKey.set(tpl.key, []);
      allByKey.get(tpl.key)!.push(itemnum);
      cost.set(itemnum, round(rng.real(tpl.cost[0], tpl.cost[1]), -2));
      const status = rng.weighted<string>([["ACTIVE", 92], ["PENDOBS", 4], ["OBSOLETE", 4]]);
      records.push({
        attrs: {
          itemnum, itemsetid: ITEMSETID, description: `${tx.t(tpl.desc)} ${tx.t(size)}`, status, orderunit: tpl.unit, issueunit: tpl.unit, commoditygroup: tpl.commodity,
          rotating: false, lottype: "NOLOT", itemtype: "ITEM", inspectionrequired: false, itemid: records.length + 1,
        },
      });
    }
  }
  // データ品質: 同じ品目が別の品目番号・表記の揺れで重複して登録されている
  let dupNo = 0;
  for (const [src, alter] of tx.itemDuplicates()) {
    const base = records.find((r) => r.attrs.itemnum === src);
    if (!base) continue;
    dupNo++;
    const itemnum = `Z-${pad(dupNo, 4)}`;
    cost.set(itemnum, cost.get(src) ?? 0);
    records.push({ attrs: { ...base.attrs, itemnum, description: alter(String(base.attrs.description)), itemid: records.length + 1, status: "ACTIVE" } });
    problems.add("ITEM_DUPLICATE", "同じ部品が別の品目番号・別の表記で重複して登録されている", "ITEM.ITEMNUM / DESCRIPTION（Z- で始まる品目）");
  }
  return { records, byKey, allByKey, cost };
}

// ---------------------------------------------------------------------------
// 作業計画
// ---------------------------------------------------------------------------

function buildJobPlans(itemByKey: Map<string, string>, ids: Ids, tx: Text): Rec[] {
  return PM_PROGRAMS.map((p) => ({
    attrs: {
      jpnum: p.jp, description: tx.t(p.desc), status: "ACTIVE", orgid: ORGID, siteid: null, pluscrevnum: 0, jpduration: p.dur,
      jobplanid: ids.next("jobplanid"), interruptible: false, templatetype: null, laborcode: null, crewid: null,
    },
    children: {
      jobtask: p.tasks.map((desc, i) => ({ jobtaskid: ids.next("jobtaskid"), jptask: (i + 1) * 10, description: tx.t(desc), orgid: ORGID, siteid: null })),
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

function buildContractors(rng: Rng, personIds: PersonIds, tx: Text): Person[] {
  const out: Person[] = [];
  for (const c of COMPANIES.filter((x) => x.company.startsWith("VND-"))) {
    const craft = c.company === "VND-EA" ? "ELEC" : c.company === "VND-IA" ? "INST" : "MECH";
    for (let i = 0; i < 3; i++) {
      const [lj, lr] = rng.pick(tx.surnames);
      const [fj, fr] = rng.pick(tx.givenNames);
      out.push({ personid: personIds.make(lr, fr), last: lj, first: fj, role: "CONTR", title: tx.t("協力会社 作業責任者"), craft, site: null, from: jst(2005, 4, 1), to: jst(2099, 1, 1), dept: tx.t(c.name) });
    }
  }
  return out;
}

function personAttrs(p: Person, tx: Text): Row {
  return {
    personid: p.personid, displayname: tx.personDisplay(p.last, p.first), lastname: p.last, firstname: p.first, status: p.to > NOW ? "ACTIVE" : "INACTIVE",
    title: p.title, department: p.dept, locationsite: p.site, locationorg: ORGID, employeetype: tx.employeeType(p.role),
    statusdate: fmt(p.to > NOW ? p.from : p.to),
  };
}

// ---------------------------------------------------------------------------
// 1 施設ぶん
// ---------------------------------------------------------------------------

export class SiteContext {
  readonly locs: Loc[] = [];
  readonly positions: Position[] = [];
  readonly assets: Asset[] = [];
  readonly meterReadings: Row[] = [];
  readonly pms: Row[] = [];
  readonly persons: Person[] = [];
  readonly wos: WoDraft[] = [];
  readonly srs: SrDraft[] = [];
  /** 東部の台帳: Maximo に入っていない資産 → Maximo にある資産（作業指示・PM の資産を付け替える） */
  readonly assetMap = new Map<string, string>();
  readonly site: SiteDef;
  readonly rng: Rng;
  readonly ids: Ids;
  readonly problems: Problems;
  readonly tx: Text;
  readonly goLive: number;
  readonly start: number;
  private readonly historyFrom: number;
  private readonly contractors: Person[];
  private readonly personIds: PersonIds;
  readonly unitLocs: Array<{ loc: string; desc: string; line: number; system: string; unit: string }> = [];
  private readonly lineLocs: Array<{ loc: string; line: number; desc: string }> = [];
  assetSeq = 0;
  private pmSeq = 0;

  constructor(site: SiteDef, rng: Rng, ids: Ids, problems: Problems, historyFrom: number, contractors: Person[], tx: Text, personIds: PersonIds) {
    this.site = site;
    this.rng = rng;
    this.ids = ids;
    this.problems = problems;
    this.historyFrom = historyFrom;
    this.contractors = contractors;
    this.tx = tx;
    this.personIds = personIds;
    this.start = jst(site.start.y, site.start.m, 1);
    this.goLive = jst(site.goLive.y, site.goLive.m, 1);
  }

  build(): void {
    this.buildLocations();
    this.buildAssets();
    this.buildPeople();
    this.buildMeters();
    this.buildPmsAndWork();
    this.buildCorrective();
    this.injectAssetProblems();
    this.buildElectricalSystem();
    this.injectLocationProblems();
  }

  get p(): string {
    return this.site.prefix;
  }

  /** 旧台帳から移した施設か（Maximo を竣工より後に入れた） */
  get legacy(): boolean {
    return this.goLive > this.start;
  }

  /** Maximo に入っている資産か（入れる前に撤去した資産・台帳だけの資産は入っていない） */
  inMaximo(a: Asset): boolean {
    if (a.hidden) return false;
    return a.decom === null || a.decom >= this.goLive || a.stale === true;
  }

  private visible?: Set<string>;
  assetVisible(assetnum: string): boolean {
    this.visible ??= new Set(this.assets.filter((a) => this.inMaximo(a)).map((a) => a.assetnum));
    return this.visible.has(assetnum);
  }

  // ---- 場所 ----

  private addLoc(l: Omit<Loc, "siteid">): void {
    this.locs.push({ ...l, siteid: this.site.siteid });
  }

  private buildLocations(): void {
    const s = this.site;
    const p = this.p;
    const tx = this.tx;
    const siteDesc = tx.t(s.description);
    this.addLoc({
      location: p, description: siteDesc, type: "OPERATING", parent: null, cls: "LOC-PLANT",
      specs: [["CAPACITY_TD", s.tonPerLine * s.lines], ["LINES", s.lines], ["COMMISSIONED", tx.yearMonth(s.start.y, s.start.m)], ["FURNACE_TYPE", tx.t("全連続燃焼式ストーカ炉")]],
    });
    for (let line = 0; line <= s.lines; line++) {
      const lloc = `${p}-${line === 0 ? "CM" : `L${line}`}`;
      const ldesc = line === 0 ? tx.commonDesc(siteDesc) : tx.lineName(line);
      this.addLoc({ location: lloc, description: ldesc, type: "OPERATING", parent: p, cls: line === 0 ? "LOC-SYSTEM" : "LOC-LINE", line, ...(line === 0 ? {} : { specs: [["CAPACITY_TD", s.tonPerLine]] }) });
      if (line > 0) this.lineLocs.push({ loc: lloc, line, desc: ldesc });
      for (const sys of SYSTEMS) {
        const units = sys.units.filter((u) => u.perLine === line > 0 && (!u.only || u.only.includes(s.siteid)));
        if (units.length === 0) continue;
        const sloc = `${p}-${line}-${sys.code}`;
        this.addLoc({ location: sloc, description: tx.sp(tx.lineName(line), tx.t(sys.name)), type: "OPERATING", parent: lloc, cls: "LOC-SYSTEM", line });
        for (const u of units) {
          const uloc = `${sloc}-${u.code}`;
          const udesc = tx.sp(tx.lineName(line), tx.t(u.name));
          this.addLoc({ location: uloc, description: udesc, type: "OPERATING", parent: sloc, cls: "LOC-UNIT", line });
          this.unitLocs.push({ loc: uloc, desc: udesc, line, system: sys.code, unit: u.code });
          this.buildPositions(uloc, line, sys.code, sys.band, u);
        }
      }
    }
    this.addLoc({ location: `${p}-STORE`, description: tx.placeDesc(siteDesc, "STORE"), type: "STOREROOM", parent: null, cls: "LOC-STORE" });
    this.addLoc({ location: `${p}-ESTORE`, description: tx.placeDesc(siteDesc, "ESTORE"), type: "STOREROOM", parent: null, cls: "LOC-STORE" });
    this.addLoc({ location: `${p}-REPAIR`, description: tx.placeDesc(siteDesc, "REPAIR"), type: "REPAIR", parent: null, cls: null });
    this.addLoc({ location: `${p}-SALVAGE`, description: tx.placeDesc(siteDesc, "SALVAGE"), type: "SALVAGE", parent: null, cls: null });
  }

  private readonly tagCounters = new Map<string, number>();

  nextTagNo(line: number, band: number, t: string): number {
    const k = `${line}|${band}|${t}`;
    const n = (this.tagCounters.get(k) ?? 0) + 1;
    this.tagCounters.set(k, n);
    return band + n;
  }

  private buildPositions(uloc: string, line: number, system: string, band: number, u: UnitDef): void {
    const s = this.site;
    const tx = this.tx;
    const items: GenItem[] = [...u.items];
    // 計器と弁を機能位置として足す
    for (const tok of (u.x ?? "").split(" ").filter(Boolean)) {
      const t = tok.slice(0, 2);
      const n = Number(tok.slice(2));
      const inst = INSTRUMENTS[t]!;
      for (let i = 0; i < n; i++) items.push({ t, c: "XMTR", n: `${u.name} ${inst.n}`, nOut: tx.sp(tx.t(u.name), tx.t(inst.n)), p: { MEAS_TYPE: inst.type, MEAS_RANGE: inst.ranges } });
    }
    for (const tok of (u.v ?? "").split(" ").filter(Boolean)) {
      const t = tok.slice(0, 2);
      const n = Number(tok.slice(2));
      const v = VALVES[t]!;
      for (let i = 0; i < n; i++) items.push({ t, c: v.c, n: `${u.name} ${v.n}`, nOut: tx.sp(tx.t(u.name), tx.t(v.n)), p: t === "MV" ? { ACTUATOR: "電動" } : {} });
    }
    const instCount = new Map<string, number>();
    for (const item of items) {
      if (item.only && !item.only.includes(s.siteid)) continue;
      const qty = item.q === -1 ? s.lines + 1 : (item.q ?? 1);
      const added = item.added?.[s.siteid];
      const startMs = added !== undefined && added > s.start.y ? jst(added, this.rng.int(4, 10), 1) : this.start;
      let no = item.ab ? this.nextTagNo(line, band, item.t) : 0;
      const base = item.nOut ?? tx.t(item.n);
      for (let k = 0; k < qty; k++) {
        if (!item.ab) no = this.nextTagNo(line, band, item.t);
        const suffix = item.ab ? String.fromCharCode(65 + k) : "";
        const tag = `${line}-${item.t}-${no}${suffix}`;
        const loc = `${this.p}-${tag}`;
        let name = base;
        let nameJa = item.n;
        if (item.ab) {
          name = tx.abUnit(base, suffix);
          nameJa = `${item.n} ${suffix}号機`;
        } else if (item.c === "XMTR" || item.c === "CVALVE" || item.c === "MOV") {
          const c = (instCount.get(item.n) ?? 0) + 1;
          instCount.set(item.n, c);
          name = tx.numbered(base, c);
          nameJa = `${item.n} No.${c}`;
        } else if (item.c === "FBAG") {
          name = tx.compartment(base, k + 1);
          nameJa = `${item.n}（第${k + 1}室）`;
        } else if (qty > 1) {
          name = tx.numbered(base, k + 1);
          nameJa = `${item.n} No.${k + 1}`;
        }
        const desc = line === 0 ? name : tx.sp(tx.lineName(line), name);
        const descJa = line === 0 ? nameJa : `${line}号炉 ${nameJa}`;
        this.addLoc({ location: loc, description: desc, type: "OPERATING", parent: uloc, cls: "LOC-POS", line });
        const priority = item.pr ?? (item.c === "XMTR" || item.c === "CVALVE" || item.c === "MOV" ? 3 : line > 0 ? 2 : 3);
        const util = this.utilOf(item, !!item.ab);
        const pos: Position = { site: s, loc, unitLoc: uloc, line, system, unit: u.code, tag, desc, descJa, item, cls: item.c, priority, start: startMs, util, gens: [] };
        this.positions.push(pos);
        const children: ChildDef[] = [...(item.ch ?? [])];
        if (item.m) children.unshift({ t: "M", c: "MOTOR", n: "電動機", kw: item.m });
        if (item.inv) children.push({ t: "IV", c: "INV", n: "インバータ" });
        let motorKw: number | undefined;
        for (const ch of children) {
          const kw = ch.kw ? pickMotorKw(this.rng, ch.kw) : ch.c === "INV" ? motorKw : undefined;
          if (ch.c === "MOTOR" && ch.t === "M") motorKw = kw;
          this.positions.push({
            site: s, loc, unitLoc: uloc, line, system, unit: u.code, tag: `${line}-${ch.t}-${no}${suffix}`, desc: tx.sp(desc, tx.t(ch.n)), descJa: `${descJa} ${ch.n}`, item: null, cls: ch.c,
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

  newAsset(pos: Position, install: number, decom: number | null): Asset {
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
      assetnum, pos, install, decom, desc: pos.desc, descJa: pos.descJa, tag: pos.tag, location: pos.loc, parent: null, serial, maker, vendor, specs: null, meters: [], cls: pos.cls,
      serialTrue: serial, makerTrue: maker, specsTrue: null,
    };
    if (decom !== null) {
      if (rng.chance(0.88)) a.location = `${this.p}-SALVAGE`;
      else if (decom >= this.goLive) this.problems.add("DECOM_AT_POSITION", "撤去済み（DECOMMISSIONED）の資産が機能位置に残ったまま（同じ位置に稼働中の資産と 2 台）", "ASSET.LOCATION / STATUS");
    }
    a.specs = this.makeSpecs(a, iy);
    a.specsTrue = a.specs.map((r) => ({ ...r }));
    this.assets.push(a);
    return a;
  }

  /** Maximo に資産を登録した日（移した施設は Maximo を入れた日） */
  registeredAt(install: number): number {
    return Math.max(install, this.goLive);
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
        alnvalue: def.type === "ALN" ? (v === null ? null : this.tx.t(String(v))) : null, numvalue: def.type === "NUMERIC" && typeof v === "number" ? v : null,
        measureunitid: def.unit ?? null, changedate: fmt(this.registeredAt(a.install)), changeby: "MAXADMIN",
      };
      out.push(row);
    });
    return out;
  }

  // ---- 人 ----

  private readonly byRole = new Map<string, Person[]>();

  private buildPeople(): void {
    const rng = this.rng.fork("people");
    const tx = this.tx;
    for (const role of ROLES) {
      const slots = Math.max(1, Math.round(role.base + role.perLine * this.site.lines));
      const list: Person[] = [];
      for (let slot = 0; slot < slots; slot++) {
        let from = this.start - rng.int(0, 4) * 365 * DAY;
        while (from < NOW + 365 * DAY) {
          const tenure = role.supervisor ? rng.real(3, 7) : rng.real(5, 16);
          const to = from + tenure * 365.25 * DAY;
          const [lj, lr] = rng.pick(tx.surnames);
          const [fj, fr] = rng.pick(tx.givenNames);
          const person: Person = {
            personid: this.personIds.make(lr, fr), last: lj, first: fj, role: role.role, title: tx.t(role.title), craft: role.craft, site: this.site.siteid,
            from: Math.max(from, jst(2004, 4, 1)), to: to > NOW ? jst(2099, 1, 1) : atTime(to, 17), dept: tx.dept(tx.t(this.site.description), role.craft),
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

  personAt(role: string, ms: number): string {
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

  group(craft: string): string {
    const c = craft === "CONTR" ? "MECH" : craft;
    return `${this.p}-${c}`;
  }

  personGroups(): Rec[] {
    return CRAFTS.filter(([c]) => c !== "CONTR").map(([craft, desc]) => {
      const members = this.persons.filter((p) => p.craft === craft && p.to > NOW);
      return {
        attrs: { persongroup: this.group(craft), description: this.tx.groupDesc(this.tx.t(this.site.description), this.tx.t(desc)), siteid: null, orgid: ORGID },
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
          // Maximo を入れる前の読みは Maximo に無い（入れたときの値から始まる）
          if (t >= this.historyFrom && t >= this.goLive) {
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

  /** PM の説明の後ろ半分（出力の言語。【法定】は前に付ける） */
  private pmTitle(prog: PmProgram): { law: boolean; body: string } {
    const law = prog.desc.startsWith("【法定】");
    return { law, body: this.tx.t(shortDesc(prog).replace("【法定】", "")) };
  }

  private assetPm(rng: Rng, pos: Position, prog: PmProgram): void {
    const pmnum = this.newPmNum();
    const lead = 14 * DAY;
    // データ品質: 更新したのに PM が古い資産を指したまま（Maximo を入れた後に撤去した資産だけ）
    const replacedAfterGoLive = pos.gens.length > 1 && pos.gens[0]!.decom !== null && pos.gens[0]!.decom >= this.goLive;
    const stale = replacedAfterGoLive && rng.chance(0.1);
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
    const title = this.pmTitle(prog);
    this.pms.push(this.pmRow(pmnum, prog, current.assetnum, pos.loc, `${current.desc} ${title.law ? this.tx.law : ""}${title.body}`, next, lastComp, lastStart, current.decom === null || stale ? "ACTIVE" : "INACTIVE"));
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
    const title = this.pmTitle(prog);
    this.pms.push(this.pmRow(pmnum, prog, null, loc, `${desc} ${title.law ? this.tx.law : ""}${title.body}`, next, lastComp, lastStart, "ACTIVE"));
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
          if (childProg.unit === "YEARS" && childProg.freq === 1 && !spring && childProg.jp !== "DAMPER-OH") continue;
          if (childProg.jp === "DAMPER-OH" && spring) continue;
          if (childProg.freq === 2 && (spring || y % 2 !== 0)) continue;
          const asset = pos.gens.find((g) => g.install <= due && (g.decom === null || g.decom > due));
          if (!asset) continue;
          const childDue = due + rng.int(1, 12) * DAY;
          const child = this.pmWork(rng, childProg, childDue, asset, pos.loc, null, undefined, undefined, parent);
          if (child) child.parentRef = parent;
        }
      }
    }
    const title = this.pmTitle(prog);
    this.pms.push(this.pmRow(pmnum, prog, null, loc, `${desc} ${title.law ? this.tx.law : ""}${title.body}`, next, lastComp, lastStartOh, "ACTIVE"));
  }

  /** 予防保全・点検・校正の作業指示を 1 件作る */
  private pmWork(rng: Rng, prog: PmProgram, due: number, asset: Asset | null, location: string, pmnum: string | null, locDesc?: string, leadOverride?: number, parent?: WoDraft): WoDraft | null {
    const lead = leadOverride ?? 14 * DAY;
    const report = parent ? parent.report : atTime(due - lead, 6, 0);
    if (due < this.historyFrom) return null;
    const durH = prog.dur;
    const law = prog.law === true;
    const title = this.pmTitle(prog);
    const desc = clip(`${law ? this.tx.law : ""}${asset ? asset.desc : (locDesc ?? "")} ${title.body}`, 100);
    const cancel = law ? 0.003 : prog.jp === "LINE-OH" ? 0 : prog.worktype === "INSP" && prog.freq === 1 && prog.unit === "MONTHS" ? 0.06 : 0.03;
    const life = this.lifecycle(rng, report, due, durH, { cancel, startDelayDays: law ? [0, 3] : [0, 14], kind: "PM" });
    const crew = prog.crew;
    const wo: WoDraft = {
      site: this.site,
      report,
      statuses: life.hist,
      failure: [],
      prog,
      asset,
      ...(locDesc !== undefined ? { locDesc } : {}),
      ...(prog.materials ? { materials: prog.materials } : {}),
      attrs: {
        siteid: this.site.siteid, orgid: ORGID, description: desc, worktype: prog.worktype, status: life.status, statusdate: fmt(life.hist[life.hist.length - 1]![1]),
        reportdate: fmt(report), reportedby: "MAXADMIN", targstartdate: fmt(due), targcompdate: fmt(due + calendarMs(durH)),
        schedstart: fmt(due), schedfinish: fmt(due + calendarMs(durH)), actstart: life.actStart === null ? null : fmt(life.actStart),
        actfinish: life.actFinish === null ? null : fmt(life.actFinish), wopriority: law ? 1 : asset ? Math.min(3, asset.pos.priority + 1) : 3,
        assetnum: asset ? asset.assetnum : null, location, pmnum, jpnum: prog.jp, failurecode: asset ? (CLASS_BY_ID.get(asset.pos.cls)?.failure ?? null) : null,
        problemcode: null, estdur: durH, estlabhrs: round(durH * crew, 1), actlabhrs: life.actHours === null ? 0 : round(life.actHours * crew, 1),
        supervisor: this.supervisorFor(prog.craft, due), lead: life.status === "WAPPR" ? null : this.leadFor(prog.craft, due, prog.contractor === true),
        ownergroup: this.group(prog.craft), woclass: "WORKORDER", historyflag: life.status === "CLOSE" || life.status === "CAN", istask: false,
        parent: null, origrecordid: null, origrecordclass: null, description_longdescription: null, downtime: false, ...emptyContractAttrs(),
      },
    };
    if (prog.jp === "LINE-OH") wo.attrs.downtime = true;
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
    // データ品質: 着手したまま何か月も閉じていない作業指示（Maximo を入れた後のもの）
    if (report < NOW - 180 * DAY && rng.chance(0.01)) {
      if (report >= this.goLive) this.problems.add("WO_STALE_OPEN", "半年以上前に着手したまま完了・クローズしていない作業指示（INPRG のまま）", "WORKORDER.STATUS / ACTFINISH");
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
    const tx = this.tx;
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
    if (report >= NOW) {
      // 運転員の連絡は届いているが、作業指示はまだ作っていない
      if (fromSr) this.makeSr(rng, srReport, tx.operatorText(rng, a.desc, prob), a.assetnum, a.pos.loc, null, null, emergency ? 1 : 3);
      return;
    }
    const durH = round(rng.real(1, emergency ? 8 : 16), 1);
    const start = emergency ? report + rng.int(10, 90) * 60_000 : report + rng.int(1, 21) * DAY;
    const life = this.lifecycle(rng, report, start, durH, { cancel: 0.03, startDelayDays: [0, 3], kind });
    const craft = ["MOTOR", "INV", "TRANSF", "BRKR", "SWGR", "GEN", "UPS", "EGEN"].includes(a.pos.cls) ? "ELEC" : ["XMTR", "ANLZ", "DCS", "CVALVE"].includes(a.pos.cls) ? "INST" : ["HVAC", "ELEV"].includes(a.pos.cls) ? "CIVIL" : "MECH";
    const pdesc = tx.t(PROBLEMS[prob]!);
    const inMaximo = report >= this.goLive;
    // データ品質: 故障コードの欠け、自由記述だけの問題
    const r = rng.next();
    const codeMode = r < 0.12 ? "none" : r < 0.22 ? "freetext" : r < 0.27 ? "problemOnly" : "full";
    const longNote = tx.longNote(fmt(at).slice(0, 16).replace("T", " "), tx.operatorText(rng, a.desc, prob));
    const description = codeMode === "freetext" ? clip(`${a.desc} ${tx.freeTextTitle(rng, prob)}`, 100) : clip(`${emergency ? tx.emergency : ""}${a.desc} ${pdesc}`, 100);
    const location = rng.chance(0.03) ? a.pos.unitLoc : a.pos.loc;
    if (location !== a.pos.loc && inMaximo) this.problems.add("WO_LOCATION_MISMATCH", "作業指示の場所が資産の機能位置と違う（装置の場所を入れている）", "WORKORDER.LOCATION");
    const completed = life.status === "COMP" || life.status === "CLOSE";
    let contractor = false;
    const lead = life.status === "WAPPR" ? null : this.leadFor(craft, report, (contractor = rng.chance(0.2)));
    const wo: WoDraft = {
      site: this.site,
      report,
      statuses: life.hist,
      failure: [],
      asset: a,
      truth: { prob, cause, remedy, codeMode, emergency },
      contractorCraft: contractor ? craft : null,
      attrs: {
        siteid: this.site.siteid, orgid: ORGID, description, worktype: kind, status: life.status, statusdate: fmt(life.hist[life.hist.length - 1]![1]),
        reportdate: fmt(report), reportedby: this.personAt("OPER", report), targstartdate: fmt(start), targcompdate: fmt(start + calendarMs(durH)),
        schedstart: life.status === "WAPPR" ? null : fmt(start), schedfinish: life.status === "WAPPR" ? null : fmt(start + calendarMs(durH)),
        actstart: life.actStart === null ? null : fmt(life.actStart), actfinish: life.actFinish === null ? null : fmt(life.actFinish),
        wopriority: emergency ? 1 : rng.pick([2, 2, 3]), assetnum: a.assetnum, location, pmnum: null, jpnum: null,
        failurecode: codeMode === "none" || codeMode === "freetext" ? null : fcls, problemcode: codeMode === "full" || codeMode === "problemOnly" ? prob : null,
        estdur: durH, estlabhrs: round(durH * 2, 1), actlabhrs: life.actHours === null ? 0 : round(life.actHours * 2, 1),
        supervisor: this.supervisorFor(craft, report), lead,
        ownergroup: this.group(craft), woclass: "WORKORDER", historyflag: life.status === "CLOSE" || life.status === "CAN", istask: false,
        parent: null, origrecordid: null, origrecordclass: null,
        description_longdescription: codeMode === "freetext"
          ? `${longNote}\n${completed ? tx.remedyLine(tx.remedyText(rng, tx.t(CAUSES[cause] ?? ""), tx.t(REMEDIES[remedy] ?? ""))) : ""}`.trim()
          : completed && rng.chance(0.5) ? `${longNote}\n${tx.remedyShort(tx.t(REMEDIES[remedy]!))}` : null,
        downtime: emergency, ...emptyContractAttrs(),
      },
    };
    if (inMaximo) {
      if (codeMode === "none") this.problems.add("WO_NO_FAILURE_CODE", "是正・緊急保全の作業指示に故障コード（故障クラス・問題）が無い", "WORKORDER.FAILURECODE / PROBLEMCODE");
      if (codeMode === "freetext") this.problems.add("WO_FREETEXT_ONLY", "故障の内容が件名・長い説明の自由記述だけで、故障コードも故障報告も無い", "WORKORDER.DESCRIPTION / DESCRIPTION_LONGDESCRIPTION");
      if (codeMode === "problemOnly") this.problems.add("WO_PROBLEM_ONLY", "問題コードはあるが故障クラスが空（故障報告の原因・処置も無い）", "WORKORDER.FAILURECODE / FAILUREREPORT");
    }
    if (codeMode === "full") {
      wo.failure.push(["PROBLEM", prob]);
      if (completed) {
        wo.failure.push(["CAUSE", cause]);
        wo.failure.push(["REMEDY", remedy]);
      }
    }
    if (completed && rng.chance(0.06)) {
      wo.attrs.actlabhrs = 0;
      if (inMaximo) this.problems.add("WO_NO_LABOR_HOURS", "完了した是正保全の作業指示に実績工数が無い（0）", "WORKORDER.ACTLABHRS");
    }
    // 部品を交換した是正保全は部品を払い出す（stores.ts が原因から品目を決める）
    if (completed && remedy === "REPLACE") wo.materials = [];
    this.wos.push(wo);
    if (fromSr) {
      const sr = this.makeSr(rng, srReport, tx.operatorText(rng, a.desc, prob), a.assetnum, a.pos.loc, life.status, life.actFinish, emergency ? 1 : 3);
      sr.wo = wo;
      wo.sr = sr;
    }
  }

  private makeSr(rng: Rng, at: number, text: string, assetnum: string | null, location: string, woStatus: string | null, woFinish: number | null, priority: number): SrDraft {
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
        class: "SR", siteid: this.site.siteid, orgid: ORGID, description: clip(this.tx.firstSentence(text), 100),
        description_longdescription: text, status, statusdate: fmt(hist[hist.length - 1]![1]), reportedby: op, affectedperson: op, reportdate: fmt(at),
        assetnum, assetsiteid: assetnum ? this.site.siteid : null, location, internalpriority: priority, reportedpriority: priority,
        ownergroup: this.group("OPER"), actualstart: hist.length > 2 ? fmt(hist[2]![1]) : null, actualfinish: finish === null ? null : fmt(finish),
      },
    };
    this.srs.push(sr);
    return sr;
  }

  private standaloneSr(rng: Rng, loc: string, desc: string, at: number): void {
    const [text, withAsset] = rng.pick(this.tx.srOnlyTexts);
    const sr = this.makeSr(rng, at, this.tx.standaloneSr(desc, text), null, loc, null, null, 3);
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
    if (!withAsset && at >= this.goLive) this.problems.add("SR_NO_ASSET", "資産・機能位置を特定しない運転員の連絡（場所が装置レベルだけ）", "SR.ASSETNUM");
  }

  // ---- 資産のデータ品質の問題 ----

  private injectAssetProblems(): void {
    const rng = this.rng.fork("dq");
    const tx = this.tx;
    const s = this.site;
    const legacy = this.legacy;
    const operating = this.assets.filter((a) => a.decom === null);
    for (const a of this.assets) {
      // Maximo を入れたときに旧台帳から移した資産（移行の問題はここに多い）
      const migrated = legacy && a.install < this.goLive;
      const counts = this.inMaximo(a);
      const add = (id: string, title: string, where: string) => {
        if (counts) this.problems.add(id, title, where);
      };
      if (a.specs && a.specs.length > 0) {
        const r = rng.next();
        if (r < (migrated ? 0.09 : 0.03)) {
          a.specs = [];
          add("SPEC_MISSING_ALL", "分類はあるが仕様（ASSETSPEC）が 1 行も無い", "ASSET.ASSETSPEC");
        } else if (r < (migrated ? 0.25 : 0.1)) {
          const n = rng.int(1, Math.max(1, Math.floor(a.specs.length / 2)));
          for (let i = 0; i < n; i++) {
            const row = rng.pick(a.specs);
            row.alnvalue = null;
            row.numvalue = null;
          }
          add("SPEC_BLANK_VALUES", "仕様の行はあるが値が空（一部の属性）", "ASSETSPEC.ALNVALUE / NUMVALUE");
        }
        for (const row of a.specs) {
          // 単位の不統一
          if (row.assetattrid === "FLOW" && typeof row.numvalue === "number" && rng.chance(0.12)) {
            row.numvalue = round(row.numvalue * 16.667, 1);
            row.measureunitid = "L/MIN";
            add("SPEC_UNIT_MIXED", "同じ属性で単位が混在（流量 m3/h と L/min、出力 kW と W、圧力 MPa と kPa）", "ASSETSPEC.MEASUREUNITID / NUMVALUE");
          } else if (row.assetattrid === "RATED_POWER" && typeof row.numvalue === "number" && rng.chance(0.04)) {
            row.numvalue = round(row.numvalue * 1000, 0);
            row.measureunitid = "W";
            add("SPEC_UNIT_MIXED", "同じ属性で単位が混在（流量 m3/h と L/min、出力 kW と W、圧力 MPa と kPa）", "ASSETSPEC.MEASUREUNITID / NUMVALUE");
          } else if ((row.assetattrid === "DESIGN_PRESS" || row.assetattrid === "SET_PRESS") && typeof row.numvalue === "number" && rng.chance(0.1)) {
            row.numvalue = round(row.numvalue * 1000, 0);
            row.measureunitid = "KPA";
            add("SPEC_UNIT_MIXED", "同じ属性で単位が混在（流量 m3/h と L/min、出力 kW と W、圧力 MPa と kPa）", "ASSETSPEC.MEASUREUNITID / NUMVALUE");
          } else if (ATTR_BY_ID.get(String(row.assetattrid))?.type === "NUMERIC" && typeof row.numvalue === "number" && row.assetattrid !== "MFG_YEAR" && rng.chance(0.02)) {
            // 数値の属性なのに、単位付きの文字（全角を含む）を英数字の欄に入れている
            row.alnvalue = tx.numberAsText(row.numvalue, String(row.measureunitid ?? ""), rng.chance(0.5));
            row.numvalue = null;
            add("SPEC_NUMBER_AS_TEXT", "数値の仕様が数値の欄ではなく英数字の欄に単位付きの文字で入っている", "ASSETSPEC.ALNVALUE / NUMVALUE");
          }
        }
      }
      // 分類の無い資産（仕様も無い）
      if (migrated && rng.chance(0.015)) {
        a.cls = null;
        a.specs = [];
        add("ASSET_NO_CLASS", "資産に分類（CLASSSTRUCTUREID）が無い", "ASSET.CLASSSTRUCTUREID");
      }
      // タグ番号の揺れ
      const r = rng.next();
      if (a.tag === null) continue;
      if (r < 0.015) {
        a.tag = a.tag.toLowerCase();
        add("TAG_FORMAT", "タグ番号（ASSETTAG）が命名規則（<炉>-<種別>-<番号><号機>）に合わない", "ASSET.ASSETTAG");
      } else if (r < 0.035) {
        a.tag = a.tag.replace(/-/g, "");
        add("TAG_FORMAT", "タグ番号（ASSETTAG）が命名規則（<炉>-<種別>-<番号><号機>）に合わない", "ASSET.ASSETTAG");
      } else if (r < 0.05) {
        a.tag = tx.charVariantTag(a.tag);
        add("CHAR_VARIANT", "タグ番号・説明に全角英数字（似た字）が混じる", "ASSET.ASSETTAG / DESCRIPTION");
      } else if (r < 0.06) {
        a.tag = `${a.tag} `;
        add("TRAILING_SPACE", "値の末尾に空白がある", "ASSET.ASSETTAG / DESCRIPTION / SERIALNUM");
      } else if (r < 0.075 && migrated) {
        a.tag = a.tag.replace(/^\d-/, "");
        add("TAG_FORMAT", "タグ番号（ASSETTAG）が命名規則（<炉>-<種別>-<番号><号機>）に合わない", "ASSET.ASSETTAG");
      } else if (r < 0.08 && a.pos.line > 0 && s.lines > 1) {
        a.tag = a.tag.replace(/^\d/, String((a.pos.line % s.lines) + 1));
        add("TAG_LINE_MISMATCH", "タグ番号の炉番号が資産の機能位置の炉と食い違う", "ASSET.ASSETTAG / LOCATION");
      } else if (r < 0.1 && migrated) {
        a.tag = null;
        add("TAG_MISSING", "タグ番号（ASSETTAG）が空", "ASSET.ASSETTAG");
      }
      // 説明の揺れ
      const d = rng.next();
      if (d < 0.03 && a.pos.line > 0) {
        a.desc = tx.lineCharVariant(a.desc, a.pos.line);
        add("CHAR_VARIANT", "タグ番号・説明に全角英数字（似た字）が混じる", "ASSET.ASSETTAG / DESCRIPTION");
      } else if (d < 0.05 && a.pos.line > 0) {
        a.desc = tx.lineNotation(a.desc, a.pos.line);
        add("DESC_LINE_NOTATION", "炉の表記が揺れる（1号炉 / No.1炉 / １号炉）", "ASSET.DESCRIPTION / LOCATIONS.DESCRIPTION");
      } else if (d < 0.07 && /[ァ-ヴー]/.test(a.descJa)) {
        a.desc = tx.notationVariant(a.desc);
        add("DESC_NOTATION_VARIANT", "説明の表記が揺れる（半角カナ・略語）", "ASSET.DESCRIPTION");
      } else if (d < 0.085) {
        a.desc = `${a.desc}${rng.pick(tx.trailingSpaces)}`;
        add("TRAILING_SPACE", "値の末尾に空白がある", "ASSET.ASSETTAG / DESCRIPTION / SERIALNUM");
      }
      // 製造番号（移した資産）
      if (migrated) {
        const sr = rng.next();
        if (sr < 0.06) {
          a.serial = rng.pick(tx.serialPlaceholders);
          add("SERIAL_PLACEHOLDER", "製造番号が「不明」「-」「N/A」などの仮の値", "ASSET.SERIALNUM");
        } else if (sr < 0.1) {
          a.serial = null;
          add("SERIAL_MISSING", "製造番号（SERIALNUM）が空", "ASSET.SERIALNUM");
        }
      }
    }
    // 製造元の欠け（移した資産）
    const rngMaker = this.rng.fork("dq-maker");
    for (const a of this.assets) {
      if (legacy && a.install < this.goLive && rngMaker.chance(0.03)) {
        a.maker = null;
        if (this.inMaximo(a)) this.problems.add("ASSET_NO_MANUFACTURER", "製造元（MANUFACTURER）が空", "ASSET.MANUFACTURER");
      }
    }
    // 重複して登録された資産（旧台帳からの移行で二重に取り込んだ）
    if (legacy) {
      for (const a of operating) {
        if (a.pos.child || a.install >= this.goLive || !rng.chance(0.02)) continue;
        const dup: Asset = {
          ...a, assetnum: String(s.assetBase + 900_000 + ++this.assetSeq), specs: [], meters: [], serial: null, duplicate: true, installNull: true,
          desc: tx.duplicateDesc(a.desc, rng.chance(0.5)), parent: a.parent, specsTrue: [],
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
      if (l.cls !== "LOC-PLANT" && (l.line ?? 0) > 0 && rng.chance(0.03)) {
        l.description = rng.chance(0.5) ? tx.lineNotation(l.description, l.line!) : tx.lineCharVariant(l.description, l.line!);
        this.problems.add("DESC_LINE_NOTATION", "炉の表記が揺れる（1号炉 / No.1炉 / １号炉）", "ASSET.DESCRIPTION / LOCATIONS.DESCRIPTION");
      }
      if (rng.chance(0.01)) {
        l.description = `${l.description} `;
        this.problems.add("TRAILING_SPACE", "値の末尾に空白がある", "ASSET.ASSETTAG / DESCRIPTION / SERIALNUM");
      }
    }
    // 設置日の無い資産
    for (const a of this.assets) {
      if (!a.duplicate && legacy && a.install < this.goLive && rng.chance(0.02)) {
        a.installNull = true;
        if (this.inMaximo(a)) this.problems.add("ASSET_NO_INSTALLDATE", "設置日（INSTALLDATE）が空", "ASSET.INSTALLDATE");
      }
    }
  }

  // ---- 電気の系統（ELEC）: 受電 → 主変圧器 → 高圧配電盤 → 動力変圧器 → コントロールセンタ → 電動機のある機器 ----

  private buildElectricalSystem(): void {
    const byName = (n: string) => this.positions.filter((p) => !p.child && p.item?.n === n);
    const recv = byName("受電遮断器")[0];
    const mtr = byName("主変圧器")[0];
    const hv = byName("高圧配電盤")[0];
    const ptr = byName("動力変圧器");
    const mcc = byName("コントロールセンタ");
    if (!recv || !mtr || !hv || ptr.length === 0 || mcc.length === 0) return;
    const locOf = new Map(this.locs.map((l) => [l.location, l]));
    const set = (loc: string, parent: string | null) => {
      const l = locOf.get(loc);
      if (l && l.elecParent === undefined) l.elecParent = parent;
    };
    set(recv.loc, null);
    set(mtr.loc, recv.loc);
    set(hv.loc, mtr.loc);
    ptr.forEach((p) => set(p.loc, hv.loc));
    mcc.forEach((m, i) => set(m.loc, ptr[i % ptr.length]!.loc));
    // 電動機を持つ機器。どの MCC から給電するかは系統・炉・場所から決める（乱数は使わない）
    for (const pos of this.positions) {
      if (pos.child?.c !== "MOTOR" || !pos.parentPos) continue;
      const k = (Number(pos.system) + pos.line * 7 + seedOf(pos.parentPos.loc)) % mcc.length;
      set(pos.loc, mcc[k]!.loc);
    }
  }

  // ---- 場所の階層のデータ品質の問題（旧台帳から移した施設） ----

  private injectLocationProblems(): void {
    if (!this.legacy) return;
    const rng = this.rng.fork("dq-loc");
    const units = this.unitLocs;
    for (const l of this.locs) {
      if (l.type !== "OPERATING" || l.parent === null || (l.cls !== "LOC-POS" && l.cls !== null)) continue;
      if (units.some((u) => u.loc === l.location)) continue;
      const r = rng.next();
      if (r < 0.01) {
        l.noHierarchy = true;
        this.problems.add("LOC_NOT_IN_HIERARCHY", "機能位置が場所の階層（PRIMARY）に入っていない", "LOCATIONS.LOCHIERARCHY");
      } else if (r < 0.015) {
        const other = units.filter((u) => u.line === (l.line ?? -1) && u.loc !== l.parent);
        if (other.length > 0) {
          l.parent = rng.pick(other).loc;
          this.problems.add("LOC_WRONG_PARENT", "機能位置の親が別の装置・設備系統になっている", "LOCATIONS.LOCHIERARCHY.PARENT");
        }
      } else if (r < 0.018) {
        l.type = "HOLDING";
        this.problems.add("LOC_TYPE_WRONG", "機能位置のタイプが運転（OPERATING）でない", "LOCATIONS.TYPE");
      }
    }
  }

  // ---- 東部の機器台帳（Excel）だけにある変更 ----

  ledgerDrift(rng: Rng): LedgerTruth[] {
    if (this.site.siteid !== "HIGASHI") return [];
    const tx = this.tx;
    const cutoff = jst(LEDGER_CUTOFF.y, LEDGER_CUTOFF.m, 1);
    const out: LedgerTruth[] = [];
    // 1) 基準日より後の更新（ろ布など寿命の短いもの）: Maximo は古い資産が稼働中のまま
    for (const pos of this.positions) {
      for (let i = 1; i < pos.gens.length; i++) {
        const g = pos.gens[i]!;
        if (g.install < cutoff) continue;
        const old = pos.gens[i - 1]!;
        g.hidden = true;
        if (!old.hidden) {
          old.stale = true;
          old.location = pos.loc;
        }
        const target = old.hidden ? (this.assetMap.get(old.assetnum) ?? old.assetnum) : old.assetnum;
        this.assetMap.set(g.assetnum, target);
        out.push({ kind: "REPLACED", asset: g, old, date: g.install });
      }
    }
    const current = this.positions
      .filter((p) => !p.child && p.gens.length > 0 && p.gens[p.gens.length - 1]!.decom === null && !p.gens[p.gens.length - 1]!.hidden)
      .map((p) => p.gens[p.gens.length - 1]!);
    const taken = new Set<Asset>(out.map((x) => x.asset));
    const pickBy = (pred: (a: Asset) => boolean, n: number): Asset[] => {
      const pool = current.filter((a) => pred(a) && !taken.has(a));
      const picked: Asset[] = [];
      while (picked.length < n && pool.length > 0) {
        const a = pool.splice(rng.int(0, pool.length - 1), 1)[0]!;
        taken.add(a);
        picked.push(a);
      }
      return picked;
    };
    // 2) 増設（台帳だけにある機器。機能位置は作ってあるが資産が無い）
    for (const nameJa of ["ピット汚水ポンプ", "換気送風機", "電気室空調機"]) {
      const same = this.positions.filter((p) => !p.child && p.item?.n === nameJa);
      const src = same[same.length - 1];
      if (!src || !src.item) continue;
      const k = same.length;
      const band = Math.floor(Number(src.tag.split("-")[2]!.replace(/\D/g, "")) / 100) * 100;
      const suffix = src.item.ab ? String.fromCharCode(65 + k) : "";
      const no = src.item.ab ? src.tag.split("-")[2]!.replace(/[A-Z]$/, "") : String(this.nextTagNo(src.line, band, src.item.t));
      const tag = `${src.line}-${src.item.t}-${no}${suffix}`;
      const loc = `${this.p}-${tag}`;
      const base = tx.t(src.item.n);
      const name = src.item.ab ? tx.abUnit(base, suffix) : tx.numbered(base, k + 1);
      const nameJa2 = src.item.ab ? `${src.item.n} ${suffix}号機` : `${src.item.n} No.${k + 1}`;
      const desc = src.line === 0 ? name : tx.sp(tx.lineName(src.line), name);
      const descJa = src.line === 0 ? nameJa2 : `${src.line}号炉 ${nameJa2}`;
      this.locs.push({ location: loc, description: desc, type: "OPERATING", parent: src.unitLoc, cls: "LOC-POS", siteid: this.site.siteid, line: src.line });
      const install = atTime(jst(2025, rng.int(7, 12), rng.int(1, 28)), 10);
      const pos: Position = { ...src, loc, tag, desc, descJa, gens: [], added: true, start: install };
      delete pos.parentPos;
      this.positions.push(pos);
      const a = this.newAsset(pos, install, null);
      a.hidden = true;
      a.vendor = rng.pick(["VND-MA", "VND-MB", "VND-SA"]);
      pos.gens.push(a);
      taken.add(a);
      out.push({ kind: "ADDED", asset: a, date: install });
    }
    // 3) 仕様の変更（ポンプの羽根車の外径を詰めた: 流量が下がる）
    for (const a of pickBy((x) => x.cls === "PUMP" && (x.specsTrue ?? []).some((r) => r.assetattrid === "FLOW" && typeof r.numvalue === "number"), 4)) {
      const row = a.specsTrue!.find((r) => r.assetattrid === "FLOW")!;
      const oldV = Number(row.numvalue);
      out.push({ kind: "SPEC_CHANGED", asset: a, date: atTime(jst(2025, rng.int(6, 12), rng.int(1, 28)), 10), spec: ["FLOW", oldV, round(oldV * 0.88, 1)] });
    }
    // 4) 名前の変更
    for (const a of pickBy((x) => x.cls === "FAN" || x.cls === "PUMP", 3)) {
      out.push({ kind: "RENAMED", asset: a, date: atTime(jst(2025, rng.int(5, 12), rng.int(1, 28)), 10), newDesc: `${a.pos.desc}${tx.lang === "ja" ? "（用途変更）" : " (repurposed)"}` });
    }
    // 5) 撤去（台帳では撤去済み、Maximo は稼働中のまま）
    for (const a of pickBy((x) => x.cls === "FAN" || x.cls === "HVAC" || x.cls === "TANK", 2)) {
      out.push({ kind: "REMOVED", asset: a, date: atTime(jst(2026, rng.int(1, 6), rng.int(1, 28)), 10) });
    }
    // 6) Maximo の方が新しい（製造番号を Maximo で直した。台帳は古いまま）
    for (const a of pickBy((x) => x.serial !== null && x.serial === x.serialTrue, 4)) {
      const fixed = atTime(jst(2026, rng.int(1, 8), rng.int(1, 28)), 11);
      const oldSerial = `${a.serial!.slice(0, -2)}${pad(rng.int(10, 99), 2)}`;
      a.changedOverride = fixed;
      out.push({ kind: "MAXIMO_NEWER", asset: a, date: fixed, oldSerial });
    }
    return out;
  }

  // ---- 正解: 星取表（Maximo を入れる前の実績と予定）・旧台帳 ----

  historyEvents(): HistoryEvent[] {
    if (!this.legacy) return [];
    const out: HistoryEvent[] = [];
    for (const w of this.wos) {
      if (w.report >= this.goLive) continue;
      const asset = w.asset ?? null;
      if (!asset) continue;
      const done = w.attrs.status === "COMP" || w.attrs.status === "CLOSE";
      const kind = String(w.attrs.worktype) as HistoryEvent["kind"];
      const date = typeof w.attrs.actstart === "string" ? Date.parse(w.attrs.actstart) : Date.parse(String(w.attrs.targstartdate));
      // Maximo を入れた後に行った作業は星取表に載らない（Maximo を入れる前に依頼し、入れた後に行った少しの作業は、どちらにも残っていない）
      if (date >= this.goLive) continue;
      out.push({ site: this.site.siteid, loc: asset.pos.loc, assetnum: asset.assetnum, cls: asset.pos.cls, date, kind, jp: w.prog?.jp ?? null, law: w.prog?.law === true, planned: !done });
    }
    // 更新（新しい資産を据えた）
    for (const pos of this.positions) {
      for (let i = 1; i < pos.gens.length; i++) {
        const g = pos.gens[i]!;
        if (g.install >= this.goLive) continue;
        out.push({ site: this.site.siteid, loc: pos.loc, assetnum: g.assetnum, cls: pos.cls, date: g.install, kind: "CP", jp: null, law: false, planned: false });
      }
    }
    return out;
  }

  legacyAssets(): LegacyAssetTruth[] {
    if (!this.legacy) return [];
    const at = this.goLive - DAY;
    const out: LegacyAssetTruth[] = [];
    for (const a of this.assets) {
      if (a.duplicate || a.install > at || (a.decom !== null && a.decom <= at)) continue;
      const model = (a.specsTrue ?? []).find((r) => r.assetattrid === "MODEL")?.alnvalue ?? null;
      const mfg = (a.specsTrue ?? []).find((r) => r.assetattrid === "MFG_YEAR")?.numvalue ?? null;
      out.push({
        site: this.site.siteid, assetnum: a.assetnum, pos: a.pos, install: a.install, decom: a.decom, serial: a.serialTrue ?? "", maker: a.makerTrue,
        model: typeof model === "string" ? model : null, mfgYear: typeof mfg === "number" ? mfg : null, inMaximo: this.inMaximo(a),
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

export function calendarMs(h: number): number {
  if (h <= 10) return h * HOUR;
  if (h <= 100) return Math.ceil(h / 8) * DAY;
  return Math.ceil(h / 24) * DAY;
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** PM の説明から分類名を除いた部分（日本語の正本。【法定】を含む） */
export function shortDesc(prog: PmProgram): string {
  const law = prog.desc.startsWith("【法定】");
  const body = prog.desc.replace("【法定】", "");
  const i = body.indexOf(" ");
  return `${law ? "【法定】" : ""}${i >= 0 ? body.slice(i + 1) : body}`;
}

/** 作業指示の外注の属性（contracts.ts が埋める） */
function emptyContractAttrs(): Row {
  return {
    vendor: null, estservcost: null, estatapprservcost: null, actservcost: null,
    ext_ponum: null, ext_assessamt: null, ext_orderamt: null, ext_acceptamt: null, ext_podate: null, ext_acceptdate: null, ext_legal: null, ext_dept: null, ext_sourceref: null,
  };
}

// ---------------------------------------------------------------------------
// 表の行への変換
// ---------------------------------------------------------------------------

function locRecord(l: Loc, ids: Ids, parents: Set<string>, elecParents: Set<string>): Rec {
  const children: Record<string, Row[]> = {};
  const hier: Row[] = [];
  if (l.type === "OPERATING" || l.type === "HOLDING") {
    if (!l.noHierarchy) hier.push({ lochierarchyid: ids.next("lochierarchyid"), systemid: "PRIMARY", parent: l.parent, children: parents.has(l.location), siteid: l.siteid, orgid: ORGID });
    if (l.elecParent !== undefined) hier.push({ lochierarchyid: ids.next("lochierarchyid"), systemid: "ELEC", parent: l.elecParent, children: elecParents.has(l.location), siteid: l.siteid, orgid: ORGID });
  }
  if (hier.length > 0) children.lochierarchy = hier;
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

function assetRecord(a: Asset, ctx: SiteContext, ids: Ids, mapAsset: (v: CellValue | undefined) => CellValue): Rec {
  const decom = a.decom !== null && !a.stale;
  const changed = a.changedOverride ?? ctx.registeredAt(decom ? Math.max(a.decom!, a.install) : a.install);
  return {
    attrs: {
      assetnum: a.assetnum, siteid: ctx.site.siteid, orgid: ORGID, description: a.desc, assettag: a.tag ?? null, location: a.location, parent: mapAsset(a.parent),
      status: decom ? "DECOMMISSIONED" : "OPERATING", statusdate: fmt(decom ? a.decom! : a.install), installdate: a.installNull ? null : fmt(a.install),
      serialnum: a.serial, manufacturer: a.duplicate ? null : a.maker, vendor: a.duplicate ? null : a.vendor, priority: a.pos.priority,
      classstructureid: a.cls ? CLASS_CSID.get(a.cls)! : null, failurecode: a.cls ? (CLASS_BY_ID.get(a.cls)?.failure ?? null) : null,
      itemnum: a.itemnum ?? null, binnum: a.binnum ?? null,
      isrunning: !decom && !a.spare, assetid: ids.next("assetid"), changeby: "MAXADMIN", changedate: fmt(changed),
    },
    children: { assetspec: a.specs ?? [], assetmeter: a.meters, sparepart: a.spareparts ?? [] },
  };
}

/** 作業指示と SR に番号を振る（組織で 1 つの連番。報告日の順） */
function numberWorkOrders(wos: WoDraft[], srs: SrDraft[], ids: Ids, push: (t: string, r: Rec) => void, mapAsset: (v: CellValue | undefined) => CellValue): void {
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
    w.attrs.assetnum = mapAsset(w.attrs.assetnum);
    if (w.parentRef?.wonum) w.attrs.parent = w.parentRef.wonum;
    if (w.sr?.ticketid) {
      w.attrs.origrecordid = w.sr.ticketid;
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
    s.attrs.assetnum = mapAsset(s.attrs.assetnum);
    push("SR", {
      attrs: s.attrs,
      children: {
        tkstatus: s.statuses.map(([status, at, by]) => ({ tkstatusid: ids.next("tkstatusid"), status, changedate: fmt(at), changeby: by })),
        relatedrecord: s.wo?.wonum ? [{ relatedrecordid: ids.next("relatedrecordid"), relatedreckey: s.wo.wonum, relatedrecclass: "WORKORDER", relatetype: "FOLLOWUP", relatedrecsiteid: s.site.siteid }] : [],
      },
    });
  }
}
