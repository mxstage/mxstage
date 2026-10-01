// 作業タブのデータストア（正本）の公開口。

export { StoreError, isStoreError, type StoreErrorCode } from "./errors";
export { compileFilters, compareValues, inListMatcher, likeMatcher, valuesEqual, type RowGetter, type RowPredicate } from "./filters";
export { JobRegistry, type JobKind, type JobRegistryOptions } from "./jobs";
export { NORMALIZE_ORDER, normalizeCompositeKey, normalizeKey, normalizeText, type CompositeKey } from "./normalize";
export { decodeCursor, encodeCursor } from "./paging";
export { Sheet, type CellInfo, type CellOverlay, type RowMark, type RowStatus, type SheetCounts, type SheetJSON, type ViewKind } from "./sheet";
export {
  coerceValue,
  formatDateForDisplay,
  isBlank,
  normalizeDateInput,
  offsetOfValue,
  parseDateInput,
  parseIsoDate,
  sameCellValue,
  toNumber,
  type CoerceOptions,
  type CoerceResult,
  type DateOffsetHint,
  type DateParts,
  type ParsedDate,
} from "./values";
export {
  WORKSPACE_FORMAT,
  Workspace,
  type AddRowsOptions,
  type AggregateOptions,
  type AggregateResult,
  type BatchOpState,
  type ChangeEvent,
  type ChangeKind,
  type ChangeListener,
  type DiffItem,
  type DiffOptions,
  type DiffResult,
  type EditOptions,
  type EditingCell,
  type ParentReplacement,
  type ReplaceParentsOptions,
  type ReplaceParentsResult,
  type SheetChanges,
  type QueryRow,
  type QueryRowsOptions,
  type QueryRowsResult,
  type RuleOptions,
  type RuleResult,
  type UndoOptions,
  type WorkspaceJSON,
  type WorkspaceOptions,
  type WorkspaceStatus,
} from "./workspace";
