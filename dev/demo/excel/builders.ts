// デモの Excel 5 種（日英）。どれもデータ（dev/datasets/plants）と同じ種から作るので、Maximo のデータと突き合わせられ、正解（truth）がある。
//   1. 発注リスト（2026 年度上半期）       … 作業指示番号は無い。件名・施設・時期で結ぶ。金額・日付の書式が揺れる
//   2. 旧設備台帳（Maximo を入れる直前）   … 製造番号・設置日・メーカーを補う。古い形式のタグ、和暦
//   3. 修理記録（北部 2026 年度上半期）     … 日本語は A4 の作業日報（帳票）、英語は表。故障コードの無い是正保全を埋め、Maximo に無い修理を見つける
//   4. 東部の機器台帳（Maximo より先に進んだ）… 更新・増設・仕様の変更・撤去。Maximo の方が新しい行もある
//   5. 星取表（北部・南部、Maximo を入れる前）… 履歴の作業指示として登録する

import { CAUSES, CLASSES, COMPANIES, PM_PROGRAMS, PROBLEMS, REMEDIES, SITES, SYSTEMS, type SiteCode } from "../../datasets/plants/catalog.ts";
import type { OrderTruth } from "../../datasets/plants/contracts.ts";
import { type Asset, type HistoryEvent, type PlantsData, type Position, type WoDraft } from "../../datasets/plants/generate.ts";
import { Text, type Lang } from "../../datasets/plants/text.ts";
import { DAY, Rng, jst, pad, seedOf, ymd } from "../../datasets/plants/util.ts";
import { colName, type CellInput, type CellSpec, type SheetSpec } from "./xlsx.ts";

export interface ExcelFile {
  /** URL に使う ASCII の ID */
  id: string;
  fileName: string;
  title: string;
  sheets: SheetSpec[];
  /** 正解（公開しない。確かめる道具と試験が使う） */
  truth: unknown;
}

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

