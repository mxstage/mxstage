// 子の表の横持ち（1 行 ＝ 1 親、1 列 ＝ 1 項目）。仕様（ASSETSPEC など）を機器ごとに横に並べて読む・直す。
// - データは縦持ちのまま。セルを直すと、対応する縦持ちの行の値の列が変わる（workspace.applyEdits、author:"user"）。
//   差分の色・取り消し・反映・LLM のツールは、縦持ちのときと同じように動く。
// - 縦持ちの行が無い項目のセル（欠け）は灰色で、まだ直せない。同じ項目の行が 2 つ以上あるセルも、どれを直すか
//   決められないので横持ちでは直さない（縦持ちで直す）。
// - 先頭の列は親のキー列と説明（読むだけ。親の値は親のペインで直す）。

import { DataEditor, GridCellKind, type DrawHeaderCallback, type EditListItem, type GridCell, type GridColumn, type GridMouseEventArgs, type GridSelection, type Highlight, type Item, CompactSelection } from "@glideapps/glide-data-grid";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CellEdit, CellValue, ColumnSchema } from "../../shared/model";
import { headerLines } from "../../shared/columnLabel";
import type { ViewKind, Workspace } from "../store";
import type { RowState } from "../store/sheet";
import { TONE_STYLE, cellTone, formatColumnValue, hoverLines, isCellEditable, parseEditedText } from "./cellStyle";
import type { DetailItem } from "./detailItems";
import { CellEditorContext, DATE_EDITOR, type CellEditorTarget } from "./editors";
import { conflictSummary, storeErrorMessage } from "./edits";
import { freezeCountForWidth } from "./layout";
import { gridMessages } from "./messages";
import { buildPivot, pivotCell, type PivotColumn, type PivotRow, type PivotSpec } from "./pivot";
import { RowDetail } from "./RowDetail";
import { GRID_THEME, HEADER_SUB_COLOR, ROW_HEIGHT, ROW_HIGHLIGHT, cellAuthor, useFontsReady } from "./SheetGrid";
import type { GridHeaderInfo } from "./SheetGrid";

export interface PivotGridProps {
  workspace: Workspace;
  sheetName: string;
  view: ViewKind;
  version: number;
  isBusy: () => boolean;
  onMessage: (text: string, tone: "info" | "error") => void;
  spec: PivotSpec;
  /** 行（親）を選んだ（他のペインを連動させるため） */
  onSelectRow?: (row: RowState | null) => void;
  renderHeader?: (h: GridHeaderInfo) => ReactNode;
}

/** 縦持ちの行が無いセル（欠け）の地（layer-01）と文字 */
const MISSING_STYLE = { bg: "#f4f4f4", fg: "#6f6f6f" };
/** 重複・別の列に値がある・単位が混ざっているときの印 */
const WARN_MARK = "⚠ ";
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

