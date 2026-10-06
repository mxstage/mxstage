// 設定画面・API キーの保管（keyvault）・オブジェクト構造のカタログ・ファイルの受け取りの文言。
// 英語が正、日本語は同じ形（src/shared/i18n.ts）。使うときに m() を呼ぶ（言語は途中で変わる）。
//
// keyvault の Worker の中では言語を切り替えないので、Worker が返す文言はいつも英語になる。
// 画面に出すときは localizeVaultMessage で今の言語に直す（LLM に渡る Maximo のエラーは英語のまま）。

import { defineMessages, getLocale, type MessagesOf } from "../../shared/i18n";

/** 言語の名前（どちらの言語でも、その言語自身の書き方で出す） */
export const LANGUAGE_NAMES = { en: "English", ja: "日本語" } as const;

/** proxy 方式の中継役（このパソコンの橋渡し）。日本語の文の組み立てに使う */
const JA_PROXY = "橋渡し（このパソコンの MX Stage）";
const EN_PROXY = "the bridge (MX Stage on this PC)";
const EN_PROXY_START = "The bridge (MX Stage on this PC)";

const JA_RELOAD_HINT =
  "作業画面を読み込み直してから、もう一度接続してください。直らないときは、作業画面と橋渡しの版が合っていない可能性があります（導入をやり直してください）。";
const EN_RELOAD_HINT =
  "Reload the work screen and connect again. If that does not help, the work screen and the bridge may be different versions (run the setup again).";

const JA_UNREACHABLE = `${JA_PROXY} から Maximo に到達できませんでした。URL を確認してください。Maximo の証明書が私設 CA の場合などは、接続方式を「直結（direct）」にしてください（Maximo 側でこのツールのオリジンと apikey ヘッダを CORS で許可する必要があります）。`;
const EN_UNREACHABLE = `${EN_PROXY_START} could not reach Maximo. Check the URL. If Maximo uses a certificate from a private CA, for example, set the connection method to Direct (Maximo must allow this tool's origin and the apikey header in its CORS settings).`;

/** 更新の失敗の理由（橋渡しの src/bridge/updates.ts が返す短いコード） */
const UPDATE_ERRORS_EN = {
        busy: "Not updated now because work is open (a window has sheets, or the AI is running a tool). It updates when the work is finished.",
        not_main: "Not updated automatically because this copy is not on the main branch.",
        local_changes: "Not updated automatically because this copy has local changes.",
        other_origin: "Not updated automatically because this copy does not come from github.com/mxstage/mxstage.",
        not_git: "This copy was not installed with git, so it cannot update itself.",
        git_failed: "Could not get the new version with git. Check your network, or update by hand.",
        setup_failed: "Got the new version, but the setup failed. Run the setup again by hand.",
        no_asset: "The release has no extension file (.mcpb).",
        no_checksum: "Could not read the checksum of the extension file.",
        checksum_mismatch: "The downloaded file did not match its checksum, so it was discarded.",
        download_failed: "Could not download the extension file.",
        too_large: "The extension file is unexpectedly large, so it was not downloaded.",
        no_release: "No release was found on GitHub.",
      };
const UPDATE_ERRORS_JA: Record<keyof typeof UPDATE_ERRORS_EN, string> = {
        busy: "作業中（シートのある窓があるか、AI がツールを実行中）なので、今は入れ替えていません。作業が終わったら入れ替えます。",
        not_main: "この写しは main ではないので、自動では更新しません。",
        local_changes: "この写しに手元の変更があるので、自動では更新しません。",
        other_origin: "この写しの取得元が github.com/mxstage/mxstage ではないので、自動では更新しません。",
        not_git: "git で入れたものではないので、自分では更新できません。",
        git_failed: "git で新しい版を取れませんでした。ネットワークを確かめるか、手で更新してください。",
        setup_failed: "新しい版は取れましたが、導入に失敗しました。手で導入をやり直してください。",
        no_asset: "リリースに拡張機能のファイル（.mcpb）がありません。",
        no_checksum: "拡張機能のファイルの SHA-256 を読めませんでした。",
        checksum_mismatch: "ダウンロードしたファイルが SHA-256 と合わなかったので、捨てました。",
        download_failed: "拡張機能のファイルをダウンロードできませんでした。",
        too_large: "拡張機能のファイルが大きすぎるので、ダウンロードしませんでした。",
        no_release: "GitHub にリリースが見つかりませんでした。",
      };