class Ctx {
  readonly lang: Lang;
  readonly tx: Text;
  readonly data: PlantsData;
  constructor(data: PlantsData) {
    this.data = data;
    this.lang = data.lang;
    this.tx = new Text(data.lang);
  }
  L(ja: string, en: string): string {
    return this.lang === "ja" ? ja : en;
  }
  site(code: SiteCode): string {
    return this.tx.t(SITES.find((s) => s.siteid === code)!.description);
  }
  siteShort(code: SiteCode): string {
    return this.L(`${{ KITA: "北部", MINAMI: "南部", HIGASHI: "東部" }[code]}CC`, `${{ KITA: "North", MINAMI: "South", HIGASHI: "East" }[code]} CC`);
  }
  company(code: string): string {
    return this.tx.t(COMPANIES.find((c) => c.company === code)?.name ?? code);
  }
  /** 会社名の書き方の揺れ（日英で同じ数） */
  companyVariant(code: string, rng: Rng): string {
    const n = this.company(code);
    if (this.lang === "ja") {
      const half = n.replace(/[Ａ-Ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
      return rng.pick([n, n, half, `(株)${half}`, `${half}株式会社`]);
    }
    return rng.pick([n, n, n.toUpperCase(), `${n} Inc.`, n.replace("Contractor", "Contr.").replace("Maker", "Mfg.")]);
  }
  person(id: string | null): { last: string; first: string; display: string } | null {
    if (!id) return null;
    return this.data.truth.persons.get(id) ?? null;
  }
  /** 担当者の書き方（姓だけ・フルネーム・イニシャル） */
  personVariant(id: string | null, rng: Rng): string {
    const p = this.person(id);
    if (!p) return "";
    const k = rng.int(0, 2);
    if (this.lang === "ja") return k === 0 ? p.last : k === 1 ? `${p.last} ${p.first}` : p.last;
    return k === 0 ? p.last : k === 1 ? `${p.first[0]}. ${p.last}` : `${p.first} ${p.last}`;
  }
  /** 炉の名前を除いた機器名（「1号炉 押込送風機」→「押込送風機」） */
  bare(desc: string): string {
    return this.lang === "ja" ? desc.replace(/^\d号炉 /, "") : desc.replace(/^Line \d /, "");
  }
  lineName(line: number): string {
    return this.tx.lineName(line);
  }
}

/** 和暦（平成は 2019-04-30 まで） */
export function wareki(y: number, m: number, d?: number): { short: string; long: string } {
  const reiwa = y > 2019 || (y === 2019 && m >= 5);
  const era = reiwa ? "R" : "H";
  const n = reiwa ? y - 2018 : y - 1988;
  const kanji = reiwa ? "令和" : "平成";
  return { short: `${era}${n}.${m}${d !== undefined ? `.${d}` : ""}`, long: `${kanji}${n === 1 ? "元" : n}年${m}月${d !== undefined ? `${d}日` : ""}` };
}

function fy(ms: number): number {
  const { y, m } = ymd(ms);
  return m >= 4 ? y : y - 1;
}

const head = (v: string): CellSpec => ({ v, s: "head" });
const cell = (v: string | number | null): CellSpec => ({ v, s: "cell" });

// ---------------------------------------------------------------------------
// 1. 発注リスト
// ---------------------------------------------------------------------------

interface OrderRowTruth {
  sheet: string;
  row: number;
  kind: OrderTruth["kind"];
  site: SiteCode;
  wonums: string[];
  ponum: string;
  vendor: string;
  assess: number;
  order: number;
  accept: number | null;
  podate: string;
  compdate: string | null;
  acceptdate: string | null;
  legal: boolean;
  buyer: string | null;
  dept: string;
  prefilled?: string;
}

const isoDay = (ms: number | null) => (ms === null ? null : new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10));

export function purchaseOrders(data: PlantsData): ExcelFile {
  const c = new Ctx(data);
  const rng = new Rng(seedOf("excel-orders"));
  const tx = c.tx;
  const ja = c.lang === "ja";
  const orders = data.truth.orders.filter((o) => o.current && !o.unlisted);
  const money = (jpy: number | null, r: Rng): CellInput => {
    if (jpy === null) return cell(null);
    const p = r.next();
    if (ja) {
      if (p < 0.7) return { v: jpy, s: "money" };
      if (p < 0.85) return cell(`${Math.round(jpy / 1000).toLocaleString("en-US")}千円`);
      if (p < 0.95) return cell(`${(jpy / 10_000).toFixed(1)}万円`);
      return cell(`¥${jpy.toLocaleString("en-US")}`);
    }
    const usd = tx.money(jpy);
    if (p < 0.7) return { v: usd, s: "money" };
    if (p < 0.85) return cell(`$${usd.toLocaleString("en-US")}`);
    if (p < 0.95) return cell(`${(usd / 1000).toFixed(1)}k`);
    return cell(`USD ${usd.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
  };
  const date = (ms: number | null, r: Rng): CellInput => {
    if (ms === null) return cell(null);
    const { y, m, d } = ymd(ms);
    const p = r.next();
    if (p < 0.6) return { v: ms, s: "date", date: true };
    if (ja) {
      if (p < 0.8) return cell(wareki(y, m, d).short);
      if (p < 0.95) return cell(`${m}/${d}`);
      return cell(`${y}年${m}月${d}日`);
    }
    if (p < 0.8) return cell(`${pad(m, 2)}/${pad(d, 2)}/${y}`);
    if (p < 0.95) return cell(`${tx.monthName(m)} ${d}`);
    return cell(`${y}-${pad(m, 2)}-${pad(d, 2)}`);
  };
  const legal = (on: boolean, r: Rng) => (on ? r.pick(ja ? ["○", "○", "法定"] : ["Y", "Yes", "Statutory"]) : r.pick(ja ? ["", "", "×"] : ["", "N", "No"]));
  const dept = (code: string, r: Rng) => {
    const v: Record<string, [string[], string[]]> = {
      FAC: [["施設課", "施設", "施設管理課"], ["Facilities", "Facilities Div.", "Facility Mgmt"]],
      EIC: [["電気計装課", "電計課", "電気計装"], ["E&I", "E&I Div.", "Elec & Inst"]],
      GEN: [["総務課", "総務", "総務課"], ["General Affairs", "GA", "General Affairs"]],
    };
    return r.pick(v[code]![ja ? 0 : 1]);
  };
  const work = (w: WoDraft): string => {
    if (w.prog) {
      const short = tx.t((w.prog.desc.replace("【法定】", "").split(" ")[1] ?? w.prog.desc));
      if (w.prog.jp === "LINE-OH") return c.L(`定期整備工事（${ymd(w.report).m <= 8 ? "春季" : "秋季"}）`, `${ymd(w.report).m <= 8 ? "spring" : "autumn"} outage works`);
      return c.L(`${short}業務委託`, `${short.toLowerCase()} service`);
    }
    const prob = w.truth?.prob ?? "";
    const jaW: Record<string, string> = { LEAK: "漏れ補修", VIB: "振動対策", NOISE: "異音対応", TRIP: "停止原因調査・修繕", OVERHEAT: "過熱対策" };
    const enW: Record<string, string> = { LEAK: "leak repair", VIB: "vibration repair", NOISE: "noise investigation", TRIP: "trip investigation and repair", OVERHEAT: "overheating repair" };
    return c.L(`${jaW[prob] ?? "修繕"}工事`, enW[prob] ?? "repair works");
  };
  const subject = (o: OrderTruth, r: Rng): string => {
    if (o.kind === "NOWO") return c.L(o.label!, ({ "ろ布 交換用 購入": "Purchase of replacement filter bags", "消石灰 購入（4〜9月分）": "Purchase of hydrated lime (Apr-Sep)", "作業服・保護具 購入": "Purchase of workwear and PPE" } as Record<string, string>)[o.label!] ?? o.label!);
    if (o.kind === "ANNUAL") {
      const prog = PM_PROGRAMS.find((p) => p.jp === o.label)!;
      const name = tx.t(prog.desc).replace(tx.law, "").replace("【法定】", "");
      return c.L(`令和8年度 ${name} 業務委託（単価契約）`, `FY2026 ${name} service contract (unit-price)`);
    }
    const w = o.wo!;
    const pos = w.asset?.pos;
    const site = r.chance(0.5) ? c.site(o.site) : c.siteShort(o.site);
    if (!pos) return `${site} ${w.locDesc ?? ""} ${work(w)}`.replace(/\s+/g, " ").trim();
    const line = pos.line > 0 ? c.L(`${pos.line}号炉`, `Line ${pos.line} `) : "";
    const nameVariant = (s: string) => (ja ? s.replace("押込送風機", r.pick(["押込送風機", "FDF"])).replace("誘引送風機", r.pick(["誘引送風機", "IDF"])) : s.replace("Forced Draft Fan", r.pick(["FD Fan", "FDF"])).replace("Induced Draft Fan", r.pick(["ID Fan", "IDF"])));
    return `${site} ${line}${nameVariant(c.bare(pos.desc))} ${work(w)}`.replace(/\s+/g, " ").trim();
  };
  const notes = (o: OrderTruth, r: Rng): string => {
    if (o.kind === "CHANGE") return c.L("変更契約（増額）", "Change order (increase)");
    if (o.kind === "CANCELLED") return c.L("取消", "Cancelled");
    if (o.kind === "ANNUAL") return c.L("年間・単価契約（作業ごとに実施）", "Annual unit-price contract (per job)");
    return r.pick(ja ? ["", "", "", "請求書待ち", "一部検収", "工期延長あり"] : ["", "", "", "Awaiting invoice", "Partially accepted", "Schedule extended"]);
  };

  const columns = ja
    ? ["No.", "施設", "件名", "業者", "査定額", "発注額", "検収額", "発注日", "工事完了日", "検収日", "法規", "担当", "部門", "備考"]
    : ["No.", "Plant", "Subject", "Vendor", "Assessed", "Ordered", "Accepted", "PO date", "Work completed", "Accepted on", "Statutory", "Buyer", "Dept", "Notes"];
  const sheetName = c.L("発注一覧", "Purchase orders");
  const rows: CellInput[][] = [
    [{ v: c.L("令和8年度 上半期 発注一覧（施設課・電気計装課）", "FY2026 H1 Purchase Order Register (Facilities / E&I)"), s: "title" }],
    [{ v: c.L("※金額は税込（円）。担当は発注担当者。作業指示番号は記入していません。", "Amounts include tax (USD). Buyer = person who raised the order. Work order numbers were not recorded."), s: "note" }],
    [],
    columns.map(head),
  ];
  const merges = ["A1:N1", "A2:N2"];
  const truth: OrderRowTruth[] = [];
  let no = 0;
  for (const site of ["KITA", "MINAMI", "HIGASHI"] as SiteCode[]) {
    const list = orders.filter((o) => o.site === site).sort((a, b) => a.podate - b.podate || a.ponum.localeCompare(b.ponum));
    let sumOrder = 0;
    let sumAccept = 0;
    for (const o of list) {
      const r = rng.fork(`${o.site}|${o.ponum}|${o.kind}`);
      no++;
      const rowIndex = rows.length + 1;
      rows.push([
        cell(no), cell(r.chance(0.7) ? c.siteShort(site) : c.site(site)), { v: subject(o, r), s: "wrap" }, cell(c.companyVariant(o.vendor, r)),
        money(o.assess, r), money(o.order, r), money(o.accept, r), date(o.podate, r), date(o.compdate, r), date(o.acceptdate, r),
        { v: legal(o.legal, r), s: "center" }, cell(c.personVariant(o.buyer, r)), cell(dept(o.dept, r)), { v: notes(o, r), s: "wrap" },
      ]);
      if (o.kind !== "CANCELLED") {
        sumOrder += o.order;
        sumAccept += o.accept ?? 0;
      }
      truth.push({
        sheet: sheetName, row: rowIndex, kind: o.kind, site, wonums: o.wos.map((w) => w.wonum ?? "").filter(Boolean), ponum: o.ponum, vendor: o.vendor,
        assess: ja ? o.assess : tx.money(o.assess), order: ja ? o.order : tx.money(o.order), accept: o.accept === null ? null : ja ? o.accept : tx.money(o.accept),
        podate: isoDay(o.podate)!, compdate: isoDay(o.compdate), acceptdate: isoDay(o.acceptdate), legal: o.legal, buyer: o.buyer, dept: o.dept,
        ...(o.prefilled ? { prefilled: o.prefilled } : {}),
      });
    }
    // 施設ごとの小計の行
    rows.push([null, { v: c.L(`${c.siteShort(site)} 小計`, `${c.siteShort(site)} subtotal`), s: "total" }, { v: "", s: "total" }, { v: "", s: "total" }, { v: "", s: "total" },
      { v: ja ? sumOrder : tx.money(sumOrder), s: "total" }, { v: ja ? sumAccept : tx.money(sumAccept), s: "total" }]);
    rows.push([]);
  }
  return {
    id: "purchase-orders",
    fileName: c.L("発注一覧_令和8年度上半期.xlsx", "Purchase_orders_FY2026_H1.xlsx"),
    title: c.L("発注一覧（令和8年度上半期）", "Purchase orders (FY2026 H1)"),
    sheets: [{ name: sheetName, rows, merges, cols: [6, 14, 48, 26, 12, 12, 12, 12, 12, 12, 10, 16, 14, 26], freeze: { row: 5 } }],
    truth: { rows: truth },
  };
}

// ---------------------------------------------------------------------------
// 2. 旧設備台帳（Maximo を入れる直前）
// ---------------------------------------------------------------------------

/** 旧台帳のタグの書き方（古い形式: ハイフン無しなど） */
function oldTag(tag: string, r: Rng): string {
  const p = r.next();
  if (p < 0.45) return tag.replace(/-/g, "");
  if (p < 0.7) return tag.replace(/^(\d)-/, "$1");
  if (p < 0.85) return tag;
  return tag.replace(/-/g, " ");
}

export function legacyRegister(data: PlantsData): ExcelFile {
  const c = new Ctx(data);
  const tx = c.tx;
  const ja = c.lang === "ja";
  const rng = new Rng(seedOf("excel-legacy"));
  const sheets: SheetSpec[] = [];
  const truth: Array<{ sheet: string; row: number; assetnum: string; inMaximo: boolean; serial: string; maker: string | null; install: string; tag: string }> = [];
  for (const site of ["KITA", "MINAMI"] as SiteCode[]) {
    const list = data.truth.legacy.filter((l) => l.site === site).sort((a, b) => a.pos.loc.localeCompare(b.pos.loc) || a.pos.tag.localeCompare(b.pos.tag));
    const sheetName = c.L(c.siteShort(site).replace("CC", ""), c.siteShort(site).replace(" CC", ""));
    const at = data.truth.goLive[site]! - DAY;
    const { y, m, d } = ymd(at);
    const rows: CellInput[][] = [
      [{ v: c.L(`${c.site(site)} 設備台帳（${wareki(y, m, d).long}現在）`, `${c.site(site)} Equipment Register (as of ${y}-${pad(m, 2)}-${pad(d, 2)})`), s: "title" }],
      [{ v: c.L("※Maximo 導入前の紙台帳を Excel に起こしたもの。機器番号は旧番号。", "Typed up from the paper register kept before Maximo. Equipment numbers use the old format."), s: "note" }],
      [head(c.L("機器", "Equipment")), null, null, null, head(c.L("製造", "Manufacture")), null, null, null, head(c.L("設置", "Installation")), null, head(c.L("備考", "Remarks"))],
      (ja ? ["旧機器番号", "機器名称", "設置場所", "系統", "メーカー", "型式", "製造番号", "製造年", "設置年月", "状態", "備考"]
        : ["Old equipment no.", "Equipment", "Location", "System", "Manufacturer", "Model", "Serial no.", "Year built", "Installed", "Status", "Remarks"]).map(head),
    ];
    for (const l of list) {
      const r = rng.fork(l.assetnum);
      const { y: iy, m: im } = ymd(l.install);
      const p = r.next();
      let installed: CellInput;
      if (ja) installed = p < 0.35 ? cell(wareki(iy, im).short) : p < 0.6 ? cell(wareki(iy, im).long) : p < 0.85 ? cell(`${iy}/${im}`) : { v: jst(iy, im, 1), s: "date", date: true };
      else installed = p < 0.35 ? cell(`${tx.monthName(im)}-${iy}`) : p < 0.6 ? cell(`${iy}/${pad(im, 2)}`) : p < 0.85 ? cell(`${pad(im, 2)}/${iy}`) : { v: jst(iy, im, 1), s: "date", date: true };
      const mfg = l.mfgYear === null ? cell(null) : r.chance(0.3) && ja ? cell(wareki(l.mfgYear, 4).short.replace(/\.4$/, "")) : cell(l.mfgYear);
      const sysName = c.lineName(l.pos.line);
      const rowIndex = rows.length + 1;
      rows.push([
        cell(oldTag(l.pos.tag, r)), cell(c.bare(l.pos.desc)), cell(l.pos.line === 0 ? c.L("共通", "Common") : sysName), cell(tx.t(SYSTEMS_BY_CODE.get(l.pos.system) ?? "")), cell(l.maker ? c.companyVariant(l.maker, r) : ""),
        cell(l.model ?? ""), cell(l.serial), mfg, installed, cell(c.L("稼働", "In service")), cell(r.chance(0.05) ? c.L("予備品あり", "Spare held") : ""),
      ]);
      truth.push({ sheet: sheetName, row: rowIndex, assetnum: l.assetnum, inMaximo: l.inMaximo, serial: l.serial, maker: l.maker, install: isoDay(l.install)!, tag: l.pos.tag });
    }
    sheets.push({ name: sheetName, rows, merges: ["A1:K1", "A2:K2", "A3:D3", "E3:H3", "I3:J3"], cols: [14, 34, 10, 22, 22, 14, 16, 9, 12, 8, 14], freeze: { row: 5 } });
  }
  return {
    id: "legacy-register",
    fileName: c.L("設備台帳_平成30年3月末_北部南部.xlsx", "Legacy_equipment_register_2018_North_South.xlsx"),
    title: c.L("旧設備台帳（Maximo 導入前）", "Legacy equipment register (before Maximo)"),
    sheets,
    truth: { rows: truth },
  };
}

// ---------------------------------------------------------------------------
// 3. 修理記録（北部 2026 年度上半期）
// ---------------------------------------------------------------------------

const NICK_JA: Array<[RegExp, string[]]> = [
  [/押込送風機/, ["押込", "FDF", "押込送風機"]], [/誘引送風機/, ["IDF", "誘引", "誘引ファン"]], [/ボイラ給水ポンプ/, ["BFP", "給水P", "ボイラ給水ポンプ"]],
  [/ごみクレーン/, ["ごみクレーン", "クレーン", "ごみクレ"]], [/ろ過式集じん器/, ["バグ", "BF", "集じん器"]], [/空気圧縮機/, ["コンプ", "空圧機", "空気圧縮機"]],
];
const NICK_EN: Array<[RegExp, string[]]> = [
  [/Forced Draft Fan/, ["FD fan", "FDF", "Forced Draft Fan"]], [/Induced Draft Fan/, ["IDF", "ID fan", "ID Fan"]], [/Boiler Feed Pump/, ["BFP", "feed pump", "Boiler Feed Pump"]],
  [/Refuse Crane/, ["refuse crane", "crane", "Refuse Crane"]], [/Bag Filter/, ["baghouse", "BF", "bag filter"]], [/Air Compressor/, ["compressor", "air comp", "Air Compressor"]],
];

const PROB_JA: Record<string, string[]> = {
  LEAK: ["漏れあり", "にじみ", "漏れ"], VIB: ["振動大", "振動ひどい", "ゆれ"], NOISE: ["異音", "キーキー音", "変な音"], LOWPERF: ["能力低下", "吐出弱い", "効き悪い"],
  OVERHEAT: ["温度高い", "軸受温度上昇", "過熱"], NOSTART: ["起動せず", "起動不良", "動かない"], TRIP: ["トリップ", "停止", "故障停止"], JAM: ["噛み込み停止", "詰まり停止", "かみこみ"],
  CLOG: ["詰まり", "閉塞", "つまり"], DRIFT: ["指示ふらつき", "指示不良", "値おかしい"], ALARM: ["警報", "アラーム", "異常警報"], NOSIGNAL: ["信号断", "表示なし", "信号来ない"],
};
const PROB_EN: Record<string, string[]> = {
  LEAK: ["leaking", "weeping", "leak"], VIB: ["high vib", "vibrating badly", "shaking"], NOISE: ["noise", "squeal", "odd noise"], LOWPERF: ["low output", "weak discharge", "poor performance"],
  OVERHEAT: ["running hot", "brg temp high", "overheating"], NOSTART: ["won't start", "start failure", "dead"], TRIP: ["tripped", "stopped", "fault trip"], JAM: ["jammed", "blocked & stopped", "jam"],
  CLOG: ["clogged", "blocked", "blockage"], DRIFT: ["reading unstable", "bad reading", "value wrong"], ALARM: ["alarm", "alarm on", "fault alarm"], NOSIGNAL: ["no signal", "not showing", "signal lost"],
};
const NOISE_LINES_JA = ["巡視 異常なし", "定期点検 異常なし", "清掃のみ", "グリスアップ", "床の清掃", "照明交換（事務所）", "工具点検"];
const NOISE_LINES_EN = ["Rounds - no issues", "PM check - OK", "Cleaning only", "Greased", "Floor cleaned", "Office light replaced", "Tool check"];

/** 修理記録: 日本語は作業日報（帳票）、英語は表 */
export function repairLog(data: PlantsData): ExcelFile {
  return data.lang === "ja" ? dailyReports(data) : repairTable(data);
}

/** 表の修理記録（英語のデータ。月ごとのシート、日付は結合） */
function repairTable(data: PlantsData): ExcelFile {
  const c = new Ctx(data);
  const tx = c.tx;
  const ja = c.lang === "ja";
  const rng = new Rng(seedOf("excel-repairs"));
  const entries = data.truth.repairs
    .map((r) => r.wo)
    .filter((w) => w.wonum !== undefined && (w.attrs.status === "COMP" || w.attrs.status === "CLOSE" || w.attrs.status === "INPRG"))
    .sort((a, b) => a.report - b.report);
  const sheets: SheetSpec[] = [];
  const truth: RepairRowTruth[] = [];
  // Maximo に無い小さな修理（日本語の作業日報と同じ日・機器・不具合。書き方だけを英語の表に合わせる）
  const freshRng = new Rng(seedOf("excel-daily"));
  const kitaPositions = freshPositions(data);
  for (let month = 4; month <= 9; month++) {
    const sheetName = c.L(`${month}月`, `${tx.monthName(month)} 2026`);
    const rows: CellInput[][] = [
      [{ v: c.L(`北部クリーンセンター 修理記録 2026年${month}月（機械・電気計装）`, `North Clean Center repair log - ${tx.monthName(month)} 2026 (mechanical / E&I)`), s: "title" }],
      [],
      (ja ? ["日付", "炉", "機器", "内容", "処置", "時間", "担当"] : ["Date", "Line", "Equipment", "Issue", "Action", "Time", "By"]).map(head),
    ];
    const merges = ["A1:G1"];
    type Line = { day: number; cells: CellInput[]; wo?: WoDraft; fresh?: NewRepairTruth };
    const lines: Line[] = [];
    for (const w of entries) {
      const { m, d } = ymd(w.report);
      if (m !== month) continue;
      const r = rng.fork(w.wonum!);
      const pos = w.asset!.pos;
      let equip = c.bare(pos.desc);
      for (const [re, alts] of ja ? NICK_JA : NICK_EN) if (re.test(equip)) equip = equip.replace(re, r.pick(alts));
      const t = w.truth!;
      const issue = r.pick((ja ? PROB_JA : PROB_EN)[t.prob] ?? [tx.t(PROBLEMS[t.prob]!)]);
      const cause = tx.t(CAUSES[t.cause] ?? "");
      const remedy = tx.t(REMEDIES[t.remedy] ?? "");
      const action = w.attrs.status === "INPRG" ? c.L("対応中", "in progress") : ja ? `${cause}のため${remedy}` : `${cause} - ${remedy.toLowerCase()}`;
      const hrs = Number(w.attrs.actlabhrs ?? 0) / 2 || Number(w.attrs.estdur ?? 2);
      const time = r.chance(0.15) ? c.L("半日", "half day") : ja ? `${Math.round(hrs * 2) / 2}h` : r.chance(0.5) ? `${Math.round(hrs * 2) / 2}h` : `${Math.round(hrs * 2) / 2} hrs`;
      const lead = c.person(typeof w.attrs.lead === "string" ? w.attrs.lead : null);
      lines.push({
        day: d, wo: w,
        cells: [null, cell(pos.line === 0 ? c.L("共通", "Com") : c.L(`${pos.line}号`, `L${pos.line}`)), cell(equip), cell(issue), { v: action, s: "wrap" }, cell(time), cell(lead ? (ja ? lead.last : lead.last) : "")],
      });
    }
    const leads = [...new Set(lines.map((l) => l.cells[6]).flatMap((x) => (x && typeof x === "object" && "v" in x && typeof x.v === "string" && x.v !== "" ? [x.v] : [])))];
    for (const f of planFresh(month, freshRng.fork(`month-${month}`), kitaPositions)) {
      const { day, pos, asset, tmpl, r } = f;
      const en = NEW_REPAIRS_EN[pos.cls]![NEW_REPAIRS[pos.cls]!.indexOf(tmpl)]!;
      let equip = c.bare(pos.desc);
      for (const [re, alts] of NICK_EN) if (re.test(equip)) equip = equip.replace(re, r.pick(alts));
      equip = equip.replace(/ No\.(\d+)$/, (_m, n: string) => r.pick([` No.${n}`, ` #${n}`, ` ${n}`]));
      const h = Math.round(tmpl.hours * 2) / 2;
      const time = r.chance(0.15) ? "half day" : r.chance(0.5) ? `${h}h` : `${h} hrs`;
      lines.push({
        day,
        cells: [null, cell(pos.line === 0 ? "Com" : `L${pos.line}`), cell(equip), cell(r.pick(en.issue)), { v: r.pick(en.act), s: "wrap" }, cell(time), cell(leads.length > 0 ? r.pick(leads) : "")],
        fresh: { date: `2026-${pad(month, 2)}-${pad(day, 2)}`, assetnum: asset.assetnum, location: asset.location, description: `${pos.desc} ${en.issue[0]}`, prob: tmpl.prob, cause: tmpl.cause, remedy: tmpl.remedy, hours: tmpl.hours },
      });
    }
    // 修理と関係の無い記録（雑多な行）
    const days = new Set(lines.map((l) => l.day));
    for (let k = 0; k < 8; k++) {
      const r = rng.fork(`noise-${month}-${k}`);
      const day = r.int(1, 28);
      days.add(day);
      lines.push({ day, cells: [null, cell(""), cell(""), cell(r.pick(ja ? NOISE_LINES_JA : NOISE_LINES_EN)), cell(""), cell(""), cell("")] });
    }
    lines.sort((a, b) => a.day - b.day);
    let i = 0;
    while (i < lines.length) {
      const day = lines[i]!.day;
      let j = i;
      while (j < lines.length && lines[j]!.day === day) j++;
      const first = rows.length + 1;
      for (let k = i; k < j; k++) {
        const l = lines[k]!;
        const row = [...l.cells];
        row[0] = k === i ? { v: jst(2026, month, day), s: "date", date: true } : { v: null, s: "date" };
        rows.push(row);
        if (l.wo) {
          const t = l.wo.truth!;
          truth.push({ sheet: sheetName, row: rows.length, kind: "WO", wonum: l.wo.wonum!, codeMode: t.codeMode, prob: t.prob, cause: t.cause, remedy: t.remedy, failurecodeMissing: t.codeMode !== "full" });
        } else if (l.fresh) {
          const f = l.fresh;
          truth.push({ sheet: sheetName, row: rows.length, kind: "NEW", prob: f.prob, cause: f.cause, remedy: f.remedy, failurecodeMissing: true, fresh: f });
        }
      }
      // 同じ日の行は日付のセルを結合（取り込むと 2 行目からは空になる）
      if (j - i > 1) merges.push(`A${first}:A${first + j - i - 1}`);
      i = j;
    }
    sheets.push({ name: sheetName, rows, merges, cols: [11, 6, 22, 18, 36, 8, 10], freeze: { row: 4 } });
  }
  return {
    id: "repair-log",
    fileName: c.L("修理記録_北部_2026年度上半期.xlsx", "Repair_log_North_FY2026_H1.xlsx"),
    title: c.L("修理記録（北部 2026年度上半期）", "Repair log (North, FY2026 H1)"),
    sheets,
    truth: { rows: truth },
  };
}

// ---------------------------------------------------------------------------
// 3'. 作業日報（日本語のデータ。北部 2026 年度上半期。A4 縦の帳票を 1 日 1 枚、月ごとのシートに縦に並べる）
//   - 常駐の委託業者（設備保守点検業務委託・年間）の日報: 平日は毎日、休日は修理のあった日だけ。
//     Maximo の是正・緊急保全（業者の無いもの）・予防保全の点検・巡視や清掃・Maximo に無い小さな修理が混ざる。
//   - 業者に発注した修繕（作業指示ごとの発注）は、その工事の日に別の日報（作業報告書）。工事名は発注一覧の件名と書き方が違う。
//   - 作業内容の文に、炉・設備・機器が通称や略語で紛れる。同じ修理が 2 行に分かれる（「同上」）ことも、行を足した日報もある。
// ---------------------------------------------------------------------------

/** 2026 年 4〜9 月の祝日・休日 */
const HOLIDAYS_2026 = new Set(["4-29", "5-3", "5-4", "5-5", "5-6", "7-20", "8-11", "9-21", "9-22", "9-23"]);
const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];
const RESIDENT_CONTRACT = "令和8年度 北部クリーンセンター 設備保守点検業務委託";
const RESIDENT_CONTRACT_VARIANTS = ["R8 北部CC 設備保守点検業務委託", "令和8年度 北部クリーンセンター設備保守点検業務", "令和８年度 北部クリーンセンター 設備保守点検業務委託"];
/** 常駐の委託業者（Maximo の業者には無い。作業者は Maximo の作業者として登録されている想定） */
const RESIDENT_VENDOR = "設備保守業者Ｃ 北部事業所";
/** 日報の行の数（足りない日は行を足す） */
const REPORT_LINES = 12;

