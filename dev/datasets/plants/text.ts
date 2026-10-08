// 出力の言語（日本語・英語）。ジェネレータは判定をすべて日本語の正本（catalog.ts）で行い、表に書き出す文だけをここで言語にする。
// 同じ種なら日英で同じ乱数を引くように、言語ごとの候補の配列は同じ長さにそろえる（tests/dev/plants-v2.test.ts が確かめる）。

import { EN, EN_GIVEN_NAMES, EN_SURNAMES } from "./en.ts";
import { GIVEN_NAMES, SURNAMES } from "./catalog.ts";
import { pad, toFullWidth, toHalfKana, type Rng } from "./util.ts";

export type Lang = "ja" | "en";

const JP = /[　-ヿ一-鿿＀-￯]/;

/** 日本語の文字を含むか（英語の出力にこれが残っていれば訳し漏れ） */
export function hasJapanese(s: string): boolean {
  return JP.test(s);
}

/** 1 ドル = 150 円で換算する（英語版の金額） */
export const JPY_PER_USD = 150;

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---- 運転員の連絡（SR）の言い回し。日英で同じ数にそろえる ----

const SR_PHRASES_JA: Record<string, string[]> = {
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
  DPHIGH: ["の差圧が上がっています。"],
  DRIFT: ["の指示がおかしいです。", "の値がふらつきます。", "の指示が現場と合いません。"],
  INSUL: ["の絶縁が下がっています。"],
  DAMAGE: ["が焼損しています。", "が壊れています。"],
  ALARM: ["の警報が出ています。", "で異常警報が出ました。"],
  NOSIGNAL: ["の信号が来ていません。", "が中央で表示されません。"],
};

/** 英語の言い回し（{a} に機器の名前が入る） */
const SR_PHRASES_EN: Record<string, string[]> = {
  LEAK: ["{a} is leaking.", "There is liquid pooling under {a}.", "{a} is weeping at the flange."],
  VIB: ["{a} is vibrating heavily.", "{a} is shaking more than usual.", "Vibration on {a} has gone up."],
  NOISE: ["{a} is making an abnormal noise.", "{a} is squealing.", "{a} sounds different from usual."],
  LOWPERF: ["{a} seems to have lost capacity.", "Discharge from {a} is weak.", "{a} is not performing well."],
  OVERHEAT: ["{a} is running hot.", "The bearing on {a} is getting hot."],
  NOSTART: ["{a} will not start.", "{a} does not respond to the start command."],
  TRIP: ["{a} has tripped.", "{a} has stopped.", "{a} stopped on a fault."],
  JAM: ["{a} jammed and stopped.", "{a} stopped with debris stuck in it."],
  WEAR: ["{a} is badly worn.", "There are burn marks on {a}."],
  BREAK: ["{a} is broken.", "The chain on {a} has snapped."],
  MEANDER: ["{a} is tracking off."],
  MALFUNC: ["{a} is not operating correctly.", "{a} does not follow the command."],
  WIREDMG: ["The wire rope on {a} has broken strands."],
  GRABDMG: ["A tooth on the bucket of {a} is chipped."],
  STUCK: ["{a} will not move.", "{a} is stuck."],
  CRACK: ["There is a crack in {a}."],
  FALLASH: ["{a} is dropping a lot of siftings."],
  CLOG: ["{a} is clogged.", "A blockage alarm came up on {a}."],
  DPHIGH: ["The differential pressure on {a} is rising."],
  DRIFT: ["{a} is reading wrong.", "The value from {a} is unstable.", "{a} does not match the local reading."],
  INSUL: ["Insulation resistance on {a} is low."],
  DAMAGE: ["{a} is burnt out.", "{a} is damaged."],
  ALARM: ["{a} is in alarm.", "A fault alarm came up on {a}."],
  NOSIGNAL: ["No signal from {a}.", "{a} is not showing in the control room."],
};

const SR_CLOSING_JA = ["確認をお願いします。", "点検願います。", "至急見てください。", ""];
const SR_CLOSING_EN = ["Please check.", "Please inspect.", "Please look at it urgently.", ""];

