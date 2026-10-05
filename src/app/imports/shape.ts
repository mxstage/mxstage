// 取り込んだ表の形を整えてから作業画面のシートにする（apply_mapping の form・fillDown・unpivot）。
// どれも作業画面の中で機械的に行い、AI には「どう読むか」だけを渡させる（行の値を AI に書き写させない）。
//   - form: 同じ形の帳票（作業日報など）が縦に並んだシートを、帳票ごとに見つける。上の欄（ラベルの右・下の値）と明細の行から、
//     1 明細 1 行の表にする（明細が無ければ 1 帳票 1 行）。ラベルで探すので、行を足した帳票でもずれない
//   - fillDown: 空のセル（結合の 2 行目以降だけ、または空のセル全部）と「〃」「同上」を上の値で埋める。帳票をまたがない
//   - unpivot: 横に並んだ列（年度・月など）を縦の行に直す。1 つのセルの複数の印を分け、数量の行を号機ごとに分ける

import type { CellValue, ColumnSchema, SheetSource } from "../../shared/model";
import type { SheetMeta, SheetRow } from "../../shared/sheet";
import {
  cellFor,
  columnIndex,
  columnLetter,
  dataRows,
  headerText,
  ImportError,
  importColumns,
  inferType,
  isBlank,
  rowAt,
  SOURCE_ROW_COLUMN,
  type MergeRange,
  type RawRow,
  type RawTable,
} from "./table";

/** 帳票の番号（何枚目の帳票か） */
export const BLOCK_COLUMN = "BLOCK";
/** unpivot の行の元のセル（例 F12） */
export const SOURCE_CELL_COLUMN = "SOURCE_CELL";
/** 帳票の数の上限 */
export const FORM_MAX_BLOCKS = 5_000;
/** unpivot で作る行の上限 */
export const UNPIVOT_MAX_ROWS = 200_000;
/** 「上と同じ」の印 */
const DITTO = new Set(["〃", "″", "”", '"', "''", "同上", "ditto", "do", "do."]);

export interface FillDownSpec {
  /** 列名・元の見出し・列記号（A など） */
  columns: readonly string[];
  /** blank: 空のセル全部 / merged: 結合したセルの 2 行目以降だけ */
  mode: "blank" | "merged";
  /** 「〃」「同上」も上の値にする */
  ditto: boolean;
}

export interface UnpivotSpec {
  /** 縦にする列（列名・元の見出し・列記号・"F:Q" のような範囲） */
  columns: readonly string[];
  /** 列の見出しの代わりに使う行（例 年度の西暦の行）。省けば見出しの文字 */
  labelRow?: number;
  labelColumn: string;
  valueColumn: string;
  /** 空のセルも行にする */
  keepEmpty: boolean;
  /** 1 つのセルの中のこれらの印を、印ごとの行に分ける（残りの文字は <valueColumn>_NOTE） */
  tokens?: readonly string[];
  /** 数量（countColumn）が 2 以上の行を labels ごとの行に分け、column に入れる */
  repeat?: { countColumn: string; labels: readonly string[]; column: string };
}

export interface FormFieldSpec {
  /** ラベル。言い換えがあれば複数（帳票によって「作業日」「実施日」など） */
  label: string | readonly string[];
  /** 値がラベルの下にある（既定は右） */
  below?: boolean;
}

export interface FormSpec {
  /** 帳票の始まりの行にある文字（表題など。空白を除いて同じ文字のセルが当たる。括弧の注記が続いてもよい） */
  start: readonly string[];
  /** 列名 → ラベル（値はラベルの右、below なら下の、空でない最初のセル）。言い換えは配列で */
  fields: Readonly<Record<string, string | readonly string[] | FormFieldSpec>>;
  /**
   * 明細の表。header はその見出しの行にある文字（言い換えは配列で）、until は明細の終わりの行にある文字。
   * columns は列名 → 見出しの言い換え（「作業内容」と「内容」を 1 つの列にする）
   */
  items?: { header: string | readonly string[]; until?: readonly string[]; columns?: Readonly<Record<string, readonly string[]>> };
}

export interface ShapeOptions {
  /** 表の見出しの行（form のときは使わない） */
  headerRow?: number;
  form?: FormSpec;
  fillDown?: FillDownSpec;
  unpivot?: UnpivotSpec;
}

/** 形を整える途中の列。index があれば元の列、無ければ extra の値 */
interface DraftColumn {
  name: string;
  header: string;
  letter: string | null;
  index: number | null;
}

