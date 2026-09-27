// ストアが投げる型付きエラー。ツール層はこれを INVALID_ARGS などに変換して LLM に返す。

export type StoreErrorCode =
  | "sheet_not_found"
  | "column_not_found"
  | "batch_not_found"
  | "batch_already_undone"
  | "job_not_found"
  | "read_only_column"
  | "invalid_filter"
  | "invalid_cursor"
  | "invalid_args";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: StoreErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.detail = detail;
  }
}

export function isStoreError(e: unknown): e is StoreError {
  return e instanceof StoreError;
}
