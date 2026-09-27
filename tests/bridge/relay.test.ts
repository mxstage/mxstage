// 中継（ローカル Hub）の往復。偽のタブを WebSocket でつないで応答させる。
// 締切は SCALE=0.05 なので ack 100ms、再接続の猶予 150ms、締切の上限 2250ms になる。

import { afterEach, describe, expect, it } from "vitest";
import { RELAY_LIMITS, RELAY_TIMEOUTS, RelayErrorCode } from "../../src/shared/protocol.ts";
import type { HubInvokeResponse, InvokeMsg, InvokeProgress } from "../../src/shared/protocol.ts";
import { LocalHub } from "../../src/bridge/hub.ts";
import { FakeTab, SCALE, sleep, startTestBridge, stopAll, waitFor } from "./support.ts";

const ACK_MS = RELAY_TIMEOUTS.ackMs * SCALE;

afterEach(async () => {
  await stopAll();
});

async function bridgeWithTab(): Promise<{ hub: LocalHub; tab: FakeTab; bridge: Awaited<ReturnType<typeof startTestBridge>> }> {
  const hub = new LocalHub({ timeoutScale: SCALE });
  const bridge = await startTestBridge({ hub });
  const tab = await FakeTab.connect(bridge);
  return { hub, tab, bridge };
}

function invokeRead(hub: LocalHub, tool = "get_status", args: unknown = {}, onProgress?: (p: InvokeProgress) => void): Promise<HubInvokeResponse> {
  return hub.invoke({ tool: tool as never, args, readOnly: true, deadlineMs: RELAY_TIMEOUTS.readDeadlineMs, idempotencyKey: "k1" }, onProgress);
}

function invokeWrite(hub: LocalHub): Promise<HubInvokeResponse> {
  return hub.invoke({ tool: "patch_cells" as never, args: {}, readOnly: false, deadlineMs: RELAY_TIMEOUTS.readDeadlineMs, idempotencyKey: "k2" });
}

describe("接続", () => {
  it("hello を送ると primary になる", async () => {
    const { tab } = await bridgeWithTab();
    const welcome = await tab.waitFor("welcome");
    expect(welcome.role).toBe("primary");
    expect(welcome.primaryTabId).toBe(tab.tabId);
    expect(welcome.heartbeatMs).toBe(RELAY_TIMEOUTS.heartbeatMs);
  });

  it("心拍（ping）には pong を返す", async () => {
    const { tab } = await bridgeWithTab();
    tab.sendRaw("ping");
    await tab.waitFor("pong");
  });

  it("プロトコルが違う hello は error を送って閉じる", async () => {
    const hub = new LocalHub({ timeoutScale: SCALE });
    const bridge = await startTestBridge({ hub });
    const tab = await FakeTab.connect(bridge, { protocol: 99, noHello: true });
    tab.send({ type: "hello", tabId: "t-old", protocol: 99, appVersion: "old", tools: [], revision: 0, workspace: null, focused: true });
    const frame = await tab.waitFor("error");
    expect(frame.code).toBe(RelayErrorCode.PROTOCOL_MISMATCH);
    await waitFor(async () => (await hub.status()).tabs.length === 0);
  });

  it("Origin が無い接続は受け付けない", async () => {
    const bridge = await startTestBridge();
    await expect(FakeTab.connect(bridge, { origin: null })).rejects.toThrow();
  });

  it("別のサイトの Origin は受け付けない", async () => {
    const bridge = await startTestBridge();
    await expect(FakeTab.connect(bridge, { origin: "http://evil.example" })).rejects.toThrow();
  });

  it("status に接続中のタブが出る", async () => {
    const { hub, tab } = await bridgeWithTab();
    const status = await hub.status();
    expect(status.primaryTabId).toBe(tab.tabId);
    expect(status.tabs).toHaveLength(1);
    expect(status.tabs[0]?.appVersion).toBe("test");
  });
});

