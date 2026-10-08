// 子の表の横持ち（属性・値の形の表を、1 行 ＝ 1 親、1 列 ＝ 1 項目にして見せる）。純ロジック。
//
// Maximo の仕様（ASSETSPEC・LOCATIONSPEC・ITEMSPEC など）は、1 機器 × 1 項目 ＝ 1 行の縦持ちで返る。
// 人が読む・直すときは、機器を行、項目を列にした横持ちのほうが見やすい。
// - データは縦持ちのまま（反映・差分・取り消し・LLM のツールは縦持ちの行を単位に動く）。横持ちは見せ方だけ。
// - 横持ちのセルを直すと、対応する縦持ちの行の値の列（数値なら NUMVALUE、文字なら ALNVALUE）が変わる。
// - 縦持ちの行が無い項目のセルは空で、値を入れると縦持ちの行を足す。

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

// ---------------------------------------------------------------------------
// 分類による区別と、欠けのセルへの入力（段階 3）
//
// 分類ごとの項目は、読み込んだ「分類の仕様」のシート（親の列 CLASSSTRUCTUREID と、子の ASSETATTRID）から取る。
// 項目の型（数値・文字）は、読み込んだ「属性」のシート（ASSETATTRID と DATATYPE）があればそこから取る。
// どちらも作業画面に見えるシートなので、利用者と LLM が同じ定義を確かめられる。
// ---------------------------------------------------------------------------

/** 分類の定義を読むシートの口（Sheet の一部） */
export interface DefinitionSheet {
  meta: Pick<SheetMeta, "name" | "columns">;
  viewRows(view: "final"): readonly RowState[];
  finalValue(row: RowState, col: string): CellValue;
}

/** 分類 ID → その分類の項目（項目名 → 単位と表示順） */
export type ClassDefs = Map<string, Map<string, { unit: string | null; seq: number | null }>>;

const CLASS_COL = "CLASSSTRUCTUREID";

function upper(name: string): string {
  return name.toUpperCase();
}

/** 読み込んだシートの中から、分類の仕様（分類 ID ごとの項目）を作る。見つからなければ null */
export function findClassDefs(sheets: Iterable<DefinitionSheet>): ClassDefs | null {
  for (const sheet of sheets) {
    const cols = sheet.meta.columns;
    const classCol = cols.find((c) => c.child === undefined && upper(c.name) === CLASS_COL);
    if (classCol === undefined) continue;
    const children = [...new Set(cols.flatMap((c) => (c.child !== undefined ? [c.child] : [])))];
    // 分類の仕様の子（CLASSSPEC）で、ASSETATTRID を持つもの。
    // 資産のシートも「分類 ID ＋ ASSETATTRID のある子（ASSETSPEC）」の形なので、子の名前で見分ける
    const child = children.find((ch) => upper(ch) === "CLASSSPEC" && cols.some((c) => c.child === ch && upper(c.name) === `${upper(ch)}.ASSETATTRID`));
    if (child === undefined) continue;
    const attrCol = cols.find((c) => c.child === child && upper(c.name) === `${upper(child)}.ASSETATTRID`)?.name as string;
    const unitCol = cols.find((c) => c.child === child && upper(c.name) === `${upper(child)}.MEASUREUNITID`)?.name ?? null;
    const seqCol = cols.find((c) => c.child === child && upper(c.name) === `${upper(child)}.DISPLAYSEQUENCE`)?.name ?? null;
    const defs: ClassDefs = new Map();
    for (const row of sheet.viewRows("final")) {
      const cls = sheet.finalValue(row, classCol.name);
      if (isEmpty(cls)) continue;
      let attrs = defs.get(String(cls));
      if (attrs === undefined) defs.set(String(cls), (attrs = new Map()));
      if (row.childName !== child) continue;
      const attr = sheet.finalValue(row, attrCol);
      if (isEmpty(attr)) continue;
      const unit = unitCol === null ? null : sheet.finalValue(row, unitCol);
      const seq = seqCol === null ? null : sheet.finalValue(row, seqCol);
      attrs.set(String(attr), { unit: isEmpty(unit) ? null : String(unit), seq: typeof seq === "number" ? seq : null });
    }
    if (defs.size > 0) return defs;
  }
  return null;
}

