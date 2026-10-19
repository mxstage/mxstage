// フォルダを中身ごと写す（fs.cpSync の代わり）。
// Node 22（2026-10 に確かめた 22.19）の Windows では、fs.cpSync が日本語・全角の括弧を含む場所（「北部クリーンセンター（本番）」
// 「OneDrive - 北部CC 保守」など）でプロセスごと落ちる（Segmentation fault）。接続先の名前や利用者名は日本語のことが多いので、
// ファイルを 1 つずつ写す。overwrite: false なら、既にあるファイルは上書きしない（足し合わせにする）。シンボリックリンクは写さない。

import { constants, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function copyTree(from: string, to: string, opts: { overwrite?: boolean; errorOnExist?: boolean } = {}): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dst, opts);
    } else if (entry.isFile()) {
      try {
        copyFileSync(src, dst, opts.overwrite === true ? 0 : constants.COPYFILE_EXCL);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || opts.errorOnExist === true) throw e;
      }
    }
  }
}