describe("ツールの往復", () => {
  it("ack して結果を返すと invoke が成功する", async () => {
    const { hub, tab } = await bridgeWithTab();
    tab.onInvoke = (msg) => tab.answer(msg.id, "できた", 42);
    const res = await invokeRead(hub);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.content[0]?.text).toBe("できた");
      expect(res.revision).toBe(42);
    }
    const invoke = tab.frames("tool.invoke")[0] as unknown as InvokeMsg;
    expect(invoke.tool).toBe("get_status");
    expect(invoke.readOnly).toBe(true);
    expect(invoke.idempotencyKey).toBe("k1");
    expect(invoke.timeoutMs).toBeGreaterThan(0);
  });

  it("分割された結果を組み立てる", async () => {
    const { hub, tab } = await bridgeWithTab();
    const payload = JSON.stringify({ content: [{ type: "text", text: "分割された結果" }] });
    tab.onInvoke = (msg) => {
      tab.ack(msg.id);
      const half = Math.ceil(payload.length / 2);
      tab.send({ type: "tool.chunk", id: msg.id, seq: 0, data: payload.slice(0, half), last: false });
      tab.send({ type: "tool.chunk", id: msg.id, seq: 1, data: payload.slice(half), last: true, revision: 9 });
    };
    const res = await invokeRead(hub);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.content[0]?.text).toBe("分割された結果");
      expect(res.revision).toBe(9);
    }
  });

  it("順番が飛んだ断片は TOOL_ERROR にする", async () => {
    const { hub, tab } = await bridgeWithTab();
    tab.onInvoke = (msg) => {
      tab.ack(msg.id);
      tab.send({ type: "tool.chunk", id: msg.id, seq: 1, data: "{}", last: true });
    };
    const res = await invokeRead(hub);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(RelayErrorCode.TOOL_ERROR);
  });

  it("形の合わない結果は TOOL_ERROR にする", async () => {
    const { hub, tab } = await bridgeWithTab();
    tab.onInvoke = (msg) => {
      tab.ack(msg.id);
      tab.send({ type: "tool.result", id: msg.id, result: { content: "ok" }, revision: 1 });
    };
    const res = await invokeRead(hub);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(RelayErrorCode.TOOL_ERROR);
  });

  it("タブの tool.error をそのまま返す", async () => {
    const { hub, tab } = await bridgeWithTab();
    tab.onInvoke = (msg) => {
      tab.ack(msg.id);
      tab.send({ type: "tool.error", id: msg.id, code: RelayErrorCode.STALE_REVISION, message: "読んだ後に変わっています", retryable: false });
    };
    const res = await invokeRead(hub);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(RelayErrorCode.STALE_REVISION);
      expect(res.message).toBe("読んだ後に変わっています");
    }
  });

  it("進捗を呼び出し元へ流す", async () => {
    const { hub, tab } = await bridgeWithTab();
    const seen: InvokeProgress[] = [];
    tab.onInvoke = (msg) => {
      tab.ack(msg.id);
      tab.send({ type: "tool.progress", id: msg.id, progress: 1, total: 3, message: "読み込み中" });
      setTimeout(() => tab.answer(msg.id), 20);
    };
    const res = await invokeRead(hub, "load_sheet", {}, (p) => seen.push(p));
    expect(res.ok).toBe(true);
    expect(seen[0]).toEqual({ progress: 1, total: 3, message: "読み込み中" });
  });

  it("1MiB を超える結果も 1 フレームで受け取れる", async () => {
    const { hub, tab } = await bridgeWithTab();
    // WebSocket の 64 ビット長のフレームと、途中で分割された受信の組み立てを通す
    const big = "あ".repeat(700_000);
    tab.onInvoke = (msg) => tab.answer(msg.id, big);
    const res = await invokeRead(hub, "query_rows");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.content[0]?.text).toBe(big);
  });

  it("引数が大きすぎるときは送らずに TOO_LARGE にする", async () => {
    const { hub, tab } = await bridgeWithTab();
    const res = await invokeRead(hub, "apply_rule", { big: "あ".repeat(RELAY_LIMITS.maxFrameBytes) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(RelayErrorCode.TOO_LARGE);
    expect(tab.frames("tool.invoke")).toHaveLength(0);
  });
});

