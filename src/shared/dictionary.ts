// 客先の辞書（呼び名など、客先特有の書き方をそろえる決まり）の形と、検査・当てはめ。
// 橋渡し（共有フォルダへの保存と読み込み。src/bridge/dictionaries.ts）と作業画面（突き合わせでの当てはめ）が共に使う。
// - 辞書は AI が作り、人が表で確かめて保存し、プログラムが当てはめる。AI は行を読んで当てはめない。
// - 呼び名の辞書は「ファイル側の書き方 → Maximo の名前」。突き合わせの片側（取り込んだファイルなど、この側）の文にだけ当てる。
//   Maximo の名前に当てると「ごみクレ → ごみクレーン」が「ごみクレーン」を「ごみクレーンーン」にしてしまうため。
// - 文字は NFKC にそろえてから当てる（全角・半角の違いを気にせず書けるように）。英字の大文字・小文字は区別しない。
// このファイルは実行時に何も import しない（橋渡しは .ts の拡張子付きで、作業画面は拡張子なしで読むため）。

/**
 * 辞書の種類
 * - alias（呼び名）: 書き方 → 正しい名前。突き合わせの前に、この側の文の書き方をそろえる
 * - code（言葉 → コード）: 文に出てくる言葉 → 項目（PROBLEM など）のコード。apply_rule の classify が、1 つに決まる行だけに入れる
 * - value（値の置き換え）: 列の値の書き方 → 正しい値。apply_rule の replace が当てる
 */
export type DictionaryKind = "alias" | "code" | "value";
export const DICTIONARY_KINDS: readonly DictionaryKind[] = ["alias", "code", "value"];

/** 合わせ方: そのままの文字（既定）か、正規表現 */
export type EntryMode = "text" | "regex";