/** 項目名 → データ型（ALN・NUMERIC・TABLE・DATE）。読み込んだ「属性」のシートから。見つからなければ空 */
export function findAttrTypes(sheets: Iterable<DefinitionSheet>): Map<string, string> {
  for (const sheet of sheets) {
    const cols = sheet.meta.columns.filter((c) => c.child === undefined);
    const attrCol = cols.find((c) => upper(c.name) === "ASSETATTRID");
    const typeCol = cols.find((c) => upper(c.name) === "DATATYPE");
    if (attrCol === undefined || typeCol === undefined) continue;
    const out = new Map<string, string>();
    for (const row of sheet.viewRows("final")) {
      const attr = sheet.finalValue(row, attrCol.name);
      const type = sheet.finalValue(row, typeCol.name);
      if (!isEmpty(attr) && !isEmpty(type)) out.set(String(attr), upper(String(type)));
    }
    if (out.size > 0) return out;
  }
  return new Map();
}

/** データ型から値の列の属性名 */
const TYPE_TO_VALUE_ATTR: Record<string, string> = { ALN: "ALNVALUE", NUMERIC: "NUMVALUE", TABLE: "TABLEVALUE", DATE: "DATEVALUE" };

/** 親の分類 ID の列（無ければ null） */
export function parentClassColumn(meta: Pick<SheetMeta, "columns">): string | null {
  return meta.columns.find((c) => c.child === undefined && upper(c.name) === CLASS_COL)?.name ?? null;
}

/** 横持ちのセルの状態。present: 行がある / missing: 分類にあるのに行が無い（欠け。値を入れると行を足す） / notInClass: 分類に無い項目 / unknown: 分類が分からない */
export type PivotCellState = "present" | "missing" | "notInClass" | "unknown";

export interface PivotClassInfo {
  defs: ClassDefs;
  /** 親の分類 ID の列 */
  classCol: string;
  attrTypes: Map<string, string>;
}

export function pivotCellState(row: PivotRow, column: PivotColumn, info: PivotClassInfo | null, value: (row: RowState, col: string) => CellValue): PivotCellState {
  if ((row.cells.get(column.key)?.length ?? 0) > 0) return "present";
  if (info === null) return "unknown";
  const cls = value(row.parent, info.classCol);
  if (isEmpty(cls)) return "unknown";
  const attrs = info.defs.get(String(cls));
  if (attrs === undefined) return "unknown";
  return attrs.has(column.attr) ? "missing" : "notInClass";
}

/**
 * 分類にあるのに、どの親にも行が無い項目も列にする（横持ちの表に出ている親の分類の項目だけ）。
 * 列の値の列は、属性の型 → 単位があれば数値 → 文字 の順で決める。
 */
export function addClassColumns(table: PivotTable, spec: PivotSpec, info: PivotClassInfo, value: (row: RowState, col: string) => CellValue): PivotTable {
  const have = new Set(table.columns.filter((c) => c.section === null).map((c) => c.attr));
  const extra = new Map<string, PivotColumn>();
  for (const row of table.rows) {
    const cls = value(row.parent, info.classCol);
    if (isEmpty(cls)) continue;
    const attrs = info.defs.get(String(cls));
    if (attrs === undefined) continue;
    for (const [attr, def] of attrs) {
      if (have.has(attr) || extra.has(attr)) continue;
      extra.set(attr, { key: attr, attr, section: null, valueCol: valueColumnFor(spec, attr, def.unit, info, null), units: def.unit ? [def.unit] : [], count: 0 });
    }
  }
  if (extra.size === 0) return table;
  return { rows: table.rows, columns: [...table.columns, ...[...extra.values()].sort((a, b) => a.attr.localeCompare(b.attr))] };
}

