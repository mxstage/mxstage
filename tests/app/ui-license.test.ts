// 設定の環境（本番／テスト）の選択と「ライセンス」、上部バーの環境の札、get_status の環境とライセンス。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectInput, VaultView } from "../../src/app/keyvault/client";
import { ENVIRONMENTS_STORAGE_KEY, LicenseClient } from "../../src/app/license/client";
import { EnvironmentTag } from "../../src/app/license/EnvironmentTag";
import type { MaximoConnectionInfo } from "../../src/app/runtime/contracts";
import { SettingsPage, type SettingsVault } from "../../src/app/settings/SettingsPage";
import type { SkillList } from "../../src/app/settings/logic";
import { licenseStatusView } from "../../src/app/tools/registry";
import type { SettingsTab } from "../../src/app/ui/routes";
import type { LicenseEntry } from "../../src/shared/license";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 9, 1);
const ACME: LicenseEntry = { state: "valid", licenseId: "lic_acme", org: "ACME Corp", hosts: ["https://maximo.acme.test"], expiresAt: "2027-10-31T00:00:00.000Z" };
const INFO: MaximoConnectionInfo = { baseUrl: "https://maximo.test", via: "proxy", connectionName: "MAXADMIN@dev", userName: "MAXADMIN", connectedAt: 1 };
const NO_SKILLS = async (): Promise<SkillList> => ({ skills: [], problems: [], userSkillsDir: null });

class FakeVault implements SettingsVault {
  view: VaultView = { kind: "disconnected" };
  calls: ConnectInput[] = [];
  private readonly listeners = new Set<() => void>();
  connect = async (input: ConnectInput): Promise<MaximoConnectionInfo> => {
    this.calls.push({ ...input });
    const info = { ...INFO, baseUrl: input.baseUrl };
    this.view = { kind: "connected", info };
    for (const l of Array.from(this.listeners)) l();
    return info;
  };
  getView = (): VaultView => this.view;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  disconnect = (): void => undefined;
}

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

