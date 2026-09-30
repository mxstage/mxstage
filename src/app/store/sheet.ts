// シート 1 枚の内部表現。
//   base 行（Maximo / Excel から読んだ値。変更しない）、overlay（セル単位の変更）、追加行、削除の印を持ち、
//   最終ビュー（base + overlay）・差分ビュー（base と異なる行）・元の値ビュー（base）を返す。
// 変更の検査・バッチ・revision の採番は Workspace が行い、ここは状態の保持と読み出しに徹する。

import type { BatchAuthor, CellValue, ColumnSchema, SheetSummary } from "../../shared/model";
import type { MaximoRecord, SheetMeta, SheetRow } from "../../shared/sheet";
import { makeParentKey, parseRowKey } from "../../shared/sheet";
import { StoreError } from "./errors";
import { sameCellValue } from "./values";

export type ViewKind = "final" | "base" | "diff";
export type RowStatus = "base" | "changed" | "added" | "deleted";

/** セルの変更 1 件。作ったら書き換えない（取り消しで前の値に戻すときに参照を使い回すため） */
export interface CellOverlay {
  readonly value: CellValue;
  readonly batchId: string;
  readonly author: BatchAuthor;
  readonly revision: number;
  /** このセルだけの根拠（CellEdit.reason）。無ければバッチの reason を使う */
  readonly reason?: string;
}

/** 行の追加・削除の印 */
export interface RowMark {
  readonly batchId: string;
  readonly author: BatchAuthor;
  readonly revision: number;
}

export interface RowState {
  readonly rowKey: string;
  readonly parentKey: string;
  readonly childName: string | null;
  /** base の値。追加行では追加したときの値 */
  readonly base: Readonly<Record<string, CellValue>>;
  added: RowMark | null;
  deleted: RowMark | null;
  cells: Map<string, CellOverlay> | null;
  /** セルごとの最終変更 revision（取り消しも変更として数える）。compare-and-set に使う */
  cellRevs: Map<string, number> | null;
}

export interface CellInfo {
  value: CellValue;
  /** 元の値（追加行は null） */
  base: CellValue;
  changed: boolean;
  author: BatchAuthor | null;
  batchId: string | null;
  revision: number;
  /**
   * 根拠。Sheet.cell ではセル固有の根拠（CellEdit.reason）だけ、
   * Workspace.cell ではそれが無ければバッチの reason を入れる（作者バッジのツールチップ用）
   */
  reason: string | null;
}

export interface SheetCounts {
  rowCount: number;
  changedCells: number;
  addedRows: number;
  deletedRows: number;
}

export interface SheetJSON {
  id: number;
  meta: SheetMeta;
  createdRevision: number;
  newRowSeq: number;
  records: MaximoRecord[];
  baseRows: SheetRow[];
  addedRows: Array<SheetRow & { added: RowMark }>;
  rowMarks: Array<{
    rowKey: string;
    deleted?: RowMark;
    cells?: Array<[string, CellOverlay]>;
    cellRevs?: Array<[string, number]>;
  }>;
  /** 親キー → 同じ親の行の構成が最後に変わった revision（古い形式には無い） */
  groupRevs?: Array<[string, number]>;
}

