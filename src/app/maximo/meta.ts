// Maximo のメタデータ（apimeta / MXAPIINTOBJECT / jsonschemas）の取得と解析。

import type { ColumnSchema, ColumnType } from "../../shared/model";
import { isRecord, type MaximoClient } from "./client";
import { loadRecords } from "./load";

export interface ObjectStructureListItem {
  /** オブジェクト構造名（大文字） */
  name: string;
  description: string;
  href: string | null;
}

const OS_NAME_RE = /^[A-Za-z0-9_]+$/;

/** apimeta?lean=1 の一覧を名前・説明の部分一致（大文字小文字を区別しない）で絞り込む */
export async function listObjectStructures(client: MaximoClient, query?: string, limit = 50): Promise<ObjectStructureListItem[]> {
  const json = await client.get(`${client.apiRoot}/apimeta?lean=1`);
  const all = parseApiMeta(json);
  const q = (query ?? "").trim().toLowerCase();
  const hit = q === "" ? all : all.filter((o) => o.name.toLowerCase().includes(q) || o.description.toLowerCase().includes(q));
  return hit.slice(0, Math.max(0, limit));
}

/**
 * apimeta の応答から name/description/href を抽出する。
 * 応答の形は版によって違う可能性があるため（配列 / member / apis）、どれでも受け付ける。【P0-1 で実機の形を確認する】
 */