/** Maximo に無い小さな修理（分類 → 不具合・処置・故障の正解） */
const NEW_REPAIRS: Record<string, Array<{ issue: string; act: string; prob: string; cause: string; remedy: string; hours: number }>> = {
  PUMP: [{ issue: "グランド部より漏れ", act: "グランド増締め", prob: "LEAK", cause: "LOOSE", remedy: "RETIGHT", hours: 0.5 }],
  FAN: [{ issue: "軸受部 異音", act: "グリース補給 経過観察", prob: "NOISE", cause: "LUBE", remedy: "LUBRIC", hours: 1.0 }],
  CONV: [{ issue: "ベルト蛇行", act: "テールプーリ 調整", prob: "MEANDER", cause: "MISALIGN", remedy: "ADJUST", hours: 1.5 }],
  CVALVE: [{ issue: "作動渋い", act: "グランド部 給油、作動確認", prob: "STUCK", cause: "LUBE", remedy: "LUBRIC", hours: 0.5 }],
  MOV: [{ issue: "開閉に時間かかる", act: "リミット 調整", prob: "MALFUNC", cause: "LINKAGE", remedy: "ADJUST", hours: 1.0 }],
  COMP: [{ issue: "ドレン排出不良", act: "オートドレン 分解清掃", prob: "CLOG", cause: "FOULED", remedy: "CLEAN", hours: 1.0 }],
  HVAC: [{ issue: "冷え悪い", act: "フィルタ清掃", prob: "LOWPERF", cause: "FOULED", remedy: "CLEAN", hours: 0.5 }],
  MOTOR: [{ issue: "端子箱カバー 緩み", act: "増締め", prob: "MALFUNC", cause: "LOOSE", remedy: "RETIGHT", hours: 0.5 }],
};
/** 英語の書き方（NEW_REPAIRS と同じ順） */
const NEW_REPAIRS_EN: Record<string, Array<{ issue: string[]; act: string[] }>> = {
  PUMP: [{ issue: ["gland leak", "leaking at gland", "gland weeping"], act: ["retightened gland", "gland nuts tightened"] }],
  FAN: [{ issue: ["bearing noise", "brg noisy", "noise at bearing"], act: ["greased, monitoring", "greased - keep an eye on it"] }],
  CONV: [{ issue: ["belt tracking off", "belt wandering", "belt off track"], act: ["adjusted tail pulley", "tail pulley adjusted"] }],
  CVALVE: [{ issue: ["sticking", "stiff operation", "valve sticky"], act: ["lubed gland, stroke checked", "greased gland - stroke OK"] }],
  MOV: [{ issue: ["slow to open/close", "slow stroke", "takes long to close"], act: ["adjusted limits", "limit switch adjusted"] }],
  COMP: [{ issue: ["drain not discharging", "auto drain blocked", "drain clogged"], act: ["auto drain stripped & cleaned", "cleaned auto drain"] }],
  HVAC: [{ issue: ["not cooling well", "poor cooling", "weak cooling"], act: ["filter cleaned", "cleaned filters"] }],
  MOTOR: [{ issue: ["terminal box cover loose", "TB cover loose", "loose terminal cover"], act: ["retightened", "screws tightened"] }],
};