/** 形を整える途中の行 */
interface DraftRow {
  row: number;
  key: string;
  block: number | null;
  cells: CellValue[];
  extra: Record<string, CellValue>;
  /** extra の列の元の列番号（結合の判定に使う） */
  src: Record<string, number>;
}

export interface ShapedImport {
  columns: DraftColumn[];
  rows: DraftRow[];
  /** 結果に添えること（帳票の数・見つからなかったラベル・埋めたセルの数など） */
  notes: Record<string, unknown>;
  defaultKeys: string[];
}

/** ラベルの比べ方: 全角と半角・半角カナをそろえ（NFKC）、空白とコロンを除き、英字は小文字 */
export function normLabel(v: CellValue | undefined): string {
  return headerText(v).normalize("NFKC").replace(/[\s:：]/g, "").toLowerCase();
}

const list = (v: string | readonly string[]): string[] => (typeof v === "string" ? [v] : [...v]);

function valueOf(c: DraftColumn, r: DraftRow): CellValue {
  return c.index !== null ? (r.cells[c.index] ?? null) : (r.extra[c.name] ?? null);
}

function setValue(c: DraftColumn, r: DraftRow, v: CellValue): void {
  if (c.index !== null) {
    const cells = r.cells.slice();
    while (cells.length <= c.index) cells.push(null);
    cells[c.index] = v;
    r.cells = cells;
  } else r.extra[c.name] = v;
}

/** 列の指定（列名・元の見出し・列記号・範囲）を列にする */
function resolveColumns(refs: readonly string[], columns: readonly DraftColumn[], allowRange: boolean, what: string): DraftColumn[] {
  const out: DraftColumn[] = [];
  const add = (c: DraftColumn) => {
    if (!out.includes(c)) out.push(c);
  };
  for (const ref of refs) {
    const byName = columns.find((c) => c.name === ref) ?? columns.find((c) => c.header !== "" && c.header === headerText(ref));
    if (byName) {
      add(byName);
      continue;
    }
    const range = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(ref.trim());
    if (allowRange && range) {
      const a = columnIndex(range[1] as string);
      const b = columnIndex(range[2] as string);
      const inRange = columns.filter((c) => c.index !== null && c.index >= Math.min(a, b) && c.index <= Math.max(a, b));
      if (inRange.length === 0) throw new ImportError(`${what}: no column in ${ref}`);
      inRange.forEach(add);
      continue;
    }
    const byLetter = /^[A-Za-z]{1,3}$/.test(ref.trim()) ? columns.find((c) => c.letter === ref.trim().toUpperCase()) : undefined;
    if (byLetter) {
      add(byLetter);
      continue;
    }
    throw new ImportError(`${what}: ${ref} is not a column. Columns: ${columns.map((c) => c.name).join(", ")}`);
  }
  return out;
}

/** 結合の 2 行目以降のセル（"行:列"） */
function mergeContinuations(t: RawTable): Set<string> {
  const out = new Set<string>();
  for (const m of t.merges ?? []) {
    if (m.r2 === m.r1) continue;
    // 大きすぎる結合（シート全体など）は埋める手がかりにしない
    if ((m.r2 - m.r1 + 1) * (m.c2 - m.c1 + 1) > 10_000) continue;
    for (let r = m.r1 + 1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) out.add(`${r}:${c}`);
  }
  return out;
}

/** 見出しの行の表（今の取り込みと同じ列） */
function tableShape(t: RawTable, headerRow: number): ShapedImport {
  if (rowAt(t, headerRow) === undefined) throw new ImportError(`Row ${headerRow} has no values`);
  const cols = importColumns(t, headerRow);
  if (cols.length === 0) throw new ImportError(`There are no columns under row ${headerRow}`);
  return {
    columns: cols.map((c) => ({ name: c.name, header: c.header, letter: c.letter, index: c.index })),
    rows: dataRows(t, headerRow).map((r) => ({ row: r.row, key: String(r.row), block: null, cells: r.cells, extra: {}, src: {} })),
    notes: {},
    defaultKeys: [SOURCE_ROW_COLUMN],
  };
}

// ---------------------------------------------------------------------------
// 帳票
// ---------------------------------------------------------------------------

interface Found {
  row: RawRow;
  col: number;
  /** ラベルと同じ文字のセル（false はラベルで始まるセル。「No. 4-04」のように値が同じセルにあることがある） */
  exact: boolean;
  /** 当たったラベル（言い換えのどれか） */
  label: string;
}

