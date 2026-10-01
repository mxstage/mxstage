// シートのグリッド（Glide Data Grid）。canvas で描くので、色分けなどは純関数（cellStyle.ts）で試験する。
// - 直接編集は workspace.applyEdits（author:"user"）。貼り付けは Glide が 1 回の onCellsEdited にまとめるので 1 バッチになる。
// - エディタを開いた・閉じたことを workspace.setEditingCell に知らせる（LLM の変更がそのセルを上書きしないように）。
// - エディタを開いた時点の行キーを覚え、確定時にはその行へ書く（開いている間に LLM が行を増減しても別の行に書かないため）。
// - 日付・日時の列は読みやすい形で出し、カレンダー付きの入力で直す。値の一覧がある列は一覧から選ぶ（editors.tsx・valueLists.ts）。
//   真偽値の列はチェックボックス（押す・空白で切り替え、1/0・y/n で入れる）。どれもストアの applyEdits（author:"user"）を通る。

import {
  BooleanEmpty,
  CompactSelection,
  DataEditor,
  GridCellKind,
  type CellClickedEventArgs,
  type DrawCellCallback,
  type DrawHeaderCallback,
  type EditListItem,
  type GridCell,
  type GridColumn,
  type GridKeyEventArgs,
  type GridMouseEventArgs,
  type GridSelection,
  type Highlight,
  type Item,
  type Theme,
} from "@glideapps/glide-data-grid";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { BatchAuthor, CellEdit, CellValue, ColumnSchema } from "../../shared/model";
import type { ValueListService } from "../maximo/valueList";
import type { ViewKind, Workspace } from "../store";
import type { RowState } from "../store/sheet";
import { TONE_STYLE, cellTone, formatCellValue, formatColumnValue, hoverLines, isCellEditable, parseEditedText } from "./cellStyle";
import { CellEditorContext, DATE_EDITOR, LIST_EDITOR, booleanFromKey, booleanFromText, type CellEditorTarget, type CellListSource } from "./editors";
import { masterListFor, maximoListTarget, mayHaveMaximoList } from "./valueLists";
import { ColumnFilterBar, ColumnFilterMenu, useColumnOptions } from "./ColumnFilterBar";
import { headerLines } from "../../shared/columnLabel";
import { conflictSummary, storeErrorMessage } from "./edits";
import { gridMessages } from "./messages";
import { applyGridFilters, changeCounts, matchRange, rowCountLabel, setFilter, type ChangeKind, type GridFilter } from "./filters";
import { defaultColumnWidth, freezeCountForWidth, frozenColumnsFor, headerHeightFor, orderForFreeze, togglePinned } from "./layout";
import { scopeColumns, scopeRows, type PaneScope } from "../pages/panes";
import { RowDetail } from "./RowDetail";
import { longCellLines, rowDetailItems } from "./detailItems";
import { clampSelection, isReclickOnSelected, singleSelectedCell } from "./selection";

export interface SheetGridProps {
  workspace: Workspace;
  sheetName: string;
  view: ViewKind;
  /** 変更通知ごとに増える（再描画のきっかけ） */
  version: number;
  /** 反映中のシートか（編集の直前にも確かめる） */
  isBusy: () => boolean;
  onMessage: (text: string, tone: "info" | "error") => void;
  /** このペインに出す範囲（親の列だけ／子の列だけ）。省略時はシート全体 */
  scope?: PaneScope;
  /** 他のペインで選ばれた行に連動して絞る */
  linkFilter?: LinkFilter | null;
  /** 行を選んだ（他のペインを連動させるため） */
  onSelectRow?: (row: RowState | null) => void;
  /** ペインの見出し（行数と行の詳細の開閉はこのグリッドの中の状態なので、ここから渡す） */
  renderHeader?: (h: GridHeaderInfo) => ReactNode;
  /** Maximo の値の一覧（getlist）。無ければ一覧は引いて読み込んだマスタのシートからだけ出す */
  valueLists?: ValueListService;
}

export interface GridHeaderInfo {
  /** 「25 行」または「1 / 12」 */
  rowCount: string;
  rowCountTitle: string;
  detailOpen: boolean;
  toggleDetail: () => void;
}

/** 連動の条件: 同じ親の行だけ、またはある列がこの値の行だけ */
export type LinkFilter = { kind: "parent"; parentKey: string } | { kind: "value"; col: string; value: string };