/** 橋渡しの入口の代わり */
function licenseClient(licenses: LicenseEntry[], storage = memoryStorage()) {
  let current = [...licenses];
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://127.0.0.1:8788").pathname;
    if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ ok: true, licenses: current }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posts.push({ path, body });
    if (path === "/_mxstage/license") {
      if (body.key === "MXS1.good") {
        current = [...current, ACME];
        return new Response(JSON.stringify({ ok: true, license: ACME, licenses: current }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, problem: "signature", licenses: current }), { status: 422 });
    }
    if (path === "/_mxstage/license/remove") {
      current = current.filter((e) => e.licenseId !== body.licenseId);
      return new Response(JSON.stringify({ ok: true, removed: true, licenses: current }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  const client = new LicenseClient({ fetch: fetchImpl as unknown as typeof fetch, storage, now: () => NOW });
  return { client, posts, storage };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // 前の試験で選んだタブ（URL のハッシュ）を持ち越さない
  window.history.replaceState(null, "", "/settings");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const q = <T extends Element>(s: string) => container.querySelector<T>(s);

function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function renderSettings(vault: FakeVault, license: LicenseClient) {
  await act(async () => {
    root.render(createElement(SettingsPage, { vault, license, storage: memoryStorage(), passwordCredential: null, replaceUrl: vi.fn(), clipboard: null, loadSkills: NO_SKILLS }));
  });
  await act(async () => {
    await license.refresh();
  });
}

/** 設定のタブを選び、そのパネルだけが見えていることを確かめて返す */
async function selectTab(id: SettingsTab): Promise<HTMLElement> {
  await act(async () => container.querySelector<HTMLButtonElement>(`[role="tab"][data-tab="${id}"]`)!.click());
  const visible = Array.from(container.querySelectorAll<HTMLElement>('[role="tabpanel"]')).filter((p) => !p.hidden);
  expect(visible.map((p) => p.dataset.tab)).toEqual([id]);
  return visible[0]!;
}

async function fillAndSubmit(url: string) {
  await act(async () => {
    setValue(q<HTMLInputElement>('input[name="maximo-url"]')!, url);
    setValue(q<HTMLInputElement>('input[name="username"]')!, "MAXADMIN@dev");
  });
  q<HTMLInputElement>('input[name="password"]')!.value = "secret-key";
  await act(async () => {
    q<HTMLFormElement>("form.connect-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("接続の環境（本番／テスト）", () => {
  it("選ばないと接続しない。選べば接続し、接続先ごとに覚えて次からは初めから選んでおく", async () => {
    const vault = new FakeVault();
    const { client, storage } = licenseClient([]);
    await renderSettings(vault, client);
    // 環境の選択は「接続」のタブ（初めに開くタブ）にある
    expect(q('[role="tabpanel"][data-tab="connection"]')?.hasAttribute("hidden")).toBe(false);
    expect(q('[role="tabpanel"][data-tab="connection"] #mx-env-test')).not.toBeNull();
    expect(q("#mx-env-production")).not.toBeNull();
    await fillAndSubmit("https://dev.test");
    expect(vault.calls).toHaveLength(0);
    expect(container.textContent).toContain("本番かテストかを選んでください");

    await act(async () => q<HTMLInputElement>("#mx-env-test")!.click());
    await fillAndSubmit("https://dev.test");
    expect(vault.calls).toHaveLength(1);
    expect(JSON.parse(storage.map.get(ENVIRONMENTS_STORAGE_KEY)!)).toEqual({ "https://dev.test": "test" });
    expect(client.environmentOf("https://dev.test")).toBe("test");
    // 接続したあとの表示にも環境を出す
    expect(container.textContent).toContain("環境");
    expect(container.textContent).toContain("テスト");
  });

  it("ライセンスキーに書かれた接続先はいつも本番で、選ばずに接続できる", async () => {
    const vault = new FakeVault();
    const { client } = licenseClient([ACME]);
    await renderSettings(vault, client);
    await act(async () => {
      setValue(q<HTMLInputElement>('input[name="maximo-url"]')!, "https://maximo.acme.test");
    });
    expect(q("#mx-env-test")).toBeNull();
    expect(container.textContent).toContain("本番（ACME Corp のライセンス）");
    await fillAndSubmit("https://maximo.acme.test");
    expect(vault.calls).toHaveLength(1);
  });
});

describe("設定の「ライセンス」", () => {
  it("キーを一覧に出し（キーそのものは出さない）、貼って追加・外す。受け付けなかった理由も出す", async () => {
    const { client, posts } = licenseClient([]);
    await renderSettings(new FakeVault(), client);
    const panel = await selectTab("license");
    expect(window.location.hash).toBe("#license");
    expect(panel.querySelector("h2")?.textContent).toBe("ライセンス");
    expect(panel.textContent).toContain("この PC にライセンスキーはありません");
    expect(panel.querySelector('a[href="https://mxstage.tsunagi.app/ja/license"]')).not.toBeNull();

    const area = panel.querySelector<HTMLTextAreaElement>("#license-key")!;
    await act(async () => setValue(area, "MXS1.bad"));
    const add = Array.from(panel.querySelectorAll("button")).find((b) => b.textContent === "キーを追加")!;
    await act(async () => add.click());
    expect(container.textContent).toContain("キーが書き換えられているか");

    await act(async () => setValue(area, "MXS1.good"));
    await act(async () => add.click());
    expect(panel.textContent).toContain("ACME Corp のライセンスを追加しました");
    expect(panel.textContent).toContain("https://maximo.acme.test");
    expect(panel.textContent).toContain("2027-10-31");
    expect(posts.map((p) => p.path)).toEqual(["/_mxstage/license", "/_mxstage/license"]);

    window.confirm = vi.fn(() => true);
    const remove = Array.from(panel.querySelectorAll("button")).find((b) => b.textContent === "外す")!;
    await act(async () => remove.click());
    expect(posts.at(-1)).toEqual({ path: "/_mxstage/license/remove", body: { licenseId: "lic_acme" } });
    expect(panel.textContent).toContain("キーを外しました");
  });

  it("開発用のキー（橋渡しが読んだもの）は外すボタンを出さない", async () => {
    const { client } = licenseClient([{ ...ACME, test: true, bundled: true }]);
    await renderSettings(new FakeVault(), client);
    const panel = await selectTab("license");
    expect(panel.textContent).toContain("開発用のキー");
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "外す")).toBe(false);
  });

  it("/settings#license で開くとライセンスのタブが見えている（タブの並びは 接続・デモ・ライセンス・AI アシスタント・Skill・更新・言語）", async () => {
    window.history.replaceState(null, "", "/settings#license");
    const { client } = licenseClient([]);
    await renderSettings(new FakeVault(), client);
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(["接続", "デモ", "ライセンス", "AI アシスタント", "Skill", "更新", "言語"]);
    expect(q('[role="tab"][data-tab="license"]')?.getAttribute("aria-selected")).toBe("true");
    const visible = Array.from(container.querySelectorAll<HTMLElement>('[role="tabpanel"]')).filter((p) => !p.hidden);
    expect(visible.map((p) => p.dataset.tab)).toEqual(["license"]);
    expect(visible[0]?.querySelector("#license-key")).not.toBeNull();
  });
});

describe("上部バーの環境の札と get_status", () => {
  async function tag(client: LicenseClient, baseUrl: string) {
    await act(async () => {
      await client.refresh();
      root.render(createElement(EnvironmentTag, { license: client, baseUrl, now: () => NOW }));
    });
    return container.textContent ?? "";
  }

  it("テスト / 本番（ライセンスあり）/ 本番（読むだけ）/ 未設定 を出し分け、期限が近ければ知らせる", async () => {
    const { client } = licenseClient([ACME]);
    const href = () => q("a.env-tag-link")?.getAttribute("href");
    expect(await tag(client, "https://maximo.acme.test/maximo")).toBe("本番 · ACME Corp");
    // 札は設定のライセンスのタブを開く。環境が未設定なら、環境を選ぶ接続のタブを開く
    expect(href()).toBe("/settings#license");
    expect(await tag(client, "https://other.test/maximo")).toBe("環境が未設定");
    expect(href()).toBe("/settings#connection");
    client.declare("https://other.test/maximo", "production");
    expect(await tag(client, "https://other.test/maximo")).toBe("本番 · 読むだけ（ライセンス無し）");
    expect(href()).toBe("/settings#license");
    client.declare("https://other.test/maximo", "test");
    expect(await tag(client, "https://other.test/maximo")).toBe("テスト");
    const soon = licenseClient([{ ...ACME, expiresAt: "2026-10-11T00:00:00.000Z" }]).client;
    expect(await tag(soon, "https://maximo.acme.test")).toContain("ライセンスの期限まで 10 日");
  });

  it("get_status には環境と、反映できるか・できなければ理由と買い方を載せる（組織名・キーは載せない）", async () => {
    const { client } = licenseClient([ACME]);
    await client.refresh();
    expect(licenseStatusView(client, "https://maximo.acme.test/maximo")).toEqual({
      environment: "production",
      license: { status: "licensed", productionWrites: true, expiresAt: ACME.expiresAt },
    });
    client.declare("https://dev.test", "test");
    expect(licenseStatusView(client, "https://dev.test")).toEqual({ environment: "test", license: { status: "not_required", productionWrites: true } });
    const unset = licenseStatusView(client, "https://unknown.test");
    expect(unset).toMatchObject({ environment: "not_set", license: { status: "environment_not_set", productionWrites: false } });
    client.declare("https://prod2.test", "production");
    const view = licenseStatusView(client, "https://prod2.test") as { license: { note: string } };
    expect(view).toMatchObject({ environment: "production", license: { status: "not_licensed", productionWrites: false } });
    expect(view.license.note).toMatch(/https:\/\/mxstage\.tsunagi\.app\/(ja\/)?license/);
    expect(JSON.stringify(licenseStatusView(client, "https://maximo.acme.test"))).not.toContain("ACME");
  });
});