/** 帳票の中で、ラベル（言い換えのどれか）に当たる最初のセル（同じ文字を先に、次に「その文字で始まる」） */
function findLabel(rows: readonly RawRow[], labels: readonly string[]): Found | null {
  const wants = labels.map((l) => ({ label: l, n: normLabel(l) })).filter((w) => w.n !== "");
  if (wants.length === 0) return null;
  for (const exact of [true, false]) {
    for (const row of rows) {
      for (let c = 0; c < row.cells.length; c++) {
        const v = row.cells[c];
        if (typeof v !== "string") continue;
        const n = normLabel(v);
        const hit = wants.find((w) => (exact ? n === w.n : n.startsWith(w.n)));
        if (hit) return { row, col: c, exact, label: hit.label };
      }
    }
  }
  return null;
}

/** ラベルで始まるセルの、ラベルより後ろの文字（空白・コロンを読み飛ばして比べる） */
export function afterLabel(text: string, label: string): string {
  const want = normLabel(label);
  let i = 0;
  let k = 0;
  while (i < text.length && k < want.length) {
    const ch = text[i] as string;
    if (ch === "\n" || ch === "\r") return "";
    // 1 文字ずつ NFKC にそろえて比べる（全角の英数字は 1 文字、「㈱」のように 2 文字以上になるものもある）
    const n = ch.normalize("NFKC").toLowerCase().replace(/[\s:：]/g, "");
    if (n === "") {
      i++;
      continue;
    }
    if (want.slice(k, k + n.length) !== n) return "";
    i++;
    k += n.length;
  }
  if (k < want.length) return "";
  const rest = text.slice(i);
  // ラベルの後で改行していれば、続きはラベルの 2 行目（「特記事項」の下の「引継ぎ」）で値ではない
  if (/^[^\S\n]*[\r\n]/.test(rest)) return "";
  return rest.replace(/^[\s　:：]+/, "").trim();
}

