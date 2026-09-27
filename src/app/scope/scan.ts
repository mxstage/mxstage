// 範囲を決めるための軽い走査。Maximo からキー列と軸の列だけを読み、軸ごとの件数を数える。
//
// - 数えるのは summarizeScope（読んだ行から数える）。scope_options は読んだ行を作業画面のシートにしてから数える
//   （Claude が読んだデータは、利用者も作業画面で同じものを見られるようにする）。
// - 列を絞るので 1 ページを大きく取れる（既定 1,000 件）。全件読み込みより速く、往復も少ない。
// - where で絞ってから呼び直すと、その中での分布が返る（期間で絞ってから部署で絞る、のように詰められる）。

import type { CellValue, TypedFilter } from "../../shared/model";
import type { MaximoRecord } from "../../shared/sheet";
import type { MaximoClient } from "../maximo/client";
import { loadRecords } from "../maximo/load";
import type { ObjectStructureInfo } from "../maximo/meta";
import type { ScopeAxis, ScopeAxisKind } from "./axes";

export const SCAN_PAGE_SIZE = 1_000;
export const DEFAULT_MAX_SCAN = 20_000;
/** これより値の種類が多い軸は、選ばせる意味が薄いので候補から外す（skipped に出す） */
export const MAX_DISTINCT = 200;

export interface ScopeValueCount {
  value: CellValue;
  count: number;
}

export interface ScopeKeyPattern {
  /** 数字を # にした形（例 WR######） */
  pattern: string;
  count: number;
  example: string;
}

export interface ScopeAxisSummary {
  name: string;
  title?: string;
  kind: ScopeAxisKind;
  reason: string;
  /** 値の種類の数（空を除く） */
  distinct: number;
  /** 空（null・空文字）の件数 */
  emptyCount: number;
  /** 多い順。kind が value のとき、または key で種類が少ないとき */
  values?: ScopeValueCount[];
  /** values に載せきれなかった種類の数 */
  omittedValues?: number;
  /** kind が key のとき（番号の形） */
  patterns?: ScopeKeyPattern[];
  /** kind が date のとき */
  min?: string;
  max?: string;
  /** 年（YYYY）または年月（YYYY-MM）ごとの件数。新しい順 */
  buckets?: ScopeValueCount[];
}

export interface ScopeScanOptions {
  where?: TypedFilter[];
  /** 走査する行数の上限 */
  maxScan?: number;
  /** 軸ごとに返す候補値の数 */
  limit?: number;
  signal?: AbortSignal;
}

export interface ScopeScanResult {
  /** 走査した件数 */
  scanned: number;
  /** Maximo 側の件数（返らなければ null） */
  total: number | null;
  /** 上限で打ち切ったか（分布は先頭だけの偏った標本になる） */
  truncated: boolean;
  axes: ScopeAxisSummary[];
  /** 値の種類が多すぎて候補にしなかった軸 */
  skipped: Array<{ name: string; title?: string; reason: string; distinct: number }>;
}

/** Maximo の日時（2026-04-01T00:00:00+09:00）から日付の部分だけ取る */
function dayOf(v: CellValue): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m === null ? m : m[1]!;
}

/** 数字を # にした番号の形（例 WO100906 → WR######） */
export function keyPattern(v: CellValue): string {
  return String(v).replace(/\d/g, "#");
}

function isEmpty(v: CellValue): boolean {
  return v === null || v === undefined || v === "";
}

function tally(map: Map<string, { value: CellValue; count: number }>, v: CellValue): void {
  const k = typeof v === "string" ? v : JSON.stringify(v);
  const cur = map.get(k);
  if (cur === undefined) map.set(k, { value: v, count: 1 });
  else cur.count++;
}

function top(map: Map<string, { value: CellValue; count: number }>, limit: number): ScopeValueCount[] {
  return Array.from(map.values())
    .sort((a, b) => b.count - a.count || (String(a.value) < String(b.value) ? -1 : 1))
    .slice(0, limit)
    .map((v) => ({ value: v.value, count: v.count }));
}

