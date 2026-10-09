// 行の突合（match_sheets と apply_rule の lookup で共通）。
// AI が決まり（置き換え・条件）を作り、照合そのものはここで行う。
// 候補が 1 件に決まらない行（0 件・2 件以上）は結ばずに返し、人か AI が判断する。

import type { CellValue, MatchConditions, NormalizeOption } from "../../shared/model";
import { StoreError } from "./errors";
import { compileFilters } from "./filters";
import { normalizeCompositeKey, normalizeKey, type CompositeKey } from "./normalize";
import type { RowState, Sheet } from "./sheet";

/** 置き換えの決まりの上限（AI が作る通称の直し方。多すぎるものは決まりではなく対応表なので、別のシートにして突合する） */
export const MAX_REWRITE_RULES = 30;
/** contains で使う名前の最短の長さ（正規化と置き換えの後）。1 文字の名前はどの文にも含まれやすく、誤って結ぶもとになる */
export const MIN_CONTAINS_LENGTH = 2;
/** dateWithin で、日ごとの索引に入れる期間の上限（日数）。これより長い期間の相手は全件と比べる */
const MAX_INDEXED_DAYS = 62;
const DAY_MS = 86_400_000;

export type RowMatch =
  | { kind: "matched"; id: string; label: string; byGroup?: boolean; byAbove?: boolean }
  | { kind: "unmatched"; label: string }
  | { kind: "ambiguous"; ids: string[]; label: string };

export interface MatchSpec {
  /** 等しい値で突合する列（この側）。空なら等しさでは絞らない */
  cols: readonly string[];
  /** 等しい値で突合する列（相手側。cols と同じ順・同じ個数） */
  targetCols: readonly string[];
  normalize: readonly NormalizeOption[];
  conditions: MatchConditions;
  /** 相手側を親（同じ親の子行をまとめて 1 件）で数えるか */
  targetByParent: boolean;
}

export interface Matcher {
  /** 相手側の候補（相手の絞り込みの後）。ID は byParent なら親キー、そうでなければ行キー */
  readonly targetIds: readonly string[];
  targetRow(id: string): RowState;
  /** 相手の表示用の値（条件に使った相手側の値を " | " で連結） */
  targetLabel(id: string): string;
  /** 行ごとの突合。group があれば、同じ帳票の行を 1 件の相手にまとめた結果 */
  matchRows(rows: readonly RowState[]): Map<RowState, RowMatch>;
}

/** 日付のセルの日（YYYY-MM-DD）。「2026-05-11」「2026/5/11」で始まる文字列だけを日付とみなす */
export function dayOfCell(v: CellValue): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(v.trim());
  if (!m) return null;
  return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** 置き換えの決まりを関数にする。正規表現の誤りは invalid_args */
export function compileRewrite(rules: MatchConditions["rewrite"]): (s: string) => string {
  if (rules === undefined || rules.length === 0) return (s) => s;
  if (!Array.isArray(rules) || rules.length > MAX_REWRITE_RULES) {
    throw new StoreError("invalid_args", `rewrite takes at most ${MAX_REWRITE_RULES} rules`);
  }
  const compiled = rules.map((r, i) => {
    if (r === null || typeof r !== "object" || typeof r.find !== "string" || r.find === "" || typeof r.replace !== "string") {
      throw new StoreError("invalid_args", `rewrite[${i}] needs find (a regular expression) and replace`, { index: i });
    }
    try {
      return { re: new RegExp(r.find, "g"), to: r.replace };
    } catch (e) {
      throw new StoreError("invalid_args", `rewrite[${i}].find is not a valid regular expression: ${(e as Error).message}`, { find: r.find });
    }
  });
  return (s) => compiled.reduce((t, { re, to }) => t.replace(re, to), s);
}

interface TargetEntry {
  id: string;
  row: RowState;
  eqKey: string | null;
  names: string[];
  from: string | null;
  to: string | null;
  label: string;
}