/** 新しく足す行の値の列（属性の型 → 横持ちの列で多く使われている列 → 単位があれば数値 → 文字） */
export function valueColumnFor(spec: PivotSpec, attr: string, unit: string | null, info: PivotClassInfo | null, column: PivotColumn | null): string {
  const byType = info?.attrTypes.get(attr);
  const fromType = byType === undefined ? undefined : spec.valueCols.find((c) => upper(c).endsWith(`.${TYPE_TO_VALUE_ATTR[byType] ?? ""}`));
  if (fromType !== undefined) return fromType;
  if (column !== null && column.count > 0) return column.valueCol;
  const num = spec.valueCols.find((c) => upper(c).endsWith(".NUMVALUE"));
  const aln = spec.valueCols.find((c) => upper(c).endsWith(".ALNVALUE"));
  return (unit !== null ? num : aln) ?? (spec.valueCols[0] as string);
}

/**
 * 欠けのセルに値を入れたときに足す行の値（子の列だけ）。項目名・値・単位（分類の仕様の単位）・分類 ID（子に列があれば）。
 * 分類が分からない・分類に無い項目なら null（足さない）
 */
export function newSpecRow(
  row: PivotRow,
  column: PivotColumn,
  spec: PivotSpec,
  info: PivotClassInfo,
  childColumns: readonly ColumnSchema[],
  newValue: CellValue,
  value: (row: RowState, col: string) => CellValue,
): Record<string, CellValue> | null {
  const cls = value(row.parent, info.classCol);
  if (isEmpty(cls)) return null;
  const def = info.defs.get(String(cls))?.get(column.attr);
  if (def === undefined) return null;
  const out: Record<string, CellValue> = { [spec.nameCol]: column.attr };
  out[valueColumnFor(spec, column.attr, def.unit, info, column)] = newValue;
  if (spec.unitCol !== null && def.unit !== null) out[spec.unitCol] = def.unit;
  const childClass = childColumns.find((c) => c.child === spec.child && upper(c.name) === `${upper(spec.child)}.${CLASS_COL}`);
  if (childClass !== undefined) out[childClass.name] = cls;
  return out;
}

/** 分類の見出し（階層パスと説明） */
export interface ClassLabel {
  path: string | null;
  description: string | null;
}

/**
 * 読み込んだ分類のシートから、分類 ID → 階層パス・説明 を作る。分類のシートは、親の列に CLASSSTRUCTUREID と
 * HIERARCHYPATH があるもの、または子に CLASSSPEC があるもの（資産のシートの DESCRIPTION は機器の説明なので使わない）
 */
export function findClassLabels(sheets: Iterable<DefinitionSheet>): Map<string, ClassLabel> {
  const out = new Map<string, ClassLabel>();
  for (const sheet of sheets) {
    const cols = sheet.meta.columns;
    const parent = (name: string) => cols.find((c) => c.child === undefined && upper(c.name) === name)?.name ?? null;
    const classCol = parent(CLASS_COL);
    if (classCol === null) continue;
    const pathCol = parent("HIERARCHYPATH");
    const isClassSheet = pathCol !== null || cols.some((c) => c.child !== undefined && upper(c.child) === "CLASSSPEC");
    if (!isClassSheet) continue;
    const descCol = parent("DESCRIPTION");
    for (const row of sheet.viewRows("final")) {
      const id = sheet.finalValue(row, classCol);
      if (isEmpty(id) || out.has(String(id))) continue;
      const path = pathCol === null ? null : sheet.finalValue(row, pathCol);
      const desc = descCol === null ? null : sheet.finalValue(row, descCol);
      out.set(String(id), { path: isEmpty(path) ? null : String(path), description: isEmpty(desc) ? null : String(desc) });
    }
  }
  return out;
}

/** 分類の列に出す文字。階層パス（分類コードをつないだもの）に説明を添える（例 MECH  ROT  PUMP（ポンプ））。無ければ説明、それも無ければ分類 ID */
export function classLabelText(id: CellValue, labels: ReadonlyMap<string, ClassLabel>): string {
  if (isEmpty(id)) return "";
  const label = labels.get(String(id));
  if (label?.path && label.description && !label.path.endsWith(label.description)) return `${label.path}（${label.description}）`;
  return label?.path ?? label?.description ?? String(id);
}
