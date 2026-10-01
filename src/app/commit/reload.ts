// 反映を確かめた親を Maximo から読み直し、シートの base を置き換える行を作る。

import type { CellValue } from "../../shared/model";
import { makeChildRowKey, type MaximoRecord, type SheetRow } from "../../shared/sheet";
import type { MaximoClient } from "../maximo/client";
import { parentKeyOf, parseMember, recordsToRows } from "../maximo/load";
import { buildSelect, upperKeys } from "../maximo/query";
import type { ParentReplacement, Sheet } from "../store";
import { commitMessages as m } from "./messages";

export interface ReloadOutcome {
  replacements: ParentReplacement[];
  /** 読み直せなかった親 → 理由（値を含めない） */
  failures: Map<string, string>;
}

/**
 * 親ごとに、読み込み時の href をそのシートの select で GET し直す。
 * 行はシートに出ていた子（読み込み時にあった子のうちシートに行があったもの）と、読み込み時に無かった子（反映で追加した子）だけにする。
 * 読み込み時に子の属性の条件で外していた子を、反映をきっかけにシートへ出さないため。
 */
export async function reloadParents(client: MaximoClient, sheet: Sheet, parentKeys: readonly string[]): Promise<ReloadOutcome> {
  const meta = sheet.meta;
  const names = meta.columns.map((c) => c.name);
  const select = buildSelect([...meta.keyColumns, ...names], meta.childIdAttrs, new Set(names));
  const idAttrs = upperKeys(meta.childIdAttrs);
  const byKey = new Map<string, MaximoRecord>();
  for (const r of sheet.records) byKey.set(parentKeyOf(r, meta.keyColumns), r);
  const replacements: ParentReplacement[] = [];
  const failures = new Map<string, string>();
  for (const pk of parentKeys) {
    const old = byKey.get(pk);
    if (old === undefined) {
      failures.set(pk, m().reload.parentNotFound);
      continue;
    }
    let rec: MaximoRecord;
    try {
      const path = client.hrefToPath(old.href);
      const json = await client.get(`${path}?lean=1&oslc.select=${encodeURIComponent(select)}`);
      // 以後の書き込み先は読み込み時の href に固定する（I7）
      rec = { ...parseMember(json, idAttrs, { requireHref: false }), href: old.href };
    } catch (e) {
      failures.set(pk, m().reload.readFailed(e instanceof Error ? e.message : m().unknownError));
      continue;
    }
    if (parentKeyOf(rec, meta.keyColumns) !== pk) {
      failures.set(pk, m().reload.keyMismatch);
      continue;
    }
    let rows: SheetRow[];
    try {
      rows = recordsToRows([rec], meta);
    } catch (e) {
      failures.set(pk, m().reload.rowsInvalid(e instanceof Error ? e.message : m().unknownError));
      continue;
    }
    replacements.push({ parentKey: pk, record: rec, rows: visibleRows(sheet, pk, old, rows) });
  }
  return { replacements, failures };
}

function visibleRows(sheet: Sheet, pk: string, old: MaximoRecord, rows: SheetRow[]): SheetRow[] {
  const shown = new Set(
    sheet
      .group(pk)
      .filter((r) => r.added === null)
      .map((r) => r.rowKey),
  );
  const loaded = new Set<string>();
  for (const [kind, list] of Object.entries(old.children)) {
    for (const c of list) if (c.idAttr && c.id !== null) loaded.add(makeChildRowKey(pk, kind, c.id));
  }
  const kept = rows.filter((r) => r.childName === null || shown.has(r.rowKey) || !loaded.has(r.rowKey));
  if (kept.length > 0) return kept;
  // 出ていた子がすべて消えた: 子を追加できるよう、子の列を空にした親だけの行にする
  const first = rows[0];
  if (first === undefined) return rows;
  const values: Record<string, CellValue> = { ...first.values };
  for (const c of sheet.meta.columns) if (c.child) values[c.name] = null;
  return [{ rowKey: pk, parentKey: pk, childName: null, values }];
}