/** Maximo に無い修理の候補の機器（北部、NEW_REPAIRS の分類） */
function freshPositions(data: PlantsData): Position[] {
  return data.truth.positions.filter((p) => p.site.siteid === "KITA" && NEW_REPAIRS[p.cls] !== undefined);
}

/**
 * Maximo に無い小さな修理（月に 4〜5 件、平日）の日・機器・不具合。
 * mr は new Rng(seedOf("excel-daily")).fork(`month-${月}`)。日英で同じものを引き、返した r で書き方を引く
 */
function planFresh(month: number, mr: Rng, positions: Position[]): Array<{ day: number; pos: Position; asset: Position["gens"][number]; tmpl: (typeof NEW_REPAIRS)[string][number]; r: Rng }> {
  const daysInMonth = new Date(Date.UTC(2026, month, 0)).getUTCDate();
  const out: Array<{ day: number; pos: Position; asset: Position["gens"][number]; tmpl: (typeof NEW_REPAIRS)[string][number]; r: Rng }> = [];
  for (let k = 0, n = mr.int(4, 5); k < n; k++) {
    const r = mr.fork(`new-${k}`);
    let day = r.int(1, daysInMonth);
    while (new Date(Date.UTC(2026, month - 1, day)).getUTCDay() % 6 === 0 || HOLIDAYS_2026.has(`${month}-${day}`)) day = (day % daysInMonth) + 1;
    const at = jst(2026, month, day, 10);
    const pos = r.pick(positions);
    const asset = pos.gens.find((a) => a.install <= at && (a.decom === null || a.decom > at) && !a.hidden);
    if (!asset) continue;
    const tmpl = r.pick(NEW_REPAIRS[pos.cls]!);
    out.push({ day, pos, asset, tmpl, r });
  }
  return out;
}

const MATERIALS: Record<string, string[]> = {
  REPLACE: ["ベアリング 6310ZZ ×2", "パッキン 一式", "メカニカルシール ×1", "Vベルト B-52 ×3", "ヒューズ ×2", "リミットスイッチ ×1"],
  LUBRIC: ["グリース（リチウム系）0.5kg", "グリース 1缶", "潤滑油 VG68 2L"],
  REPAIR: ["溶接棒 少量", "補修テープ", "シール剤"],
  RETIGHT: ["ウエス"],
  CLEAN: ["ウエス、洗浄剤"],
};
const ROUTINE_JA: Array<[string, string[]]> = [
  ["巡視点検", ["場内巡視 異常なし", "場内巡視（ボイラ・排ガス処理系統）異常なし", "朝礼・KY活動、場内巡視", "場内巡視 1号炉〜3号炉 異常なし"]],
  ["清掃", ["灰押出機まわり 清掃", "ごみピット投入扉まわり 清掃", "排水処理室 床清掃", "工作室 整理清掃"]],
  ["給油", ["コンベヤ類 定期給油", "クレーン 走行部 給油", "送風機類 給脂"]],
  ["打合せ", ["監督員と月間工程 打合せ", "定期整備の段取り 打合せ", "安全パトロール 同行"]],
];
const SPOT_WORK: Record<string, string> = { LEAK: "漏れに伴う修繕", VIB: "振動に伴う修繕", NOISE: "異音に伴う修繕", TRIP: "停止に伴う原因調査及び修繕", OVERHEAT: "温度上昇に伴う修繕" };
const SPOT_LEADS = ["高橋", "伊藤", "渡辺", "中村", "小林", "加藤"];

interface ReportLine {
  cat: string;
  text: string;
  hours: CellInput;
  crew: number | null;
  kind: "WO" | "NEW" | "PM" | "ROUTINE";
  wo?: WoDraft;
  pmWonum?: string;
  fresh?: NewRepairTruth;
}

/** 英語の修理記録の 1 行の正解 */
interface RepairRowTruth {
  sheet: string;
  row: number;
  kind: "WO" | "NEW";
  wonum?: string;
  codeMode?: string;
  prob: string;
  cause: string;
  remedy: string;
  failurecodeMissing: boolean;
  /** Maximo に無い修理（作業指示を作る先） */
  fresh?: NewRepairTruth;
}

