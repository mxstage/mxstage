// Maximo からのレコード取得（ページング）と、グリッドの平坦な行への変換。

import type { CellValue, TypedFilter } from "../../shared/model";
import { makeChildRowKey, makeParentKey, type MaximoChild, type MaximoRecord, type SheetMeta, type SheetRow } from "../../shared/sheet";
import { isRecord, type MaximoClient } from "./client";
import { buildOrderBy, buildSelect, buildWhere, splitColumnName, upperKeys } from "./query";

export interface LoadRecordsOptions {
  os: string;
  /** 列名（子は "CHILD.ATTR"） */
  select: string[];
  where?: TypedFilter[];
  /** "-WONUM" は降順 */
  orderBy?: string[];
  maxRows?: number;
  pageSize?: number;
  /** 同時に取るページ数（既定 4。1 にすると nextPage を順にたどる） */
  concurrency?: number;
  /** 子オブジェクト名 → 子の ID 属性（describe の結果） */
  childIdAttrs: Record<string, string | null>;
  /** スキーマの列名の集合。select / where / orderBy の検査に使う */
  knownAttrs: Set<string>;
  /** 親のキー列。select に無ければ足す（行キーに必要なため） */
  keyColumns?: string[];
  signal?: AbortSignal;
}

export interface LoadRecordsResult {
  records: MaximoRecord[];
  /** maxRows で打ち切った、または件数が合わない（黙って切り捨てず画面に出す） */
  truncated: boolean;
  /** collectioncount による総件数。返らなければ null */
  total: number | null;
  /** 子属性のフィルタ。Maximo へは送っていないのでタブ内で評価する */
  postFilters: TypedFilter[];
}

export type LoadProgress = (loaded: number, total: number | null) => void;

export const DEFAULT_MAX_ROWS = 5_000;
export const MAX_MAX_ROWS = 100_000;
/** 子を含む読み込みの 1 ページ（子の配列で応答が大きくなるため小さめ） */
export const DEFAULT_PAGE_SIZE = 200;
/** 親の列だけの読み込みの 1 ページ（Maximo の上限で切られてもそのまま続けられる） */
export const WIDE_PAGE_SIZE = 1_000;
/** 同時に取るページ数 */
export const DEFAULT_CONCURRENCY = 4;
const OS_NAME_RE = /^[A-Za-z0-9_]+$/;

/** 列の数と子の有無から 1 ページの件数を決める（指定があればそれを使う） */
export function autoPageSize(select: readonly string[], childIdAttrs: Record<string, string | null>): number {
  if (Object.keys(childIdAttrs).length > 0) return DEFAULT_PAGE_SIZE;
  return select.length <= 40 ? WIDE_PAGE_SIZE : 400;
}

/**
 * GET /maximo/api/os/{os}?lean=1&oslc.select&oslc.where&oslc.orderBy&oslc.pageSize&collectioncount=1
 * を responseInfo.nextPage.href に沿ってたどる。nextPage の href は同じ baseUrl / proxy の path+query に付け替える。
 */