const FREE_TEXT_JA: Record<string, string[]> = {
  LEAK: ["漏れ有", "もれ 要確認", "にじみあり"], VIB: ["振動 要確認", "ゆれ大", "振動ｱﾘ"], NOISE: ["異音", "変な音がする", "音 要確認"],
  TRIP: ["停止した", "トリップ", "止まった件"], DRIFT: ["指示不良?", "値おかしい"], CLOG: ["詰まり", "つまり除去"],
};
const FREE_TEXT_EN: Record<string, string[]> = {
  LEAK: ["leak", "leaking?? chk", "weeping"], VIB: ["vib chk", "shaking bad", "vib high"], NOISE: ["noise", "weird noise", "noisy - chk"],
  TRIP: ["stopped", "trip", "stopped again"], DRIFT: ["bad reading?", "value wrong"], CLOG: ["clogged", "unclog"],
};
const FREE_TEXT_OTHER_JA = ["不具合", "調子悪い", "要点検", "不調"];
const FREE_TEXT_OTHER_EN = ["problem", "not right", "needs check", "faulty"];

const REMEDY_CLOSING_JA = ["様子見。", "復旧。", "運転再開。", ""];
const REMEDY_CLOSING_EN = ["Monitoring.", "Restored.", "Back in service.", ""];

const SR_ONLY_JA: Array<[string, boolean]> = [
  ["照明が切れています。", false], ["床に灰がこぼれているので清掃をお願いします。", false], ["点検口の扉が閉まりにくいです。", false],
  ["手すりの塗装がはがれています。", false], ["現場の表示札が読めなくなっています。", false], ["雨漏りしています。", false],
  ["換気が弱い気がします。", false], ["工具の置き場を決めてほしいです。", false], ["監視カメラの映像が暗いです。", false],
];
const SR_ONLY_EN: Array<[string, boolean]> = [
  ["A light is out.", false], ["Ash has spilled on the floor; please clean it up.", false], ["The inspection hatch door is hard to close.", false],
  ["Paint is peeling off the handrail.", false], ["The equipment label can no longer be read.", false], ["The roof is leaking.", false],
  ["Ventilation feels weak.", false], ["Please decide where tools should be kept.", false], ["The CCTV picture is dark.", false],
];

/** 英語の略語（説明の表記の揺れ） */
const EN_ABBREV: Array<[RegExp, string]> = [
  [/\bpump\b/i, "PMP"], [/\bmotor\b/i, "MTR"], [/\bfan\b/i, "FN"], [/\bvalve\b/i, "VLV"], [/\btransmitter\b/i, "XMTR"],
  [/\bconveyor\b/i, "CONV"], [/\bcompressor\b/i, "COMPR"], [/\binverter\b/i, "VFD"], [/\bdamper\b/i, "DMPR"], [/\btank\b/i, "TK"],
];

export class Text {
  readonly lang: Lang;
  /** 辞書に無かった日本語（英語のとき）。試験と生成の報告で使う */
  readonly missing = new Set<string>();

  constructor(lang: Lang) {
    this.lang = lang;
  }

  /** catalog の日本語を出力の言語にする。日本語の文字を含まない値はそのまま */
  t(ja: string): string {
    if (this.lang === "ja" || !JP.test(ja)) return ja;
    const en = EN[ja];
    if (en === undefined) {
      this.missing.add(ja);
      return ja;
    }
    return en;
  }

  get currency(): string {
    return this.lang === "ja" ? "JPY" : "USD";
  }

  /** 円の金額を出力の通貨にする（英語はドル。digits は小数の桁） */
  money(jpy: number, digits = 0): number {
    if (this.lang === "ja") return Math.round(jpy);
    const f = 10 ** digits;
    return Math.round((jpy / JPY_PER_USD) * f) / f;
  }

  sp(a: string, b: string): string {
    return `${a} ${b}`;
  }

  /** 炉の名前（0 は共通） */
  lineName(line: number): string {
    if (this.lang === "ja") return line === 0 ? "共通" : `${line}号炉`;
    return line === 0 ? "Common" : `Line ${line}`;
  }

  commonDesc(site: string): string {
    return this.lang === "ja" ? `${site} 共通設備` : `${site} common facilities`;
  }

  abUnit(name: string, suffix: string): string {
    return this.lang === "ja" ? `${name} ${suffix}号機` : `${name} ${suffix}`;
  }

  numbered(name: string, n: number): string {
    return `${name} No.${n}`;
  }

  compartment(name: string, k: number): string {
    return this.lang === "ja" ? `${name}（第${k}室）` : `${name} (compartment ${k})`;
  }

  yearMonth(y: number, m: number): string {
    return this.lang === "ja" ? `${y}年${m}月` : `${MONTHS_EN[m - 1]} ${y}`;
  }

