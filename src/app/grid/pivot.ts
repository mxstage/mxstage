// 子の表の横持ち（属性・値の形の表を、1 行 ＝ 1 親、1 列 ＝ 1 項目にして見せる）。純ロジック。
//
// Maximo の仕様（ASSETSPEC・LOCATIONSPEC・ITEMSPEC など）は、1 機器 × 1 項目 ＝ 1 行の縦持ちで返る。
// 人が読む・直すときは、機器を行、項目を列にした横持ちのほうが見やすい。
// - データは縦持ちのまま（反映・差分・取り消し・LLM のツールは縦持ちの行を単位に動く）。横持ちは見せ方だけ。
// - 横持ちのセルを直すと、対応する縦持ちの行の値の列（数値なら NUMVALUE、文字なら ALNVALUE）が変わる。
// - 縦持ちの行が無い項目のセルは空で、まだ直せない（行を足すのは次の段階）。

import type { CellValue, ColumnSchema } from "../../shared/model";
import type { SheetMeta } from "../../shared/sheet";
import type { RowState } from "../store/sheet";

/** 横持ちにできる子の表の形 */
export interface PivotSpec {
  child: string;
  /** 項目名の列（例 ASSETSPEC.ASSETATTRID） */
  nameCol: string;
  /** 値の列（数値・文字・表・日付の順） */
  valueCols: string[];
  /** 単位の列（例 ASSETSPEC.MEASUREUNITID） */
  unitCol: string | null;
  /** セクションの列（同じ項目がセクション違いで並ぶ） */
  sectionCol: string | null;
}

/** 値の列の候補（Maximo の仕様の表の属性名）。並びは、どれにも値が無い項目で使う順 */
const VALUE_ATTRS = ["ALNVALUE", "NUMVALUE", "TABLEVALUE", "DATEVALUE"] as const;
/** 項目名の列（Maximo の仕様の表は ASSETATTRID。属性の ID で終わる名前） */
const NAME_ATTR_RE = /ATTRID$/;
/** 横持ちの列がこれより多くなる表は、既定では縦持ちにする（列が多すぎて読めない） */
export const MAX_PIVOT_COLUMNS = 300;

function attrOf(col: ColumnSchema, child: string): string {
  return col.name.slice(child.length + 1).toUpperCase();
}

/** 子の表が「項目名と値の組」の形なら、その列を返す（形が合わなければ null） */
export function pivotSpecFor(meta: Pick<SheetMeta, "columns">, child: string): PivotSpec | null {
  const cols = meta.columns.filter((c) => c.child === child);
  const name = cols.find((c) => NAME_ATTR_RE.test(attrOf(c, child)));
  if (name === undefined) return null;
  const valueCols = VALUE_ATTRS.flatMap((a) => cols.filter((c) => attrOf(c, child) === a).map((c) => c.name));
  if (valueCols.length === 0) return null;
  return {
    child,
    nameCol: name.name,
    valueCols,
    unitCol: cols.find((c) => attrOf(c, child) === "MEASUREUNITID")?.name ?? null,
    sectionCol: cols.find((c) => attrOf(c, child) === "SECTION")?.name ?? null,
  };
}

function isEmpty(v: CellValue): boolean {
  return v === null || v === "";
}

/** 横持ちの列（1 項目。セクションがあればセクションごと） */
export interface PivotColumn {
  key: string;
  /** 項目名（ASSETATTRID の値） */
  attr: string;
  section: string | null;
  /** この項目の値を主に入れている列（数値の項目なら NUMVALUE） */
  valueCol: string;
  /** この項目の行にある単位（混ざっていれば複数） */
  units: string[];
  /** この項目の行がある親の数 */
  count: number;
}

/** 横持ちの 1 セル */
export interface PivotCell {
  /** 対応する縦持ちの行（無ければ null。重複していれば最初の行） */
  row: RowState | null;
  /** 値を読む・書く列。主の列が空で別の値の列に値があれば、その列 */
  valueCol: string;
  /** 主の列と違う列に値が入っている（数値の項目が文字で入っているなど） */
  otherColumn: boolean;
  /** 同じ親・同じ項目の行の数（2 以上は重複） */
  count: number;
}

export interface PivotRow {
  parentKey: string;
  /** 親の値を読む行（子の行には親の値も入っている） */
  parent: RowState;
  cells: Map<string, RowState[]>;
}

export interface PivotTable {
  columns: PivotColumn[];
  rows: PivotRow[];
}

