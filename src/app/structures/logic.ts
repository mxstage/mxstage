// オブジェクト構造の画面 /structures の純ロジック: 属性の絞り込み、子オブジェクトの要約、一覧の内訳、読み込み失敗の文言。

import type { ColumnSchema } from "../../shared/model";
import { foldText, type StoredObjectStructure } from "../catalog/catalog";
import { MaximoError, MaximoNetworkError } from "../maximo/client";
import type { DefinedObjectStructure } from "../maximo/meta";

export { sheetsByStructure } from "../catalog/usage";

/** 属性の表の範囲: すべて / 親だけ / ある子オブジェクトだけ */
export type ColumnScope = { kind: "all" } | { kind: "parent" } | { kind: "child"; name: string };

export function scopeKey(scope: ColumnScope): string {
  return scope.kind === "child" ? `child:${scope.name}` : scope.kind;
}

export function parseScopeKey(key: string): ColumnScope {
  if (key === "parent") return { kind: "parent" };
  if (key.startsWith("child:")) return { kind: "child", name: key.slice("child:".length) };
  return { kind: "all" };
}

/** 範囲と検索語（名前・日本語ラベルの部分一致。全角半角・大文字小文字を区別しない）で属性を絞る */
export function filterColumns(columns: readonly ColumnSchema[], scope: ColumnScope, query: string): ColumnSchema[] {
  const q = foldText(query).trim();
  return columns.filter((c) => {
    if (scope.kind === "parent" && c.child) return false;
    if (scope.kind === "child" && c.child !== scope.name) return false;
    if (q === "") return true;
    return foldText(c.name).includes(q) || (c.title !== undefined && foldText(c.title).includes(q));
  });
}

export interface ChildSummary {
  name: string;
  idAttr: string | null;
  columnCount: number;
}

export function childSummaries(entry: StoredObjectStructure): ChildSummary[] {
  const counts = new Map<string, number>();
  for (const c of entry.info.columns) if (c.child) counts.set(c.child, (counts.get(c.child) ?? 0) + 1);
  return Object.keys(entry.info.childIdAttrs).map((name) => ({ name, idAttr: entry.info.childIdAttrs[name] ?? null, columnCount: counts.get(name) ?? 0 }));
}

export function parentColumnCount(entry: StoredObjectStructure): number {
  return entry.info.columns.filter((c) => !c.child).length;
}

/** API で使えないため読み込まない構造を、適用先ごとにまとめる（多い順。同数なら適用先の名前順） */
export function groupByUseWith(structures: readonly DefinedObjectStructure[]): Array<{ usewith: string; names: string[] }> {
  const groups = new Map<string, string[]>();
  for (const s of structures) {
    let names = groups.get(s.usewith);
    if (!names) groups.set(s.usewith, (names = []));
    names.push(s.name);
  }
  return Array.from(groups, ([usewith, names]) => ({ usewith, names })).sort((a, b) => b.names.length - a.names.length || (a.usewith < b.usewith ? -1 : a.usewith > b.usewith ? 1 : 0));
}

/** 例 2026-09-17 16:38（利用者の PC の時刻） */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 入力されたオブジェクト構造名を大文字にそろえる。使えない文字があれば null */
export function normalizeOsName(raw: string): string | null {
  const os = raw.trim().toUpperCase();
  return /^[A-Z0-9_]+$/.test(os) ? os : null;
}

/** 画面から読み込めなかったときの文言（Maximo の本文は長さを区切って添える） */
export function loadErrorMessage(os: string, e: unknown): string {
  if (e instanceof MaximoError) {
    if (e.status === 404) return `オブジェクト構造 ${os} は Maximo にありません。名前を確かめてください。`;
    if (e.status === 401 || e.status === 403) return `Maximo が ${os} の読み取りを拒否しました（${e.status}）。API キーの権限を確かめてください。`;
    return `${os} を読み込めませんでした（Maximo の応答 ${e.status}${e.message ? `: ${e.message.slice(0, 200)}` : ""}）。`;
  }
  if (e instanceof MaximoNetworkError) return `Maximo に届かなかったため ${os} を読み込めませんでした${e.timedOut ? "（時間切れ）" : ""}。接続を確かめてください。`;
  const detail = e instanceof Error && e.message ? `: ${e.message.slice(0, 200)}` : "";
  return `${os} を読み込めませんでした${detail}。`;
}