  /** 施設の特別な場所（倉庫・撤去品置場・修理中） */
  placeDesc(site: string, kind: "STORE" | "ESTORE" | "SALVAGE" | "REPAIR"): string {
    if (this.lang === "ja") {
      return `${site} ${{ STORE: "部品倉庫", ESTORE: "電気・計装倉庫", SALVAGE: "撤去品置場", REPAIR: "修理中（業者預け）" }[kind]}`;
    }
    return `${site} ${{ STORE: "parts store", ESTORE: "electrical & instrument store", SALVAGE: "salvage yard", REPAIR: "out for repair (vendor)" }[kind]}`;
  }

  dept(site: string, craft: string): string {
    if (this.lang === "ja") return `${site} ${craft === "OPER" ? "運転係" : craft === "MECH" ? "機械係" : craft === "CIVIL" ? "管理係" : "電気計装係"}`;
    // 部署（PERSON.DEPARTMENT）は 30 文字まで
    return `${site.replace(" Clean Center", " CC")} ${craft === "OPER" ? "Operations" : craft === "MECH" ? "Mechanical" : craft === "CIVIL" ? "Facilities" : "E&I"}`;
  }

  groupDesc(site: string, craftDesc: string): string {
    return this.lang === "ja" ? `${site} ${craftDesc}班` : `${site} ${craftDesc} team`;
  }

  failureClassDesc(d: string): string {
    return this.lang === "ja" ? `${d}（故障クラス）` : `${d} (failure class)`;
  }

  get law(): string {
    return this.lang === "ja" ? "【法定】" : "[Statutory] ";
  }

  get emergency(): string {
    return this.lang === "ja" ? "【緊急】" : "[EMERGENCY] ";
  }

  spareDesc(itemDesc: string): string {
    return this.lang === "ja" ? `予備品 ${itemDesc}` : `Spare ${itemDesc}`;
  }

  /** 人の表示名 */
  personDisplay(last: string, first: string): string {
    if (first === "") return last;
    return this.lang === "ja" ? `${last} ${first}` : `${first} ${last}`;
  }

  /** 姓と名の候補（[表示, ID 用のローマ字]）。日英で同じ数 */
  get surnames(): Array<[string, string]> {
    return this.lang === "ja" ? SURNAMES : EN_SURNAMES;
  }

  get givenNames(): Array<[string, string]> {
    return this.lang === "ja" ? GIVEN_NAMES : EN_GIVEN_NAMES;
  }

  employeeType(role: string): string {
    if (this.lang === "ja") return role === "CONTR" ? "協力会社" : role === "SYS" ? "システム" : "職員";
    return role === "CONTR" ? "Contractor" : role === "SYS" ? "System" : "Employee";
  }

  /** 運転員の連絡の文 */
  operatorText(rng: Rng, assetDesc: string, prob: string): string {
    const closing = this.lang === "ja" ? SR_CLOSING_JA : SR_CLOSING_EN;
    if (this.lang === "ja") {
      const phrase = rng.pick(SR_PHRASES_JA[prob] ?? ["に不具合があります。"]);
      return `${assetDesc.trim()}${phrase}${rng.pick(closing)}`;
    }
    const phrase = rng.pick(SR_PHRASES_EN[prob] ?? ["{a} has a problem."]).replace("{a}", `the ${assetDesc.trim()}`);
    const sentence = phrase.charAt(0).toUpperCase() + phrase.slice(1);
    const c = rng.pick(closing);
    return c ? `${sentence} ${c}` : sentence;
  }

  /** 連絡の文の最初の文（SR の件名にする） */
  firstSentence(text: string): string {
    if (this.lang === "ja") return text.split("。")[0]!;
    const i = text.indexOf(". ");
    return i >= 0 ? text.slice(0, i) : text.replace(/\.$/, "");
  }

  freeTextTitle(rng: Rng, prob: string): string {
    const map = this.lang === "ja" ? FREE_TEXT_JA : FREE_TEXT_EN;
    return rng.pick(map[prob] ?? (this.lang === "ja" ? FREE_TEXT_OTHER_JA : FREE_TEXT_OTHER_EN));
  }

  remedyText(rng: Rng, causeDesc: string, remedyDesc: string): string {
    const c = rng.pick(this.lang === "ja" ? REMEDY_CLOSING_JA : REMEDY_CLOSING_EN);
    if (this.lang === "ja") return `${causeDesc}と思われる。${remedyDesc}を実施。${c}`;
    return `Probable cause: ${causeDesc.toLowerCase()}. ${remedyDesc} carried out.${c ? ` ${c}` : ""}`;
  }