export function PivotGrid({ workspace, sheetName, view, version, isBusy, onMessage, spec, onSelectRow, renderHeader }: PivotGridProps) {
  const sheet = workspace.sheets.get(sheetName);
  const t = gridMessages().pivot;
  const [selection, setSelection] = useState<GridSelection>(EMPTY_SELECTION);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [paneWidth, setPaneWidth] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const busy = isBusy();
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

  const value = useCallback((row: RowState, col: string): CellValue => (sheet ? sheet.viewValue(row, col, view) : null), [sheet, view]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const table = useMemo(() => (sheet ? buildPivot(sheet.viewRows(view), spec, value) : { columns: [], rows: [] }), [sheet, view, version, spec, value]);
  // 先頭の列: 親のキー列と説明（読むだけ）
  const labelCols = useMemo<ColumnSchema[]>(() => {
    if (!sheet) return [];
    const keys = new Set(sheet.meta.keyColumns.map((k) => k.toUpperCase()));
    const parentCols = sheet.meta.columns.filter((c) => c.child === undefined);
    const out = parentCols.filter((c) => keys.has(c.name.toUpperCase()));
    const desc = parentCols.find((c) => c.name.toUpperCase() === "DESCRIPTION");
    if (desc !== undefined && !out.includes(desc)) out.push(desc);
    return out;
  }, [sheet, version]);

  const rowsRef = useRef<readonly PivotRow[]>(table.rows);
  rowsRef.current = table.rows;
  const columnsRef = useRef<readonly PivotColumn[]>(table.columns);
  columnsRef.current = table.columns;
  const labelRef = useRef(labelCols);
  labelRef.current = labelCols;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const editingRef = useRef<EditingTarget | null>(null);
  const editorTargetRef = useRef<CellEditorTarget | null>(null);

  // シートを離れるときは編集中の印を消す
  useEffect(
    () => () => {
      if (editingRef.current) workspace.setEditingCell(sheetName, null, null);
      editingRef.current = null;
    },
    [workspace, sheetName],
  );

  /** 横持ちのセル（列の番号から。先頭の親の列なら null） */
  const cellAt = useCallback(
    ([c, r]: Item) => {
      const prow = rowsRef.current[r];
      const column = columnsRef.current[c - labelRef.current.length];
      if (prow === undefined || column === undefined) return null;
      return { prow, column, cell: pivotCell(prow, column, spec, value) };
    },
    [spec, value],
  );

  const gridColumns = useMemo<GridColumn[]>(
    () => [
      ...labelCols.map((c) => ({ id: `p:${c.name}`, title: headerLines(c).main, width: widths[`p:${c.name}`] ?? (c.name.toUpperCase() === "DESCRIPTION" ? 220 : 120) })),
      ...table.columns.map((c) => ({ id: `v:${c.key}`, title: c.attr, width: widths[`v:${c.key}`] ?? 140 })),
    ],
    [labelCols, table.columns, widths],
  );

  // 見出しの 2 段目: 親の列は属性名、項目の列はセクションと単位（混ざっていれば ⚠）
  const subOf = useCallback(
    (id: string): string | null => {
      if (id.startsWith("p:")) {
        const c = labelCols.find((x) => `p:${x.name}` === id);
        return c ? headerLines(c).sub : null;
      }
      const c = table.columns.find((x) => `v:${x.key}` === id);
      if (!c) return null;
      const parts = [c.section !== null ? t.section(c.section) : null, c.units.length > 0 ? `${c.units.length > 1 ? WARN_MARK : ""}${c.units.join(" / ")}` : null].filter((p): p is string => p !== null);
      return parts.length > 0 ? parts.join(" · ") : null;
    },
    [labelCols, table.columns, t],
  );

  const drawHeader = useCallback<DrawHeaderCallback>(
    (args, drawContent) => {
      if (args.column.id === undefined) {
        drawContent();
        return;
      }
      const sub = subOf(args.column.id);
      const { ctx, rect, theme: th, column } = args;
      const midY = rect.y + rect.height / 2;
      const x = rect.x + th.cellHorizontalPadding;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, Math.max(0, rect.width - th.cellHorizontalPadding), rect.height);
      ctx.clip();
      ctx.textBaseline = "middle";
      ctx.fillStyle = args.isSelected ? th.textHeaderSelected : th.textHeader;
      ctx.font = `${th.headerFontStyle} ${th.fontFamily}`;
      ctx.fillText(column.title, x, sub === null ? midY : midY - 8);
      if (sub !== null) {
        ctx.fillStyle = HEADER_SUB_COLOR;
        ctx.font = `400 12px ${th.fontFamily}`;
        ctx.fillText(sub, x, midY + 9);
      }
      ctx.restore();
    },
    [subOf],
  );

  const getCellContent = useCallback(
    (item: Item): GridCell => {
      if (!sheet) return EMPTY_CELL;
      const [c, r] = item;
      const prow = rowsRef.current[r];
      if (prow === undefined) return EMPTY_CELL;
      const label = labelRef.current[c];
      if (label !== undefined) {
        const text = formatColumnValue(label, sheet.viewValue(prow.parent, label.name, view));
        return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: true, readonly: true, themeOverride: { bgCell: TONE_STYLE.normal.bg, textDark: TONE_STYLE.normal.fg } };
      }
      const at = cellAt(item);
      if (at === null) return EMPTY_CELL;
      const { cell } = at;
      if (cell.row === null) {
        return { kind: GridCellKind.Text, data: "", displayData: "", allowOverlay: false, readonly: true, themeOverride: { bgCell: MISSING_STYLE.bg, textDark: MISSING_STYLE.fg } };
      }
      const row = cell.row;
      const changed = view !== "base" && sheet.isCellChanged(row, cell.valueCol);
      const protectedColumn = sheet.isProtectedColumn(cell.valueCol);
      const tone = cellTone({ view, rowStatus: sheet.rowStatus(row), changed, author: cellAuthor(row, cell.valueCol), protectedColumn });
      const editable = cell.count === 1 && isCellEditable({ view, rowStatus: sheet.rowStatus(row), protectedColumn, busy });
      const text = formatColumnValue(sheet.column(cell.valueCol), value(row, cell.valueCol));
      const style = TONE_STYLE[tone];
      const warn = cell.count > 1 || cell.otherColumn;
      return {
        kind: GridCellKind.Text,
        data: text,
        displayData: warn ? `${WARN_MARK}${text}` : text,
        allowOverlay: true,
        readonly: !editable,
        themeOverride: { bgCell: style.bg, textDark: style.fg },
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheet, view, busy, version, cellAt, value],
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
      let skipped = 0;
      for (const it of items) {
        if (it.value.kind !== GridCellKind.Text) continue;
        const v = parseEditedText(it.value.data);
        if (items.length === 1 && editing && editing.index[0] === it.location[0] && editing.index[1] === it.location[1]) {
          edits.push({ rowKey: editing.rowKey, col: editing.col, value: v });
          continue;
        }
        const at = cellAt(it.location);
        // 親の列・欠け・重複のセルには書かない
        if (at === null || at.cell.row === null || at.cell.count !== 1) {
          if (it.location[0] >= labelRef.current.length) skipped++;
          continue;
        }
        edits.push({ rowKey: at.cell.row.rowKey, col: at.cell.valueCol, value: v });
      }
      if (skipped > 0) onMessage(t.skipped(skipped), "info");
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
    [sheet, sheetName, workspace, isBusy, onMessage, cellAt, t],
  );

  // 編集を開いた時点の行と列を覚える（開いている間に LLM が行を増減しても、別の行に書かないため）
  const provideEditor = useCallback(
    (cell: GridCell) => {
      const cur = selectionRef.current.current?.cell;
      if (sheet && cur && cell.kind === GridCellKind.Text && !cell.readonly && !isBusy()) {
        const at = cellAt(cur);
        if (at !== null && at.cell.row !== null) {
          editingRef.current = { index: [cur[0], cur[1]], rowKey: at.cell.row.rowKey, col: at.cell.valueCol };
          workspace.setEditingCell(sheetName, at.cell.row.rowKey, at.cell.valueCol);
          const col = sheet.column(at.cell.valueCol);
          if (col && (col.type === "date" || col.type === "datetime")) {
            editorTargetRef.current = { col, originalText: formatColumnValue(col, sheet.finalValue(at.cell.row, at.cell.valueCol)) };
            return DATE_EDITOR;
          }
        }
      }
      editorTargetRef.current = null;
      return undefined;
    },
    [sheet, sheetName, workspace, isBusy, cellAt],
  );

  const onFinishedEditing = useCallback(() => {
    const finished = editingRef.current;
    workspace.setEditingCell(sheetName, null, null);
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
      const at = cellAt(args.location);
      if (at === null) {
        setHover(null);
        return;
      }
      const { column, cell } = at;
      const lines: string[] = [column.section === null ? column.attr : `${column.attr}（${t.section(column.section)}）`];
      if (column.units.length > 0) lines.push(column.units.length > 1 ? t.mixedUnits(column.units.join(" / ")) : t.units(column.units[0] as string));
      if (cell.row === null) {
        lines.push(t.missing);
      } else {
        lines.push(t.valueColumn(cell.valueCol));
        if (cell.otherColumn) lines.push(t.otherColumn(cell.valueCol, column.valueCol));
        if (cell.count > 1) lines.push(t.duplicate(cell.count));
        const changed = view !== "base" && sheet.isCellChanged(cell.row, cell.valueCol);
        const tone = cellTone({ view, rowStatus: sheet.rowStatus(cell.row), changed, author: cellAuthor(cell.row, cell.valueCol), protectedColumn: sheet.isProtectedColumn(cell.valueCol) });
        const info = tone === "user" || tone === "llm" ? workspace.cell(sheetName, cell.row.rowKey, cell.valueCol) : null;
        const extra = hoverLines({ tone, author: info?.author ?? cellAuthor(cell.row, cell.valueCol), reason: info?.reason ?? null, before: sheet.baseValue(cell.row, cell.valueCol), after: sheet.finalValue(cell.row, cell.valueCol) });
        if (extra) lines.push(...extra);
      }
      setHover({ x: args.bounds.x, y: args.bounds.y + args.bounds.height, lines });
    },
    [sheet, sheetName, view, workspace, cellAt, t],
  );

  const selectedRowIndex = selection.current?.cell[1];
  const highlightRegions = useMemo<readonly Highlight[] | undefined>(
    () => (selectedRowIndex === undefined || gridColumns.length === 0 ? undefined : [{ color: ROW_HIGHLIGHT, range: { x: 0, y: selectedRowIndex, width: gridColumns.length, height: 1 }, style: "no-outline" }]),
    [selectedRowIndex, gridColumns.length],
  );

  if (!sheet) return null;

  // 選んだ行（親）の項目を縦に並べる
  const selectedRow = selectedRowIndex === undefined ? null : (table.rows[selectedRowIndex] ?? null);
  const detailItems: DetailItem[] =
    selectedRow === null
      ? []
      : table.columns.map((column) => {
          const cell = pivotCell(selectedRow, column, spec, value);
          const text = cell.row === null ? "" : formatColumnValue(sheet.column(cell.valueCol), value(cell.row, cell.valueCol));
          const changed = cell.row !== null && view !== "base" && sheet.isCellChanged(cell.row, cell.valueCol);
          const author = changed && cell.row !== null ? cellAuthor(cell.row, cell.valueCol) : null;
          return { name: column.key, label: column.section === null ? column.attr : `${column.attr}（${column.section}）`, attr: null, value: text, changed, ...(author ? { author } : {}), long: false, empty: text === "" };
        });
  const detailTitle = selectedRow === null ? "" : labelCols.map((c) => formatColumnValue(c, sheet.viewValue(selectedRow.parent, c.name, view))).filter((v) => v !== "").join(" / ");
  const tooltipLeft = hover ? Math.max(4, Math.min(hover.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 364)) : 0;

  return (
    <div className="grid-wrap" ref={wrapRef} onMouseLeave={() => setHover(null)}>
      {renderHeader?.({
        rowCount: t.size(table.rows.length, table.columns.length),
        rowCountTitle: t.sizeTitle,
        detailOpen: showDetail,
        toggleDetail: () => setShowDetail((s) => !s),
      })}
      <div className="grid-body">
        <CellEditorContext.Provider value={editorTargetRef}>
          <DataEditor
            columns={gridColumns}
            rows={table.rows.length}
            freezeColumns={freezeCountForWidth(paneWidth, labelCols.length)}
            headerHeight={48}
            drawHeader={drawHeader}
            rowHeight={ROW_HEIGHT}
            verticalBorder={false}
            highlightRegions={highlightRegions}
            getCellContent={getCellContent}
            cellActivationBehavior="double-click"
            onCellsEdited={onCellsEdited}
            onPaste={true}
            provideEditor={provideEditor}
            onFinishedEditing={onFinishedEditing}
            onItemHovered={onItemHovered}
            gridSelection={selection}
            onGridSelectionChange={(s) => {
              setSelection(s);
              const cell = s.current?.cell;
              onSelectRow?.(cell ? (rowsRef.current[cell[1]]?.parent ?? null) : null);
            }}
            onColumnResize={(column, size) => {
              const id = column.id ?? column.title;
              setWidths((w) => ({ ...w, [id]: size }));
            }}
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
        (selectedRow === null ? <div className="row-detail hint muted small">{t.detailHint}</div> : <RowDetail title={detailTitle} items={detailItems} />)}
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
