// 橋渡しの試験で、利用者の「ドキュメント」に書かないようにする（接続先の既定のフォルダ。src/bridge/documentsDir.ts）。
// 試験ごとに DictionaryStore の documentsDir を渡すが、渡し忘れても一時フォルダに書く。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MXSTAGE_DOCUMENTS_DIR = mkdtempSync(join(tmpdir(), "mxstage-documents-"));
