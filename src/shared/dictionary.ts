// 客先の辞書（呼び名など、客先特有の書き方をそろえる決まり）の形と、検査・当てはめ。
// 橋渡し（共有フォルダへの保存と読み込み。src/bridge/dictionaries.ts）と作業画面（突き合わせでの当てはめ）が共に使う。
// - 辞書は AI が作り、人が表で確かめて保存し、プログラムが当てはめる。AI は行を読んで当てはめない。
// - 呼び名の辞書は「ファイル側の書き方 → Maximo の名前」。突き合わせの片側（取り込んだファイルなど、この側）の文にだけ当てる。
//   Maximo の名前に当てると「ごみクレ → ごみクレーン」が「ごみクレーン」を「ごみクレーンーン」にしてしまうため。
// - 文字は NFKC にそろえてから当てる（全角・半角の違いを気にせず書けるように）。英字の大文字・小文字は区別しない。
// このファイルは実行時に何も import しない（橋渡しは .ts の拡張子付きで、作業画面は拡張子なしで読むため）。

export type DictionaryKind = "alias";
export const DICTIONARY_KINDS: readonly DictionaryKind[] = ["alias"];

/** 合わせ方: そのままの文字（既定）か、正規表現 */
export type EntryMode = "text" | "regex";

export interface DictionaryEntryInput {
  /** 書き方（ファイルでの書き方。正規表現のときはパターン） */
  find: string;
  /** 正しい名前（空なら、その書き方を消す） */
  to: string;
  mode: EntryMode;
  /** 根拠のメモ */
  note: string;
}

export interface DictionaryEntry extends DictionaryEntryInput {
  id: string;
  /** 同じ項目の変更の通し番号（新しいほど大きい） */
  rev: number;
  /** 最後に変えた日時（ISO 8601） */
  updatedAt: string;
  /** 最後に変えたメンバーの表示名 */
  updatedBy: string;
}

export interface DictionaryMeta {
  id: string;
  name: string;
  kind: DictionaryKind;
  description: string;
  createdAt: string;
  createdBy: string;
}

export const DICTIONARY_NAME_MAX = 64;
export const DICTIONARY_DESCRIPTION_MAX = 500;
export const ENTRY_FIND_MAX = 200;
export const ENTRY_TO_MAX = 200;
export const ENTRY_NOTE_MAX = 500;
/** 1 つの辞書の項目の上限（多すぎるものは決まりではなく対応表なので、シートにして突き合わせる） */
export const MAX_ENTRIES = 5000;
export const MEMBER_NAME_MAX = 64;

export const DICTIONARY_ID_RE = /^d_[0-9a-f]{16}$/;
export const ENTRY_ID_RE = /^e_[0-9a-f]{16}$/;
export const MEMBER_ID_RE = /^m_[0-9a-f]{16}$/;
export const SAVE_ID_RE = /^s_[0-9a-f]{16}$/;

/** 「そのまま」「正規表現」などの書き方を合わせ方にする。読めなければ null */
export function parseEntryMode(v: unknown): EntryMode | null {
  if (v === null || v === undefined || v === "") return "text";
  if (typeof v !== "string") return null;
  const s = v.normalize("NFKC").trim().toLowerCase();
  if (s === "text" || s === "literal" || s === "そのまま" || s === "文字" || s === "plain") return "text";
  if (s === "regex" || s === "regexp" || s === "正規表現" || s === "re") return "regex";
  return null;
}

export type EntryProblemCode = "find_empty" | "find_too_long" | "to_too_long" | "note_too_long" | "mode_invalid" | "regex_invalid" | "regex_slow" | "regex_empty_match";

export interface EntryProblem {
  code: EntryProblemCode;
  /** 正規表現の誤りの文など */
  detail?: string;
}

/**
 * 遅くなりやすい正規表現（入れ子の繰り返し。例 (a+)+、(\w*)*、(.+){2,}）。
 * JavaScript の正規表現は途中で止められないので、作業画面が固まる形は受け付けない
 */
const NESTED_QUANTIFIER_RE = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,)/;

