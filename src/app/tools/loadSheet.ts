// load_sheet の計画: オブジェクト構造の属性で select / where / orderBy を検査し、シートの列・キー列・子の ID 属性を決める。

import type { ColumnSchema, TypedFilter } from "../../shared/model";
import type { SheetMeta } from "../../shared/sheet";
import type { ToolArgs } from "../../shared/toolDefs";
import type { ObjectStructureInfo } from "../maximo/meta";
import { buildOrderBy, buildSelect, buildWhere, QueryBuildError, splitColumnName } from "../maximo/query";
import { compileFilters } from "../store";
import { findClassDefs, findClassLabels, parentClassColumn, pivotSpecFor, type DefinitionSheet } from "../grid/pivot";
import { invalidArgs, messageOf, withSuggestions } from "./errors";

export const CHILD_ID_NOTE =
  "The ID attributes of child objects are inferred from naming rules (such as <child object name>ID) and need checking against the real Maximo. Children whose idAttr is null cannot be changed or deleted, only added.";

/**
 * 仕様の表（ASSETSPEC など、項目名と値の組の子）を読み込んだとき、作業画面が分類の階層パスと欠けを出すのに足りないものを LLM に知らせる。
 * 分類 ID が無い・分類のシート（HIERARCHYPATH と CLASSSPEC）が無いときだけ文を返す
 */
export function specificationNote(meta: Pick<SheetMeta, "columns" | "childIdAttrs">, others: Iterable<DefinitionSheet>): string | null {
  const specChild = Object.keys(meta.childIdAttrs).find((child) => pivotSpecFor(meta, child) !== null);
  if (specChild === undefined) return null;
  if (parentClassColumn(meta) === null) {
    return `The ${specChild} rows are shown one row per record in the work screen. Add CLASSSTRUCTUREID to select so the work screen can show each record's classification (hierarchy path) and mark missing specification items.`;
  }
  const list = [...others];
  const hasPaths = [...findClassLabels(list).values()].some((l) => l.path !== null);
  if (findClassDefs(list) !== null && hasPaths) return null;
  return (
    "To show each record's classification hierarchy path and mark missing specification items in the work screen, also load the classifications as a sheet: " +
    "the object structure for classifications (find it with find_object_structures), with CLASSSTRUCTUREID, HIERARCHYPATH, DESCRIPTION and the CLASSSPEC child (ASSETATTRID, MEASUREUNITID). Ask the user first."
  );
}

export interface KeyResolution {
  keyColumns: string[];
  /** schema: スキーマの主キー表示、inferred: 規則で推定、href: キー列なし（行を href で識別） */
  source: "schema" | "inferred" | "href";
  note?: string;
}

/**
 * 親のキー列を決める。
 * 1. スキーマの主キー表示（pk）があればそれ。
 * 2. 無ければ推定: 必須の親の列のうち名前が NUM で終わる列がちょうど 1 つなら、その列（SITEID か ORGID があれば先頭に足す）。
 * 3. それでも決まらなければキー列なし（行は Maximo の href で識別する）。
 * 2・3 は実機確認が必要。
 */
export function resolveKeyColumns(info: Pick<ObjectStructureInfo, "columns" | "keyColumns">): KeyResolution {
  if (info.keyColumns.length > 0) return { keyColumns: [...info.keyColumns], source: "schema" };
  const parents = info.columns.filter((c) => !c.child);
  const names = new Set(parents.map((c) => c.name));
  const nums = parents.filter((c) => c.required === true && /NUM$/.test(c.name));
  const only = nums.length === 1 ? nums[0] : undefined;
  if (only) {
    const scope = ["SITEID", "ORGID"].find((n) => names.has(n));
    const keys = scope ? [scope, only.name] : [only.name];
    return {
      keyColumns: keys,
      source: "inferred",
      note: `The schema does not mark a primary key, so ${keys.join(", ")} was inferred as the key by a rule (exactly one required column whose name ends in NUM${scope ? `, with ${scope} in front` : ""}). This needs checking against the real Maximo.`,
    };
  }
  return {
    keyColumns: [],
    source: "href",
    note: "The schema does not mark a primary key and no key could be inferred by rule, so rows are identified by their Maximo href (parent rows cannot be added). This needs checking against the real Maximo.",
  };
}

export type LoadSheetArgs = ToolArgs<"load_sheet">;

export interface SheetLoadPlan {
  os: string;
  meta: SheetMeta;
  keys: KeyResolution;
  /** Maximo から読む列（シートの列すべて。キー列は loadRecords が足す） */
  select: string[];
  /** 列名を大文字にそろえた条件（子は CHILD.ATTR） */
  where: TypedFilter[];
  orderBy: string[];
  /** 読み込む子オブジェクト → 子の ID 属性 */
  childIdAttrs: Record<string, string | null>;
  knownAttrs: Set<string>;
  /** 指定されていないが足した列（キー列、子の ID 列、子の条件の列） */
  addedColumns: string[];
}

