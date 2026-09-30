// 読み込む範囲を利用者と決めるための「絞り込みの軸」を、オブジェクト構造の属性から機械的に選ぶ（純ロジック）。
//
// ここに規則を置く理由: LLM がその場で思い付いた軸を出すと、同じ依頼でも毎回違う聞き方になり再現性が無い。
// 軸の選び方を 1 か所に固定しておけば、どの構造でも（工事管理でも機器台帳でも）同じ順序・同じ観点で聞ける。

import type { ColumnSchema } from "../../shared/model";
import { foldText } from "../catalog/catalog";
import type { ObjectStructureInfo } from "../maximo/meta";

export type ScopeAxisKind = "value" | "date" | "key";

export interface ScopeAxis {
  /** 列名（親の属性だけ） */
  name: string;
  title?: string;
  kind: ScopeAxisKind;
  /** どの観点で選んだか（利用者にそのまま見せる） */
  reason: string;
}

/**
 * 値で絞る軸の手がかり。並びがそのまま利用者に見せる順になる（業務で先に聞かれる観点から）。
 * - exact: その名前ならまず間違いなくその観点の列（最優先）
 * - words: 名前かラベルに含まれていれば候補（名前に含まれる方を優先する）
 */
const VALUE_HINTS: ReadonlyArray<{ reason: string; exact: readonly string[]; words: readonly string[] }> = [
  { reason: "status", exact: ["status", "wostatus", "historyflag"], words: ["status", "ステータス", "状態"] },
  { reason: "classification", exact: ["classstructureid", "assetclass", "woclass", "class"], words: ["class", "分類", "クラス"] },
  {
    reason: "owner or department",
    exact: ["persongroup", "ownergroup", "workgroup", "crewid", "supervisor", "lead", "owner", "assignedownergroup", "reportedby", "changeby"],
    words: ["persongroup", "ownergroup", "workgroup", "crew", "supervisor", "dept", "担当", "部署", "グループ", "責任", "作業班"],
  },
  { reason: "type", exact: ["worktype", "type", "woclass", "jpnum"], words: ["worktype", "種別", "タイプ", "区分", "方式"] },
  { reason: "location", exact: ["siteid", "orgid", "location", "parent"], words: ["siteid", "location", "orgid", "サイト", "ロケーション", "エリア", "場所", "組織"] },
  { reason: "priority", exact: ["priority", "wopriority"], words: ["priority", "優先"] },
];

const DATE_REASON = "period";
const KEY_REASON = "numbering pattern";

/** 軸に向かない列（表示用の重複・長い文章・システム項目） */
function excluded(col: ColumnSchema): boolean {
  const n = col.name.toUpperCase();
  if (col.child !== undefined) return true; // 子の属性は Maximo へ条件を送れないので軸にしない
  if (n.endsWith("_DESCRIPTION")) return true; // ドメインの説明（同じ値の別表現）
  if (n === "DESCRIPTION" || n.endsWith("LONGDESCRIPTION")) return true; // 自由記述
  return false;
}

/**
 * 値で絞る軸か。桁が長い自由入力の列と真偽値は自動では選ばない（真偽値は axes で名指しすれば軸にできる）。
 * rank は同じ観点の中での優先順位: 0=名前が一致 / 1=名前に含まれる / 2=ラベルに含まれる。
 */
function valueMatch(col: ColumnSchema): { reason: string; rank: number } | null {
  if (col.type !== "string" && col.type !== "integer") return null;
  if (col.maxLength !== undefined && col.maxLength > 40) return null;
  const name = foldText(col.name);
  const title = foldText(col.title ?? "");
  for (const hint of VALUE_HINTS) {
    if (hint.exact.includes(name)) return { reason: hint.reason, rank: 0 };
    if (hint.words.some((w) => name.includes(w))) return { reason: hint.reason, rank: 1 };
    // 整数はラベルだけの一致では選ばない（件数や桁の列を拾うため）
    if (col.type === "string" && hint.words.some((w) => title.includes(w))) return { reason: hint.reason, rank: 2 };
  }
  return null;
}

/** 呼び出し側（axes 指定）向け。観点が決まらなければ「指定」 */
function valueReason(col: ColumnSchema): string | null {
  return valueMatch(col)?.reason ?? null;
}

const REASON_ORDER = [...VALUE_HINTS.map((h) => h.reason), DATE_REASON, KEY_REASON];

export interface PickAxesOptions {
  /** 返す軸の数（既定 8） */
  max?: number;
}

/**
 * オブジェクト構造の属性から絞り込みの軸を選ぶ。
 * - キー列（例 WONUM）は「番号の規則」の軸にする（接頭辞や桁で絞れる）
 * - 日付・日時は「期間」の軸にする
 * - 状態・分類・担当・部署・種別・場所・優先度に当たる短い文字列と真偽値は「値」の軸にする
 */
export function pickScopeAxes(info: ObjectStructureInfo, opts: PickAxesOptions = {}): ScopeAxis[] {
  const keys = new Set(info.keyColumns.map((k) => k.toUpperCase()));
  const found: Array<ScopeAxis & { rank: number }> = [];
  for (const col of info.columns) {
    if (excluded(col)) continue;
    const name = col.name.toUpperCase();
    const match = valueMatch(col);
    // キー列でも観点が決まる列（SITEID など）は値の軸にする。決まらないキー列（WONUM など）は番号の規則の軸
    const kind: ScopeAxisKind | null =
      match !== null ? "value" : keys.has(name) ? "key" : col.type === "date" || col.type === "datetime" ? "date" : null;
    if (kind === null) continue;
    const axis: ScopeAxis & { rank: number } = {
      name,
      kind,
      reason: match?.reason ?? (kind === "key" ? KEY_REASON : DATE_REASON),
      rank: match?.rank ?? 0,
    };
    if (col.title !== undefined) axis.title = col.title;
    found.push(axis);
  }
  found.sort((a, b) => {
    const ra = REASON_ORDER.indexOf(a.reason);
    const rb = REASON_ORDER.indexOf(b.reason);
    if (ra !== rb) return ra - rb;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return found.slice(0, Math.max(1, opts.max ?? 8)).map(({ rank: _rank, ...axis }) => axis);
}

/** 利用者や LLM が指定した属性を軸にする（存在しない列は呼び出し側で弾く） */
export function axesFor(info: ObjectStructureInfo, names: readonly string[]): ScopeAxis[] {
  const byName = new Map(info.columns.map((c) => [c.name.toUpperCase(), c]));
  const keys = new Set(info.keyColumns.map((k) => k.toUpperCase()));
  const out: ScopeAxis[] = [];
  for (const raw of names) {
    const name = raw.trim().toUpperCase();
    const col = byName.get(name);
    if (col === undefined || out.some((a) => a.name === name)) continue;
    const kind: ScopeAxisKind = keys.has(name) ? "key" : col.type === "date" || col.type === "datetime" ? "date" : "value";
    const reason = kind === "key" ? KEY_REASON : kind === "date" ? DATE_REASON : (valueReason(col) ?? "requested");
    const a: ScopeAxis = { name, kind, reason };
    if (col.title !== undefined) a.title = col.title;
    out.push(a);
  }
  return out;
}
