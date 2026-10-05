// Maximo が無くても試せるデモ（作業画面の側）: 接続先の一覧のデモ・環境は常にテスト・設定の「デモ」・get_status の案内。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoConnector } from "../../src/app/connections/auto";
import { SELECTED_CONNECTION_KEY, SavedConnectionsClient, type SavedConnection } from "../../src/app/connections/client";
import { parseDemoStatus, type DemoApi, type DemoState } from "../../src/app/demo/client";
import { ImportStore } from "../../src/app/imports";
import type { VaultView } from "../../src/app/keyvault/client";
import { LicenseClient } from "../../src/app/license/client";
import type { MaximoConnectionInfo } from "../../src/app/runtime/contracts";
import { DemoSection } from "../../src/app/settings/DemoSection";
import { validateSettingsForm } from "../../src/app/settings/logic";
import type { SettingsVault } from "../../src/app/settings/SettingsPage";
import { demoStatusView } from "../../src/app/tools/registry";
import { setLocale } from "../../src/shared/i18n";
import { DEMO_ORIGINS, type DemoLang, type DemoStatus } from "../../src/shared/demo";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function conn(id: string, baseUrl: string, extra: Partial<SavedConnection> = {}): SavedConnection {
  return { id, name: id, baseUrl, environment: "test", createdAt: 0, updatedAt: 0, lastUsedAt: null, ...extra };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

/** 橋渡しの /_mxstage/connections の偽物（落とし済みのデモは別の配列） */
function bridgeFetch(state: { connections: SavedConnection[]; demo: SavedConnection[]; lastUsedId: string | null }) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    if (url.startsWith("/_mxstage/connections/use")) state.lastUsedId = String(body?.id);
    return new Response(JSON.stringify({ ok: true, ...state, protection: "dpapi" }), { status: 200 });
  }) as typeof fetch;
}

const DEMO_JA = conn("demo-ja", DEMO_ORIGINS.ja, { name: "MX Stage demo (Japanese)" });

describe("接続先の一覧のデモ", () => {
  beforeEach(() => setLocale("ja"));
  afterEach(() => setLocale("en"));

  it("デモは別の配列で読み、画面の言語の名前にする。最後に使ったのがデモならデモを選ぶ", async () => {
    const client = new SavedConnectionsClient({ fetch: bridgeFetch({ connections: [], demo: [DEMO_JA], lastUsedId: "demo-ja" }), storage: memoryStorage() });
    await client.refresh();
    expect(client.snapshot().connections).toEqual([]);
    expect(client.snapshot().demo).toEqual([expect.objectContaining({ id: "demo-ja", name: "MX Stage デモ（日本語）", environment: "test" })]);
    expect(client.preferred()?.id).toBe("demo-ja");
  });

  it("「接続先が 1 つならそれ」にデモは数えない", async () => {
    const onlyDemo = new SavedConnectionsClient({ fetch: bridgeFetch({ connections: [], demo: [DEMO_JA], lastUsedId: null }), storage: memoryStorage() });
    await onlyDemo.refresh();
    expect(onlyDemo.preferred()).toBeNull();

    const real = conn("c_0123456789abcdef", "https://maximo.example.com");
    const both = new SavedConnectionsClient({ fetch: bridgeFetch({ connections: [real], demo: [DEMO_JA], lastUsedId: null }), storage: memoryStorage() });
    await both.refresh();
    expect(both.preferred()?.id).toBe(real.id);
  });

  it("この窓で選んだのがデモで、そのデモが消えていればつながない", async () => {
    const client = new SavedConnectionsClient({ fetch: bridgeFetch({ connections: [], demo: [], lastUsedId: null }), storage: memoryStorage({ [SELECTED_CONNECTION_KEY]: "demo-en" }) });
    await client.refresh();
    expect(client.preferred()).toBeNull();
  });
});

