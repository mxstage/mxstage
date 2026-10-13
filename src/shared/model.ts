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
  /**
   * Maximo のスキーマ（jsonschemas）がこの属性に値の一覧（ドメイン・参照先の表）があると示した（hasList）。
   * スキーマに印が無かった（古い定義・Excel のシート）ときは省略する
   */
  hasList?: boolean;
  /** 見出しに列名（2 段目）を出さない（辞書のシートの FIND など、利用者に意味の無い列名） */
  hideName?: boolean;
  /** 値の表示名（例 text → そのまま）。値そのものは変えず、画面の表示だけに使う */
  valueLabels?: Record<string, string>;
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
    }
  | {
      /** 客先の辞書（src/app/dictionaries）。Maximo には反映せず、保存すると共有フォルダに書く */
      kind: "dictionary";
      dictionaryId: string;
      dictionaryName: string;
      dictKind: "alias" | "code" | "value";
      /** 辞書のある接続先（保存した接続先の ID・デモの ID・保存していない接続先の Maximo の URL） */
      scope: string;
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
        /** このシート側の突合列。複合キー（例 ["SITEID","EXT_EQUIPTAG"]）は配列で、targetMatchCol と同じ順・同じ個数にする。contains か dateWithin があれば省ける */
        matchCol?: string | string[];
        targetMatchCol?: string | string[];
        sourceCol: string;
        normalize?: NormalizeOption[];
      } & MatchConditions;
    }
  | {
      /**
       * 言葉 → コードの辞書で、文に出てくる言葉からコードを決める（1 つに決まる行だけ。2 つ以上は ambiguous）。
       * textCol の文（複数なら空白でつなぐ）に当て、field の項目の項目だけを使う。scopeCol があれば、その値の行だけに当てる項目も使う
       */
      classify: {
        dictionary: string;
        textCol: string | string[];
        field: string;
        scopeCol?: string;
      };
    }
  | {
      /** 値の置き換えの辞書で、列の値を正しい値にする（fromCol を省くとその列の値。当たらない行は変えない） */
      replace: {
        dictionary: string;
        fromCol?: string;
      };
    }
  | {
      /**
       * 行の時期で値を選ぶ（作業指示・注文書などのステータス）。日付は YYYY-MM-DD で比べる。
       * 終わりの日が asOf 以前なら past、始まりの日が asOf 以前なら inProgress、どれかの日付（予定の日を含む）があれば future、日付が無ければ変えない
       */
      phase: {
        /** 終わりの日の列（ACTFINISH・TARGCOMPDATE など） */
        finish?: string;
        /** 始まりの日の列（ACTSTART など） */
        start?: string;
        /** 予定の日の列（TARGSTARTDATE・SCHEDSTART など）。実績の日付が無い行を future にするためだけに使う */
        planned?: string;
        /** 過去の行の値（ツールでは省くと接続先の設定。既定 COMP） */
        past?: CellValue;
        inProgress: CellValue;
        future: CellValue;
        /** 比べる日（YYYY-MM-DD）。省くと今日 */
        asOf?: string;
        /** 新しく足した行だけを変える（既定 true。今ある記録のステータスは、そのまま中身を直す） */
        newRowsOnly?: boolean;
      };
    };

export type NormalizeOption = "trim" | "upper" | "lower" | "nfkc" | "removeSpaces" | "removeHyphens";

/**
 * 突合の追加の条件（match_sheets と apply_rule の lookup で共通）。決まりは AI が作り、照合はタブ内のプログラムが行う。
 * 候補が 1 件に決まる行だけを結び、0 件・2 件以上の行は結ばずに返す。
 * col はこの側（match_sheets では左、lookup ではこのシート）、targetCol は相手側（右、参照先のシート）の列。
 */
export interface MatchConditions {
  /** 正規化の後に、両側の文字列へ順に当てる置き換え（正規表現、すべての一致を置き換える）。通称をそろえる。例: find "#(\d)"、replace "$1号炉" */
  rewrite?: Array<{ find: string; replace: string }>;
  /** この側の文（col）に、相手の名前（targetCol）が含まれる。via で、相手の列の値から別のシートの名前を引ける（例: ASSETNUM → 資産の DESCRIPTION） */
  contains?: { col: string; targetCol: string; via?: { sheet: string; matchCol: string; sourceCol: string } };
  /** この側の日付（col）が、相手の始まりの日〜終わりの日（両端を含む）に入る。targetEnd が無いか空なら始まりの日だけ */
  dateWithin?: { col: string; targetStart: string; targetEnd?: string };
  /** 相手側の行を絞る条件（例: 修理の行は WORKTYPE が CM・EM の作業指示だけ） */
  targetFilter?: TypedFilter[];
  /** この側の列。同じ値の行を 1 つの帳票とみなし、1 件に決まった行の相手がそろって 1 件なら、帳票の全行をその相手に結ぶ */
  group?: string;
  /** 「同上」の行: col が pattern（正規表現）に合い、自分では 1 件に決まらない行は、真上の行が 1 件に決まっていればその相手を引き継ぐ */
  followsAbove?: { col: string; pattern: string };
  /** 客先の辞書（呼び名）の名前。この側の文にだけ、ほかの条件の前に当てる（作業画面で開いている辞書） */
  dictionaries?: string[];
}

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

/** apply_rule の phase 1 列分の内訳。noDate（日付が無い）と existing（newRowsOnly で今ある行）は変えない */
export interface PhaseStats {
  past: number;
  inProgress: number;
  future: number;
  noDate: number;
  existing: number;
  asOf: string;
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
  /** apply_rule で phase を使った列ごとの内訳 */
  phase?: Record<string, PhaseStats>;
  /** apply_rule で classify・replace を使った列ごとの件数（matched は値を決めた行、unmatched は当たらなかった行、ambiguous は 2 つ以上に分かれた行） */
  dictionary?: Record<string, LookupStats>;
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
  /** matched のうち、同じ帳票（group）の別の行の結果で結んだもの */
  matchedByGroup?: number;
  /** matched のうち、「同上」として真上の行の相手を引き継いだもの */
  matchedByAbove?: number;
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
