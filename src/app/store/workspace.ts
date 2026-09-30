// 作業タブのデータストア（正本）。
//   シート・バッチ・revision・変更通知を持ち、LLM と利用者の変更を compare-and-set で適用する。
//   UI やネットワークに依存しない純 TypeScript。

import type {
  ApplyResult,
  BatchAuthor,
  BatchInfo,
  CellEdit,
  CellValue,
  ConflictInfo,
  DiffEntry,
  LookupStats,
  MatchSummary,
  NormalizeOption,
  RuleValue,
  SheetSummary,
  TypedFilter,
} from "../../shared/model";
import type { BatchRecord, MaximoRecord, OverlayOp, SheetMeta, SheetRow } from "../../shared/sheet";
import { makeChildRowKey, makeParentKey, NEW_CHILD_PREFIX } from "../../shared/sheet";
import { StoreError } from "./errors";
import { compileFilters } from "./filters";
import { randomHex } from "./ids";
import { JobRegistry } from "./jobs";
import { normalizeCompositeKey } from "./normalize";
import { checkLimit, paginate } from "./paging";
import { Sheet, type CellInfo, type CellOverlay, type RowMark, type RowState, type RowStatus, type SheetJSON, type ViewKind } from "./sheet";
import { coerceValue, isBlank, sameCellValue } from "./values";

// ---------------------------------------------------------------------------
// 公開型
// ---------------------------------------------------------------------------

export type ChangeKind =
  | "sheet_created"
  | "sheet_removed"
  | "cells_changed"
  | "rows_added"
  | "rows_deleted"
  | "batch_undone"
  | "editing_changed"
  | "workspace_renamed";

export interface ChangeEvent {
  revision: number;
  sheet: string | null;
  kind: ChangeKind;
  batchId?: string;
}

export type ChangeListener = (event: ChangeEvent) => void;

export interface EditOptions {
  author: BatchAuthor;
  reason?: string;
  /** 直前に読んだ revision。省略すると changed_since_read を検査しない（グリッドの直接編集用） */
  baseRevision?: number;
}

export interface RuleOptions extends EditOptions {
  /** true なら変更せず件数と conflicts だけ返す */
  dryRun?: boolean;
}

export interface AddRowsOptions extends EditOptions {
  /** 子行として追加するときの親の行キー（親行・子行のどちらでもよい） */
  parentRowKey?: string;
  /** 子オブジェクト名。省略時は parentRowKey の子行・シートの子が 1 種類ならそれ・入力の子の列から決める */
  childName?: string;
}

export interface UndoOptions {
  /** 取り消しを実行する人（省略時は利用者）。llm なら利用者が編集中のセル・行は取り消さず user_editing にする */
  author?: BatchAuthor;
}

/**
 * apply_rule の結果。lookup を使った列は ApplyResult.lookup に列ごとの突合件数を入れる
 * （unmatched は変更せずスキップ、ambiguous は変更せず conflicts に lookup_ambiguous で載せる）。
 */
export interface RuleResult extends ApplyResult {
  /** 条件に合った行数 */
  matched: number;
}

export interface QueryRowsOptions {
  filter?: readonly TypedFilter[];
  columns?: readonly string[];
  view?: ViewKind;
  limit?: number;
  cursor?: string;
}

export interface QueryRow {
  rowKey: string;
  values: Record<string, CellValue>;
  /** 差分ビューのときだけ付ける */
  status?: RowStatus;
  changedColumns?: string[];
}

export interface QueryRowsResult {
  rows: QueryRow[];
  nextCursor: string | null;
  revision: number;
  total: number;
}

export interface AggregateOptions {
  groupBy: readonly string[];
  filter?: readonly TypedFilter[];
  limit?: number;
}

export interface AggregateResult {
  groups: Array<{ key: Record<string, CellValue>; count: number }>;
  totalGroups: number;
  revision: number;
}

/**
 * 差分の 1 件。
 * - change: セルの変更（col・before・after）
 * - add: 追加行 1 行（col は "*"、values に null 以外の値）
 * - delete: 削除行 1 行（col は "*"、values にキー列と子の ID）
 */
export interface DiffItem extends DiffEntry {
  kind: "change" | "add" | "delete";
  values?: Record<string, CellValue>;
  /** 根拠。セル固有の根拠（CellEdit.reason）、無ければバッチの reason */
  reason?: string;
}

export interface DiffOptions {
  limit?: number;
  cursor?: string;
}

export interface DiffResult {
  changedCells: number;
  addedRows: number;
  deletedRows: number;
  /** entries の総数（ページングの目安） */
  total: number;
  entries: DiffItem[];
  nextCursor: string | null;
  revision: number;
}

export interface WorkspaceStatus {
  workspace: string;
  revision: number;
  sheets: SheetSummary[];
}

export interface EditingCell {
  sheet: string;
  rowKey: string;
  col: string;
}

export interface WorkspaceOptions {
  now?: () => number;
}

/**
 * Maximo への反映に使う差分の全件（getDiff と違ってページングせず、作者・根拠を付けない）。
 * maximo/commit の CommitChanges と同じ形。
 */
export interface SheetChanges {
  /**
   * Base と異なる最終値のセル。削除の印が付いた行のセルは含めないが、
   * 親の列の変更だけは同じ親に残っている行に付け替えて含める（親の列は同じ親の行で共有するため）
   */
  cells: Array<{ rowKey: string; col: string; value: CellValue }>;
  /** 追加行（追加した後に削除した行は含めない）。values は全列の最終値 */
  addedRows: Array<{ rowKey: string; parentKey: string; childName: string | null; values: Record<string, CellValue> }>;
  /** 削除の印が付いた既存の行 */
  deletedRows: string[];
  /**
   * 行がすべて削除された親に残った親の列の変更（付け替える先の行が無いので cells に入れられない）。
   * 親行の削除は書き込みエンジンが未対応なので反映できない。黙って捨てず、反映パネルの blockers に出す
   */
  unwritableParentEdits: Array<{ parentKey: string; columns: string[] }>;
}

/** replaceParents の 1 件: 親キーと、Maximo から読み直した親レコード・その親の行 */
export interface ParentReplacement {
  parentKey: string;
  record: MaximoRecord;
  rows: readonly SheetRow[];
}

export interface ReplaceParentsOptions {
  /** 反映を始めたときのシート ID。違えば（シートが読み込み直されていれば）何も置き換えない */
  sheetId?: number;
  /** この revision より後に同じ親の行が変わっていれば、その親は置き換えない */
  unchangedSince?: number;
}

export interface ReplaceParentsResult {
  replaced: string[];
  skipped: Array<{ parentKey: string; reason: "sheet_replaced" | "changed_since" | "invalid_rows" }>;
  revision: number;
}

/** バッチの操作 1 件と、取り消しに必要な内部情報 */
export interface BatchOpState {
  op: OverlayOp;
  /** set のとき、適用前の overlay（無ければ null） */
  prevEntry?: CellOverlay | null;
  /** set のとき、セル固有の根拠（CellEdit.reason） */
  reason?: string;
  reverted: boolean;
}

export const WORKSPACE_FORMAT = "mxstage.workspace.v1";