/** 列名を大文字の "ATTR" / "CHILD.ATTR" にそろえる */
function normalizeName(raw: string, what: string): string {
  try {
    const p = splitColumnName(raw.trim());
    return p.child ? `${p.child}.${p.attr}` : p.attr;
  } catch (e) {
    throw invalidArgs(`${what} ${JSON.stringify(raw)} cannot be used: ${e instanceof Error ? e.message : ""}`);
  }
}

/** シートがどの接続先の、いつ保存した定義から読み込んだか（反映の前に今の接続先・定義と比べる） */
export interface StructureOrigin {
  baseUrl: string;
  loadedAt: number;
}

export function planSheetLoad(info: ObjectStructureInfo, args: LoadSheetArgs, origin?: StructureOrigin): SheetLoadPlan {
  const byName = new Map<string, ColumnSchema>(info.columns.map((c) => [c.name, c]));
  const known = new Set(byName.keys());
  const unknown: string[] = [];
  const check = (name: string) => {
    if (!known.has(name) && !unknown.includes(name)) unknown.push(name);
  };

  const selected: string[] = [];
  for (const raw of args.select) {
    const n = normalizeName(raw, "select column");
    check(n);
    if (!selected.includes(n)) selected.push(n);
  }
  const where: TypedFilter[] = args.where.map((f) => {
    const n = normalizeName(f.attr, "where column");
    check(n);
    const out: TypedFilter = { attr: n, op: f.op };
    if (f.value !== undefined) out.value = f.value;
    return out;
  });
  const orderBy = (args.orderBy ?? []).map((raw) => {
    const t = raw.trim();
    const n = normalizeName(t.replace(/^[+-]/, ""), "orderBy column");
    check(n);
    return `${t.startsWith("-") ? "-" : ""}${n}`;
  });
  if (unknown.length > 0) {
    const parts = unknown.map((n) => withSuggestions(`Column ${n} is not in the object structure ${info.os}`, n, known));
    throw invalidArgs(`${parts.join(". ")}. Check the attribute names with describe_object_structure`);
  }

  const keys = resolveKeyColumns(info);
  const childIdAttrs: Record<string, string | null> = {};
  for (const n of [...selected, ...where.map((f) => f.attr)]) {
    const child = byName.get(n)?.child;
    if (child && !(child in childIdAttrs)) childIdAttrs[child] = info.childIdAttrs[child] ?? null;
  }

  // 列の順: キー列 → select の順（子の最初の列の前にその子の ID 列）→ select に無い子の条件の列
  const order: string[] = [];
  const added: string[] = [];
  const push = (n: string, auto: boolean) => {
    if (order.includes(n)) return;
    order.push(n);
    if (auto) added.push(n);
  };
  const pushWithChildId = (n: string, auto: boolean) => {
    const child = byName.get(n)?.child;
    const idAttr = child ? childIdAttrs[child] : null;
    if (child && idAttr) {
      const idCol = `${child}.${idAttr}`;
      if (known.has(idCol)) push(idCol, !selected.includes(idCol));
    }
    push(n, auto);
  };
  for (const k of keys.keyColumns) push(k, !selected.includes(k));
  for (const n of selected) pushWithChildId(n, false);
  for (const f of where) if (byName.get(f.attr)?.child) pushWithChildId(f.attr, !selected.includes(f.attr));

  // Maximo へ送る前に、検索条件を組み立てられるかを確かめる（読み込みを始めてから失敗しないように）
  let postFilters: TypedFilter[];
  try {
    buildSelect([...keys.keyColumns, ...order], childIdAttrs, known);
    postFilters = buildWhere(where, known).postFilters;
    if (orderBy.length > 0) buildOrderBy(orderBy, known);
  } catch (e) {
    if (e instanceof QueryBuildError) throw invalidArgs(e.message);
    throw e;
  }
  // 子の属性の条件は Maximo へ送らずタブ内で評価するので、値の形もここで確かめる。
  // 後段フィルタの組み立てまで遅らせると、全ページを読み終えてから引数の誤りで失敗する
  try {
    const planned = new Set(order);
    compileFilters(postFilters, (c) => planned.has(c));
  } catch (e) {
    throw invalidArgs(messageOf(e));
  }

  const columns = order.map((n) => ({ ...(byName.get(n) as ColumnSchema) }));
  const source: SheetMeta["source"] = { kind: "maximo", os: info.os, select: order, where, maxRows: args.maxRows };
  if (orderBy.length > 0) source.orderBy = orderBy;
  if (origin !== undefined) {
    source.baseUrl = origin.baseUrl;
    source.structureLoadedAt = origin.loadedAt;
  }
  return {
    os: info.os,
    meta: { name: args.name, source, columns, keyColumns: keys.keyColumns, childIdAttrs },
    keys,
    select: order,
    where,
    orderBy,
    childIdAttrs,
    knownAttrs: known,
    addedColumns: added,
  };
}
