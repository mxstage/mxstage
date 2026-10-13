// 辞書のシート: 共有フォルダの辞書（橋渡しが合わせた今の項目）を作業画面のシートにし、
// 保存前の変更（シートの上の変更）を保存の変更（put・delete）にする。
// - 行キーは項目の ID（e_<16 桁>）。新しく足した行は new~<連番> で、保存すると橋渡しが ID を付ける。
// - 列は種類ごと（src/shared/dictionarySheet.ts の DICT_COLUMNS_OF）。見出しは今の言語で、列名は出さない。

import { entryProblem, parseEntryMode, type DictionaryEntry, type DictionaryEntryInput, type DictionaryKind, type EntryProblem } from "../../shared/dictionary";
import { DICT_COLUMN, DICT_COLUMNS_OF, DICT_FIELD, DICT_FIND, DICT_MODE, DICT_NOTE, DICT_SCOPE, DICT_TO, DICT_UPDATED } from "../../shared/dictionarySheet";
import type { CellValue, ColumnSchema } from "../../shared/model";
import { makeParentKey, type SheetMeta, type SheetRow } from "../../shared/sheet";
import type { Sheet } from "../store/sheet";
import { dictionaryMessages } from "./messages";

export type SaveOp = { op: "put"; id?: string; entry: DictionaryEntryInput } | { op: "delete"; id: string };

export interface DictionaryRef {
  id: string;
  name: string;
  kind: DictionaryKind;
  scope: string;
}

/** 辞書のシートの種類（辞書のシートでなければ null） */
export function dictionaryKindOf(sheet: Sheet): DictionaryKind | null {
  return sheet.meta.source.kind === "dictionary" ? sheet.meta.source.dictKind : null;
}

export function dictionaryColumns(kind: DictionaryKind): ColumnSchema[] {
  const t = dictionaryMessages().columns;
  const titles: Record<string, string> =
    kind === "code"
      ? { [DICT_FIND]: t.word, [DICT_TO]: t.code, [DICT_FIELD]: t.field, [DICT_SCOPE]: t.scope }
      : kind === "value"
        ? { [DICT_FIND]: t.find, [DICT_TO]: t.toValue, [DICT_COLUMN]: t.column }
        : { [DICT_FIND]: t.find, [DICT_TO]: t.to };
  const common: Record<string, Omit<ColumnSchema, "name">> = {
    [DICT_FIND]: { type: "string", maxLength: 200 },
    [DICT_TO]: { type: "string", maxLength: 200 },
    [DICT_MODE]: { title: t.mode, type: "string", valueLabels: { text: t.modeText, regex: t.modeRegex } },
    [DICT_NOTE]: { title: t.note, type: "string", maxLength: 500 },
    [DICT_UPDATED]: { title: t.updated, type: "string", readOnly: true },
    [DICT_FIELD]: { type: "string", maxLength: 64 },
    [DICT_SCOPE]: { type: "string", maxLength: 200 },
    [DICT_COLUMN]: { type: "string", maxLength: 128 },
  };
  return DICT_COLUMNS_OF[kind].map((name) => ({ name, ...common[name], ...(titles[name] ? { title: titles[name] } : {}), hideName: true }) as ColumnSchema);
}

export function dictionarySheetMeta(sheetName: string, ref: DictionaryRef): SheetMeta {
  return {
    name: sheetName,
    source: { kind: "dictionary", dictionaryId: ref.id, dictionaryName: ref.name, dictKind: ref.kind, scope: ref.scope },
    columns: dictionaryColumns(ref.kind),
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
      values: {
        [DICT_FIND]: e.find,
        [DICT_TO]: e.to,
        [DICT_MODE]: e.mode,
        [DICT_NOTE]: e.note,
        [DICT_UPDATED]: updatedLabel(e),
        [DICT_FIELD]: e.field ?? null,
        [DICT_SCOPE]: e.scope ?? null,
        [DICT_COLUMN]: e.column ?? null,
      },
    };
  });
}

function text(v: CellValue | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

/** シートの行を辞書の項目にする（保存・検査・当てはめで使う） */
export function entryOfRow(sheet: Sheet, rowKey: string): DictionaryEntryInput & { modeRaw: CellValue } {
  const row = sheet.row(rowKey);
  const get = (col: string) => (row && sheet.hasColumn(col) ? sheet.finalValue(row, col) : null);
  const modeRaw = get(DICT_MODE);
  const out: DictionaryEntryInput & { modeRaw: CellValue } = { find: text(get(DICT_FIND)), to: text(get(DICT_TO)), mode: parseEntryMode(modeRaw) ?? "text", note: text(get(DICT_NOTE)), modeRaw };
  const field = text(get(DICT_FIELD)).trim();
  const scope = text(get(DICT_SCOPE)).trim();
  const column = text(get(DICT_COLUMN)).trim();
  if (field !== "") out.field = field;
  if (scope !== "") out.scope = scope;
  if (column !== "") out.column = column;
  return out;
}

/** 項目の問題（使えない項目）。使えれば null */
export function rowProblem(sheet: Sheet, rowKey: string): EntryProblem | null {
  const e = entryOfRow(sheet, rowKey);
  return entryProblem({ ...e, mode: e.modeRaw }, dictionaryKindOf(sheet) ?? "alias");
}

/** シートの全項目（当てはめ用。ID は行キー） */
export function sheetEntries(sheet: Sheet): Array<DictionaryEntryInput & { id: string; modeRaw: CellValue }> {
  return sheet.viewRows("final").map((r) => ({ id: r.rowKey, ...entryOfRow(sheet, r.rowKey) }));
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
  const kind = dictionaryKindOf(sheet) ?? "alias";
  for (const row of sheet.orderedRows()) {
    const status = sheet.rowStatus(row);
    if (status === null || status === "base") continue;
    if (status === "deleted") {
      out.ops.push({ op: "delete", id: row.rowKey });
      out.deleted++;
      continue;
    }
    const e = entryOfRow(sheet, row.rowKey);
    const problem = entryProblem({ ...e, mode: e.modeRaw }, kind);
    if (problem !== null) {
      out.problems.push({ rowKey: row.rowKey, problem });
      continue;
    }
    const { modeRaw: _m, ...input } = e;
    const entry: DictionaryEntryInput = { ...input, find: input.find.trim(), to: input.to.trim(), note: input.note.trim() };
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
