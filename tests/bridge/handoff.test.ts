// 作業のある窓を primary に保つことと、作業を別の窓へ移すこと（src/bridge/hub.ts・handoff.ts）。
import { afterEach, describe, expect, it } from "vitest";
import { HANDOFF_DONE_PATH, HANDOFF_REFUSE_PATH, HANDOFF_START_PATH, HANDOFF_UPLOAD_PATH } from "../../src/bridge/handoff.ts";
import { LocalHub } from "../../src/bridge/hub.ts";
import { FakeTab, SCALE, rawRequest, startTestBridge, stopAll, waitFor } from "./support.ts";

afterEach(async () => {
  await stopAll();
});

const JSON_HEADERS = { "content-type": "application/json", "sec-fetch-site": "same-origin" };

async function bridgeWithHub() {
  const hub = new LocalHub({ timeoutScale: SCALE });
  const bridge = await startTestBridge({ hub });
  return { hub, bridge };
}

describe("作業のある窓を primary に保つ", () => {
  it("シートの無い窓は、フォーカスしても作業のある窓から primary を奪わない", async () => {
    const { hub, bridge } = await bridgeWithHub();
    const working = await FakeTab.connect(bridge, { tabId: "tab-working", sheets: 3 });
    expect(hub.primaryTabId()).toBe("tab-working");
    const empty = await FakeTab.connect(bridge, { tabId: "tab-empty", sheets: 0, focused: true });
    expect(hub.primaryTabId()).toBe("tab-working");
    // ミラーの窓には、primary にシートがいくつあるかを知らせる
    const welcome = await empty.waitFor("welcome");
    expect(welcome).toMatchObject({ role: "mirror", primaryTabId: "tab-working", primarySheets: 3 });
    empty.send({ type: "tab.focus", tabId: "tab-empty" });
    await new Promise((r) => setTimeout(r, 30));
    expect(hub.primaryTabId()).toBe("tab-working");
    expect(working.frames("tab.roles").every((f) => f.primaryTabId === "tab-working")).toBe(true);
  });

  it("どちらにも作業があれば、これまでどおりフォーカスした窓が primary になる", async () => {
    const { hub, bridge } = await bridgeWithHub();
    await FakeTab.connect(bridge, { tabId: "tab-a", sheets: 1 });
    const b = await FakeTab.connect(bridge, { tabId: "tab-b", sheets: 2, focused: false });
    expect(hub.primaryTabId()).toBe("tab-a");
    b.send({ type: "tab.focus", tabId: "tab-b" });
    await waitFor(() => hub.primaryTabId() === "tab-b");
  });

  it("primary の作業が空になり、別の窓に作業があれば、その窓を primary にする", async () => {
    const { hub, bridge } = await bridgeWithHub();
    const a = await FakeTab.connect(bridge, { tabId: "tab-a", sheets: 0 });
    const b = await FakeTab.connect(bridge, { tabId: "tab-b", sheets: 0, focused: false });
    expect(hub.primaryTabId()).toBe("tab-a");
    b.send({ type: "tab.state", tabId: "tab-b", sheets: 2 });
    await waitFor(() => hub.primaryTabId() === "tab-b");
    await a.waitFor("tab.roles");
    expect(a.frames("tab.roles").at(-1)).toMatchObject({ primaryTabId: "tab-b", primarySheets: 2 });
  });

  it("シートの数を知らせない古い画面は、これまでどおりフォーカスで primary になる", async () => {
    const { hub, bridge } = await bridgeWithHub();
    await FakeTab.connect(bridge, { tabId: "tab-a", sheets: 2 });
    const old = await FakeTab.connect(bridge, { tabId: "tab-old", focused: false });
    old.send({ type: "tab.focus", tabId: "tab-old" });
    await waitFor(() => hub.primaryTabId() === "tab-old");
  });
});

describe("作業を別の窓へ移す", () => {
  it("作業のある窓が送った作業を、移したい窓に渡し、終わったら送り元に知らせる", async () => {
    const { bridge } = await bridgeWithHub();
    const source = await FakeTab.connect(bridge, { tabId: "tab-source", sheets: 2 });
    await FakeTab.connect(bridge, { tabId: "tab-target", sheets: 0 });

    const started = rawRequest(bridge, HANDOFF_START_PATH, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ tabId: "tab-target" }) });
    const exportFrame = await source.waitFor("workspace.export");
    const token = String(exportFrame.token);
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    const work = { format: "mxstage.workspace.v1", name: "作業", sheets: [{ big: "x".repeat(2_000_000) }] };
    const upload = await rawRequest(bridge, `${HANDOFF_UPLOAD_PATH}?token=${token}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(work) });
    expect(upload.status).toBe(200);

    const res = await started;
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; token: string; workspace: typeof work };
    expect(body).toMatchObject({ ok: true, token });
    expect(body.workspace.sheets[0]?.big).toHaveLength(2_000_000);

    // 移したい窓以外からの done は受けない
    const wrong = await rawRequest(bridge, HANDOFF_DONE_PATH, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, tabId: "tab-source" }) });
    expect(wrong.status).toBe(404);
    const done = await rawRequest(bridge, HANDOFF_DONE_PATH, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, tabId: "tab-target" }) });
    expect(JSON.parse(done.body)).toMatchObject({ ok: true, released: true });
    expect(await source.waitFor("workspace.release")).toMatchObject({ token });
  });

  it("作業のある窓が断ったら、理由を返す", async () => {
    const { bridge } = await bridgeWithHub();
    const source = await FakeTab.connect(bridge, { tabId: "tab-source", sheets: 1 });
    await FakeTab.connect(bridge, { tabId: "tab-target", sheets: 0 });
    const started = rawRequest(bridge, HANDOFF_START_PATH, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ tabId: "tab-target" }) });
    const token = String((await source.waitFor("workspace.export")).token);
    await rawRequest(bridge, HANDOFF_REFUSE_PATH, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, reason: "committing" }) });
    const res = await started;
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: "committing" });
  });

  it("作業のある窓が無ければ移さない。ほかのサイトからは受けない", async () => {
    const { bridge } = await bridgeWithHub();
    await FakeTab.connect(bridge, { tabId: "tab-target", sheets: 0 });
    const none = await rawRequest(bridge, HANDOFF_START_PATH, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ tabId: "tab-target" }) });
    expect(none.status).toBe(409);
    expect(JSON.parse(none.body)).toMatchObject({ error: "no_source" });
    const crossSite = await rawRequest(bridge, HANDOFF_START_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ tabId: "tab-target" }),
    });
    expect(crossSite.status).toBe(403);
    const unknown = await rawRequest(bridge, `${HANDOFF_UPLOAD_PATH}?token=${"0".repeat(32)}`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
    expect(unknown.status).toBe(404);
  });
});
