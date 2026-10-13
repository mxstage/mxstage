// 辞書のシート: 共有フォルダの辞書（橋渡しが合わせた今の項目）を作業画面のシートにし、
// 保存前の変更（シートの上の変更）を保存の変更（put・delete）にする。
// - 行キーは項目の ID（e_<16 桁>）。新しく足した行は new~<連番> で、保存すると橋渡しが ID を付ける。
// - 列は書き方・正しい名前・合わせ方・メモ・最後に変えた人（読み取り専用）。見出しは今の言語で、列名は出さない。

import { entryProblem, parseEntryMode, type DictionaryEntry, type DictionaryEntryInput, type EntryProblem } from "../../shared/dictionary";
import { DICT_FIND, DICT_MODE, DICT_NOTE, DICT_TO, DICT_UPDATED } from "../../shared/dictionarySheet";
import type { CellValue, ColumnSchema } from "../../shared/model";
import { makeParentKey, type SheetMeta, type SheetRow } from "../../shared/sheet";
import type { Sheet } from "../store/sheet";
import { dictionaryMessages } from "./messages";

export type SaveOp = { op: "put"; id?: string; entry: DictionaryEntryInput } | { op: "delete"; id: string };

export interface DictionaryRef {
  id: string;
  name: string;
  kind: "alias";
  scope: string;
}

export function dictionaryColumns(): ColumnSchema[] {
  const t = dictionaryMessages().columns;
  return [
    { name: DICT_FIND, title: t.find, type: "string", maxLength: 200, hideName: true },
    { name: DICT_TO, title: t.to, type: "string", maxLength: 200, hideName: true },
    { name: DICT_MODE, title: t.mode, type: "string", hideName: true, valueLabels: { text: t.modeText, regex: t.modeRegex } },
    { name: DICT_NOTE, title: t.note, type: "string", maxLength: 500, hideName: true },
    { name: DICT_UPDATED, title: t.updated, type: "string", readOnly: true, hideName: true },
  ];
}

export function dictionarySheetMeta(sheetName: string, ref: DictionaryRef): SheetMeta {
  return {
    name: sheetName,
    source: { kind: "dictionary", dictionaryId: ref.id, dictionaryName: ref.name, dictKind: ref.kind, scope: ref.scope },
    columns: dictionaryColumns(),
    keyColumns: [],
    childIdAttrs: {},
  };
}

/** 「武藤 10/08 14:02」（今の言語の日時の書き方） */
export function updatedLabel(e: Pick<DictionaryEntry, "updatedAt" | "updatedBy">): string {
  const d = new Date(e.updatedAt);
  if (Number.isNaN(d.getTime())) return e.updatedBy;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${e.updatedBy} ${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function entriesToRows(entries: readonly DictionaryEntry[]): SheetRow[] {
  return entries.map((e) => {
    const rowKey = makeParentKey([e.id]);
    return {
      rowKey,
      parentKey: rowKey,
      childName: null,
      values: { [DICT_FIND]: e.find, [DICT_TO]: e.to, [DICT_MODE]: e.mode, [DICT_NOTE]: e.note, [DICT_UPDATED]: updatedLabel(e) },
    };
  });
}

function text(v: CellValue): string {
  return v === null || v === undefined ? "" : String(v);
}

/** シートの行を辞書の項目にする（保存と検査で使う） */
export function entryOfRow(sheet: Sheet, rowKey: string): DictionaryEntryInput & { modeRaw: CellValue } {
  const row = sheet.row(rowKey);
  const get = (col: string) => (row ? sheet.finalValue(row, col) : null);
  const modeRaw = get(DICT_MODE);
  return { find: text(get(DICT_FIND)), to: text(get(DICT_TO)), mode: parseEntryMode(modeRaw) ?? "text", note: text(get(DICT_NOTE)), modeRaw };
}

/** 項目の問題（使えない項目）。使えれば null */
export function rowProblem(sheet: Sheet, rowKey: string): EntryProblem | null {
  const e = entryOfRow(sheet, rowKey);
  return entryProblem({ find: e.find, to: e.to, mode: e.modeRaw, note: e.note });
}

export interface PendingChanges {
  ops: SaveOp[];
  added: number;
  changed: number;
  deleted: number;
  /** 使えない項目（保存しない。理由を出す） */
  problems: Array<{ rowKey: string; problem: EntryProblem }>;
}

/** 保存前の変更を保存の変更にする */
export function pendingChanges(sheet: Sheet): PendingChanges {
  const out: PendingChanges = { ops: [], added: 0, changed: 0, deleted: 0, problems: [] };
  for (const row of sheet.orderedRows()) {
    const status = sheet.rowStatus(row);
    if (status === null || status === "base") continue;
    if (status === "deleted") {
      out.ops.push({ op: "delete", id: row.rowKey });
      out.deleted++;
      continue;
    }
    const e = entryOfRow(sheet, row.rowKey);
    const problem = entryProblem({ find: e.find, to: e.to, mode: e.modeRaw, note: e.note });
    if (problem !== null) {
      out.problems.push({ rowKey: row.rowKey, problem });
      continue;
    }
    const entry: DictionaryEntryInput = { find: e.find.trim(), to: e.to.trim(), mode: e.mode, note: e.note.trim() };
    if (status === "added") {
      out.ops.push({ op: "put", entry });
      out.added++;
    } else {
      out.ops.push({ op: "put", id: row.rowKey, entry });
      out.changed++;
    }
  }
  return out;
}

/** 使えない理由（今の言語） */
export function problemText(p: EntryProblem): string {
  const t = dictionaryMessages().problems;
  const base = t[p.code] as string;
  return p.detail ? t.withDetail(base, p.detail) : base;
}
