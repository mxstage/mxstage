// ライセンスと環境（本番／テスト）の関門（src/app/license・src/app/commit/controller.ts）。
// 有償なのは本番の Maximo への「Maximo に反映」だけ。テスト環境と、本番での読み込み・編集には何も求めない。

import { describe, expect, it, vi } from "vitest";
import { ObjectStructureCatalog } from "../../src/app/catalog/catalog";
import { blockedMessagePrefix, createCommitController, alreadyRunningMessage } from "../../src/app/commit/controller";
import { ENVIRONMENTS_STORAGE_KEY, LicenseClient, daysUntilExpiry, type AuthorizeOutcome, type LicenseGate, type LicenseSnapshot } from "../../src/app/license/client";
import { authorizeFailure, licenseBlocker } from "../../src/app/license/gate";
import { PRICING_URL } from "../../src/app/license/messages";
import { MaximoClient } from "../../src/app/maximo/client";
import type { ToolContext } from "../../src/app/relay";
import type { MaximoConnection } from "../../src/app/runtime/contracts";
import { JobRegistry, Workspace } from "../../src/app/store";
import { createToolRegistry } from "../../src/app/tools/registry";
import { setLocale } from "../../src/shared/i18n";
import type { LicenseEntry } from "../../src/shared/license";
import type { InvokeMsg } from "../../src/shared/protocol";
import type { ToolName } from "../../src/shared/toolDefs";
import { createFakeMaximo, sampleSeed } from "../fakes/fake-maximo";

const ACME: LicenseEntry = { state: "valid", licenseId: "lic_acme", org: "ACME Corp", hosts: ["https://maximo.test"], expiresAt: "2027-10-31T00:00:00.000Z" };

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

/** 橋渡しの入口の代わり。GET は licenses、POST は応答を差し替えられる */
function bridge(licenses: LicenseEntry[] = [], handlers: Record<string, (body: Record<string, unknown>) => { status: number; body: unknown }> = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1:8788");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method, path: url.pathname, body });
    if (method === "GET") return new Response(JSON.stringify({ ok: true, licenses }), { status: 200 });
    const h = handlers[url.pathname];
    const out = h ? h(body) : { status: 404, body: {} };
    return new Response(JSON.stringify(out.body), { status: out.status });
  });
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

