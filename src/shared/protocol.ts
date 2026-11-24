// mxrelay.v1: 橋渡しの Hub とブラウザ作業タブの間の中継プロトコル。
// 正本はタブにあり、Hub はツール呼び出しを primary タブへ渡して結果を持ち帰るだけ。
// 橋渡しとタブの両方から import する（ランタイム非依存の型と定数だけを置く）。

import type { ToolName } from "./toolDefs";

export const RELAY_SUBPROTOCOL = "mxrelay.v1";
export const RELAY_PROTOCOL_VERSION = 1;

/** モデルに返すエラー種別。すべて isError:true の CallToolResult に変換する */
export const RelayErrorCode = {
  NO_TAB: -32001,
  NO_ACK: -32002,
  DEADLINE: -32003,
  TAB_DISCONNECTED: -32004,
  BUSY: -32005,
  TOO_LARGE: -32006,
  FORBIDDEN: -32007,
  STALE_REVISION: -32008,
  PROTOCOL_MISMATCH: -32009,
  UNKNOWN_OUTCOME: -32010,
  TOOL_ERROR: -32011,
  INVALID_ARGS: -32602,
} as const;
export type RelayErrorCode = (typeof RelayErrorCode)[keyof typeof RelayErrorCode];

/** タイムアウト予算。Codex の既定ツールタイムアウト 60 秒を下回るように決めている */
export const RELAY_TIMEOUTS = {
  /** 裏の窓（最小化した Chrome など）のタブは、受け取りを返すまで 5〜12 秒かかることがある（2026-10-15 に計った） */
  ackMs: 15_000,
  readDeadlineMs: 25_000,
  maxDeadlineMs: 45_000,
  heartbeatMs: 20_000,
  /** 直前に切断したタブの再接続を待つ猶予 */
  reconnectGraceMs: 3_000,
} as const;

export const RELAY_LIMITS = {
  /** WebSocket 1 フレームの上限（大きな結果は分けて送るので、1 フレームは小さく保つ） */
  maxFrameBytes: 1_048_576,
  /** これを超える結果は tool.chunk に分割する */
  chunkThresholdBytes: 262_144,
  /** 分割後も含めた 1 結果の上限 */
  maxResultBytes: 8_388_608,
} as const;

export type TabRole = "primary" | "mirror";

