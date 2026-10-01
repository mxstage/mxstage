// グリッドの列ごとの絞り込み（純ロジック）。
//
// 画面で見えている文字列に対して絞る（Maximo へ問い合わせ直さない）。読み込んだシートの中だけの話で、
// 変更・反映の対象は変わらない。値の比較は全角半角と大文字小文字を区別しない（探すときの取りこぼしを減らすため）。
// 変更の状態（誰が変えたセルか・追加行・削除行）でも絞れる。区分はセルの色分けと同じ。

import { foldText } from "../catalog/catalog";
import { gridMessages } from "./messages";

/** セルの変更の状態。削除行 > 追加行 > 変更したセル（作者別）> 変更なし の順で 1 つに決める（セルの色分けと同じ） */
export type ChangeKind = "llm" | "user" | "added" | "deleted" | "none";

export const CHANGE_KINDS: readonly ChangeKind[] = ["llm", "user", "added", "deleted", "none"];

/** 変更の状態の名前（今の言語の文言。セルの色の凡例と同じ） */
export function changeLabel(kind: ChangeKind): string {
  return gridMessages().tone[kind];
}

export type GridFilter =
  | { col: string; kind: "contains"; text: string }
  | { col: string; kind: "values"; values: string[] }
  | { col: string; kind: "empty" }
  | { col: string; kind: "notEmpty" }
  | { col: string; kind: "change"; changes: ChangeKind[] };

/** 値で決まる絞り込み（変更の状態以外） */
export type ValueFilter = Exclude<GridFilter, { kind: "change" }>;

/** 空とみなす表示（null は formatCellValue で "" になる） */
function isBlank(value: string): boolean {
  return value.trim() === "";
}

export function matchesFilter(value: string, filter: ValueFilter): boolean {
  switch (filter.kind) {
    case "contains":
      return foldText(value).includes(foldText(filter.text));
    case "values": {
      const folded = foldText(value);
      return filter.values.some((v) => foldText(v) === folded);
    }
    case "empty":
      return isBlank(value);
    case "notEmpty":
      return !isBlank(value);
  }
}

/**
 * すべての絞り込みに当たる行だけを残す（同じ列に複数あれば、どれにも当たる行だけ）。
 * changeOf はセルの変更の状態（渡さなければ、どのセルも「変更なし」）
 */
export function applyGridFilters<T>(
  rows: readonly T[],
  filters: readonly GridFilter[],
  valueOf: (row: T, col: string) => string,
  changeOf: (row: T, col: string) => ChangeKind = () => "none",
): T[] {
  if (filters.length === 0) return [...rows];
  return rows.filter((row) => filters.every((f) => (f.kind === "change" ? f.changes.includes(changeOf(row, f.col)) : matchesFilter(valueOf(row, f.col), f))));
}

/** その列の変更の状態ごとの件数（件数が 0 の区分も並べる。区分の順は CHANGE_KINDS） */
export function changeCounts<T>(rows: readonly T[], col: string, changeOf: (row: T, col: string) => ChangeKind): Array<{ kind: ChangeKind; count: number }> {
  const counts = new Map<ChangeKind, number>(CHANGE_KINDS.map((k) => [k, 0]));
  for (const row of rows) {
    const k = changeOf(row, col);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return CHANGE_KINDS.map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
}

/** その列に実際に入っている値を多い順に返す（選んで絞るための候補） */
export function distinctValues<T>(rows: readonly T[], col: string, valueOf: (row: T, col: string) => string, limit = 30): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const v = valueOf(row, col);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return Array.from(counts, ([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, limit);
}

/** 絞り込みの札（チップ）の文言。title は列の画面表示名（無ければ列名） */
export function filterLabel(filter: GridFilter, title: string = filter.col): string {
  const t = gridMessages().filter;
  switch (filter.kind) {
    case "contains":
      return t.contains(title, filter.text);
    case "values":
      return filter.values.length === 1 ? t.value(title, blankLabel(filter.values[0] as string)) : t.values(title, filter.values.length);
    case "empty":
      return t.empty(title);
    case "notEmpty":
      return t.notEmpty(title);
    case "change":
      return t.change(title, filter.changes.map(changeLabel));
  }
}

function blankLabel(value: string): string {
  return isBlank(value) ? gridMessages().hover.empty : value;
}

/**
 * ペインの見出しに出す行数。列の絞り込みか、他のペインへの連動で行が減っているときは「残り / 全体」、
 * どちらも無ければ「全体 行」。total は連動する前の行数（連動で減ったことも見えるように）
 */
export function rowCountLabel(c: { shown: number; total: number; narrowed: boolean }): string {
  return c.narrowed ? `${c.shown} / ${c.total}` : gridMessages().filter.rows(c.total);
}

/** 同じ列の絞り込みは 1 つにする（列メニューで選び直したら置き換える） */
export function setFilter(filters: readonly GridFilter[], filter: GridFilter | null, col: string): GridFilter[] {
  const rest = filters.filter((f) => f.col !== col);
  return filter === null ? rest : [...rest, filter];
}

/**
 * 「文字を含む」で当たった位置（元の文字列の添字。end は含まない）。当たらなければ null。
 * 比べ方は matchesFilter と同じ（全角半角・大文字小文字を区別しない）。1 文字ずつ正規化して元の位置に戻すので、
 * 半角の濁点（ｶﾞ）のように 2 文字が 1 文字にまとまる並びは位置を出せない（そのときも null。行は絞り込みに当たっている）
 */
export function matchRange(value: string, text: string): { start: number; end: number } | null {
  const needle = foldText(text);
  if (needle === "") return null;
  let folded = "";
  const origin: number[] = [];
  let i = 0;
  for (const ch of value) {
    const f = foldText(ch);
    for (let k = 0; k < f.length; k++) origin.push(i);
    folded += f;
    i += ch.length;
  }
  const at = folded.indexOf(needle);
  if (at < 0) return null;
  const lastOrigin = origin[at + needle.length - 1] as number;
  const lastChar = value.codePointAt(lastOrigin) as number;
  return { start: origin[at] as number, end: lastOrigin + (lastChar > 0xffff ? 2 : 1) };
}