interface NewRepairTruth {
  date: string;
  assetnum: string;
  location: string;
  description: string;
  prob: string;
  cause: string;
  remedy: string;
  hours: number;
}

interface DailyReport {
  day: number;
  spot: boolean;
  no: string;
  contract: string;
  vendorName: string;
  vendor: string | null;
  ponum: string | null;
  lead: string;
  crew: number;
  time: string;
  weather: string;
  writer: string;
  place: string;
  lines: ReportLine[];
  notes: string;
  materials: string;
}

export interface DailyRowTruth {
  sheet: string;
  row: number;
  report: string;
  date: string;
  contract: "RESIDENT" | "SPOT";
  contractName: string;
  kind: ReportLine["kind"];
  wonum?: string;
  ponum?: string;
  vendor?: string;
  codeMode?: string;
  prob?: string;
  cause?: string;
  remedy?: string;
  failurecodeMissing?: boolean;
  /** Maximo に無い修理（作業指示を作る先） */
  fresh?: NewRepairTruth;
}

function dailyReports(data: PlantsData): ExcelFile {
  const c = new Ctx(data);
  const tx = c.tx;
  const rng = new Rng(seedOf("excel-daily"));
  const dayOf = (iso: unknown): { m: number; d: number } | null => (typeof iso === "string" ? ymd(Date.parse(iso)) : null);
  const done = (w: WoDraft) => w.wonum !== undefined && (w.attrs.status === "COMP" || w.attrs.status === "CLOSE" || w.attrs.status === "INPRG");
  const repairs = data.truth.repairs.map((r) => r.wo).filter(done);
  const resident = repairs.filter((w) => !w.attrs.vendor);
  const spot = repairs.filter((w) => w.attrs.vendor && w.attrs.status !== "INPRG");
  // 予防保全・点検・校正（常駐の業者がしたもの）
  const pms = (data.tables.WORKORDER ?? [])
    .map((r) => r.attrs)
    .filter((a) => a.siteid === "KITA" && (a.worktype === "PM" || a.worktype === "INSP" || a.worktype === "CAL") && (a.status === "COMP" || a.status === "CLOSE") && !a.vendor && typeof a.actstart === "string" && a.actstart >= "2026-04" && a.actstart < "2026-10");
  const kitaPositions = freshPositions(data);

  /** 機器の書き方（炉の書き方・系統の名前・通称・号機の書き方が揺れる） */
  const equipText = (pos: Position, r: Rng): string => {
    let equip = c.bare(pos.desc);
    for (const [re, alts] of NICK_JA) if (re.test(equip)) equip = equip.replace(re, r.pick(alts));
    equip = equip
      .replace(/ ([A-Z])号機$/, (_m, x: string) => r.pick([` ${x}号機`, `(${x})`, ` ${x}`, `${x}号`]))
      .replace(/ No\.(\d+)$/, (_m, n: string) => r.pick([` No.${n}`, ` #${n}`, `${n}号`, ` ${n}`]));
    const line = pos.line > 0 ? r.pick([`${pos.line}号炉 `, `${pos.line}炉 `, `No.${pos.line} `, `#${pos.line} `, `${pos.line}号の`]) : r.pick(["", "共通 ", ""]);
    const sys = SYSTEMS.find((s) => s.code === pos.system)?.name;
    const sysText = sys && !line.endsWith("の") && r.chance(0.25) ? `${sys} ` : "";
    return `${line}${sysText}${equip}`.replace(/\s+/g, " ").trim();
  };
  const woEquip = (w: WoDraft, r: Rng): string => (w.asset ? equipText(w.asset.pos, r) : (w.locDesc ?? ""));
  const hoursOf = (h: number, r: Rng): CellInput => {
    const p = r.next();
    if (p < 0.85) return { v: Math.round(h * 2) / 2 || 0.5, s: "fNum" };
    if (p < 0.95) return { v: `${Math.round(h * 2) / 2 || 0.5}h`, s: "fCenter" };
    return { v: "半日", s: "fCenter" };
  };
  const dateText = (m: number, d: number, r: Rng): string => {
    const w = WEEKDAY_JA[new Date(Date.UTC(2026, m - 1, d)).getUTCDay()]!;
    const p = r.next();
    if (p < 0.85) return `令和8年${m}月${d}日（${w}）`;
    if (p < 0.95) return `R8.${m}.${d}`;
    return `${m}/${d}（${w}）`;
  };
  const weather = (m: number, r: Rng) => r.pick(m === 6 || m === 7 ? ["雨", "曇", "曇時々雨", "雨のち曇", "晴"] : ["晴", "晴", "曇", "晴のち曇", "雨"]);

  /** 是正・緊急保全の行（2 行に分かれることがある）。cap はその日の作業時間の上限 */
  const repairLines = (w: WoDraft, r: Rng, cap: number): ReportLine[] => {
    const t = w.truth!;
    const equip = woEquip(w, r);
    const issue = r.pick(PROB_JA[t.prob] ?? [tx.t(PROBLEMS[t.prob]!)]);
    const cause = tx.t(CAUSES[t.cause] ?? "");
    const remedy = tx.t(REMEDIES[t.remedy] ?? "");
    const cat = w.attrs.worktype === "EM" ? "緊急対応" : r.pick(["故障修理", "修理", "不具合対応"]);
    const crew = r.int(1, 3);
    const hrs = Math.min(cap, Number(w.attrs.actlabhrs ?? 0) / crew || Number(w.attrs.estdur ?? 2));
    const contact = w.sr && r.chance(0.3) ? "（運転員より連絡）" : "";
    if (w.attrs.status === "INPRG") return [{ cat, text: `${equip} ${issue}${contact} 応急処置、部品手配中`, hours: hoursOf(hrs, r), crew, kind: "WO", wo: w }];
    const action = r.pick([`${cause}のため${remedy}`, `${remedy}（${cause}）`, `→ ${remedy}`]);
    if (r.chance(0.2)) {
      return [
        { cat, text: `${equip} ${issue}${contact} 点検`, hours: hoursOf(hrs / 2, r), crew, kind: "WO", wo: w },
        { cat: "〃", text: `同上 ${action}`, hours: hoursOf(hrs / 2, r), crew, kind: "WO", wo: w },
      ];
    }
    return [{ cat, text: `${equip} ${issue}${contact} ${action}`, hours: hoursOf(hrs, r), crew, kind: "WO", wo: w }];
  };

  const sheets: SheetSpec[] = [];
  const truth: DailyRowTruth[] = [];
  const reportCounts: Record<string, number> = {};
  for (let month = 4; month <= 9; month++) {
    const sheetName = `${month}月`;
    const mr = rng.fork(`month-${month}`);
    const daysInMonth = new Date(Date.UTC(2026, month, 0)).getUTCDate();
    // Maximo に無い修理（月に 4〜5 件、平日）
    const fresh = new Map<number, ReportLine[]>();
    for (const { day, pos, asset, tmpl, r } of planFresh(month, mr, kitaPositions)) {
      const equip = equipText(pos, r);
      const line: ReportLine = {
        cat: r.pick(["修理", "補修", "不具合対応"]), text: `${equip} ${tmpl.issue} ${tmpl.act}`, hours: hoursOf(tmpl.hours, r), crew: r.int(1, 2), kind: "NEW",
        fresh: { date: `2026-${pad(month, 2)}-${pad(day, 2)}`, assetnum: asset.assetnum, location: asset.location, description: `${pos.descJa} ${tmpl.issue}`, prob: tmpl.prob, cause: tmpl.cause, remedy: tmpl.remedy, hours: tmpl.hours },
      };
      fresh.set(day, [...(fresh.get(day) ?? []), line]);
    }

    const reports: DailyReport[] = [];
    let seq = 0;
    for (let day = 1; day <= daysInMonth; day++) {
      const r = mr.fork(`day-${day}`);
      const workday = new Date(Date.UTC(2026, month - 1, day)).getUTCDay() % 6 !== 0 && !HOLIDAYS_2026.has(`${month}-${day}`);
      const fixes = resident.filter((w) => { const d = dayOf(w.attrs.actstart); return d !== null && d.m === month && d.d === day; }).sort((a, b) => a.wonum!.localeCompare(b.wonum!));
      const news = fresh.get(day) ?? [];
      if (workday || fixes.length > 0 || news.length > 0) {
        const lines: ReportLine[] = [];
        if (workday) lines.push(routineLine(0, r));
        const todays = pms.filter((a) => (a.actstart as string).startsWith(`2026-${pad(month, 2)}-${pad(day, 2)}`)).sort((a, b) => String(a.wonum).localeCompare(String(b.wonum)));
        const cap = workday ? 7.5 : 4.5;
        for (const a of todays.slice(0, workday ? r.int(1, 2) : 0)) {
          const cat = a.worktype === "CAL" ? "校正" : a.worktype === "INSP" ? "点検" : "定期点検";
          const text = String(a.description).replace(/（\d+か?(月|年|週)）$/, r.chance(0.5) ? "" : "$&").replace(/^(\d)号炉 /, (_m, n: string) => r.pick([`${n}号炉 `, `${n}炉 `, `#${n} `]));
          const crew = r.int(1, 2);
          lines.push({ cat, text, hours: hoursOf(Math.min(4, Number(a.actlabhrs ?? 1) / crew || 1), r), crew, kind: "PM", pmWonum: String(a.wonum) });
        }
        for (const w of fixes) lines.push(...repairLines(w, r.fork(w.wonum!), cap));
        lines.push(...news);
        if (workday && r.chance(0.6)) lines.push(routineLine(r.int(1, 3), r));
        // 前の行と同じ作業区分は「〃」と書く
        for (let i = 1; i < lines.length; i++) if (lines[i]!.cat === lines[i - 1]!.cat && r.chance(0.6)) lines[i] = { ...lines[i]!, cat: "〃" };
        const lead = fixes.map((w) => c.person(typeof w.attrs.lead === "string" ? w.attrs.lead : null)?.last).find(Boolean) ?? r.pick(["佐藤", "鈴木", "田中"]);
        const em = fixes.some((w) => w.attrs.worktype === "EM");
        const pending = fixes.find((w) => w.attrs.status === "INPRG");
        const watch = fixes.find((w) => w.truth && (w.truth.remedy === "TEMP" || w.truth.remedy === "NOACTION"));
        const remedies = fixes.map((w) => w.truth?.remedy ?? "").filter((x) => MATERIALS[x]);
        seq++;
        reports.push({
          day, spot: false, no: `${month}-${pad(seq, 2)}`, contract: r.chance(0.9) ? RESIDENT_CONTRACT : r.pick(RESIDENT_CONTRACT_VARIANTS), vendorName: RESIDENT_VENDOR, vendor: null, ponum: null,
          lead, crew: workday ? r.int(3, 6) : Math.min(5, Math.max(2, fixes.length)),
          time: workday ? (em ? "8:30〜19:30" : r.pick(["8:30〜17:15", "8:30〜17:15", "8:30〜17:00"])) : fixes.length >= 3 ? "8:30〜17:15" : r.pick(["9:00〜15:00", "10:00〜14:30"]),
          weather: weather(month, r), writer: lead, place: r.pick(["場内一円", "場内一円", "工場棟"]), lines,
          notes: pending ? `${woEquip(pending, r)} 部品手配中。入荷後に交換予定。` : watch ? `${woEquip(watch, r)} 経過観察とする。` : r.pick(["特になし", "", "引継ぎ事項なし"]),
          materials: remedies.length > 0 ? [...new Set(remedies.map((x) => r.pick(MATERIALS[x]!)))].join("、") : r.pick(["", "ウエス", "—"]),
        });
      }
      // 業者に発注した修繕: その工事の日に別の日報
      for (const w of spot.filter((x) => { const d = dayOf(x.attrs.actstart); return d !== null && d.m === month && d.d === day; }).sort((a, b) => a.wonum!.localeCompare(b.wonum!))) {
        const s = r.fork(`spot-${w.wonum}`);
        const t = w.truth!;
        const equip = woEquip(w, s);
        const issue = s.pick(PROB_JA[t.prob] ?? [tx.t(PROBLEMS[t.prob]!)]);
        const cause = tx.t(CAUSES[t.cause] ?? "");
        const remedy = tx.t(REMEDIES[t.remedy] ?? "");
        const pos = w.asset?.pos;
        const contract = `${s.chance(0.5) ? "北部クリーンセンター " : s.chance(0.5) ? "北部CC " : ""}${pos ? `${pos.line > 0 ? `${pos.line}号炉` : ""}${c.bare(pos.desc).replace(/ [A-Z]号機$| No\.\d+$/, "")}` : (w.locDesc ?? "")} ${SPOT_WORK[t.prob] ?? "修繕"}`.replace(/\s+/g, " ").trim();
        const crew = s.int(2, 4);
        const hrs = Math.min(6, Number(w.attrs.actlabhrs ?? 0) / crew || Number(w.attrs.estdur ?? 4));
        const lines: ReportLine[] = [
          { cat: "準備", text: s.pick(["準備・養生", "KY活動、養生", "仮設足場・養生"]), hours: hoursOf(0.5, s), crew, kind: "WO", wo: w },
          { cat: "点検", text: `${equip} ${issue} 原因調査・分解点検`, hours: hoursOf(hrs * 0.4, s), crew, kind: "WO", wo: w },
          { cat: "修繕", text: `${cause}のため${remedy}`, hours: hoursOf(hrs * 0.4, s), crew, kind: "WO", wo: w },
          { cat: "試運転", text: s.pick(["試運転・復旧確認 異常なし", "復旧後 試運転確認 良好", "試運転 振動・温度 異常なし"]), hours: hoursOf(0.5, s), crew, kind: "WO", wo: w },
        ];
        if (s.chance(0.5)) lines.push({ cat: "片付け", text: "片付け・清掃", hours: hoursOf(0.5, s), crew, kind: "WO", wo: w });
        const finish = dayOf(w.attrs.actfinish);
        reports.push({
          day, spot: true, no: `修-${month}${pad(day, 2)}-${w.wonum!.slice(-2)}`, contract, vendorName: c.companyVariant(String(w.attrs.vendor), s), vendor: String(w.attrs.vendor), ponum: w.order?.ponum ?? null,
          lead: s.pick(SPOT_LEADS), crew, time: s.pick(["8:30〜17:00", "9:00〜16:30", "8:00〜17:00"]), weather: weather(month, s), writer: s.pick(SPOT_LEADS), place: equip, lines,
          notes: finish !== null && (finish.m !== month || finish.d !== day) ? `工期 ${month}/${day}〜${finish.m}/${finish.d}。翌日も継続。` : s.pick(["工事完了。監督員立会いにて試運転確認済み。", "工事完了。", "完了。報告書は後日提出。"]),
          materials: MATERIALS[t.remedy] ? s.pick(MATERIALS[t.remedy]!) : "",
        });
      }
    }
    reportCounts[sheetName] = reports.length;

    // ---- 帳票を並べる（1 枚 = A4 縦 1 ページ） ----
    const rows: CellInput[][] = [];
    const merges: string[] = [];
    const heights: Record<number, number> = {};
    const breaks: number[] = [];
    const F = (v: string | number | null, s: CellSpec["s"] = "fCell"): CellSpec => ({ v, s });
    const put = (r: number, col: number, spec: CellInput) => {
      while (rows.length <= r) rows.push([]);
      const row = rows[r]!;
      while (row.length < col) row.push(undefined);
      row[col] = spec;
    };
    /** 結合して、範囲のすべてのセルに書式を付ける（罫線を引くため） */
    const box = (r1: number, c1: number, r2: number, c2: number, spec: CellSpec) => {
      for (let r = r1; r <= r2; r++) for (let k = c1; k <= c2; k++) put(r, k, r === r1 && k === c1 ? spec : { v: null, s: spec.s });
      if (r1 !== r2 || c1 !== c2) merges.push(`${colName(c1)}${r1 + 1}:${colName(c2)}${r2 + 1}`);
    };
    for (const rep of reports) {
      const b = rows.length;
      put(b, 0, F("北部クリーンセンター", "fSmall"));
      box(b, 2, b, 4, F(rep.spot ? "作 業 報 告 書" : "作　業　日　報", "fTitle"));
      put(b, 5, F("監督員", "fLabel"));
      put(b, 6, F("係長", "fLabel"));
      put(b, 7, F(rep.spot ? "現場代理人" : "担当", "fLabel"));
      heights[b + 1] = 30;
      put(b + 1, 0, F(`No. ${rep.no}`, "fSmall"));
      for (let k = 5; k <= 7; k++) put(b + 1, k, F(null, "fCenter"));
      heights[b + 2] = 34;
      heights[b + 3] = 6;
      box(b + 3, 0, b + 3, 1, F("委託契約工事名", "fLabel"));
      box(b + 3, 2, b + 3, 7, F(rep.contract));
      box(b + 4, 0, b + 4, 1, F("受注者", "fLabel"));
      box(b + 4, 2, b + 4, 4, F(rep.vendorName));
      put(b + 4, 5, F("作業日", "fLabel"));
      box(b + 4, 6, b + 4, 7, F(dateText(month, rep.day, rng.fork(`date-${rep.no}`)), "fCenter"));
      box(b + 5, 0, b + 5, 1, F("作業責任者", "fLabel"));
      put(b + 5, 2, F(rep.lead, "fCenter"));
      put(b + 5, 3, F("作業員", "fLabel"));
      put(b + 5, 4, F(`${rep.crew} 名`, "fCenter"));
      put(b + 5, 5, F("作業時間", "fLabel"));
      box(b + 5, 6, b + 5, 7, F(rep.time, "fCenter"));
      box(b + 6, 0, b + 6, 1, F("天候", "fLabel"));
      put(b + 6, 2, F(rep.weather, "fCenter"));
      put(b + 6, 3, F("記入者", "fLabel"));
      put(b + 6, 4, F(rep.writer, "fCenter"));
      put(b + 6, 5, F("作業場所", "fLabel"));
      box(b + 6, 6, b + 6, 7, F(rep.place, "fCenter"));
      for (let k = 3; k <= 6; k++) heights[b + k + 1] = 22;
      heights[b + 8] = 6;
      const h = b + 8;
      put(h, 0, F("No.", "fHead"));
      put(h, 1, F("作業区分", "fHead"));
      box(h, 2, h, 5, F("作業内容", "fHead"));
      put(h, 6, F("時間", "fHead"));
      put(h, 7, F("人員", "fHead"));
      heights[h + 1] = 22;
      const n = Math.max(REPORT_LINES, rep.lines.length);
      for (let i = 0; i < n; i++) {
        const l = rep.lines[i];
        const r = h + 1 + i;
        put(r, 0, F(l ? i + 1 : null, "fCenter"));
        put(r, 1, F(l ? l.cat : null, "fCenter"));
        box(r, 2, r, 5, F(l ? l.text : null, "fWrap"));
        put(r, 6, l ? l.hours ?? F(null, "fCenter") : F(null, "fCenter"));
        put(r, 7, F(l?.crew ?? null, "fCenter"));
        heights[r + 1] = 28;
        if (!l) continue;
        const w = l.wo;
        const t = w?.truth;
        truth.push({
          sheet: sheetName, row: r + 1, report: rep.no, date: `2026-${pad(month, 2)}-${pad(rep.day, 2)}`, contract: rep.spot ? "SPOT" : "RESIDENT", contractName: rep.contract, kind: l.kind,
          ...(w ? { wonum: w.wonum! } : l.pmWonum ? { wonum: l.pmWonum } : {}),
          ...(rep.spot && rep.ponum ? { ponum: rep.ponum } : {}), ...(rep.spot && rep.vendor ? { vendor: rep.vendor } : {}),
          ...(t ? { codeMode: t.codeMode, prob: t.prob, cause: t.cause, remedy: t.remedy, failurecodeMissing: t.codeMode !== "full" } : {}),
          ...(l.fresh ? { fresh: l.fresh, prob: l.fresh.prob, cause: l.fresh.cause, remedy: l.fresh.remedy, failurecodeMissing: true } : {}),
        });
      }
      const s0 = h + 1 + n + 1;
      heights[s0] = 6;
      box(s0, 0, s0 + 2, 1, F("特記事項\n引継ぎ", "fLabel"));
      box(s0, 2, s0 + 2, 7, F(rep.notes || null, "fWrap"));
      for (let k = 0; k < 3; k++) heights[s0 + k + 1] = 20;
      box(s0 + 3, 0, s0 + 3, 1, F("使用材料", "fLabel"));
      box(s0 + 3, 2, s0 + 3, 7, F(rep.materials || null, "fWrap"));
      heights[s0 + 4] = 22;
      breaks.push(s0 + 4);
      heights[s0 + 5] = 10;
      rows[s0 + 4] = [];
    }
    sheets.push({ name: sheetName, rows, merges, cols: [5, 10, 12, 12, 12, 11, 9, 9], rowHeights: heights, print: { breaks: breaks.slice(0, -1), footer: "&A　&P / &N" } });
  }
  return {
    id: "repair-log",
    fileName: "作業日報_北部_2026年度上半期.xlsx",
    title: "作業日報（北部 2026年度上半期）",
    sheets,
    truth: { rows: truth, reports: reportCounts },
  };

  /** 巡視・清掃・給油・打合せの行 */
  function routineLine(kind: number, r: Rng): ReportLine {
    const [cat, texts] = ROUTINE_JA[kind]!;
    return { cat, text: r.pick(texts), hours: hoursOf(kind === 0 ? 1 : r.pick([0.5, 1, 1.5, 2]), r), crew: r.int(1, 3), kind: "ROUTINE" };
  }
}