export const settingsMessages = defineMessages(
  {
    page: {
      title: "Settings",
      backToApp: "Back to work screen",
      failed: "Something went wrong.",
    },
    // 設定画面のタブ（短く。各タブの中の見出しは各節の title）
    tabs: {
      label: "Settings sections",
      connection: "Connection",
      assistants: "AI assistants",
      skills: "Skills",
      updates: "Updates",
    },
    updates: {
      title: "Updates",
      loading: "Loading…",
      unavailable: "This bridge cannot check for updates. It may be an older version.",
      current: (version: string, kind: string) => `Version ${version} (${kind})`,
      kindGit: "installed with the setup script",
      kindBundle: "Claude Desktop extension",
      autoLabel: "Update automatically",
      on: "On",
      off: "Off",
      autoHelpGit:
        "Once a day, asks GitHub whether a new version exists. When one does, it is installed automatically while no work is open (no window has sheets and the AI is not running a tool), and the bridge restarts.",
      autoHelpBundle:
        "Once a day, asks GitHub whether a new version exists, and tells you here when one does. Claude Desktop manages the extension, so you install the new file with one click.",
      privacy: "Only the latest version number is fetched; nothing about you or your data is sent. While this is off, MX Stage does not contact GitHub (except when you press “Check now”).",
      neverChecked: "Not checked yet.",
      lastChecked: (when: string) => `Last checked: ${when}`,
      checkNow: "Check now",
      checking: "Checking…",
      upToDate: "You have the latest version.",
      available: (version: string) => `Version ${version} is available.`,
      whatsNew: "What's new",
      installGit: "Update now",
      installBundle: "Download and install",
      applying: "Updating… This can take a few minutes. The bridge restarts when it is done; then reopen this screen.",
      downloading: "Downloading…",
      restartNeeded: "Updated. Restart your AI assistant to use the new version.",
      downloaded: "Downloaded and checked the new extension file:",
      installSteps: "In Claude Desktop, open Settings → Extensions → Advanced settings → Install Extension… and choose this file.",
      folderHint: "If the folder did not open, paste the copied path into the File Explorer address bar.",
      copyPath: "Copy path",
      copied: "Copied",
      error: (code: string) => (UPDATE_ERRORS_EN as Record<string, string>)[code] ?? `Could not update (${code}).`,
    },
    language: {
      title: "Language",
      label: "Language",
      help: "Used for the work screen. The AI replies in the language you write in.",
    },
    maximo: {
      title: "Maximo connection",
      pastStatus: {
        label: "Status for past work",
        comp: "Completed (COMP). The records can still be corrected later",
        close: "Closed (CLOSE). Cannot be undone; closed records cannot be changed",
        help: "When the AI registers or updates work whose end date has passed (for example history from Excel), it gives them this status unless you say otherwise. Work in progress and future work get the statuses you agree with the AI. Kept on this PC for this connection.",
      },
      lockedIdle: "The API key was cleared from memory after 30 minutes of inactivity (locked). Connect again.",
      lockedManual: "Disconnected.",
      keyNote:
        "The API key is kept only in this tab's memory (a dedicated Web Worker) and is never saved on a server or in browser storage. Let your browser's password manager remember it.",
      urlLabel: "Maximo URL",
      viaLabel: "Connection method",
      nameLabel: "Connection name",
      keyLabel: "API key",
      connect: "Connect",
      checking: "Checking…",
      connected: "Connected.",
      maximo: "Maximo",
      hostVia: (host: string, direct: boolean) => `${host} (${direct ? "direct" : "proxy"})`,
      user: "Maximo user",
      unknownUser: "(unknown)",
      backToApp: "Back to work screen",
      reconnect: "Use another connection",
      disconnect: "Disconnect",
    },
    saved: {
      title: "Saved connections",
      intro: "Saved on this PC. Every window of the work screen on this PC (the installed app, a browser tab, or the browser inside your AI assistant) connects automatically, even after a restart.",
      protection: (kind: string) =>
        kind === "dpapi"
          ? "The API keys are encrypted by the bridge with Windows data protection (DPAPI) for your Windows user. They are never sent to the browser."
          : kind === "keychain"
            ? "The API keys are encrypted by the bridge with a key kept in the macOS Keychain. They are never sent to the browser."
            : "The API keys are encrypted by the bridge with a key in a file only you can read. They are never sent to the browser.",
      empty: "No saved connections yet. Connect below with “Save on this PC” checked.",
      use: "Connect",
      inUse: "Connected",
      connecting: "Connecting…",
      editKey: "Edit",
      remove: "Delete",
      removeConfirm: (name: string) => `Delete the saved connection “${name}” and its API key from this PC?`,
      saveLabel: "Save on this PC and connect automatically from now on",
      saveDirect: "A direct connection cannot be saved (the API key would have to be in the browser). Use Proxy to save it.",
      editing: (name: string) => `Editing “${name}”. Leave the API key empty to keep the saved key.`,
      cancelEdit: "Cancel editing",
      update: "Save and connect",
      autoFailed: (name: string) => `Could not connect automatically to “${name}”.`,
      autoRetrying: "Retrying automatically.",
      savedBadge: "Saved on this PC",
      unsavedKeyNote:
        "Not saved: the API key is kept only in this tab's memory (a dedicated Web Worker) and is cleared when the tab is reloaded or after 30 minutes of inactivity.",
      problem: {
        invalid_name: "Enter a connection name of 128 characters or fewer.",
        invalid_url: "Use the form https://host[:port] for the Maximo URL (no path).",
        invalid_key: "The API key contains characters that cannot be used.",
        key_required: "Enter the API key.",
        not_found: "This saved connection no longer exists. It may have been deleted in another window.",
        too_many: "You cannot save more than 50 connections. Delete ones you no longer use.",
        unavailable: "This PC could not protect the API key, so it was not saved. Connect without saving.",
        unreadable: "The saved API keys cannot be decrypted on this PC (they were saved by another user or PC). Enter the API key again.",
        bridge_unavailable: "The bridge cannot save connections. It may be an older version. Run the setup again, or connect without saving.",
      },
    },
    via: {
      direct: "Direct (from the browser; Maximo needs CORS settings)",
      proxy: "Proxy (through the bridge on this PC; default)",
    },
    validation: {
      via: "Choose a connection method.",
      urlEmpty: "Enter the Maximo URL.",
      urlFormat: "The URL is not valid (for example, https://maximo.example.com).",
      urlExtras: "Remove the user name, query (?) and # from the URL.",
      urlHttps: "Use an https URL.",
      urlProxyPath: "With proxy, use the form https://host[:port] (no path such as /maximo).",
      urlDemo: "This address is reserved for the built-in demo. Connect to the demo from the Demo tab.",
      nameEmpty: "Enter a connection name (for example, MAXADMIN@mas-dev).",
      nameTooLong: (max: number) => `Use ${max} characters or fewer for the connection name.`,
      keyEmpty: "Enter the API key.",
      keyChars: "The API key contains characters that cannot be used (spaces, line breaks or full-width characters).",
    },
    connectError: {
      forbiddenOrigin: "The request was not accepted as coming from the same origin. Open this page again from the work screen URL.",
      unreachable: EN_UNREACHABLE,
      unreachableStatus: (status: number) => `${EN_UNREACHABLE} (HTTP ${status})`,
      pathNotAllowed: `The request was for a path that ${EN_PROXY} does not forward (it forwards only paths starting with /maximo/api/ and /maximo/oslc/). This is not a problem with the API key. ${EN_RELOAD_HINT}`,
      invalidPath: `The request path contained characters that cannot be used (such as %2e, %2f, ; or ..), so ${EN_PROXY} did not forward it. This is not a problem with the API key. ${EN_RELOAD_HINT}`,
      missingApikey: `The API key did not reach ${EN_PROXY}. Enter the API key again in Settings and connect again.`,
      apikeyInQuery: `The request had the API key in the URL query (?apikey=), so ${EN_PROXY} did not forward it (to keep the key out of history and logs). Enter the API key only in the API key field in Settings, and do not put ? in the Maximo URL.`,
      methodNotAllowed: `${EN_PROXY_START} does not accept this request method (it forwards only GET and POST). This is not a problem with the API key. ${EN_RELOAD_HINT}`,
      upstreamTimeout: `The request from ${EN_PROXY} to Maximo did not return in time. Check that Maximo is running and check your network (VPN, proxy and so on), then connect again.`,
      timeout: "Maximo did not respond in time.",
      directUnreachable:
        "The browser could not reach Maximo directly. Check Maximo's CORS settings (allow this tool's origin and the apikey header) and its certificate, or set the connection method to Proxy.",
      proxyUnreachable: `Could not connect to Maximo. Check that ${EN_PROXY} is running, and check your network.`,
      hostNotAllowed:
        "Connecting to this Maximo host is not allowed (it is not in the bridge's --allow-host list). Add this host to --allow-host when you start the bridge.",
      unauthorized: "The bridge did not accept the request. Restart the bridge and connect again.",
      invalidBase: "Use the form https://host[:port] for the Maximo URL (no path).",
      vaultLocked: "The API key was locked. Connect again.",
      vaultForbiddenDestination: "The API key cannot be sent to this destination. Check the Maximo URL and the connection method.",
      vaultBadRequest: "The API key or the URL contains characters that cannot be used.",
      connectionNotFound: "This saved connection no longer exists on this PC. Choose another one or connect again.",
      connectionUnreadable: "The saved API key cannot be decrypted on this PC (it was saved by another user or PC). Edit the connection and enter the API key again.",
      connectionUnavailable: "The bridge cannot use saved connections. Run the setup again, or connect without saving.",
      invalidKey: "The API key is not valid, or this connection does not have permission.",
      gatewayTimeout: (status: number) => `Maximo did not respond in time (HTTP ${status}).`,
      whoamiNotFound: "whoami was not found. Check the Maximo URL (everything before /maximo).",
      notJson: "Maximo did not return JSON. Check that the URL does not point to a sign-in page or similar.",
      httpError: (status: number, reasonCode: string | null) => `Maximo returned an error (HTTP ${status}${reasonCode ? `, ${reasonCode}` : ""}).`,
      fallback: "Could not connect. Check the Maximo URL and the connection method.",
    },
    llm: {
      title: "LLM client connection",
      summary: "Registered with Claude Code.",
      relayNote: "The bridge that Claude Code starts (a stdio MCP server) relays to the bridge serving this screen. No URL or token is needed.",
      reinstallNote: 'If MX Stage is missing from Claude Code\'s tool list, ask Claude Code to "reinstall MX Stage", or run the setup again.',
      check: "Check the registration",
      copy: "Copy",
      copied: "Copied",
    },
    skills: {
      title: "Skills (work procedures)",
      intro: "Files that teach the LLM how to work in MX Stage and what it must not do. Claude Code reads them from its next session.",
      loading: "Loading the list…",
      defaultsTitle: "Built-in",
      defaultsHelp: "Installed with MX Stage and replaced when you update MX Stage. Do not edit them.",
      defaultsEmpty: "None.",
      groupIndex: "Index (rules and which Skill to read when)",
      groupCore: "Basic operations",
      groupObject: "Standard Maximo objects",
      userTitle: "Your Skills",
      userIntro: "Procedures for each customer's environment (custom objects, attributes and rules) and for your repeated tasks. Names starting with mxstage are reserved for built-in Skills.",
      // 置き場所の文: before <フォルダ> middle <名前/SKILL.md> after
      userPlaceBefore: "Put them in ",
      userPlaceMiddle: " as ",
      userPlaceAfter: ".",
      userPlaceName: "name",
      userKeep: " They are kept when you update MX Stage and are never published. After adding one, run the setup again to add it to Claude Code.",
      userEmpty: "None yet.",
      problemError: "Cannot load: ",
      problemWarn: "Warning: ",
      version: (version: string) => ` version ${version}`,
      listFailed: (status: number) => `Could not load the Skills list (${status}). The bridge may be an older version. Run the setup again.`,
    },
  },
  {
    page: {
      title: "設定",
      backToApp: "作業画面に戻る",
      failed: "処理に失敗しました。",
    },
    tabs: {
      label: "設定の項目",
      connection: "接続",
      assistants: "AI アシスタント",
      skills: "Skill",
      updates: "更新",
    },
    updates: {
      title: "更新",
      loading: "読み込んでいます…",
      unavailable: "この橋渡しは更新を確かめられません。古い版かもしれません。",
      current: (version, kind) => `版 ${version}（${kind}）`,
      kindGit: "導入スクリプトで入れたもの",
      kindBundle: "Claude Desktop の拡張機能",
      autoLabel: "自動で更新する",
      on: "オン",
      off: "オフ",
      autoHelpGit:
        "1 日 1 回、GitHub に新しい版があるかを問い合わせます。あれば、作業中でないとき（シートのある窓が無く、AI がツールを実行していないとき）に自動で入れ替え、橋渡しを起動し直します。",
      autoHelpBundle:
        "1 日 1 回、GitHub に新しい版があるかを問い合わせ、あればここでお知らせします。拡張機能は Claude Desktop が管理しているので、新しいファイルはボタン 1 つで入れられるようにします。",
      privacy: "問い合わせるのは最新の版の番号だけで、あなたや作業のデータは送りません。オフの間は GitHub に問い合わせません（「今すぐ確かめる」を押したときだけ）。",
      neverChecked: "まだ確かめていません。",
      lastChecked: (when) => `最後に確かめた日時: ${when}`,
      checkNow: "今すぐ確かめる",
      checking: "確かめています…",
      upToDate: "最新の版です。",
      available: (version) => `新しい版 ${version} があります。`,
      whatsNew: "変更点",
      installGit: "今すぐ更新する",
      installBundle: "ダウンロードして入れる",
      applying: "更新しています…（数分かかります）。終わると橋渡しが起動し直すので、この画面を開き直してください。",
      downloading: "ダウンロードしています…",
      restartNeeded: "入れ替えました。AI アシスタントを開き直すと新しい版になります。",
      downloaded: "新しい拡張機能のファイルをダウンロードし、確かめました:",
      installSteps: "Claude Desktop の「Settings → Extensions」で「Advanced settings → Install Extension…」を押し、このファイルを選んでください。",
      folderHint: "フォルダが開かなかったときは、コピーした場所をエクスプローラーのアドレス欄に貼り付けてください。",
      copyPath: "場所をコピー",
      copied: "コピーしました",
      error: (code) => (UPDATE_ERRORS_JA as Record<string, string>)[code] ?? `更新できませんでした（${code}）。`,
    },
    language: {
      title: "言語",
      label: "言語",
      help: "作業画面の表示に使います。AI は、あなたが書いた言語で答えます。",
    },
    maximo: {
      title: "Maximo への接続",
      pastStatus: {
        label: "過去の作業のステータス",
        comp: "完了（COMP）。後から中身を直せる",
        close: "クローズ（CLOSE）。戻せず、クローズした記録は中身も直せない",
        help: "終わりの日が過ぎた作業（Excel の履歴など）を AI が登録・更新するとき、指示が無ければこのステータスにします。仕掛かり中と先の作業は、AI と決めたステータスにします。この PC に、接続先ごとに覚えます。",
      },
      lockedIdle: "無操作が 30 分続いたため、API キーをメモリから消しました（ロック中）。もう一度接続してください。",
      lockedManual: "接続を切りました。",
      keyNote:
        "API キーはこのタブのメモリ（専用の Web Worker）にだけ置き、サーバやブラウザのストレージには保存しません。記憶はブラウザのパスワードマネージャーに任せてください。",
      urlLabel: "Maximo URL",
      viaLabel: "接続方式",
      nameLabel: "接続名",
      keyLabel: "API キー",
      connect: "接続",
      checking: "確認しています…",
      connected: "接続しました。",
      maximo: "Maximo",
      hostVia: (host, direct) => `${host}（${direct ? "直結" : "proxy"}）`,
      user: "Maximo の利用者",
      unknownUser: "（不明）",
      backToApp: "作業画面に戻る",
      reconnect: "別の接続にする",
      disconnect: "接続を切る",
    },
    saved: {
      title: "保存した接続先",
      intro: "この PC に保存しています。この PC で開いた作業画面は、どの窓（インストールしたアプリ・ブラウザのタブ・AI アシスタントの中のブラウザ）でも、PC を再起動したあとでも、自動でつながります。",
      protection: (kind) =>
        kind === "dpapi"
          ? "API キーは、橋渡しが Windows のデータ保護（DPAPI）で、あなたの Windows ユーザーにだけ開けるように暗号化しています。ブラウザには渡しません。"
          : kind === "keychain"
            ? "API キーは、橋渡しが macOS のキーチェーンに置いた鍵で暗号化しています。ブラウザには渡しません。"
            : "API キーは、橋渡しが、あなただけが読めるファイルの鍵で暗号化しています。ブラウザには渡しません。",
      empty: "保存した接続先はまだありません。下で「この PC に保存する」を選んで接続してください。",
      use: "接続",
      inUse: "接続中",
      connecting: "接続しています…",
      editKey: "直す",
      remove: "削除",
      removeConfirm: (name) => `保存した接続先「${name}」と、その API キーをこの PC から消しますか？`,
      saveLabel: "この PC に保存して、次からは自動で接続する",
      saveDirect: "直結の接続は保存できません（API キーをブラウザに置くことになるため）。保存するときは proxy にしてください。",
      editing: (name) => `「${name}」を直しています。API キーを空のままにすると、保存してあるキーのままにします。`,
      cancelEdit: "直すのをやめる",
      update: "保存して接続",
      autoFailed: (name) => `「${name}」に自動で接続できませんでした。`,
      autoRetrying: "自動でやり直します。",
      savedBadge: "この PC に保存",
      unsavedKeyNote:
        "保存しない場合: API キーはこのタブのメモリ（専用の Web Worker）にだけ置き、タブを読み込み直したときと、30 分操作が無いときに消えます。",
      problem: {
        invalid_name: "接続名を 128 文字以内で入れてください。",
        invalid_url: "Maximo URL は https://host[:port] の形にしてください（パスを含めない）。",
        invalid_key: "API キーに使えない文字が含まれています。",
        key_required: "API キーを入れてください。",
        not_found: "この接続先はもうありません。別の窓で削除されたかもしれません。",
        too_many: "保存できる接続先は 50 までです。使わないものを削除してください。",
        unavailable: "この PC で API キーを保護できなかったので、保存しませんでした。保存せずに接続してください。",
        unreadable: "保存した API キーをこの PC では開けません（別のユーザーか別の PC で保存したものです）。API キーを入れ直してください。",
        bridge_unavailable: "橋渡しが接続先を保存できません。古い版かもしれません。導入をやり直すか、保存せずに接続してください。",
      },
    },
    via: {
      direct: "直結（ブラウザから直接。Maximo 側の CORS 設定が必要）",
      proxy: "proxy（このパソコンの橋渡し経由。既定）",
    },
    validation: {
      via: "接続方式を選んでください。",
      urlEmpty: "Maximo URL を入力してください。",
      urlFormat: "URL の形式が正しくありません（例 https://maximo.example.com）。",
      urlExtras: "URL にユーザー名・クエリ（?）・# を含めないでください。",
      urlHttps: "https の URL にしてください。",
      urlProxyPath: "proxy 方式では https://host[:port] の形にしてください（/maximo などのパスは付けません）。",
      urlDemo: "このアドレスは組み込みのデモのものです。デモには「デモ」のタブからつないでください。",
      nameEmpty: "接続名を入力してください（例 MAXADMIN@mas-dev）。",
      nameTooLong: (max) => `接続名は ${max} 文字以内にしてください。`,
      keyEmpty: "API キーを入力してください。",
      keyChars: "API キーに使えない文字（空白・改行・全角文字）が含まれています。",
    },
    connectError: {
      forbiddenOrigin: "同一オリジンからの要求として受け付けられませんでした。作業画面の URL から開き直してください。",
      unreachable: JA_UNREACHABLE,
      unreachableStatus: (status) => `${JA_UNREACHABLE}（HTTP ${status}）`,
      pathNotAllowed: `${JA_PROXY}が転送しないパスへの要求でした（転送するのは /maximo/api/ と /maximo/oslc/ で始まるパスだけです）。API キーの誤りではありません。${JA_RELOAD_HINT}`,
      invalidPath: `要求のパスに使えない文字（%2e・%2f・;・.. など）が含まれていたので、${JA_PROXY}が転送を止めました。API キーの誤りではありません。${JA_RELOAD_HINT}`,
      missingApikey: `${JA_PROXY}に API キーが届きませんでした。設定画面で API キーを入れ直してから、もう一度接続してください。`,
      apikeyInQuery: `API キーを URL のクエリ（?apikey=）に入れた要求だったので、${JA_PROXY}が転送を止めました（キーが履歴やログに残らないようにするためです）。API キーは設定画面の API キー欄にだけ入れ、Maximo URL に ? を含めないでください。`,
      methodNotAllowed: `${JA_PROXY}が受け付けない方式の要求でした（転送するのは GET と POST だけです）。API キーの誤りではありません。${JA_RELOAD_HINT}`,
      upstreamTimeout: `${JA_PROXY}から Maximo への要求が、時間内に返りませんでした。Maximo が動いているか、VPN やプロキシなどのネットワークを確認してから、もう一度接続してください。`,
      timeout: "Maximo の応答がタイムアウトしました。",
      directUnreachable:
        "ブラウザから Maximo に直接届きませんでした。Maximo 側の CORS 設定（このツールのオリジンと apikey ヘッダの許可）と証明書を確認するか、接続方式を proxy にしてください。",
      proxyUnreachable: `Maximo に接続できませんでした。${JA_PROXY}が動いているか、ネットワークを確認してください。`,
      hostNotAllowed:
        "この Maximo ホストへの接続は許可されていません（橋渡しの起動引数 --allow-host の許可ホスト外）。橋渡しを起動するときの --allow-host にこのホストを足してください。",
      unauthorized: "橋渡しが要求を受け付けませんでした。橋渡しを起動し直してから、もう一度接続してください。",
      invalidBase: "Maximo URL は https://host[:port] の形にしてください（パスを含めない）。",
      vaultLocked: "API キーがロックされました。もう一度接続してください。",
      vaultForbiddenDestination: "この送り先には API キーを付けて送れません。Maximo URL と接続方式を確認してください。",
      vaultBadRequest: "API キーまたは URL に使えない文字が含まれています。",
      connectionNotFound: "この接続先は、この PC にもうありません。別の接続先を選ぶか、接続し直してください。",
      connectionUnreadable: "保存した API キーをこの PC では開けません（別のユーザーか別の PC で保存したものです）。接続先を「直す」で API キーを入れ直してください。",
      connectionUnavailable: "橋渡しが保存した接続先を使えません。導入をやり直すか、保存せずに接続してください。",
      invalidKey: "API キーが無効か、この接続に権限がありません。",
      gatewayTimeout: (status) => `Maximo の応答が時間内に返りませんでした（HTTP ${status}）。`,
      whoamiNotFound: "whoami が見つかりません。Maximo URL（/maximo の手前まで）を確認してください。",
      notJson: "Maximo の応答が JSON ではありません。URL がログイン画面などに向いていないか確認してください。",
      httpError: (status, reasonCode) => `Maximo がエラーを返しました（HTTP ${status}${reasonCode ? `、${reasonCode}` : ""}）。`,
      fallback: "接続できませんでした。Maximo URL と接続方式を確認してください。",
    },
    llm: {
      title: "LLM クライアントの接続",
      summary: "Claude Code に登録済みです。",
      relayNote: "Claude Code が起動する橋渡し（stdio の MCP サーバ）は、この画面を配っている橋渡しに中継します。URL もトークンも要りません。",
      reinstallNote: "Claude Code のツールの一覧に MX Stage が出てこないときは、Claude Code に「MX Stage を入れ直して」と頼むか、導入をもう一度実行してください。",
      check: "登録を確かめる",
      copy: "コピー",
      copied: "コピーしました",
    },
    skills: {
      title: "Skill（作業手順書）",
      intro: "LLM に MX Stage の作業手順と禁止事項を教えるファイルです。Claude Code は新しいセッションから読みます。",
      loading: "一覧を読んでいます…",
      defaultsTitle: "アプリ既定",
      defaultsHelp: "MX Stage と一緒に入り、MX Stage を更新すると置き換わります。書き換えないでください。",
      defaultsEmpty: "ありません。",
      groupIndex: "目次（決まりと、どの場面で何を読むか）",
      groupCore: "基本動作",
      groupObject: "Maximo の標準オブジェクト",
      userTitle: "利用者の Skill",
      userIntro: "客先の環境ごとの手順（カスタムのオブジェクト・属性・決まり）と、繰り返す作業の手順です。mxstage で始まる名前はアプリ既定の Skill 専用です。",
      userPlaceBefore: "",
      userPlaceMiddle: " の下に ",
      userPlaceAfter: " で置きます。",
      userPlaceName: "名前",
      userKeep: "MX Stage を更新しても消えず、公開もされません。置いたあと導入をやり直すと Claude Code に入ります。",
      userEmpty: "まだありません。",
      problemError: "読み込めません: ",
      problemWarn: "注意: ",
      version: (version) => ` 版 ${version}`,
      listFailed: (status) => `Skill の一覧を読めませんでした（${status}）。橋渡しの版が古い可能性があります。導入をやり直してください。`,
    },
  },
);