/**
 * 縦持ちの行から横持ちの表を作る。rows はシートの行（ビューの行）。親は並びのまま 1 行ずつ、子の無い親も出す。
 * value はビューでの値（元の値ビューなら元の値）。
 */
export function buildPivot(rows: readonly RowState[], spec: PivotSpec, value: (row: RowState, col: string) => CellValue): PivotTable {
  const parents = new Map<string, PivotRow>();
  const columns = new Map<string, { attr: string; section: string | null; filled: Map<string, number>; units: Set<string>; parents: Set<string> }>();
  for (const row of rows) {
    let p = parents.get(row.parentKey);
    if (p === undefined) {
      p = { parentKey: row.parentKey, parent: row, cells: new Map() };
      parents.set(row.parentKey, p);
    }
    if (row.childName !== spec.child) continue;
    const name = value(row, spec.nameCol);
    if (isEmpty(name)) continue;
    const attr = String(name);
    const sectionValue = spec.sectionCol === null ? null : value(row, spec.sectionCol);
    const section = isEmpty(sectionValue) ? null : String(sectionValue);
    const key = section === null ? attr : `${attr}\u0000${section}`;
    let c = columns.get(key);
    if (c === undefined) {
      c = { attr, section, filled: new Map(), units: new Set(), parents: new Set() };
      columns.set(key, c);
    }
    c.parents.add(row.parentKey);
    for (const vc of spec.valueCols) if (!isEmpty(value(row, vc))) c.filled.set(vc, (c.filled.get(vc) ?? 0) + 1);
    if (spec.unitCol !== null) {
      const u = value(row, spec.unitCol);
      if (!isEmpty(u)) c.units.add(String(u));
    }
    const list = p.cells.get(key);
    if (list) list.push(row);
    else p.cells.set(key, [row]);
  }
  const out: PivotColumn[] = [];
  for (const [key, c] of columns) {
    // 値の入っている数がいちばん多い列を、この項目の値の列にする（同じ数なら候補の並び）
    let valueCol = spec.valueCols[0] as string;
    let best = -1;
    for (const vc of spec.valueCols) {
      const n = c.filled.get(vc) ?? 0;
      if (n > best) {
        best = n;
        valueCol = vc;
      }
    }
    out.push({ key, attr: c.attr, section: c.section, valueCol, units: [...c.units].sort(), count: c.parents.size });
  }
  // 多くの親にある項目を先に（同じなら項目名・セクションの順）
  out.sort((a, b) => b.count - a.count || a.attr.localeCompare(b.attr) || (a.section ?? "").localeCompare(b.section ?? ""));
  return { columns: out, rows: [...parents.values()] };
}

/** 横持ちの 1 セル（行が無ければ row は null） */
export function pivotCell(row: PivotRow, column: PivotColumn, spec: PivotSpec, value: (row: RowState, col: string) => CellValue): PivotCell {
  const list = row.cells.get(column.key) ?? [];
  const first = list[0] ?? null;
  if (first === null) return { row: null, valueCol: column.valueCol, otherColumn: false, count: 0 };
  let valueCol = column.valueCol;
  let otherColumn = false;
  if (isEmpty(value(first, valueCol))) {
    const other = spec.valueCols.find((vc) => vc !== valueCol && !isEmpty(value(first, vc)));
    if (other !== undefined) {
      valueCol = other;
      otherColumn = true;
    }
  }
  return { row: first, valueCol, otherColumn, count: list.length };
}

/**
 * 既定で横持ちにするか。形が合い（pivotSpecFor）、1 つの親に項目が何件もあり、項目名がほかの親でも繰り返し出て、
 * 列が多すぎないとき。作業の明細のように、行が 1 件ずつの出来事になっている表は縦持ちのまま。
 */
export function preferPivot(rows: readonly RowState[], spec: PivotSpec, value: (row: RowState, col: string) => CellValue): boolean {
  const names = new Set<string>();
  const parents = new Set<string>();
  let childRows = 0;
  for (const row of rows) {
    if (row.childName !== spec.child) continue;
    const name = value(row, spec.nameCol);
    if (isEmpty(name)) continue;
    childRows++;
    parents.add(row.parentKey);
    names.add(String(name));
  }
  if (childRows === 0) return true;
  const perParent = childRows / parents.size;
  // 項目名が繰り返し出る（項目の種類が行の数よりはっきり少ない）
  const repeats = names.size <= Math.max(1, childRows / 2) || parents.size === 1;
  return perParent >= 2 && repeats && names.size <= MAX_PIVOT_COLUMNS;
}