// Carbon（White テーマ）の色。canvas には CSS の変数が届かないので値で持つ（docs/design.md に対応表がある）
/** 書体の並び（styles/carbon.scss の --mx-font-sans と同じ） */
const FONT_SANS = "'IBM Plex Sans', 'IBM Plex Sans JP', system-ui, -apple-system, 'Segoe UI', sans-serif";
const GRID_THEME: Partial<Theme> = {
  // interactive（blue 60）
  accentColor: "#0f62fe",
  accentLight: "rgba(15, 98, 254, 0.10)",
  accentFg: "#ffffff",
  fontFamily: FONT_SANS,
  // body-compact-01 / heading-compact-01 / label-01（行番号）
  baseFontStyle: "14px",
  headerFontStyle: "600 14px",
  markerFontStyle: "12px",
  editorFontSize: "14px",
  cellHorizontalPadding: 8,
  // 選んだ範囲の枠も角を四角にする
  roundingRadius: 0,
  bgCell: "#ffffff",
  // DataTable の見出しと同じ（layer-accent-01 / hover / gray 30）
  bgHeader: "#e0e0e0",
  bgHeaderHovered: "#d1d1d1",
  bgHeaderHasFocus: "#c6c6c6",
  // 行の間の罫線（border-subtle-00。縦の罫線は引かない。DataEditor の verticalBorder）
  borderColor: "#e0e0e0",
  horizontalBorderColor: "#e0e0e0",
  headerBottomBorderColor: "#c6c6c6",
  // text-primary / text-secondary / text-helper
  textDark: "#161616",
  textMedium: "#525252",
  textHeader: "#161616",
  textLight: "#6f6f6f",
  textHeaderSelected: "#ffffff",
  linkColor: "#0f62fe",
  resizeIndicatorColor: "#0f62fe",
};

/** 列の見出しの 2 段目（属性名）と ▾ の色（text-secondary） */
const HEADER_SUB_COLOR = "#525252";
/** 絞り込み中の列の見出し（地・文字・漏斗の印。blue 20 / blue 80 / blue 60） */
const FILTERED_HEADER_BG = "#d0e2ff";
const FILTERED_HEADER_FG = "#002d9c";
const FILTERED_MARK = "#0f62fe";
/** 「文字を含む」で当たった部分の印（blue 60 を薄く重ね、blue 70 の下線を引く） */
const MATCH_FILL = "rgba(15, 98, 254, 0.20)";
const MATCH_LINE = "#0043ce";
/** 選んだセルと同じ行の塗り（DataTable の選んだ行と同じ灰色。利用者の変更の青と紛れないように） */
const ROW_HIGHLIGHT = "rgba(141, 141, 141, 0.20)";
/** 行の高さ（Carbon の DataTable の sm） */
const ROW_HEIGHT = 32;

/** 見出しの印（Carbon の chevron--down 16px と filter 32px のパス）。Path2D が無い環境（試験）では作らない */
const CHEVRON_DOWN_16 = "M8 11 3 6 3.7 5.3 8 9.6 12.3 5.3 13 6z";
const FILTER_32 =
  "M18,28H14a2,2,0,0,1-2-2V18.41L4.59,11A2,2,0,0,1,4,9.59V6A2,2,0,0,1,6,4H26a2,2,0,0,1,2,2V9.59A2,2,0,0,1,27.41,11L20,18.41V26A2,2,0,0,1,18,28ZM6,6V9.59l8,8V26h4V17.59l8-8V6Z";
let headerIcons: { chevron: Path2D; filter: Path2D } | null = null;
function headerIconPaths(): { chevron: Path2D; filter: Path2D } | null {
  if (headerIcons === null && typeof Path2D !== "undefined") headerIcons = { chevron: new Path2D(CHEVRON_DOWN_16), filter: new Path2D(FILTER_32) };
  return headerIcons;
}
/** 見出しの印の大きさ（px） */
const HEADER_ICON = 16;

/**
 * canvas は書体を読み終えても描き直さないので、読み終えたら数を増やして描き直させる（最初の描画は OS の字体になりうる）。
 * document.fonts が無い環境（試験）では何もしない
 */
function useFontsReady(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const fonts = (typeof document === "undefined" ? undefined : (document as { fonts?: FontFaceSet }).fonts) ?? undefined;
    if (!fonts || typeof fonts.load !== "function") return undefined;
    let alive = true;
    const sample = "あA";
    void Promise.all([fonts.load(`400 14px ${FONT_SANS}`, sample), fonts.load(`600 14px ${FONT_SANS}`, sample), fonts.load(`400 12px ${FONT_SANS}`, sample)])
      .catch(() => undefined)
      .then(() => {
        if (alive) setEpoch((n) => n + 1);
      });
    return () => {
      alive = false;
    };
  }, []);
  return epoch;
}
/**
 * 選んでいたセルをもう一度押してから選択を外すまでの待ち。この間に 2 回目が来ればダブルクリック（編集を開く）として扱う
 * （Glide は 500ms 以内の 2 回目をダブルクリックとみなすが、それだけ待つと外れるのが遅く感じる）
 */