// ---------------------------------------------------------------------------
// API キーの保管（keyvault）
// ---------------------------------------------------------------------------

const VAULT_EN = {
  // Worker の中（core.ts）
  urlUnparsable: "The Maximo URL cannot be parsed.",
  urlExtras: "Remove credentials, the query and # from the Maximo URL.",
  urlHttps: "Use https for the Maximo URL.",
  urlProxyPath: "With proxy, the Maximo URL must not include a path.",
  badVia: "The connection method is not valid.",
  badKey: "The API key is empty or contains characters that cannot be used.",
  noUrl: "The Maximo URL is missing.",
  locked: "The API key is locked. Connect again in Settings.",
  method: "Only GET and POST requests are sent.",
  destUnparsable: "The destination URL cannot be parsed.",
  destExtras: "Remove credentials and # from the destination URL.",
  sentinel: "Do not put the key placeholder in the URL or the body.",
  proxyDestination: "With proxy, the API key is sent only to /mx/ on the same origin.",
  otherMaximo: "The API key is sent only to the connected Maximo.",
  directDestination: "With direct, the API key is sent only to the connected Maximo's origin.",
  headerNotString: "A header value is not a string.",
  headerDuplicate: (name: string) => `The header ${name} appears more than once.`,
  keyHeaderInvalid: "The API key header is not valid.",
  headerNotAllowed: (name: string) => `The header ${name} is not allowed.`,
  sentinelInHeader: "Do not put the key placeholder in another header.",
  keyHeaderMissing: "The API key header is missing.",
  aborted: "Canceled.",
  network: "Cannot reach Maximo.",
  redirect: "Maximo returned a redirect. Check the URL.",
  unprocessable: "The request cannot be processed.",
  badFetch: "The send request is not valid.",
};