function formShape(t: RawTable, spec: FormSpec): ShapedImport {
  const starts = spec.start.map(normLabel).filter((s) => s !== "");
  if (starts.length === 0) throw new ImportError("form.start needs at least one text");
  const fieldEntries = Object.entries(spec.fields).map(
    ([name, f]) => [name.trim(), typeof f === "string" || Array.isArray(f) ? { labels: list(f as string | readonly string[]), below: false } : { labels: list((f as FormFieldSpec).label), below: (f as FormFieldSpec).below === true }] as const,
  );
  for (const [name] of fieldEntries) {
    if (name === "" || name === "__proto__" || name === SOURCE_ROW_COLUMN || name === BLOCK_COLUMN) throw new ImportError(`${JSON.stringify(name)} cannot be used as a field name`);
  }
  if (fieldEntries.length === 0 && spec.items === undefined) throw new ImportError("form needs fields or items");
  const itemHeaders = spec.items ? list(spec.items.header) : [];
  // 明細の列の言い換え（見出しの文字 → 列名）
  const aliasOf = new Map<string, string>();
  for (const [name, texts] of Object.entries(spec.items?.columns ?? {})) for (const x of [name, ...texts]) aliasOf.set(normLabel(x), name.trim());
  // ラベル（値と取り違えないよう、右・下を探すときに飛ばす）
  const labels = new Set<string>([...fieldEntries.flatMap(([, f]) => f.labels.map(normLabel)), ...itemHeaders.map(normLabel), ...(spec.items?.until ?? []).map(normLabel)]);
  const mergeAt = new Map<string, MergeRange>();
  for (const m of t.merges ?? []) mergeAt.set(`${m.r1}:${m.c1}`, m);

  // 始まりは、文字が同じセル（空白は除く）。括弧の注記が続く表題（作業日報（休日））も認める。
  // 「含む」にしないのは、明細の文（「監督員と打合せ」など）で帳票が切れないようにするため
  const isStart = (v: CellValue | undefined) => {
    if (typeof v !== "string") return false;
    const n = normLabel(v);
    return starts.some((s) => n === s || (n.startsWith(s) && /^[（(【[〔]/.test(n.slice(s.length))));
  };
  const startRows = t.rows.filter((r) => r.cells.some(isStart)).map((r) => r.row);
  if (startRows.length === 0) throw new ImportError(`No cell contains ${spec.start.join(" / ")} (form.start). Check the title text with describe_import`);
  if (startRows.length > FORM_MAX_BLOCKS) throw new ImportError(`More than ${FORM_MAX_BLOCKS} forms were found. Check form.start`);
  const blocks = startRows.map((start, i) => ({ start, end: i + 1 < startRows.length ? (startRows[i + 1] as number) - 1 : Number.MAX_SAFE_INTEGER }));

  const itemColumns: DraftColumn[] = [];
  const used = new Set<string>([SOURCE_ROW_COLUMN, BLOCK_COLUMN, ...fieldEntries.map(([n]) => n)]);
  const itemByLabel = new Map<string, DraftColumn>();
  const rows: DraftRow[] = [];
  const missing: Record<string, number> = {};
  let noItems = 0;

  const valueNear = (rowsIn: readonly RawRow[], found: Found, below: boolean): { value: CellValue; col: number } | null => {
    const m = mergeAt.get(`${found.row.row}:${found.col}`);
    if (!below) {
      for (let c = (m?.c2 ?? found.col) + 1; c < found.row.cells.length; c++) {
        const v = found.row.cells[c];
        if (isBlank(v)) continue;
        return typeof v === "string" && labels.has(normLabel(v)) ? null : { value: v as CellValue, col: c };
      }
      return null;
    }
    for (const r of rowsIn) {
      if (r.row <= (m?.r2 ?? found.row.row)) continue;
      const v = r.cells[found.col];
      if (isBlank(v)) continue;
      return typeof v === "string" && labels.has(normLabel(v)) ? null : { value: v as CellValue, col: found.col };
    }
    return null;
  };

  const until = (spec.items?.until ?? []).map(normLabel).filter((s) => s !== "");
  // 明細は、until の文字か、上の欄のラベル（特記事項など、明細の下にある欄）の行の手前で終わる
  const fieldLabels = new Set(fieldEntries.flatMap(([, f]) => f.labels.map(normLabel)));
  const isUntil = (r: RawRow) =>
    r.cells.some((v) => {
      if (typeof v !== "string") return false;
      const n = normLabel(v);
      // 2 行のラベル（「特記事項」の下に「引継ぎ」）は 1 行目で比べる
      return until.some((u) => n.startsWith(u)) || fieldLabels.has(n) || fieldLabels.has(normLabel(v.split(/\r?\n/)[0]));
    });
  blocks.forEach((b, bi) => {
    const rowsIn = t.rows.filter((r) => r.row >= b.start && r.row <= b.end);
    const extra: Record<string, CellValue> = { [BLOCK_COLUMN]: bi + 1 };
    const src: Record<string, number> = {};
    // 明細の表（見出しの行から終わりの手前まで）
    const head = spec.items === undefined ? null : findLabel(rowsIn, itemHeaders);
    const endRow = head === null ? null : (rowsIn.find((r) => r.row > head.row.row && isUntil(r))?.row ?? Number.MAX_SAFE_INTEGER);
    // 上の欄のラベルは明細の表の外で探す（明細の見出しの「No.」などと取り違えない）
    const headerArea = head === null ? rowsIn : rowsIn.filter((r) => r.row < head.row.row || r.row >= (endRow as number));
    for (const [name, f] of fieldEntries) {
      const found = findLabel(headerArea, f.labels);
      const rest = found !== null && !found.exact ? afterLabel(String(found.row.cells[found.col]), found.label) : "";
      const got = found === null ? null : rest !== "" ? { value: rest as CellValue, col: found.col } : valueNear(rowsIn, found, f.below);
      extra[name] = got?.value ?? null;
      if (got) src[name] = got.col;
      else missing[name] = (missing[name] ?? 0) + 1;
    }
    if (spec.items === undefined) {
      rows.push({ row: b.start, key: String(b.start), block: bi + 1, cells: [], extra, src });
      return;
    }
    if (head === null) {
      noItems++;
      return;
    }
    // この帳票の明細の列（見出しの文字で合わせる。帳票ごとに列の位置が違ってもよい）
    const local: Array<{ col: DraftColumn; index: number }> = [];
    head.row.cells.forEach((v, i) => {
      const h = headerText(v);
      if (h === "") return;
      const alias = aliasOf.get(normLabel(h));
      // 言い換えを指定した列は 1 つにまとめる（キーは列名）。それ以外は見出しの文字ごと
      const key = alias !== undefined ? `=${alias}` : normLabel(h);
      let col = itemByLabel.get(key);
      if (col === undefined) {
        const base = alias ?? h;
        let name = base;
        for (let n = 2; used.has(name) || name === "__proto__"; n++) name = `${base}_${n}`;
        used.add(name);
        col = { name, header: h, letter: null, index: null };
        itemByLabel.set(key, col);
        itemColumns.push(col);
      }
      if (local.some((l) => l.col === col)) return;
      local.push({ col, index: i });
    });
    for (const r of rowsIn) {
      if (r.row <= head.row.row) continue;
      if (r.row >= (endRow as number)) break;
      const values = local.map((l) => r.cells[l.index] ?? null);
      const filled = values.filter((v) => !isBlank(v));
      if (filled.length === 0) continue;
      // 番号だけの行（あらかじめ番号を振った空の行）は飛ばす
      if (filled.length === 1 && typeof values[0] === "number") continue;
      const e: Record<string, CellValue> = { ...extra };
      const s: Record<string, number> = { ...src };
      local.forEach((l, i) => {
        e[l.col.name] = values[i] ?? null;
        s[l.col.name] = l.index;
      });
      rows.push({ row: r.row, key: String(r.row), block: bi + 1, cells: [], extra: e, src: s });
    }
  });

  const columns: DraftColumn[] = [
    { name: BLOCK_COLUMN, header: "", letter: null, index: null },
    ...fieldEntries.map(([name, f]) => ({ name, header: f.labels[0] ?? "", letter: null, index: null })),
    ...itemColumns,
  ];
  const notes: Record<string, unknown> = { forms: blocks.length };
  if (Object.keys(missing).length > 0) notes.missingFields = missing;
  if (noItems > 0) notes.formsWithoutItems = noItems;
  return { columns, rows, notes, defaultKeys: [SOURCE_ROW_COLUMN] };
}

// ---------------------------------------------------------------------------
// fillDown・unpivot
// ---------------------------------------------------------------------------

function applyFillDown(t: RawTable, shaped: ShapedImport, spec: FillDownSpec): void {
  const targets = resolveColumns(spec.columns, shaped.columns, false, "fillDown");
  const merged = spec.mode === "merged" ? mergeContinuations(t) : null;
  const filled: Record<string, number> = {};
  for (const c of targets) {
    let last: CellValue = null;
    let block: number | null | undefined;
    let n = 0;
    for (const r of shaped.rows) {
      if (r.block !== block) {
        block = r.block;
        last = null;
      }
      const v = valueOf(c, r);
      const ditto = spec.ditto && typeof v === "string" && DITTO.has(v.trim().toLowerCase());
      if (isBlank(v) || ditto) {
        const col = c.index ?? r.src[c.name];
        const inMerge = merged === null || (col !== undefined && merged.has(`${r.row}:${col}`));
        if (last !== null && (ditto || inMerge)) {
          setValue(c, r, last);
          n++;
        }
        continue;
      }
      last = v;
    }
    filled[c.name] = n;
  }
  shaped.notes.filledDown = filled;
}

/** 1 つのセルの文字を印ごとに分ける（印の後ろの文字はその印の注記。印の無い文字はそのまま 1 つ） */
export function splitTokens(text: string, tokens: readonly string[]): Array<{ value: string; note: string | null }> {
  const sorted = [...tokens].filter((x) => x !== "").sort((a, b) => b.length - a.length);
  const out: Array<{ value: string; note: string }> = [];
  let lead = "";
  for (let i = 0; i < text.length; ) {
    const tok = sorted.find((x) => text.startsWith(x, i));
    if (tok !== undefined) {
      out.push({ value: tok, note: "" });
      i += tok.length;
      continue;
    }
    const ch = text[i] as string;
    if (out.length === 0) lead += ch;
    else (out[out.length - 1] as { note: string }).note += ch;
    i++;
  }
  if (out.length === 0) return [{ value: text, note: null }];
  if (lead.trim() !== "") (out[0] as { note: string }).note = `${lead.trim()} ${out[0]!.note}`;
  return out.map((p) => ({ value: p.value, note: p.note.trim() === "" ? null : p.note.trim() }));
}

function applyUnpivot(t: RawTable, shaped: ShapedImport, spec: UnpivotSpec, headerRow: number | undefined): ShapedImport {
  const targets = resolveColumns(spec.columns, shaped.columns.filter((c) => c.index !== null), true, "unpivot");
  const keep = shaped.columns.filter((c) => !targets.includes(c));
  const labelCells = spec.labelRow !== undefined ? rowAt(t, spec.labelRow) : headerRow !== undefined ? rowAt(t, headerRow) : undefined;
  if (spec.labelRow !== undefined && labelCells === undefined) throw new ImportError(`unpivot.labelRow ${spec.labelRow} has no values`);
  const labelOf = (c: DraftColumn): CellValue => {
    const v = labelCells?.cells[c.index as number];
    if (!isBlank(v)) return typeof v === "string" ? headerText(v) : (v as CellValue);
    return c.header !== "" ? c.header : c.letter;
  };
  const noteColumn = `${spec.valueColumn}_NOTE`;
  const added = [SOURCE_CELL_COLUMN, spec.labelColumn, spec.valueColumn, ...(spec.tokens ? [noteColumn] : []), ...(spec.repeat ? [spec.repeat.column] : [])];
  const names = new Set(keep.map((c) => c.name));
  for (const n of added) {
    if (n.trim() === "" || n === "__proto__" || n === SOURCE_ROW_COLUMN || names.has(n)) throw new ImportError(`unpivot: column name ${JSON.stringify(n)} is already used`);
    names.add(n);
  }
  const count = spec.repeat ? resolveColumns([spec.repeat.countColumn], keep, false, "unpivot.repeat.countColumn")[0]! : null;
  const rows: DraftRow[] = [];
  let skipped = 0;
  // 数量が号機の名前より多い行（名前の数までしか分けない。結果で知らせる）
  let overflow = 0;
  let maxCount = 0;
  for (const r of shaped.rows) {
    if (spec.labelRow !== undefined && r.row <= spec.labelRow) continue;
    let units: Array<string | null> = [null];
    if (spec.repeat && count) {
      const n = Number(String(valueOf(count, r) ?? "").replace(/[^\d.]/g, ""));
      if (Number.isInteger(n) && n >= 2) units = spec.repeat.labels.slice(0, n).map(String);
      if (Number.isInteger(n) && n > spec.repeat.labels.length) {
        overflow++;
        maxCount = Math.max(maxCount, n);
      }
    }
    for (const c of targets) {
      const v = r.cells[c.index as number] ?? null;
      if (isBlank(v) && !spec.keepEmpty) {
        skipped++;
        continue;
      }
      const pieces = spec.tokens && typeof v === "string" ? splitTokens(v, spec.tokens) : [{ value: v, note: null }];
      pieces.forEach((p, pi) => {
        for (const u of units) {
          const extra: Record<string, CellValue> = { ...r.extra, [SOURCE_CELL_COLUMN]: `${c.letter}${r.row}`, [spec.labelColumn]: labelOf(c), [spec.valueColumn]: p.value };
          if (spec.tokens) extra[noteColumn] = p.note;
          if (spec.repeat) extra[spec.repeat.column] = u;
          const key = `${r.row}:${c.letter}${pieces.length > 1 ? `:${pi + 1}` : ""}${u !== null ? `:${u}` : ""}`;
          rows.push({ row: r.row, key, block: r.block, cells: r.cells, extra, src: r.src });
        }
      });
      if (rows.length > UNPIVOT_MAX_ROWS) throw new ImportError(`unpivot makes more than ${UNPIVOT_MAX_ROWS} rows. Narrow the columns`);
    }
  }
  const columns: DraftColumn[] = [...keep, ...added.map((name) => ({ name, header: "", letter: null, index: null }))];
  const notes = {
    ...shaped.notes,
    unpivot: {
      sourceRows: shaped.rows.length,
      columns: targets.map((c) => c.letter),
      rows: rows.length,
      ...(spec.keepEmpty ? {} : { skippedEmptyCells: skipped }),
      ...(overflow > 0 ? { repeatNote: `${overflow} rows have a quantity above the ${spec.repeat!.labels.length} labels in repeat (up to ${maxCount}); only the first ${spec.repeat!.labels.length} units were made. Give more labels.` } : {}),
    },
  };
  const defaultKeys = [SOURCE_CELL_COLUMN, ...(spec.tokens ? [spec.valueColumn] : []), ...(spec.repeat ? [spec.repeat.column] : [])];
  return { columns, rows, notes, defaultKeys };
}

/** 形を整える（form か見出しの行の表 → fillDown → unpivot） */
export function shapeImport(t: RawTable, opts: ShapeOptions): ShapedImport {
  if (opts.form !== undefined && opts.unpivot !== undefined) throw new ImportError("form and unpivot cannot be used together");
  let shaped: ShapedImport;
  if (opts.form !== undefined) shaped = formShape(t, opts.form);
  else {
    if (opts.headerRow === undefined) throw new ImportError("headerRow is needed (or form)");
    shaped = tableShape(t, opts.headerRow);
  }
  if (opts.fillDown !== undefined) applyFillDown(t, shaped, opts.fillDown);
  if (opts.unpivot !== undefined) shaped = applyUnpivot(t, shaped, opts.unpivot, opts.headerRow);
  return shaped;
}

/** 複数のシートを 1 つの表にするときの、シートの名前の列 */
export const SHEET_COLUMN = "SHEET";

function addCounts(to: Record<string, number>, from: unknown): void {
  if (!from || typeof from !== "object") return;
  for (const [k, v] of Object.entries(from as Record<string, unknown>)) if (typeof v === "number") to[k] = (to[k] ?? 0) + v;
}

/**
 * 複数のシート（4 月〜9 月など）を同じ読み方で整え、1 つの表にする。SHEET 列にシートの名前、rowKey は「シート:行」。
 * BLOCK は通し番号にする。1 つなら shapeImport と同じ
 */
export function shapeImportMany(tables: readonly RawTable[], opts: ShapeOptions): ShapedImport {
  if (tables.length === 1) return shapeImport(tables[0] as RawTable, opts);
  const columns: DraftColumn[] = [{ name: SHEET_COLUMN, header: "", letter: null, index: null }];
  const byName = new Map<string, DraftColumn>();
  const rows: DraftRow[] = [];
  const sheets: Array<Record<string, unknown>> = [];
  const missing: Record<string, number> = {};
  const filled: Record<string, number> = {};
  const unpivot: Record<string, number> = {};
  let forms = 0;
  let firstKeys: string[] = [SOURCE_ROW_COLUMN];
  tables.forEach((t, ti) => {
    let s: ShapedImport;
    try {
      s = shapeImport(t, opts);
    } catch (e) {
      if (e instanceof ImportError) throw new ImportError(`${t.name}: ${e.message}`);
      throw e;
    }
    if (ti === 0) firstKeys = s.defaultKeys;
    for (const c of s.columns) {
      if (byName.has(c.name)) continue;
      const col: DraftColumn = { name: c.name, header: c.header, letter: null, index: null };
      byName.set(c.name, col);
      columns.push(col);
    }
    for (const r of s.rows) {
      const extra: Record<string, CellValue> = { [SHEET_COLUMN]: t.name };
      for (const c of s.columns) extra[c.name] = valueOf(c, r);
      const block = r.block === null ? null : r.block + forms;
      if (block !== null) extra[BLOCK_COLUMN] = block;
      rows.push({ row: r.row, key: `${t.name}:${r.key}`, block, cells: [], extra, src: {} });
    }
    const n = typeof s.notes.forms === "number" ? s.notes.forms : 0;
    sheets.push({ name: t.name, rows: s.rows.length, ...(opts.form !== undefined ? { forms: n } : {}) });
    forms += n;
    addCounts(missing, s.notes.missingFields);
    addCounts(filled, s.notes.filledDown);
    addCounts(unpivot, s.notes.unpivot);
  });
  const notes: Record<string, unknown> = { sheets };
  if (opts.form !== undefined) notes.forms = forms;
  if (Object.keys(missing).length > 0) notes.missingFields = missing;
  if (opts.fillDown !== undefined) notes.filledDown = filled;
  if (opts.unpivot !== undefined) notes.unpivot = unpivot;
  return { columns, rows, notes, defaultKeys: [SHEET_COLUMN, ...firstKeys] };
}

export interface BuildShapedOptions {
  name: string;
  source: Extract<SheetSource, { kind: "excel" }>;
  rename?: Readonly<Record<string, string>>;
  keyColumns?: readonly string[];
}

/** 形を整えた表を作業画面のシートにする。SOURCE_ROW は元の行番号（rowKey は行番号、unpivot では行と列） */
export function buildShapedSheet(shaped: ShapedImport, opts: BuildShapedOptions): { meta: SheetMeta; rows: SheetRow[]; notes: Record<string, unknown> } {
  const rename = opts.rename ?? {};
  for (const from of Object.keys(rename)) {
    if (!shaped.columns.some((c) => c.name === from)) throw new ImportError(`${from} in rename is not a column`);
  }
  const names = new Set<string>([SOURCE_ROW_COLUMN]);
  const schema: ColumnSchema[] = [{ name: SOURCE_ROW_COLUMN, title: "Source row", type: "integer", readOnly: true }];
  const finalNames = shaped.columns.map((c) => {
    const name = (rename[c.name] ?? c.name).trim();
    if (name === "" || name === "__proto__") throw new ImportError(`${c.name} → ${JSON.stringify(name)} in rename cannot be used as a column name`);
    if (names.has(name)) throw new ImportError(`Column name ${name} is used twice (check rename)`);
    names.add(name);
    return name;
  });
  shaped.columns.forEach((c, i) => {
    const values = shaped.rows.map((r) => valueOf(c, r)).filter((v) => !isBlank(v));
    const fixed = c.name === BLOCK_COLUMN ? "integer" : c.name === SOURCE_CELL_COLUMN || c.name === SHEET_COLUMN ? "string" : null;
    const col: ColumnSchema = { name: finalNames[i] as string, type: fixed ?? inferType(values) };
    // 画面の見出しの 2 段目: 帳票のラベル・元の見出し（名前を変えたときは元の名前）
    const title = c.header !== "" ? c.header : c.name;
    if (title !== col.name) col.title = title;
    if (fixed !== null) col.readOnly = true;
    schema.push(col);
  });
  const keyColumns = opts.keyColumns !== undefined && opts.keyColumns.length > 0 ? [...opts.keyColumns] : shaped.defaultKeys.map((k) => rename[k]?.trim() || k);
  for (const k of keyColumns) {
    if (!names.has(k)) throw new ImportError(`Key column ${k} is not a column (use the names after rename)`);
  }
  const seen = new Set<string>();
  const rows: SheetRow[] = [];
  for (const r of shaped.rows) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    const values: Record<string, CellValue> = { [SOURCE_ROW_COLUMN]: r.row };
    shaped.columns.forEach((c, i) => {
      const s = schema[i + 1] as ColumnSchema;
      values[s.name] = cellFor(valueOf(c, r) ?? undefined, s.type);
    });
    rows.push({ rowKey: r.key, parentKey: r.key, childName: null, values });
  }
  const meta: SheetMeta = { name: opts.name, source: opts.source, columns: schema, keyColumns, childIdAttrs: {} };
  return { meta, rows, notes: shaped.notes };
}

/** describe_import の手がかり: 同じ回数ずつ出てくるラベル（同じ形の帳票が並んでいるシート） */
export interface FormHint {
  forms: number;
  labels: string[];
  firstRows: number[];
  /** 帳票の始まりの行（最初のラベルの行）にある、毎回は出てこない文字（表題が 2 種類ある、など）と回数 */
  titles?: Array<{ text: string; count: number }>;
}

export function formHint(t: RawTable, scanRows = 5_000): FormHint | null {
  const seen = new Map<string, { text: string; rows: number[] }>();
  for (const r of t.rows.slice(0, scanRows)) {
    const inRow = new Set<string>();
    for (const v of r.cells) {
      if (typeof v !== "string") continue;
      const text = headerText(v);
      const key = normLabel(text);
      if (key === "" || key.length > 30 || /^[-+]?[\d,.]+$/.test(key) || inRow.has(key)) continue;
      inRow.add(key);
      const e = seen.get(key) ?? { text, rows: [] };
      e.rows.push(r.row);
      seen.set(key, e);
    }
  }
  // 同じ回数（3 回以上）出てくるラベルが 4 つ以上あれば、帳票が並んでいると見る
  const byCount = new Map<number, Array<{ text: string; rows: number[] }>>();
  for (const e of seen.values()) {
    if (e.rows.length < 3) continue;
    byCount.set(e.rows.length, [...(byCount.get(e.rows.length) ?? []), e]);
  }
  let best: Array<{ text: string; rows: number[] }> = [];
  for (const list of byCount.values()) if (list.length > best.length || (list.length === best.length && (list[0]?.rows.length ?? 0) > (best[0]?.rows.length ?? 0))) best = list;
  if (best.length < 4) return null;
  best.sort((a, b) => (a.rows[0] as number) - (b.rows[0] as number));
  const first = best[0]!;
  const hint: FormHint = { forms: first.rows.length, labels: best.slice(0, 20).map((e) => e.text), firstRows: first.rows.slice(0, 5) };
  // 始まりの行にある、ラベルではない文字（「作業日報」22 回と「作業報告書」4 回のような表題の違い）
  const labelKeys = new Set(best.map((e) => normLabel(e.text)));
  const startRows = new Set(first.rows);
  const titles = new Map<string, { text: string; count: number }>();
  for (const r of t.rows) {
    if (!startRows.has(r.row)) continue;
    for (const v of r.cells) {
      if (typeof v !== "string") continue;
      const key = normLabel(v);
      if (key === "" || labelKeys.has(key) || key.length > 30) continue;
      const e = titles.get(key) ?? { text: key, count: 0 };
      e.count++;
      titles.set(key, e);
    }
  }
  const list = [...titles.values()].filter((e) => e.count < first.rows.length).sort((a, b) => b.count - a.count).slice(0, 5);
  if (list.length > 0) hint.titles = list;
  return hint;
}

/** describe_import の手がかり: 結合したセル（"A5:A7" の形で先頭から） */
export function mergeSummary(t: RawTable, max = 10): { count: number; first: string[] } | null {
  const m = t.merges ?? [];
  if (m.length === 0) return null;
  return { count: m.length, first: m.slice(0, max).map((x) => `${columnLetter(x.c1)}${x.r1}:${columnLetter(x.c2)}${x.r2}`) };
}