export async function loadRecords(client: MaximoClient, opts: LoadRecordsOptions, onProgress?: LoadProgress): Promise<LoadRecordsResult> {
  if (!OS_NAME_RE.test(opts.os)) throw new Error(`Invalid object structure name ${JSON.stringify(opts.os)}`);
  const maxRows = clampInt(opts.maxRows ?? DEFAULT_MAX_ROWS, 1, MAX_MAX_ROWS);
  const pageSize = clampInt(opts.pageSize ?? autoPageSize(opts.select, opts.childIdAttrs), 1, 1_000);
  const concurrency = clampInt(opts.concurrency ?? DEFAULT_CONCURRENCY, 1, 8);
  const selectCols = [...(opts.keyColumns ?? []), ...opts.select];
  const select = buildSelect(selectCols, opts.childIdAttrs, opts.knownAttrs);
  const { where, postFilters } = buildWhere(opts.where ?? [], opts.knownAttrs);
  // 並列で取るときはページの境目がずれないよう、並び順を必ず決める（指定が無ければキー列）
  const keyColumns = opts.keyColumns ?? [];
  const wantParallel = concurrency > 1 && ((opts.orderBy?.length ?? 0) > 0 || keyColumns.length > 0);
  const orderCols = opts.orderBy && opts.orderBy.length > 0 ? opts.orderBy : wantParallel ? keyColumns : [];
  const orderBy = orderCols.length > 0 ? buildOrderBy(orderCols, opts.knownAttrs) : "";

  const params: Array<[string, string]> = [["lean", "1"], ["oslc.select", select]];
  if (where) params.push(["oslc.where", where]);
  if (orderBy) params.push(["oslc.orderBy", orderBy]);
  params.push(["oslc.pageSize", String(pageSize)], ["collectioncount", "1"]);
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const collectionPath = `${client.apiRoot}/os/${opts.os.toLowerCase()}`;
  let path: string | null = `${collectionPath}?${query}`;

  const idAttrs = upperKeys(opts.childIdAttrs);
  const records: MaximoRecord[] = [];
  const seen = new Set<string>();
  let total: number | null = null;
  let truncated = false;
  let parallelDone = false;
  while (path !== null) {
    if (opts.signal?.aborted) throw new Error("Loading was cancelled");
    if (seen.has(path)) throw new Error("Maximo nextPage links form a loop");
    seen.add(path);
    const page = await client.get(path);
    if (!isRecord(page)) throw new Error("Invalid Maximo response (not an object)");
    const members = Array.isArray(page.member) ? page.member : [];
    const info = isRecord(page.responseInfo) ? page.responseInfo : {};
    if (total === null && typeof info.totalCount === "number") total = info.totalCount;
    let i = 0;
    for (; i < members.length && records.length < maxRows; i++) records.push(parseMember(members[i], idAttrs));
    onProgress?.(records.length, total);
    const next = isRecord(info.nextPage) && typeof info.nextPage.href === "string" ? info.nextPage.href : null;
    if (records.length >= maxRows) {
      if (i < members.length || next !== null) truncated = true;
      break;
    }
    if (next === null || members.length === 0) break;
    // 1 ページ目で総件数と実際のページの大きさが分かったら、残りのページを pageno で並列に取る（往復を減らす）。
    // 1 度でも失敗したら nextPage を順にたどる元のやり方に戻す
    if (wantParallel && !parallelDone && total !== null && records.length === members.length) {
      parallelDone = true;
      const filled = await loadPagesInParallel({
        client,
        collectionPath,
        query,
        pageRows: members.length,
        want: Math.min(total, maxRows),
        have: records.length,
        concurrency,
        idAttrs,
        records,
        onProgress: (loaded) => onProgress?.(loaded, total),
        signal: opts.signal,
      });
      if (filled) {
        if (records.length >= maxRows && total > records.length) truncated = true;
        break;
      }
    }
    const nextPath = client.hrefToPath(next);
    if (!nextPath.toLowerCase().startsWith(`${collectionPath.toLowerCase()}?`)) throw new Error("Maximo nextPage points to another collection");
    path = nextPath;
  }
  if (total !== null && total > records.length) truncated = true;
  return { records, truncated, total, postFilters };
}

interface ParallelPagesOptions {
  client: MaximoClient;
  collectionPath: string;
  query: string;
  /** 1 ページ目で実際に返った件数（Maximo が pageSize を切り下げることがある） */
  pageRows: number;
  /** 取りたい総件数 */
  want: number;
  /** すでに取った件数 */
  have: number;
  concurrency: number;
  idAttrs: Record<string, string | null>;
  records: MaximoRecord[];
  /** 取れた件数（ページが終わるたびに増える見込みの数） */
  onProgress: (loaded: number) => void;
  signal?: AbortSignal | undefined;
}