const VAULT_JA: MessagesOf<typeof VAULT_EN> = {
  urlUnparsable: "Maximo の URL を解析できません。",
  urlExtras: "Maximo の URL に認証情報・クエリ・# を含めないでください。",
  urlHttps: "Maximo の URL は https にしてください。",
  urlProxyPath: "proxy 方式の Maximo の URL にはパスを含めません。",
  badVia: "接続方式が正しくありません。",
  badKey: "API キーが空か、使えない文字を含んでいます。",
  noUrl: "Maximo の URL がありません。",
  locked: "API キーはロックされています。設定画面で再接続してください。",
  method: "GET と POST だけを送ります。",
  destUnparsable: "送り先の URL を解析できません。",
  destExtras: "送り先の URL に認証情報や # を含めないでください。",
  sentinel: "キーの置き換え用の文字列を URL や本文に入れないでください。",
  proxyDestination: "proxy 方式では、同一オリジンの /mx/ 配下にだけ API キーを付けて送ります。",
  otherMaximo: "接続した Maximo 以外へは API キーを付けて送りません。",
  directDestination: "direct 方式では、接続した Maximo のオリジンにだけ API キーを付けて送ります。",
  headerNotString: "ヘッダの値が文字列ではありません。",
  headerDuplicate: (name) => `ヘッダ ${name} が重複しています。`,
  keyHeaderInvalid: "API キーのヘッダが正しくありません。",
  headerNotAllowed: (name) => `ヘッダ ${name} は付けられません。`,
  sentinelInHeader: "キーの置き換え用の文字列を別のヘッダに入れないでください。",
  keyHeaderMissing: "API キーのヘッダがありません。",
  aborted: "中止しました。",
  network: "Maximo へ通信できません。",
  redirect: "Maximo がリダイレクトを返しました。URL を確認してください。",
  unprocessable: "処理できない要求です。",
  badFetch: "送信の要求が正しくありません。",
};

