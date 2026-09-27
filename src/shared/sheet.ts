// タブ内のシートの内部表現と、Maximo へのコミット計画の型。
// 画面のシートストア（src/app/store）と書き込みエンジン（src/app/maximo）が共有する。

import type { BatchAuthor, CellValue, ColumnSchema, SheetSource } from "./model";

/** Maximo から取得した親レコード 1 件 */
export interface MaximoRecord {
  /** GET で得た href。書き込みはこの URL にだけ送る（クライアントで組み立てない） */
  href: string;
  /** _rowstamp。不透明な文字列として比較する */
  rowstamp: string | null;
  /** 親の属性。列名は大文字に正規化する */
  attrs: Record<string, CellValue>;
  /** 子オブジェクト名（大文字）→ 子レコード */
  children: Record<string, MaximoChild[]>;
}

export interface MaximoChild {
  /** 子を特定する属性名（例 MULTIID）。分からない場合は null（その子は変更・削除できない） */
  idAttr: string | null;
  id: CellValue;
  rowstamp: string | null;
  attrs: Record<string, CellValue>;
  href?: string;
}

/** グリッドの 1 行。親だけの行、または親×子の行（MXLoader と同じ平坦な形） */
export interface SheetRow {
  rowKey: string;
  parentKey: string;
  childName: string | null;
  /** 列名 → 値。子の行にも親の列の値を入れる */
  values: Record<string, CellValue>;
}

export type OverlayOp =
  | { kind: "set"; rowKey: string; col: string; value: CellValue; prev: CellValue }
  | { kind: "addRow"; rowKey: string; parentKey: string; childName: string | null; values: Record<string, CellValue> }
  | { kind: "deleteRow"; rowKey: string };

export interface BatchRecord {
  batchId: string;
  author: BatchAuthor;
  reason?: string;
  createdAt: number;
  sheet: string;
  ops: OverlayOp[];
  undone: boolean;
}

/** 別のシートの列から引いて読み込んだマスタ（機器台帳・ロケーションなど）のつながり */
export interface SheetLink {
  /** 参照元のシート名 */
  sheet: string;
  /** 参照元の列（子は CHILD.ATTR） */
  from: string;
  /** このシート側の列（例 ASSETNUM） */
  to: string;
}

export interface SheetMeta {
  name: string;
  source: SheetSource;
  columns: ColumnSchema[];
  /** 親を特定するキー列（例 SITEID, WONUM） */
  keyColumns: string[];
  /** 子オブジェクト名 → 子を特定する属性名（不明なら null） */
  childIdAttrs: Record<string, string | null>;
  /** どのシートのどの列から引いて読み込んだか（画面はこれで関連シートを並べ、選んだ行に連動させる） */
  link?: SheetLink;
}

// ---------------------------------------------------------------------------
// 行キー
//   親行:  encodeURIComponent(キー値1)|encodeURIComponent(キー値2)
//   子行:  <親キー>#<子オブジェクト名>:<encodeURIComponent(子ID)>   新規の子は ID を "new~<連番>" にする
// ---------------------------------------------------------------------------

const PARENT_SEP = "|";
const CHILD_SEP = "#";
const ID_SEP = ":";
export const NEW_CHILD_PREFIX = "new~";

function keyPart(v: CellValue): string {
  return encodeURIComponent(v === null ? "" : String(v));
}

export function makeParentKey(keyValues: CellValue[]): string {
  return keyValues.map(keyPart).join(PARENT_SEP);
}

export function makeChildRowKey(parentKey: string, childName: string, childId: CellValue | `${typeof NEW_CHILD_PREFIX}${number}`): string {
  return `${parentKey}${CHILD_SEP}${childName}${ID_SEP}${keyPart(childId as CellValue)}`;
}

export function parseRowKey(rowKey: string): { parentKey: string; childName: string | null; childId: string | null; isNewChild: boolean } {
  const i = rowKey.indexOf(CHILD_SEP);
  if (i < 0) return { parentKey: rowKey, childName: null, childId: null, isNewChild: false };
  const parentKey = rowKey.slice(0, i);
  const rest = rowKey.slice(i + 1);
  const j = rest.indexOf(ID_SEP);
  const childName = j < 0 ? rest : rest.slice(0, j);
  const childId = j < 0 ? null : decodeURIComponent(rest.slice(j + 1));
  return { parentKey, childName, childId, isNewChild: childId !== null && childId.startsWith(NEW_CHILD_PREFIX) };
}

// ---------------------------------------------------------------------------
// コミット計画（親 1 件につき HTTP 1 回）
// ---------------------------------------------------------------------------

export type ChildCommitOp =
  | { action: "Change"; idAttr: string; id: CellValue; attrs: Record<string, CellValue> }
  | { action: "Delete"; idAttr: string; id: CellValue }
  | { action: "Add"; attrs: Record<string, CellValue> };

export interface ParentCommitPlan {
  parentKey: string;
  href: string;
  /** 送信直前に読み直して一致を確かめる値 */
  expectedRowstamp: string | null;
  /** 子オブジェクト名 → 読み込み時点の子 ID の集合（照合用） */
  expectedChildIds: Record<string, CellValue[]>;
  /** 変更された親属性だけ */
  attrs: Record<string, CellValue>;
  children: Record<string, ChildCommitOp[]>;
  /** 変更・削除する子の読み込み時 _rowstamp（子オブジェクト名 → 子 ID 文字列 → rowstamp）。子だけの更新では親の _rowstamp が変わらないことがあるため照合に使う */
  expectedChildRowstamps?: Record<string, Record<string, string | null>>;
}