/**
 * 2 ページ目以降を pageno で並列に取り、ページ順に records へ足す。
 * 取り切れたら true。pageno に応えない Maximo や、途中で失敗したときは false（呼び出し側が nextPage で続ける）。
 */
async function loadPagesInParallel(opts: ParallelPagesOptions): Promise<boolean> {
  const { client, collectionPath, query, pageRows, want, have, concurrency, idAttrs, records } = opts;
  if (pageRows <= 0 || have >= want) return false;
  const lastPage = Math.ceil(want / pageRows);
  if (lastPage <= 1) return false;
  const pages: Array<MaximoRecord[] | null> = Array.from({ length: lastPage - 1 }, () => null);
  let next = 0;
  let failed = false;
  let fetched = have;
  const worker = async () => {
    while (!failed) {
      const index = next++;
      if (index >= pages.length) return;
      if (opts.signal?.aborted) throw new Error("Loading was cancelled");
      const page = await client.get(`${collectionPath}?${query}&pageno=${index + 2}`);
      if (!isRecord(page) || !Array.isArray(page.member)) {
        failed = true;
        return;
      }
      pages[index] = page.member.map((m) => parseMember(m, idAttrs));
      fetched = Math.min(want, fetched + page.member.length);
      opts.onProgress(fetched);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, () => worker()));
  if (failed) return false;
  const hrefs = new Set(records.map((r) => r.href));
  for (const page of pages) {
    if (page === null) return false;
    for (const rec of page) {
      if (records.length >= want) break;
      // 並べ替えの境目で同じ行が 2 度返ることがあるので、href で取り除く
      if (rec.href !== "" && hrefs.has(rec.href)) continue;
      hrefs.add(rec.href);
      records.push(rec);
    }
  }
  if (records.length !== fetched) opts.onProgress(records.length);
  return true;
}

/**
 * lean 形式の member 1 件を MaximoRecord にする。属性名は大文字、子配列（オブジェクトの配列）は子オブジェクト名（大文字）→ MaximoChild。
 * lean 形式では null の属性が省略されるので、読む側は「無い＝null」として扱う。
 */
export function parseMember(member: unknown, childIdAttrs: Record<string, string | null>, opts: { requireHref?: boolean } = {}): MaximoRecord {
  if (!isRecord(member)) throw new Error("Invalid Maximo member");
  const href = typeof member.href === "string" && member.href !== "" ? member.href : typeof member.localref === "string" ? member.localref : "";
  if (href === "" && opts.requireHref !== false) throw new Error("A Maximo member has no href");
  const attrs: Record<string, CellValue> = {};
  const children: Record<string, MaximoChild[]> = {};
  for (const [k, v] of Object.entries(member)) {
    if (isMetaKey(k)) continue;
    const name = k.toUpperCase();
    if (Array.isArray(v)) {
      if (v.every(isRecord)) children[name] = v.map((c) => parseChild(c, childIdAttrs[name] ?? null));
      continue;
    }
    if (isRecord(v)) {
      children[name] = [parseChild(v, childIdAttrs[name] ?? null)];
      continue;
    }
    attrs[name] = toCell(v);
  }
  return { href, rowstamp: toRowstamp(member._rowstamp), attrs, children };
}

function parseChild(obj: Record<string, unknown>, idAttr: string | null): MaximoChild {
  const attrs: Record<string, CellValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isMetaKey(k) || Array.isArray(v) || isRecord(v)) continue; // 孫オブジェクトは未対応
    attrs[k.toUpperCase()] = toCell(v);
  }
  const upperId = idAttr ? idAttr.toUpperCase() : null;
  const child: MaximoChild = { idAttr: upperId, id: upperId ? (attrs[upperId] ?? null) : null, rowstamp: toRowstamp(obj._rowstamp), attrs };
  const href = typeof obj.href === "string" ? obj.href : typeof obj.localref === "string" ? obj.localref : undefined;
  if (href !== undefined) child.href = href;
  return child;
}