describe("デモの環境と入力の検査", () => {
  it("デモのオリジンは、本番と申告されていても常にテスト", () => {
    const storage = memoryStorage();
    const license = new LicenseClient({ fetch: async () => new Response("{}", { status: 503 }), storage });
    license.declare(DEMO_ORIGINS.en, "production");
    expect(license.environmentOf(DEMO_ORIGINS.en)).toBe("test");
    expect(license.environmentOf("https://maximo.example.com")).toBeNull();
  });

  it("予約のホストは接続先の URL として受けない", () => {
    const errors = validateSettingsForm({ baseUrl: "https://demo-ja.mxstage.invalid", via: "proxy", connectionName: "x", apiKey: "k" });
    expect(errors.baseUrl).toBeTruthy();
    expect(validateSettingsForm({ baseUrl: "https://maximo.example.com", via: "proxy", connectionName: "x", apiKey: "k" }).baseUrl).toBeUndefined();
  });

  it("get_status は、デモにつないでいるときだけデモの案内を載せる（英語）", () => {
    expect(demoStatusView(DEMO_ORIGINS.ja)).toMatchObject({ demo: { language: "ja", note: expect.stringContaining("built-in demo") } });
    expect(demoStatusView("https://maximo.example.com")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 設定の「デモ」
// ---------------------------------------------------------------------------

function status(over: Partial<Record<DemoLang, Partial<DemoStatus["languages"]["ja"]>>> = {}, extra: Partial<DemoStatus> = {}): DemoStatus {
  const lang = (l: DemoLang) => ({ state: "none" as const, totalBytes: null, receivedBytes: 0, error: null, ...over[l] });
  return { version: 2, dataHost: "mxstage-demo.pages.dev", languages: { ja: lang("ja"), en: lang("en") }, loaded: null, loading: null, idleUnloadMs: 3_600_000, excel: {}, ...extra };
}

const XLSX = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]);

class FakeDemoApi implements DemoApi {
  current: DemoStatus = status();
  calls: string[] = [];
  /** download を呼ばれたあと、status を何回読んだら落とし終えるか */
  readyAfter = 1;
  private reads = 0;
  private ok(): DemoState {
    return { kind: "ready", status: this.current, error: null };
  }
  status = async (): Promise<DemoState> => {
    this.calls.push("status");
    if (this.current.languages.ja.state === "downloading" && ++this.reads >= this.readyAfter) this.finish("ja");
    return this.ok();
  };
  download = async (lang: DemoLang): Promise<DemoState> => {
    this.calls.push(`download:${lang}`);
    this.current = status({ [lang]: { state: "downloading", totalBytes: 9_000_000, receivedBytes: 1_000_000 } });
    return this.ok();
  };
  finish(lang: DemoLang): void {
    this.current = status(
      { [lang]: { state: "ready", totalBytes: 9_000_000, receivedBytes: 9_000_000 } },
      { excel: { [lang]: [{ id: "purchase-orders", title: "発注一覧", fileName: "発注一覧.xlsx", bytes: XLSX.byteLength, sha256: "sha-ok" }] } },
    );
  }
  reset = async (): Promise<DemoState> => {
    this.calls.push("reset");
    return this.ok();
  };
  close = async (): Promise<DemoState> => {
    this.calls.push("close");
    this.current = { ...this.current, loaded: null };
    return this.ok();
  };
  remove = async (lang: DemoLang): Promise<DemoState> => {
    this.calls.push(`remove:${lang}`);
    this.current = status();
    return this.ok();
  };
  excel = async (): Promise<Uint8Array | null> => XLSX;
  excelUrl = (lang: DemoLang, id: string) => `/_mxstage/demo/excel/${lang}/${id}.xlsx`;
}

class FakeVault implements SettingsVault {
  view: VaultView = { kind: "disconnected" };
  private readonly listeners = new Set<() => void>();
  connect = async (): Promise<MaximoConnectionInfo> => {
    throw new Error("unused");
  };
  getView = (): VaultView => this.view;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  disconnect = (): void => this.set({ kind: "disconnected" });
  set(v: VaultView): void {
    this.view = v;
    for (const l of [...this.listeners]) l();
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("ja");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setLocale("en");
  vi.useRealTimers();
});

function buttonByText(text: string): HTMLButtonElement | HTMLAnchorElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>("button, a")).find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button "${text}" in: ${container.textContent}`);
  return found;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function setup(api: FakeDemoApi, extra: { imports?: ImportStore } = {}) {
  const vault = new FakeVault();
  const bridge = { connections: [] as SavedConnection[], demo: [] as SavedConnection[], lastUsedId: null as string | null };
  const connections = new SavedConnectionsClient({ fetch: bridgeFetch(bridge), storage: memoryStorage() });
  const connected: string[] = [];
  const autoConnect = new AutoConnector({
    saved: connections,
    vault: {
      getView: () => ({ kind: vault.view.kind }),
      disconnect: () => vault.disconnect(),
      connectSaved: async (saved) => {
        connected.push(saved.id);
        const info: MaximoConnectionInfo = { baseUrl: saved.baseUrl, via: "proxy", connectionName: saved.name, userName: null, connectedAt: 0, savedId: saved.id };
        vault.set({ kind: "connected", info });
        return info;
      },
    },
  });
  return { vault, bridge, connections, autoConnect, connected, ...extra };
}

describe("設定の「デモ」", () => {
  it("落とす大きさと置き場所を書き、押すと落としてからデモにつなぐ", async () => {
    const api = new FakeDemoApi();
    const s = setup(api);
    await act(async () => {
      root.render(createElement(DemoSection, { api, vault: s.vault, connections: s.connections, autoConnect: s.autoConnect }));
    });
    await settle();
    expect(container.textContent).toContain("mxstage-demo.pages.dev");
    expect(container.textContent).toContain("約 10 MB");
    expect(container.textContent).toContain("0.5 GB");
    // 何も押さなければ落とさない
    expect(api.calls.filter((c) => c.startsWith("download"))).toEqual([]);

    s.bridge.demo = [DEMO_JA];
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await act(async () => {
      buttonByText("データを落としてつなぐ").click();
    });
    await settle();
    expect(api.calls).toContain("download:ja");
    expect(container.textContent).toContain("落としています");
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    await settle();
    expect(s.connected).toEqual(["demo-ja"]);
    expect(container.textContent).toContain("デモにつないでいます");
    expect(buttonByText("作業画面を開く")).toBeTruthy();
  });

  it("サンプルの Excel を、SHA-256 を確かめて作業画面の置き場に入れる", async () => {
    const api = new FakeDemoApi();
    api.finish("ja");
    const imports = new ImportStore();
    const s = setup(api, { imports });
    await act(async () => {
      root.render(
        createElement(DemoSection, { api, vault: s.vault, connections: s.connections, autoConnect: s.autoConnect, imports, digest: async () => "sha-ok", newImportId: () => "demo-1" }),
      );
    });
    await settle();
    await act(async () => {
      buttonByText("作業画面に取り込む").click();
    });
    await settle();
    expect(imports.get("demo-1")).toMatchObject({ fileName: "発注一覧.xlsx", dropped: true, sha256: "sha-ok" });
    expect(container.textContent).toContain("発注一覧.xlsx を作業画面に入れました");
  });

  it("SHA-256 が合わなければ入れない", async () => {
    const api = new FakeDemoApi();
    api.finish("ja");
    const imports = new ImportStore();
    const s = setup(api, { imports });
    await act(async () => {
      root.render(createElement(DemoSection, { api, vault: s.vault, connections: s.connections, autoConnect: s.autoConnect, imports, digest: async () => "other", newImportId: () => "demo-2" }));
    });
    await settle();
    await act(async () => {
      buttonByText("作業画面に取り込む").click();
    });
    await settle();
    expect(imports.get("demo-2")).toBeNull();
    expect(container.textContent).toContain("取り込めませんでした");
  });

  it("消すときは確かめ、つないでいれば切ってから消す", async () => {
    const api = new FakeDemoApi();
    api.finish("ja");
    const s = setup(api);
    s.vault.set({ kind: "connected", info: { baseUrl: DEMO_ORIGINS.ja, via: "proxy", connectionName: "demo", userName: null, connectedAt: 0, savedId: "demo-ja" } });
    const confirm = vi.fn(() => false);
    await act(async () => {
      root.render(createElement(DemoSection, { api, vault: s.vault, connections: s.connections, autoConnect: s.autoConnect, confirm }));
    });
    await settle();
    await act(async () => {
      buttonByText("落としたデータを消す").click();
    });
    expect(confirm).toHaveBeenCalled();
    expect(api.calls).not.toContain("remove:ja");
    confirm.mockReturnValue(true);
    await act(async () => {
      buttonByText("落としたデータを消す").click();
    });
    await settle();
    expect(api.calls).toContain("remove:ja");
    expect(s.vault.view.kind).toBe("disconnected");
  });

  it("--no-demo の橋渡しでは、切っていると知らせる", async () => {
    const api = new FakeDemoApi();
    api.status = async () => ({ kind: "disabled" });
    const s = setup(api);
    await act(async () => {
      root.render(createElement(DemoSection, { api, vault: s.vault, connections: s.connections, autoConnect: s.autoConnect }));
    });
    await settle();
    expect(container.textContent).toContain("--no-demo");
  });
});

describe("デモの状態の読み取り", () => {
  it("形の違う応答は読まない", () => {
    expect(parseDemoStatus({ version: 2, dataHost: "x", languages: { ja: { state: "ready" } } })).toBeNull();
    expect(parseDemoStatus(status())).toMatchObject({ version: 2, languages: { ja: { state: "none" }, en: { state: "none" } } });
  });
});