export function parseApiMeta(json: unknown): ObjectStructureListItem[] {
  let list: unknown[] = [];
  if (Array.isArray(json)) list = json;
  else if (isRecord(json)) {
    if (Array.isArray(json.member)) list = json.member;
    else if (Array.isArray(json.apis)) list = json.apis;
  }
  const out: ObjectStructureListItem[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!isRecord(item)) continue;
    const href = str(item.href) ?? str(item.about) ?? str(item.schema) ?? null;
    let name = str(item.name) ?? str(item.objectStructure) ?? str(item.title);
    if (!name && href) name = href.replace(/[?#].*$/, "").split("/").filter(Boolean).pop();
    if (!name || !OS_NAME_RE.test(name)) continue;
    const upper = name.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    out.push({ name: upper, description: str(item.description) ?? str(item.title) ?? "", href });
  }
  out.sort(byName);
  return out;
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Maximo に定義されたオブジェクト構造 1 つ（MXAPIINTOBJECT の行） */
export interface DefinedObjectStructure {
  /** オブジェクト構造名（大文字） */
  name: string;
  description: string;
  /** 適用先（USEWITH）。Maximo の言語の値のまま（例 統合、マイグレーション・マネージャー） */
  usewith: string;
}

/** Maximo に定義されたすべてのオブジェクト構造を MXAPIINTOBJECT から読む（名前順） */
export async function listDefinedObjectStructures(client: MaximoClient): Promise<DefinedObjectStructure[]> {
  const attrs = ["INTOBJECTNAME", "DESCRIPTION", "USEWITH"];
  const { records } = await loadRecords(client, {
    os: "MXAPIINTOBJECT",
    select: attrs,
    childIdAttrs: {},
    knownAttrs: new Set(attrs),
    pageSize: 1_000,
    maxRows: 100_000,
  });
  const out: DefinedObjectStructure[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    const name = typeof r.attrs.INTOBJECTNAME === "string" ? r.attrs.INTOBJECTNAME.toUpperCase() : "";
    if (!OS_NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: str(r.attrs.DESCRIPTION) ?? "", usewith: str(r.attrs.USEWITH) ?? "" });
  }
  return out.sort(byName);
}

/** API で使えるオブジェクト構造の一覧（apimeta と Maximo の定義を合わせたもの） */
export interface StructureList {
  /** API で使える構造（名前順） */
  items: Array<{ name: string; description: string }>;
  /** Maximo に定義された構造の数。定義を読めなければ null */
  definedCount: number | null;
  /** apimeta に載らず、定義から足した数 */
  addedFromDefinitions: number;
  /** 定義はあるが、適用先が API で使えないため読み込まない構造（名前順） */
  notApi: DefinedObjectStructure[];
  /** 定義（MXAPIINTOBJECT）を読めなかった理由。このときは apimeta の一覧だけ */
  definedError?: string;
}

/**
 * apimeta の一覧に、Maximo の定義（MXAPIINTOBJECT）にあって apimeta に載らない構造を足す。
 * 実機（2026-09-17）では、顧客が作った EXT_* などが apimeta に載らなかったが、jsonschemas も行の読み取りもできた。
 * 足すのは、apimeta に載る構造と同じ適用先（USEWITH）のものだけ。適用先の値は Maximo の言語で返るので名前で決め打ちせず、
 * apimeta に載る構造の適用先から決める。それ以外（マイグレーション・マネージャー・WOS など。jsonschemas が 500 を返した）は notApi にする。
 */
export function mergeStructureLists(listed: readonly ObjectStructureListItem[], defined: readonly DefinedObjectStructure[] | { error: string }): StructureList {
  const items = listed.map((i) => ({ name: i.name, description: i.description }));
  if (!Array.isArray(defined)) {
    return { items, definedCount: null, addedFromDefinitions: 0, notApi: [], definedError: (defined as { error: string }).error };
  }
  const listedNames = new Set(items.map((i) => i.name));
  const apiUseWith = new Set(defined.filter((d) => listedNames.has(d.name)).map((d) => d.usewith));
  const notApi: DefinedObjectStructure[] = [];
  let added = 0;
  for (const d of defined) {
    if (listedNames.has(d.name)) continue;
    if (apiUseWith.has(d.usewith)) {
      items.push({ name: d.name, description: d.description });
      added++;
    } else {
      notApi.push({ ...d });
    }
  }
  return { items: items.sort(byName), definedCount: defined.length, addedFromDefinitions: added, notApi };
}

export interface ObjectStructureInfo {
  os: string;
  /** 親の列 → 子の列の順。子の列名は "CHILD.ATTR" */
  columns: ColumnSchema[];
  /** スキーマの主キー表示（pk）から得た親のキー列。無ければ空 */
  keyColumns: string[];
  /** 子オブジェクト名 → 子を特定する属性（推定できなければ null） */
  childIdAttrs: Record<string, string | null>;
}

/** jsonschemas/{os}?oslc.select=* を取得して解析する */
export async function getObjectStructureInfo(client: MaximoClient, os: string): Promise<ObjectStructureInfo> {
  if (!OS_NAME_RE.test(os)) throw new Error(`Invalid object structure name ${JSON.stringify(os)}`);
  const json = await client.get(`${client.apiRoot}/jsonschemas/${os.toLowerCase()}?oslc.select=*`);
  return parseJsonSchema(os, json);
}

/** オブジェクト構造の列。child を渡すとその子オブジェクトの列だけを返す */
export async function describeObjectStructure(client: MaximoClient, os: string, child?: string): Promise<ColumnSchema[]> {
  const info = await getObjectStructureInfo(client, os);
  return filterChildColumns(info, child);
}

export function filterChildColumns(info: ObjectStructureInfo, child?: string): ColumnSchema[] {
  if (child === undefined) return info.columns;
  const c = child.toUpperCase();
  if (!(c in info.childIdAttrs)) throw new Error(`Child object ${c} does not exist in ${info.os}`);
  return info.columns.filter((col) => col.child === c);
}

/** 既知の子オブジェクトの ID 属性（名前の規則に合わないもの）。【P0-1 で実機確認が必要】 */
const KNOWN_CHILD_ID_ATTRS: Record<string, string> = {
  MULTIASSETLOCCI: "MULTIID",
  // WPSERVICE / WPMATERIAL / WPTOOL は WPITEM のビューで、一意 ID は WPITEMID と想定（未確認）
  WPSERVICE: "WPITEMID",
  WPMATERIAL: "WPITEMID",
  WPTOOL: "WPITEMID",
};

/**
 * jsonschemas の応答を ColumnSchema[] に解析する。
 * - 列名は大文字。_rowstamp / href / localref など _ で始まるシステム項目は除く。
 * - type:"array"（items に properties）または type:"object"（properties）のプロパティは子オブジェクトとして
 *   "CHILD.ATTR" の列にし child を設定する。孫オブジェクトは未対応なので除く。
 * - 型は subType / format / type から決める。
 * - readOnly は readOnly / readonly / x-readonly / x-readOnly のいずれかが真なら採用する。
 */
export function parseJsonSchema(os: string, schema: unknown): ObjectStructureInfo {
  if (!isRecord(schema)) throw new Error("Invalid jsonschemas response");
  const props = isRecord(schema.properties) ? schema.properties : {};
  const required = requiredSet(schema);
  const parentCols: ColumnSchema[] = [];
  const childCols: ColumnSchema[] = [];
  const childIdAttrs: Record<string, string | null> = {};
  for (const [rawName, rawProp] of Object.entries(props)) {
    if (isSystemProp(rawName) || !isRecord(rawProp)) continue;
    const name = rawName.toUpperCase();
    const childSchema = childSchemaOf(rawProp);
    if (childSchema) {
      const cprops = isRecord(childSchema.properties) ? childSchema.properties : {};
      const creq = requiredSet(childSchema);
      for (const [rawCName, rawCProp] of Object.entries(cprops)) {
        if (isSystemProp(rawCName) || !isRecord(rawCProp) || childSchemaOf(rawCProp)) continue;
        const cname = rawCName.toUpperCase();
        childCols.push(columnOf(`${name}.${cname}`, rawCProp, creq.has(cname) || rawCProp.required === true, name));
      }
      childIdAttrs[name] = inferChildIdAttr(name, childSchema, rawProp);
      continue;
    }
    if (rawProp.type === "array" || rawProp.type === "object") continue;
    parentCols.push(columnOf(name, rawProp, required.has(name) || rawProp.required === true));
  }
  const parentNames = new Set(parentCols.map((c) => c.name));
  const keyColumns = pkOf(schema).filter((k) => parentNames.has(k));
  return { os: os.toUpperCase(), columns: [...parentCols, ...childCols], keyColumns, childIdAttrs };
}

/**
 * ChildIdAttr（子を特定する属性）の決め方。上から順に、子のスキーマに実在する属性だけを採用する。
 *   1. 既知の対応（MULTIASSETLOCCI → MULTIID など）
 *   2. "<子オブジェクト名>ID"（Maximo が作る一意 ID 列の命名。例 EXT_WOPERMIT → EXT_WOPERMITID）
 *   3. "<子オブジェクト名>UID"
 *   4. 子のスキーマの主キー表示（pk 等）が 1 属性だけならそれ
 *   いずれにも当たらなければ null（その子は変更・削除できず、追加だけ可能）。
 * 子オブジェクト名は OS 上の別名（プロパティ名）と、スキーマの resource / objectName の両方で試す。
 * 【この推定は仮定に基づく。P0-1 で EXT_WOPERMIT・ASSETSPEC などの実機スキーマを見て確認が必要】
 */
export function inferChildIdAttr(childName: string, childSchema: Record<string, unknown>, containerProp?: Record<string, unknown>): string | null {
  const cprops = isRecord(childSchema.properties) ? childSchema.properties : {};
  const names = new Set(Object.keys(cprops).map((k) => k.toUpperCase()));
  const aliases: string[] = [];
  for (const a of [childName, str(childSchema.resource), str(childSchema.objectName), str(containerProp?.objectName), str(childSchema.title)]) {
    if (a && OS_NAME_RE.test(a) && !aliases.includes(a.toUpperCase())) aliases.push(a.toUpperCase());
  }
  for (const a of aliases) {
    const known = KNOWN_CHILD_ID_ATTRS[a];
    if (known && names.has(known)) return known;
  }
  for (const suffix of ["ID", "UID"]) {
    for (const a of aliases) {
      if (names.has(`${a}${suffix}`)) return `${a}${suffix}`;
    }
  }
  const pk = pkOf(childSchema).filter((k) => names.has(k));
  if (pk.length === 1) return pk[0]!;
  return null;
}

function columnOf(name: string, prop: Record<string, unknown>, required: boolean, child?: string): ColumnSchema {
  const col: ColumnSchema = { name, type: mapType(prop) };
  const title = str(prop.title) ?? str(prop.remarks);
  if (title) col.title = title;
  if (typeof prop.maxLength === "number" && Number.isFinite(prop.maxLength)) col.maxLength = prop.maxLength;
  if (required) col.required = true;
  if ([prop.readOnly, prop.readonly, prop["x-readonly"], prop["x-readOnly"]].some(truthy)) col.readOnly = true;
  if (child) col.child = child;
  return col;
}

function mapType(prop: Record<string, unknown>): ColumnType {
  const t = str(prop.type)?.toLowerCase();
  const st = str(prop.subType)?.toUpperCase() ?? str(prop.maxType)?.toUpperCase();
  const f = str(prop.format)?.toLowerCase();
  if (st === "DATETIME" || f === "date-time") return "datetime";
  if (st === "DATE" || f === "date") return "date";
  if (st === "YORN" || t === "boolean") return "boolean";
  if (st === "INTEGER" || st === "SMALLINT" || st === "BIGINT" || st === "LONG" || t === "integer") return "integer";
  if (st === "DECIMAL" || st === "FLOAT" || st === "AMOUNT" || st === "DURATION" || t === "number") return "number";
  if (t === "string") return "string";
  return "unknown";
}

function childSchemaOf(prop: Record<string, unknown>): Record<string, unknown> | null {
  if (prop.type === "array" && isRecord(prop.items) && isRecord(prop.items.properties)) return prop.items;
  if (prop.type === "object" && isRecord(prop.properties)) return prop;
  return null;
}

function isSystemProp(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("_") || n === "href" || n === "localref" || n.endsWith("_collectionref") || !OS_NAME_RE.test(name);
}

function requiredSet(schema: Record<string, unknown>): Set<string> {
  return new Set(Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string").map((x) => x.toUpperCase()) : []);
}

function pkOf(schema: Record<string, unknown>): string[] {
  for (const k of ["pk", "primaryKey", "x-pk", "keys"]) {
    const v = schema[k];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return (v as string[]).map((x) => x.toUpperCase());
    if (typeof v === "string" && v !== "") return v.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  }
  return [];
}

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