// ---------------------------------------------------------------------------
// 4. 東部の機器台帳（Maximo より先に進んだ）
// ---------------------------------------------------------------------------

function mainSpec(a: Asset, c: Ctx, override?: [string, number, number]): string {
  const rows = a.specsTrue ?? [];
  const num = (attr: string) => {
    if (override && override[0] === attr) return override[2];
    const v = rows.find((r) => r.assetattrid === attr)?.numvalue;
    return typeof v === "number" ? v : null;
  };
  switch (a.pos.cls) {
    case "MOTOR": return [num("RATED_POWER") !== null ? `${num("RATED_POWER")}kW` : "", num("POLES") !== null ? `${num("POLES")}P` : "", num("RATED_VOLTAGE") !== null ? `${num("RATED_VOLTAGE")}V` : ""].filter(Boolean).join(" ");
    case "PUMP": return c.L(`流量 ${num("FLOW") ?? "-"}m3/h 揚程 ${num("HEAD") ?? "-"}m`, `Flow ${num("FLOW") ?? "-"} m3/h, head ${num("HEAD") ?? "-"} m`);
    case "FAN": return c.L(`風量 ${num("AIRFLOW") ?? "-"}m3/min`, `Air flow ${num("AIRFLOW") ?? "-"} m3/min`);
    case "INV": return num("RATED_KVA") !== null ? `${num("RATED_KVA")}kVA` : "";
    case "HVAC": return c.L(`冷房 ${num("COOL_KW") ?? "-"}kW`, `Cooling ${num("COOL_KW") ?? "-"} kW`);
    default: return "";
  }
}

