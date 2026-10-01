// グリッドのセルの色分け・編集可否・ホバーの文言（純関数）。

import type { BatchAuthor, CellValue, ColumnSchema } from "../../shared/model";
import { formatDateForDisplay, type RowStatus, type ViewKind } from "../store";
import { gridMessages } from "./messages";

export type CellTone = "normal" | "readonly" | "llm" | "user" | "added" | "deleted";

export interface CellToneInput {
  view: ViewKind;
  rowStatus: RowStatus | null;
  /** base と値が異なるセル */
  changed: boolean;
  /** そのセルを最後に変えた作者 */
  author: BatchAuthor | null;
  /** 読み取り専用の列（readOnly・キー列・子の ID 列） */
  protectedColumn: boolean;
}

/** 優先順: 削除行 > 追加行 > 変更したセル（作者別） > 読み取り専用の列。元の値ビューでは変更を色付けしない */
export function cellTone(i: CellToneInput): CellTone {
  if (i.view !== "base") {
    if (i.rowStatus === "deleted") return "deleted";
    if (i.rowStatus === "added") return "added";
    if (i.changed) return i.author === "llm" ? "llm" : "user";
  }
  return i.protectedColumn ? "readonly" : "normal";
}

/**
 * Carbon の色の段（IBM Design Language の palette）。文字と地のコントラストはどれも 4.5:1 以上（docs/design.md）。
 * 変更したセルは 20 の段（数が少なく、目立たせる）、行ごとの色は 10 の段（行全体が騒がしくならないように）。
 * 削除行はこれに加えて取り消し線を引く（SheetGrid の drawCell）
 */
export const TONE_STYLE: Record<CellTone, { bg: string; fg: string }> = {
  // background / text-primary
  normal: { bg: "#ffffff", fg: "#161616" },
  // 背景は塗らず、文字だけ薄くする（text-helper）
  readonly: { bg: "#ffffff", fg: "#6f6f6f" },
  // purple 20 / purple 70（LLM の変更）
  llm: { bg: "#e8daff", fg: "#6929c4" },
  // blue 20 / blue 70（利用者の変更）
  user: { bg: "#d0e2ff", fg: "#0043ce" },
  // green 10 / text-primary
  added: { bg: "#defbe6", fg: "#161616" },
  // red 10 / red 70
  deleted: { bg: "#fff1f1", fg: "#a2191f" },
};

/** 凡例に出す色（読み取り専用は色ではなく文字の薄さで分かるので出さない） */
export const LEGEND_TONES: readonly Exclude<CellTone, "normal" | "readonly">[] = ["llm", "user", "added", "deleted"];

/** 凡例に出す色の名前（今の言語の文言） */
export function toneLabel(tone: Exclude<CellTone, "normal">): string {
  return gridMessages().tone[tone];
}

export interface EditableInput {
  view: ViewKind;
  rowStatus: RowStatus | null;
  protectedColumn: boolean;
  /** 反映中のシート */
  busy: boolean;
}

/** 直接編集できるのは最終ビューの、反映中でない、読み取り専用でない列の、削除されていない行だけ */
export function isCellEditable(i: EditableInput): boolean {
  return i.view === "final" && !i.busy && !i.protectedColumn && i.rowStatus !== null && i.rowStatus !== "deleted";
}

export function formatCellValue(v: CellValue): string {
  return v === null ? "" : String(v);
}

/**
 * 列の型に合わせた表示。日付・日時は読みやすい形（2026-10-01 / 2026-10-01 09:00。オフセットは出さない）にそろえる。
 * 表示だけで、値（Maximo に送る ISO 8601）は変えない
 */
export function formatColumnValue(col: Pick<ColumnSchema, "type"> | undefined, v: CellValue): string {
  if (col && (col.type === "date" || col.type === "datetime")) return formatDateForDisplay(col.type, v);
  return formatCellValue(v);
}

/** グリッドで入力した文字列を値にする。空は null。列の型への変換と検査はストア（coerceValue）が行う */
export function parseEditedText(text: string): CellValue {
  return text === "" ? null : text;
}

/** 作者の名前（今の言語の文言） */
export function authorLabel(author: BatchAuthor): string {
  return gridMessages().author[author];
}

export interface HoverInput {
  tone: CellTone;
  author: BatchAuthor | null;
  reason: string | null;
  before: CellValue;
  after: CellValue;
}

/** ホバーで出す行。何も出さないセルは null */
export function hoverLines(h: HoverInput): string[] | null {
  const t = gridMessages();
  const fmt = (v: CellValue) => (v === null || v === "" ? t.hover.empty : String(v));
  const who = h.author ? [t.hover.author(authorLabel(h.author))] : [];
  const why = h.reason ? [t.hover.reason(h.reason)] : [];
  switch (h.tone) {
    case "llm":
    case "user":
      return [...who, ...why, `${fmt(h.before)} → ${fmt(h.after)}`];
    case "added":
      return [t.tone.added, ...who, ...why];
    case "deleted":
      return [t.tone.deleted, ...who, ...why];
    case "readonly":
      return [t.hover.readonlyColumn];
    case "normal":
      return null;
  }
}
