// 画面の骨組み（Root・トースト・ダイアログなど）の文言。英語が正、日本語は同じ形（src/shared/i18n.ts）。

import { defineMessages } from "../../shared/i18n";

export const uiMessages = defineMessages(
  {
    workEnded: "Work ended. A new session has started.",
    /** 作業の既定の名前（上部バーの ○ のツールチップと get_status に出る） */
    workspaceName: (when: string) => `Session ${when}`,
    close: "Close",
    status: { error: "Error", warning: "Warning", success: "Success", info: "Information" },
    drop: {
      tooLarge: (name: string, mb: number) => `${name} is too large (up to ${mb} MB).`,
      received: (name: string) => `Received ${name}. Ask Claude to "import the dropped file".`,
      unreadable: (name: string) => `Could not read ${name}.`,
      /** Claude が送ったファイルが届いた・届かなかった */
      imported: (name: string) => `Received the file ${name}. Claude will check its contents and turn it into a sheet.`,
      importFailed: (reason: string) => `Could not receive the file (${reason}).`,
    },
    updateReady: "A new version is ready. Close this tab and open it again to switch to it.",
  },
  {
    workEnded: "作業を終了しました。新しい作業を始めます。",
    workspaceName: (when) => `作業 ${when}`,
    close: "閉じる",
    status: { error: "エラー", warning: "注意", success: "完了", info: "お知らせ" },
    drop: {
      tooLarge: (name, mb) => `${name} は大きすぎます（${mb}MB まで）。`,
      received: (name) => `${name} を受け取りました。Claude に「ドロップしたファイルを取り込んで」と伝えてください。`,
      unreadable: (name) => `${name} を読み取れませんでした。`,
      imported: (name) => `ファイル ${name} を受け取りました。Claude が中身を確かめてシートにします。`,
      importFailed: (reason) => `ファイルを受け取れませんでした（${reason}）`,
    },
    updateReady: "新しい版を用意しました。このタブを閉じて開き直すと入れ替わります。",
  },
);