export interface WorkspaceJSON {
  format: typeof WORKSPACE_FORMAT;
  name: string;
  revision: number;
  sheetSeq: number;
  batchSeq: number;
  sheets: SheetJSON[];
  batches: Array<{ record: Omit<BatchRecord, "ops">; sheetId: number; revision: number; ops: BatchOpState[] }>;
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

interface BatchEntry {
  record: BatchRecord;
  sheetId: number;
  revision: number;
  ops: BatchOpState[];
}

type RuleEval = { kind: "value"; value: CellValue } | { kind: "unmatched" } | { kind: "ambiguous" };

interface CompiledRule {
  col: string;
  kind: "const" | "copyFrom" | "lookup";
  evaluate: (row: RowState) => RuleEval;
}

type RowPlan = { op: Extract<OverlayOp, { kind: "addRow" }> } | { conflict: ConflictInfo };

/** 適用前の操作と、セル固有の根拠（set のときだけ） */
interface PlannedOp {
  op: OverlayOp;
  reason?: string;
}

const DEFAULT_LIMIT = 50;
const DEFAULT_EXTRA_COLUMNS = 10;
const MAX_CANDIDATES = 10;

function checkAuthor(author: unknown): void {
  if (author !== "user" && author !== "llm") {
    throw new StoreError("invalid_args", "author は user か llm にしてください");
  }
}

function checkEditOptions(opts: EditOptions, revision: number): void {
  checkAuthor(opts.author);
  if (opts.baseRevision !== undefined && (!Number.isSafeInteger(opts.baseRevision) || opts.baseRevision < 0)) {
    throw new StoreError("invalid_args", "baseRevision は 0 以上の整数にしてください", { baseRevision: opts.baseRevision });
  }
  // 現在より新しい revision は読めないはず。タブを開き直して revision が 0 から数え直された後に古い値を渡されると、
  // どのセルも「読んだ後に変わっていない」と判定されて compare-and-set が効かなくなるので受け付けない
  if (opts.baseRevision !== undefined && opts.baseRevision > revision) {
    throw new StoreError("invalid_args", `baseRevision ${opts.baseRevision} は現在の revision ${revision} より新しいです。get_status か query_rows で読み直してください`, {
      baseRevision: opts.baseRevision,
      revision,
    });
  }
}

/** バッチの操作は取り消しで参照するので凍結する（toJSON の結果を書き換えられても内部が壊れないように） */
function freezeOp(op: OverlayOp): OverlayOp {
  if (op.kind === "addRow") Object.freeze(op.values);
  return Object.freeze(op);
}

function columnNotFound(col: string, sheet: string): StoreError {
  return new StoreError("column_not_found", `列 ${col} はシート ${sheet} にありません`, { column: col, sheet });
}

/** 突合列（文字列または配列）を列名の配列にする */
function columnList(v: string | readonly string[], name: string): string[] {
  const list = typeof v === "string" ? [v] : Array.isArray(v) ? [...v] : [];
  if (list.length === 0 || list.some((c) => typeof c !== "string" || c === "")) {
    throw new StoreError("invalid_args", `${name} には 1 列以上の列名を指定してください`, { [name]: v });
  }
  return list;
}

/** 複合キーの両側の列。同じ個数でなければ invalid_args */
function pairColumns(a: string | readonly string[], b: string | readonly string[], nameA: string, nameB: string): [string[], string[]] {
  const la = columnList(a, nameA);
  const lb = columnList(b, nameB);
  if (la.length !== lb.length) {
    throw new StoreError("invalid_args", `${nameA} と ${nameB} は同じ順・同じ個数の列にしてください（${la.length} 列と ${lb.length} 列）`, {
      [nameA]: la,
      [nameB]: lb,
    });
  }
  return [la, lb];
}

function mustRow(sheet: Sheet, rowKey: string): RowState {
  const row = sheet.row(rowKey);
  if (!row) throw new Error(`internal: row ${rowKey} disappeared`);
  return row;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export class Workspace {
  readonly jobs: JobRegistry;

  private _name: string;
  private _revision = 0;
  private readonly sheetMap = new Map<string, Sheet>();
  private batchList: BatchEntry[] = [];
  private readonly batchMap = new Map<string, BatchEntry>();
  private readonly listeners = new Set<ChangeListener>();
  private editing: EditingCell | null = null;
  private sheetSeq = 0;
  private batchSeq = 0;
  private readonly now: () => number;

  constructor(name: string, opts: WorkspaceOptions = {}) {
    this._name = name;
    this.now = opts.now ?? Date.now;
    this.jobs = new JobRegistry({ now: this.now });
  }

  get name(): string {
    return this._name;
  }

  get revision(): number {
    return this._revision;
  }

  get sheets(): ReadonlyMap<string, Sheet> {
    return this.sheetMap;
  }

  /** 現在のシートに対するバッチ（取り消し済みを含む、古い順） */
  get batches(): readonly BatchRecord[] {
    // undone を外から書き換えられないよう浅い複製を返す（ops は凍結済み）
    return this.batchList.map((b) => ({ ...b.record }));
  }

  rename(name: string): void {
    if (name === this._name) return;
    this._name = name;
    this.emit({ revision: this._revision, sheet: null, kind: "workspace_renamed" });
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ChangeEvent): void {
    for (const l of Array.from(this.listeners)) {
      try {
        l(event);
      } catch {
        // 通知先の例外でストアの処理を止めない
      }
    }
  }

  status(): WorkspaceStatus {
    return { workspace: this._name, revision: this._revision, sheets: Array.from(this.sheetMap.values(), (s) => s.summary()) };
  }

  hasSheet(name: string): boolean {
    return this.sheetMap.has(name);
  }

  getSheet(name: string): Sheet {
    const s = this.sheetMap.get(name);
    if (!s) throw new StoreError("sheet_not_found", `シート ${name} はありません。get_status でシート名を確認してください`, { sheet: name });
    return s;
  }

  summary(sheet: string): SheetSummary {
    return this.getSheet(sheet).summary();
  }

  /** セルの状態。reason はセル固有の根拠、無ければそのセルを最後に変えたバッチ（追加行は追加したバッチ）の reason */
  cell(sheetName: string, rowKey: string, col: string): CellInfo | null {
    const info = this.getSheet(sheetName).cell(rowKey, col);
    if (info === null) return null;
    if (info.reason === null && info.batchId !== null) info.reason = this.batchReason(info.batchId) ?? null;
    return info;
  }

  private batchReason(batchId: string): string | undefined {
    return this.batchMap.get(batchId)?.record.reason;
  }

  listBatches(sheet?: string): BatchInfo[] {
    return this.batchList
      .filter((b) => sheet === undefined || b.record.sheet === sheet)
      .map((b) => {
        const info: BatchInfo = {
          batchId: b.record.batchId,
          author: b.record.author,
          createdAt: b.record.createdAt,
          opCount: b.record.ops.length,
          sheet: b.record.sheet,
          undone: b.record.undone,
        };
        if (b.record.reason !== undefined) info.reason = b.record.reason;
        return info;
      });
  }

  // ---------------------------------------------------------------------------
  // シート
  // ---------------------------------------------------------------------------

  /** シートを作る。同名のシートは置き換え、そのシートのバッチ（取り消し履歴）も捨てる */
  createSheet(meta: SheetMeta, rows: readonly SheetRow[], records: readonly MaximoRecord[] = []): SheetSummary {
    const revision = this._revision + 1;
    const sheet = new Sheet(this.sheetSeq + 1, meta, rows, records, revision);
    this.sheetSeq = sheet.id;
    this._revision = revision;
    const old = this.sheetMap.get(meta.name);
    if (old) this.dropBatches(old.id);
    if (this.editing?.sheet === meta.name) this.editing = null;
    this.sheetMap.set(meta.name, sheet);
    this.emit({ revision, sheet: meta.name, kind: "sheet_created" });
    return sheet.summary();
  }

  removeSheet(name: string): boolean {
    const old = this.sheetMap.get(name);
    if (!old) return false;
    this.sheetMap.delete(name);
    this.dropBatches(old.id);
    if (this.editing?.sheet === name) this.editing = null;
    this._revision++;
    this.emit({ revision: this._revision, sheet: name, kind: "sheet_removed" });
    return true;
  }

  private dropBatches(sheetId: number): void {
    this.batchList = this.batchList.filter((b) => {
      if (b.sheetId !== sheetId) return true;
      this.batchMap.delete(b.record.batchId);
      return false;
    });
  }

  /** 利用者がグリッドで編集中のセル。col が null なら解除。LLM の変更はこのセルを user_editing にする */
  setEditingCell(sheet: string, rowKey: string | null, col: string | null): void {
    const next = rowKey !== null && col !== null ? { sheet, rowKey, col } : null;
    const cur = this.editing;
    if (cur === null && next === null) return;
    if (cur && next && cur.sheet === next.sheet && cur.rowKey === next.rowKey && cur.col === next.col) return;
    this.editing = next;
    this.emit({ revision: this._revision, sheet, kind: "editing_changed" });
  }

  getEditingCell(): EditingCell | null {
    return this.editing ? { ...this.editing } : null;
  }

  // ---------------------------------------------------------------------------
  // 変更
  // ---------------------------------------------------------------------------

  applyEdits(sheetName: string, edits: readonly CellEdit[], opts: EditOptions): ApplyResult {
    const sheet = this.getSheet(sheetName);
    checkEditOptions(opts, this._revision);
    const conflicts: ConflictInfo[] = [];
    const ops = this.planSets(sheet, edits, opts, conflicts);
    return this.finish(sheet, opts, ops, conflicts, "cells_changed");
  }

  /**
   * 条件に合う行（最終ビューで評価）の列を一括で変更する。
   * 値はすべて適用前の状態から求める（SQL の UPDATE と同じく、同じ規則の他の列の変更に影響されない）。
   * 列の誤り（存在しない・変更できない）は行ごとの conflict にせず StoreError にする。
   */
  applyRule(sheetName: string, filter: readonly TypedFilter[], set: Readonly<Record<string, RuleValue>>, opts: RuleOptions): RuleResult {
    const sheet = this.getSheet(sheetName);
    checkEditOptions(opts, this._revision);
    const predicate = compileFilters(filter, (c) => sheet.hasColumn(c));
    const entries = Object.entries(set);
    if (entries.length === 0) throw new StoreError("invalid_args", "set には 1 列以上を指定してください");
    const rules = entries.map(([col, rv]) => this.compileRule(sheet, col, rv));
    const rows = sheet.viewRows("final").filter((r) => predicate((c) => sheet.finalValue(r, c)));

    const conflicts: ConflictInfo[] = [];
    const edits: CellEdit[] = [];
    const lookup: Record<string, LookupStats> = {};
    for (const rule of rules) {
      const stats: LookupStats | null = rule.kind === "lookup" ? (lookup[rule.col] = { matched: 0, unmatched: 0, ambiguous: 0 }) : null;
      const values: Array<{ row: RowState; value: CellValue }> = [];
      for (const row of rows) {
        const r = rule.evaluate(row);
        if (r.kind === "unmatched") {
          // 参照先に無い行は変更しない（conflict にもしない）
          if (stats) stats.unmatched++;
        } else if (r.kind === "ambiguous") {
          if (stats) stats.ambiguous++;
          conflicts.push({ rowKey: row.rowKey, col: rule.col, reason: "lookup_ambiguous" });
        } else {
          if (stats) stats.matched++;
          values.push({ row, value: r.value });
        }
      }
      for (const v of this.dropParentDisagreements(sheet, rule, values, conflicts)) {
        edits.push({ rowKey: v.row.rowKey, col: rule.col, value: v.value });
      }
    }
    const ops = this.planSets(sheet, edits, opts, conflicts);
    const extra: Pick<RuleResult, "matched" | "lookup"> = { matched: rows.length };
    if (rules.some((r) => r.kind === "lookup")) extra.lookup = lookup;
    if (opts.dryRun) return { batchId: null, applied: ops.length, conflicts, revision: this._revision, ...extra };
    return { ...this.finish(sheet, opts, ops, conflicts, "cells_changed"), ...extra };
  }

  /**
   * 親の列は同じ親の全行で 1 つの値を共有する。copyFrom・lookup で同じ親の行から違う値が出たら、
   * どれを入れるか決められないので、その親の行はすべて invalid_value にして変更しない。
   */
  private dropParentDisagreements(
    sheet: Sheet,
    rule: CompiledRule,
    values: Array<{ row: RowState; value: CellValue }>,
    conflicts: ConflictInfo[],
  ): Array<{ row: RowState; value: CellValue }> {
    const schema = sheet.column(rule.col);
    if (rule.kind === "const" || !schema || !sheet.isParentColumn(rule.col)) return values;
    // 列の型に合わせてから比べる（"1" と 1、null と空文字は同じ値）
    const comparable = (v: CellValue): CellValue => {
      const c = coerceValue(schema, v);
      const out = c.ok ? c.value : v;
      return isBlank(out) ? null : out;
    };
    const firstByParent = new Map<string, CellValue>();
    const disagree = new Set<string>();
    for (const { row, value } of values) {
      const v = comparable(value);
      if (!firstByParent.has(row.parentKey)) firstByParent.set(row.parentKey, v);
      else if (firstByParent.get(row.parentKey) !== v) disagree.add(row.parentKey);
    }
    if (disagree.size === 0) return values;
    return values.filter(({ row }) => {
      if (!disagree.has(row.parentKey)) return true;
      conflicts.push({ rowKey: row.rowKey, col: rule.col, reason: "invalid_value" });
      return false;
    });
  }

  addRows(sheetName: string, rows: ReadonlyArray<Readonly<Record<string, CellValue>>>, opts: AddRowsOptions): ApplyResult {
    const sheet = this.getSheet(sheetName);
    checkEditOptions(opts, this._revision);
    const conflicts: ConflictInfo[] = [];
    const ops: PlannedOp[] = [];
    const push = (plan: RowPlan) => {
      if ("conflict" in plan) conflicts.push(plan.conflict);
      else ops.push({ op: plan.op });
    };

    const base = opts.baseRevision;
    if (opts.parentRowKey === undefined) {
      const pendingKeys = new Set<string>();
      rows.forEach((values, i) => {
        const plan = this.planParentRow(sheet, values, i, pendingKeys, base);
        if ("op" in plan) pendingKeys.add(plan.op.rowKey);
        push(plan);
      });
    } else {
      const parent = sheet.row(opts.parentRowKey);
      // 親だけの行に削除の印が付いた親（親の削除）にも子を追加しない
      if (!parent || parent.deleted || sheet.group(parent.parentKey).some((r) => r.childName === null && r.deleted !== null)) {
        conflicts.push({ rowKey: opts.parentRowKey, col: "", reason: "row_not_found" });
      } else {
        const names = sheet.childNames();
        if (names.length === 0) {
          throw new StoreError("invalid_args", `シート ${sheet.name} には子オブジェクトの列がありません`, { sheet: sheet.name });
        }
        if (opts.childName !== undefined && !names.includes(opts.childName)) {
          throw new StoreError("invalid_args", `子オブジェクト ${opts.childName} はシート ${sheet.name} にありません`, { childName: opts.childName });
        }
        if (base !== undefined && sheet.groupRevision(parent.parentKey) > base) {
          // 読んだ後に同じ親の行が追加・削除された（またはシートを読み込み直した）。同じ子を二重に足さないよう読み直させる
          conflicts.push({ rowKey: opts.parentRowKey, col: "", reason: "changed_since_read" });
        } else {
          rows.forEach((values, i) => push(this.planChildRow(sheet, parent, values, i, opts.childName)));
        }
      }
    }
    return this.finish(sheet, opts, ops, conflicts, "rows_added");
  }

  deleteRows(sheetName: string, rowKeys: readonly string[], opts: EditOptions): ApplyResult {
    const sheet = this.getSheet(sheetName);
    checkEditOptions(opts, this._revision);
    const editing = this.editingFor(sheet, opts);
    const conflicts: ConflictInfo[] = [];
    const ops: PlannedOp[] = [];
    for (const rowKey of new Set(rowKeys)) {
      const row = sheet.row(rowKey);
      if (!row || row.deleted) {
        conflicts.push({ rowKey, col: "", reason: "row_not_found" });
      } else if (editing && editing.rowKey === rowKey) {
        conflicts.push({ rowKey, col: editing.col, reason: "user_editing" });
      } else if (opts.baseRevision !== undefined && sheet.rowRevision(row) > opts.baseRevision) {
        conflicts.push({ rowKey, col: "", reason: "changed_since_read" });
      } else {
        ops.push({ op: { kind: "deleteRow", rowKey } });
      }
    }
    return this.finish(sheet, opts, ops, conflicts, "rows_deleted");
  }

  /**
   * バッチの逆操作を新しい順に適用する。
   * - バッチの後に別のバッチが変えたセル・行は取り消さず conflict にする（その部分は後で再度取り消せる）。
   * - 親の列は同じ親の全行で 1 つの値を共有するので、同じ親・同じ列の変更は全部取り消すか全部残す
   *   （後から追加した子行が変更後の値を写している場合も残す。一部だけ戻すと同じ親の行で値が食い違う）。
   * - author が llm なら、利用者が編集中のセル・行は取り消さず user_editing にする。
   * - すべて取り消せたときだけ undone にする。取り消しは新しいバッチを作らない。
   */
  undoBatch(batchId: string, opts: UndoOptions = {}): ApplyResult {
    const entry = this.batchMap.get(batchId);
    if (!entry) {
      throw new StoreError("batch_not_found", `バッチ ${batchId} はありません（シートを読み込み直すと以前のバッチは消えます）`, { batchId });
    }
    if (entry.record.undone) throw new StoreError("batch_already_undone", `バッチ ${batchId} は取り消し済みです`, { batchId });
    const sheet = this.sheetMap.get(entry.record.sheet);
    if (!sheet || sheet.id !== entry.sheetId) {
      throw new StoreError("batch_not_found", `バッチ ${batchId} のシートは置き換えられています`, { batchId });
    }
    if (opts.author !== undefined) checkAuthor(opts.author);
    const editing = opts.author === undefined ? null : this.editingFor(sheet, { author: opts.author });

    // 1) 検査だけ行う（まだ変更しない）。同じバッチの操作どうしは互いの検査結果を変えない
    const order: number[] = [];
    const conflictAt = new Map<number, ConflictInfo>();
    for (let i = entry.ops.length - 1; i >= 0; i--) {
      const st = entry.ops[i];
      if (!st || st.reverted) continue;
      order.push(i);
      const c = this.checkRevert(sheet, batchId, st.op, editing);
      if (c) conflictAt.set(i, c);
    }
    this.keepParentGroupsTogether(sheet, entry.ops, entry.revision, order, conflictAt);

    // 2) 適用
    const revision = this._revision + 1;
    const conflicts: ConflictInfo[] = [];
    let applied = 0;
    for (const i of order) {
      const st = entry.ops[i];
      if (!st) continue;
      const c = conflictAt.get(i);
      if (c) {
        conflicts.push(c);
      } else {
        this.doRevert(sheet, st, revision);
        st.reverted = true;
        applied++;
      }
    }
    if (conflicts.length === 0) entry.record.undone = true;
    if (applied > 0) {
      this._revision = revision;
      this.emit({ revision, sheet: sheet.name, kind: "batch_undone", batchId });
    }
    return { batchId: applied > 0 ? batchId : null, applied, conflicts, revision: this._revision };
  }

  private finish(sheet: Sheet, opts: EditOptions, ops: PlannedOp[], conflicts: ConflictInfo[], kind: ChangeKind): ApplyResult {
    if (ops.length === 0) return { batchId: null, applied: 0, conflicts, revision: this._revision };
    const batchId = this.commit(sheet, opts, ops, kind);
    return { batchId, applied: ops.length, conflicts, revision: this._revision };
  }

  private editingFor(sheet: Sheet, opts: EditOptions): EditingCell | null {
    return opts.author === "llm" && this.editing !== null && this.editing.sheet === sheet.name ? this.editing : null;
  }

  /**
   * セル変更を検査して set 操作にする（まだ適用しない）。
   * 親の列は同じ親の全行（削除の印が付いた行を含む）に同じ値を入れる。applied はこの展開後の件数になる。
   */
  private planSets(sheet: Sheet, edits: readonly CellEdit[], opts: EditOptions, conflicts: ConflictInfo[]): PlannedOp[] {
    const ops: PlannedOp[] = [];
    const pending = new Map<RowState, Map<string, CellValue>>();
    const current = (row: RowState, col: string): CellValue => {
      const m = pending.get(row);
      return m !== undefined && m.has(col) ? (m.get(col) as CellValue) : sheet.finalValue(row, col);
    };
    const editing = this.editingFor(sheet, opts);
    const base = opts.baseRevision;

    for (const e of edits) {
      const row = sheet.row(e.rowKey);
      if (!row || row.deleted) {
        conflicts.push({ rowKey: e.rowKey, col: e.col, reason: "row_not_found" });
        continue;
      }
      const schema = sheet.column(e.col);
      if (!schema) {
        conflicts.push({ rowKey: e.rowKey, col: e.col, reason: "column_not_found" });
        continue;
      }
      if (sheet.isProtectedColumn(e.col)) {
        conflicts.push({ rowKey: e.rowKey, col: e.col, reason: "read_only_column" });
        continue;
      }
      const coerced = coerceValue(schema, e.value);
      if (!coerced.ok) {
        conflicts.push({ rowKey: e.rowKey, col: e.col, reason: "invalid_value" });
        continue;
      }
      const value = coerced.value;
      const targets = sheet.isParentColumn(e.col) ? sheet.group(row.parentKey) : [row];
      const changing = targets.filter((t) => !sameCellValue(current(t, e.col), value));
      // 既に同じ値（null と空文字は同じ）なら何もしない（conflict にもしない）
      if (changing.length === 0) continue;
      if (editing && editing.col === e.col && targets.some((t) => t.rowKey === editing.rowKey)) {
        conflicts.push({ rowKey: e.rowKey, col: e.col, reason: "user_editing" });
        continue;
      }
      if (base !== undefined && targets.some((t) => sheet.cellRevision(t, e.col) > base)) {
        conflicts.push({ rowKey: e.rowKey, col: e.col, reason: "changed_since_read" });
        continue;
      }
      for (const t of changing) {
        const planned: PlannedOp = { op: { kind: "set", rowKey: t.rowKey, col: e.col, value, prev: current(t, e.col) } };
        // セル固有の根拠。親の列を同じ親の全行に反映するときは、その全行に同じ根拠を付ける
        if (typeof e.reason === "string" && e.reason !== "") planned.reason = e.reason;
        ops.push(planned);
        let m = pending.get(t);
        if (!m) pending.set(t, (m = new Map()));
        m.set(e.col, value);
      }
    }
    return ops;
  }

  private compileRule(sheet: Sheet, col: string, rv: RuleValue): CompiledRule {
    if (!sheet.hasColumn(col)) throw columnNotFound(col, sheet.name);
    if (sheet.isProtectedColumn(col)) {
      throw new StoreError("read_only_column", `列 ${col} は変更できません（キー列・子の ID 列・読み取り専用）`, { column: col });
    }
    if ("const" in rv) {
      const v = rv.const;
      return { col, kind: "const", evaluate: () => ({ kind: "value", value: v }) };
    }
    if ("copyFrom" in rv) {
      const src = rv.copyFrom;
      if (!sheet.hasColumn(src)) throw columnNotFound(src, sheet.name);
      return { col, kind: "copyFrom", evaluate: (row) => ({ kind: "value", value: sheet.finalValue(row, src) }) };
    }
    if (!("lookup" in rv) || rv.lookup === null || typeof rv.lookup !== "object") {
      throw new StoreError("invalid_args", `列 ${col} の規則は const / copyFrom / lookup のいずれかにしてください`, { column: col });
    }
    const lk = rv.lookup;
    const [matchCols, targetCols] = pairColumns(lk.matchCol, lk.targetMatchCol, "matchCol", "targetMatchCol");
    for (const c of matchCols) if (!sheet.hasColumn(c)) throw columnNotFound(c, sheet.name);
    const target = this.getSheet(lk.sheet);
    for (const c of [...targetCols, lk.sourceCol]) if (!target.hasColumn(c)) throw columnNotFound(c, target.name);
    const norm: readonly NormalizeOption[] = lk.normalize ?? [];
    // 参照元が親の列なら、同じ親の複数の行（子行）は同じ値なので 1 件として数える
    const byParent = target.isParentColumn(lk.sourceCol);
    const index = new Map<string, { ids: Set<string>; value: CellValue }>();
    for (const t of target.viewRows("final")) {
      const { id: key } = normalizeCompositeKey(
        targetCols.map((c) => target.finalValue(t, c)),
        norm,
      );
      if (key === null) continue;
      const id = byParent ? t.parentKey : t.rowKey;
      const hit = index.get(key);
      if (hit) hit.ids.add(id);
      else index.set(key, { ids: new Set([id]), value: target.finalValue(t, lk.sourceCol) });
    }
    return {
      col,
      kind: "lookup",
      evaluate: (row) => {
        // どれか 1 列でも空なら突合しない（unmatched）
        const { id: key } = normalizeCompositeKey(
          matchCols.map((c) => sheet.finalValue(row, c)),
          norm,
        );
        const hit = key === null ? undefined : index.get(key);
        if (!hit) return { kind: "unmatched" };
        if (hit.ids.size > 1) return { kind: "ambiguous" };
        return { kind: "value", value: hit.value };
      },
    };
  }

  /** 親行の追加。行キーはキー列の値から作る（キー列が無いシートは new~<連番>）。行キーを決められない行の conflict は #<入力の位置> */
  private planParentRow(
    sheet: Sheet,
    values: Readonly<Record<string, CellValue>>,
    index: number,
    pendingKeys: ReadonlySet<string>,
    base: number | undefined,
  ): RowPlan {
    const where = `#${index}`;
    const out: Record<string, CellValue> = {};
    for (const [col, v] of Object.entries(values)) {
      const schema = sheet.column(col);
      if (!schema) return { conflict: { rowKey: where, col, reason: "column_not_found" } };
      const c = coerceValue(schema, v);
      // 親の行に子の列の値は入れられない（子の行として追加する）
      if (!c.ok || (schema.child && !isBlank(c.value))) return { conflict: { rowKey: where, col, reason: "invalid_value" } };
      // 読み取り専用の列（キー列を除く）は新しい行でも Maximo が決めるので値を入れさせない
      if (schema.readOnly && !sheet.meta.keyColumns.includes(col) && !isBlank(c.value)) {
        return { conflict: { rowKey: where, col, reason: "read_only_column" } };
      }
      out[col] = c.value;
    }
    const keys = sheet.meta.keyColumns;
    let rowKey: string;
    if (keys.length === 0) {
      do rowKey = makeParentKey([`${NEW_CHILD_PREFIX}${sheet.newRowSeq++}`]);
      while (sheet.row(rowKey) || pendingKeys.has(rowKey));
    } else {
      const blank = keys.find((k) => isBlank(out[k]));
      if (blank !== undefined) return { conflict: { rowKey: where, col: blank, reason: "invalid_value" } };
      rowKey = makeParentKey(keys.map((k) => out[k] ?? null));
      if (sheet.row(rowKey) || sheet.group(rowKey).length > 0 || pendingKeys.has(rowKey)) {
        return { conflict: { rowKey, col: keys[0] ?? "", reason: "invalid_value" } };
      }
    }
    // 読んだ後にシートを読み込み直した・同じキーの行が増減した
    if (base !== undefined && sheet.groupRevision(rowKey) > base) return { conflict: { rowKey, col: "", reason: "changed_since_read" } };
    return { op: { kind: "addRow", rowKey, parentKey: rowKey, childName: null, values: out } };
  }

  /** 子行の追加。親の列は親の現在の値を写し、入力で違う値を指定したら invalid_value にする */
  private planChildRow(
    sheet: Sheet,
    parent: RowState,
    values: Readonly<Record<string, CellValue>>,
    index: number,
    childNameOpt: string | undefined,
  ): RowPlan {
    const where = `#${index}`;
    let childName = childNameOpt ?? parent.childName;
    if (childName === null) {
      const names = sheet.childNames();
      const used = new Set<string>();
      for (const c of Object.keys(values)) {
        const child = sheet.column(c)?.child;
        if (child) used.add(child);
      }
      const only = names.length === 1 ? names[0] : used.size === 1 ? Array.from(used)[0] : undefined;
      if (only === undefined) return { conflict: { rowKey: where, col: "", reason: "invalid_value" } };
      childName = only;
    }
    const out: Record<string, CellValue> = {};
    for (const c of sheet.meta.columns) if (!c.child) out[c.name] = sheet.finalValue(parent, c.name);
    for (const [col, v] of Object.entries(values)) {
      const schema = sheet.column(col);
      if (!schema) return { conflict: { rowKey: where, col, reason: "column_not_found" } };
      const c = coerceValue(schema, v);
      if (!c.ok) return { conflict: { rowKey: where, col, reason: "invalid_value" } };
      if (!schema.child) {
        // 親の列は親の現在の値と同じでなければならない（null と空文字は同じ）
        if (!sameCellValue(c.value, out[col] ?? null)) return { conflict: { rowKey: where, col, reason: "invalid_value" } };
      } else if (schema.child !== childName) {
        if (!isBlank(c.value)) return { conflict: { rowKey: where, col, reason: "invalid_value" } };
      } else if (sheet.isProtectedColumn(col) && !isBlank(c.value)) {
        // 子の ID 列・読み取り専用の子の列は Maximo が決める
        return { conflict: { rowKey: where, col, reason: "read_only_column" } };
      } else {
        out[col] = c.value;
      }
    }
    let rowKey: string;
    do rowKey = makeChildRowKey(parent.parentKey, childName, `${NEW_CHILD_PREFIX}${sheet.newRowSeq++}`);
    while (sheet.row(rowKey));
    return { op: { kind: "addRow", rowKey, parentKey: parent.parentKey, childName, values: out } };
  }

  private commit(sheet: Sheet, opts: EditOptions, planned: PlannedOp[], kind: ChangeKind): string {
    const revision = ++this._revision;
    const batchId = `b${++this.batchSeq}-${randomHex(3)}`;
    // 印・overlay・操作は取り消しで参照を使い回すので凍結する
    const mark: RowMark = Object.freeze({ batchId, author: opts.author, revision });
    const ops = planned.map((p) => freezeOp(p.op));
    const states: BatchOpState[] = planned.map(({ reason }, i): BatchOpState => {
      const op = ops[i] as OverlayOp;
      switch (op.kind) {
        case "set": {
          const row = mustRow(sheet, op.rowKey);
          const prevEntry = row.cells?.get(op.col) ?? null;
          const withReason = reason !== undefined ? { reason } : {};
          sheet.setCell(row, op.col, Object.freeze({ value: op.value, ...mark, ...withReason }), revision);
          return { op, prevEntry, reverted: false, ...withReason };
        }
        case "addRow":
          sheet.insertAdded(Sheet.newAddedRow({ rowKey: op.rowKey, parentKey: op.parentKey, childName: op.childName, values: op.values }, mark), revision);
          return { op, reverted: false };
        case "deleteRow":
          sheet.setDeleted(mustRow(sheet, op.rowKey), mark, revision);
          return { op, reverted: false };
      }
    });
    const record: BatchRecord = { batchId, author: opts.author, createdAt: this.now(), sheet: sheet.name, ops: Object.freeze(ops) as OverlayOp[], undone: false };
    if (opts.reason !== undefined) record.reason = opts.reason;
    const entry: BatchEntry = { record, sheetId: sheet.id, revision, ops: states };
    this.batchList.push(entry);
    this.batchMap.set(batchId, entry);
    this.emit({ revision, sheet: sheet.name, kind, batchId });
    return batchId;
  }

  /** 取り消せるかの検査（変更しない）。取り消せなければ conflict を返す */
  private checkRevert(sheet: Sheet, batchId: string, op: OverlayOp, editing: EditingCell | null): ConflictInfo | null {
    switch (op.kind) {
      case "set": {
        const row = sheet.row(op.rowKey);
        if (!row) return { rowKey: op.rowKey, col: op.col, reason: "row_not_found" };
        const cur = row.cells?.get(op.col);
        if (!cur || cur.batchId !== batchId) return { rowKey: op.rowKey, col: op.col, reason: "changed_since_read" };
        if (editing && editing.rowKey === op.rowKey && editing.col === op.col) return { rowKey: op.rowKey, col: op.col, reason: "user_editing" };
        return null;
      }
      case "addRow": {
        const row = sheet.row(op.rowKey);
        if (!row || row.added?.batchId !== batchId) return { rowKey: op.rowKey, col: "", reason: "row_not_found" };
        // 後から削除・変更された行、子が追加された親行は消さない
        const hasChildren = row.childName === null && sheet.group(row.parentKey).some((r) => r !== row);
        if (row.deleted || row.cells || hasChildren) return { rowKey: op.rowKey, col: "", reason: "changed_since_read" };
        if (editing && editing.rowKey === op.rowKey) return { rowKey: op.rowKey, col: editing.col, reason: "user_editing" };
        return null;
      }
      case "deleteRow": {
        const row = sheet.row(op.rowKey);
        if (!row) return { rowKey: op.rowKey, col: "", reason: "row_not_found" };
        if (row.deleted?.batchId !== batchId) return { rowKey: op.rowKey, col: "", reason: "changed_since_read" };
        return null;
      }
    }
  }

  /**
   * 親の列の変更を「同じ親・同じ列」の組にまとめ、1 件でも取り消せない組は全部を conflict にする。
   * 取り消せる組でも、このバッチの後に追加した同じ親の行（追加時に変更後の値を写した子行など）の値が
   * 取り消した後の値（バッチ前の値）と違えば、組ごと残す。
   * バッチの時点からあった行でバッチが変えなかった行は、取り消してもバッチ前の状態に戻るだけなので見ない。
   */
  private keepParentGroupsTogether(
    sheet: Sheet,
    ops: readonly BatchOpState[],
    batchRevision: number,
    order: readonly number[],
    conflictAt: Map<number, ConflictInfo>,
  ): void {
    const groups = new Map<string, { parentKey: string; col: string; idxs: number[] }>();
    for (const i of order) {
      const op = ops[i]?.op;
      if (op?.kind !== "set" || !sheet.isParentColumn(op.col)) continue;
      const row = sheet.row(op.rowKey);
      if (!row) continue;
      const id = JSON.stringify([row.parentKey, op.col]);
      const g = groups.get(id);
      if (g) g.idxs.push(i);
      else groups.set(id, { parentKey: row.parentKey, col: op.col, idxs: [i] });
    }
    for (const { parentKey, col, idxs } of groups.values()) {
      let reason = idxs.map((i) => conflictAt.get(i)?.reason).find((r) => r !== undefined);
      if (reason === undefined) {
        // order は新しい順なので末尾がこの組で最も古い操作。その prev がバッチ前の値
        const oldest = ops[idxs[idxs.length - 1] ?? -1]?.op;
        const before = oldest?.kind === "set" ? oldest.prev : null;
        const covered = new Set(idxs.map((i) => ops[i]?.op.rowKey));
        const addedLater = (r: RowState) => r.added !== null && r.added.revision > batchRevision && !covered.has(r.rowKey);
        if (sheet.group(parentKey).some((r) => addedLater(r) && !sameCellValue(sheet.finalValue(r, col), before))) {
          reason = "changed_since_read";
        }
      }
      if (reason === undefined) continue;
      for (const i of idxs) {
        const op = ops[i]?.op;
        if (op && !conflictAt.has(i)) conflictAt.set(i, { rowKey: op.rowKey, col, reason });
      }
    }
  }

  /** checkRevert を通った操作を取り消す */
  private doRevert(sheet: Sheet, st: BatchOpState, revision: number): void {
    const op = st.op;
    const row = mustRow(sheet, op.rowKey);
    switch (op.kind) {
      case "set":
        sheet.setCell(row, op.col, st.prevEntry ?? null, revision);
        return;
      case "addRow":
        sheet.removeAdded(row, revision);
        return;
      case "deleteRow":
        sheet.setDeleted(row, null, revision);
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // 読み取り
  // ---------------------------------------------------------------------------

  queryRows(sheetName: string, opts: QueryRowsOptions = {}): QueryRowsResult {
    const sheet = this.getSheet(sheetName);
    const view = opts.view ?? "final";
    if (view !== "final" && view !== "base" && view !== "diff") {
      throw new StoreError("invalid_args", "view は final / base / diff のいずれかにしてください", { view });
    }
    const limit = checkLimit(opts.limit, DEFAULT_LIMIT);
    const predicate = compileFilters(opts.filter ?? [], (c) => sheet.hasColumn(c));
    const columns = opts.columns ?? defaultColumns(sheet);
    for (const c of columns) if (!sheet.hasColumn(c)) throw columnNotFound(c, sheet.name);
    const matched = sheet.viewRows(view).filter((r) => predicate((c) => sheet.viewValue(r, c, view)));
    const { page, nextCursor } = paginate(matched, opts.cursor, limit);
    const rows = page.map((r) => {
      const values: Record<string, CellValue> = {};
      for (const c of columns) values[c] = sheet.viewValue(r, c, view);
      const out: QueryRow = { rowKey: r.rowKey, values };
      if (view === "diff") {
        const s = sheet.rowStatus(r);
        if (s !== null) out.status = s;
        if (s === "changed") out.changedColumns = sheet.changedColumns(r);
      }
      return out;
    });
    return { rows, nextCursor, revision: this._revision, total: matched.length };
  }

  /** 最終ビューを列の値でグループ化して件数を数える。null と空文字は同じグループ（null）にする */
  aggregate(sheetName: string, opts: AggregateOptions): AggregateResult {
    const sheet = this.getSheet(sheetName);
    if (opts.groupBy.length === 0) throw new StoreError("invalid_args", "groupBy には 1 列以上を指定してください");
    for (const c of opts.groupBy) if (!sheet.hasColumn(c)) throw columnNotFound(c, sheet.name);
    const limit = checkLimit(opts.limit, DEFAULT_LIMIT);
    const predicate = compileFilters(opts.filter ?? [], (c) => sheet.hasColumn(c));
    const groups = new Map<string, { key: Record<string, CellValue>; count: number }>();
    for (const r of sheet.viewRows("final")) {
      if (!predicate((c) => sheet.finalValue(r, c))) continue;
      const vals = opts.groupBy.map((c) => {
        const v = sheet.finalValue(r, c);
        return v === "" ? null : v;
      });
      const id = JSON.stringify(vals);
      const g = groups.get(id);
      if (g) {
        g.count++;
      } else {
        const key: Record<string, CellValue> = {};
        opts.groupBy.forEach((c, i) => (key[c] = vals[i] ?? null));
        groups.set(id, { key, count: 1 });
      }
    }
    const sorted = Array.from(groups.entries())
      .sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([, g]) => g);
    return { groups: sorted.slice(0, limit), totalGroups: sorted.length, revision: this._revision };
  }

  /**
   * 2 つのシートの最終ビューを正規化したキーで突合する。
   * - 突合列は単一列か複合キー（同じ順・同じ個数の列の配列）。
   * - キーが空（null・空文字・正規化後に空。複合キーはどれか 1 列でも空）の行は一致させず、その側の unmatched に数える。
   * - 右側で同じキーの行が複数あれば ambiguous。
   * - 突合列がすべて親の列なら、同じ親の複数の行（子行）は 1 件として数える（子の数だけ重複させない）。
   * - サンプルの key は各列の正規化後の値を " | " で連結した文字列。
   */
  matchSheets(
    leftName: string,
    rightName: string,
    leftCol: string | readonly string[],
    rightCol: string | readonly string[],
    normalize: readonly NormalizeOption[],
    sampleSize: number,
  ): MatchSummary {
    const left = this.getSheet(leftName);
    const right = this.getSheet(rightName);
    const [leftCols, rightCols] = pairColumns(leftCol, rightCol, "leftCol", "rightCol");
    for (const c of leftCols) if (!left.hasColumn(c)) throw columnNotFound(c, left.name);
    for (const c of rightCols) if (!right.hasColumn(c)) throw columnNotFound(c, right.name);
    if (!Number.isSafeInteger(sampleSize) || sampleSize < 0) {
      throw new StoreError("invalid_args", "sampleSize は 0 以上の整数にしてください", { sampleSize });
    }
    const entities = (sheet: Sheet, cols: readonly string[]) => {
      const byParent = cols.every((c) => sheet.isParentColumn(c));
      const seen = new Set<string>();
      const out: Array<{ rowKey: string; key: string | null; label: string }> = [];
      for (const r of sheet.viewRows("final")) {
        const id = byParent ? r.parentKey : r.rowKey;
        if (seen.has(id)) continue;
        seen.add(id);
        const k = normalizeCompositeKey(
          cols.map((c) => sheet.finalValue(r, c)),
          normalize,
        );
        out.push({ rowKey: r.rowKey, key: k.id, label: k.label });
      }
      return out;
    };

    const rightIndex = new Map<string, string[]>();
    const rightEntities = entities(right, rightCols);
    for (const e of rightEntities) {
      if (e.key === null) continue;
      const list = rightIndex.get(e.key);
      if (list) list.push(e.rowKey);
      else rightIndex.set(e.key, [e.rowKey]);
    }

    const summary: MatchSummary = {
      matched: 0,
      unmatchedLeft: 0,
      unmatchedRight: 0,
      ambiguous: 0,
      samples: { matched: [], unmatchedLeft: [], unmatchedRight: [], ambiguous: [] },
    };
    const hitKeys = new Set<string>();
    for (const e of entities(left, leftCols)) {
      const candidates = e.key === null ? undefined : rightIndex.get(e.key);
      if (e.key === null || candidates === undefined) {
        summary.unmatchedLeft++;
        if (summary.samples.unmatchedLeft.length < sampleSize) summary.samples.unmatchedLeft.push({ rowKey: e.rowKey, key: e.label });
        continue;
      }
      hitKeys.add(e.key);
      const [first] = candidates;
      if (candidates.length === 1 && first !== undefined) {
        summary.matched++;
        if (summary.samples.matched.length < sampleSize) summary.samples.matched.push({ leftRowKey: e.rowKey, rightRowKey: first, key: e.label });
      } else {
        summary.ambiguous++;
        if (summary.samples.ambiguous.length < sampleSize) {
          summary.samples.ambiguous.push({ leftRowKey: e.rowKey, key: e.label, candidates: candidates.slice(0, MAX_CANDIDATES) });
        }
      }
    }
    for (const e of rightEntities) {
      if (e.key !== null && hitKeys.has(e.key)) continue;
      summary.unmatchedRight++;
      if (summary.samples.unmatchedRight.length < sampleSize) summary.samples.unmatchedRight.push({ rowKey: e.rowKey, key: e.label });
    }
    return summary;
  }

  getDiff(sheetName: string, opts: DiffOptions = {}): DiffResult {
    const sheet = this.getSheet(sheetName);
    const limit = checkLimit(opts.limit, DEFAULT_LIMIT);
    const items: DiffItem[] = [];
    let changedCells = 0;
    let addedRows = 0;
    let deletedRows = 0;
    const idCols = rowIdentityColumns(sheet);
    // 根拠: セル固有の根拠、無ければバッチの reason。どちらも無ければ付けない
    const withReason = (item: DiffItem, cellReason?: string): DiffItem => {
      const reason = cellReason ?? this.batchReason(item.batchId);
      if (reason !== undefined) item.reason = reason;
      return item;
    };
    for (const r of sheet.orderedRows()) {
      const s = sheet.rowStatus(r);
      if (s === "deleted" && r.deleted) {
        deletedRows++;
        const values: Record<string, CellValue> = {};
        for (const c of idCols(r)) values[c] = r.base[c] ?? null;
        items.push(withReason({ kind: "delete", rowKey: r.rowKey, col: "*", before: null, after: null, author: r.deleted.author, batchId: r.deleted.batchId, values }));
      } else if (s === "added" && r.added) {
        addedRows++;
        const values: Record<string, CellValue> = {};
        for (const c of sheet.meta.columns) {
          const v = sheet.finalValue(r, c.name);
          if (v !== null) values[c.name] = v;
        }
        items.push(withReason({ kind: "add", rowKey: r.rowKey, col: "*", before: null, after: null, author: r.added.author, batchId: r.added.batchId, values }));
      } else if (s === "changed") {
        for (const col of sheet.changedColumns(r)) {
          const e = r.cells?.get(col);
          if (!e) continue;
          changedCells++;
          items.push(
            withReason({ kind: "change", rowKey: r.rowKey, col, before: r.base[col] ?? null, after: e.value, author: e.author, batchId: e.batchId }, e.reason),
          );
        }
      }
    }
    const { page, nextCursor } = paginate(items, opts.cursor, limit);
    return { changedCells, addedRows, deletedRows, total: items.length, entries: page, nextCursor, revision: this._revision };
  }

  // ---------------------------------------------------------------------------
  // Maximo への反映（追加のメソッド。既存の挙動は変えない）
  // ---------------------------------------------------------------------------

  /** 反映用の差分を全件返す（SheetChanges の説明を参照） */
  changes(sheetName: string): SheetChanges {
    const sheet = this.getSheet(sheetName);
    const out: SheetChanges = { cells: [], addedRows: [], deletedRows: [], unwritableParentEdits: [] };
    const deleted: RowState[] = [];
    // 親キー → その親で削除されていない行（親の列の変更を付け替える先）
    const survivor = new Map<string, string>();
    // 既に cells に入れた親の列（親キーと列名の組）
    const doneParentCols = new Set<string>();
    const parentColId = (parentKey: string, col: string) => JSON.stringify([parentKey, col]);
    for (const r of sheet.orderedRows()) {
      const s = sheet.rowStatus(r);
      if (s === null) continue;
      if (s === "deleted") {
        out.deletedRows.push(r.rowKey);
        deleted.push(r);
        continue;
      }
      if (!survivor.has(r.parentKey)) survivor.set(r.parentKey, r.rowKey);
      if (s === "added") {
        const values: Record<string, CellValue> = {};
        for (const c of sheet.meta.columns) values[c.name] = sheet.finalValue(r, c.name);
        out.addedRows.push({ rowKey: r.rowKey, parentKey: r.parentKey, childName: r.childName, values });
      } else if (s === "changed") {
        for (const col of sheet.changedColumns(r)) {
          out.cells.push({ rowKey: r.rowKey, col, value: sheet.finalValue(r, col) });
          if (sheet.isParentColumn(col)) doneParentCols.add(parentColId(r.parentKey, col));
        }
      }
    }
    // 削除した行に残った親の列の変更。同じ親に行が残っていればその行に付け替える（残っていなければ反映できない）
    const lost = new Map<string, string[]>();
    for (const r of deleted) {
      const anchor = survivor.get(r.parentKey);
      for (const col of sheet.changedColumns(r)) {
        if (!sheet.isParentColumn(col)) continue;
        const id = parentColId(r.parentKey, col);
        if (doneParentCols.has(id)) continue;
        doneParentCols.add(id);
        if (anchor === undefined) {
          const cols = lost.get(r.parentKey);
          if (cols) cols.push(col);
          else lost.set(r.parentKey, [col]);
          continue;
        }
        out.cells.push({ rowKey: anchor, col, value: sheet.finalValue(r, col) });
      }
    }
    for (const [parentKey, columns] of lost) out.unwritableParentEdits.push({ parentKey, columns });
    return out;
  }

  /**
   * 反映を確かめた親だけ、base（Maximo の値・親レコード）を読み直した内容に置き換え、その親の overlay・追加行・削除の印を消す。
   * - 他の親の行・overlay・バッチはそのまま残す（バッチの取り消しは、置き換えた行の分を conflict にする）。
   * - 置き換えた行のセルは revision を進めるので、読み直す前の baseRevision での変更は changed_since_read になる。
   * - シート全体を新しい Sheet に差し替えるので、変更通知は sheet_created（同名シートの置き換えと同じ扱い）。
   */
  replaceParents(sheetName: string, replacements: readonly ParentReplacement[], opts: ReplaceParentsOptions = {}): ReplaceParentsResult {
    const sheet = this.getSheet(sheetName);
    const skipped: ReplaceParentsResult["skipped"] = [];
    if (opts.sheetId !== undefined && sheet.id !== opts.sheetId) {
      for (const rep of replacements) skipped.push({ parentKey: rep.parentKey, reason: "sheet_replaced" });
      return { replaced: [], skipped, revision: this._revision };
    }
    const keys = sheet.meta.keyColumns;
    // maximo/load の parentKeyOf と同じ規則（キー列が無ければ href、あればキー値を大文字の属性名で引く）。
    // Sheet.record と規則をそろえないと、読み直した親を引き当てられず置き換えを取りこぼす
    const keyOf = (rec: MaximoRecord): string => (keys.length === 0 ? rec.href : makeParentKey(keys.map((k) => rec.attrs[k.toUpperCase()] ?? null)));
    const accepted = new Map<string, ParentReplacement>();
    for (const rep of replacements) {
      const pk = rep.parentKey;
      const since = opts.unchangedSince;
      if (since !== undefined && (sheet.groupRevision(pk) > since || sheet.group(pk).some((r) => sheet.rowRevision(r) > since))) {
        skipped.push({ parentKey: pk, reason: "changed_since" });
        continue;
      }
      const rowKeys = new Set(rep.rows.map((r) => r.rowKey));
      const shapeOk =
        !accepted.has(pk) &&
        rep.rows.length > 0 &&
        rowKeys.size === rep.rows.length &&
        keyOf(rep.record) === pk &&
        rep.rows.every((r) => r.parentKey === pk && (r.childName === null ? r.rowKey === pk : r.rowKey.startsWith(`${pk}#`)));
      if (!shapeOk) {
        skipped.push({ parentKey: pk, reason: "invalid_rows" });
        continue;
      }
      accepted.set(pk, rep);
    }
    if (accepted.size === 0) return { replaced: [], skipped, revision: this._revision };

    const revision = this._revision + 1;
    const json = sheet.toJSON();
    const removedKeys = new Set<string>();
    for (const pk of accepted.keys()) for (const r of sheet.group(pk)) removedKeys.add(r.rowKey);
    const cloneRow = (r: SheetRow): SheetRow => ({ rowKey: r.rowKey, parentKey: r.parentKey, childName: r.childName, values: { ...r.values } });
    // 表示順を保つため、置き換える親の最初の base 行の位置に新しい行を入れる
    const baseRows: SheetRow[] = [];
    const inserted = new Set<string>();
    for (const r of json.baseRows) {
      const rep = accepted.get(r.parentKey);
      if (!rep) {
        baseRows.push(r);
      } else if (!inserted.has(r.parentKey)) {
        inserted.add(r.parentKey);
        baseRows.push(...rep.rows.map(cloneRow));
      }
    }
    for (const [pk, rep] of accepted) if (!inserted.has(pk)) baseRows.push(...rep.rows.map(cloneRow));
    json.baseRows = baseRows;
    json.addedRows = json.addedRows.filter((r) => !accepted.has(r.parentKey));
    json.rowMarks = json.rowMarks.filter((m) => !removedKeys.has(m.rowKey));
    const colNames = sheet.meta.columns.map((c) => c.name);
    for (const rep of accepted.values()) {
      for (const r of rep.rows) json.rowMarks.push({ rowKey: r.rowKey, cellRevs: colNames.map((c): [string, number] => [c, revision]) });
    }
    json.groupRevs = [...(json.groupRevs ?? []).filter(([pk]) => !accepted.has(pk)), ...Array.from(accepted.keys(), (pk): [string, number] => [pk, revision])];
    const records = [...json.records];
    for (const [pk, rep] of accepted) {
      const i = records.findIndex((rec) => keyOf(rec) === pk);
      if (i >= 0) records[i] = rep.record;
      else records.push(rep.record);
    }
    json.records = records;

    const next = Sheet.fromJSON(json);
    this.sheetMap.set(sheetName, next);
    if (this.editing?.sheet === sheetName && removedKeys.has(this.editing.rowKey) && !next.row(this.editing.rowKey)) this.editing = null;
    this._revision = revision;
    this.emit({ revision, sheet: sheetName, kind: "sheet_created" });
    return { replaced: Array.from(accepted.keys()), skipped, revision };
  }

  // ---------------------------------------------------------------------------
  // 直列化（IndexedDB ジャーナル用）。編集中のセルとジョブは含めない
  // ---------------------------------------------------------------------------

  toJSON(): WorkspaceJSON {
    return {
      format: WORKSPACE_FORMAT,
      name: this._name,
      revision: this._revision,
      sheetSeq: this.sheetSeq,
      batchSeq: this.batchSeq,
      sheets: Array.from(this.sheetMap.values(), (s) => s.toJSON()),
      batches: this.batchList.map((b) => {
        const { ops: _ops, ...record } = b.record;
        return { record, sheetId: b.sheetId, revision: b.revision, ops: b.ops.map((o) => ({ ...o })) };
      }),
    };
  }

  static fromJSON(json: WorkspaceJSON, opts: WorkspaceOptions = {}): Workspace {
    if (json === null || typeof json !== "object" || json.format !== WORKSPACE_FORMAT) {
      throw new StoreError("invalid_args", "作業データの形式が違います");
    }
    const ws = new Workspace(json.name, opts);
    ws._revision = json.revision;
    ws.sheetSeq = json.sheetSeq;
    ws.batchSeq = json.batchSeq;
    for (const sj of json.sheets) ws.sheetMap.set(sj.meta.name, Sheet.fromJSON(sj));
    for (const b of json.batches) {
      // 作ったときと同じく、操作と取り消し用の overlay を凍結する
      const ops = b.ops.map(
        (o): BatchOpState => ({
          ...o,
          op: freezeOp(o.op.kind === "addRow" ? { ...o.op, values: { ...o.op.values } } : { ...o.op }),
          ...(o.prevEntry ? { prevEntry: Object.freeze({ ...o.prevEntry }) } : {}),
        }),
      );
      const record: BatchRecord = { ...b.record, ops: Object.freeze(ops.map((o) => o.op)) as OverlayOp[] };
      const entry: BatchEntry = { record, sheetId: b.sheetId, revision: b.revision, ops };
      ws.batchList.push(entry);
      ws.batchMap.set(record.batchId, entry);
    }
    return ws;
  }
}

/** columns 省略時の列: キー列と、キー以外の先頭 10 列 */
function defaultColumns(sheet: Sheet): string[] {
  const keys = sheet.meta.keyColumns;
  const rest = sheet.meta.columns.map((c) => c.name).filter((n) => !keys.includes(n));
  return [...keys, ...rest.slice(0, DEFAULT_EXTRA_COLUMNS)];
}

/** 削除行の差分に載せる列（キー列と、子行ならその子の ID 列） */
function rowIdentityColumns(sheet: Sheet): (row: RowState) => string[] {
  return (row) => {
    const cols = [...sheet.meta.keyColumns];
    if (row.childName !== null) {
      const idAttr = sheet.meta.childIdAttrs[row.childName];
      if (idAttr) {
        const col = `${row.childName}.${idAttr}`;
        if (sheet.hasColumn(col)) cols.push(col);
      }
    }
    return cols;
  };
}
