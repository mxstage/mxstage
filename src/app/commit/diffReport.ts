// 差分レポート（Excel）。反映の前に、何を・どの値から・どの値へ・誰が・なぜ変えるかを 1 冊にまとめる。
// 承認の証跡（情報システム部門や顧客への説明）に使う。作業画面のメモリにある差分だけから作り、どこにも送らない。
//
//   概要:   接続先・構造・シート・依頼メモ・件数・列ごとの件数・作業の履歴（バッチ）
//   差分:   変更 1 セル = 1 行（キー列・子・種類・列・変更前・変更後・作者・根拠・時刻）。追加行は値のある列ごとに 1 行、削除行は 1 行
//   書き込みログ: 反映した後だけ（その回・そのシートの分。キーと結果だけで、属性値は入らない）
//
// レポートは「写し」（ReportSnapshot）から作る。反映の前は今の差分の写し、反映の後は反映を始めたときの写し
// （反映した行は Maximo から読み直されて差分から消えるので、controller が反映の直前に残す）とその回の書き込みログ。
//
// 属性値をそのまま書くので、Maximo のデータを含むファイルになる。扱いは利用者の組織の決まりに従う（画面の説明にも書く）。

import type { BatchAuthor, BatchInfo, CellValue } from "../../shared/model";
import { headerLines } from "../../shared/columnLabel";
import { defineMessages } from "../../shared/i18n";
import { parseRowKey, type SheetMeta } from "../../shared/sheet";
import type { WriteLogEntry } from "../maximo/commit";
import type { CommitPanelState } from "../runtime/contracts";
import type { DiffItem, Workspace } from "../store";
import { commitMessages } from "./messages";
import { XLSX_STYLE, buildXlsx, type XlsxCell, type XlsxRow, type XlsxSheet } from "./xlsxWriter";

export const diffReportMessages = defineMessages(
  {
    button: "Diff report (Excel)",
    buttonTitle: "Save every change with its old value, new value, author and reason as an Excel file (it contains Maximo data)",
    saved: (file: string) => `Saved ${file}`,
    failed: "Could not make the diff report",
    sheets: { summary: "Summary", changes: "Changes", writeLog: "Write log" },
    title: "MX Stage diff report",
    notice:
      "Changes staged in the MX Stage work screen. Nothing here has been written to Maximo unless the write log says so: MX Stage writes only when a person presses Commit to Maximo in the work screen.",
    item: "Item",
    value: "Value",
    createdAt: "Created",
    target: "Maximo",
    environment: "Environment",
    structure: "Object structure",
    sheet: "Sheet",
    note: "Commit request note",
    requestedBy: "Requested by",
    records: "Records",
    changedCells: "Changed cells",
    addedRows: "Added rows",
    newRecords: "New records",
    deletedRows: "Deleted rows",
    byColumn: "Changes by column",
    column: "Column",
    attribute: "Attribute",
    count: "Count",
    history: "Work history (batches, oldest first)",
    time: "Time",
    author: "Author",
    operations: "Operations",
    reason: "Reason",
    state: "State",
    undone: "Undone",
    active: "Active",
    no: "No.",
    child: "Child object",
    childId: "Child ID",
    kind: "Change",
    before: "Before",
    after: "After",
    kinds: { change: "Changed", add: "Added row", addRecord: "New record", delete: "Deleted row" },
    authors: { llm: "AI assistant", user: "Person" } as Record<BatchAuthor, string>,
    environments: { test: "Test", production: "Production" },
    stage: "Stage",
    stageBefore: "Before commit (for approval)",
    stageAfter: "Committed (with the write log of this commit)",
    newChild: "(new)",
    empty: "(empty)",
    log: {
      at: "Time",
      record: "Record",
      transactionId: "Transaction ID",
      change: "Child changes",
      delete: "Child deletions",
      add: "Child additions",
      attrs: "Attributes",
      http: "HTTP",
      reasonCode: "Maximo reason code",
      result: "Result",
    },
  },
  {
    button: "差分レポート（Excel）",
    buttonTitle: "すべての変更を、変更前・変更後・作者・根拠とともに Excel に保存します（Maximo のデータを含みます）",
    saved: (file) => `${file} を保存しました`,
    failed: "差分レポートを作れませんでした",
    sheets: { summary: "概要", changes: "差分", writeLog: "書き込みログ" },
    title: "MX Stage 差分レポート",
    notice:
      "MX Stage の作業画面で準備した変更です。書き込みログに載っていない限り、Maximo にはまだ書き込まれていません。MX Stage が Maximo に書き込むのは、人が作業画面で [Maximo に反映] を押したときだけです。",
    item: "項目",
    value: "値",
    createdAt: "作成日時",
    target: "Maximo",
    environment: "環境",
    structure: "オブジェクト構造",
    sheet: "シート",
    note: "反映の依頼メモ",
    requestedBy: "依頼した人",
    records: "親レコード",
    changedCells: "変更セル",
    addedRows: "追加行",
    newRecords: "新規レコード",
    deletedRows: "削除行",
    byColumn: "列ごとの変更",
    column: "列",
    attribute: "属性名",
    count: "件数",
    history: "作業の履歴（バッチ。古い順）",
    time: "時刻",
    author: "作者",
    operations: "操作数",
    reason: "根拠",
    state: "状態",
    undone: "取り消し済み",
    active: "有効",
    no: "No.",
    child: "子オブジェクト",
    childId: "子の ID",
    kind: "種類",
    before: "変更前",
    after: "変更後",
    kinds: { change: "変更", add: "追加行", addRecord: "新規レコード", delete: "削除行" },
    authors: { llm: "AI アシスタント", user: "利用者" },
    environments: { test: "テスト", production: "本番" },
    stage: "段階",
    stageBefore: "反映の前（承認用）",
    stageAfter: "反映済み（この回の書き込みログ付き）",
    newChild: "（新規）",
    empty: "（空）",
    log: {
      at: "時刻",
      record: "レコード",
      transactionId: "トランザクション ID",
      change: "子の変更",
      delete: "子の削除",
      add: "子の追加",
      attrs: "属性",
      http: "HTTP",
      reasonCode: "Maximo の理由コード",
      result: "結果",
    },
  },
);

