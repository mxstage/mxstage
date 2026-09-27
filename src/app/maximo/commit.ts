// Maximo への書き込みエンジン（PATCH + MERGE）。人がタブで承認したときだけ呼ぶ。
//
// 不変条件（違反は CommitInvariantError で止める。planCommit と executeCommit の両方で検査する）
//   I1  PATCH は必ず patchtype: MERGE。MERGE を外す引数そのものを持たない
//   I2  子の Change/Delete は、idAttr と id が読み込み時の子に存在する場合だけ
//   I3  削除件数の上限（親あたり 10、全体 50）。超えたら確認フラグが必要
//   I4  Add に ID を付けない
//   I5  送る属性は、変更された・readOnly でない・キー列でない列だけ
//   I6  空の子配列を送らない（子コレクションを丸ごと置き換えない）
//   I7  href は読み込み時の record.href だけを使い、組み立てない
//   I8  1 計画は 200 親まで
//   I10 null（空文字を含む）への変更は allowNull が無ければ拒否する
//       【Maximo で null をどう送るか（JSON null か "" か）は P0 で確認する】
// コミット手順: 親ごとに precheck（I9: 読み直して親の _rowstamp・子 ID 集合・触る子の _rowstamp を照合）→ 送信 → verify。
// 最初に送った 1 件の後にカナリアの確認を待つ。自動再試行はしない。
// 応答の分類: 2xx → verify / 409 → reconcile（反映済みなら verified、未反映なら unknown）/ reasonCode 付きエラー → error /
//   通信エラー・タイムアウト・reasonCode の無い 5xx → 読み直した結果を message に書き、状態は unknown（応答を受け取れていないため）

import type { CellValue, ColumnSchema, CommitRowResult } from "../../shared/model";
import { NEW_CHILD_PREFIX, parseRowKey, type ChildCommitOp, type MaximoChild, type MaximoRecord, type ParentCommitPlan, type SheetMeta } from "../../shared/sheet";
import { MaximoError, MaximoNetworkError, type MaximoClient } from "./client";
import { columnChild, parentKeyOf, parseMember } from "./load";
import { upperKeys } from "./query";

export type InvariantCode = "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7" | "I8" | "I10" | "INPUT";

export class CommitInvariantError extends Error {
  readonly code: InvariantCode;
  constructor(code: InvariantCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "CommitInvariantError";
    this.code = code;
  }
}

export const COMMIT_LIMITS = {
  maxDeletesPerParent: 10,
  maxDeletesTotal: 50,
  maxParentsPerPlan: 200,
} as const;

const ATTR_RE = /^[A-Za-z0-9_]+$/;

/**
 * ParentCommitPlan に、変更・削除する子の読み込み時 _rowstamp を足したもの（旧設計 I9）。
 * Maximo では子だけを更新しても親の _rowstamp が変わらないことがあるため、触る子は子の _rowstamp でも照合する。
 * 【共有契約 ParentCommitPlan への追加を依頼中。それまではこの拡張型で持つ】
 */
export interface CommitPlan extends ParentCommitPlan {
  /** 子オブジェクト名 → 子 ID（文字列）→ 読み込み時の _rowstamp */
  expectedChildRowstamps?: Record<string, Record<string, string | null>>;
}

/**
 * シートの差分（store の実装に依存しない素直な形）。
 * - cells: Base と異なる最終値のセル。親の列は親行・子行どちらの行キーでもよい。
 * - addedRows: 追加した子行（親の追加は未対応）。values の子の列は "CHILD.ATTR"。親の列が入っていてもよいが、親の値の変更は cells で渡す。
 * - deletedRows: 削除した子行の行キー（親の削除は未対応）。
 */
export interface CommitChanges {
  cells: Array<{ rowKey: string; col: string; value: CellValue }>;
  addedRows: Array<{ rowKey: string; parentKey: string; childName: string | null; values: Record<string, CellValue> }>;
  deletedRows: string[];
}

export interface PlanCommitOptions {
  /** null（空文字を含む）への変更を許す（I10） */
  allowNull?: boolean;
  /** 削除件数の上限を超えることを人が確認した（I3） */
  deletesConfirmed?: boolean;
}

interface ChildChangeAcc {
  child: MaximoChild;
  attrs: Map<string, CellValue>;
}

interface ParentAcc {
  record: MaximoRecord;
  parentSets: Map<string, CellValue>;
  kinds: string[];
  changes: Map<string, Map<string, ChildChangeAcc>>;
  deletes: Map<string, Map<string, MaximoChild>>;
  adds: Map<string, Array<Record<string, CellValue>>>;
}