function newRowState(r: SheetRow, added: RowMark | null): RowState {
  // 列名が "constructor" などでも Object.prototype の値を拾わないよう、プロトタイプの無いオブジェクトに写す
  const base = Object.create(null) as Record<string, CellValue>;
  for (const [k, v] of Object.entries(r.values)) base[k] = v;
  return {
    rowKey: r.rowKey,
    parentKey: r.parentKey,
    childName: r.childName,
    base,
    added,
    deleted: null,
    cells: null,
    cellRevs: null,
  };
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** meta は JSON にできる値だけなので JSON で複製し、凍結する */
function cloneFrozen(meta: SheetMeta): SheetMeta {
  return deepFreeze(JSON.parse(JSON.stringify(meta)) as SheetMeta);
}

/**
 * 行キーの形の検査。親の列の変更は同じ親キーの行すべてに反映するので、親キーの誤りは別の行の書き換えになる。
 * - 親だけの行: 行キー = 親キー（子の区切り # を含まない）
 * - 子の行: makeChildRowKey(親キー, 子オブジェクト名, 子 ID) の形
 */
function checkRowShape(r: SheetRow): void {
  const bad = (why: string) => new StoreError("invalid_args", `Invalid key for row ${String(r.rowKey)} (${why})`, { rowKey: r.rowKey });
  if (typeof r.rowKey !== "string" || r.rowKey === "" || typeof r.parentKey !== "string") throw bad("the row key and parent key must be non-empty strings");
  const p = parseRowKey(r.rowKey);
  if (r.childName === null) {
    if (r.rowKey !== r.parentKey || p.childName !== null) throw bad("a parent-only row must have the same row key and parent key");
  } else if (p.parentKey !== r.parentKey || p.childName !== r.childName) {
    throw bad("child row keys must be made with makeChildRowKey(parent key, child object name, child ID)");
  }
}

export class Sheet {
  readonly id: number;
  readonly meta: SheetMeta;
  /** このシートを作った revision。これより前に読んだ値はすべて古い */
  readonly createdRevision: number;
  readonly records: readonly MaximoRecord[];
  /** 新しい行のキーに使う連番（取り消しても戻さない） */
  newRowSeq = 1;

  private readonly columnMap = new Map<string, ColumnSchema>();
  private readonly columnOrder = new Map<string, number>();
  private readonly protectedCols = new Set<string>();
  private readonly childNameSet = new Set<string>();
  private readonly baseRows: RowState[] = [];
  private addedRows: RowState[] = [];
  private readonly byKey = new Map<string, RowState>();
  private readonly byParent = new Map<string, RowState[]>();
  private recordMap: Map<string, MaximoRecord> | null = null;
  /** 親キー → 同じ親の行の追加・削除（とその取り消し）の最終 revision */
  private readonly groupRevs = new Map<string, number>();

  private structureVersion = 0;
  private dataVersion = 0;
  private orderCache: { version: number; rows: RowState[] } | null = null;
  private readonly viewCache = new Map<ViewKind, { version: string; rows: RowState[] }>();
  private countsCache: { version: string; counts: SheetCounts } | null = null;

  constructor(id: number, meta: SheetMeta, rows: readonly SheetRow[], records: readonly MaximoRecord[], createdRevision: number) {
    this.id = id;
    // 呼び出し元が後から meta を書き換えても列の索引と食い違わないよう、複製して凍結する
    this.meta = cloneFrozen(meta);
    this.createdRevision = createdRevision;
    this.records = records;
    this.meta.columns.forEach((c, i) => {
      // "__proto__" は値のオブジェクトに代入するとプロトタイプの差し替えになるので列名に使わせない
      if (typeof c.name !== "string" || c.name === "" || c.name === "__proto__") {
        throw new StoreError("invalid_args", `The column name ${String(c.name)} cannot be used`, { column: c.name });
      }
      if (this.columnMap.has(c.name)) throw new StoreError("invalid_args", `Duplicate column ${c.name}`, { column: c.name });
      this.columnMap.set(c.name, c);
      this.columnOrder.set(c.name, i);
      if (c.readOnly) this.protectedCols.add(c.name);
      if (c.child) this.childNameSet.add(c.child);
    });
    for (const k of meta.keyColumns) {
      if (!this.columnMap.has(k)) throw new StoreError("invalid_args", `Key column ${k} is not a column`, { column: k });
      this.protectedCols.add(k);
    }
    for (const [child, idAttr] of Object.entries(meta.childIdAttrs)) {
      this.childNameSet.add(child);
      // 子を特定する属性は行キーの一部なので変更させない
      if (idAttr !== null) this.protectedCols.add(`${child}.${idAttr}`);
    }
    for (const r of rows) {
      checkRowShape(r);
      if (this.byKey.has(r.rowKey)) throw new StoreError("invalid_args", `Duplicate row key ${r.rowKey}`, { rowKey: r.rowKey });
      const st = newRowState(r, null);
      this.baseRows.push(st);
      this.index(st);
    }
  }

  get name(): string {
    return this.meta.name;
  }

  // ---------------------------------------------------------------------------
  // 列
  // ---------------------------------------------------------------------------

  column(name: string): ColumnSchema | undefined {
    return this.columnMap.get(name);
  }

  hasColumn(name: string): boolean {
    return this.columnMap.has(name);
  }

  /** readOnly・キー列・子の ID 列 */
  isProtectedColumn(name: string): boolean {
    return this.protectedCols.has(name);
  }

  /** 親の列（子オブジェクトに属さない列）。同じ親の行はこの列の値を共有する */
  isParentColumn(name: string): boolean {
    const c = this.columnMap.get(name);
    return c !== undefined && !c.child;
  }

  childNames(): string[] {
    return Array.from(this.childNameSet);
  }

  columnIndex(name: string): number {
    return this.columnOrder.get(name) ?? -1;
  }

  // ---------------------------------------------------------------------------
  // 行と値
  // ---------------------------------------------------------------------------

  row(rowKey: string): RowState | undefined {
    return this.byKey.get(rowKey);
  }

  /** 同じ親キーの行（削除の印が付いた行も含む） */
  group(parentKey: string): readonly RowState[] {
    return this.byParent.get(parentKey) ?? [];
  }

  /**
   * 親キーに対応する Maximo の親レコード（href・rowstamp を書き込みエンジンが使う）。
   * 親キーの作り方は maximo/load の parentKeyOf と同じにする。
   * キー列が決まらなかったシートは href が親キーなので、キー値から作ると引き当てられない。
   */
  record(parentKey: string): MaximoRecord | undefined {
    if (this.recordMap === null) {
      this.recordMap = new Map();
      const keys = this.meta.keyColumns;
      for (const rec of this.records) {
        this.recordMap.set(keys.length === 0 ? rec.href : makeParentKey(keys.map((k) => rec.attrs[k.toUpperCase()] ?? null)), rec);
      }
    }
    return this.recordMap.get(parentKey);
  }

  finalValue(row: RowState, col: string): CellValue {
    const e = row.cells?.get(col);
    if (e !== undefined) return e.value;
    return row.base[col] ?? null;
  }

  baseValue(row: RowState, col: string): CellValue {
    return row.added ? null : (row.base[col] ?? null);
  }

  /** ビューでの値。差分ビューの削除行は元の値を返す */
  viewValue(row: RowState, col: string, view: ViewKind): CellValue {
    if (view === "base") return this.baseValue(row, col);
    if (view === "diff" && row.deleted) return row.base[col] ?? null;
    return this.finalValue(row, col);
  }

  /** セルの最終変更 revision（シートの作成・行の追加を含む） */
  cellRevision(row: RowState, col: string): number {
    return Math.max(this.createdRevision, row.added?.revision ?? 0, row.cellRevs?.get(col) ?? 0);
  }

  /** 行のいずれかのセルの最終変更 revision */
  rowRevision(row: RowState): number {
    let rev = Math.max(this.createdRevision, row.added?.revision ?? 0);
    if (row.cellRevs) for (const r of row.cellRevs.values()) rev = Math.max(rev, r);
    return rev;
  }

  /** 同じ親の行の構成（行の追加・削除とその取り消し）が最後に変わった revision（シートの作成を含む）。子の追加の compare-and-set に使う */
  groupRevision(parentKey: string): number {
    return Math.max(this.createdRevision, this.groupRevs.get(parentKey) ?? 0);
  }

  private touchGroup(parentKey: string, revision: number | null): void {
    if (revision !== null) this.groupRevs.set(parentKey, Math.max(revision, this.groupRevs.get(parentKey) ?? 0));
  }

  isCellChanged(row: RowState, col: string): boolean {
    if (row.added) return false;
    const e = row.cells?.get(col);
    return e !== undefined && !sameCellValue(e.value, row.base[col] ?? null);
  }

  changedColumns(row: RowState): string[] {
    if (row.added || !row.cells) return [];
    const cols: string[] = [];
    for (const [col, e] of row.cells) if (!sameCellValue(e.value, row.base[col] ?? null)) cols.push(col);
    return cols.sort((a, b) => this.columnIndex(a) - this.columnIndex(b));
  }

  /** 行の状態。追加した後に削除した行は、どのビューにも出さないので null */
  rowStatus(row: RowState): RowStatus | null {
    if (row.added) return row.deleted ? null : "added";
    if (row.deleted) return "deleted";
    if (row.cells) for (const [col, e] of row.cells) if (!sameCellValue(e.value, row.base[col] ?? null)) return "changed";
    return "base";
  }

  /**
   * 表示順の全行。base の順に並べ、追加行は同じ親の最後の base 行の直後に置く。
   * base に親が無い追加行（新しい親とその子）は末尾に親ごとにまとめる。
   */
  orderedRows(): readonly RowState[] {
    if (this.orderCache && this.orderCache.version === this.structureVersion) return this.orderCache.rows;
    let rows: RowState[];
    if (this.addedRows.length === 0) {
      rows = this.baseRows;
    } else {
      const lastBaseIndex = new Map<string, number>();
      this.baseRows.forEach((r, i) => lastBaseIndex.set(r.parentKey, i));
      const after = new Map<number, RowState[]>();
      const tail = new Map<string, RowState[]>();
      for (const r of this.addedRows) {
        const i = lastBaseIndex.get(r.parentKey);
        if (i !== undefined) {
          const list = after.get(i);
          if (list) list.push(r);
          else after.set(i, [r]);
        } else {
          const list = tail.get(r.parentKey);
          if (list) list.push(r);
          else tail.set(r.parentKey, [r]);
        }
      }
      rows = [];
      this.baseRows.forEach((r, i) => {
        rows.push(r);
        const list = after.get(i);
        if (list) rows.push(...list);
      });
      for (const list of tail.values()) rows.push(...list);
    }
    this.orderCache = { version: this.structureVersion, rows };
    return rows;
  }

  private versionTag(): string {
    return `${this.structureVersion}:${this.dataVersion}`;
  }

  viewRows(view: ViewKind): readonly RowState[] {
    const version = this.versionTag();
    const cached = this.viewCache.get(view);
    if (cached && cached.version === version) return cached.rows;
    let rows: RowState[];
    switch (view) {
      case "base":
        rows = this.baseRows;
        break;
      case "final":
        rows = this.orderedRows().filter((r) => !r.deleted);
        break;
      case "diff":
        rows = this.orderedRows().filter((r) => {
          const s = this.rowStatus(r);
          return s !== null && s !== "base";
        });
        break;
    }
    this.viewCache.set(view, { version, rows });
    return rows;
  }

  counts(): SheetCounts {
    const version = this.versionTag();
    if (this.countsCache && this.countsCache.version === version) return this.countsCache.counts;
    const counts: SheetCounts = { rowCount: 0, changedCells: 0, addedRows: 0, deletedRows: 0 };
    for (const r of this.orderedRows()) {
      if (!r.deleted) counts.rowCount++;
      const s = this.rowStatus(r);
      if (s === "added") counts.addedRows++;
      else if (s === "deleted") counts.deletedRows++;
      else if (s === "changed") counts.changedCells += this.changedColumns(r).length;
    }
    this.countsCache = { version, counts };
    return counts;
  }

  summary(): SheetSummary {
    const c = this.counts();
    return {
      name: this.meta.name,
      source: this.meta.source,
      rowCount: c.rowCount,
      columns: this.meta.columns,
      keyColumns: this.meta.keyColumns,
      changedCells: c.changedCells,
      addedRows: c.addedRows,
      deletedRows: c.deletedRows,
    };
  }

  // ---------------------------------------------------------------------------
  // グリッド向けの読み出し（RowState を書き換えさせないため値をコピーして返す）
  // ---------------------------------------------------------------------------

  rowKeys(view: ViewKind): string[] {
    return this.viewRows(view).map((r) => r.rowKey);
  }

  rowInfo(rowKey: string): { rowKey: string; parentKey: string; childName: string | null; status: RowStatus | null } | null {
    const r = this.byKey.get(rowKey);
    if (!r) return null;
    return { rowKey: r.rowKey, parentKey: r.parentKey, childName: r.childName, status: this.rowStatus(r) };
  }

  rowValues(rowKey: string, view: ViewKind = "final"): Record<string, CellValue> | null {
    const r = this.byKey.get(rowKey);
    if (!r) return null;
    const out: Record<string, CellValue> = {};
    for (const c of this.meta.columns) out[c.name] = this.viewValue(r, c.name, view);
    return out;
  }

  cell(rowKey: string, col: string): CellInfo | null {
    const r = this.byKey.get(rowKey);
    if (!r || !this.columnMap.has(col)) return null;
    const e = r.cells?.get(col);
    return {
      value: this.finalValue(r, col),
      base: this.baseValue(r, col),
      changed: this.isCellChanged(r, col),
      author: e?.author ?? r.added?.author ?? null,
      batchId: e?.batchId ?? r.added?.batchId ?? null,
      revision: this.cellRevision(r, col),
      reason: e?.reason ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // 状態の変更（Workspace だけが呼ぶ）
  // ---------------------------------------------------------------------------

  /** entry が null なら overlay を外して base の値に戻す。どちらの場合も revision を記録する */
  setCell(row: RowState, col: string, entry: CellOverlay | null, revision: number): void {
    if (entry) {
      (row.cells ??= new Map()).set(col, entry);
    } else if (row.cells) {
      row.cells.delete(col);
      if (row.cells.size === 0) row.cells = null;
    }
    (row.cellRevs ??= new Map()).set(col, revision);
    this.dataVersion++;
  }

  /** revision が null なら同じ親の構成の revision を記録しない（復元用） */
  insertAdded(row: RowState, revision: number | null): void {
    if (this.byKey.has(row.rowKey)) throw new StoreError("invalid_args", `Row key ${row.rowKey} already exists`, { rowKey: row.rowKey });
    this.addedRows.push(row);
    this.index(row);
    this.touchGroup(row.parentKey, revision);
    this.structureVersion++;
  }

  removeAdded(row: RowState, revision: number): void {
    this.touchGroup(row.parentKey, revision);
    this.addedRows = this.addedRows.filter((r) => r !== row);
    this.byKey.delete(row.rowKey);
    const g = this.byParent.get(row.parentKey);
    if (g) {
      const rest = g.filter((r) => r !== row);
      if (rest.length > 0) this.byParent.set(row.parentKey, rest);
      else this.byParent.delete(row.parentKey);
    }
    this.structureVersion++;
  }

  setDeleted(row: RowState, mark: RowMark | null, revision: number): void {
    row.deleted = mark;
    this.touchGroup(row.parentKey, revision);
    this.dataVersion++;
  }

  static newAddedRow(r: SheetRow, mark: RowMark): RowState {
    return newRowState(r, mark);
  }

  private index(row: RowState): void {
    this.byKey.set(row.rowKey, row);
    const g = this.byParent.get(row.parentKey);
    if (g) g.push(row);
    else this.byParent.set(row.parentKey, [row]);
  }

  // ---------------------------------------------------------------------------
  // 直列化
  // ---------------------------------------------------------------------------

  toJSON(): SheetJSON {
    const toSheetRow = (r: RowState): SheetRow => ({ rowKey: r.rowKey, parentKey: r.parentKey, childName: r.childName, values: { ...r.base } });
    const rowMarks: SheetJSON["rowMarks"] = [];
    for (const r of [...this.baseRows, ...this.addedRows]) {
      if (!r.deleted && !r.cells && !r.cellRevs) continue;
      const m: SheetJSON["rowMarks"][number] = { rowKey: r.rowKey };
      if (r.deleted) m.deleted = r.deleted;
      if (r.cells) m.cells = Array.from(r.cells.entries());
      if (r.cellRevs) m.cellRevs = Array.from(r.cellRevs.entries());
      rowMarks.push(m);
    }
    const addedRows: SheetJSON["addedRows"] = [];
    for (const r of this.addedRows) if (r.added) addedRows.push({ ...toSheetRow(r), added: r.added });
    return {
      id: this.id,
      meta: this.meta,
      createdRevision: this.createdRevision,
      newRowSeq: this.newRowSeq,
      records: [...this.records],
      baseRows: this.baseRows.map(toSheetRow),
      addedRows,
      rowMarks,
      groupRevs: Array.from(this.groupRevs.entries()),
    };
  }

  static fromJSON(json: SheetJSON): Sheet {
    const sheet = new Sheet(json.id, json.meta, json.baseRows, json.records, json.createdRevision);
    sheet.newRowSeq = json.newRowSeq;
    // overlay・印は取り消しで参照を使い回すので、作ったときと同じく凍結する
    for (const a of json.addedRows) sheet.insertAdded(newRowState(a, Object.freeze({ ...a.added })), null);
    for (const m of json.rowMarks) {
      const r = sheet.byKey.get(m.rowKey);
      if (!r) throw new StoreError("invalid_args", `Row ${m.rowKey} of the restore data is missing`, { rowKey: m.rowKey });
      r.deleted = m.deleted ? Object.freeze({ ...m.deleted }) : null;
      r.cells = m.cells ? new Map(m.cells.map(([col, e]) => [col, Object.freeze({ ...e })])) : null;
      r.cellRevs = m.cellRevs ? new Map(m.cellRevs) : null;
    }
    for (const [parentKey, rev] of json.groupRevs ?? []) sheet.groupRevs.set(parentKey, rev);
    sheet.dataVersion++;
    return sheet;
  }
}
