// 表示だけの列の中身: 突き合わせ先（左のシート）と、辞書の効いた行（辞書のシート）。
// 列はシートの値ではない（編集・差分・反映には入らない）。文言は今の言語。

import { headerLines } from "../../shared/columnLabel";
import { formatCellValue } from "../grid/cellStyle";
import type { ExtraColumn } from "../grid/SheetGrid";
import { dictionaryMessages } from "../dictionaries/messages";
import { problemText, rowProblem } from "../dictionaries/sheet";
import { DICT_FIND, DICT_MODE, DICT_TO } from "../../shared/dictionarySheet";
import type { Workspace } from "../store";
import type { RowState } from "../store/sheet";
import type { MatchArgs, MatchView, MatchViewStore } from "./views";

export const MATCH_COLUMN_ID = "\u0001match";
export const HITS_COLUMN_ID = "\u0001hits";

/** 相手の行の見え方（キーの値 + 説明）。例「148700 3号炉 スートブロワ No.3」 */
export function targetText(ws: Workspace, sheetName: string, rowKey: string): string {
  if (!ws.hasSheet(sheetName)) return rowKey;
  const sheet = ws.getSheet(sheetName);
  const row = sheet.row(rowKey);
  if (!row) return rowKey;
  const keys = sheet.meta.keyColumns.filter((k) => !/^(SITEID|ORGID)$/i.test(k));
  const key = (keys.length > 0 ? keys : sheet.meta.keyColumns).map((k) => formatCellValue(sheet.finalValue(row, k))).filter((v) => v !== "").join(" / ");
  const desc = sheet.hasColumn("DESCRIPTION") ? formatCellValue(sheet.finalValue(row, "DESCRIPTION")) : "";
  return [key || rowKey, desc].filter((v) => v !== "").join(" ");
}

/** 列のラベル（見出しの日本語名があればそれ） */
function colLabel(ws: Workspace, sheet: string, col: string): string {
  if (!ws.hasSheet(sheet)) return col;
  const c = ws.getSheet(sheet).column(col);
  return c ? headerLines(c).main : col;
}

/** AI が使った条件を、利用者が読める言葉で */
export function conditionLines(ws: Workspace, args: MatchArgs): string[] {
  const r = dictionaryMessages().reason;
  const e = args.extra;
  const out: string[] = [];
  const left = (c: string) => colLabel(ws, args.left, c);
  const leftCols = args.leftCol === undefined ? [] : Array.isArray(args.leftCol) ? args.leftCol : [args.leftCol];
  if (leftCols.length > 0) out.push(r.eq(leftCols.map(left).join("・")));
  if (e.contains) out.push(r.contains(left(e.contains.col)));
  if (e.dateWithin) out.push(r.dateWithin(left(e.dateWithin.col)));
  if (e.targetFilter && e.targetFilter.length > 0) out.push(r.targetFilter);
  if (e.group) out.push(r.group(left(e.group)));
  if (e.followsAbove) out.push(r.followsAbove);
  if (e.rewrite && e.rewrite.length > 0) out.push(r.rewrite(e.rewrite.length));
  if (e.dictionaries && e.dictionaries.length > 0) out.push(r.dictionaries(e.dictionaries.join("・")));
  return out;
}

/** 辞書の項目（辞書のシートの行キー）の読み替えの説明 */
function aliasLines(ws: Workspace, args: MatchArgs, ids: readonly string[]): string[] {
  const r = dictionaryMessages().reason;
  const out: string[] = [];
  for (const name of args.extra.dictionaries ?? []) {
    const d = ws.dictionarySheet(name);
    if (d === null) continue;
    for (const id of ids) {
      const row = d.row(id);
      if (!row) continue;
      out.push(r.alias(formatCellValue(d.finalValue(row, DICT_FIND)), formatCellValue(d.finalValue(row, DICT_TO)), name));
    }
  }
  return out;
}

export interface MatchColumnActions {
  /** 見つからない行の「読み替えを足す」 */
  onAddAlias(row: RowState, bounds: { x: number; y: number; width: number; height: number }): void;
}

/** 左のシートの「突き合わせ先」の列 */
export function matchColumn(ws: Workspace, view: MatchView, actions: MatchColumnActions): ExtraColumn {
  const t = dictionaryMessages().column;
  const conditions = conditionLines(ws, view.args);
  const r = dictionaryMessages().reason;
  return {
    id: MATCH_COLUMN_ID,
    title: t.title,
    width: 300,
    // 帳票の列が多く、文の列は右の方にあることが多い。結果は最初に見える所に置き、指すと読んだ文を出す
    after: "start",
    cell: (row) => {
      const m = view.rows.get(row.rowKey);
      if (!m) return null;
      const aliases = aliasLines(ws, view.args, m.aliases);
      const read = m.label === "" ? [] : [r.readAs(m.label)];
      if (m.kind === "matched") {
        const suffix = m.byAbove ? ` ${t.byAbove}` : m.byGroup ? ` ${t.byGroup}` : "";
        return { text: `${targetText(ws, view.args.right, m.targets[0] ?? "")}${suffix}`, tone: "ok", hover: [...read, ...aliases, ...conditions] };
      }
      if (m.kind === "ambiguous") {
        return { text: t.ambiguous(m.targets.length), tone: "warn", hover: [...read, `${t.candidates}:`, ...m.targets.slice(0, 10).map((k) => `・${targetText(ws, view.args.right, k)}`), ...aliases] };
      }
      return { text: t.unmatched, tone: "none", action: t.addAlias, hover: [...read, ...aliases, t.addAliasHint] };
    },
    onClick: (row, bounds) => {
      if (view.rows.get(row.rowKey)?.kind === "unmatched") actions.onAddAlias(row, bounds);
    },
  };
}

/** 辞書のシートの「効いた行」の列 */
export function hitsColumn(ws: Workspace, sheetName: string, matches: MatchViewStore | undefined): ExtraColumn {
  const t = dictionaryMessages();
  const sheet = ws.hasSheet(sheetName) ? ws.getSheet(sheetName) : null;
  const name = sheet?.meta.source.kind === "dictionary" ? sheet.meta.source.dictionaryName : sheetName;
  const hits = matches?.hitsFor(name) ?? { used: false, hits: new Map() };
  return {
    id: HITS_COLUMN_ID,
    title: t.columns.hits,
    width: 150,
    after: DICT_MODE,
    cell: (row) => {
      if (sheet === null) return null;
      const problem = rowProblem(sheet, row.rowKey);
      if (problem !== null) return { text: t.hits.unusable(problemText(problem)), tone: "error", hover: [problemText(problem)] };
      if (!hits.used) return { text: t.hits.none, tone: "muted", hover: [t.hits.noMatchYet] };
      const h = hits.hits.get(row.rowKey);
      if (!h) return { text: "0", tone: "muted" };
      if (h.ambiguous > 0) return { text: t.hits.widens(h.hits), tone: "warn", hover: [t.hits.widensTitle(h.ambiguous)] };
      return { text: t.hits.count(h.hits) };
    },
  };
}