/** 差分からコミット計画（親 1 件につき HTTP 1 回）を作る。不変条件に違反すれば例外 */
export function planCommit(meta: SheetMeta, records: MaximoRecord[], changes: CommitChanges, opts: PlanCommitOptions = {}): CommitPlan[] {
  const cols = new Map(meta.columns.map((c) => [c.name.toUpperCase(), c]));
  const keyCols = new Set(meta.keyColumns.map((k) => k.toUpperCase()));
  const childIdAttrs = upperKeys(meta.childIdAttrs);
  const selectedKinds = new Set(meta.columns.map(columnChild).filter((c): c is string => c !== null));

  const byKey = new Map<string, MaximoRecord>();
  const order: string[] = [];
  for (const r of records) {
    const k = parentKeyOf(r, meta.keyColumns);
    if (byKey.has(k)) throw new CommitInvariantError("INPUT", `親キー ${k} が重複している`);
    byKey.set(k, r);
    order.push(k);
  }
  const accs = new Map<string, ParentAcc>();
  const accOf = (parentKey: string): ParentAcc => {
    let acc = accs.get(parentKey);
    if (acc) return acc;
    const record = byKey.get(parentKey);
    if (!record) throw new CommitInvariantError("INPUT", `親 ${parentKey} は読み込んだレコードに無い`);
    assertHref(record.href);
    acc = { record, parentSets: new Map(), kinds: [], changes: new Map(), deletes: new Map(), adds: new Map() };
    accs.set(parentKey, acc);
    return acc;
  };
  const touchKind = (acc: ParentAcc, kind: string) => {
    if (!acc.kinds.includes(kind)) acc.kinds.push(kind);
  };
  const resolve = (col: string) => {
    const name = col.toUpperCase();
    const schema = cols.get(name);
    if (!schema) throw new CommitInvariantError("I5", `列 ${name} はシートの列に無い`);
    const child = columnChild(schema);
    const attr = child ? name.slice(name.indexOf(".") + 1) : name;
    if (!ATTR_RE.test(attr)) throw new CommitInvariantError("I5", `列 ${name} の属性名が不正`);
    return { name, schema, child, attr };
  };
  const setParent = (acc: ParentAcc, attr: string, value: CellValue) => {
    const prev = acc.parentSets.get(attr);
    if (prev !== undefined && !sameCell(prev, value)) throw new CommitInvariantError("INPUT", `同じ親の列 ${attr} に行によって異なる値が入っている`);
    acc.parentSets.set(attr, value);
  };

  // 追加行の行キーは「親キー#子オブジェクト名:new~N」に限る。既存の子の行キーと取り違えると、
  // その行の削除が「追加の取り消し」として黙って捨てられるため、先に止める
  for (const row of changes.addedRows) {
    if (!row.childName) throw new CommitInvariantError("INPUT", "親行の追加は未対応");
    const ap = parseRowKey(row.rowKey);
    if (ap.parentKey !== row.parentKey) throw new CommitInvariantError("INPUT", `追加行 ${row.rowKey} の親キーが一致しない`);
    if (!ap.isNewChild || ap.childName?.toUpperCase() !== row.childName.toUpperCase()) {
      throw new CommitInvariantError("INPUT", `追加行 ${row.rowKey} の行キーが新規の子（${NEW_CHILD_PREFIX}N）の形でない`);
    }
  }
  const addedByKey = new Map(changes.addedRows.map((r) => [r.rowKey, r]));
  if (addedByKey.size !== changes.addedRows.length) throw new CommitInvariantError("INPUT", "追加行の行キーが重複している");
  const cancelledAdds = new Set<string>();
  const deletedExisting = new Set<string>();

  // 1) 削除（削除する行へのセル変更は送らない）
  for (const rowKey of changes.deletedRows) {
    if (addedByKey.has(rowKey)) {
      cancelledAdds.add(rowKey);
      continue;
    }
    const p = parseRowKey(rowKey);
    if (!p.childName) throw new CommitInvariantError("INPUT", "親行の削除は未対応");
    if (p.isNewChild) continue;
    const acc = accOf(p.parentKey);
    const kind = p.childName.toUpperCase();
    const child = findLoadedChild(acc.record, kind, p.childId);
    let m = acc.deletes.get(kind);
    if (!m) acc.deletes.set(kind, (m = new Map()));
    m.set(String(child.id), child);
    touchKind(acc, kind);
    deletedExisting.add(rowKey);
  }

  // 2) セル変更
  const addOverrides = new Map<string, Record<string, CellValue>>();
  for (const cell of changes.cells) {
    if (deletedExisting.has(cell.rowKey) || cancelledAdds.has(cell.rowKey)) continue;
    const r = resolve(cell.col);
    const added = addedByKey.get(cell.rowKey);
    if (added) {
      if (r.child) {
        let o = addOverrides.get(cell.rowKey);
        if (!o) addOverrides.set(cell.rowKey, (o = {}));
        o[r.name] = cell.value;
      } else {
        assertWritableParent(r, keyCols);
        setParent(accOf(added.parentKey), r.attr, cell.value);
      }
      continue;
    }
    const p = parseRowKey(cell.rowKey);
    const acc = accOf(p.parentKey);
    if (!r.child) {
      assertWritableParent(r, keyCols);
      setParent(acc, r.attr, cell.value);
      continue;
    }
    if (!p.childName || p.childName.toUpperCase() !== r.child) {
      throw new CommitInvariantError("INPUT", `子の列 ${r.name} を ${r.child} 以外の行で変更している`);
    }
    if (p.isNewChild) throw new CommitInvariantError("INPUT", `新規の子行 ${cell.rowKey} が addedRows に無い`);
    const child = findLoadedChild(acc.record, r.child, p.childId);
    if (r.schema.readOnly) throw new CommitInvariantError("I5", `列 ${r.name} は読み取り専用`);
    if (child.idAttr && r.attr === child.idAttr.toUpperCase()) throw new CommitInvariantError("I5", `子の ID 属性 ${r.name} は変更できない`);
    let km = acc.changes.get(r.child);
    if (!km) acc.changes.set(r.child, (km = new Map()));
    let ch = km.get(String(child.id));
    if (!ch) km.set(String(child.id), (ch = { child, attrs: new Map() }));
    const prev = ch.attrs.get(r.attr);
    if (prev !== undefined && !sameCell(prev, cell.value)) throw new CommitInvariantError("INPUT", `同じセル ${r.name} に異なる値が複数ある`);
    ch.attrs.set(r.attr, cell.value);
    touchKind(acc, r.child);
  }

  // 3) 追加
  for (const row of changes.addedRows) {
    if (cancelledAdds.has(row.rowKey)) continue;
    if (!row.childName) throw new CommitInvariantError("INPUT", "親行の追加は未対応");
    const kind = row.childName.toUpperCase();
    if (!selectedKinds.has(kind)) throw new CommitInvariantError("INPUT", `子 ${kind} はシートで読み込んでいない`);
    if (parseRowKey(row.rowKey).parentKey !== row.parentKey) throw new CommitInvariantError("INPUT", `追加行 ${row.rowKey} の親キーが一致しない`);
    const acc = accOf(row.parentKey);
    const idAttr = childIdAttrs[kind]?.toUpperCase() ?? null;
    const values = { ...row.values, ...(addOverrides.get(row.rowKey) ?? {}) };
    const attrs: Record<string, CellValue> = {};
    for (const [col, v] of Object.entries(values)) {
      const name = col.toUpperCase();
      if (!name.includes(".") && !cols.get(name)?.child) {
        // 親の列の値（行に繰り返し入っている）。変更は cells で渡す約束なので、違っていれば止める
        const effective = acc.parentSets.has(name) ? acc.parentSets.get(name)! : (acc.record.attrs[name] ?? null);
        if (!sameCell(v, effective)) throw new CommitInvariantError("INPUT", `追加行 ${row.rowKey} の親の列 ${name} が親の値と違う（親の変更は cells で渡す）`);
        continue;
      }
      const r = resolve(name);
      if (r.child !== kind) {
        if (isNullish(v)) continue;
        throw new CommitInvariantError("INPUT", `追加行 ${row.rowKey} に別の種類の子の列 ${name} がある`);
      }
      if (idAttr && r.attr === idAttr) {
        if (isNullish(v)) continue;
        throw new CommitInvariantError("I4", `追加する子に ID 属性 ${name} を付けない`);
      }
      if (isNullish(v)) continue; // 追加では空の属性を送らない
      if (r.schema.readOnly) throw new CommitInvariantError("I5", `列 ${name} は読み取り専用`);
      attrs[r.attr] = v;
    }
    if (Object.keys(attrs).length === 0) throw new CommitInvariantError("I6", `追加行 ${row.rowKey} に送る属性が無い`);
    let list = acc.adds.get(kind);
    if (!list) acc.adds.set(kind, (list = []));
    list.push(attrs);
    touchKind(acc, kind);
  }

  // 4) 計画にまとめる
  const plans: CommitPlan[] = [];
  let totalDeletes = 0;
  for (const key of order) {
    const acc = accs.get(key);
    if (!acc) continue;
    const rec = acc.record;
    const attrs: Record<string, CellValue> = {};
    for (const [a, v] of acc.parentSets) {
      const base = rec.attrs[a] ?? null;
      if (sameCell(v, base)) continue;
      if (isNullish(v) && !opts.allowNull) throw new CommitInvariantError("I10", `親の列 ${a} を空にする変更には allowNull が必要`);
      attrs[a] = v;
    }
    const children: Record<string, ChildCommitOp[]> = {};
    let parentDeletes = 0;
    for (const kind of acc.kinds) {
      const ops: ChildCommitOp[] = [];
      const deletes = acc.deletes.get(kind) ?? new Map<string, MaximoChild>();
      for (const [id, ch] of acc.changes.get(kind) ?? []) {
        if (deletes.has(id)) continue;
        const changed: Record<string, CellValue> = {};
        for (const [a, v] of ch.attrs) {
          const base = ch.child.attrs[a] ?? null;
          if (sameCell(v, base)) continue;
          if (isNullish(v) && !opts.allowNull) throw new CommitInvariantError("I10", `子の列 ${kind}.${a} を空にする変更には allowNull が必要`);
          changed[a] = v;
        }
        if (Object.keys(changed).length > 0) ops.push({ action: "Change", idAttr: ch.child.idAttr!, id: ch.child.id, attrs: changed });
      }
      for (const child of deletes.values()) {
        ops.push({ action: "Delete", idAttr: child.idAttr!, id: child.id });
        parentDeletes++;
      }
      for (const a of acc.adds.get(kind) ?? []) ops.push({ action: "Add", attrs: a });
      if (ops.length > 0) children[kind] = ops;
    }
    if (parentDeletes > COMMIT_LIMITS.maxDeletesPerParent && !opts.deletesConfirmed) {
      throw new CommitInvariantError("I3", `親 ${key} の削除が ${parentDeletes} 件で上限 ${COMMIT_LIMITS.maxDeletesPerParent} を超える（確認が必要）`);
    }
    totalDeletes += parentDeletes;
    if (Object.keys(attrs).length === 0 && Object.keys(children).length === 0) continue;
    const expectedChildIds: Record<string, CellValue[]> = {};
    const expectedChildRowstamps: Record<string, Record<string, string | null>> = {};
    for (const [kind, ops] of Object.entries(children)) {
      const loaded = (rec.children[kind] ?? []).filter((c) => c.idAttr && c.id !== null);
      expectedChildIds[kind] = loaded.map((c) => c.id);
      const touched: Record<string, string | null> = {};
      for (const op of ops) {
        if (op.action === "Add") continue;
        touched[String(op.id)] = loaded.find((c) => String(c.id) === String(op.id))?.rowstamp ?? null;
      }
      if (Object.keys(touched).length > 0) expectedChildRowstamps[kind] = touched;
    }
    plans.push({ parentKey: key, href: rec.href, expectedRowstamp: rec.rowstamp, expectedChildIds, expectedChildRowstamps, attrs, children });
  }
  if (totalDeletes > COMMIT_LIMITS.maxDeletesTotal && !opts.deletesConfirmed) {
    throw new CommitInvariantError("I3", `削除が合計 ${totalDeletes} 件で上限 ${COMMIT_LIMITS.maxDeletesTotal} を超える（確認が必要）`);
  }
  validatePlans(plans, { allowNull: opts.allowNull ?? false, deletesConfirmed: opts.deletesConfirmed ?? false, childIdAttrs });
  return plans;
}

