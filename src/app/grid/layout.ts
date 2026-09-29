// グリッドの寸法の決め方。狭い画面（チャットと半々に並べるなど）で固定列だけが見えて
// 中身が読めなくなるのを防ぐ。canvas に渡す前の純関数なのでここで試験する。

import type { ColumnSchema } from "../../shared/model";
import { headerLines } from "../../shared/columnLabel";

/** これより狭いと固定列を外す（固定列だけで埋まってしまうため） */
export const NARROW_WIDTH = 520;
/** これより狭いと固定列は 1 本まで */
export const MEDIUM_WIDTH = 820;

/** 画面（ペイン）の幅に応じた固定列の本数。固定したい列（frozen 本）が 0 本なら固定しない */
export function freezeCountForWidth(width: number, frozen: number): number {
  if (frozen <= 0) return 0;
  if (width > 0 && width < NARROW_WIDTH) return 0;
  if (width > 0 && width < MEDIUM_WIDTH) return Math.min(1, frozen);
  return Math.min(MAX_FROZEN, frozen);
}

/** 広い画面でも固定は 3 本まで（固定した列が表を埋めると横に動かせなくなる） */
export const MAX_FROZEN = 3;

/**
 * キー列のうち、行の見分けに使わない「範囲」の列（サイト・組織・クラスなど）。
 * キーの一部なので消せないが、1 回の作業ではほぼ同じ値が並ぶので、固定すると表示の幅だけを取る。
 */
const QUALIFIER_KEYS = new Set(["SITEID", "ORGID", "CLASS", "WOCLASS", "LANGCODE", "ITEMSETID", "SETID", "TENANTID"]);

/**
 * 左に固定する列。利用者が選んだ列があればそれを、無ければキー列のうち行を見分ける列（WONUM・ASSETNUM・TICKETID など）。
 * キー列がすべて「範囲」の列なら、最後のキー列を使う
 */
export function frozenColumnsFor(keyColumns: readonly string[], pinned: readonly string[] | null): string[] {
  if (pinned !== null) return [...pinned];
  const ids = keyColumns.filter((k) => !QUALIFIER_KEYS.has(k.toUpperCase()));
  if (ids.length > 0) return ids;
  const last = keyColumns[keyColumns.length - 1];
  return last === undefined ? [] : [last];
}

/** 列の見出しのメニューから、その列を固定する・固定を外す（今の固定の列に足す・から外す） */
export function togglePinned(frozen: readonly string[], col: string): string[] {
  return frozen.includes(col) ? frozen.filter((c) => c !== col) : [...frozen, col];
}

/**
 * 固定する列を先頭に寄せる（固定は先頭の列からしかできないため）。ほかの列は元の並びのまま。
 * 並べ替えるのは画面の表示だけで、シートの列の順（読み込み・反映）は変えない
 */
export function orderForFreeze<T extends { name: string }>(columns: readonly T[], frozen: readonly string[]): { columns: T[]; freeze: number } {
  const byName = new Map(columns.map((c) => [c.name, c] as const));
  const head = frozen.flatMap((n) => {
    const c = byName.get(n);
    return c === undefined ? [] : [c];
  });
  const headSet = new Set(head);
  return { columns: [...head, ...columns.filter((c) => !headSet.has(c))], freeze: head.length };
}

/** 2 段見出し（ラベル＋属性名）を出す列があるかで見出しの高さを決める */
export function headerHeightFor(columns: readonly ColumnSchema[]): number {
  return columns.some((c) => headerLines(c).sub !== null) ? 48 : 32;
}

/** これより狭い画面では、関連する表を並べず今のシートだけを出す（チャットと半々に並べたときなど） */
export const ONE_PANE_WIDTH = 1000;

export function showOnePane(windowWidth: number): boolean {
  return windowWidth > 0 && windowWidth < ONE_PANE_WIDTH;
}

/** これより狭い画面では、反映・変更履歴のパネルを初めから隠す（表に幅を回す） */
export const HIDE_SIDE_WIDTH = 1200;

/**
 * 列の初期の幅。すべて同じ幅だと、短いコードの列が無駄に広く、工事内容のような長文は読めない。
 * 利用者が動かした幅があればそちらを使う。
 */
export function defaultColumnWidth(c: ColumnSchema): number {
  if (c.type === "boolean") return 90;
  if (c.type === "integer" || c.type === "number") return 100;
  if (c.type === "date" || c.type === "datetime") return 130;
  const len = c.maxLength ?? 0;
  if (len > 0 && len <= 12) return 110;
  if (len >= 200) return 280;
  return 150;
}
