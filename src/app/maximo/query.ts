// oslc.select / oslc.where / oslc.orderBy の組み立て。
// LLM の文字列を直接入れない。属性名は ^[A-Za-z0-9_]+$ かつスキーマにある既知の列だけを通す。

import type { CellValue, TypedFilter } from "../../shared/model";

const NAME_RE = /^[A-Za-z0-9_]+$/;
/** in に並べる値の上限（URL 長の保護） */
export const MAX_IN_VALUES = 200;

export class QueryBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryBuildError";
  }
}

/** 列名（"WONUM" / "EXT_WOPERMIT.EXT_PERMITDATE"）を大文字の子オブジェクト名と属性名に分ける */
export function splitColumnName(col: string): { child: string | null; attr: string } {
  const parts = col.split(".");
  if (parts.length > 2) throw new QueryBuildError(`列名 ${JSON.stringify(col)} は 2 階層までにする（孫オブジェクトは未対応）`);
  for (const p of parts) {
    if (!NAME_RE.test(p)) throw new QueryBuildError(`列名 ${JSON.stringify(col)} に使えない文字がある`);
  }
  if (parts.length === 2) return { child: parts[0]!.toUpperCase(), attr: parts[1]!.toUpperCase() };
  return { child: null, attr: parts[0]!.toUpperCase() };
}

function assertKnown(col: string, knownAttrs: Set<string> | undefined): void {
  if (knownAttrs && !knownAttrs.has(col)) throw new QueryBuildError(`列 ${col} はオブジェクト構造に無い`);
}

/**
 * oslc.select を組み立てる。
 * 親は _rowstamp を必ず含め、子は child{<ID 属性>,_rowstamp,...} にする（書き込み時の照合に使う）。
 * 属性名は Maximo の lean 形式に合わせて小文字にする。
 * knownAttrs を渡すとスキーマに無い列を拒否する（列名誤りで黙って空になるのを防ぐ）。
 */
export function buildSelect(select: string[], childIdAttrs: Record<string, string | null>, knownAttrs?: Set<string>): string {
  const idAttrs = upperKeys(childIdAttrs);
  const parent: string[] = ["_rowstamp"];
  const children = new Map<string, string[]>();
  for (const col of select) {
    const { child, attr } = splitColumnName(col);
    if (attr === "_ROWSTAMP") continue;
    assertKnown(child ? `${child}.${attr}` : attr, knownAttrs);
    if (child) {
      let list = children.get(child);
      if (!list) {
        list = [];
        const idAttr = idAttrs[child];
        if (idAttr) {
          if (!NAME_RE.test(idAttr)) throw new QueryBuildError(`子 ${child} の ID 属性名が不正`);
          list.push(idAttr.toLowerCase());
        }
        list.push("_rowstamp");
        children.set(child, list);
      }
      pushUnique(list, attr.toLowerCase());
    } else {
      pushUnique(parent, attr.toLowerCase());
    }
  }
  const parts = [...parent];
  for (const [child, attrs] of children) parts.push(`${child.toLowerCase()}{${attrs.join(",")}}`);
  return parts.join(",");
}

export interface WhereBuildResult {
  /** oslc.where に入れる文字列。条件が無ければ空文字 */
  where: string;
  /** 子属性のフィルタ。Maximo へは送らず、呼び出し元がタブ内で後段フィルタとして評価する */
  postFilters: TypedFilter[];
}

/**
 * TypedFilter[] から oslc.where を組み立てる。複数条件は and でつなぐ。
 * knownAttrs は列名（大文字、子は CHILD.ATTR）の集合。
 */
export function buildWhere(filters: TypedFilter[], knownAttrs: Set<string>): WhereBuildResult {
  const clauses: string[] = [];
  const postFilters: TypedFilter[] = [];
  for (const f of filters) {
    const { child, attr } = splitColumnName(f.attr);
    const col = child ? `${child}.${attr}` : attr;
    assertKnown(col, knownAttrs);
    if (child) {
      // 子のフィルタを oslc.where に入れると「条件に合う子を持つ親」の絞り込みになり、
      // 子の行の絞り込みと意味が変わるため、Maximo へは送らない
      postFilters.push({ ...f, attr: col });
      continue;
    }
    clauses.push(buildClause(attr.toLowerCase(), f));
  }
  return { where: clauses.join(" and "), postFilters };
}

