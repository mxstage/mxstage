// 作業画面にドロップされたファイルを取り込みとして受け取る。
// - Claude がファイルを送れないとき（チャットに添えたファイルのパスが分からないなど）の受け口。
//   作業画面が取り込み番号を作って受け取り、get_status の imports に出す。
// - ドロップしたファイルをブラウザが開いて作業画面から離れないよう、ファイルのドロップは必ず止める。

import { IMPORT_MAX_BYTES, toHex } from "../relay";
import type { ImportStore } from "./store";

export interface ImportDropOptions {
  win: Window;
  store: ImportStore;
  notify: (text: string, tone?: "info" | "error") => void;
  /** 試験用 */
  newId?: () => string;
  digest?: (bytes: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;
  maxBytes?: number;
}

function randomId(win: Window): string {
  const b = new Uint8Array(9);
  win.crypto.getRandomValues(b);
  return `drop-${toHex(b)}`;
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

export function installImportDrop(opts: ImportDropOptions): () => void {
  const { win, store, notify } = opts;
  const maxBytes = opts.maxBytes ?? IMPORT_MAX_BYTES;
  const newId = opts.newId ?? (() => randomId(win));
  const digest = opts.digest ?? ((bytes) => win.crypto.subtle.digest("SHA-256", bytes));

  const onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };

  const receive = async (file: File) => {
    if (file.size > maxBytes) {
      notify(`${file.name} は大きすぎます（${Math.round(maxBytes / 1024 / 1024)}MB まで）。`, "error");
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let sha256 = "";
      try {
        sha256 = toHex(new Uint8Array(await digest(bytes)));
      } catch {
        // チェックサムが無くても取り込みはできる
      }
      const importId = newId();
      store.add({ importId, fileName: file.name, contentType: file.type || "application/octet-stream", bytes, sha256 }, { dropped: true });
      notify(`${file.name} を受け取りました。Claude に「ドロップしたファイルを取り込んで」と伝えてください。`);
    } catch {
      notify(`${file.name} を読み取れませんでした。`, "error");
    }
  };

  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    for (const file of Array.from(e.dataTransfer?.files ?? [])) void receive(file);
  };

  win.addEventListener("dragover", onDragOver);
  win.addEventListener("drop", onDrop);
  return () => {
    win.removeEventListener("dragover", onDragOver);
    win.removeEventListener("drop", onDrop);
  };
}
