// 作業を別の窓へ移す（画面側）: シートの数を Hub に知らせること、移すよう頼まれたら送ること、受け取った作業を作り直すこと。
import { describe, expect, it, vi } from "vitest";
import { confirmWorkMoved, fetchWorkFromOtherWindow } from "../../src/app/boot/handoff";
import { HANDOFF_ENDPOINTS } from "../../src/app/boot/runtime";
import { RelaySocket, type WebSocketLike } from "../../src/app/relay/socket";
import { Workspace } from "../../src/app/store/workspace";
import { makeParentKey, type SheetMeta, type SheetRow } from "../../src/shared/sheet";

class FakeWs implements WebSocketLike {
  static last: FakeWs | null = null;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: string[] = [];
  constructor() {
    FakeWs.last = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  frames(type: string): Record<string, unknown>[] {
    return this.sent.filter((s) => s.startsWith("{")).map((s) => JSON.parse(s) as Record<string, unknown>).filter((f) => f.type === type);
  }
}

function sampleWorkspace(): Workspace {
  const ws = new Workspace("作業 A");
  const key = makeParentKey(["A-100"]);
  const meta: SheetMeta = {
    name: "資産",
    source: { kind: "maximo", os: "MXAPIASSET", select: ["ASSETNUM"], where: [], baseUrl: "https://maximo.example.com" },
    columns: [{ name: "ASSETNUM", type: "string" }, { name: "DESCRIPTION", type: "string" }],
    keyColumns: ["ASSETNUM"],
    childIdAttrs: {},
  };
  const rows: SheetRow[] = [{ rowKey: key, parentKey: key, childName: null, values: { ASSETNUM: "A-100", DESCRIPTION: "ポンプ" } }];
  ws.createSheet(meta, rows);
  return ws;
}

function socket(opts: { sheets: () => number; onExport?: (t: string) => void; onRelease?: (t: string) => void }) {
  const relay = new RelaySocket({
    url: "ws://127.0.0.1:1/ws",
    appVersion: "test",
    tools: [],
    handler: async () => ({ result: { content: [] }, revision: 0 }),
    getRevision: () => 0,
    getWorkspace: () => "作業",
    getSheetCount: opts.sheets,
    onWorkspaceExport: opts.onExport,
    onWorkspaceRelease: opts.onRelease,
    tabId: "tab-1",
    WebSocketImpl: FakeWs as unknown as new (url: string, protocols?: string | string[]) => WebSocketLike,
    window: null,
    document: null,
  });
  relay.start();
  const ws = FakeWs.last as FakeWs;
  ws.open();
  return { relay, ws };
}

describe("シートの数を Hub に知らせる", () => {
  it("hello に載せ、変わったときだけ tab.state を送る", () => {
    let sheets = 0;
    const { relay, ws } = socket({ sheets: () => sheets });
    expect(ws.frames("hello")[0]).toMatchObject({ sheets: 0 });
    relay.notifyState();
    expect(ws.frames("tab.state")).toHaveLength(0);
    sheets = 2;
    relay.notifyState();
    relay.notifyState();
    expect(ws.frames("tab.state")).toEqual([{ type: "tab.state", tabId: "tab-1", sheets: 2 }]);
    relay.stop();
  });

  it("primary の窓のシートの数を状態に載せる", () => {
    const { relay, ws } = socket({ sheets: () => 0 });
    ws.receive({ type: "welcome", role: "mirror", primaryTabId: "tab-2", heartbeatMs: 20_000, primarySheets: 3 });
    expect(relay.getStatus()).toMatchObject({ role: "mirror", primarySheets: 3 });
    ws.receive({ type: "tab.roles", primaryTabId: "tab-1", primarySheets: 0 });
    expect(relay.getStatus()).toMatchObject({ role: "primary", primarySheets: 0 });
    relay.stop();
  });

  it("移すよう頼まれたら・移り終わったら知らせる（形の合わない token は無視する）", () => {
    const onExport = vi.fn();
    const onRelease = vi.fn();
    const { relay, ws } = socket({ sheets: () => 1, onExport, onRelease });
    const token = "a".repeat(32);
    ws.receive({ type: "workspace.export", token });
    ws.receive({ type: "workspace.export", token: "../../x" });
    ws.receive({ type: "workspace.release", token });
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledWith(token);
    expect(onRelease).toHaveBeenCalledWith(token);
    relay.stop();
  });
});

describe("受け取った作業を作り直す", () => {
  it("送り元の作業（toJSON）から、同じシートと値を持つ作業を作る", async () => {
    const source = sampleWorkspace();
    source.applyEdits("資産", [{ rowKey: makeParentKey(["A-100"]), col: "DESCRIPTION", value: "ポンプ（更新）" }], { author: "user" });
    const token = "b".repeat(32);
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      expect(JSON.parse(String(init?.body))).toEqual({ tabId: "tab-target" });
      return new Response(JSON.stringify({ ok: true, token, workspace: source.toJSON() }), { status: 200 });
    }) as typeof fetch;
    const got = await fetchWorkFromOtherWindow("tab-target", { fetch: fetchImpl });
    if (!got.ok) throw new Error(got.reason);
    expect(calls).toEqual([HANDOFF_ENDPOINTS.start]);
    expect(got.token).toBe(token);
    expect(got.workspace.name).toBe("作業 A");
    expect(got.workspace.cell("資産", makeParentKey(["A-100"]), "DESCRIPTION")?.value).toBe("ポンプ（更新）");
    // 変更の履歴（取り消し）も移る
    expect(got.workspace.revision).toBe(source.revision);
  });

  it("移せない理由を返す", async () => {
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await fetchWorkFromOtherWindow("t", { fetch: reply(409, { ok: false, error: "committing" }) })).toEqual({ ok: false, reason: "committing" });
    expect(await fetchWorkFromOtherWindow("t", { fetch: reply(504, { ok: false, error: "handoff_timeout" }) })).toEqual({ ok: false, reason: "timeout" });
    expect(await fetchWorkFromOtherWindow("t", { fetch: reply(200, { ok: true, token: "x", workspace: { format: "other" } }) })).toEqual({ ok: false, reason: "invalid" });
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await fetchWorkFromOtherWindow("t", { fetch: down })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("作り直し終えたら done を送る", async () => {
    const sent: unknown[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push([String(input), JSON.parse(String(init?.body))]);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    expect(await confirmWorkMoved("c".repeat(32), "tab-target", { fetch: fetchImpl })).toBe(true);
    expect(sent).toEqual([[HANDOFF_ENDPOINTS.done, { token: "c".repeat(32), tabId: "tab-target" }]]);
  });
});