/** 軸の列だけを Maximo から読み、軸ごとに数える（試験と、シートを作らない呼び出し元のため） */
export async function scanScope(client: MaximoClient, info: ObjectStructureInfo, axes: readonly ScopeAxis[], opts: ScopeScanOptions = {}): Promise<ScopeScanResult> {
  const maxScan = Math.max(1, opts.maxScan ?? DEFAULT_MAX_SCAN);
  const knownAttrs = new Set(info.columns.map((c) => c.name));
  const select = axes.map((a) => a.name);
  const load: Parameters<typeof loadRecords>[1] = {
    os: info.os,
    select: select.length > 0 ? select : info.keyColumns,
    childIdAttrs: {},
    knownAttrs,
    keyColumns: info.keyColumns,
    maxRows: maxScan,
    pageSize: SCAN_PAGE_SIZE,
  };
  if (opts.where !== undefined) load.where = opts.where;
  if (opts.signal !== undefined) load.signal = opts.signal;
  const { records, total, truncated } = await loadRecords(client, load);
  return { scanned: records.length, total, truncated, ...summarizeScope(records, axes, opts.limit) };
}

/** 読んだ行から、軸ごとの候補値と件数・期間・番号の形を数える */
export function summarizeScope(records: readonly MaximoRecord[], axes: readonly ScopeAxis[], limitArg?: number): Pick<ScopeScanResult, "axes" | "skipped"> {
  const limit = Math.max(1, Math.min(50, limitArg ?? 12));
  const counts = axes.map(() => new Map<string, { value: CellValue; count: number }>());
  const empties = axes.map(() => 0);
  const dayMin: Array<string | null> = axes.map(() => null);
  const dayMax: Array<string | null> = axes.map(() => null);
  const months = axes.map(() => new Map<string, { value: CellValue; count: number }>());
  const patterns = axes.map(() => new Map<string, { value: CellValue; count: number; example: string }>());

  for (const rec of records) {
    axes.forEach((axis, i) => {
      const v = rec.attrs[axis.name] ?? null;
      if (isEmpty(v)) {
        empties[i]!++;
        return;
      }
      tally(counts[i]!, v);
      if (axis.kind === "date") {
        const day = dayOf(v);
        if (day !== null) {
          if (dayMin[i] === null || day < dayMin[i]!) dayMin[i] = day;
          if (dayMax[i] === null || day > dayMax[i]!) dayMax[i] = day;
          tally(months[i]!, day.slice(0, 7));
        }
      } else if (axis.kind === "key") {
        const p = keyPattern(v);
        const cur = patterns[i]!.get(p);
        if (cur === undefined) patterns[i]!.set(p, { value: p, count: 1, example: String(v) });
        else cur.count++;
      }
    });
  }

  const summaries: ScopeAxisSummary[] = [];
  const skipped: ScopeScanResult["skipped"] = [];
  axes.forEach((axis, i) => {
    const distinct = counts[i]!.size;
    const s: ScopeAxisSummary = { name: axis.name, kind: axis.kind, reason: axis.reason, distinct, emptyCount: empties[i]! };
    if (axis.title !== undefined) s.title = axis.title;
    if (axis.kind === "date") {
      if (dayMin[i] !== null) s.min = dayMin[i]!;
      if (dayMax[i] !== null) s.max = dayMax[i]!;
      const monthly = months[i]!;
      // 年月が多いときは年でまとめる（選びやすさのため）
      const source = monthly.size > limit ? yearly(monthly) : monthly;
      s.buckets = Array.from(source.values())
        .sort((a, b) => (String(a.value) < String(b.value) ? 1 : -1))
        .slice(0, limit)
        .map((v) => ({ value: v.value, count: v.count }));
    } else if (axis.kind === "key") {
      s.patterns = Array.from(patterns[i]!.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
        .map((p) => ({ pattern: String(p.value), count: p.count, example: p.example }));
      if (distinct <= limit) s.values = top(counts[i]!, limit);
    } else {
      if (distinct > MAX_DISTINCT) {
        const sk: ScopeScanResult["skipped"][number] = { name: axis.name, reason: axis.reason, distinct };
        if (axis.title !== undefined) sk.title = axis.title;
        skipped.push(sk);
        return;
      }
      s.values = top(counts[i]!, limit);
      if (distinct > limit) s.omittedValues = distinct - limit;
    }
    summaries.push(s);
  });

  return { axes: summaries, skipped };
}

function yearly(monthly: Map<string, { value: CellValue; count: number }>): Map<string, { value: CellValue; count: number }> {
  const out = new Map<string, { value: CellValue; count: number }>();
  for (const { value, count } of monthly.values()) {
    const y = String(value).slice(0, 4);
    const cur = out.get(y);
    if (cur === undefined) out.set(y, { value: y, count });
    else cur.count += count;
  }
  return out;
}
