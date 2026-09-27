// Excel・CSV の取り込み（作業画面に届いたファイルを読み、シートにする）。

export { installImportDrop, type ImportDropOptions } from "./drop";
export { IMPORT_KEEP_FILES, ImportStore, parseImportFile, type ImportEntry } from "./store";
export {
  buildImportSheet,
  columnLetter,
  dataRows,
  detectMxLoader,
  headerCandidates,
  headerText,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
  ImportError,
  importColumns,
  SOURCE_ROW_COLUMN,
  suggestedHeaderRow,
  type BuiltImport,
  type HeaderCandidate,
  type ImportColumn,
  type ImportWorkbook,
  type MxLoaderInfo,
  type RawRow,
  type RawTable,
} from "./table";
