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
    updateAvailable: (version: string) => `MX Stage ${version} is available. See Settings → Updates.`,
    handoff: {
      elsewhere: (n: number) => `The work (${n} ${n === 1 ? "sheet" : "sheets"}) is open in another window. Your AI assistant's tools work in that window too.`,
      move: "Move it to this window",
      moving: "Moving…",
      movedHere: "Moved the work to this window. Your AI assistant's tools now work here.",
      movedAway: "The work was moved to another window.",
      restored: "Reopened with your work kept.",
      lost: "The work kept for the reload could not be restored (it is kept for 10 minutes, and only while MX Stage is running).",
      failed: {
        no_source: "No other window has work to move.",
        committing: "The other window is committing to Maximo. Try again when it has finished.",
        loading: "The other window is still loading data. Try again when it has finished.",
        timeout: "The other window did not respond. Check that it is still open.",
        too_large: "The work is too large to move.",
        invalid: "This window could not read the work. It stays in the other window.",
        unavailable: "Could not move the work. Run the setup again if the bridge is an older version.",
      },
    },
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
    updateAvailable: (version) => `MX Stage の新しい版 ${version} があります。設定の「更新」で入れられます。`,
    handoff: {
      elsewhere: (n) => `作業（シート ${n} 枚）は別の窓で開いています。AI アシスタントのツールもその窓で動いています。`,
      move: "この窓に移す",
      moving: "移しています…",
      movedHere: "作業をこの窓に移しました。AI アシスタントのツールもこの窓で動きます。",
      movedAway: "作業を別の窓に移しました。",
      restored: "作業を引き継いで開き直しました。",
      lost: "再読み込みのあいだ預けた作業を戻せませんでした（預かるのは 10 分間、MX Stage が動いている間だけです）。",
      failed: {
        no_source: "移せる作業のある窓がありません。",
        committing: "別の窓で Maximo への反映をしています。終わってからもう一度試してください。",
        loading: "別の窓でまだデータを読み込んでいます。終わってからもう一度試してください。",
        timeout: "作業のある窓が応答しませんでした。その窓が開いたままか確かめてください。",
        too_large: "作業が大きすぎて移せません。",
        invalid: "この窓で作業を読み取れませんでした。作業は元の窓に残っています。",
        unavailable: "作業を移せませんでした。橋渡しが古い版なら、導入をやり直してください。",
      },
    },
  },
);
