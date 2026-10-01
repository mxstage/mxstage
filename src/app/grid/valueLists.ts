// グリッドで値を一覧から選ぶ列の決め方と、一覧の出どころ（純関数。画面の部品は editors.tsx）。
//
// 出どころの順:
//   1. その列から引いて読み込んだマスタのシート（load_master。meta.link が この シート・この列 を指す）がある
//      → マスタの突合列の値（説明の列 DESCRIPTION があれば添える）
//   2. Maximo から読み込んだシート → Maximo の getlist（maximo/valueList.ts）
//      スキーマに値の一覧の印（hasList）が付いた列だけ。シートのどの列にも印が無い（印の無い古い定義）ときは、
//      短い文字列の列（maxLength が LAZY_MAX_LENGTH 以下）で編集を開いたときに取りに行き、無ければ普通の入力にする。

import type { ColumnSchema } from "../../shared/model";
import { parseRowKey } from "../../shared/sheet";
import type { ValueListItem, ValueListTarget } from "../maximo/valueList";
import type { Sheet, Workspace } from "../store";
import type { RowState } from "../store/sheet";
import { formatCellValue } from "./cellStyle";

/** スキーマに hasList の印が無いとき、一覧を試しに取りに行く文字列の列の長さの上限（コード値の列。説明文の列は除く） */
export const LAZY_MAX_LENGTH = 64;

export interface MasterList {
  /** マスタのシート名 */
  sheet: string;
  items: ValueListItem[];
}

/** この列から引いて読み込んだマスタのシートの値（無ければ null） */
export function masterListFor(workspace: Workspace, sheetName: string, col: string): MasterList | null {
  for (const [name, master] of workspace.sheets) {
    const link = master.meta.link;
    if (link === undefined || link.sheet !== sheetName || link.from !== col || !master.hasColumn(link.to)) continue;
    const descCol = master.hasColumn("DESCRIPTION") && link.to !== "DESCRIPTION" ? "DESCRIPTION" : null;
    const items = new Map<string, ValueListItem>();
    for (const row of master.viewRows("final")) {
      if (master.rowStatus(row) === "deleted") continue;
      const value = formatCellValue(master.finalValue(row, link.to));
      if (value === "" || items.has(value)) continue;
      const item: ValueListItem = { value };
      if (descCol !== null) {
        const d = formatCellValue(master.finalValue(row, descCol));
        if (d !== "") item.description = d;
      }
      items.set(value, item);
    }
    const list = Array.from(items.values()).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    return { sheet: name, items: list };
  }
  return null;
}

/** スキーマが hasList の印を持つか（シートのどれかの列に印があれば、印の無い列は一覧が無いとみなす） */
export function schemaHasListFlags(columns: readonly ColumnSchema[]): boolean {
  return columns.some((c) => c.hasList !== undefined);
}

/** Maximo の getlist を使ってよい列か（読み取り専用・キー・子の ID 列は呼び出し側で除く） */
export function mayHaveMaximoList(col: ColumnSchema, columns: readonly ColumnSchema[]): boolean {
  if (col.type === "boolean" || col.type === "date" || col.type === "datetime") return false;
  if (col.hasList === true) return true;
  if (schemaHasListFlags(columns)) return false;
  return col.type === "string" && col.maxLength !== undefined && col.maxLength <= LAZY_MAX_LENGTH;
}

/**
 * getlist を付けるレコードと属性。行の href（子の列なら子の href）を使い、無い（追加した行）ときは
 * 同じシートの別の行の href（同じ種類の子）を使う。どれも無ければ null。
 */
export function maximoListTarget(sheet: Sheet, row: RowState | null, col: ColumnSchema): ValueListTarget | null {
  const source = sheet.meta.source;
  if (source.kind !== "maximo") return null;
  const dot = col.name.indexOf(".");
  const child = col.child ?? (dot >= 0 ? col.name.slice(0, dot) : null);
  const attr = dot >= 0 ? col.name.slice(dot + 1) : col.name;
  let href: string | undefined;
  if (child === null) {
    href = (row ? sheet.record(row.parentKey)?.href : undefined) || sheet.records.find((r) => r.href !== "")?.href;
  } else {
    if (row && row.childName === child) {
      const { childId } = parseRowKey(row.rowKey);
      const own = sheet.record(row.parentKey)?.children[child]?.find((c) => c.id !== null && String(c.id) === childId);
      href = own?.href;
    }
    if (!href) {
      for (const rec of sheet.records) {
        href = rec.children[child]?.find((c) => typeof c.href === "string" && c.href !== "")?.href;
        if (href) break;
      }
    }
  }
  if (!href) return null;
  const target: ValueListTarget = { os: source.os, col: col.name, href, attr };
  if (source.baseUrl !== undefined) target.baseUrl = source.baseUrl;
  return target;
}

/** 一覧の中にある値か（大文字小文字は区別しない。Maximo の大文字の列は小文字で入れても大文字になる） */
export function isInList(items: readonly ValueListItem[], text: string): boolean {
  const t = text.trim();
  if (t === "") return true;
  const lower = t.toLowerCase();
  return items.some((i) => i.value === t || i.value.toLowerCase() === lower);
}

/** 入力に合う候補（値か説明に含む。全角半角・大文字小文字は区別しない） */
export function filterItems(items: readonly ValueListItem[], text: string): readonly ValueListItem[] {
  const q = fold(text.trim());
  if (q === "") return items;
  return items.filter((i) => fold(i.value).includes(q) || (i.description !== undefined && fold(i.description).includes(q)));
}

function fold(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}