  longNote(when: string, text: string): string {
    return this.lang === "ja" ? `${when} 運転員より連絡。${text}` : `${when} Reported by operator. ${text}`;
  }

  remedyLine(text: string): string {
    return this.lang === "ja" ? `処置: ${text}` : `Action: ${text}`;
  }

  remedyShort(remedyDesc: string): string {
    return this.lang === "ja" ? `処置: ${remedyDesc}。` : `Action: ${remedyDesc}.`;
  }

  standaloneSr(desc: string, text: string): string {
    return this.lang === "ja" ? `${desc}：${text}` : `${desc}: ${text}`;
  }

  get srOnlyTexts(): Array<[string, boolean]> {
    return this.lang === "ja" ? SR_ONLY_JA : SR_ONLY_EN;
  }

  get serialPlaceholders(): string[] {
    return this.lang === "ja" ? ["不明", "-", "N/A", "ﾌﾒｲ", "なし"] : ["UNKNOWN", "-", "N/A", "TBD", "NONE"];
  }

  get trailingSpaces(): string[] {
    return this.lang === "ja" ? [" ", "  ", "　"] : [" ", "  ", " "];
  }

  // ---- データ品質の問題の表し方（日本語は全角・半角カナ、英語は似た字・略語） ----

  /** 似た字・全角が混じったタグ */
  charVariantTag(tag: string): string {
    if (this.lang === "ja") return toFullWidth(tag);
    // 0 を O に、ハイフンをエンダッシュに
    return /0/.test(tag) ? tag.replace("0", "O") : tag.replace("-", "–");
  }

  /** 説明の炉番号に似た字・全角が混じる */
  lineCharVariant(desc: string, line: number): string {
    if (this.lang === "ja") return desc.replace(`${line}号炉`, `${toFullWidth(String(line))}号炉`);
    // 1 を小文字の l に、それ以外は空白が抜ける
    return desc.replace(`Line ${line}`, line === 1 ? "Line l" : `Line${line}`);
  }

  /** 炉の表記の揺れ（1号炉 → No.1炉 / Line 1 → No.1 Line） */
  lineNotation(desc: string, line: number): string {
    if (this.lang === "ja") return desc.replace(`${line}号炉`, `No.${line}炉`);
    return desc.replace(`Line ${line}`, `#${line} Line`);
  }

  /** 説明の文字の揺れ（半角カナ / 略語） */
  notationVariant(desc: string): string {
    if (this.lang === "ja") return toHalfKana(desc);
    let out = desc;
    for (const [re, abbr] of EN_ABBREV) out = out.replace(re, abbr);
    return out === desc ? desc.toUpperCase() : out;
  }

  /** 数値の仕様を単位付きの文字にしたもの */
  numberAsText(value: number, unit: string, wide: boolean): string {
    if (this.lang === "ja") return wide ? toFullWidth(`${value}`) + unit : `${value}${unit.toLowerCase()}`;
    return wide ? `${value} ${unit}` : `${value}${unit.toLowerCase()}`;
  }

  /** 二重に登録した資産の説明 */
  duplicateDesc(desc: string, wide: boolean): string {
    if (!wide) return `${desc} `;
    return this.lang === "ja" ? toFullWidth(desc).replace(/　/g, " ") : desc.toUpperCase();
  }

  /** 重複して登録した品目の説明の変え方（日英で同じ数・同じ品目） */
  itemDuplicates(): Array<[string, (d: string) => string]> {
    if (this.lang === "ja") {
      return [
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
    }
    return [
      ["BRG-0002", (d) => d.replace(/^Ball bearing/, "BRG")],
      ["BRG-0003", (d) => d.replace("ZZ", "-ZZ")],
      ["BRG-0005", (d) => d.replace(" ", "  ")],
      ["MSL-0003", (d) => d.replace("Mechanical seal", "Mech. seal")],
      ["GSK-0004", (d) => `${d.replace("JIS 10K", "10K")}  `],
      ["VBT-0003", (d) => d.toUpperCase()],
      ["FUS-0002", (d) => d.replace("Fuse", "FUSE")],
      ["GRS-0001", (d) => d.replace("Lithium", "Li")],
      ["TCK-0002", (d) => d.replace("Thermocouple type K", "K-type thermocouple")],
      ["CGS-0001", (d) => `${d} `],
    ];
  }

  /** 日付の表記（Excel の乱れた日付に使う） */
  monthName(m: number): string {
    return MONTHS_EN[m - 1]!;
  }

  pad2(n: number): string {
    return pad(n, 2);
  }
}