/** 項目の検査。使える項目なら null */
export function entryProblem(e: { find: unknown; to: unknown; mode: unknown; note?: unknown }): EntryProblem | null {
  const mode = parseEntryMode(e.mode);
  if (mode === null) return { code: "mode_invalid" };
  const find = typeof e.find === "string" ? e.find : e.find === null || e.find === undefined ? "" : String(e.find);
  const to = typeof e.to === "string" ? e.to : e.to === null || e.to === undefined ? "" : String(e.to);
  const note = typeof e.note === "string" ? e.note : "";
  if (find.trim() === "") return { code: "find_empty" };
  if (find.length > ENTRY_FIND_MAX) return { code: "find_too_long" };
  if (to.length > ENTRY_TO_MAX) return { code: "to_too_long" };
  if (note.length > ENTRY_NOTE_MAX) return { code: "note_too_long" };
  if (mode === "regex") {
    const pattern = find.normalize("NFKC");
    let re: RegExp;
    try {
      re = new RegExp(pattern, "gi");
    } catch (err) {
      return { code: "regex_invalid", detail: err instanceof Error ? err.message : String(err) };
    }
    if (NESTED_QUANTIFIER_RE.test(pattern)) return { code: "regex_slow" };
    re.lastIndex = 0;
    if (re.test("")) return { code: "regex_empty_match" };
  }
  return null;
}

/** 正規表現の中で特別な意味を持つ文字を、そのままの文字として扱う形にする */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** そのままの書き方を、空白の有無を問わずに見つけるパターン（「スートブロワ 5」と「スートブロワ5」を同じに扱う） */
function literalPattern(s: string): string {
  return escapeRegex(s.normalize("NFKC").trim()).replace(/\s+/g, "\\s*");
}

export interface CompiledAlias {
  id: string;
  /** 当てはめる。当たらなければ同じ文字列を返す */
  apply(text: string): string;
}

export interface CompiledAliases {
  rules: CompiledAlias[];
  /** 使えない項目（当てはめに使わない） */
  problems: Array<{ id: string; problem: EntryProblem }>;
}

/**
 * 呼び名の項目を当てはめられる形にする。並びは、そのままの項目（書き方の長い順）→ 正規表現の項目（渡した順）。
 * 長い書き方を先に当てるのは「ポンプ A」より「温水循環ポンプ A」を先に読み替えるため。
 */
export function compileAliases(entries: ReadonlyArray<Pick<DictionaryEntry, "id" | "find" | "to" | "mode"> & { note?: string }>): CompiledAliases {
  const problems: CompiledAliases["problems"] = [];
  const texts: Array<{ id: string; find: string; to: string }> = [];
  const regexes: Array<{ id: string; find: string; to: string }> = [];
  for (const e of entries) {
    const p = entryProblem(e);
    if (p !== null) {
      problems.push({ id: e.id, problem: p });
      continue;
    }
    const mode = parseEntryMode(e.mode) ?? "text";
    const item = { id: e.id, find: e.find.normalize("NFKC").trim(), to: (e.to ?? "").normalize("NFKC").trim() };
    if (mode === "text") texts.push(item);
    else regexes.push({ ...item, find: e.find.normalize("NFKC") });
  }
  texts.sort((a, b) => b.find.length - a.find.length);
  const rules: CompiledAlias[] = [];
  for (const t of texts) {
    // 正しい名前がすでに書かれている所は読み替えない（「ごみクレ → ごみクレーン」で「ごみクレーン」を「ごみクレーンーン」にしない）。
    // 左から順に見て、同じ位置なら正しい名前を先に当てる
    const keep = t.to === "" ? null : literalPattern(t.to);
    const re = new RegExp(keep === null ? `(${literalPattern(t.find)})` : `(${keep})|(${literalPattern(t.find)})`, "giu");
    const to = t.to;
    rules.push({
      id: t.id,
      apply: (text) => text.replace(re, (whole: string, a: string | undefined, b: string | undefined) => (keep !== null && a !== undefined && b === undefined ? whole : to)),
    });
  }
  for (const r of regexes) {
    const re = new RegExp(r.find, "gi");
    const to = r.to;
    rules.push({ id: r.id, apply: (text) => text.replace(re, to) });
  }
  return { rules, problems };
}

/** 文に呼び名を当てはめる。applied は文を変えた項目の ID（当てはめた順） */
export function applyAliases(rules: readonly CompiledAlias[], text: string): { text: string; applied: string[] } {
  let out = text.normalize("NFKC");
  const applied: string[] = [];
  for (const r of rules) {
    const next = r.apply(out);
    if (next !== out) {
      applied.push(r.id);
      out = next;
    }
  }
  return { text: out, applied };
}