/** レポートに要るものの写し（シートを後から変えても、写しは変わらない） */
export interface ReportSnapshot {
  sheet: string;
  meta: SheetMeta;
  entries: DiffItem[];
  changedCells: number;
  addedRows: number;
  deletedRows: number;
  batches: BatchInfo[];
  /** 反映の依頼と件数（パネルの写し）。無ければ省く */
  panel: Pick<CommitPanelState, "note" | "requestedBy" | "counts" | "target"> | null;
  takenAt: number;
}

export interface DiffReportInput {
  snapshot: ReportSnapshot;
  /** 環境の表示（テスト・本番など）。分からなければ省く */
  environment?: string | null;
  /** その回・そのシートの書き込みログ（反映の後だけ） */
  writeLog?: readonly WriteLogEntry[];
  now?: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 端末の時刻で YYYY-MM-DD HH:mm:ss */
export function formatLocalTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function cell(v: CellValue | undefined): XlsxCell {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "true" : "false";
  return v;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 今のシートの差分の写しを取る（差分はページをたどって全件） */
export function takeReportSnapshot(workspace: Workspace, sheet: string, panel: CommitPanelState | null, now: number = Date.now()): ReportSnapshot {
  const entries: DiffItem[] = [];
  let cursor: string | undefined;
  let changedCells = 0;
  let addedRows = 0;
  let deletedRows = 0;
  for (;;) {
    const res = workspace.getDiff(sheet, { limit: 5_000, ...(cursor !== undefined ? { cursor } : {}) });
    entries.push(...res.entries.map((e) => ({ ...e, ...(e.values !== undefined ? { values: { ...e.values } } : {}) })));
    ({ changedCells, addedRows, deletedRows } = res);
    if (res.nextCursor === null) break;
    cursor = res.nextCursor;
  }
  const p =
    panel === null
      ? null
      : {
          counts: { ...panel.counts },
          ...(panel.note !== undefined ? { note: panel.note } : {}),
          ...(panel.requestedBy !== undefined ? { requestedBy: panel.requestedBy } : {}),
          ...(panel.target !== undefined ? { target: { ...panel.target } } : {}),
        };
  return {
    sheet,
    meta: workspace.getSheet(sheet).meta,
    entries,
    changedCells,
    addedRows,
    deletedRows,
    batches: workspace.listBatches(sheet).map((b) => ({ ...b })),
    panel: p,
    takenAt: now,
  };
}

/** 差分レポートのブック（シートの並び）を作る。試験しやすいよう、バイト列にする前の形で返す */
export function diffReportSheets(input: DiffReportInput): XlsxSheet[] {
  const t = diffReportMessages();
  const snap = input.snapshot;
  const sheetName = snap.sheet;
  const meta = snap.meta;
  const now = input.now ?? Date.now();
  const entries = snap.entries;
  const res = snap;
  const panel = snap.panel;
  const columns = new Map(meta.columns.map((c) => [c.name, c]));
  const label = (col: string) => {
    const c = columns.get(col);
    return c === undefined ? col : headerLines(c).main;
  };
  const batches = snap.batches;
  const batchTime = new Map(batches.map((b) => [b.batchId, b.createdAt]));
  const source = meta.source;
  const os = source.kind === "maximo" ? source.os : null;
  const baseUrl = panel?.target?.baseUrl ?? (source.kind === "maximo" ? (source.baseUrl ?? null) : null);

  // --- 概要 ---
  const summary: XlsxRow[] = [{ cells: [t.title], style: XLSX_STYLE.title }, { cells: [t.notice], style: XLSX_STYLE.wrap }, { cells: [] }];
  summary.push({ cells: [t.item, t.value], style: XLSX_STYLE.header });
  const info: Array<[string, XlsxCell]> = [
    [t.createdAt, formatLocalTime(now)],
    [t.stage, (input.writeLog ?? []).length > 0 ? t.stageAfter : t.stageBefore],
    [t.target, baseUrl],
    ...(input.environment ? ([[t.environment, input.environment]] as Array<[string, XlsxCell]>) : []),
    [t.structure, os],
    [t.sheet, sheetName],
    ...(panel?.note ? ([[t.note, panel.note]] as Array<[string, XlsxCell]>) : []),
    ...(panel?.requestedBy ? ([[t.requestedBy, t.authors[panel.requestedBy]]] as Array<[string, XlsxCell]>) : []),
    ...(panel ? ([[t.records, panel.counts.parents]] as Array<[string, XlsxCell]>) : []),
    [t.changedCells, res.changedCells],
    [t.addedRows, res.addedRows],
    ...(panel?.counts.newRecords ? ([[t.newRecords, panel.counts.newRecords]] as Array<[string, XlsxCell]>) : []),
    [t.deletedRows, res.deletedRows],
  ];
  for (const [k, v] of info) summary.push({ cells: [k, v], style: XLSX_STYLE.wrap });

  const byColumn = new Map<string, number>();
  for (const e of entries) if (e.kind === "change") byColumn.set(e.col, (byColumn.get(e.col) ?? 0) + 1);
  if (byColumn.size > 0) {
    summary.push({ cells: [] }, { cells: [t.byColumn], style: XLSX_STYLE.title }, { cells: [t.column, t.attribute, t.count], style: XLSX_STYLE.header });
    for (const [col, n] of [...byColumn].sort((a, b) => b[1] - a[1])) summary.push({ cells: [label(col), col, n] });
  }
  if (batches.length > 0) {
    summary.push(
      { cells: [] },
      { cells: [t.history], style: XLSX_STYLE.title },
      { cells: [t.time, t.author, t.operations, t.reason, t.state], style: XLSX_STYLE.header },
    );
    for (const b of batches) {
      summary.push({ cells: [formatLocalTime(b.createdAt), t.authors[b.author], b.opCount, b.reason ?? null, b.undone ? t.undone : t.active], style: XLSX_STYLE.wrap });
    }
  }

  // --- 差分 ---
  const keyCols = meta.keyColumns;
  const head = [t.no, ...keyCols.map(label), t.child, t.childId, t.kind, t.column, t.attribute, t.before, t.after, t.author, t.reason, t.time];
  const rows: XlsxRow[] = [{ cells: head, style: XLSX_STYLE.header }];
  let no = 0;
  for (const e of entries) {
    const key = parseRowKey(e.rowKey);
    const keyValues = key.parentKey.split("|").map(decode);
    const keys: XlsxCell[] = keyCols.map((_, i) => keyValues[i] ?? null);
    const childId = key.childName === null ? null : key.isNewChild ? t.newChild : key.childId === null ? null : decode(key.childId);
    const common = (kind: string, col: string | null, before: XlsxCell, after: XlsxCell): XlsxCell[] => [
      ++no,
      ...keys,
      key.childName,
      childId,
      kind,
      col === null ? null : label(col),
      col,
      before,
      after,
      t.authors[e.author],
      e.reason ?? null,
      batchTime.has(e.batchId) ? formatLocalTime(batchTime.get(e.batchId)!) : null,
    ];
    if (e.kind === "change") {
      rows.push({ cells: common(t.kinds.change, e.col, e.before === null ? t.empty : cell(e.before), e.after === null ? t.empty : cell(e.after)), style: XLSX_STYLE.wrap });
    } else if (e.kind === "add") {
      const kind = key.childName === null ? t.kinds.addRecord : t.kinds.add;
      const values = Object.entries(e.values ?? {});
      if (values.length === 0) rows.push({ cells: common(kind, null, null, null), style: XLSX_STYLE.wrap });
      for (const [col, v] of values) rows.push({ cells: common(kind, col, null, cell(v)), style: XLSX_STYLE.wrap });
    } else {
      const ids = Object.entries(e.values ?? {})
        .map(([c, v]) => `${c}=${v === null ? "" : String(v)}`)
        .join(", ");
      rows.push({ cells: common(t.kinds.delete, null, ids || null, null), style: XLSX_STYLE.wrap });
    }
  }
  const widths = [6, ...keyCols.map(() => 14), 16, 10, 12, 22, 18, 28, 28, 14, 48, 20];

  const sheets: XlsxSheet[] = [
    { name: t.sheets.summary, rows: summary, widths: [28, 60, 10, 48, 14] },
    { name: t.sheets.changes, rows, widths, freezeRows: 1, autoFilterRow: 1 },
  ];

  // --- 書き込みログ（反映した後だけ） ---
  const log = input.writeLog ?? [];
  if (log.length > 0) {
    const status = commitMessages().resultStatus;
    const l = t.log;
    const logRows: XlsxRow[] = [{ cells: [l.at, l.record, l.transactionId, l.change, l.delete, l.add, l.attrs, l.http, l.reasonCode, l.result], style: XLSX_STYLE.header }];
    for (const w of log) {
      logRows.push({
        cells: [
          w.at,
          w.parentKey.split("|").map(decode).join(" / "),
          w.transactionId,
          w.ops.change,
          w.ops.delete,
          w.ops.add,
          w.ops.attrs.join(" "),
          w.httpStatus,
          w.reasonCode,
          status[w.result] ?? w.result,
        ],
      });
    }
    sheets.push({ name: t.sheets.writeLog, rows: logRows, widths: [24, 24, 30, 10, 10, 10, 40, 8, 18, 30], freezeRows: 1, autoFilterRow: 1 });
  }
  return sheets;
}

export function diffReportXlsx(input: DiffReportInput): Uint8Array {
  return buildXlsx(diffReportSheets(input));
}

/** mxstage-diff-<シート名>-YYYYMMDD-HHmmss.xlsx（ファイル名に使えない文字は _） */
export function diffReportFileName(sheet: string, d: Date): string {
  const safe = sheet.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "sheet";
  return `mxstage-diff-${safe}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.xlsx`;
}
