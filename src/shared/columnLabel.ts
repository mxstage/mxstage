// 列の見出しに出す文字列。Maximo の属性名だけでは何の列か分からないので、
// 画面表示名（日本語ラベル）を主に、属性名を添えて出す。canvas に描く前の純関数なのでここで試験する。

import type { ColumnSchema } from "./model";

export interface HeaderLines {
  /** 上の行（日本語ラベル。無ければ属性名） */
  main: string;
  /** 下の行（属性名。ラベルが無い・ラベルと同じときは null） */
  sub: string | null;
}

/** 見出しの 2 行。子の列は属性名に子オブジェクト名を残す（MULTIASSETLOCCI.ASSETNUM） */
export function headerLines(c: Pick<ColumnSchema, "name" | "title">): HeaderLines {
  const title = (c.title ?? "").trim();
  if (title === "" || title === c.name) return { main: c.name, sub: null };
  return { main: title, sub: c.name };
}

/** 1 行で書くときの表記（札・メニュー・行の詳細の見出し） */
export function columnLabel(c: Pick<ColumnSchema, "name" | "title">): string {
  const { main, sub } = headerLines(c);
  return sub === null ? main : `${main}（${sub}）`;
}

/** 列名 → ラベルの対応表（ツールの応答に添えて、LLM が利用者へ日本語で伝えられるようにする） */
export function columnTitleMap(columns: ReadonlyArray<Pick<ColumnSchema, "name" | "title">>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of columns) {
    const { main, sub } = headerLines(c);
    if (sub !== null) out[c.name] = main;
  }
  return out;
}
