// タブから届くフレームの解釈（橋渡し版）。不正なものは null にして無視する（接続は切らない）。
//
// 以前あった Hub Durable Object と同じ判定を行う。tests/bridge/frames.test.ts がそのときの出力を
// 期待値として固定しているので、判定を変えると試験が知らせる。

import { RelayErrorCode } from "../shared/protocol.ts";
import type { ChunkMsg, ErrorMsg, ProgressMsg, TabToHub, ToolResultPayload } from "../shared/protocol.ts";

const MAX_MESSAGE_TEXT = 4_000;

/** attachment.ts の MAX_TAB_ID_LENGTH と同じ */
export const MAX_TAB_ID_LENGTH = 128;
export const MAX_APP_VERSION_LENGTH = 64;
export const MAX_WORKSPACE_LENGTH = 256;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function optText(v: unknown): string | undefined {
  return typeof v === "string" ? v.slice(0, MAX_MESSAGE_TEXT) : undefined;
}

/**
 * hello は protocol の食い違いを先に判定したいので、他の項目が欠けていても形だけ作って返す。
 * tabId の妥当性は呼び出し側で確かめる。
 */
export function parseTabMessage(data: string | ArrayBuffer): TabToHub | null {
  if (typeof data !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v.type !== "string") return null;

  switch (v.type) {
    case "hello":
      return {
        type: "hello",
        tabId: typeof v.tabId === "string" ? v.tabId : "",
        protocol: finite(v.protocol) ? v.protocol : -1,
        appVersion: typeof v.appVersion === "string" ? v.appVersion : "",
        tools: Array.isArray(v.tools) ? v.tools.filter((t): t is string => typeof t === "string") : [],
        revision: finite(v.revision) ? v.revision : 0,
        workspace: typeof v.workspace === "string" ? v.workspace : null,
        focused: v.focused === true,
      };
    case "tab.focus":
      return { type: "tab.focus", tabId: typeof v.tabId === "string" ? v.tabId : "" };
    case "tool.ack":
      return typeof v.id === "string" ? { type: "tool.ack", id: v.id } : null;
    case "tool.progress": {
      if (typeof v.id !== "string" || !finite(v.progress)) return null;
      const msg: ProgressMsg = { type: "tool.progress", id: v.id, progress: v.progress };
      if (finite(v.total)) msg.total = v.total;
      const text = optText(v.message);
      if (text !== undefined) msg.message = text;
      return msg;
    }
    case "tool.chunk": {
      if (typeof v.id !== "string" || !finite(v.seq) || typeof v.data !== "string" || typeof v.last !== "boolean") return null;
      const msg: ChunkMsg = { type: "tool.chunk", id: v.id, seq: v.seq, data: v.data, last: v.last };
      if (finite(v.revision)) msg.revision = v.revision;
      return msg;
    }
    case "tool.result":
      if (typeof v.id !== "string") return null;
      // result の形は保留中の呼び出しに照らして検査する（TOOL_ERROR で決着させるため）
      return { type: "tool.result", id: v.id, result: v.result as ToolResultPayload, revision: finite(v.revision) ? v.revision : 0 };
    case "tool.error": {
      if (typeof v.id !== "string") return null;
      const msg: ErrorMsg = {
        type: "tool.error",
        id: v.id,
        code: isRelayErrorCode(v.code) ? v.code : RelayErrorCode.TOOL_ERROR,
        message: optText(v.message) ?? "",
      };
      if (typeof v.retryable === "boolean") msg.retryable = v.retryable;
      return msg;
    }
    case "sheet.ops":
      if (!("ops" in v)) return null;
      return { type: "sheet.ops", tabId: typeof v.tabId === "string" ? v.tabId : "", revision: finite(v.revision) ? v.revision : 0, ops: v.ops };
    default:
      return null;
  }
}

const RELAY_ERROR_CODES = new Set<number>(Object.values(RelayErrorCode));

export function isRelayErrorCode(v: unknown): v is RelayErrorCode {
  return typeof v === "number" && RELAY_ERROR_CODES.has(v);
}

/**
 * 共有契約の ToolResultPayload（text の content・structuredContent・isError）に作り直す。
 * 形が合わなければ null。余分なキー（_meta など）や text 以外の content はモデルへ流さない。
 */
export function normalizeToolResult(v: unknown): ToolResultPayload | null {
  if (!isObj(v) || !Array.isArray(v.content)) return null;
  const content: ToolResultPayload["content"] = [];
  for (const item of v.content) {
    if (!isObj(item) || item.type !== "text" || typeof item.text !== "string") return null;
    content.push({ type: "text", text: item.text });
  }
  const out: ToolResultPayload = { content };
  if (v.structuredContent !== undefined) {
    if (!isObj(v.structuredContent)) return null;
    out.structuredContent = v.structuredContent;
  }
  if (v.isError !== undefined) {
    if (typeof v.isError !== "boolean") return null;
    out.isError = v.isError;
  }
  return out;
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function isValidTabId(tabId: string): boolean {
  return tabId.length > 0 && tabId.length <= MAX_TAB_ID_LENGTH;
}

export function capText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
