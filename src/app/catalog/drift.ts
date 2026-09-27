// シートと、そのシートを読み込んだオブジェクト構造の今の定義との食い違い。
// シートは読み込んだときの列の定義を持ち、Maximo への反映もその定義で組み立てる。
// 読み込んだ後に作業画面が定義を取り直し（「すべて取り直す」・再読み込み）、反映に使う列が変わっていたら、
// 古い定義のまま送らずに止める（例: 列が無くなった・読み取り専用になった・型が変わった・子を特定する属性が変わった）。

import type { ColumnSchema } from "../../shared/model";
import { parseRowKey, type SheetMeta } from "../../shared/sheet";
import type { CommitChanges } from "../maximo/commit";
import type { ObjectStructureInfo } from "../maximo/meta";

/** 反映に使う列と子オブジェクト（変更したセル・追加した行の列、変更・追加・削除する子） */
function usedByChanges(changes: CommitChanges): { columns: Set<string>; children: Set<string> } {
  const columns = new Set<string>();
  const children = new Set<string>();
  for (const c of changes.cells) {
    columns.add(c.col.toUpperCase());
    const child = parseRowKey(c.rowKey).childName;
    if (child !== null) children.add(child.toUpperCase());
  }
  for (const r of changes.addedRows) {
    for (const k of Object.keys(r.values)) columns.add(k.toUpperCase());
    if (r.childName !== null) children.add(r.childName.toUpperCase());
  }
  for (const rowKey of changes.deletedRows) {
    const child = parseRowKey(rowKey).childName;
    if (child !== null) children.add(child.toUpperCase());
  }
  return { columns, children };
}

/** 食い違いの説明（無ければ空）。変更に関係しない列の違いは問わない */
export function structureDriftProblems(meta: SheetMeta, current: ObjectStructureInfo, changes: CommitChanges): string[] {
  const problems: string[] = [];
  const before = new Map<string, ColumnSchema>(meta.columns.map((c) => [c.name.toUpperCase(), c]));
  const now = new Map<string, ColumnSchema>(current.columns.map((c) => [c.name.toUpperCase(), c]));
  const used = usedByChanges(changes);
  for (const name of Array.from(used.columns).sort()) {
    const old = before.get(name);
    if (old === undefined) continue; // シートに無い列は反映の組み立てで弾かれる
    const cur = now.get(name);
    if (cur === undefined) {
      problems.push(`列 ${name} が無くなりました`);
      continue;
    }
    if (cur.readOnly === true && old.readOnly !== true) problems.push(`列 ${name} が読み取り専用になりました`);
    if (cur.type !== old.type) problems.push(`列 ${name} の型が ${old.type} から ${cur.type} に変わりました`);
    if (cur.maxLength !== undefined && old.maxLength !== undefined && cur.maxLength < old.maxLength) {
      problems.push(`列 ${name} の桁が ${old.maxLength} から ${cur.maxLength} に減りました`);
    }
  }
  for (const child of Array.from(used.children).sort()) {
    if (!Object.prototype.hasOwnProperty.call(current.childIdAttrs, child)) {
      problems.push(`子オブジェクト ${child} が無くなりました`);
      continue;
    }
    const oldId = meta.childIdAttrs[child] ?? null;
    const newId = current.childIdAttrs[child] ?? null;
    if (oldId !== newId) problems.push(`子オブジェクト ${child} を特定する属性が ${oldId ?? "不明"} から ${newId ?? "不明"} に変わりました`);
  }
  if (current.keyColumns.length > 0 && meta.keyColumns.length > 0 && current.keyColumns.join(",") !== meta.keyColumns.join(",")) {
    problems.push(`キー列が ${meta.keyColumns.join(", ")} から ${current.keyColumns.join(", ")} に変わりました`);
  }
  return problems;
}