function findLoadedChild(record: MaximoRecord, kind: string, childId: string | null): MaximoChild {
  const list = record.children[kind];
  if (!list) throw new CommitInvariantError("I2", `子 ${kind} は読み込み時に存在しない`);
  if (childId === null) throw new CommitInvariantError("I2", `子 ${kind} の行キーに ID が無い`);
  const found = list.filter((c) => c.idAttr && c.id !== null && String(c.id) === childId);
  if (found.length !== 1) throw new CommitInvariantError("I2", `子 ${kind} の ID が読み込み時の子に無い（ID 不明の子は変更・削除できない）`);
  return found[0]!;
}

function assertWritableParent(r: { name: string; schema: { readOnly?: boolean }; attr: string }, keyCols: Set<string>): void {
  if (keyCols.has(r.attr)) throw new CommitInvariantError("I5", `キー列 ${r.name} は変更できない`);
  if (r.schema.readOnly) throw new CommitInvariantError("I5", `列 ${r.name} は読み取り専用`);
}

function assertHref(href: string): void {
  if (typeof href !== "string" || href === "") throw new CommitInvariantError("I7", "読み込み時の href が無い");
  if (href.includes("?") || href.includes("#")) throw new CommitInvariantError("I7", "href にクエリやフラグメントが含まれている");
  if (!/^https?:\/\//i.test(href) && !href.startsWith("/")) throw new CommitInvariantError("I7", "href が URL ではない");
}

/** 列定義に照らして送ってよい列か（I5）。keySet を渡すと親のキー列も拒否する */
function assertWritableColumn(colMap: Map<string, ColumnSchema>, keySet: Set<string> | null, name: string): void {
  const col = colMap.get(name);
  if (!col) throw new CommitInvariantError("I5", `列 ${name} はシートの列に無い`);
  if (col.readOnly) throw new CommitInvariantError("I5", `列 ${name} は読み取り専用`);
  if (keySet?.has(name)) throw new CommitInvariantError("I5", `キー列 ${name} は変更できない`);
}

export function isNullish(v: CellValue | undefined): boolean {
  return v === null || v === undefined || v === "";
}

/** 差分判定の等価（null と空文字は同じとみなす） */
export function sameCell(a: CellValue | undefined, b: CellValue | undefined): boolean {
  if (isNullish(a) && isNullish(b)) return true;
  return a === b;
}

export interface ValidatePlanOptions {
  allowNull: boolean;
  deletesConfirmed: boolean;
  childIdAttrs?: Record<string, string | null>;
  /** シートの列定義。渡すと I5（列に有る・readOnly でない・キー列でない）も検査する */
  columns?: ColumnSchema[];
  keyColumns?: string[];
}

/** 計画そのものの不変条件を検査する（送信前にもう一度呼ぶ） */
export function validatePlans(plans: ParentCommitPlan[], opts: ValidatePlanOptions): void {
  if (plans.length > COMMIT_LIMITS.maxParentsPerPlan) {
    throw new CommitInvariantError("I8", `1 回の反映は ${COMMIT_LIMITS.maxParentsPerPlan} 親までにする（${plans.length} 件）`);
  }
  const idAttrs = upperKeys(opts.childIdAttrs ?? {});
  const colMap = opts.columns ? new Map(opts.columns.map((c) => [c.name.toUpperCase(), c])) : null;
  const keySet = new Set((opts.keyColumns ?? []).map((k) => k.toUpperCase()));
  const seen = new Set<string>();
  const seenHref = new Set<string>();
  let totalDeletes = 0;
  for (const plan of plans) {
    if (seen.has(plan.parentKey)) throw new CommitInvariantError("INPUT", `親 ${plan.parentKey} の計画が重複している`);
    seen.add(plan.parentKey);
    assertHref(plan.href);
    // 送信先はオリジンを捨てたパスで決まるので、パスで重複を見る（キー列の選び方の誤りで同じレコードに 2 回送らない）
    const hrefPath = plan.href.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, "");
    if (seenHref.has(hrefPath)) throw new CommitInvariantError("INPUT", `親 ${plan.parentKey} の href が別の計画と同じ`);
    seenHref.add(hrefPath);
    for (const [a, v] of Object.entries(plan.attrs)) {
      if (!ATTR_RE.test(a) || a.startsWith("_")) throw new CommitInvariantError("I5", `属性名 ${a} が不正`);
      if (isNullish(v) && !opts.allowNull) throw new CommitInvariantError("I10", `親の列 ${a} を空にする変更には allowNull が必要`);
      if (colMap) assertWritableColumn(colMap, keySet, a.toUpperCase());
    }
    let deletes = 0;
    for (const [kind, ops] of Object.entries(plan.children)) {
      if (!ATTR_RE.test(kind)) throw new CommitInvariantError("I5", `子オブジェクト名 ${kind} が不正`);
      if (!Array.isArray(ops) || ops.length === 0) throw new CommitInvariantError("I6", `子 ${kind} の配列が空`);
      const expected = new Set((plan.expectedChildIds[kind] ?? []).map((x) => String(x)));
      // シートの定義で ID 属性が不明（null）とされた子は、計画に ID があっても変更・削除しない
      const configured = Object.prototype.hasOwnProperty.call(idAttrs, kind.toUpperCase()) ? idAttrs[kind.toUpperCase()] : undefined;
      if (configured === null && ops.some((o) => o.action !== "Add")) {
        throw new CommitInvariantError("I2", `子 ${kind} は ID 属性が分からないので変更・削除できない`);
      }
      const kindIdAttr = configured ?? ops.find((o) => o.action !== "Add")?.idAttr ?? null;
      for (const op of ops) {
        if (op.action === "Change" || op.action === "Delete") {
          if (!op.idAttr || !ATTR_RE.test(op.idAttr) || op.id === null || !expected.has(String(op.id))) {
            throw new CommitInvariantError("I2", `子 ${kind} の ${op.action} の ID が読み込み時の子に無い`);
          }
          if (kindIdAttr && op.idAttr.toUpperCase() !== kindIdAttr.toUpperCase()) throw new CommitInvariantError("I2", `子 ${kind} の ID 属性が一致しない`);
          if (op.action === "Delete") deletes++;
        }
        if (op.action === "Change" || op.action === "Add") {
          const keys = Object.keys(op.attrs);
          if (keys.length === 0) throw new CommitInvariantError("I6", `子 ${kind} の ${op.action} に属性が無い`);
          for (const a of keys) {
            if (!ATTR_RE.test(a) || a.startsWith("_")) throw new CommitInvariantError("I5", `属性名 ${kind}.${a} が不正`);
            if (kindIdAttr && a.toUpperCase() === kindIdAttr.toUpperCase()) {
              throw new CommitInvariantError(op.action === "Add" ? "I4" : "I5", `子 ${kind} の ${op.action} に ID 属性を属性として入れない`);
            }
            if (isNullish(op.attrs[a]) && !(op.action === "Change" && opts.allowNull)) {
              throw new CommitInvariantError("I10", `子の列 ${kind}.${a} を空にする変更には allowNull が必要`);
            }
            if (colMap) assertWritableColumn(colMap, null, `${kind.toUpperCase()}.${a.toUpperCase()}`);
          }
        }
      }
    }
    if (deletes > COMMIT_LIMITS.maxDeletesPerParent && !opts.deletesConfirmed) {
      throw new CommitInvariantError("I3", `親 ${plan.parentKey} の削除が上限 ${COMMIT_LIMITS.maxDeletesPerParent} を超える（確認が必要）`);
    }
    totalDeletes += deletes;
  }
  if (totalDeletes > COMMIT_LIMITS.maxDeletesTotal && !opts.deletesConfirmed) {
    throw new CommitInvariantError("I3", `削除の合計が上限 ${COMMIT_LIMITS.maxDeletesTotal} を超える（確認が必要）`);
  }
}