describe("失敗の決着", () => {
  it("タブが無ければ NO_TAB", async () => {
    const hub = new LocalHub({ timeoutScale: SCALE });
    await startTestBridge({ hub });
    const res = await hub.invoke({ tool: "get_status" as never, args: {}, readOnly: true, deadlineMs: 1_000, idempotencyKey: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(RelayErrorCode.NO_TAB);
  });

  it("ack が来なければ読み取りは NO_ACK（再試行可）", async () => {
    const { hub, tab } = await bridgeWithTab();
    tab.onInvoke = () => undefined;
    const res = await invokeRead(hub);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(RelayErrorCode.NO_ACK);
      expect(res.retryable).toBe(true);
    }
    // 読み取りは打ち切りを知らせる
    await waitFor(() => tab.frames("tool.cancel").length === 1);
    expect(tab.frames("tool.cancel")[0]?.reason).toBe("deadline");
  });

  it("ack が来なければ書き込みは NO_ACK（再試行不可・cancel も送らない）", async () => {
    const { hub, tab } = await bridgeWithTab();
    tab.onInvoke = () => undefined;
    const res = await invokeWrite(hub);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(RelayErrorCode.NO_ACK);
      expect(res.retryable).toBe(false);
    }
    await sleep(ACK_MS * 2);
    expect(tab.frames("tool.cancel")).toHaveLength(0);
  });

  it("ack はあるが結果が来なければ読み取りは DEADLINE", async () => {
    const { hub, tab } = await bridgeWithTab();
    tab.onInvoke = (msg) => tab.ack(msg.id);
    const res = await hub.invoke({ tool: "get_status" as never, args: {}, readOnly: true, deadlineMs: 400, idempotencyKey: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(RelayErrorCode.DEADLINE);
    await waitFor(() => tab.frames("tool.cancel").length === 1);
    expect(tab.frames("tool.cancel")[0]?.reason).toBe("deadline");
  });

  it("ack はあるが結果が来なければ書き込みは UNKNOWN_OUTCOME", async () => {
    const { hub, tab } = await bridgeWithTab();
    tab.onInvoke = (msg) => tab.ack(msg.id);
    const res = await hub.invoke({ tool: "patch_cells" as never, args: {}, readOnly: false, deadlineMs: 400, idempotencyKey: "k" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(RelayErrorCode.UNKNOWN_OUTCOME);
    // 書き込みは打ち切らない（タブに完了させる）
    await sleep(ACK_MS * 2);
    expect(tab.frames("tool.cancel")).toHaveLength(0);
  });

  it("処理中に切断したら読み取りは TAB_DISCONNECTED", async () => {
    const { hub, tab } = await bridgeWithTab();
    tab.onInvoke = (msg) => {
      tab.ack(msg.id);
      setTimeout(() => tab.close(), 10);
    };
    const res = await invokeRead(hub);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(RelayErrorCode.TAB_DISCONNECTED);
      expect(res.retryable).toBe(true);
    }
  });

  it("処理中に切断したら書き込みは UNKNOWN_OUTCOME", async () => {
    const { hub, tab } = await bridgeWithTab();
    tab.onInvoke = (msg) => {
      tab.ack(msg.id);
      setTimeout(() => tab.close(), 10);
    };
    const res = await invokeWrite(hub);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe(RelayErrorCode.UNKNOWN_OUTCOME);
  });
});

describe("複数のタブ", () => {
  it("後からフォーカスしたタブが primary になる", async () => {
    const hub = new LocalHub({ timeoutScale: SCALE });
    const bridge = await startTestBridge({ hub });
    const first = await FakeTab.connect(bridge, { focused: true });
    const second = await FakeTab.connect(bridge, { focused: false });
    expect((await hub.status()).primaryTabId).toBe(first.tabId);
    second.send({ type: "tab.focus", tabId: second.tabId });
    await waitFor(async () => (await hub.status()).primaryTabId === second.tabId);
    const roles = first.frames("tab.roles");
    expect(roles[roles.length - 1]?.primaryTabId).toBe(second.tabId);
  });

  it("応答しない読み取りは別のタブへ 1 回だけ送り直す", async () => {
    const hub = new LocalHub({ timeoutScale: SCALE });
    const bridge = await startTestBridge({ hub });
    const first = await FakeTab.connect(bridge, { focused: true });
    const second = await FakeTab.connect(bridge, { focused: false });
    first.onInvoke = () => undefined;
    second.onInvoke = (msg) => second.answer(msg.id, "別のタブが答えた");
    const res = await invokeRead(hub);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.content[0]?.text).toBe("別のタブが答えた");
    await waitFor(() => first.frames("tool.cancel").length === 1);
    expect(first.frames("tool.cancel")[0]?.reason).toBe("superseded");
  });
});
