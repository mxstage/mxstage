// 生成に使う小道具: 種付きの乱数（同じ種なら毎回同じデータ）、日時、文字の揺れ（全角・半角カナ・末尾の空白）。
// Node が型を消すだけで動かすので、引数プロパティや enum は使わない。

/** 種付きの乱数（mulberry32）。Math.random は使わない */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** 0 以上 1 未満 */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** min 以上 max 以下の整数 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  /** min 以上 max 未満の実数 */
  real(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)]!;
  }
  /** 重み付きで選ぶ */
  weighted<T>(list: ReadonlyArray<readonly [T, number]>): T {
    let total = 0;
    for (const [, w] of list) total += w;
    let r = this.next() * total;
    for (const [v, w] of list) {
      r -= w;
      if (r < 0) return v;
    }
    return list[list.length - 1]![0];
  }
  /** ポアソン分布（平均 lambda。小さい値向け） */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * this.normal()));
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > l);
    return k - 1;
  }
  normal(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** 別の系列の乱数を作る（サイトや表ごとに分けると、一部だけ作っても他の値が変わらない） */
  fork(salt: string): Rng {
    let h = this.s ^ 0x9e3779b9;
    for (let i = 0; i < salt.length; i++) h = Math.imul(h ^ salt.charCodeAt(i), 0x01000193) >>> 0;
    return new Rng(h);
  }
}

export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

// ---- 日時（日本時間。Maximo の応答と同じ 2026-04-01T08:30:00+09:00 の形で返す） ----

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
const JST = 9 * HOUR;

/** 日本時間の年月日時分から ms */
export function jst(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi) - JST;
}

/** ms を Maximo の日時の文字列にする（分まで。秒は 00） */
export function fmt(ms: number): string {
  const d = new Date(Math.floor(ms / 60_000) * 60_000 + JST);
  return `${d.toISOString().slice(0, 19)}+09:00`;
}

/** 日本時間の年・月（1〜12）・日 */
export function ymd(ms: number): { y: number; m: number; d: number } {
  const d = new Date(ms + JST);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/** 日本時間で months か月後の同じ日時（月末は詰める） */
export function addMonths(ms: number, months: number): number {
  const d = new Date(ms + JST);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes()) - JST;
}

/** 日本時間のその日の h 時 mi 分 */
export function atTime(ms: number, h: number, mi = 0): number {
  const { y, m, d } = ymd(ms);
  return jst(y, m, d, h, mi);
}

/** 土日なら次の月曜にずらす */
export function weekday(ms: number): number {
  const dow = new Date(ms + JST).getUTCDay();
  if (dow === 6) return ms + 2 * DAY;
  if (dow === 0) return ms + DAY;
  return ms;
}

// ---- 文字の揺れ（データ品質の問題として仕込む） ----

/** 英数字と記号の一部を全角にする */
export function toFullWidth(s: string): string {
  return s.replace(/[0-9A-Za-z\-.()]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
}

const HALF_KANA: Record<string, string> = {
  ア: "ｱ", イ: "ｲ", ウ: "ｳ", エ: "ｴ", オ: "ｵ", カ: "ｶ", キ: "ｷ", ク: "ｸ", ケ: "ｹ", コ: "ｺ",
  サ: "ｻ", シ: "ｼ", ス: "ｽ", セ: "ｾ", ソ: "ｿ", タ: "ﾀ", チ: "ﾁ", ツ: "ﾂ", テ: "ﾃ", ト: "ﾄ",
  ナ: "ﾅ", ニ: "ﾆ", ヌ: "ﾇ", ネ: "ﾈ", ノ: "ﾉ", ハ: "ﾊ", ヒ: "ﾋ", フ: "ﾌ", ヘ: "ﾍ", ホ: "ﾎ",
  マ: "ﾏ", ミ: "ﾐ", ム: "ﾑ", メ: "ﾒ", モ: "ﾓ", ヤ: "ﾔ", ユ: "ﾕ", ヨ: "ﾖ", ラ: "ﾗ", リ: "ﾘ",
  ル: "ﾙ", レ: "ﾚ", ロ: "ﾛ", ワ: "ﾜ", ヲ: "ｦ", ン: "ﾝ", ァ: "ｧ", ィ: "ｨ", ゥ: "ｩ", ェ: "ｪ",
  ォ: "ｫ", ッ: "ｯ", ャ: "ｬ", ュ: "ｭ", ョ: "ｮ", ー: "ｰ",
  ガ: "ｶﾞ", ギ: "ｷﾞ", グ: "ｸﾞ", ゲ: "ｹﾞ", ゴ: "ｺﾞ", ザ: "ｻﾞ", ジ: "ｼﾞ", ズ: "ｽﾞ", ゼ: "ｾﾞ", ゾ: "ｿﾞ",
  ダ: "ﾀﾞ", ヂ: "ﾁﾞ", ヅ: "ﾂﾞ", デ: "ﾃﾞ", ド: "ﾄﾞ", バ: "ﾊﾞ", ビ: "ﾋﾞ", ブ: "ﾌﾞ", ベ: "ﾍﾞ", ボ: "ﾎﾞ",
  パ: "ﾊﾟ", ピ: "ﾋﾟ", プ: "ﾌﾟ", ペ: "ﾍﾟ", ポ: "ﾎﾟ", ヴ: "ｳﾞ",
};

/** 全角カタカナを半角カナにする */
export function toHalfKana(s: string): string {
  let out = "";
  for (const c of s) out += HALF_KANA[c] ?? c;
  return out;
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** 小数を桁で丸める */
export function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
