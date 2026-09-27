// タブ（正本）とツール定義で共有するデータモデルの型。
// ランタイム非依存。zod スキーマは toolDefs.ts に置き、ここは TypeScript の型だけにする。

export type CellValue = string | number | boolean | null;

/** Maximo の oslc.where とタブ内の絞り込みの両方に使う型付きフィルタ。LLM の文字列を where に直接入れないための形 */
export type FilterOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "notin" | "like" | "isnull" | "notnull";

export interface TypedFilter {
  /** 属性名（Maximo）または列名（シート）。子は "EXT_WOPERMIT.EXT_PERMITDATE" のようにドットでつなぐ */
  attr: string;
  op: FilterOp;
  value?: CellValue | CellValue[];
}

export type ColumnType = "string" | "number" | "integer" | "boolean" | "date" | "datetime" | "unknown";

export interface ColumnSchema {
  /** 列名。子オブジェクトの属性は "EXT_WOPERMIT.EXT_PERMITDATE" */
  name: string;
  title?: string;
  type: ColumnType;
  maxLength?: number;
  required?: boolean;
  /** Maximo 側で更新できない列（キー、システム列など） */
  readOnly?: boolean;
  /** 子オブジェクトの列ならその名前（例 "EXT_WOPERMIT"） */
  child?: string;
}

export type SheetSource =
  | {
      kind: "maximo";
      /** 読み込みに使ったオブジェクト構造。Maximo への反映もこの構造のレコード（/api/os/<os>/...）にだけ送る */
      os: string;
      mbo?: string;
      select: string[];
      where: TypedFilter[];
      orderBy?: string[];
      maxRows?: number;
      /** 読み込んだ Maximo の接続先。反映はこの接続先に接続しているときだけ行う */
      baseUrl?: string;
      /** 読み込みに使ったオブジェクト構造の定義の版（作業画面のカタログに保存した時刻）。反映の前に今の定義と比べる */
      structureLoadedAt?: number;
    }
  | {
      kind: "excel";
      importId: string;
      fileName: string;
      sheetName: string;
      headerRow: number;
    };

export interface SheetSummary {
  name: string;
  source: SheetSource;
  rowCount: number;
  columns: ColumnSchema[];
  keyColumns: string[];
  changedCells: number;
  addedRows: number;
  deletedRows: number;
}

export interface CellEdit {
  /** 行キー。getRowKey で作る安定したキー（親キー＋子の一意 ID） */
  rowKey: string;
  col: string;
  value: CellValue;
  /** このセルだけの根拠（例 (b) の TAGNO の選定理由）。無ければバッチの reason */
  reason?: string;
}

/** apply_rule の 1 列分の更新規則。行データを LLM に通さずタブ内で評価する */
export type RuleValue =
  | { const: CellValue }
  | { copyFrom: string }
  | {
      lookup: {
        sheet: string;
        /** このシート側の突合列。複合キー（例 ["SITEID","EXT_EQUIPTAG"]）は配列で、targetMatchCol と同じ順・同じ個数にする */
        matchCol: string | string[];
        targetMatchCol: string | string[];
        sourceCol: string;
        normalize?: NormalizeOption[];
      };
    };

export type NormalizeOption = "trim" | "upper" | "lower" | "nfkc" | "removeSpaces" | "removeHyphens";

export type BatchAuthor = "user" | "llm";

export interface BatchInfo {
  batchId: string;
  author: BatchAuthor;
  reason?: string;
  createdAt: number;
  opCount: number;
  sheet: string;
  undone: boolean;
}

export interface ConflictInfo {
  rowKey: string;
  col: string;
  reason: "changed_since_read" | "user_editing" | "read_only_column" | "row_not_found" | "column_not_found" | "invalid_value" | "lookup_ambiguous";
}

/** apply_rule の lookup 1 列分の突合結果。unmatched は変更せずスキップ、ambiguous（参照先に複数候補）は変更せず conflicts に lookup_ambiguous で載せる */
export interface LookupStats {
  matched: number;
  unmatched: number;
  ambiguous: number;
}

export interface ApplyResult {
  batchId: string | null;
  applied: number;
  conflicts: ConflictInfo[];
  revision: number;
  /** apply_rule で lookup を使った列ごとの突合件数 */
  lookup?: Record<string, LookupStats>;
}

export interface DiffEntry {
  rowKey: string;
  col: string;
  before: CellValue;
  after: CellValue;
  author: BatchAuthor;
  batchId: string;
}

export interface MatchSummary {
  matched: number;
  unmatchedLeft: number;
  unmatchedRight: number;
  ambiguous: number;
  samples: {
    matched: Array<{ leftRowKey: string; rightRowKey: string; key: string }>;
    unmatchedLeft: Array<{ rowKey: string; key: string }>;
    unmatchedRight: Array<{ rowKey: string; key: string }>;
    ambiguous: Array<{ leftRowKey: string; key: string; candidates: string[] }>;
  };
}

export type CommitState = "idle" | "requested" | "running" | "done" | "failed";

export interface CommitRowResult {
  rowKey: string;
  status: "verified" | "conflict" | "error" | "unknown" | "skipped";
  httpStatus?: number;
  reasonCode?: string;
  message?: string;
}

export interface CommitStatus {
  sheet: string;
  state: CommitState;
  note?: string;
  requestedAt?: number;
  results: CommitRowResult[];
}

export type JobState = "running" | "done" | "failed" | "cancelled";

export interface JobStatus {
  jobId: string;
  kind: "load_sheet" | "apply_rule" | "import";
  state: JobState;
  progress: number;
  total?: number;
  message?: string;
  result?: Record<string, unknown>;
}