/** MCP の CallToolResult と同じ形（タブ側で組み立てて返す） */
export interface ToolResultPayload {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Tab → Hub
// ---------------------------------------------------------------------------

export interface HelloMsg {
  type: "hello";
  tabId: string;
  protocol: number;
  appVersion: string;
  /** タブが実行できるツール名 */
  tools: string[];
  revision: number;
  workspace: string | null;
  focused: boolean;
  /** 作業にあるシートの数。シートの無いタブはフォーカスしても、シートのある primary を奪わない */
  sheets?: number;
  /** つなぎ直したタブが知らせる直前の様子（止まっていた時間、切れた理由）。Hub はログに残すだけ */
  diag?: string;
  /** 今つないでいる接続先（保存した接続先の ID・デモの ID・保存していない接続先の Maximo の URL）。つないでいなければ null */
  connection?: string | null;
}

export interface FocusMsg {
  type: "tab.focus";
  tabId: string;
}

export interface AckMsg {
  type: "tool.ack";
  id: string;
}

export interface ProgressMsg {
  type: "tool.progress";
  id: string;
  progress: number;
  total?: number;
  message?: string;
}

/** 大きな結果の分割送信。data は JSON 文字列の断片。最後の断片で result を組み立てる */
export interface ChunkMsg {
  type: "tool.chunk";
  id: string;
  seq: number;
  data: string;
  last: boolean;
  revision?: number;
}

export interface ResultMsg {
  type: "tool.result";
  id: string;
  result: ToolResultPayload;
  revision: number;
}

export interface ErrorMsg {
  type: "tool.error";
  id: string;
  code: RelayErrorCode;
  message: string;
  retryable?: boolean;
}

/** primary タブの変更をミラー（他タブ・埋め込みビュー）へ流す（Phase 3） */
export interface SheetOpsMsg {
  type: "sheet.ops";
  tabId: string;
  revision: number;
  ops: unknown;
}

/** タブの作業の様子が変わった（シートの数・接続先）。hello の後で送る */
export interface TabStateMsg {
  type: "tab.state";
  tabId: string;
  sheets: number;
  /** 今つないでいる接続先（hello と同じ）。古い画面は送らない */
  connection?: string | null;
}

export type TabToHub = HelloMsg | FocusMsg | AckMsg | ProgressMsg | ChunkMsg | ResultMsg | ErrorMsg | SheetOpsMsg | TabStateMsg;

// ---------------------------------------------------------------------------
// Hub → Tab
// ---------------------------------------------------------------------------

export interface WelcomeMsg {
  type: "welcome";
  role: TabRole;
  primaryTabId: string | null;
  heartbeatMs: number;
  /** primary のタブにあるシートの数（分からなければ null） */
  primarySheets?: number | null;
}

export interface RolesMsg {
  type: "tab.roles";
  primaryTabId: string | null;
  primarySheets?: number | null;
}

/**
 * 作業を別の窓へ移す（作業データを橋渡しの /_mxstage/handoff へ送らせる）。送り先の窓が「この窓に移す」を押したとき、
 * 作業のある primary のタブへ送る。タブは作業を直列化して /_mxstage/handoff/upload?token= に送る（保存はしない）
 */
export interface WorkspaceExportMsg {
  type: "workspace.export";
  token: string;
}

/** 作業が別の窓に移り終わった。送り元のタブは作業を空にする */
export interface WorkspaceReleaseMsg {
  type: "workspace.release";
  token: string;
}

export interface InvokeMsg {
  type: "tool.invoke";
  id: string;
  tool: ToolName;
  args: unknown;
  /** epoch ミリ秒。これを過ぎたら Hub は DEADLINE で打ち切る */
  deadlineAt: number;
  /** 送信時点での締切までの残りミリ秒。タブは「受信時刻＋この値」を締切にする（Hub とブラウザの時計のずれに左右されないため） */
  timeoutMs: number;
  idempotencyKey: string;
  readOnly: boolean;
}

export interface CancelMsg {
  type: "tool.cancel";
  id: string;
  reason: "deadline" | "mcp_cancelled" | "superseded";
}

/** 単回チケットで受け取った Excel などをタブへ流す（橋渡しは保存しない）。data は base64 */
export interface ImportChunkMsg {
  type: "import.chunk";
  importId: string;
  seq: number;
  data: string;
  last: boolean;
  fileName: string;
  contentType: string;
  totalBytes: number;
}

/** hello を受け付けられないとき（プロトコルの版違いなど）に送ってから閉じる */
export interface ErrorFrameMsg {
  type: "error";
  code: RelayErrorCode;
  message: string;
}

export type HubToTab = WelcomeMsg | RolesMsg | InvokeMsg | CancelMsg | ImportChunkMsg | SheetOpsMsg | ErrorFrameMsg | WorkspaceExportMsg | WorkspaceReleaseMsg;

// ---------------------------------------------------------------------------
// MCP サーバ → Hub
// ---------------------------------------------------------------------------

export interface HubInvokeRequest {
  tool: ToolName;
  args: unknown;
  readOnly: boolean;
  /** 締切までのミリ秒。maxDeadlineMs で頭打ちにする */
  deadlineMs: number;
  idempotencyKey: string;
}

export type HubInvokeResponse =
  | { ok: true; result: ToolResultPayload; revision: number }
  | { ok: false; code: RelayErrorCode; message: string; retryable: boolean };

export interface InvokeProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface HubStatus {
  /** connection: タブが今つないでいる接続先（MCP が客先の Skill を選ぶのに使う。古い画面では無い） */
  tabs: Array<{ tabId: string; role: TabRole; workspace: string | null; appVersion: string; connectedAt: number; connection?: string | null }>;
  primaryTabId: string | null;
}

/**
 * Hub が MCP サーバに公開する呼び出し（src/bridge/hub.ts が実装し、client の橋渡しは primary へ中継する）。
 */
export interface HubRpc {
  /** onProgress はタブの tool.progress を受け取る（橋渡しが MCP の進捗通知に変換し、クライアントの無応答タイムアウトを延ばす） */
  invoke(req: HubInvokeRequest, onProgress?: (p: InvokeProgress) => unknown): Promise<HubInvokeResponse>;
  status(): Promise<HubStatus>;
  /** インポートチケットで受け取ったファイルの断片を primary タブへ流す（保存しない） */
  pushImport(msg: ImportChunkMsg): Promise<{ delivered: boolean }>;
}


/**
 * 作業画面は MX Stage の道具だけで扱う決まり（AI 向け）。ブラウザ・画面の操作の道具（Claude in Chrome・computer use など）で
 * 作業画面を開いたり読んだりすると、作業画面の守り（guard.ts の forbidden_origin）に断られる。作業画面が要るときは道具を呼べば橋渡しが開く。
 * サーバの案内・ツールの説明・作業画面を開いたときの文・目次の Skill に同じ趣旨を書く（試験: tests/bridge/browserTools.test.ts）
 */
export const WORK_SCREEN_TOOLS_ONLY =
  "Read, change and show the work screen only with the MX Stage tools. Never open, click or read it with browser or screen control tools (Claude in Chrome, computer use and the like): the work screen refuses calls from them. When the work screen is needed, call an MX Stage tool and MX Stage opens it.";

/** MX Stage の道具が見えないとき（開き直しの直後など）の決まり（AI 向け） */
export const MXSTAGE_TOOLS_MISSING =
  "If the MX Stage tools are not visible (for example just after a restart), do not turn to a browser: wait a moment and check the tool list again, or ask the user in one line to restart Claude.";

/**
 * 作業画面のタブが無かったときに、橋渡しが既定のブラウザで開いたか（src/bridge/workScreen.ts）。
 * opened: 今開いた / waiting: 少し前に開いた（開き直さない） / failed: 開けなかった / gave_up: 開いたがつながらなかった / off: 開かない設定
 */
export type WorkScreenOpenOutcome = "opened" | "waiting" | "failed" | "gave_up" | "off";

/** 橋渡しが作業画面を既定のブラウザで開いた（開こうとした）ときに、AI に渡す文 */
export function workScreenOpenMessage(outcome: WorkScreenOpenOutcome, appUrl: string): string {
  switch (outcome) {
    case "opened":
      return (
        `The work screen tab was not open, so MX Stage opened it (${appUrl}/app) on this PC (in a Chrome or Edge app window, or the default browser). ` +
        "Tell the user that the work screen is opening in their browser (do not ask them to type the URL, and do not open it again, nor with browser or screen control tools), wait about 10 seconds, then call get_status and continue."
      );
    case "waiting":
      return (
        `MX Stage opened the work screen (${appUrl}/app) on this PC (in a Chrome or Edge app window, or the default browser) a moment ago and it has not connected yet. ` +
        "Do not open it again, nor with browser or screen control tools. Wait about 10 seconds, then call get_status and continue. If it is still not connected, ask the user to look at the browser window that opened."
      );
    case "gave_up":
      return (
        `MX Stage opened the work screen on this PC (in a Chrome or Edge app window, or the default browser), but no work screen tab has connected. ` +
        `Ask the user to open ${appUrl}/app in Chrome or Edge (or to show the tab that opened), then try again. Do not open it yourself with browser or screen control tools.`
      );
    case "failed":
      return `The work screen tab is not open and MX Stage could not open a browser on this PC. Ask the user to open ${appUrl}/app in their browser, then try again. Do not open it yourself with browser or screen control tools.`;
    case "off":
      return relayErrorMessage(RelayErrorCode.NO_TAB, appUrl);
  }
}

/** モデルに次の行動が分かる文言にする（汎用的なエラー文は使わない） */
export function relayErrorMessage(code: RelayErrorCode, appUrl: string): string {
  switch (code) {
    case RelayErrorCode.NO_TAB:
      // 橋渡しが既定のブラウザで開けなかったとき（--no-open・ブラウザが無い）の文。開けたときは workScreenOpenMessage
      return `The work screen tab is not open. Ask the user to open ${appUrl}/app in their browser, then try again. Do not open it yourself with browser or screen control tools.`;
    case RelayErrorCode.NO_ACK:
      return "The work screen tab did not answer. It reconnects by itself: wait about 20 seconds, then call get_status once. If that also fails, ask the user to show the work screen tab and press its Reload button. If the call was a change, check get_diff before repeating it, because it may have been applied.";
    case RelayErrorCode.DEADLINE:
      return "The operation did not finish in time. Narrow the target or run it as a job (check progress with get_job).";
    case RelayErrorCode.TAB_DISCONNECTED:
      return "The connection to the work screen tab was lost during the operation. Reopen the tab, then check the state with get_status.";
    case RelayErrorCode.BUSY:
      return "The work screen is processing another change. Wait a moment, then try again.";
    case RelayErrorCode.TOO_LARGE:
      return "The result is too large. Narrow the columns or conditions, or fetch it in parts with cursor.";
    case RelayErrorCode.FORBIDDEN:
      return "This operation is not allowed.";
    case RelayErrorCode.STALE_REVISION:
      return "The data changed after you read it. Read the latest data, then try again.";
    case RelayErrorCode.PROTOCOL_MISMATCH:
      return "The work screen may be an old version. Ask the user to reload the tab.";
    case RelayErrorCode.UNKNOWN_OUTCOME:
      return "Could not confirm whether the change was applied. Check the revision with get_status and the contents with get_diff before trying again.";
    case RelayErrorCode.INVALID_ARGS:
      return "The arguments are invalid.";
    default:
      return "The operation failed in the work screen.";
  }
}