/** Worker（core.ts）が返す文言 */
export const vaultMessages = defineMessages(VAULT_EN, VAULT_JA);

/** メインスレッドの窓口（client.ts）の文言 */
export const vaultClientMessages = defineMessages(
  {
    workerUnavailable: "Could not start the Worker that holds the API key. Reload the page.",
    workerMessageError: "Could not communicate with the Worker that holds the API key.",
    workerTimeout: "The Worker that holds the API key is not responding. Reload the page.",
    aborted: "Canceled",
    noResponse: "No response was received from Maximo",
    network: "Cannot reach Maximo",
    superseded: "This connection was canceled because another connection was started.",
    disposed: "The key vault has been closed",
    postFailed: "Could not send to the key vault Worker",
  },
  {
    workerUnavailable: "API キーの保管用 Worker を起動できませんでした。ページを再読み込みしてください。",
    workerMessageError: "API キーの保管用 Worker との通信に失敗しました。",
    workerTimeout: "API キーの保管用 Worker が応答しません。ページを再読み込みしてください。",
    aborted: "中止しました",
    noResponse: "Maximo の応答を受け取れませんでした",
    network: "Maximo へ通信できません",
    superseded: "別の接続を始めたため、この接続は取りやめました。",
    disposed: "キーの保管を終了しました",
    postFailed: "キーの保管用の Worker に送れませんでした",
  },
);