export function compileMatcher(sheet: Sheet, target: Sheet, spec: MatchSpec, getSheet: (name: string) => Sheet): Matcher {
  const cond = spec.conditions;
  const { contains, dateWithin, group, followsAbove } = cond;
  if (spec.cols.length !== spec.targetCols.length) throw new Error("internal: cols and targetCols differ in length");
  if (spec.cols.length === 0 && contains === undefined && dateWithin === undefined) {
    throw new StoreError("invalid_args", "Give match columns, contains or dateWithin (at least one condition)");
  }
  const need = (s: Sheet, c: string | undefined, label: string) => {
    if (c === undefined) return;
    if (typeof c !== "string" || c === "") throw new StoreError("invalid_args", `${label} needs a column name`);
    if (!s.hasColumn(c)) throw new StoreError("column_not_found", `Column ${c} is not in sheet ${s.name}`, { column: c, sheet: s.name });
  };
  for (const c of spec.cols) need(sheet, c, "cols");
  for (const c of spec.targetCols) need(target, c, "targetCols");
  if (contains !== undefined) {
    need(sheet, contains.col, "contains.col");
    need(target, contains.targetCol, "contains.targetCol");
  }
  if (dateWithin !== undefined) {
    need(sheet, dateWithin.col, "dateWithin.col");
    need(target, dateWithin.targetStart, "dateWithin.targetStart");
    need(target, dateWithin.targetEnd, "dateWithin.targetEnd");
  }
  need(sheet, group, "group");
  let abovePattern: RegExp | null = null;
  if (followsAbove !== undefined) {
    need(sheet, followsAbove.col, "followsAbove.col");
    try {
      abovePattern = new RegExp(followsAbove.pattern);
    } catch (e) {
      throw new StoreError("invalid_args", `followsAbove.pattern is not a valid regular expression: ${(e as Error).message}`, { pattern: followsAbove.pattern });
    }
  }

  const rewrite = compileRewrite(cond.rewrite);
  const text = (v: CellValue | undefined): string | null => {
    const k = normalizeKey(v, spec.normalize);
    if (k === null) return null;
    const out = rewrite(k);
    return out === "" ? null : out;
  };
  const eqKey = (s: Sheet, r: RowState, cols: readonly string[]): CompositeKey =>
    normalizeCompositeKey(
      cols.map((c) => s.finalValue(r, c)),
      spec.normalize,
      rewrite,
    );

  // contains の名前を別のシートから引く（例: 作業指示の ASSETNUM → 資産の DESCRIPTION）
  let viaNames: ((v: CellValue) => string[]) | null = null;
  if (contains?.via !== undefined) {
    const via = contains.via;
    const vs = getSheet(via.sheet);
    need(vs, via.matchCol, "contains.via.matchCol");
    need(vs, via.sourceCol, "contains.via.sourceCol");
    const byKey = new Map<string, Set<string>>();
    for (const r of vs.viewRows("final")) {
      const k = normalizeKey(vs.finalValue(r, via.matchCol), ["trim", "nfkc", "upper"]);
      const name = text(vs.finalValue(r, via.sourceCol));
      if (k === null || name === null) continue;
      const set = byKey.get(k);
      if (set) set.add(name);
      else byKey.set(k, new Set([name]));
    }
    viaNames = (v) => {
      const k = normalizeKey(v, ["trim", "nfkc", "upper"]);
      return k === null ? [] : [...(byKey.get(k) ?? [])];
    };
  }

  // 相手側の候補
  const targetPredicate = compileFilters(cond.targetFilter ?? [], (c) => target.hasColumn(c));
  const all: TargetEntry[] = [];
  const entries: TargetEntry[] = [];
  const byId = new Map<string, TargetEntry>();
  for (const r of target.viewRows("final")) {
    if (!targetPredicate((c) => target.finalValue(r, c))) continue;
    const id = spec.targetByParent ? r.parentKey : r.rowKey;
    if (byId.has(id)) continue;
    let names: string[] = [];
    if (contains !== undefined) {
      const v = target.finalValue(r, contains.targetCol);
      names = (viaNames ? viaNames(v) : [text(v)]).filter((n): n is string => n !== null && n.length >= MIN_CONTAINS_LENGTH);
    }
    let from: string | null = null;
    let to: string | null = null;
    if (dateWithin !== undefined) {
      from = dayOfCell(target.finalValue(r, dateWithin.targetStart));
      to = dateWithin.targetEnd === undefined ? from : (dayOfCell(target.finalValue(r, dateWithin.targetEnd)) ?? from);
      if (from !== null && to !== null && to < from) [from, to] = [to, from];
    }
    const k = eqKey(target, r, spec.targetCols);
    const labelParts = [...(spec.cols.length > 0 ? [k.label] : []), ...(dateWithin ? [from === to ? (from ?? "") : `${from ?? ""}..${to ?? ""}`] : []), ...(contains ? [names.join(" / ")] : [])];
    const e: TargetEntry = { id, row: r, eqKey: spec.cols.length > 0 ? k.id : null, names, from, to, label: labelParts.join(" | ") };
    all.push(e);
    byId.set(id, e);
    // 条件に使う値が無い相手は、どの行とも結ばない（右側だけの行に数える）
    if (spec.cols.length > 0 && e.eqKey === null) continue;
    if (contains !== undefined && names.length === 0) continue;
    if (dateWithin !== undefined && from === null) continue;
    entries.push(e);
  }

  // 索引: 等しさの列があればそのキー、無ければ日ごと（長い期間は wide）、どちらも無ければ全件
  const byEq = new Map<string, TargetEntry[]>();
  const byDay = new Map<string, TargetEntry[]>();
  const wide: TargetEntry[] = [];
  const push = (m: Map<string, TargetEntry[]>, k: string, e: TargetEntry) => {
    const list = m.get(k);
    if (list) list.push(e);
    else m.set(k, [e]);
  };
  for (const e of entries) {
    if (spec.cols.length > 0) push(byEq, e.eqKey as string, e);
    else if (dateWithin !== undefined) {
      const span = daysBetween(e.from as string, e.to as string);
      if (span > MAX_INDEXED_DAYS) wide.push(e);
      else for (let i = 0; i <= span; i++) push(byDay, addDays(e.from as string, i), e);
    }
  }

  const matchOne = (r: RowState): RowMatch => {
    const labelParts: string[] = [];
    let pool: readonly TargetEntry[] = entries;
    if (spec.cols.length > 0) {
      const k = eqKey(sheet, r, spec.cols);
      labelParts.push(k.label);
      if (k.id === null) return { kind: "unmatched", label: labelParts.join(" | ") };
      pool = byEq.get(k.id) ?? [];
    }
    let day: string | null = null;
    if (dateWithin !== undefined) {
      day = dayOfCell(sheet.finalValue(r, dateWithin.col));
      labelParts.push(day ?? "");
      if (day === null) return { kind: "unmatched", label: labelParts.join(" | ") };
      if (spec.cols.length === 0) pool = [...(byDay.get(day) ?? []), ...wide];
    }
    let body: string | null = null;
    if (contains !== undefined) {
      body = text(sheet.finalValue(r, contains.col));
      labelParts.push(body ?? "");
      if (body === null) return { kind: "unmatched", label: labelParts.join(" | ") };
    }
    const label = labelParts.join(" | ");
    const hits = pool.filter(
      (e) =>
        (day === null || ((e.from as string) <= day && day <= (e.to as string))) &&
        (body === null || e.names.some((n) => (body as string).includes(n))),
    );
    if (hits.length === 0) return { kind: "unmatched", label };
    if (hits.length === 1) return { kind: "matched", id: hits[0]!.id, label };
    return { kind: "ambiguous", ids: hits.map((e) => e.id), label };
  };

  return {
    targetIds: all.map((e) => e.id),
    targetRow: (id) => {
      const e = byId.get(id);
      if (!e) throw new Error(`internal: target ${id} not found`);
      return e.row;
    },
    targetLabel: (id) => byId.get(id)?.label ?? "",
    matchRows: (rows) => {
      const out = new Map<RowState, RowMatch>();
      for (const r of rows) out.set(r, matchOne(r));
      if (followsAbove !== undefined && abovePattern !== null) {
        // 「同上」の行: 自分では 1 件に決まらず、真上の行（シートの並びで直前、同じ対象の中）が 1 件に決まっていれば、その相手を引き継ぐ
        const position = new Map<string, number>();
        sheet.viewRows("final").forEach((r, i) => position.set(r.rowKey, i));
        let prev: RowState | null = null;
        for (const r of rows) {
          const m = out.get(r)!;
          const above = prev !== null && position.get(prev.rowKey) === (position.get(r.rowKey) ?? -1) - 1 ? out.get(prev) : undefined;
          const raw = sheet.finalValue(r, followsAbove.col);
          if (m.kind !== "matched" && above?.kind === "matched" && typeof raw === "string" && abovePattern.test(raw.trim())) {
            out.set(r, { kind: "matched", id: above.id, label: m.label, byAbove: true });
          }
          prev = r;
        }
      }
      if (group === undefined) return out;
      // 同じ帳票（group の値が同じ行）: 1 件に決まった行の相手がそろって 1 件なら、帳票の全行をその相手に結ぶ。
      // 違う相手に決まった行があれば、帳票の全行を ambiguous にする（どれが正しいか決められない）
      const groups = new Map<string, RowState[]>();
      for (const r of rows) {
        const g = normalizeKey(sheet.finalValue(r, group), ["trim", "nfkc"]);
        if (g === null) continue;
        const list = groups.get(g);
        if (list) list.push(r);
        else groups.set(g, [r]);
      }
      for (const members of groups.values()) {
        const ids = new Set<string>();
        for (const r of members) {
          const m = out.get(r)!;
          if (m.kind === "matched") ids.add(m.id);
        }
        if (ids.size === 0) continue;
        for (const r of members) {
          const m = out.get(r)!;
          if (ids.size === 1) {
            const [id] = ids;
            if (m.kind !== "matched") out.set(r, { kind: "matched", id: id!, label: m.label, byGroup: true });
          } else {
            out.set(r, { kind: "ambiguous", ids: [...ids], label: m.label });
          }
        }
      }
      return out;
    },
  };
}