describe("LicenseClient（橋渡しの入口と接続先ごとの申告）", () => {
  it("キーの一覧を読み、接続先がキーの本番の接続先に含まれればその接続先は本番（申告より優先）", async () => {
    const storage = memoryStorage();
    const client = new LicenseClient({ fetch: bridge([ACME]).fetch, storage });
    expect(client.snapshot().status).toBe("loading");
    await client.refresh();
    expect(client.snapshot()).toMatchObject({ status: "ready", licenses: [ACME] });
    expect(client.licenseFor("https://MAXIMO.test/maximo/")).toEqual(ACME);
    expect(client.licenseFor("https://other.test/maximo")).toBeNull();

    client.declare("https://maximo.test/maximo", "test");
    expect(client.environmentOf("https://maximo.test/maximo")).toBe("production");
    expect(client.environmentOf("https://dev.test/maximo")).toBeNull();
    client.declare("https://dev.test/maximo/", "test");
    expect(client.environmentOf("https://dev.test/maximo")).toBe("test");
    expect(JSON.parse(storage.map.get(ENVIRONMENTS_STORAGE_KEY)!)).toEqual({ "https://maximo.test/maximo": "test", "https://dev.test/maximo": "test" });
  });

  it("橋渡しが応えなければ unavailable（本番のキーは無いものとして扱う）", async () => {
    const client = new LicenseClient({ fetch: (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch });
    await client.refresh();
    expect(client.snapshot().status).toBe("unavailable");
    expect(client.licenseFor("https://maximo.test")).toBeNull();
    const broken = new LicenseClient({ fetch: (async () => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch });
    await broken.refresh();
    expect(broken.snapshot().status).toBe("unavailable");
  });

  it("保存・外す・反映の許可を橋渡しに頼み、一覧を更新する", async () => {
    const b = bridge([], {
      "/_mxstage/license": (body) =>
        body.key === "good" ? { status: 200, body: { ok: true, license: ACME, licenses: [ACME] } } : { status: 422, body: { ok: false, problem: "signature", licenses: [] } },
      "/_mxstage/license/remove": () => ({ status: 200, body: { ok: true, removed: true, licenses: [] } }),
      "/_mxstage/license/authorize": (body) =>
        body.baseUrl === "https://maximo.test/maximo"
          ? { status: 200, body: { ok: true, host: "https://maximo.test", license: ACME } }
          : { status: 403, body: { ok: false, problem: "not_licensed", licensedHosts: ["https://maximo.test"] } },
    });
    const client = new LicenseClient({ fetch: b.fetch });
    const seen = vi.fn();
    client.subscribe(seen);
    expect(await client.save("bad")).toEqual({ ok: false, problem: "signature" });
    expect(await client.save("good")).toEqual({ ok: true, license: ACME });
    expect(client.snapshot().licenses).toEqual([ACME]);
    expect(await client.authorize("https://maximo.test/maximo")).toEqual({ ok: true, license: ACME });
    expect(await client.authorize("https://other.test/maximo")).toEqual({ ok: false, problem: "not_licensed", licensedHosts: ["https://maximo.test"] });
    expect(await client.remove("lic_acme")).toBe(true);
    expect(client.snapshot().licenses).toEqual([]);
    expect(seen).toHaveBeenCalled();
    // 同一オリジンの fetch（相対の URL）だけを使う。GET にはキャッシュ避けを付ける
    expect(b.calls.every((c) => c.path.startsWith("/_mxstage/license"))).toBe(true);
  });

  it("期限までの日数", () => {
    expect(daysUntilExpiry(ACME, Date.UTC(2027, 9, 1))).toBe(30);
    expect(daysUntilExpiry({ ...ACME, expiresAt: undefined }, 0)).toBeNull();
  });
});

/** 反映の関門だけを試すための LicenseGate */
function fakeGate(opts: { environment?: "production" | "test" | null; licensed?: LicenseEntry | null; snapshot?: Partial<LicenseSnapshot>; authorize?: () => Promise<AuthorizeOutcome> } = {}): LicenseGate & { authorize: ReturnType<typeof vi.fn> } {
  const snap: LicenseSnapshot = { status: "ready", licenses: opts.licensed ? [opts.licensed] : [], version: 1, ...opts.snapshot };
  return {
    snapshot: () => snap,
    subscribe: () => () => undefined,
    licenseFor: () => opts.licensed ?? null,
    environmentOf: () => (opts.environment === undefined ? (opts.licensed ? "production" : null) : opts.environment),
    authorize: vi.fn(opts.authorize ?? (async () => (opts.licensed ? { ok: true as const, license: opts.licensed } : { ok: false as const, problem: "no_license" as const, licensedHosts: [] }))),
  };
}

describe("licenseBlocker（反映の関門の文）", () => {
  it("テストには何も求めない。環境を選んでいなければ選ぶように言う", () => {
    expect(licenseBlocker(fakeGate({ environment: "test" }), "https://dev.test/maximo")).toBeNull();
    expect(licenseBlocker(fakeGate({ environment: null }), "https://dev.test/maximo")).toContain("本番かテストかを設定で選んで");
    expect(licenseBlocker(fakeGate({ licensed: ACME }), "https://maximo.test/maximo")).toBeNull();
  });

  it("本番でキーが無ければ、理由・買い方・無償で続けられることを言う（LLM もこの文で説明する）", () => {
    const why = licenseBlocker(fakeGate({ environment: "production" }), "https://prod.acme.test/maximo")!;
    expect(why).toContain("https://prod.acme.test");
    expect(why).toContain(PRICING_URL);
    expect(why).toContain("読み込み・Skill・編集はライセンス無しで続けられます");
    const other = licenseBlocker(fakeGate({ environment: "production", snapshot: { licenses: [ACME] } }), "https://prod.acme.test/maximo")!;
    expect(other).toContain("ライセンスの本番: https://maximo.test");
    setLocale("en");
    expect(licenseBlocker(fakeGate({ environment: "production" }), "https://prod.acme.test/maximo")).toContain("needs a license");
  });

  it("期限切れ・取り消し・橋渡しが応えないときは、それぞれの理由を言う", () => {
    const expired = { ...ACME, state: "expired" as const };
    expect(licenseBlocker(fakeGate({ environment: "production", snapshot: { licenses: [expired] } }), "https://maximo.test/maximo")).toContain("期限が切れています");
    const revoked = { ...ACME, state: "revoked" as const };
    expect(licenseBlocker(fakeGate({ environment: "production", snapshot: { licenses: [revoked] } }), "https://maximo.test/maximo")).toContain("取り消されています");
    expect(licenseBlocker(fakeGate({ environment: "production", snapshot: { status: "unavailable" } }), "https://maximo.test/maximo")).toContain("確かめられません");
    expect(authorizeFailure({ ok: false, problem: "unavailable", licensedHosts: [] }, "https://maximo.test")).toContain("確かめられません");
  });
});

const APP_URL = "https://mxstage.test/app";
const SHEET = "作業指示";

async function prepared(license: LicenseGate) {
  const fake = createFakeMaximo(sampleSeed());
  const client = new MaximoClient({ baseUrl: fake.baseUrl, apiKey: () => fake.apiKey, via: "direct", fetchImpl: fake.fetch, sleep: async () => {} });
  const conn: MaximoConnection = { info: { baseUrl: fake.baseUrl, via: "direct", connectionName: "MAXADMIN@test", userName: "MAXADMIN", connectedAt: 1 }, client };
  const connection = { current: () => conn, subscribe: () => () => undefined };
  const workspace = new Workspace("作業");
  const controller = createCommitController({ workspace, connection, license });
  const registry = createToolRegistry({ workspace, jobs: new JobRegistry(), connection, commits: controller, catalog: new ObjectStructureCatalog(), appVersion: "test", appUrl: APP_URL });
  let seq = 0;
  const call = async (tool: string, args: unknown) => {
    const msg: InvokeMsg = { type: "tool.invoke", id: `c${++seq}`, tool: tool as ToolName, args, deadlineAt: Date.now() + 30_000, timeoutMs: 30_000, idempotencyKey: "", readOnly: false };
    const ctx: ToolContext = { signal: new AbortController().signal, progress: () => {} };
    return (await registry.handler(msg, ctx)).result.structuredContent as Record<string, any>;
  };
  // 本番でも読み込みと編集はライセンス無しでできる
  await call("load_sheet", { name: SHEET, os: "MXAPIWO", select: ["WONUM", "SITEID", "DESCRIPTION"] });
  const edited = await call("apply_rule", { sheet: SHEET, filter: [{ attr: "WONUM", op: "eq", value: "WO1001" }], set: { DESCRIPTION: { const: "ポンプ点検（更新）" } }, baseRevision: workspace.revision, reason: "試験" });
  expect(edited.applied).toBe(1);
  fake.state.requests.length = 0;
  return { fake, controller, workspace };
}

/** 反映を最後まで進める（カナリアの確認が出たら続ける） */
async function finish<T>(controller: { panel(s: string): { awaitingCanary: unknown }; continueCanary(s: string, p: boolean): void }, run: Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    if (controller.panel(SHEET).awaitingCanary !== null) controller.continueCanary(SHEET, true);
  }, 5);
  try {
    return await run;
  } finally {
    clearInterval(timer);
  }
}