const PROBE = "\u0001";

/**
 * Worker が返した文言（Worker の中ではいつも英語）を今の言語に直す。知らない文言はそのまま返す。
 * 引数を 1 つとる文言（ヘッダ名）は、前後の固定部分で見分けて引数を取り出す。
 */
export function localizeVaultMessage(message: string): string {
  if (getLocale() === "en") return message;
  const target = vaultMessages() as unknown as Record<string, string | ((arg: string) => string)>;
  for (const [key, en] of Object.entries(VAULT_EN) as [string, string | ((arg: string) => string)][]) {
    const to = target[key];
    if (typeof en === "string") {
      if (en === message && typeof to === "string") return to;
      continue;
    }
    if (typeof to !== "function") continue;
    const [prefix, suffix] = en(PROBE).split(PROBE) as [string, string];
    if (message.length > prefix.length + suffix.length && message.startsWith(prefix) && message.endsWith(suffix)) {
      return to(message.slice(prefix.length, message.length - suffix.length));
    }
  }
  return message;
}

// ---------------------------------------------------------------------------
// オブジェクト構造のカタログ（src/app/catalog）
// ---------------------------------------------------------------------------

export const catalogMessages = defineMessages(
  {
    unknownError: "unknown error",
    listFailed: (detail: string) => `Could not load the list of object structures (${detail})`,
    badName: (raw: string) => `Use only letters, digits and _ in the object structure name ${raw}`,
    storageFallback: (detail: string | null) =>
      `Could not save in this browser, so the loaded object structures will be lost when you close this tab${detail ? ` (${detail})` : ""}.`,
    idbRequest: "The IndexedDB request failed",
    idbAborted: "The IndexedDB write was aborted",
    idbWrite: "The IndexedDB write failed",
    idbOpen: "Could not open IndexedDB",
    idbBlocked: "Could not open IndexedDB because an older version in another tab is using it",
  },
  {
    unknownError: "不明なエラー",
    listFailed: (detail) => `オブジェクト構造の一覧を読めませんでした（${detail}）`,
    badName: (raw) => `オブジェクト構造名 ${raw} は英数字と _ だけにしてください`,
    storageFallback: (detail) => `このブラウザに保存できなかったため、読み込んだオブジェクト構造はこのタブを閉じると消えます${detail ? `（${detail}）` : ""}。`,
    idbRequest: "IndexedDB の要求に失敗しました",
    idbAborted: "IndexedDB の書き込みが中断されました",
    idbWrite: "IndexedDB の書き込みに失敗しました",
    idbOpen: "IndexedDB を開けませんでした",
    idbBlocked: "IndexedDB が別のタブの古い版に使われているため開けませんでした",
  },
);

// ---------------------------------------------------------------------------
// ファイルの受け取りに失敗した理由（src/app/boot/services.ts。ImportErrorReason ごと）
// ---------------------------------------------------------------------------

export const importErrorMessages = defineMessages(
  {
    sequence: "chunks arrived out of order",
    size_mismatch: "the size does not match",
    too_large: "too large (up to 20 MB)",
    too_many: "too many files at once",
    timeout: "the rest of the file did not arrive",
    invalid_data: "the content could not be read",
    digest_failed: "the checksum could not be calculated",
  },
  {
    sequence: "断片の順番が合いません",
    size_mismatch: "大きさが合いません",
    too_large: "大きすぎます（20MB まで）",
    too_many: "同時に受け取れるファイル数を超えました",
    timeout: "続きが届きませんでした",
    invalid_data: "内容を読み取れませんでした",
    digest_failed: "チェックサムを計算できませんでした",
  },
);
