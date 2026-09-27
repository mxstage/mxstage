// 突合キーの正規化（match_sheets と apply_rule の lookup で使う）。
// 指定の順序に結果が左右されないよう、適用順は NORMALIZE_ORDER に固定する。

import type { CellValue, NormalizeOption } from "../../shared/model";

export const NORMALIZE_ORDER: readonly NormalizeOption[] = ["nfkc", "trim", "removeSpaces", "removeHyphens", "upper", "lower"];

// 空白: JS の \s は U+3000（全角空白）・U+00A0・U+FEFF を含む。ゼロ幅空白 U+200B は含まないので足す
const EDGE_SPACES_RE = /^[\s​]+|[\s​]+$/g;
const ALL_SPACES_RE = /[\s​]+/g;

// ハイフン類として除去する文字。TAG NO. の手入力・全角半角の揺れで混ざる「横棒」を対象にする。
//   U+002D - HYPHEN-MINUS / U+2010 ‐ HYPHEN / U+2011 ‑ NON-BREAKING HYPHEN / U+2012 ‒ FIGURE DASH
//   U+2013 – EN DASH / U+2014 — EM DASH / U+2015 ― HORIZONTAL BAR / U+2212 − MINUS SIGN
//   U+FF0D － FULLWIDTH HYPHEN-MINUS（nfkc を指定しない場合にも除けるよう明示する）
// 除外する文字:
//   U+30FC ー（長音符）と U+FF70 ｰ（半角長音符）。カタカナ語の一部（「モーター」「メーター」など）なので、
//   除くと別の語が同じキーになり誤一致を生む。長音符をハイフン代わりに入力したデータは、
//   自動で吸収せず不一致として見せ、人か LLM が判断する。
const HYPHENS_RE = /[-‐‑‒–—―−－]/g;

export function normalizeText(s: string, options: readonly NormalizeOption[]): string {
  if (options.length === 0) return s;
  const set = new Set(options);
  let out = s;
  for (const opt of NORMALIZE_ORDER) {
    if (!set.has(opt)) continue;
    switch (opt) {
      case "nfkc":
        out = out.normalize("NFKC");
        break;
      case "trim":
        out = out.replace(EDGE_SPACES_RE, "");
        break;
      case "removeSpaces":
        out = out.replace(ALL_SPACES_RE, "");
        break;
      case "removeHyphens":
        out = out.replace(HYPHENS_RE, "");
        break;
      case "upper":
        out = out.toUpperCase();
        break;
      case "lower":
        out = out.toLowerCase();
        break;
    }
  }
  return out;
}

/** セル値を突合キーにする。null・空文字・正規化後に空になる値は「キーなし」として null を返す */
export function normalizeKey(v: CellValue | undefined, options: readonly NormalizeOption[]): string | null {
  if (v === null || v === undefined) return null;
  const s = normalizeText(typeof v === "string" ? v : String(v), options);
  return s === "" ? null : s;
}

export interface CompositeKey {
  /** 索引用のキー。1 列でもキーなしなら null（突合しない） */
  id: string | null;
  /** 表示用（MatchSummary の key）。各列の正規化後の値を " | " で連結し、キーなしの列は空文字 */
  label: string;
}

/**
 * 複数列（複合キー）の突合キー。
 * 単一列の id は正規化した値そのもの。複数列の id は正規化した値の配列を JSON にする。
 * 区切り文字（\u001f など）での連結と同じ役割だが、値にその文字が含まれても別のキーが同じ id にならない。
 * 突合する両側は同じ列数なので、単一列と複数列の id が混ざることはない。
 */
export function normalizeCompositeKey(values: ReadonlyArray<CellValue | undefined>, options: readonly NormalizeOption[]): CompositeKey {
  const parts = values.map((v) => normalizeKey(v, options));
  const label = parts.map((p) => p ?? "").join(" | ");
  if (parts.some((p) => p === null)) return { id: null, label };
  return { id: parts.length === 1 ? (parts[0] as string) : JSON.stringify(parts), label };
}