// ---------------------------------------------------------------------------
// リクエストの組み立て
// ---------------------------------------------------------------------------

export interface PatchRequest {
  url: string;
  method: "POST";
  headers: {
    "x-method-override": "PATCH";
    patchtype: "MERGE";
    transactionid: string;
    batcherror: "1";
    properties: "*";
    "content-type": "application/json";
  };
  body: Record<string, unknown>;
}

/** 親 1 件分の PATCH（POST + x-method-override）を組み立てる。lean 形式なので属性名は小文字 */
export function buildPatchRequest(plan: ParentCommitPlan, transactionId: string): PatchRequest {
  if (typeof transactionId !== "string" || !/^[A-Za-z0-9_.:~-]{1,128}$/.test(transactionId)) throw new CommitInvariantError("INPUT", "transactionid が不正");
  assertHref(plan.href);
  const body: Record<string, unknown> = {};
  for (const [a, v] of Object.entries(plan.attrs)) body[a.toLowerCase()] = v;
  for (const [kind, ops] of Object.entries(plan.children)) {
    if (ops.length === 0) throw new CommitInvariantError("I6", `子 ${kind} の配列が空`);
    const key = kind.toLowerCase();
    if (key in body) throw new CommitInvariantError("INPUT", `子オブジェクト名 ${kind} が親の属性名と衝突する`);
    body[key] = ops.map((op) => {
      switch (op.action) {
        case "Change":
          return { [op.idAttr.toLowerCase()]: op.id, ...lowerAttrs(op.attrs), _action: "Change" };
        case "Delete":
          return { [op.idAttr.toLowerCase()]: op.id, _action: "Delete" };
        case "Add":
          return lowerAttrs(op.attrs);
      }
    });
  }
  const req: PatchRequest = {
    url: `${plan.href}?lean=1`,
    method: "POST",
    headers: {
      "x-method-override": "PATCH",
      patchtype: "MERGE",
      transactionid: transactionId,
      batcherror: "1",
      properties: "*",
      "content-type": "application/json",
    },
    body,
  };
  assertSafePatchRequest(req, plan);
  return req;
}