const posts = (fake: ReturnType<typeof createFakeMaximo>) => fake.state.requests.filter((r) => r.method === "POST");

describe("CommitController の関門", () => {
  it("本番でキーが無ければ、読み込み・編集はできるが反映は blocker で止まり、Maximo には何も送らない", async () => {
    const gate = fakeGate({ environment: "production" });
    const { fake, controller } = await prepared(gate);
    const panel = controller.panel(SHEET);
    expect(panel.counts.changedCells).toBe(1);
    expect(panel.blockers.some((b) => b.includes("ライセンスが要ります"))).toBe(true);
    const res = await controller.run(SHEET, {});
    expect(res.message?.startsWith(blockedMessagePrefix())).toBe(true);
    expect(gate.authorize).not.toHaveBeenCalled();
    expect(posts(fake)).toEqual([]);
  });

  it("テスト環境ではキーを求めず、橋渡しにも確かめない", async () => {
    const gate = fakeGate({ environment: "test" });
    const { controller } = await prepared(gate);
    expect(controller.panel(SHEET).blockers).toEqual([]);
    expect((await finish(controller, controller.run(SHEET, {}))).state).toBe("done");
    expect(gate.authorize).not.toHaveBeenCalled();
  });

  it("本番でキーがあれば、送る直前に橋渡しで確かめてから反映する。確かめている間は二重の実行と編集を止める", async () => {
    let release: (v: AuthorizeOutcome) => void = () => undefined;
    const gate = fakeGate({ licensed: ACME, authorize: () => new Promise<AuthorizeOutcome>((r) => (release = r)) });
    const { fake, controller } = await prepared(gate);
    expect(controller.panel(SHEET).blockers).toEqual([]);
    const run = controller.run(SHEET, {});
    await vi.waitFor(() => expect(gate.authorize).toHaveBeenCalledWith(fake.baseUrl));
    expect(controller.isRunning(SHEET)).toBe(true);
    expect((await controller.run(SHEET, {})).message).toBe(alreadyRunningMessage());
    expect(posts(fake)).toEqual([]);
    release({ ok: true, license: ACME });
    expect((await finish(controller, run)).state).toBe("done");
    expect(posts(fake).length).toBeGreaterThan(0);
  });

  it("手元の一覧ではキーがあっても、橋渡しが断れば送らない（期限切れ・取り消し・つながらない）", async () => {
    const gate = fakeGate({ licensed: ACME, authorize: async () => ({ ok: false, problem: "expired", licensedHosts: [] }) });
    const { fake, controller } = await prepared(gate);
    const res = await controller.run(SHEET, {});
    expect(res.message).toContain("期限が切れています");
    expect(controller.isRunning(SHEET)).toBe(false);
    expect(posts(fake)).toEqual([]);
  });
});