export function ledger(data: PlantsData): ExcelFile {
  const c = new Ctx(data);
  const tx = c.tx;
  const ja = c.lang === "ja";
  const rng = new Rng(seedOf("excel-ledger"));
  const drift = data.truth.ledger;
  const byAsset = new Map<Asset, (typeof drift)[number]>();
  for (const x of drift) byAsset.set(x.asset, x);
  const replacedOld = new Set(drift.filter((x) => x.kind === "REPLACED").map((x) => x.old!));
  const positions = data.truth.positions.filter((p) => p.site.siteid === "HIGASHI" && p.gens.length > 0);
  const rows: CellInput[][] = [
    [{ v: c.L("東部クリーンセンター 機器台帳（現場管理用）", "East Clean Center Equipment Register (site copy)"), s: "title" }],
    [{ v: c.L("最終更新 2026/9/12 ※Maximo とは別に現場で更新しているもの", "Last updated 2026-09-12. Maintained on site, separately from Maximo."), s: "note" }],
    [],
    (ja ? ["機器番号", "機器名称", "炉", "系統", "メーカー", "型式", "製造番号", "設置日", "主要仕様", "状態", "更新日", "備考"]
      : ["Tag", "Equipment", "Line", "System", "Manufacturer", "Model", "Serial no.", "Installed", "Key specs", "Status", "Updated", "Remarks"]).map(head),
  ];
  const truth: Array<{ row: number; kind: string; assetnum: string | null; maximoAssetnum: string | null; tag: string; date: string | null }> = [];
  const sorted = [...positions].sort((a, b) => a.loc.localeCompare(b.loc) || a.tag.localeCompare(b.tag));
  for (const pos of sorted) {
    // 今その位置にある資産（台帳だけにある新しい資産を含む）
    const a = pos.gens[pos.gens.length - 1]!;
    if (a.decom !== null || replacedOld.has(a)) continue;
    const r = rng.fork(a.assetnum);
    const x = byAsset.get(a);
    const kind = x?.kind ?? "SAME";
    const model = (a.specsTrue ?? []).find((s) => s.assetattrid === "MODEL")?.alnvalue ?? "";
    const updated = x ? x.date : jst(r.int(2021, 2024), r.int(1, 12), r.int(1, 28));
    const serial = kind === "MAXIMO_NEWER" ? x!.oldSerial! : (a.serialTrue ?? "");
    const remark = (() => {
      const { y, m } = ymd(x?.date ?? 0);
      switch (kind) {
        case "REPLACED": return c.L(`${y}/${m} 更新（旧品撤去）`, `Replaced ${y}-${pad(m, 2)} (old unit removed)`);
        case "ADDED": return c.L(`${y}/${m} 増設`, `Added ${y}-${pad(m, 2)}`);
        case "SPEC_CHANGED": return c.L(`${y}/${m} 羽根車外径変更`, `Impeller trimmed ${y}-${pad(m, 2)}`);
        case "RENAMED": return c.L(`${y}/${m} 名称変更`, `Renamed ${y}-${pad(m, 2)}`);
        case "REMOVED": return c.L(`${y}/${m} 撤去`, `Removed ${y}-${pad(m, 2)}`);
        default: return "";
      }
    })();
    const rowIndex = rows.length + 1;
    rows.push([
      cell(pos.tag), cell(kind === "RENAMED" ? c.bare(x!.newDesc!) : c.bare(pos.desc)), cell(pos.line === 0 ? c.L("共通", "Common") : String(pos.line)), cell(tx.t(SYSTEMS_BY_CODE.get(pos.system) ?? "")),
      cell(a.makerTrue ? c.company(a.makerTrue) : ""), cell(typeof model === "string" ? model : ""), cell(serial), { v: a.install, s: "date", date: true }, cell(mainSpec(a, c, x?.spec)),
      cell(kind === "REMOVED" ? c.L("撤去", "Removed") : c.L("稼働", "In service")), { v: updated, s: "date", date: true }, { v: remark, s: "wrap" },
    ]);
    truth.push({
      row: rowIndex, kind, assetnum: a.assetnum, maximoAssetnum: kind === "ADDED" ? null : kind === "REPLACED" ? x!.old!.assetnum : a.assetnum, tag: pos.tag, date: x ? isoDay(x.date) : null,
    });
  }
  return {
    id: "east-register",
    fileName: c.L("機器台帳_東部_現場管理.xlsx", "Equipment_register_East_site_copy.xlsx"),
    title: c.L("東部の機器台帳（Maximo より新しい）", "East equipment register (ahead of Maximo)"),
    sheets: [{ name: c.L("機器台帳", "Register"), rows, merges: ["A1:L1", "A2:L2"], cols: [13, 34, 6, 22, 22, 12, 14, 11, 26, 9, 11, 26], freeze: { row: 5, col: 3 } }],
    truth: { rows: truth },
  };
}

// ---------------------------------------------------------------------------
// 5. 星取表（北部・南部、Maximo を入れる前）
// ---------------------------------------------------------------------------

const STAR_CLASSES = new Set(["PUMP", "FAN", "COMP", "CONV", "CRANE", "GRATE", "FEEDER", "TURBINE", "GEN", "BOILER", "BAGF", "SCR", "TRANSF", "EGEN", "ANLZ", "DCS", "ELEV", "WBRIDGE", "HYDU", "TOWER", "MIXER"]);
const OH_JPS = new Set(["PUMP-OH", "COMP-OH", "FAN-OH", "GRAB-OH", "GRATE-OH", "REFR-OH", "TURB-4Y", "HEX-2Y"]);

/** 出来事 → 星取表の印（月例・3 か月ごとの点検は載せない） */
function symbolOf(e: HistoryEvent): string | null {
  if (e.kind === "CP") return "●";
  if (e.kind === "CM" || e.kind === "EM") return "△";
  if (e.jp && OH_JPS.has(e.jp)) return e.law ? "◎★" : "◎";
  const prog = PM_PROGRAMS.find((p) => p.jp === e.jp);
  if (!prog) return null;
  const months = prog.unit === "YEARS" ? prog.freq * 12 : prog.freq;
  if (months < 6) return null;
  return prog.law ? "★" : "○";
}

const ORDER = ["●", "◎", "★", "○", "△"];

