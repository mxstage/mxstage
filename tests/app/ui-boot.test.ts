// 起動時の結線（Workspace・反映コントローラ・ツール実行・中継ソケット）の試験。

import { describe, expect, it, vi } from "vitest";
import { ObjectStructureCatalog } from "../../src/app/catalog/catalog";
import { RELAY_SUBPROTOCOL } from "../../src/shared/protocol";
import { createRuntime, commitRequesterOf, defaultWorkspaceName, type RuntimeFactories } from "../../src/app/boot/runtime";
import type { WebSocketFactory, WebSocketLike } from "../../src/app/relay";
import type { CommitController, CommitPanelState, ConnectionProvider, ToolRegistryDeps } from "../../src/app/runtime/contracts";
import type { SheetMeta } from "../../src/shared/sheet";

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed: number | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closed = code ?? 1000;
    this.readyState = 3;
  }
}

const PANEL: CommitPanelState = {
  sheet: "WO",
  state: "idle",
  counts: { parents: 0, changedCells: 0, addedRows: 0, deletedRows: 0 },
  blockers: [],
  needsDeleteConfirm: false,
  needsNullConfirm: false,
  awaitingCanary: null,
  results: [],
};

function fakeController(): CommitController {
  return {
    request: () => PANEL,
    panel: () => PANEL,
    isRunning: () => false,
    run: async () => PANEL,
    continueCanary: () => undefined,
    cancel: () => undefined,
    dismiss: () => undefined,
    subscribe: () => () => undefined,
    writeLog: () => [],
    writeLogCsv: () => "",
    lastRun: () => null,
  };
}

const connection: ConnectionProvider = { current: () => null, subscribe: () => () => undefined };

/** 中身は問わないシート（Maximo に触らない Excel 由来） */
function excelMeta(name: string): SheetMeta {
  return {
    name,
    source: { kind: "excel", importId: "imp1", fileName: "f.xlsx", sheetName: "Sheet1", headerRow: 1 },
    columns: [{ name: "ID", type: "string" }],
    keyColumns: ["ID"],
    childIdAttrs: {},
  };
}

function setup(overrides: Partial<RuntimeFactories> = {}) {
  FakeWebSocket.instances = [];
  let toolDeps: ToolRegistryDeps | null = null;
  const handler = vi.fn(async () => ({ result: { content: [] as Array<{ type: "text"; text: string }> }, revision: 0 }));
  const factories: RuntimeFactories = {
    createCommitController: () => fakeController(),
    createToolRegistry: (deps) => {
      toolDeps = deps;
      return { tools: ["get_status", "load_sheet"], handler };
    },
    ...overrides,
  };
  const runtime = createRuntime({
    connection,
    catalog: new ObjectStructureCatalog(),
    factories,
    appVersion: "1.2.3",
    origin: "https://mxstage.test",
    relayUrl: "wss://mxstage.test/ws",
    workspaceName: "作業A",
    relayOverrides: { WebSocketImpl: FakeWebSocket as unknown as WebSocketFactory, window: null, document: null, tabId: "tab-test" },
  });
  return { runtime, deps: () => toolDeps };
}

describe("createRuntime", () => {
  it("ツールに作業データと反映の依頼口を渡す（実行はできない）", () => {
    const { runtime, deps } = setup();
    const d = deps();
    expect(d).not.toBeNull();
    expect(d?.workspace).toBe(runtime.workspace);
    expect(d?.jobs).toBe(runtime.workspace.jobs);
    expect(d?.connection).toBe(connection);
    expect(d?.appVersion).toBe("1.2.3");
    expect(d?.appUrl).toBe("https://mxstage.test/app");
    // LLM のツールからは Maximo へ書き込めない
    expect(Object.keys(d?.commits ?? {}).sort()).toEqual(["isRunning", "panel", "request"]);
    expect((d?.commits as unknown as { run?: unknown }).run).toBeUndefined();
    runtime.dispose();
  });

  it("start で中継につなぎ、hello にツール名と作業名を載せる", () => {
    const { runtime } = setup();
    expect(runtime.relayStatus().state).toBe("closed");
    runtime.start();
    const ws = FakeWebSocket.instances[0];
    expect(ws?.url).toBe("wss://mxstage.test/ws");
    expect(ws?.protocols).toBe(RELAY_SUBPROTOCOL);
    expect(runtime.relayStatus().state).toBe("connecting");

    ws!.readyState = 1;
    ws!.onopen?.({});
    const hello = JSON.parse(ws!.sent[0] ?? "{}") as Record<string, unknown>;
    expect(hello.type).toBe("hello");
    expect(hello.tools).toEqual(["get_status", "load_sheet"]);
    expect(hello.appVersion).toBe("1.2.3");
    expect(hello.workspace).toBe("作業A");
    expect(hello.revision).toBe(0);
    runtime.dispose();
  });

  it("中継の状態の変化を購読できる", () => {
    const { runtime } = setup();
    const seen: string[] = [];
    const unsubscribe = runtime.subscribeRelay(() => seen.push(runtime.relayStatus().state));
    runtime.start();
    expect(seen).toContain("connecting");
    unsubscribe();
    runtime.dispose();
    expect(FakeWebSocket.instances[0]?.closed).not.toBeNull();
  });

  it("作業終了（dispose）は実行中の反映を打ち切る", () => {
    const cancelled: string[] = [];
    const running = new Set<string>(["WO"]);
    const controller = fakeController();
    controller.isRunning = (sheet: string) => running.has(sheet);
    controller.cancel = (sheet: string) => void cancelled.push(sheet);
    const { runtime } = setup({ createCommitController: () => controller });
    for (const name of ["WO", "ASSET"]) runtime.workspace.createSheet(excelMeta(name), []);

    runtime.dispose();
    // 反映中のシートだけ打ち切る（捨てた作業データのために残りを Maximo へ送らせない）
    expect(cancelled).toEqual(["WO"]);
    // 2 回目の dispose では何もしない
    runtime.dispose();
    expect(cancelled).toEqual(["WO"]);
  });

  it("作業名の既定値", () => {
    expect(defaultWorkspaceName(new Date(2026, 8, 16, 10, 30))).toBe("作業 2026-09-16 10:30");
  });

  it("反映の依頼口は controller に委譲する", () => {
    const controller = fakeController();
    const request = vi.fn(() => PANEL);
    controller.request = request;
    const requester = commitRequesterOf(controller);
    requester.request("WO", "確認してください", "llm");
    expect(request).toHaveBeenCalledWith("WO", "確認してください", "llm");
  });
});
