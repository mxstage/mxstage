// グリッドの寸法の決め方。狭い画面（チャットと半々に並べるなど）で固定列だけが見えて
// 中身が読めなくなるのを防ぐ。canvas に渡す前の純関数なのでここで試験する。

import type { ColumnSchema } from "../../shared/model";
import { headerLines } from "../../shared/columnLabel";

/** これより狭いと固定列を外す（固定列だけで埋まってしまうため） */
export const NARROW_WIDTH = 520;
/** これより狭いと固定列は 1 本まで */
export const MEDIUM_WIDTH = 820;

/** 画面（ペイン）の幅に応じた固定列の本数。keyColumns が 0 本なら固定しない */
export function freezeCountForWidth(width: number, keyColumns: number): number {
  if (keyColumns <= 0) return 0;
  if (width > 0 && width < NARROW_WIDTH) return 0;
  if (width > 0 && width < MEDIUM_WIDTH) return Math.min(1, keyColumns);
  return Math.min(2, keyColumns);
}

/** 2 段見出し（ラベル＋属性名）を出す列があるかで見出しの高さを決める */
export function headerHeightFor(columns: readonly ColumnSchema[]): number {
  return columns.some((c) => headerLines(c).sub !== null) ? 42 : 30;
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