/** 送信直前の検査（I1 MERGE、I6 空配列、I7 href） */
export function assertSafePatchRequest(req: PatchRequest, plan: ParentCommitPlan): void {
  const h = req.headers as Record<string, unknown>;
  if (req.method !== "POST" || h["x-method-override"] !== "PATCH") throw new CommitInvariantError("I1", "PATCH（x-method-override）でない");
  if (h.patchtype !== "MERGE") throw new CommitInvariantError("I1", "patchtype: MERGE が付いていない");
  if (req.url !== `${plan.href}?lean=1`) throw new CommitInvariantError("I7", "送信先が読み込み時の href と一致しない");
  for (const [k, v] of Object.entries(req.body)) {
    if (Array.isArray(v) && v.length === 0) throw new CommitInvariantError("I6", `子 ${k} の配列が空`);
  }
}

function lowerAttrs(attrs: Record<string, CellValue>): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  for (const [a, v] of Object.entries(attrs)) out[a.toLowerCase()] = v;
  return out;
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

export interface CommitRowOutcome extends CommitRowResult {
  transactionId: string | null;
  /** リクエストを Maximo へ送った（結果が不明な場合を含む） */
  sent: boolean;
}

export interface ExecuteCommitOptions {
  onRow?: (result: CommitRowOutcome, plan: ParentCommitPlan) => void;
  /** 最初に送った 1 件（カナリア）の結果を人に見せ、続行してよければ true を返す */
  waitForCanaryContinue: (canary: CommitRowOutcome) => Promise<boolean>;
  /** 削除件数の上限超えを人が確認した（I3） */
  maxDeletesConfirmed?: boolean;
  /** null への変更を許す（I10） */
  allowNull?: boolean;
  /** 子オブジェクト名 → ID 属性（SheetMeta.childIdAttrs）。追加だけの子の照合に使う */
  childIdAttrs?: Record<string, string | null>;
  /** シートの定義。渡すと送信前に I5（readOnly・キー列）も検査し直す。childIdAttrs が無ければここから取る */
  meta?: Pick<SheetMeta, "columns" | "keyColumns" | "childIdAttrs">;
  /** error / unknown になったら残りを skipped にする（既定 true） */
  stopOnFailure?: boolean;
  makeTransactionId?: (plan: ParentCommitPlan, index: number) => string;
  /**
   * シートを読み込んだオブジェクト構造（例 MXAPIWO）。渡すと、送信先をその構造のレコード（/api/os/mxapiwo/...）に限る（I7）。
   * 読み込みに使った構造とは別の構造へ書き込まないため。
   */
  os?: string;
}

/**
 * 計画を 1 親ずつ実行する。precheck（読み直し照合）→ 送信 → verify。
 * - precheck で _rowstamp か子 ID 集合が違えば conflict（送らない）
 * - 2xx → verify（読み直して変更した属性・子操作が反映されているか。変更していない子が消えていないか）
 * - 409 → reconcile（読み直して反映済みなら verified、未反映・読み直し失敗なら unknown）
 * - 通信エラー・タイムアウト / reasonCode の無い 5xx / JSON でない 2xx・リダイレクト → 読み直した結果を message に書き、状態は unknown
 * - reasonCode 付きのエラー → error。送る前にクライアントが止めた場合（API キー未設定など）は error（sent:false）
 * - 送信先（I7）・transactionid・本文は、1 件も送らないうちに全計画分を検査する（違反は例外）
 * - onRow が例外を投げたら残りは skipped にして結果を返す
 * 自動再試行はしない。
 */
export async function executeCommit(client: MaximoClient, plans: CommitPlan[], opts: ExecuteCommitOptions): Promise<CommitRowOutcome[]> {
  const idAttrsOpt = upperKeys(opts.childIdAttrs ?? opts.meta?.childIdAttrs ?? {});
  validatePlans(plans, {
    allowNull: opts.allowNull ?? false,
    deletesConfirmed: opts.maxDeletesConfirmed ?? false,
    childIdAttrs: idAttrsOpt,
    columns: opts.meta?.columns,
    keyColumns: opts.meta?.keyColumns,
  });
  const stopOnFailure = opts.stopOnFailure ?? true;
  // 送信先・transactionid・本文は、1 件も送らないうちに全計画分を組み立てて検査する（途中で例外にならないように）
  const prepared = preparePlans(client, plans, opts.makeTransactionId ?? defaultTransactionId(), opts.os);
  const results: CommitRowOutcome[] = [];
  let canaryDone = false;
  let stopReason: string | null = null;
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]!;
    let result: CommitRowOutcome;
    if (stopReason !== null) {
      result = { rowKey: plan.parentKey, status: "skipped", message: stopReason, transactionId: null, sent: false };
    } else {
      result = await commitOne(client, plan, prepared[i]!, idAttrsOpt);
    }
    results.push(result);
    try {
      opts.onRow?.(result, plan);
    } catch {
      // 結果を画面に出せないまま書き込みを続けない。例外にすると結果の配列も失われるので、残りを skipped にして返す
      if (stopReason === null) stopReason = "結果の通知（onRow）に失敗したため送らなかった";
    }
    if (stopReason !== null) continue;
    if (stopOnFailure && (result.status === "error" || result.status === "unknown")) {
      stopReason = "前の行が失敗したため送らなかった";
      continue;
    }
    if (result.sent && !canaryDone) {
      canaryDone = true;
      if (i < plans.length - 1) {
        let ok = false;
        try {
          ok = await opts.waitForCanaryContinue(result);
        } catch {
          ok = false;
        }
        if (!ok) stopReason = "カナリアの確認で続行しなかった";
      }
    }
  }
  return results;
}

