// 作業画面に届いたファイル（Claude が curl で送ったもの・利用者がドロップしたもの）を持っておき、読み取った結果を使い回す。
// ファイルはタブのメモリにだけ置く（保存しない）。タブを閉じる・再読み込みする・作業終了で消える。

import type { ImportedFile } from "../relay";
import { parseCsv } from "./csv";
import { ImportError, type ImportWorkbook } from "./table";
import { isOleFile, isZipFile, parseXlsx } from "./xlsx";

/** 持っておくファイルの数。超えたら古いものから捨てる */
export const IMPORT_KEEP_FILES = 5;

export interface ImportEntry {
  importId: string;
  fileName: string;
  bytes: number;
  sha256: string;
  receivedAt: number;
  /** 利用者が作業画面にドロップしたファイルか（false は Claude が送ったもの） */
  dropped: boolean;
}

/** ファイルの中身から形式を決めて読む（拡張子より中身を信じる） */
export async function parseImportFile(fileName: string, bytes: Uint8Array): Promise<ImportWorkbook> {
  if (isZipFile(bytes) || isOleFile(bytes)) return parseXlsx(bytes);
  if (/\.(xlsx|xlsm|xls|xlsb)$/i.test(fileName)) throw new ImportError(`${fileName} cannot be read as an Excel file (its contents are not in Excel format).`);
  return parseCsv(bytes, fileName);
}

interface Held {
  entry: ImportEntry;
  file: ImportedFile;
  parsed: Promise<ImportWorkbook> | null;
}

export class ImportStore {
  private readonly held = new Map<string, Held>();
  private readonly listeners = new Set<(entry: ImportEntry) => void>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** ファイルを受け取る。同じ importId は置き換える */
  add(file: ImportedFile, opts: { dropped?: boolean } = {}): ImportEntry {
    const entry: ImportEntry = {
      importId: file.importId,
      fileName: file.fileName,
      bytes: file.bytes.byteLength,
      sha256: file.sha256,
      receivedAt: this.now(),
      dropped: opts.dropped === true,
    };
    this.held.delete(file.importId);
    this.held.set(file.importId, { entry, file, parsed: null });
    while (this.held.size > IMPORT_KEEP_FILES) {
      const oldest = this.held.keys().next().value as string;
      this.held.delete(oldest);
    }
    for (const l of Array.from(this.listeners)) {
      try {
        l(entry);
      } catch {
        // 表示側の失敗で受け取りを止めない
      }
    }
    return entry;
  }

  /** 受け取ったファイル（新しい順） */
  list(): ImportEntry[] {
    return Array.from(this.held.values(), (h) => h.entry).reverse();
  }

  get(importId: string): ImportEntry | null {
    return this.held.get(importId)?.entry ?? null;
  }

  /** 読み取った結果。1 回だけ読み、以後は同じ結果を返す（失敗したら次は読み直す） */
  workbook(importId: string): Promise<ImportWorkbook> {
    const h = this.held.get(importId);
    if (h === undefined) return Promise.reject(new ImportError(`The file for import ${importId} is not in the work screen.`));
    if (h.parsed === null) {
      const parsed = parseImportFile(h.file.fileName, h.file.bytes);
      h.parsed = parsed;
      parsed.catch(() => {
        if (h.parsed === parsed) h.parsed = null;
      });
    }
    return h.parsed;
  }

  subscribe(listener: (entry: ImportEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.held.clear();
  }
}