export interface DictionaryEntryInput {
  /** 書き方（ファイルでの書き方・文に出てくる言葉。正規表現のときはパターン） */
  find: string;
  /** 正しい名前・コード・正しい値（呼び名と値の置き換えでは、空ならその書き方を消す） */
  to: string;
  mode: EntryMode;
  /** 根拠のメモ */
  note: string;
  /** 言葉 → コード: どの項目のコードか（例 PROBLEM・CAUSE・REMEDY） */
  field?: string;
  /** 言葉 → コード: この値の行だけに当てる（例 故障クラス PUMP。「,」「、」で複数。空ならすべての行） */
  scope?: string;
  /** 値の置き換え: この列だけに当てる（空ならどの列にも） */
  column?: string;
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
export const ENTRY_FIELD_MAX = 64;
export const ENTRY_SCOPE_MAX = 200;
export const ENTRY_COLUMN_MAX = 128;
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

export type EntryProblemCode =
  | "find_empty"
  | "find_too_long"
  | "to_too_long"
  | "note_too_long"
  | "mode_invalid"
  | "regex_invalid"
  | "regex_slow"
  | "regex_empty_match"
  | "field_empty"
  | "code_empty"
  | "field_too_long"
  | "scope_too_long"
  | "column_too_long";

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

function str(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

/** 項目の検査。使える項目なら null。kind を渡すと、その種類に要る欄（言葉 → コードの項目とコード）も確かめる */
export function entryProblem(
  e: { find: unknown; to: unknown; mode: unknown; note?: unknown; field?: unknown; scope?: unknown; column?: unknown },
  kind: DictionaryKind = "alias",
): EntryProblem | null {
  const mode = parseEntryMode(e.mode);
  if (mode === null) return { code: "mode_invalid" };
  const find = str(e.find);
  const to = str(e.to);
  const note = typeof e.note === "string" ? e.note : "";
  if (find.trim() === "") return { code: "find_empty" };
  if (find.length > ENTRY_FIND_MAX) return { code: "find_too_long" };
  if (to.length > ENTRY_TO_MAX) return { code: "to_too_long" };
  if (note.length > ENTRY_NOTE_MAX) return { code: "note_too_long" };
  if (str(e.field).length > ENTRY_FIELD_MAX) return { code: "field_too_long" };
  if (str(e.scope).length > ENTRY_SCOPE_MAX) return { code: "scope_too_long" };
  if (str(e.column).length > ENTRY_COLUMN_MAX) return { code: "column_too_long" };
  if (kind === "code") {
    if (str(e.field).trim() === "") return { code: "field_empty" };
    if (to.trim() === "") return { code: "code_empty" };
  }
  if (mode === "regex") {
    const pattern = normalizeRegexPattern(find);
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

const REGEX_SYNTAX_CHAR = /^[.*+?^${}()|[\]\\/]$/;

/**
 * 正規表現の項目のパターンを、値と同じく NFKC にそろえる。
 * 全角の記号（「（」「＄」「．」など）は書いた人にとってただの文字なので、半角にしたときに正規表現の記号になるものは「\」を付けて文字のままにする
 * （「^(\d+)/(\d+)（」の「（」がグループの始まりにならないように）
 */
export function normalizeRegexPattern(pattern: string): string {
  let out = "";
  for (const ch of pattern) {
    const n = ch.normalize("NFKC");
    out += n !== ch && REGEX_SYNTAX_CHAR.test(n) ? `\\${n}` : n;
  }
  return out;
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
    else regexes.push({ ...item, find: normalizeRegexPattern(e.find) });
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

// ---------------------------------------------------------------------------
// 言葉 → コード（apply_rule の classify）
// ---------------------------------------------------------------------------

/** 項目名・絞り込みの値の比べ方（全角半角・大文字小文字・前後の空白を問わない） */
export function foldKey(s: string): string {
  return s.normalize("NFKC").trim().toUpperCase();
}

export interface CompiledCode {
  id: string;
  /** 項目（foldKey 済み） */
  field: string;
  /** 入れるコード（書いたとおり） */
  code: string;
  /** この値の行だけ（foldKey 済み）。null ならすべての行 */
  scopes: string[] | null;
  /** 文の中で当たった位置（NFKC にそろえた文の添字） */
  spans(text: string): Array<[number, number]>;
}

export function compileCodes(entries: ReadonlyArray<Pick<DictionaryEntry, "id" | "find" | "to" | "mode"> & { field?: string; scope?: string }>): {
  rules: CompiledCode[];
  problems: Array<{ id: string; problem: EntryProblem }>;
} {
  const rules: CompiledCode[] = [];
  const problems: Array<{ id: string; problem: EntryProblem }> = [];
  for (const e of entries) {
    const p = entryProblem(e, "code");
    if (p !== null) {
      problems.push({ id: e.id, problem: p });
      continue;
    }
    const mode = parseEntryMode(e.mode) ?? "text";
    const re = mode === "text" ? new RegExp(literalPattern(e.find), "giu") : new RegExp(normalizeRegexPattern(e.find), "gi");
    const scopeList = (e.scope ?? "")
      .split(/[,、，]/)
      .map(foldKey)
      .filter((s) => s !== "");
    rules.push({
      id: e.id,
      field: foldKey(e.field ?? ""),
      code: (e.to ?? "").normalize("NFKC").trim(),
      scopes: scopeList.length > 0 ? scopeList : null,
      spans: (text) => {
        const out: Array<[number, number]> = [];
        re.lastIndex = 0;
        for (let m = re.exec(text); m !== null; m = re.exec(text)) {
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          out.push([m.index, m.index + m[0].length]);
        }
        return out;
      },
    });
  }
  return { rules, problems };
}

export type ClassifyResult = { kind: "code"; code: string; applied: string[] } | { kind: "ambiguous"; codes: string[]; applied: string[] } | { kind: "none"; applied: string[] };

/**
 * 文に出てくる言葉から、その項目のコードを決める。
 * - その項目の項目で、絞り込み（scope）が合うものだけを見る。
 * - 長い言葉の中に入っている短い言葉は数えない（「グランド部より漏れ」があれば、その中の「漏れ」は数えない）。
 * - 当たった言葉のコードが 1 つにそろえば code、2 つ以上なら ambiguous（入れない）、無ければ none。
 */
export function classifyText(rules: readonly CompiledCode[], text: string, field: string, scopeValue: string | null): ClassifyResult {
  const f = foldKey(field);
  const scope = scopeValue === null ? null : foldKey(scopeValue);
  const t = text.normalize("NFKC");
  const hits: Array<{ rule: CompiledCode; spans: Array<[number, number]> }> = [];
  for (const r of rules) {
    if (r.field !== f) continue;
    if (r.scopes !== null && (scope === null || !r.scopes.includes(scope))) continue;
    const spans = r.spans(t);
    if (spans.length > 0) hits.push({ rule: r, spans });
  }
  // 長い言葉に含まれる短い言葉の当たりを外す
  const all = hits.flatMap((h) => h.spans.map((s) => ({ id: h.rule.id, s })));
  const counted = hits.filter((h) =>
    h.spans.some(([a, b]) => !all.some((o) => o.id !== h.rule.id && o.s[0] <= a && b <= o.s[1] && o.s[1] - o.s[0] > b - a)),
  );
  const applied = counted.map((h) => h.rule.id);
  const codes = Array.from(new Set(counted.map((h) => h.rule.code)));
  if (codes.length === 1) return { kind: "code", code: codes[0] as string, applied };
  if (codes.length > 1) return { kind: "ambiguous", codes, applied };
  return { kind: "none", applied };
}

// ---------------------------------------------------------------------------
// 値の置き換え（apply_rule の replace）
// ---------------------------------------------------------------------------

/** 値の比べ方（全角半角・大文字小文字・前後と続く空白を問わない） */
function foldValue(s: string): string {
  return s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export interface CompiledValue {
  id: string;
  /** この列だけ（foldKey 済み）。null ならどの列にも */
  column: string | null;
  mode: EntryMode;
  /** そのまま: 値全体がこれと同じとき（foldValue 済み） */
  exact: string | null;
  to: string;
  re: RegExp | null;
}

export function compileValues(entries: ReadonlyArray<Pick<DictionaryEntry, "id" | "find" | "to" | "mode"> & { column?: string }>): {
  rules: CompiledValue[];
  problems: Array<{ id: string; problem: EntryProblem }>;
} {
  const rules: CompiledValue[] = [];
  const problems: Array<{ id: string; problem: EntryProblem }> = [];
  for (const e of entries) {
    const p = entryProblem(e, "value");
    if (p !== null) {
      problems.push({ id: e.id, problem: p });
      continue;
    }
    const mode = parseEntryMode(e.mode) ?? "text";
    const column = (e.column ?? "").trim() === "" ? null : foldKey(e.column ?? "");
    rules.push({
      id: e.id,
      column,
      mode,
      exact: mode === "text" ? foldValue(e.find) : null,
      to: (e.to ?? "").normalize("NFKC").trim(),
      re: mode === "regex" ? new RegExp(normalizeRegexPattern(e.find), "gi") : null,
    });
  }
  return { rules, problems };
}

export type ReplaceResult = { kind: "value"; value: string; applied: string[] } | { kind: "ambiguous"; values: string[]; applied: string[] } | { kind: "none" };

/**
 * 列の値を、正しい値に置き換える。
 * - そのままの項目: 値全体が書き方と同じとき、正しい値にする。違う正しい値の項目が 2 つ以上当たれば ambiguous（変えない）。
 * - 正規表現の項目: そのままの項目が当たらなかったとき、値の中の当たる所を順に置き換える。
 */
export function replaceValue(rules: readonly CompiledValue[], column: string, value: string): ReplaceResult {
  const col = foldKey(column);
  const own = rules.filter((r) => r.column === null || r.column === col);
  const folded = foldValue(value);
  const exact = own.filter((r) => r.exact !== null && r.exact === folded);
  if (exact.length > 0) {
    const values = Array.from(new Set(exact.map((r) => r.to)));
    const applied = exact.map((r) => r.id);
    if (values.length > 1) return { kind: "ambiguous", values, applied };
    return values[0] === value ? { kind: "none" } : { kind: "value", value: values[0] as string, applied };
  }
  let out = value.normalize("NFKC");
  const applied: string[] = [];
  for (const r of own) {
    if (r.re === null) continue;
    r.re.lastIndex = 0;
    const next = out.replace(r.re, r.to);
    if (next !== out) {
      applied.push(r.id);
      out = next;
    }
  }
  return applied.length > 0 && out !== value ? { kind: "value", value: out, applied } : { kind: "none" };
}
