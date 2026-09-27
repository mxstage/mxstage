// 保存したオブジェクト構造の横断検索。利用者が構造名やテーブル名を言わなくても、
// 業務の言葉（例 許可申請、申請完了日、タグ番号）から候補の構造と当たった属性を探す。
// LLM のツール find_object_structures と、作業画面の「オブジェクト構造」の検索欄が同じ決め方を使う。
// - 探すのは構造名・子オブジェクト名・属性名・属性の日本語ラベル（この Maximo は構造の説明が空なので、日本語はラベルにある）。
// - 言葉はすべて当たる構造を優先し、1 つも無ければ一部だけ当たる構造を partial として返す。
// - 点数が同じなら MXAPI で始まる構造（REST API 向けに用意された構造）を先に並べる。

import type { ColumnSchema, ColumnType } from "../../shared/model";
import { foldText, type StoredObjectStructure } from "./catalog";

export interface StructureSearchColumn {
  name: string;
  title?: string;
  type: ColumnType;
}

export interface StructureSearchHit {
  os: string;
  score: number;
  /** 当たった言葉（検索語を正規化したもの） */
  matchedTerms: string[];
  /** 構造名に当たったか */
  nameMatched: boolean;
  /** 名前が当たった子オブジェクト */
  childMatches: string[];
  /** 当たった属性の数 */
  matchedColumnCount: number;
  /** 当たった属性（強く当たった順に上限まで） */
  columns: StructureSearchColumn[];
}

export interface StructureSearchResult {
  terms: string[];
  /** 検索語のすべてに当たる構造が無く、一部だけ当たる構造を返したか */
  partial: boolean;
  /** 当たった構造の数（返した数ではない） */
  totalHits: number;
  hits: StructureSearchHit[];
}

export interface StructureSearchOptions {
  limit?: number;
  columnsPerStructure?: number;
}

/** 検索語を分ける（空白・読点・カンマ・中黒・スラッシュ）。全角半角と大文字小文字はそろえる */
export function searchTerms(query: string): string[] {
  const terms = foldText(query)
    .split(/[\s、,，・/／]+/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  return Array.from(new Set(terms));
}

const WEIGHT = {
  osName: 6,
  childName: 5,
  titleExact: 5,
  titlePartial: 3,
  columnName: 2,
} as const;

/** 属性 1 つと検索語 1 つの当たり方（当たらなければ 0） */
function columnWeight(c: ColumnSchema, term: string): number {
  if (c.title !== undefined) {
    const title = foldText(c.title);
    if (title === term) return WEIGHT.titleExact;
    if (title.includes(term)) return WEIGHT.titlePartial;
  }
  return foldText(c.name).includes(term) ? WEIGHT.columnName : 0;
}

function scoreStructure(entry: StoredObjectStructure, terms: readonly string[], columnsPerStructure: number): StructureSearchHit | null {
  const osName = foldText(entry.os);
  const childNames = Object.keys(entry.info.childIdAttrs);
  const columnBest = new Map<ColumnSchema, number>();
  const matchedTerms: string[] = [];
  const childMatches = new Set<string>();
  let nameMatched = false;
  let score = 0;
  for (const term of terms) {
    let best = 0;
    let columnHits = 0;
    if (osName.includes(term)) {
      nameMatched = true;
      best = Math.max(best, WEIGHT.osName);
    }
    for (const child of childNames) {
      if (foldText(child).includes(term)) {
        childMatches.add(child);
        best = Math.max(best, WEIGHT.childName);
      }
    }
    for (const c of entry.info.columns) {
      const w = columnWeight(c, term);
      if (w === 0) continue;
      columnHits++;
      columnBest.set(c, Math.max(columnBest.get(c) ?? 0, w));
      best = Math.max(best, w);
    }
    if (best > 0) {
      matchedTerms.push(term);
      // 同じ言葉に多くの属性が当たる構造を少しだけ上にする（上限を付けて、列の多い構造ばかりにならないように）
      score += best + Math.min(columnHits, 3) * 0.25;
    }
  }
  if (matchedTerms.length === 0) return null;
  const columns = Array.from(columnBest.entries())
    .sort((a, b) => b[1] - a[1] || (a[0].child ? 1 : 0) - (b[0].child ? 1 : 0) || (a[0].name < b[0].name ? -1 : 1))
    .slice(0, columnsPerStructure)
    .map(([c]) => {
      const v: StructureSearchColumn = { name: c.name, type: c.type };
      if (c.title !== undefined) v.title = c.title;
      return v;
    });
  return { os: entry.os, score, matchedTerms, nameMatched, childMatches: Array.from(childMatches), matchedColumnCount: columnBest.size, columns };
}

function compareHits(a: StructureSearchHit, b: StructureSearchHit): number {
  if (b.score !== a.score) return b.score - a.score;
  const apiA = a.os.startsWith("MXAPI") ? 0 : 1;
  const apiB = b.os.startsWith("MXAPI") ? 0 : 1;
  if (apiA !== apiB) return apiA - apiB;
  return a.os < b.os ? -1 : a.os > b.os ? 1 : 0;
}

export function searchStructures(entries: readonly StoredObjectStructure[], query: string, opts: StructureSearchOptions = {}): StructureSearchResult {
  const terms = searchTerms(query);
  const limit = Math.max(1, opts.limit ?? 10);
  const columnsPerStructure = Math.max(0, opts.columnsPerStructure ?? 8);
  if (terms.length === 0) return { terms, partial: false, totalHits: 0, hits: [] };
  const scored = entries.map((e) => scoreStructure(e, terms, columnsPerStructure)).filter((h): h is StructureSearchHit => h !== null);
  const full = scored.filter((h) => h.matchedTerms.length === terms.length);
  const partial = full.length === 0;
  const pool = (partial ? scored : full).sort(compareHits);
  return { terms, partial: partial && pool.length > 0, totalHits: pool.length, hits: pool.slice(0, limit) };
}