function defaultTransactionId(): (plan: ParentCommitPlan, index: number) => string {
  const run = `${Date.now().toString(36)}-${randomToken()}`;
  return (_plan, index) => `mxs-${run}-${index}`;
}

function randomToken(): string {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") {
    const b = new Uint8Array(6);
    c.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(16).slice(2, 14);
}

interface Snapshot {
  rowstamp: string | null;
  attrs: Record<string, CellValue>;
  children: Record<string, MaximoChild[]>;
}

interface PreparedPlan {
  /** 読み直しに使う path（クエリなし） */
  path: string;
  /** 送信に使う path（?lean=1 付き） */
  postPath: string;
  transactionId: string;
  req: PatchRequest;
}

/**
 * 1 件も送らないうちに、全計画の送信先（I7）・transactionid・本文（I1/I6）を組み立てて検査する。
 * 違反は CommitInvariantError（何も送っていない）。
 */
function preparePlans(client: MaximoClient, plans: ParentCommitPlan[], makeTx: (plan: ParentCommitPlan, index: number) => string, os?: string): PreparedPlan[] {
  if (os !== undefined && !/^[A-Za-z0-9_]+$/.test(os)) throw new CommitInvariantError("I7", `オブジェクト構造名 ${JSON.stringify(os)} が不正`);
  // 構造が分かっていれば、その構造のレコードだけを送信先にする（/maximo/api/os/mxapiwo/...）
  const osPrefix = `${client.apiRoot}/os/${os === undefined ? "" : `${os}/`}`.toLowerCase();
  const usedTx = new Set<string>();
  return plans.map((plan, index) => {
    let path: string;
    try {
      path = client.hrefToPath(plan.href);
    } catch (e) {
      throw new CommitInvariantError("I7", `親 ${plan.parentKey} の href を送信先にできない: ${errMessage(e)}`);
    }
    // 書き込みはオブジェクト構造のレコード（/maximo/api/os/...）にだけ送る
    if (!path.toLowerCase().startsWith(osPrefix) || path.includes("?")) {
      throw new CommitInvariantError(
        "I7",
        os === undefined
          ? `親 ${plan.parentKey} の href がオブジェクト構造のレコードを指していない`
          : `親 ${plan.parentKey} の href がシートを読み込んだオブジェクト構造 ${os.toUpperCase()} のレコードを指していない`,
      );
    }
    const transactionId = makeTx(plan, index);
    // 同じ transactionid を別の親に使うと 409 になり、どちらが反映されたか確かめられなくなる
    if (usedTx.has(transactionId)) throw new CommitInvariantError("INPUT", "transactionid が同じ実行の中で重複している");
    usedTx.add(transactionId);
    const req = buildPatchRequest(plan, transactionId);
    return { path, postPath: client.hrefToPath(req.url), transactionId, req };
  });
}

async function commitOne(client: MaximoClient, plan: CommitPlan, prep: PreparedPlan, idAttrsOpt: Record<string, string | null>): Promise<CommitRowOutcome> {
  const base = { rowKey: plan.parentKey };
  const idAttrs: Record<string, string | null> = {};
  for (const [kind, ops] of Object.entries(plan.children)) {
    const fromOps = ops.find((o) => o.action !== "Add");
    idAttrs[kind] = (idAttrsOpt[kind.toUpperCase()] ?? (fromOps && "idAttr" in fromOps ? fromOps.idAttr : null))?.toUpperCase() ?? null;
  }
  const { path, transactionId, req } = prep;
  const select = snapshotSelect(plan, idAttrs);

  // 1) precheck
  let before: Snapshot;
  try {
    before = await readSnapshot(client, path, select, idAttrs);
  } catch (e) {
    const status = e instanceof MaximoError && e.status === 404 ? "conflict" : "error";
    return { ...base, status, ...errFields(e), message: `送信前の読み直しに失敗したため送らなかった: ${errMessage(e)}`, transactionId: null, sent: false };
  }
  const conflict = compareExpected(plan, before, idAttrs);
  if (conflict) return { ...base, status: "conflict", message: conflict, transactionId: null, sent: false };

  // 2) 送信（組み立て済みの要求を送る直前にもう一度検査する）
  assertSafePatchRequest(req, plan);
  let httpStatus: number | undefined;
  try {
    const res = await client.post(prep.postPath, { ...req.headers }, req.body);
    httpStatus = res.status;
  } catch (e) {
    if (e instanceof MaximoError) {
      // 409 は transactionid の重複＝同じ要求を Maximo が処理済み。読み直して反映済みなら verified
      if (e.status === 409) return reconcile(client, plan, path, select, idAttrs, before, transactionId, "409（transactionid の重複）", e, "verified");
      if (e.reasonCode) return { ...base, status: "error", httpStatus: e.status, reasonCode: e.reasonCode, message: e.message, transactionId, sent: true };
      // reasonCode の無い 5xx、JSON でない 2xx（中継のログイン画面など）、リダイレクト（0・3xx）は、
      // Maximo が処理したかを応答から判断できないので結果不明にする
      if (e.status >= 500 || e.status < 400) {
        const cause = e.status >= 500 ? `HTTP ${e.status}` : `HTTP ${e.status}（応答を解釈できない）`;
        return reconcile(client, plan, path, select, idAttrs, before, transactionId, cause, e, "unknown");
      }
      return { ...base, status: "error", httpStatus: e.status, message: e.message, transactionId, sent: true };
    }
    if (e instanceof MaximoNetworkError) {
      // 応答を受け取れていないので結果は unknown。読み直しの結果は人の判断材料として message に書く
      return reconcile(client, plan, path, select, idAttrs, before, transactionId, e.timedOut ? "タイムアウト" : "通信エラー", null, "unknown");
    }
    // それ以外はクライアントが送る前に止めたもの（API キーが消えた等）。リクエストは送っていない
    return { ...base, status: "error", message: `送信前に止めたため送らなかった: ${errMessage(e)}`, transactionId: null, sent: false };
  }

  // 3) verify
  let after: Snapshot;
  try {
    after = await readSnapshot(client, path, select, idAttrs);
  } catch (e) {
    return { ...base, status: "unknown", httpStatus, message: `送信後の読み直しに失敗した: ${errMessage(e)}`, transactionId, sent: true };
  }
  const mismatches = verifyAgainstPlan(plan, before, after, idAttrs);
  if (mismatches.length === 0) return { ...base, status: "verified", httpStatus, transactionId, sent: true };
  return { ...base, status: "unknown", httpStatus, message: `送信は成功したが読み直した値が一致しない: ${mismatches.join(", ")}`, transactionId, sent: true };
}