export function starChart(data: PlantsData): ExcelFile {
  const c = new Ctx(data);
  const tx = c.tx;
  const ja = c.lang === "ja";
  const rng = new Rng(seedOf("excel-starchart"));
  const sheets: SheetSpec[] = [];
  const truth: Array<{ sheet: string; row: number; fy: number; col: string; symbols: string; locs: string[]; assetnums: string[]; events: Array<{ loc: string; assetnum: string; kind: string; jp: string | null; date: string; symbol: string }> }> = [];
  const events = data.truth.history;
  const byLoc = new Map<string, HistoryEvent[]>();
  for (const e of events) {
    const k = `${e.site}|${e.loc}`;
    if (!byLoc.has(k)) byLoc.set(k, []);
    byLoc.get(k)!.push(e);
  }
  for (const site of ["KITA", "MINAMI"] as SiteCode[]) {
    const s = SITES.find((x) => x.siteid === site)!;
    const goLive = data.truth.goLive[site]!;
    const fyFrom = s.start.m >= 4 ? s.start.y : s.start.y - 1;
    const fyTo = fy(goLive - DAY);
    const years: number[] = [];
    for (let y = fyFrom; y <= fyTo; y++) years.push(y);
    // 機器の行（A/B 号機は 1 行にまとめる）
    const positions = data.truth.positions.filter((p) => p.site.siteid === site && !p.child && STAR_CLASSES.has(p.cls) && !p.added);
    const groups = new Map<string, Position[]>();
    for (const p of positions) {
      const key = p.item?.ab ? `${p.unitLoc}|${p.item.n}|${p.tag.replace(/[A-Z]$/, "")}` : p.loc;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }
    const bySystem = new Map<string, Position[][]>();
    for (const g of groups.values()) {
      const sys = g[0]!.system;
      if (!bySystem.has(sys)) bySystem.set(sys, []);
      bySystem.get(sys)!.push(g);
    }
    for (const [sys, list] of [...bySystem.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const sysName = tx.t(SYSTEMS_BY_CODE.get(sys)!);
      const sheetName = c.L(`${c.siteShort(site).replace("CC", "")} ${sysName}`, `${c.siteShort(site).replace(" CC", "")} ${sysName}`).slice(0, 31);
      const lastCol = 7 + years.length;
      const rows: CellInput[][] = [
        [{ v: c.L(`${c.site(site)} 設備保全履歴（星取表） ${sysName} ${wareki(years[0]!, 4).long.replace("4月", "")}度〜${wareki(years[years.length - 1]!, 4).long.replace("4月", "")}度`, `${c.site(site)} maintenance history (star chart) - ${sysName} FY${years[0]}-FY${years[years.length - 1]}`), s: "title" }],
        [{ v: c.L("凡例: ○点検 ◎分解整備 ●更新 △補修 ★法定検査　（予定は計画、実績は実施）", "Legend: ○ inspection  ◎ overhaul  ● replacement  △ repair  ★ statutory inspection  (Plan / Actual)"), s: "note" }],
        [],
        [head("No."), head(c.L("設備", "Unit")), head(c.L("機器名称", "Equipment")), head(c.L("機器番号", "Tag")), head(c.L("数量", "Qty")), head(c.L("耐用年数", "Life (yrs)")),
          head(c.L("区分", "Row")), head(c.L("年度", "FY")), ...years.slice(1).map(() => head("")), head(c.L("備考", "Remarks"))],
        [null, null, null, null, null, null, null, ...years.map((y) => head(ja ? wareki(y, 4).short.replace(/\.4$/, "") : `FY${String(y).slice(2)}`))],
        [null, null, null, null, null, null, null, ...years.map((y) => ({ v: y, s: "center" } as CellSpec))],
      ];
      const merges = [`A1:${colLetter(lastCol)}1`, `A2:${colLetter(lastCol)}2`, `H4:${colLetter(7 + years.length - 1)}4`];
      // 年度の列は H から（No, 設備, 機器名称, 機器番号, 数量, 耐用年数, 区分 = A〜G）
      let no = 0;
      const sortedGroups = list.sort((a, b) => a[0]!.unitLoc.localeCompare(b[0]!.unitLoc) || a[0]!.tag.localeCompare(b[0]!.tag));
      let unitStart = -1;
      let unitName = "";
      for (const g of sortedGroups) {
        const p0 = g[0]!;
        const uName = c.bare(tx.sp(c.lineName(p0.line), tx.t(SYSTEM_UNIT_NAME.get(`${p0.system}|${p0.unit}`) ?? "")));
        const unitLabel = p0.line === 0 ? uName : `${c.lineName(p0.line)} ${uName}`;
        const name = g.length > 1 ? c.bare(p0.desc).replace(/ [AB]号機$/, "").replace(/ A$/, "") : c.bare(p0.desc);
        const tag = g.length > 1 ? `${p0.tag.replace(/[A-Z]$/, "")}${g.map((p) => p.tag.slice(-1)).join("/")}` : p0.tag;
        const life = CLASS_LIFE.get(p0.cls);
        no++;
        const planRow: CellInput[] = [cell(no), cell(unitLabel), cell(name), cell(tag), cell(g.length), cell(life ? c.L(`${life[0]}〜${life[1]}`, `${life[0]}-${life[1]}`) : ""), cell(c.L("予定", "Plan"))];
        const actRow: CellInput[] = [cell(null), cell(null), cell(null), cell(null), cell(null), cell(null), cell(c.L("実績", "Actual"))];
        const r = rng.fork(tag + site);
        const remarks: string[] = [];
        for (const y of years) {
          // 子の資産（電動機など）の出来事は載せない（同じ場所でも分類が違う）
          const evs = g.flatMap((p) => (byLoc.get(`${site}|${p.loc}`) ?? []).filter((e) => e.cls === p.cls).map((e) => ({ e, p }))).filter(({ e }) => fy(e.date) === y);
          const plan = new Set<string>();
          const act = new Map<string, Array<{ e: HistoryEvent; p: Position }>>();
          for (const x of evs) {
            const sym = symbolOf(x.e);
            if (!sym) continue;
            if (x.e.kind !== "CM" && x.e.kind !== "EM") plan.add(sym);
            if (!x.e.planned) {
              if (!act.has(sym)) act.set(sym, []);
              act.get(sym)!.push(x);
            }
          }
          const order = (set: Iterable<string>) => [...new Set([...set].join("").split(""))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).join("");
          planRow.push({ v: order(plan) || null, s: "center" });
          let actText = order(act.keys());
          // 注記: 片方の号機だけ・月・部位
          if (actText && g.length > 1) {
            const units = new Set([...act.values()].flat().map((x) => x.p.tag.slice(-1)));
            if (units.size === 1 && r.chance(0.6)) actText += `(${[...units][0]})`;
          } else if (actText.includes("◎") && r.chance(0.25)) {
            const oh = [...(act.get("◎") ?? act.get("◎★") ?? [])][0];
            if (oh) actText += ja ? `(${ymd(oh.e.date).m}月)` : `(${tx.monthName(ymd(oh.e.date).m)})`;
          }
          actRow.push({ v: actText || null, s: "center" });
          if (actText) {
            truth.push({
              sheet: sheetName, row: rows.length + 2, fy: y, col: colLetter(7 + years.indexOf(y)), symbols: order(act.keys()),
              locs: g.map((p) => p.loc), assetnums: [...new Set([...act.values()].flat().map((x) => x.e.assetnum))],
              events: [...act.entries()].flatMap(([sym, xs]) => xs.map((x) => ({ loc: x.p.loc, assetnum: x.e.assetnum, kind: x.e.kind, jp: x.e.jp, date: isoDay(x.e.date)!, symbol: sym }))),
            });
          }
          if (act.has("●") && g.length > 1 && r.chance(0.3)) remarks.push(c.L(`${wareki(y, 4).short.replace(/\.4$/, "")} ${[...new Set(act.get("●")!.map((x) => x.p.tag.slice(-1)))].join("・")}号機更新`, `FY${y}: unit ${[...new Set(act.get("●")!.map((x) => x.p.tag.slice(-1)))].join("/")} replaced`));
        }
        planRow.push(cell(""));
        actRow.push({ v: remarks.join(" "), s: "wrap" });
        const startRow = rows.length + 1;
        rows.push(planRow, actRow);
        for (const col of ["A", "C", "D", "E", "F"]) merges.push(`${col}${startRow}:${col}${startRow + 1}`);
        // 設備の列は同じ装置の行をまとめて結合（取り込むと 2 行目から空になる）
        if (unitName !== unitLabel) {
          if (unitStart > 0 && startRow - 1 > unitStart) merges.push(`B${unitStart}:B${startRow - 1}`);
          unitStart = startRow;
          unitName = unitLabel;
          rows[startRow - 1]![1] = cell(unitLabel);
        } else {
          rows[startRow - 1]![1] = cell(null);
        }
      }
      if (unitStart > 0 && rows.length > unitStart) merges.push(`B${unitStart}:B${rows.length}`);
      sheets.push({ name: sheetName, rows, merges, cols: [5, 22, 26, 16, 5, 9, 7, ...years.map(() => 9), 22], freeze: { row: 7, col: 8 } });
    }
  }
  return {
    id: "star-chart",
    fileName: c.L("星取表_北部南部_Maximo導入前.xlsx", "Star_chart_North_South_before_Maximo.xlsx"),
    title: c.L("星取表（北部・南部、Maximo 導入前の保全履歴）", "Star chart (North / South maintenance history before Maximo)"),
    sheets,
    truth: { rows: truth },
  };
}

function colLetter(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const SYSTEMS_BY_CODE = new Map(SYSTEMS.map((s) => [s.code, s.name]));
const SYSTEM_UNIT_NAME = new Map(SYSTEMS.flatMap((s) => s.units.map((u) => [`${s.code}|${u.code}`, u.name] as [string, string])));
const CLASS_LIFE = new Map(CLASSES.filter((x) => x.life).map((x) => [x.id, x.life!] as [string, [number, number]]));

/** 5 種すべて */
export function allExcel(data: PlantsData): ExcelFile[] {
  return [purchaseOrders(data), legacyRegister(data), repairLog(data), ledger(data), starChart(data)];
}
