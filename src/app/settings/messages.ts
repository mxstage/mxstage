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

export const settingsMessages = defineMessages(
  {
    page: {
      title: "Settings",
      backToApp: "Back to work screen",
      failed: "Something went wrong.",
    },
    language: {
      title: "Language",
      label: "Language",
      help: "Used for the work screen. The AI replies in the language you write in.",
    },
    maximo: {
      title: "Maximo connection",
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
      userTitle: "Your Skills",
      userIntro: "Procedures for your own tasks or customers.",
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
    language: {
      title: "言語",
      label: "言語",
      help: "作業画面の表示に使います。AI は、あなたが書いた言語で答えます。",
    },
    maximo: {
      title: "Maximo への接続",
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
      userTitle: "利用者の Skill",
      userIntro: "業務や客先ごとの手順です。",
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