const RECLICK_DELAY_MS = 250;

const EMPTY_ROWS: readonly RowState[] = [];
const EMPTY_COLUMNS: readonly ColumnSchema[] = [];
const EMPTY_CELL: GridCell = { kind: GridCellKind.Text, data: "", displayData: "", allowOverlay: false, readonly: true };
const EMPTY_SELECTION: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };

interface EditingTarget {
  index: Item;
  rowKey: string;
  col: string;
}

interface HoverState {
  x: number;
  y: number;
  lines: string[];
}

/** セルを最後に変えた作者（削除行は削除した作者、追加行は追加した作者） */
function cellAuthor(row: RowState, col: string): BatchAuthor | null {
  if (row.deleted) return row.deleted.author;
  return row.cells?.get(col)?.author ?? row.added?.author ?? null;
}

function batchReason(workspace: Workspace, sheet: string, batchId: string): string | null {
  return workspace.listBatches(sheet).find((b) => b.batchId === batchId)?.reason ?? null;
}

/** 真偽値の列のセルの値。読めない値は undefined（そのときは文字のセルで出す） */
function booleanCellData(v: CellValue): boolean | null | undefined {
  if (v === true || v === false) return v;
  if (v === null || v === "") return null;
  return booleanFromText(String(v));
}

export function SheetGrid({ workspace, sheetName, view, version, isBusy, onMessage, scope, linkFilter, onSelectRow, renderHeader, valueLists }: SheetGridProps) {
  const sheet = workspace.sheets.get(sheetName);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [selection, setSelection] = useState<GridSelection>(EMPTY_SELECTION);
  const [hover, setHover] = useState<HoverState | null>(null);
  // 選んだ行の全列を縦に読む（列が多いとき・長文のセル・画面が狭いとき）
  const [showDetail, setShowDetail] = useState(false);
  // 表の幅。狭いときは固定列を外す（固定列だけが見えて中身が読めなくなるのを防ぐ）
  const [paneWidth, setPaneWidth] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const busy = isBusy();
  // 書体を読み終えたら theme を作り直す（Glide は theme が変わると描き直す）
  const fontEpoch = useFontsReady();
  const theme = useMemo(() => ({ ...GRID_THEME }), [fontEpoch]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    setPaneWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setPaneWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 列ごとの絞り込み（読み込んだシートの中だけ。Maximo へは問い合わせ直さない）
  const [filters, setFilters] = useState<readonly GridFilter[]>([]);
  const [menu, setMenu] = useState<{ col: string; x: number; y: number } | null>(null);
  // 利用者が選んだ固定の列（null は自動: キー列のうち行を見分ける列）
  const [pinned, setPinned] = useState<string[] | null>(null);
  const paneScope: PaneScope = scope ?? { kind: "all" };
  // 画面に出す文字（日付は読みやすい形）。絞り込み・行の詳細もこれを使う
  const displayValue = useCallback((row: RowState, col: string) => (sheet ? formatColumnValue(sheet.column(col), sheet.viewValue(row, col, view)) : ""), [sheet, view]);
  // 連動は値そのもので比べる（AppPage は選んだ行の値を formatCellValue で渡す）
  const rawValue = useCallback((row: RowState, col: string) => (sheet ? formatCellValue(sheet.viewValue(row, col, view)) : ""), [sheet, view]);
  const scopedRows = useMemo(() => (sheet ? scopeRows(sheet.viewRows(view), paneScope) : EMPTY_ROWS), [sheet, view, version, paneScope.kind, (paneScope as { name?: string }).name]);
  // シートの並びのままの列（行の詳細はこの順で出す）
  const scopedColumns = useMemo(
    () => (sheet ? scopeColumns(sheet.meta.columns, sheet.meta.keyColumns, paneScope) : EMPTY_COLUMNS),
    [sheet, version, paneScope.kind, (paneScope as { name?: string }).name],
  );
  // 固定する列（WONUM・ASSETNUM・TICKETID など）を先頭に寄せる。サイト・クラスのような範囲のキー列は固定せず、元の並びで残す
  const frozen = useMemo(() => {
    const present = new Set(scopedColumns.map((c) => c.name));
    return frozenColumnsFor(sheet?.meta.keyColumns ?? [], pinned).filter((n) => present.has(n));
  }, [scopedColumns, sheet, pinned]);
  const { columns, freeze } = useMemo(() => orderForFreeze(scopedColumns, frozen), [scopedColumns, frozen]);
  // 他のペインで選ばれた行に連動して絞る（連動は絞り込みの札には出さない）
  const allRows = useMemo(() => {
    if (!linkFilter) return scopedRows;
    if (linkFilter.kind === "parent") return scopedRows.filter((r) => r.parentKey === linkFilter.parentKey);
    return scopedRows.filter((r) => rawValue(r, linkFilter.col) === linkFilter.value);
  }, [scopedRows, linkFilter, rawValue]);
  // セルの変更の状態（色分けと同じ区分）。元の値ビューでも、絞り込みは変更の有無で行う
  const changeOf = useCallback(
    (row: RowState, col: string): ChangeKind => {
      if (!sheet) return "none";
      const status = sheet.rowStatus(row);
      if (status === "deleted") return "deleted";
      if (status === "added") return "added";
      if (sheet.isCellChanged(row, col)) return cellAuthor(row, col) === "llm" ? "llm" : "user";
      return "none";
    },
    [sheet],
  );
  const rows = useMemo(() => applyGridFilters(allRows, filters, displayValue, changeOf), [allRows, filters, displayValue, changeOf, version]);
  const menuOptions = useColumnOptions(allRows, menu?.col ?? null, displayValue);
  const menuChanges = useMemo(() => (menu === null ? [] : changeCounts(allRows, menu.col, changeOf)), [allRows, menu, changeOf, version]);
  // シートを切り替えたら絞り込みは持ち越さない（列が違う）
  useEffect(() => {
    setFilters([]);
    setMenu(null);
    setPinned(null);
  }, [sheetName]);
  // LLM が行を消した直後は、選択が無くなった行を指しうる。今の行数・列数に収めてから使う
  const safeSelection = useMemo(() => clampSelection(selection, rows.length, columns.length), [selection, rows.length, columns.length]);
  // コールバックからは描画した時点の行・列を参照する（利用者が見ている並びと一致させる）
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const selectionRef = useRef(safeSelection);
  selectionRef.current = safeSelection;
  const editingRef = useRef<EditingTarget | null>(null);
  // 開いている編集部品に渡す情報（列・開いたときの表示・値の一覧）
  const editorTargetRef = useRef<CellEditorTarget | null>(null);
  // 押す前に 1 マスだけ選んでいたセル（同じセルをもう一度押したら選択を外すため）
  const pressedOnRef = useRef<readonly [number, number] | null>(null);
  const deselectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSelectRowRef = useRef(onSelectRow);
  onSelectRowRef.current = onSelectRow;
  const cancelDeselect = useCallback(() => {
    if (deselectTimerRef.current !== null) clearTimeout(deselectTimerRef.current);
    deselectTimerRef.current = null;
  }, []);
  useEffect(() => cancelDeselect, [cancelDeselect]);

  // 選んでいたセルをもう一度押したら、選択を外す（行の塗りと、他のペインの連動も外れる）。
  // ダブルクリック（編集を開く）の 1 回目と区別するため、少し待ってから外す
  const onCellClicked = useCallback(
    (cell: Item, args: CellClickedEventArgs) => {
      cancelDeselect();
      const before = pressedOnRef.current;
      pressedOnRef.current = null;
      if (cell[0] < 0 || !isReclickOnSelected({ before, cell, shiftKey: args.shiftKey, ctrlKey: args.ctrlKey, metaKey: args.metaKey, button: args.button, isDoubleClick: args.isDoubleClick === true })) return;
      deselectTimerRef.current = setTimeout(() => {
        deselectTimerRef.current = null;
        // 待っている間に別のセルへ動いていたら外さない
        const now = singleSelectedCell(selectionRef.current);
        if (now === null || now[0] !== cell[0] || now[1] !== cell[1]) return;
        setSelection(EMPTY_SELECTION);
        onSelectRowRef.current?.(null);
      }, RECLICK_DELAY_MS);
    },
    [cancelDeselect],
  );

  // シートを離れるときは編集中の印を消す
  useEffect(
    () => () => {
      if (editingRef.current) workspace.setEditingCell(sheetName, null, null);
      editingRef.current = null;
    },
    [workspace, sheetName],
  );

  const gridColumns = useMemo<GridColumn[]>(
    () =>
      columns.map((c) => {
        const width = widths[c.name] ?? defaultColumnWidth(c);
        // 見出しは日本語ラベル（属性名は drawHeader で下に小さく出す）。▾ から列ごとの絞り込みを開く。
        // 読み取り専用の列は見出しに印を付けず、セルの文字の薄さで示す
        return { id: c.name, title: headerLines(c).main, width, hasMenu: true };
      }),
    [columns, widths],
  );

  // 見出しの 2 段目（属性名）。ラベルだけでは Maximo のどの属性か分からないので添える
  const subLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of columns) {
      const { sub } = headerLines(c);
      if (sub !== null) m.set(c.name, sub);
    }
    return m;
  }, [columns]);
  // 絞り込みがかかっている列（見出しの色を変え、「文字を含む」は当たった部分に印を付ける）
  const filterByCol = useMemo(() => new Map(filters.map((f) => [f.col, f] as const)), [filters]);

  // 見出しは自前で描く: 上の行にラベル、下の行に属性名、右端に ▾（絞り込みを開けることを常に見せる）。
  // 絞り込み中の列は地を塗り、▾ の代わりに漏斗の印を出す（どの列で絞っているかを表の上でも分かるように）
  const drawHeader = useCallback<DrawHeaderCallback>(
    (args, drawContent) => {
      // 行番号の列は Glide に任せる
      if (args.column.id === undefined) {
        drawContent();
        return;
      }
      const sub = subLabels.get(args.column.id);
      const filtered = filterByCol.has(args.column.id);
      const { ctx, rect, theme, column } = args;
      const pad = theme.cellHorizontalPadding;
      const midY = rect.y + rect.height / 2;
      const x = rect.x + pad;
      if (filtered) {
        ctx.save();
        ctx.fillStyle = FILTERED_HEADER_BG;
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height - 1);
        ctx.restore();
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, Math.max(0, rect.width - pad - HEADER_ICON - 4), rect.height);
      ctx.clip();
      ctx.textBaseline = "middle";
      ctx.fillStyle = filtered ? FILTERED_HEADER_FG : args.isSelected ? theme.textHeaderSelected : theme.textHeader;
      ctx.font = `${theme.headerFontStyle} ${theme.fontFamily}`;
      ctx.fillText(column.title, x, sub === undefined ? midY : midY - 8);
      if (sub !== undefined) {
        // label-01（12px・字間 0.32px）
        ctx.fillStyle = HEADER_SUB_COLOR;
        ctx.font = `400 12px ${theme.fontFamily}`;
        if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0.32px";
        ctx.fillText(sub, x, midY + 9);
      }
      ctx.restore();
      // ▾（chevron--down）か、絞り込み中なら漏斗（filter）。どちらも Carbon のアイコンの形を 16px で塗る
      const icons = headerIconPaths();
      if (icons === null) return;
      ctx.save();
      ctx.translate(rect.x + rect.width - pad - HEADER_ICON, midY - HEADER_ICON / 2);
      if (filtered) {
        ctx.fillStyle = FILTERED_MARK;
        ctx.scale(HEADER_ICON / 32, HEADER_ICON / 32);
        ctx.fill(icons.filter);
      } else {
        ctx.fillStyle = HEADER_SUB_COLOR;
        ctx.fill(icons.chevron);
      }
      ctx.restore();
    },
    [subLabels, filterByCol],
  );

  // セルに描き足す: 「文字を含む」で当たった部分の印と、削除行の取り消し線（セルの themeOverride だけでは描けない）
  const drawCell = useCallback<DrawCellCallback>(
    (args, drawContent) => {
      drawContent();
      if (!sheet || args.cell.kind !== GridCellKind.Text) return;
      const text = args.cell.displayData.split("\n")[0] ?? "";
      if (text === "") return;
      const { ctx, rect, theme } = args;
      const pad = theme.cellHorizontalPadding;
      const maxX = rect.x + rect.width - pad;
      const filter = filterByCol.get(columnsRef.current[args.col]?.name ?? "");
      if (filter?.kind === "contains") {
        const hit = matchRange(text, filter.text);
        if (hit !== null) {
          ctx.save();
          ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`;
          const x0 = rect.x + pad + ctx.measureText(text.slice(0, hit.start)).width;
          const x1 = Math.min(maxX, x0 + ctx.measureText(text.slice(hit.start, hit.end)).width);
          if (x0 < maxX) {
            const h = 20;
            const top = Math.round(rect.y + (rect.height - h) / 2);
            ctx.fillStyle = MATCH_FILL;
            ctx.fillRect(x0, top, x1 - x0, h);
            ctx.fillStyle = MATCH_LINE;
            ctx.fillRect(x0, top + h - 2, x1 - x0, 2);
          }
          ctx.restore();
        }
      }
      if (view === "base") return;
      const row = rowsRef.current[args.row];
      if (!row || sheet.rowStatus(row) !== "deleted") return;
      ctx.save();
      ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`;
      const width = Math.min(ctx.measureText(text).width, rect.width - pad * 2);
      const y = Math.round(rect.y + rect.height / 2) + 0.5;
      ctx.strokeStyle = TONE_STYLE.deleted.fg;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rect.x + pad, y);
      ctx.lineTo(rect.x + pad + Math.max(0, width), y);
      ctx.stroke();
      ctx.restore();
    },
    [sheet, view, filterByCol],
  );

  const getCellContent = useCallback(
    ([c, r]: Item): GridCell => {
      const row = rowsRef.current[r];
      const col = columnsRef.current[c];
      if (!sheet || !row || !col) return EMPTY_CELL;
      const name = col.name;
      const status = sheet.rowStatus(row);
      const changed = view !== "base" && sheet.isCellChanged(row, name);
      const protectedColumn = sheet.isProtectedColumn(name);
      const tone = cellTone({ view, rowStatus: status, changed, author: cellAuthor(row, name), protectedColumn });
      const editable = isCellEditable({ view, rowStatus: status, protectedColumn, busy });
      const value = sheet.viewValue(row, name, view);
      const style = TONE_STYLE[tone];
      if (col.type === "boolean") {
        // チェックボックス（押す・空白で切り替え）。読めない値は文字のまま出す
        const b = booleanCellData(value);
        if (b !== undefined) {
          return {
            kind: GridCellKind.Boolean,
            data: b ?? BooleanEmpty,
            allowOverlay: false,
            readonly: !editable,
            contentAlign: "left",
            themeOverride: { bgCell: style.bg, textDark: style.fg },
          };
        }
      }
      const text = formatColumnValue(col, value);
      return {
        kind: GridCellKind.Text,
        data: text,
        displayData: text,
        // 読み取り専用でも開けるようにする（工事内容のような長文・改行を全文読むため）
        allowOverlay: true,
        readonly: !editable,
        themeOverride: { bgCell: style.bg, textDark: style.fg },
      };
    },
    // version: ストアの変更で内容が変わったことを Glide に伝えるため、関数を作り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheet, view, busy, version],
  );

  const onCellsEdited = useCallback(
    (items: readonly EditListItem[]): boolean => {
      if (!sheet) return true;
      if (isBusy()) {
        onMessage(gridMessages().sheetGrid.busy, "error");
        return true;
      }
      const editing = editingRef.current;
      const edits: CellEdit[] = [];
      for (const it of items) {
        let value: CellValue;
        if (it.value.kind === GridCellKind.Text) value = parseEditedText(it.value.data);
        else if (it.value.kind === GridCellKind.Boolean) value = it.value.data === true ? true : it.value.data === false ? false : null;
        else continue;
        const [c, r] = it.location;
        let rowKey: string | undefined;
        let col: string | undefined;
        if (items.length === 1 && editing && editing.index[0] === c && editing.index[1] === r) {
          rowKey = editing.rowKey;
          col = editing.col;
        } else {
          rowKey = rowsRef.current[r]?.rowKey;
          col = columnsRef.current[c]?.name;
        }
        if (rowKey === undefined || col === undefined) continue;
        edits.push({ rowKey, col, value });
      }
      if (edits.length === 0) return true;
      try {
        const res = workspace.applyEdits(sheetName, edits, { author: "user", baseRevision: workspace.revision });
        const msg = conflictSummary(res.conflicts);
        if (msg) onMessage(msg, "error");
      } catch (e) {
        onMessage(storeErrorMessage(e), "error");
      }
      return true;
    },
    [sheet, sheetName, workspace, isBusy, onMessage],
  );

  // 値の一覧の出どころ（引いて読み込んだマスタのシート → Maximo の getlist）。一覧が無いと分かっている列は null
  const listSourceFor = useCallback(
    (row: RowState, col: ColumnSchema): CellListSource | null => {
      if (!sheet) return null;
      const master = masterListFor(workspace, sheetName, col.name);
      if (master !== null && master.items.length > 0) return { kind: "master", sheet: master.sheet, items: master.items };
      if (!valueLists || !mayHaveMaximoList(col, sheet.meta.columns)) return null;
      const target = maximoListTarget(sheet, row, col);
      if (target === null) return null;
      const known = valueLists.peek(target.os, target.col);
      if (known?.status === "none") return null;
      return { kind: "maximo", initial: known, load: () => valueLists.load(target) };
    },
    [sheet, sheetName, workspace, valueLists],
  );

  // Glide はエディタを開くときにこれを呼ぶ。開く対象は選択中のセル。
  // 日付・日時の列はカレンダー付きの入力、値の一覧がある列は一覧から選ぶ入力、それ以外は Glide の既定の入力（undefined）
  const provideEditor = useCallback(
    (cell: GridCell) => {
      const cur = selectionRef.current.current?.cell;
      if (sheet && cur && cell.kind === GridCellKind.Text && !cell.readonly && !isBusy()) {
        const row = rowsRef.current[cur[1]];
        const col = columnsRef.current[cur[0]];
        if (row && col) {
          editingRef.current = { index: [cur[0], cur[1]], rowKey: row.rowKey, col: col.name };
          workspace.setEditingCell(sheetName, row.rowKey, col.name);
          const originalText = formatColumnValue(col, sheet.finalValue(row, col.name));
          if (col.type === "date" || col.type === "datetime") {
            editorTargetRef.current = { col, originalText };
            return DATE_EDITOR;
          }
          const list = listSourceFor(row, col);
          if (list !== null) {
            editorTargetRef.current = { col, originalText, list };
            return LIST_EDITOR;
          }
        }
      }
      editorTargetRef.current = null;
      return undefined;
    },
    [sheet, sheetName, workspace, isBusy, listSourceFor],
  );

  // 真偽値の列: 1/t/y で入、0/f/n で切にする（空白は Glide が切り替える）。ほかの文字では切り替えない
  const onKeyDown = useCallback(
    (e: GridKeyEventArgs) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.key === " ") return;
      const cur = selectionRef.current.current?.cell;
      const col = cur ? columnsRef.current[cur[0]] : undefined;
      if (!cur || col?.type !== "boolean") return;
      const cell = getCellContent(cur);
      if (cell.kind !== GridCellKind.Boolean) return;
      e.cancel();
      if (cell.readonly) return;
      const b = booleanFromKey(e.key);
      if (b === null) return;
      onCellsEdited([{ location: cur, value: { ...cell, data: b } }]);
    },
    [getCellContent, onCellsEdited],
  );

  // 真偽値の列に貼り付けた文字（true/false・1/0・Y/N）を値にする。読めない文字では変えない
  const coercePasteValue = useCallback((text: string, cell: GridCell): GridCell | undefined => {
    if (cell.kind !== GridCellKind.Boolean) return undefined;
    const b = booleanFromText(text);
    return { ...cell, data: b === undefined ? cell.data : (b ?? BooleanEmpty) };
  }, []);

  const onFinishedEditing = useCallback(() => {
    const finished = editingRef.current;
    workspace.setEditingCell(sheetName, null, null);
    // onCellsEdited が後から呼ばれても開いた時点の行キーを使えるよう、消すのは現在の処理の後にする
    queueMicrotask(() => {
      if (editingRef.current === finished) editingRef.current = null;
    });
  }, [workspace, sheetName]);

  const onItemHovered = useCallback(
    (args: GridMouseEventArgs) => {
      if (args.kind !== "cell" || !sheet) {
        setHover(null);
        return;
      }
      const [c, r] = args.location;
      const row = rowsRef.current[r];
      const col = columnsRef.current[c];
      if (!row || !col) {
        setHover(null);
        return;
      }
      const name = col.name;
      const changed = view !== "base" && sheet.isCellChanged(row, name);
      const tone = cellTone({ view, rowStatus: sheet.rowStatus(row), changed, author: cellAuthor(row, name), protectedColumn: sheet.isProtectedColumn(name) });
      if (tone === "normal") {
        // 変更も読み取り専用でもない普通のセルでも、長文（工事内容など）は全文を出す。
        // 列幅に収まらない値は、グリッドでは切れて読めないため
        const lines = longCellLines(displayValue(row, name));
        setHover(lines === null ? null : { x: args.bounds.x, y: args.bounds.y + args.bounds.height, lines });
        return;
      }
      let author: BatchAuthor | null = cellAuthor(row, name);
      let reason: string | null = null;
      if (tone === "deleted" && row.deleted) {
        reason = batchReason(workspace, sheetName, row.deleted.batchId);
      } else if (tone !== "readonly") {
        const info = workspace.cell(sheetName, row.rowKey, name);
        author = info?.author ?? author;
        reason = info?.reason ?? null;
      }
      const lines = hoverLines({ tone, author, reason, before: sheet.baseValue(row, name), after: sheet.finalValue(row, name) });
      setHover(lines ? { x: args.bounds.x, y: args.bounds.y + args.bounds.height, lines } : null);
    },
    [sheet, sheetName, view, workspace],
  );

  const onColumnResize = useCallback((column: GridColumn, newSize: number) => {
    const id = column.id ?? column.title;
    setWidths((w) => ({ ...w, [id]: newSize }));
  }, []);

  // 選んだセルと同じ行の他のセルを薄く塗る（どの行を読んでいるか分かるように）
  const selectedRowIndex = safeSelection.current?.cell[1];
  const highlightRegions = useMemo<readonly Highlight[] | undefined>(
    () =>
      selectedRowIndex === undefined || columns.length === 0
        ? undefined
        : [{ color: ROW_HIGHLIGHT, range: { x: 0, y: selectedRowIndex, width: columns.length, height: 1 }, style: "no-outline" }],
    [selectedRowIndex, columns.length],
  );

  if (!sheet) return null;

  const tooltipLeft =hover ? Math.max(4, Math.min(hover.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 364)) : 0;

  const currentFilter = menu === null ? null : (filters.find((f) => f.col === menu.col) ?? null);

  // 選んでいる行（行の詳細に出す）
  const selectedCell = safeSelection.current?.cell;
  const selectedRow = selectedCell ? (rows[selectedCell[1]] ?? null) : null;
  const detailItems =
    selectedRow === null
      ? []
      : rowDetailItems(scopedColumns, (col) => {
          const changed = view !== "base" && sheet.isCellChanged(selectedRow, col);
          return { value: displayValue(selectedRow, col), changed, ...(changed ? { author: cellAuthor(selectedRow, col) } : {}) };
        });
  const detailTitle = selectedRow === null ? "" : (sheet.meta.keyColumns.map((k) => displayValue(selectedRow, k)).filter((v) => v !== "").join(" / ") || selectedRow.rowKey);

  return (
    <div className="grid-wrap" ref={wrapRef} onMouseLeave={() => setHover(null)}>
      {renderHeader?.({
        rowCount: rowCountLabel({ shown: rows.length, total: scopedRows.length, narrowed: filters.length > 0 || Boolean(linkFilter) }),
        rowCountTitle: gridMessages().sheetGrid.rowCountTitle,
        detailOpen: showDetail,
        toggleDetail: () => setShowDetail((s) => !s),
      })}
      <ColumnFilterBar
        filters={filters}
        shown={rows.length}
        total={allRows.length}
        titleOf={(col) => headerLines(columns.find((c) => c.name === col) ?? { name: col }).main}
        onRemove={(col) => setFilters((f) => setFilter(f, null, col))}
        onClearAll={() => setFilters([])}
      />
      <div
        className="grid-body"
        onPointerDownCapture={() => {
          pressedOnRef.current = singleSelectedCell(selectionRef.current);
        }}
      >
      <CellEditorContext.Provider value={editorTargetRef}>
      <DataEditor
        columns={gridColumns}
        rows={rows.length}
        freezeColumns={freezeCountForWidth(paneWidth, freeze)}
        headerHeight={headerHeightFor(columns)}
        drawHeader={drawHeader}
        drawCell={drawCell}
        rowHeight={ROW_HEIGHT}
        verticalBorder={false}
        highlightRegions={highlightRegions}
        onHeaderClicked={(col, args) => {
          // 見出しを押したらその列の絞り込みを開く（▾ の印は hasMenu で出している）
          const name = columnsRef.current[col]?.name;
          if (name === undefined) return;
          args.preventDefault();
          // 画面に固定して出す（ペインの外にはみ出せるように）。右端では左に寄せる
          const width = 260;
          const x = Math.max(4, Math.min(args.bounds.x, (typeof window === "undefined" ? 1200 : window.innerWidth) - width - 8));
          setMenu((m) => (m?.col === name ? null : { col: name, x, y: args.bounds.y + args.bounds.height }));
        }}
        getCellContent={getCellContent}
        onCellClicked={onCellClicked}
        // 選んでいるセルをもう一度押すと選択を外すので、編集はダブルクリック（または Enter・そのまま入力）で開く
        cellActivationBehavior="double-click"
        onCellsEdited={onCellsEdited}
        onPaste={true}
        coercePasteValue={coercePasteValue}
        onKeyDown={onKeyDown}
        provideEditor={provideEditor}
        onFinishedEditing={onFinishedEditing}
        onItemHovered={onItemHovered}
        gridSelection={safeSelection}
        onGridSelectionChange={(s) => {
          setSelection(s);
          // 選んだ行を他のペイン（子・参照先のマスタ）に伝える
          const cell = s.current?.cell;
          onSelectRow?.(cell ? (rowsRef.current[cell[1]] ?? null) : null);
        }}
        onColumnResize={onColumnResize}
        getCellsForSelection={true}
        rowMarkers="number"
        smoothScrollX={true}
        smoothScrollY={true}
        theme={theme}
        width="100%"
        height="100%"
      />
      </CellEditorContext.Provider>
      </div>
      {showDetail &&
        (selectedRow === null ? (
          <div className="row-detail hint muted small">{gridMessages().sheetGrid.detailHint}</div>
        ) : (
          <RowDetail title={detailTitle} items={detailItems} />
        ))}
      {menu &&
        createPortal(
          <ColumnFilterMenu
            col={menu.col}
            options={menuOptions}
            changes={menuChanges}
            current={currentFilter}
            position={{ x: menu.x, y: menu.y }}
            pinned={frozen.includes(menu.col)}
            onTogglePin={() => {
              setPinned(togglePinned(frozen, menu.col));
              setMenu(null);
            }}
            onApply={(f) => {
              setFilters((cur) => setFilter(cur, f, menu.col));
              setMenu(null);
            }}
            onClose={() => setMenu(null)}
          />,
          document.body,
        )}
      {hover && (
        <div className="cell-tooltip" role="tooltip" style={{ left: tooltipLeft, top: hover.y + 4 }}>
          {hover.lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