function isMetaKey(k: string): boolean {
  const n = k.toLowerCase();
  return n === "href" || n === "localref" || n.startsWith("_") || n.endsWith("_collectionref");
}

function toCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v);
}

function toRowstamp(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// ---------------------------------------------------------------------------
// グリッドの行への変換
// ---------------------------------------------------------------------------

/** ID の分からない子の行キーに使う接頭辞（例 idx~0）。この行は変更・削除できない */
export const NO_ID_CHILD_PREFIX = "idx~";

/** 親キー。キー列があればその値から作り、無ければ href を使う */
export function parentKeyOf(record: MaximoRecord, keyColumns: string[]): string {
  if (keyColumns.length === 0) return record.href;
  return makeParentKey(keyColumns.map((k) => record.attrs[k.toUpperCase()] ?? null));
}

/** 列の子オブジェクト名（大文字）。親の列なら null */
export function columnChild(col: { name: string; child?: string }): string | null {
  if (col.child) return col.child.toUpperCase();
  return col.name.includes(".") ? splitColumnName(col.name).child : null;
}

/**
 * MaximoRecord[] を MXLoader と同じ平坦な行にする。
 * - 子の列を選んでいなければ親 1 行。
 * - 子の列があれば、親の値を子の行数だけ繰り返す。複数種類の子を選んだ場合は種類ごとに行を作る。
 * - 選んだ種類の子を 1 件も持たない親は、子の列を空にした親 1 行にする（子を追加できるように）。
 */
export function recordsToRows(records: MaximoRecord[], meta: Pick<SheetMeta, "columns" | "keyColumns">): SheetRow[] {
  const parentCols: string[] = [];
  const childCols = new Map<string, Array<{ col: string; attr: string }>>();
  for (const c of meta.columns) {
    const name = c.name.toUpperCase();
    const child = columnChild(c);
    if (child) {
      let list = childCols.get(child);
      if (!list) childCols.set(child, (list = []));
      list.push({ col: name, attr: name.slice(name.indexOf(".") + 1) });
    } else {
      parentCols.push(name);
    }
  }
  for (const k of meta.keyColumns) if (!parentCols.includes(k.toUpperCase())) parentCols.push(k.toUpperCase());
  const allChildCols = [...childCols.values()].flat();

  const rows: SheetRow[] = [];
  const seenParents = new Set<string>();
  for (const rec of records) {
    const parentKey = parentKeyOf(rec, meta.keyColumns);
    if (seenParents.has(parentKey)) throw new Error(`Duplicate parent key ${parentKey} (check the choice of key columns)`);
    seenParents.add(parentKey);
    const base: Record<string, CellValue> = {};
    for (const col of parentCols) base[col] = rec.attrs[col] ?? null;
    let emitted = 0;
    for (const [kind, cols] of childCols) {
      const list = rec.children[kind] ?? [];
      const seenIds = new Set<string>();
      list.forEach((child, index) => {
        const idPart: CellValue = child.idAttr && child.id !== null ? child.id : `${NO_ID_CHILD_PREFIX}${index}`;
        const rowKey = makeChildRowKey(parentKey, kind, idPart);
        if (seenIds.has(rowKey)) throw new Error(`Duplicate ID of child ${kind} within the same parent`);
        seenIds.add(rowKey);
        const values: Record<string, CellValue> = { ...base };
        for (const { col } of allChildCols) values[col] = null;
        for (const { col, attr } of cols) values[col] = child.attrs[attr] ?? null;
        rows.push({ rowKey, parentKey, childName: kind, values });
        emitted++;
      });
    }
    if (emitted === 0) {
      const values: Record<string, CellValue> = { ...base };
      for (const { col } of allChildCols) values[col] = null;
      rows.push({ rowKey: parentKey, parentKey, childName: null, values });
    }
  }
  return rows;
}