async function reconcile(
  client: MaximoClient,
  plan: ParentCommitPlan,
  path: string,
  select: string,
  idAttrs: Record<string, string | null>,
  before: Snapshot,
  transactionId: string,
  cause: string,
  err: MaximoError | null,
  /** 読み直しで反映済みだったときの状態。応答を受け取れていない場合は unknown のままにする */
  whenReflected: "verified" | "unknown",
): Promise<CommitRowOutcome> {
  const fields: Partial<CommitRowOutcome> = {};
  if (err) {
    fields.httpStatus = err.status;
    if (err.reasonCode) fields.reasonCode = err.reasonCode;
  }
  let after: Snapshot;
  try {
    after = await readSnapshot(client, path, select, idAttrs);
  } catch (e) {
    return { rowKey: plan.parentKey, ...fields, status: "unknown", message: `${cause}。読み直しにも失敗したため結果不明: ${errMessage(e)}`, transactionId, sent: true };
  }
  const mismatches = verifyAgainstPlan(plan, before, after, idAttrs);
  if (mismatches.length === 0) {
    if (whenReflected === "unknown") {
      return {
        rowKey: plan.parentKey,
        ...fields,
        status: "unknown",
        message: `${cause}。読み直しでは反映済みに見えるが、応答を受け取れていないため結果不明として扱う（自動では再送しない）`,
        transactionId,
        sent: true,
      };
    }
    return { rowKey: plan.parentKey, ...fields, status: "verified", message: `${cause}。読み直しで反映を確認した`, transactionId, sent: true };
  }
  return {
    rowKey: plan.parentKey,
    ...fields,
    status: "unknown",
    message: `${cause}。読み直しでは未反映（${mismatches.join(", ")}）。自動では再送しない`,
    transactionId,
    sent: true,
  };
}

function snapshotSelect(plan: ParentCommitPlan, idAttrs: Record<string, string | null>): string {
  const parts = ["_rowstamp", ...Object.keys(plan.attrs).map((a) => a.toLowerCase())];
  for (const [kind, ops] of Object.entries(plan.children)) {
    const inner: string[] = [];
    const idAttr = idAttrs[kind];
    if (idAttr) inner.push(idAttr.toLowerCase());
    inner.push("_rowstamp");
    for (const op of ops) {
      if (op.action === "Delete") continue;
      for (const a of Object.keys(op.attrs)) if (!inner.includes(a.toLowerCase())) inner.push(a.toLowerCase());
    }
    parts.push(`${kind.toLowerCase()}{${inner.join(",")}}`);
  }
  return parts.join(",");
}

async function readSnapshot(client: MaximoClient, path: string, select: string, idAttrs: Record<string, string | null>): Promise<Snapshot> {
  const json = await client.get(`${path}?lean=1&oslc.select=${encodeURIComponent(select)}`);
  const rec = parseMember(json, upperKeys(idAttrs), { requireHref: false });
  return { rowstamp: rec.rowstamp, attrs: rec.attrs, children: upperKeys(rec.children) };
}

function compareExpected(plan: CommitPlan, snap: Snapshot, idAttrs: Record<string, string | null>): string | null {
  // 読み込み時の _rowstamp が無いと他の人の更新を検知できないので送らない
  if (plan.expectedRowstamp === null) return "読み込み時の _rowstamp が無く、他の更新と照合できないため送らなかった";
  if (snap.rowstamp !== plan.expectedRowstamp) {
    return "読み込み後に Maximo 側で親レコードが更新された（_rowstamp が違う）ため送らなかった";
  }
  for (const kind of Object.keys(plan.children)) {
    if (!idAttrs[kind]) continue; // ID の分からない子（追加だけ）は集合を照合できない
    const expected = new Set((plan.expectedChildIds[kind] ?? []).map((x) => String(x)));
    const actual = new Set((snap.children[kind.toUpperCase()] ?? []).filter((c) => c.id !== null).map((c) => String(c.id)));
    if (expected.size !== actual.size || [...expected].some((x) => !actual.has(x))) {
      return `読み込み後に子 ${kind} の集合が変わったため送らなかった`;
    }
  }
  // 変更・削除する子の _rowstamp（子だけの更新では親の _rowstamp が変わらないことがあるため）。
  // 値を持つ計画（planCommit が作ったもの）では、変更・削除するすべての子の分がそろっていなければ照合できないので送らない
  if (plan.expectedChildRowstamps !== undefined) {
    for (const [kind, ops] of Object.entries(plan.children)) {
      const touched = plan.expectedChildRowstamps[kind] ?? {};
      for (const op of ops) {
        if (op.action !== "Add" && !Object.prototype.hasOwnProperty.call(touched, String(op.id))) {
          return `子 ${kind} の読み込み時の _rowstamp が計画に無く、照合できないため送らなかった`;
        }
      }
    }
  }
  for (const [kind, touched] of Object.entries(plan.expectedChildRowstamps ?? {})) {
    const list = snap.children[kind.toUpperCase()] ?? [];
    for (const [id, rowstamp] of Object.entries(touched)) {
      const c = list.find((x) => x.id !== null && String(x.id) === id);
      if (!c) return `読み込み後に子 ${kind} が見つからなくなったため送らなかった`;
      if (rowstamp === null || c.rowstamp !== rowstamp) return `読み込み後に子 ${kind} が更新された（_rowstamp が違う）ため送らなかった`;
    }
  }
  return null;
}

