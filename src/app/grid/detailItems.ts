// 「行の詳細」に並べる項目。画面が狭いときや、工事内容のような長文・改行のあるセルを読むために、
// 選んだ 1 行の全列を縦に並べる。値の取り出しは呼び出し側に任せ、ここは並べ方だけを決める（試験できるように）。

import type { BatchAuthor, ColumnSchema } from "../../shared/model";
import { headerLines } from "../../shared/columnLabel";

/** これより長い、または改行を含む値は幅いっぱいに出す */
export const LONG_VALUE_CHARS = 40;

export interface DetailItem {
  /** 列名（属性名。子は CHILD.ATTR） */
  name: string;
  /** 見出し（日本語ラベル。無ければ属性名） */
  label: string;
  /** ラベルがあるときの属性名（無ければ null） */
  attr: string | null;
  value: string;
  changed: boolean;
  /** 変更したセルの作者（文字をその作者の色で出す）。分からないときは持たない */
  author?: BatchAuthor | null;
  /** 変更したセルの元の値（表示用の文字。空は ""）。変更していないセル・元の値ビューでは持たない */
  before?: string;
  /** 長文（改行を含む、または LONG_VALUE_CHARS より長い） */
  long: boolean;
  /** 値が空 */
  empty: boolean;
}

export function isLongValue(value: string): boolean {
  return value.includes("\n") || value.length > LONG_VALUE_CHARS;
}

export interface DetailRead {
  value: string;
  changed: boolean;
  author?: BatchAuthor | null;
  before?: string;
}

/** 列の順はシートの列の順。空の列も飛ばさずに出す（入っていないことも情報のため） */
export function rowDetailItems(columns: readonly ColumnSchema[], read: (col: string) => DetailRead): DetailItem[] {
  return columns.map((c) => {
    const { main, sub } = headerLines(c);
    const { value, changed, author, before } = read(c.name);
    // 元の値が長文なら、新しい値が短くても幅いっぱいで並べる（新旧を同じ幅で見比べられるように）
    const long = isLongValue(value) || (before !== undefined && isLongValue(before));
    return {
      name: c.name,
      label: main,
      attr: sub,
      value,
      changed,
      ...(author !== undefined ? { author } : {}),
      ...(changed && before !== undefined ? { before } : {}),
      long,
      empty: value === "",
    };
  });
}

/** 空の列を後ろにまとめる（値の入っている列から読めるように）。空にした変更は変更なので前に残す */
export function sortDetailItems(items: readonly DetailItem[]): DetailItem[] {
  const front = (i: DetailItem) => !i.empty || i.changed;
  return [...items.filter(front), ...items.filter((i) => !front(i))];
}

/** マウスを置いたときに全文を出す行数と文字数の上限 */
export const HOVER_MAX_LINES = 14;
export const HOVER_MAX_CHARS = 1_000;

/**
 * 長文のセルにマウスを置いたときに出す行。短い値は null（吹き出しを出さない）。
 * 列幅に収まらない値はグリッドでは切れて読めないので、ここで全文を返す。
 */
export function longCellLines(value: string): string[] | null {
  if (!isLongValue(value)) return null;
  const text = value.length > HOVER_MAX_CHARS ? `${value.slice(0, HOVER_MAX_CHARS)}…` : value;
  const lines = text.split("\n");
  return lines.length > HOVER_MAX_LINES ? [...lines.slice(0, HOVER_MAX_LINES), "…"] : lines;
}
