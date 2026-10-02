// 子の表の横持ち（1 行 ＝ 1 親、1 列 ＝ 1 項目）。仕様（ASSETSPEC など）を機器ごとに横に並べて読む・直す。
// - データは縦持ちのまま。セルを直すと、対応する縦持ちの行の値の列が変わる（workspace.applyEdits、author:"user"）。
//   差分の色・取り消し・反映・LLM のツールは、縦持ちのときと同じように動く。
// - 読み込んだ「分類の仕様」のシートがあれば、行の無いセルを 2 つに分ける（grid/pivot.ts の pivotCellState）:
//   欠け（その機器の分類にある項目なのに行が無い。黄色）は値を入れると仕様の行を足す（workspace.addRows、author:"user"）。
//   分類に無い項目は灰色で直せない。分類の仕様が無ければ、行の無いセルはすべて灰色で直せない。
// - 同じ項目の行が 2 つ以上あるセルは、どれを直すか決められないので横持ちでは直さない（縦持ちで直す）。
// - 先頭の列は親のキー列と説明（読むだけ。親の値は親のペインで直す）。
// - 列の見出しから縦持ちと同じ絞り込みができる（grid/filters.ts）。欠け・値が空のセルは「空」、分類に無い項目のセルは
//   「（分類に無い）」という値として扱うので、「この項目が欠けている機器だけ」を出せる。

import { DataEditor, GridCellKind, type DrawHeaderCallback, type EditListItem, type GridCell, type GridColumn, type GridMouseEventArgs, type GridSelection, type Highlight, type Item, CompactSelection } from "@glideapps/glide-data-grid";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CellEdit, CellValue, ColumnSchema } from "../../shared/model";
import { headerLines } from "../../shared/columnLabel";
import type { ViewKind, Workspace } from "../store";
import type { RowState } from "../store/sheet";
import { PIVOT_CELL_STYLE, PIVOT_WARN_MARK, TONE_STYLE, cellTone, formatColumnValue, hoverLines, isCellEditable, parseEditedText } from "./cellStyle";
import type { DetailItem } from "./detailItems";
import { CellEditorContext, DATE_EDITOR, type CellEditorTarget } from "./editors";
import { conflictSummary, storeErrorMessage } from "./edits";
import { freezeCountForWidth } from "./layout";
import { gridMessages } from "./messages";
import {
  addClassColumns,
  buildPivot,
  findAttrTypes,
  findClassDefs,
  newSpecRow,
  parentClassColumn,
  pivotCell,
  pivotCellState,
  type PivotClassInfo,
  type PivotColumn,
  type PivotRow,
  type PivotSpec,
} from "./pivot";
import { createPortal } from "react-dom";
import { ColumnFilterBar, ColumnFilterMenu, useColumnOptions } from "./ColumnFilterBar";
import { applyGridFilters, changeCounts, setFilter, type ChangeKind, type GridFilter } from "./filters";
import { RowDetail } from "./RowDetail";
import {
  FILTERED_HEADER_BG,
  FILTERED_HEADER_FG,
  FILTERED_MARK,
  GRID_THEME,
  HEADER_ICON,
  HEADER_SUB_COLOR,
  ROW_HEIGHT,
  ROW_HIGHLIGHT,
  cellAuthor,
  headerIconPaths,
  useFontsReady,
} from "./SheetGrid";
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

/** 行が無く直せないセル（分類に無い項目・分類が分からない）と、欠け（値を入れると行を足す）の色。凡例と同じ */
const NONE_STYLE = PIVOT_CELL_STYLE.none;
const MISSING_STYLE = PIVOT_CELL_STYLE.missing;
/** 重複・別の列に値がある・単位が混ざっているときの印 */
const WARN_MARK = `${PIVOT_WARN_MARK} `;
const EMPTY_CELL: GridCell = { kind: GridCellKind.Text, data: "", displayData: "", allowOverlay: false, readonly: true };
const EMPTY_SELECTION: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };

/** 編集を開いたセル。行があれば行と列、欠けなら親と項目（値を入れると行を足す） */
type EditingTarget = { index: Item; kind: "edit"; rowKey: string; col: string } | { index: Item; kind: "add"; parentKey: string; columnKey: string };

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
  // 分類の仕様（読み込んだシートから）。この表のシートは除く（資産のシートも分類 ID と ASSETSPEC を持つため）
  const classInfo = useMemo<PivotClassInfo | null>(() => {
    if (!sheet) return null;
    const classCol = parentClassColumn(sheet.meta);
    if (classCol === null) return null;
    const others = Array.from(workspace.sheets.values()).filter((x) => x.name !== sheetName);
    const defs = findClassDefs(others);
    return defs === null ? null : { defs, classCol, attrTypes: findAttrTypes(others) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, sheet, sheetName, version]);
  const table = useMemo(() => {
    if (!sheet) return { columns: [], rows: [] };
    const base = buildPivot(sheet.viewRows(view), spec, value);
    return classInfo === null ? base : addClassColumns(base, spec, classInfo, value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, view, version, spec, value, classInfo]);
  // 列ごとの絞り込み（列の ID は 親の列が p:<列名>、項目の列が v:<項目のキー>）
  const [filters, setFilters] = useState<readonly GridFilter[]>([]);
  const [menu, setMenu] = useState<{ col: string; x: number; y: number } | null>(null);
  useEffect(() => {
    setFilters([]);
    setMenu(null);
  }, [sheetName]);
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

  /** 絞り込みに使う文字（画面の表示と同じ。分類に無い項目のセルは「（分類に無い）」） */
  const filterText = useCallback(
    (prow: PivotRow, id: string): string => {
      if (!sheet) return "";
      if (id.startsWith("p:")) {
        const name = id.slice(2);
        return formatColumnValue(sheet.column(name), sheet.viewValue(prow.parent, name, view));
      }
      const column = table.columns.find((c) => `v:${c.key}` === id);
      if (column === undefined) return "";
      const cell = pivotCell(prow, column, spec, value);
      if (cell.row === null) return pivotCellState(prow, column, classInfo, value) === "notInClass" ? t.notInClassValue : "";
      return formatColumnValue(sheet.column(cell.valueCol), value(cell.row, cell.valueCol));
    },
    [sheet, view, table.columns, spec, value, classInfo, t],
  );
  /** 変更の状態（縦持ちの表と同じ区分。行の無いセルは変更なし） */
  const changeOf = useCallback(
    (prow: PivotRow, id: string): ChangeKind => {
      if (!sheet || id.startsWith("p:")) return "none";
      const column = table.columns.find((c) => `v:${c.key}` === id);
      if (column === undefined) return "none";
      const cell = pivotCell(prow, column, spec, value);
      if (cell.row === null) return "none";
      const status = sheet.rowStatus(cell.row);
      if (status === "deleted") return "deleted";
      if (status === "added") return "added";
      if (sheet.isCellChanged(cell.row, cell.valueCol)) return cellAuthor(cell.row, cell.valueCol) === "llm" ? "llm" : "user";
      return "none";
    },
    [sheet, table.columns, spec, value],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shownRows = useMemo(() => applyGridFilters(table.rows, filters, filterText, changeOf), [table.rows, filters, filterText, changeOf, version]);
  const menuOptions = useColumnOptions(table.rows, menu?.col ?? null, filterText);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const menuChanges = useMemo(() => (menu === null ? [] : changeCounts(table.rows, menu.col, changeOf)), [table.rows, menu, changeOf, version]);
  const filterByCol = useMemo(() => new Map(filters.map((f) => [f.col, f] as const)), [filters]);
  const titleOf = useCallback(
    (id: string): string => {
      if (id.startsWith("p:")) {
        const c = labelCols.find((x) => `p:${x.name}` === id);
        return c ? headerLines(c).main : id.slice(2);
      }
      return table.columns.find((c) => `v:${c.key}` === id)?.attr ?? id;
    },
    [labelCols, table.columns],
  );

  const rowsRef = useRef<readonly PivotRow[]>(shownRows);
  rowsRef.current = shownRows;
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
      return { prow, column, cell: pivotCell(prow, column, spec, value), state: pivotCellState(prow, column, classInfo, value) };
    },
    [spec, value, classInfo],
  );

  const gridColumns = useMemo<GridColumn[]>(
    () => [
      ...labelCols.map((c) => ({ id: `p:${c.name}`, title: headerLines(c).main, width: widths[`p:${c.name}`] ?? (c.name.toUpperCase() === "DESCRIPTION" ? 220 : 120), hasMenu: true })),
      ...table.columns.map((c) => ({ id: `v:${c.key}`, title: c.attr, width: widths[`v:${c.key}`] ?? 140, hasMenu: true })),
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
      const filtered = filterByCol.has(args.column.id);
      const { ctx, rect, theme: th, column } = args;
      const pad = th.cellHorizontalPadding;
      const midY = rect.y + rect.height / 2;
      const x = rect.x + pad;
      // 絞り込み中の列は地を塗り、▾ の代わりに漏斗の印（縦持ちの表と同じ）
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
      ctx.fillStyle = filtered ? FILTERED_HEADER_FG : args.isSelected ? th.textHeaderSelected : th.textHeader;
      ctx.font = `${th.headerFontStyle} ${th.fontFamily}`;
      ctx.fillText(column.title, x, sub === null ? midY : midY - 8);
      if (sub !== null) {
        ctx.fillStyle = HEADER_SUB_COLOR;
        ctx.font = `400 12px ${th.fontFamily}`;
        ctx.fillText(sub, x, midY + 9);
      }
      ctx.restore();
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
    [subOf, filterByCol],
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
        // 欠けは値を入れられる（反映中・元の値ビューを除く）。分類に無い・分からないセルは直せない
        if (at.state === "missing") {
          const editable = view !== "base" && !busy;
          return { kind: GridCellKind.Text, data: "", displayData: "", allowOverlay: editable, readonly: !editable, themeOverride: { bgCell: MISSING_STYLE.bg, textDark: MISSING_STYLE.fg } };
        }
        return { kind: GridCellKind.Text, data: "", displayData: "", allowOverlay: false, readonly: true, themeOverride: { bgCell: NONE_STYLE.bg, textDark: NONE_STYLE.fg } };
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
      // 欠けに入れた値は、親ごとに仕様の行を足す（親の行キー → 足す行の値）
      const adds = new Map<string, Array<Record<string, CellValue>>>();
      let skipped = 0;
      const addTo = (prow: PivotRow, column: PivotColumn, v: CellValue) => {
        // 空のまま確定したときは行を足さない
        if (v === null || v === "" || classInfo === null) return;
        const values = newSpecRow(prow, column, spec, classInfo, sheet.meta.columns, v, value);
        if (values === null) {
          skipped++;
          return;
        }
        const list = adds.get(prow.parent.rowKey);
        if (list) list.push(values);
        else adds.set(prow.parent.rowKey, [values]);
      };
      for (const it of items) {
        if (it.value.kind !== GridCellKind.Text) continue;
        const v = parseEditedText(it.value.data);
        if (items.length === 1 && editing && editing.index[0] === it.location[0] && editing.index[1] === it.location[1]) {
          if (editing.kind === "edit") {
            edits.push({ rowKey: editing.rowKey, col: editing.col, value: v });
          } else {
            // 開いた時点の親と項目に足す（開いている間に並びが変わっても別の機器に足さない）
            const prow = rowsRef.current.find((x) => x.parentKey === editing.parentKey);
            const column = columnsRef.current.find((x) => x.key === editing.columnKey);
            if (prow && column && (prow.cells.get(column.key)?.length ?? 0) === 0) addTo(prow, column, v);
            else skipped++;
          }
          continue;
        }
        const at = cellAt(it.location);
        if (at === null) continue;
        if (at.cell.row === null) {
          if (at.state === "missing") addTo(at.prow, at.column, v);
          else if (it.location[0] >= labelRef.current.length) skipped++;
          continue;
        }
        // 重複のセルには書かない
        if (at.cell.count !== 1) {
          skipped++;
          continue;
        }
        edits.push({ rowKey: at.cell.row.rowKey, col: at.cell.valueCol, value: v });
      }
      if (skipped > 0) onMessage(t.skipped(skipped), "info");
      if (edits.length === 0 && adds.size === 0) return true;
      try {
        if (edits.length > 0) {
          const res = workspace.applyEdits(sheetName, edits, { author: "user", baseRevision: workspace.revision });
          const msg = conflictSummary(res.conflicts);
          if (msg) onMessage(msg, "error");
        }
        for (const [parentRowKey, rows] of adds) {
          const res = workspace.addRows(sheetName, rows, { author: "user", parentRowKey, childName: spec.child, baseRevision: workspace.revision, reason: t.addReason });
          const msg = conflictSummary(res.conflicts);
          if (msg) onMessage(msg, "error");
        }
      } catch (e) {
        onMessage(storeErrorMessage(e), "error");
      }
      return true;
    },
    [sheet, sheetName, workspace, isBusy, onMessage, cellAt, t, classInfo, spec, value],
  );

  // 編集を開いた時点の行と列を覚える（開いている間に LLM が行を増減しても、別の行に書かないため）
  const provideEditor = useCallback(
    (cell: GridCell) => {
      const cur = selectionRef.current.current?.cell;
      if (sheet && cur && cell.kind === GridCellKind.Text && !cell.readonly && !isBusy()) {
        const at = cellAt(cur);
        if (at !== null && at.cell.row === null && at.state === "missing") {
          editingRef.current = { index: [cur[0], cur[1]], kind: "add", parentKey: at.prow.parentKey, columnKey: at.column.key };
        }
        if (at !== null && at.cell.row !== null) {
          editingRef.current = { index: [cur[0], cur[1]], kind: "edit", rowKey: at.cell.row.rowKey, col: at.cell.valueCol };
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
        const cls = classInfo === null ? null : sheet.viewValue(at.prow.parent, classInfo.classCol, view);
        if (at.state === "missing") lines.push(t.missingInClass(String(cls)));
        else if (at.state === "notInClass") lines.push(t.notInClass(String(cls)));
        else lines.push(classInfo === null ? t.missingNoClass : t.missing);
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
    [sheet, sheetName, view, workspace, cellAt, t, classInfo],
  );

  const selectedRowIndex = selection.current?.cell[1];
  const highlightRegions = useMemo<readonly Highlight[] | undefined>(
    () => (selectedRowIndex === undefined || gridColumns.length === 0 ? undefined : [{ color: ROW_HIGHLIGHT, range: { x: 0, y: selectedRowIndex, width: gridColumns.length, height: 1 }, style: "no-outline" }]),
    [selectedRowIndex, gridColumns.length],
  );

  if (!sheet) return null;

  // 選んだ行（親）の項目を縦に並べる
  const selectedRow = selectedRowIndex === undefined ? null : (shownRows[selectedRowIndex] ?? null);
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
        rowCount: filters.length > 0 ? t.sizeFiltered(shownRows.length, table.rows.length, table.columns.length) : t.size(table.rows.length, table.columns.length),
        rowCountTitle: t.sizeTitle,
        detailOpen: showDetail,
        toggleDetail: () => setShowDetail((s) => !s),
      })}
      <ColumnFilterBar
        filters={filters}
        shown={shownRows.length}
        total={table.rows.length}
        titleOf={titleOf}
        onRemove={(col) => setFilters((f) => setFilter(f, null, col))}
        onClearAll={() => setFilters([])}
      />
      {classInfo === null && <p className="pivot-hint muted small">{parentClassColumn(sheet.meta) === null ? t.hintNoClassColumn : t.hintNoClassSheet}</p>}
      <div className="grid-body">
        <CellEditorContext.Provider value={editorTargetRef}>
          <DataEditor
            columns={gridColumns}
            rows={shownRows.length}
            onHeaderClicked={(col, args) => {
              // 見出しを押したらその列の絞り込みを開く（縦持ちの表と同じ）
              const id = gridColumns[col]?.id;
              if (id === undefined) return;
              args.preventDefault();
              const width = 260;
              const x = Math.max(4, Math.min(args.bounds.x, (typeof window === "undefined" ? 1200 : window.innerWidth) - width - 8));
              setMenu((m) => (m?.col === id ? null : { col: id, x, y: args.bounds.y + args.bounds.height }));
            }}
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
      {menu &&
        createPortal(
          <ColumnFilterMenu
            col={menu.col}
            title={titleOf(menu.col)}
            options={menuOptions}
            changes={menuChanges}
            current={filters.find((f) => f.col === menu.col) ?? null}
            position={{ x: menu.x, y: menu.y }}
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