/** 読み直した結果が計画どおりか。一致しない項目の名前だけを返す（値は含めない） */
function verifyAgainstPlan(plan: ParentCommitPlan, before: Snapshot, after: Snapshot, idAttrs: Record<string, string | null>): string[] {
  const mism: string[] = [];
  for (const [a, v] of Object.entries(plan.attrs)) {
    if (!sameValue(v, after.attrs[a.toUpperCase()])) mism.push(a.toUpperCase());
  }
  for (const [kind, ops] of Object.entries(plan.children)) {
    const K = kind.toUpperCase();
    const beforeList = before.children[K] ?? [];
    const afterList = after.children[K] ?? [];
    const idAttr = idAttrs[kind];
    const adds = ops.filter((o): o is Extract<ChildCommitOp, { action: "Add" }> => o.action === "Add");
    if (idAttr) {
      const afterById = new Map(afterList.filter((c) => c.id !== null).map((c) => [String(c.id), c]));
      const deleted = new Set(ops.filter((o) => o.action === "Delete").map((o) => String((o as { id: CellValue }).id)));
      for (const op of ops) {
        if (op.action === "Change") {
          const c = afterById.get(String(op.id));
          if (!c) {
            mism.push(`${K}（変更した子が見つからない）`);
            continue;
          }
          for (const [a, v] of Object.entries(op.attrs)) if (!sameValue(v, c.attrs[a.toUpperCase()])) mism.push(`${K}.${a.toUpperCase()}`);
        } else if (op.action === "Delete") {
          if (afterById.has(String(op.id))) mism.push(`${K}（削除が未反映）`);
        }
      }
      const beforeIds = new Set(beforeList.filter((c) => c.id !== null).map((c) => String(c.id)));
      for (const id of beforeIds) {
        if (!deleted.has(id) && !afterById.has(id)) {
          mism.push(`${K}（変更していない子が消えた）`);
          break;
        }
      }
      const newChildren = afterList.filter((c) => c.id === null || !beforeIds.has(String(c.id)));
      if (!matchAdds(adds, newChildren)) mism.push(`${K}（追加が未反映）`);
      else if (newChildren.length > adds.length) mism.push(`${K}（想定外の子が増えた）`);
    } else {
      if (afterList.length !== beforeList.length + adds.length) mism.push(`${K}（子の件数が合わない）`);
      else if (!matchAddsByCount(adds, beforeList, afterList)) mism.push(`${K}（追加が未反映）`);
    }
  }
  return mism;
}

/** 追加した属性を持つ新しい子が、追加の数だけ（1 対 1 で）あるか */
function matchAdds(adds: Array<{ attrs: Record<string, CellValue> }>, candidates: MaximoChild[]): boolean {
  const used = new Set<number>();
  for (const add of adds) {
    const idx = candidates.findIndex((c, i) => !used.has(i) && attrsMatch(add.attrs, c));
    if (idx < 0) return false;
    used.add(idx);
  }
  return true;
}

/** ID の分からない子: 追加した属性に一致する子の数が、追加の数だけ増えているか */
function matchAddsByCount(adds: Array<{ attrs: Record<string, CellValue> }>, beforeList: MaximoChild[], afterList: MaximoChild[]): boolean {
  for (const add of adds) {
    const same = adds.filter((x) => Object.keys(x.attrs).length === Object.keys(add.attrs).length && attrsMatchPlain(add.attrs, x.attrs)).length;
    const b = beforeList.filter((c) => attrsMatch(add.attrs, c)).length;
    const a = afterList.filter((c) => attrsMatch(add.attrs, c)).length;
    if (a - b < same) return false;
  }
  return true;
}

function attrsMatch(sent: Record<string, CellValue>, child: MaximoChild): boolean {
  return Object.entries(sent).every(([a, v]) => sameValue(v, child.attrs[a.toUpperCase()]));
}

function attrsMatchPlain(x: Record<string, CellValue>, y: Record<string, CellValue>): boolean {
  return Object.entries(x).every(([a, v]) => sameValue(v, y[a] ?? null));
}

/**
 * 送った値と読み直した値の比較。null と空文字と省略は同じ、数値は数値として、
 * 日付だけの値（YYYY-MM-DD）は読み直した日時の先頭と比べる。日時は時刻として比べる。
 */
export function sameValue(sent: CellValue, got: CellValue | undefined): boolean {
  const g = got === undefined ? null : got;
  if (sent === null || g === null || isNullish(sent) || isNullish(g)) return isNullish(sent) && isNullish(g);
  if (sent === g) return true;
  if (typeof sent === "number") return (typeof g === "number" || (typeof g === "string" && g.trim() !== "")) && Number(g) === sent;
  if (typeof sent === "boolean") return g === (sent ? 1 : 0);
  if (typeof g === "number") return sent.trim() !== "" && Number(sent) === g;
  if (typeof g === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(sent)) return g.startsWith(`${sent}T`) || g === sent;
    if (/^\d{4}-\d{2}-\d{2}T/.test(sent) && /^\d{4}-\d{2}-\d{2}T/.test(g)) {
      const a = Date.parse(sent);
      const b = Date.parse(g);
      return Number.isFinite(a) && a === b;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 書き込みログ（キーと結果だけ。属性値は入れない）
// ---------------------------------------------------------------------------

export interface WriteLogEntry {
  at: string;
  parentKey: string;
  transactionId: string | null;
  ops: { change: number; delete: number; add: number; attrs: string[] };
  httpStatus: number | null;
  reasonCode: string | null;
  result: CommitRowResult["status"];
}

export function writeLogEntry(plan: ParentCommitPlan, result: CommitRowOutcome, at: number = Date.now()): WriteLogEntry {
  let change = 0;
  let del = 0;
  let add = 0;
  const attrs = new Set<string>(Object.keys(plan.attrs).map((a) => a.toUpperCase()));
  for (const [kind, ops] of Object.entries(plan.children)) {
    for (const op of ops) {
      if (op.action === "Delete") {
        del++;
        continue;
      }
      if (op.action === "Change") change++;
      else add++;
      for (const a of Object.keys(op.attrs)) attrs.add(`${kind.toUpperCase()}.${a.toUpperCase()}`);
    }
  }
  return {
    at: new Date(at).toISOString(),
    parentKey: plan.parentKey,
    transactionId: result.transactionId,
    ops: { change, delete: del, add, attrs: [...attrs].sort() },
    httpStatus: result.httpStatus ?? null,
    reasonCode: result.reasonCode ?? null,
    result: result.status,
  };
}

function errMessage(e: unknown): string {
  if (e instanceof MaximoError) return e.reasonCode ? `${e.reasonCode} ${e.message}` : e.message;
  if (e instanceof Error) return e.message;
  return "不明なエラー";
}

function errFields(e: unknown): { httpStatus?: number; reasonCode?: string } {
  if (!(e instanceof MaximoError)) return {};
  const out: { httpStatus?: number; reasonCode?: string } = { httpStatus: e.status };
  if (e.reasonCode) out.reasonCode = e.reasonCode;
  return out;
}
