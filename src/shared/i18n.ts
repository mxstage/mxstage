// 作業画面の言語（英語と日本語）。英語を正とし、日本語は英語と同じ形にそろえる（抜けは型検査で見つかる）。
//
//   const m = defineMessages(
//     { title: "Settings", saved: (n: number) => `${n} saved` },
//     { title: "設定", saved: (n) => `${n} 件を保存しました` },
//   );
//   m().title      // 今の言語の文言
//
// 言語の決め方: 利用者が設定で選んだもの（localStorage の mxstage.locale）→ 無ければブラウザの言語が日本語なら日本語、
// それ以外は英語。切り替えたら subscribeLocale で知らせ、画面は作り直して表示を変える（作業データはタブのメモリにあるので、再読み込みはしない）。
// LLM に渡す文言（ツールの説明・結果・案内）は、ここを通さず英語だけにする。ただし作業画面にも出る文
// （反映の関門の理由・反映の結果・ライセンスの案内など）は、ここを通して今の言語にする（LLM は利用者の言葉で答える）。

export type Locale = "en" | "ja";
export const LOCALES: readonly Locale[] = ["en", "ja"];
/** 利用者が選んだ言語を覚えておく localStorage のキー */
export const LOCALE_STORAGE_KEY = "mxstage.locale";

type MessageValue = string | ((...args: never[]) => string);
export interface MessageTree {
  readonly [key: string]: MessageValue | MessageTree;
}

/** 英語の文言と同じ形（文字列は文字列、関数は同じ引数の関数、入れ子は同じ入れ子） */
export type MessagesOf<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : T[K] extends (...args: infer A) => string ? (...args: A) => string : MessagesOf<T[K]>;
};

let current: Locale = "en";
const listeners = new Set<(locale: Locale) => void>();

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "ja";
}

export function getLocale(): Locale {
  return current;
}

/** 言語を切り替える。変わったときだけ知らせる */
export function setLocale(locale: Locale): void {
  if (!isLocale(locale) || locale === current) return;
  current = locale;
  for (const listener of [...listeners]) listener(locale);
}

/** 言語が変わったら呼ぶ。戻り値で解除する */
export function subscribeLocale(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 保存した設定とブラウザの言語から、使う言語を決める */
export function detectLocale(input: { stored?: string | null; languages?: readonly string[] }): Locale {
  if (isLocale(input.stored)) return input.stored;
  const first = (input.languages ?? [])[0] ?? "";
  return first.toLowerCase().startsWith("ja") ? "ja" : "en";
}

/** 英語（正）と日本語の文言の組を作る。返す関数は、呼んだときの言語の文言を返す */
export function defineMessages<const T extends MessageTree>(en: T, ja: MessagesOf<T>): () => MessagesOf<T> {
  const english = en as unknown as MessagesOf<T>;
  return () => (current === "ja" ? ja : english);
}
