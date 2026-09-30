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
  ackMs: 2_000,
  readDeadlineMs: 25_000,
  maxDeadlineMs: 45_000,
  heartbeatMs: 20_000,
  /** 直前に切断したタブの再接続を待つ猶予 */
  reconnectGraceMs: 3_000,
} as const;

export const RELAY_LIMITS = {
  /** WebSocket 1 フレームの上限（Workers の受信上限 32MiB より十分小さくする） */
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

export type TabToHub = HelloMsg | FocusMsg | AckMsg | ProgressMsg | ChunkMsg | ResultMsg | ErrorMsg | SheetOpsMsg;

// ---------------------------------------------------------------------------
// Hub → Tab
// ---------------------------------------------------------------------------

export interface WelcomeMsg {
  type: "welcome";
  role: TabRole;
  primaryTabId: string | null;
  heartbeatMs: number;
}

export interface RolesMsg {
  type: "tab.roles";
  primaryTabId: string | null;
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

/** 単回チケットで受け取った Excel などをタブへ流す（Worker は保存しない）。data は base64 */
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

export type HubToTab = WelcomeMsg | RolesMsg | InvokeMsg | CancelMsg | ImportChunkMsg | SheetOpsMsg | ErrorFrameMsg;

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
  tabs: Array<{ tabId: string; role: TabRole; workspace: string | null; appVersion: string; connectedAt: number }>;
  primaryTabId: string | null;
}

/**
 * Hub が MCP サーバに公開する呼び出し（src/bridge/hub.ts が実装し、client の橋渡しは primary へ中継する）。
 */
export interface HubRpc {
  /** onProgress はタブの tool.progress を受け取る（Worker が MCP の進捗通知に変換し、クライアントの無応答タイムアウトを延ばす） */
  invoke(req: HubInvokeRequest, onProgress?: (p: InvokeProgress) => unknown): Promise<HubInvokeResponse>;
  status(): Promise<HubStatus>;
  /** インポートチケットで受け取ったファイルの断片を primary タブへ流す（保存しない） */
  pushImport(msg: ImportChunkMsg): Promise<{ delivered: boolean }>;
}

/**
 * タブの WebSocket 接続。Worker が認証と Origin 検査を済ませてから
 * stub.fetch(new Request(`https://hub${HUB_WS_PATH}`, { headers: { Upgrade: "websocket", [HUB_USER_HEADER]: userKey } })) を呼ぶ。
 */
export const HUB_WS_PATH = "/ws";
export const HUB_USER_HEADER = "X-Mx-User";
export const HUB_LOCATION_HINT = "apac-ne";

/** モデルに次の行動が分かる文言にする（汎用的なエラー文は使わない） */
export function relayErrorMessage(code: RelayErrorCode, appUrl: string): string {
  switch (code) {
    case RelayErrorCode.NO_TAB:
      return `The work screen tab is not open. Ask the user to open ${appUrl}/app in their browser, then try again.`;
    case RelayErrorCode.NO_ACK:
      return "The work screen tab is not responding. Check that the tab is shown, then try again.";
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
