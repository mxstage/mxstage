// グリッドのセルの色分け・編集可否・ホバーの文言（純関数）。

import type { BatchAuthor, CellValue } from "../../shared/model";
import type { RowStatus, ViewKind } from "../store";

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

/** Industry の段の色（鋼青 1 色と中間色）。削除行はこれに加えて取り消し線を引く（SheetGrid の drawCell） */
export const TONE_STYLE: Record<CellTone, { bg: string; fg: string }> = {
  normal: { bg: "#ffffff", fg: "#1d1f20" },
  // 背景は塗らず、文字だけ薄くする（neutral-600）
  readonly: { bg: "#ffffff", fg: "#7a7a7d" },
  // accent-200 / accent-800
  llm: { bg: "#d6ebff", fg: "#2c455d" },
  // accent-400 / accent-900
  user: { bg: "#94bce3", fg: "#1d2d3d" },
  // neutral-200 / text
  added: { bg: "#e7e7ea", fg: "#1d1f20" },
  // neutral-300 / neutral-700
  deleted: { bg: "#d4d4d7", fg: "#5d5d60" },
};

/** 凡例に出す色（読み取り専用は色ではなく文字の薄さで分かるので出さない） */
export const LEGEND_TONES: readonly Exclude<CellTone, "normal" | "readonly">[] = ["llm", "user", "added", "deleted"];

export const TONE_LABEL: Record<Exclude<CellTone, "normal">, string> = {
  llm: "LLM の変更",
  user: "利用者の変更",
  added: "追加行",
  deleted: "削除行",
  readonly: "読み取り専用",
};

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

/** グリッドで入力した文字列を値にする。空は null。列の型への変換と検査はストア（coerceValue）が行う */
export function parseEditedText(text: string): CellValue {
  return text === "" ? null : text;
}

export const AUTHOR_LABEL: Record<BatchAuthor, string> = { llm: "LLM", user: "利用者" };

export interface HoverInput {
  tone: CellTone;
  author: BatchAuthor | null;
  reason: string | null;
  before: CellValue;
  after: CellValue;
}

/** ホバーで出す行。何も出さないセルは null */
export function hoverLines(h: HoverInput): string[] | null {
  const fmt = (v: CellValue) => (v === null || v === "" ? "（空）" : String(v));
  const who = h.author ? [`作者: ${AUTHOR_LABEL[h.author]}`] : [];
  const why = h.reason ? [`根拠: ${h.reason}`] : [];
  switch (h.tone) {
    case "llm":
    case "user":
      return [...who, ...why, `${fmt(h.before)} → ${fmt(h.after)}`];
    case "added":
      return ["追加行", ...who, ...why];
    case "deleted":
      return ["削除行", ...who, ...why];
    case "readonly":
      return ["読み取り専用の列（キー列など）"];
    case "normal":
      return null;
  }
}