function buildClause(a: string, f: TypedFilter): string {
  switch (f.op) {
    case "eq":
      return `${a}=${scalar(f, false)}`;
    case "ne":
      return `${a}!=${scalar(f, false)}`;
    case "gt":
      return `${a}>${ordered(f)}`;
    case "gte":
      return `${a}>=${ordered(f)}`;
    case "lt":
      return `${a}<${ordered(f)}`;
    case "lte":
      return `${a}<=${ordered(f)}`;
    case "in": {
      if (!Array.isArray(f.value) || f.value.length === 0) throw new QueryBuildError(`${f.attr} の in には 1 件以上の値の配列を渡す`);
      if (f.value.length > MAX_IN_VALUES) throw new QueryBuildError(`${f.attr} の in は ${MAX_IN_VALUES} 件までにする`);
      return `${a} in [${f.value.map((v) => formatValue(f.attr, v, false)).join(",")}]`;
    }
    case "notin":
      // Maximo の否定の in は文書化された構文が確かでなく（!="[a,b]" などは実装依存）、
      // 誤ると条件が黙って無視されて全件が返る。安全のため Maximo へは送らない
      throw new QueryBuildError(`${f.attr} の notin は Maximo の検索条件に使えない。in / ne で表すか、読み込み後にタブ内で絞り込む`);
    case "like": {
      if (Array.isArray(f.value) || f.value === null || f.value === undefined || typeof f.value === "boolean") {
        throw new QueryBuildError(`${f.attr} の like には文字列を渡す`);
      }
      const s = String(f.value);
      if (s === "") throw new QueryBuildError(`${f.attr} の like に空文字は使えない`);
      assertSafeString(f.attr, s, true);
      return `${a}="%${s}%"`;
    }
    case "isnull":
      assertNoValue(f);
      return `${a}!="*"`;
    case "notnull":
      assertNoValue(f);
      return `${a}="*"`;
    default:
      throw new QueryBuildError(`未対応の演算子 ${String((f as { op: unknown }).op)}`);
  }
}

function scalar(f: TypedFilter, _ordered: boolean): string {
  if (Array.isArray(f.value)) throw new QueryBuildError(`${f.attr} の ${f.op} に配列は使えない`);
  if (f.value === undefined || f.value === null) throw new QueryBuildError(`${f.attr} の ${f.op} に値が無い（空の判定は isnull / notnull を使う）`);
  return formatValue(f.attr, f.value, false);
}

function ordered(f: TypedFilter): string {
  if (typeof f.value === "boolean") throw new QueryBuildError(`${f.attr} の ${f.op} に真偽値は使えない`);
  return scalar(f, true);
}

function formatValue(attr: string, v: CellValue, allowPercent: boolean): string {
  if (v === null) throw new QueryBuildError(`${attr} の値に null は使えない（isnull / notnull を使う）`);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new QueryBuildError(`${attr} の数値が不正`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === "") throw new QueryBuildError(`${attr} の値に空文字は使えない（isnull / notnull を使う）`);
  // "*" 単独は Maximo で「値がある」の意味になるので値として使わない
  if (v === "*") throw new QueryBuildError(`${attr} の値に * は使えない（notnull を使う）`);
  assertSafeString(attr, v, allowPercent);
  return `"${v}"`;
}

function assertSafeString(attr: string, s: string, allowPercent: boolean): void {
  // Maximo の oslc.where には " のエスケープ方法が文書化されていないため拒否する
  if (s.includes('"')) throw new QueryBuildError(`${attr} の値に " を含むものは検索条件に使えない`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new QueryBuildError(`${attr} の値に制御文字を含めない`);
  // % は Maximo でワイルドカードとして解釈され、完全一致のつもりが部分一致になる
  if (!allowPercent && s.includes("%")) throw new QueryBuildError(`${attr} の値に % を含めない（部分一致は like を使う）`);
}

function assertNoValue(f: TypedFilter): void {
  if (f.value !== undefined && f.value !== null) throw new QueryBuildError(`${f.attr} の ${f.op} に値は付けない`);
}

/**
 * oslc.orderBy を組み立てる。"-WONUM" は降順、"WONUM" / "+WONUM" は昇順。子の属性では並べ替えない。
 */
export function buildOrderBy(orderBy: string[], knownAttrs?: Set<string>): string {
  return orderBy
    .map((o) => {
      const desc = o.startsWith("-");
      const name = o.replace(/^[+-]/, "");
      const { child, attr } = splitColumnName(name);
      if (child) throw new QueryBuildError(`子の属性 ${name} では並べ替えできない`);
      assertKnown(attr, knownAttrs);
      return `${desc ? "-" : "+"}${attr.toLowerCase()}`;
    })
    .join(",");
}

function pushUnique(list: string[], v: string): void {
  if (!list.includes(v)) list.push(v);
}

export function upperKeys<V>(obj: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(obj)) out[k.toUpperCase()] = v;
  return out;
}
