// 設定画面を react-dom で描画し、パスワードマネージャー向けのフォームの形と送信の流れを確かめる。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectInput, VaultView } from "../../src/app/keyvault/client";
import { toMaximoError } from "../../src/app/maximo/client";
import type { MaximoConnectionInfo } from "../../src/app/runtime/contracts";
import { CONNECTED_URL, SettingsPage, type SettingsPageProps, type SettingsVault } from "../../src/app/settings/SettingsPage";
import { STORAGE_KEYS } from "../../src/app/settings/logic";
import { fakeSkillsBridge } from "./fakeSkillsBridge";
import { NAVIGATE_EVENT, SETTINGS_TABS, navigate, type SettingsTab } from "../../src/app/ui/routes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "real-api-key-12345";
const INFO: MaximoConnectionInfo = { baseUrl: "https://maximo.test", via: "proxy", connectionName: "MAXADMIN@dev", userName: "MAXADMIN", connectedAt: 1 };

class FakeVault implements SettingsVault {
  view: VaultView = { kind: "disconnected" };
  calls: ConnectInput[] = [];
  result: (input: ConnectInput) => Promise<MaximoConnectionInfo> = async (input) => ({ ...INFO, baseUrl: input.baseUrl, via: input.via, connectionName: input.connectionName });
  private readonly listeners = new Set<() => void>();

  connect = (input: ConnectInput): Promise<MaximoConnectionInfo> => {
    this.calls.push({ ...input });
    return this.result(input).then((info) => {
      this.set({ kind: "connected", info });
      return info;
    });
  };
  getView = (): VaultView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  disconnect = (): void => this.set({ kind: "disconnected" });
  set(v: VaultView): void {
    this.view = v;
    for (const l of Array.from(this.listeners)) l();
  }
}

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
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
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(props: Partial<SettingsPageProps> & { vault: SettingsVault }): Promise<void> {
  const full: SettingsPageProps = {
    storage: memoryStorage(),
    passwordCredential: null,
    replaceUrl: vi.fn(),
    clipboard: null,
    ...fakeSkillsBridge(),
    ...props,
  };
  await act(async () => {
    root.render(createElement(SettingsPage, full));
  });
}


function q<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector);
}

function tabButton(id: SettingsTab): HTMLButtonElement {
  return q<HTMLButtonElement>(`[role="tab"][data-tab="${id}"]`)!;
}

function panel(id: SettingsTab): HTMLElement {
  return q<HTMLElement>(`[role="tabpanel"][data-tab="${id}"]`)!;
}

/** 見えているタブのパネル（ちょうど 1 つ） */
function visiblePanels(): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="tabpanel"]'))
    .filter((p) => !p.hidden)
    .map((p) => p.dataset.tab ?? "");
}

async function selectTab(id: SettingsTab): Promise<void> {
  await act(async () => {
    tabButton(id).click();
  });
  expect(visiblePanels()).toEqual([id]);
}

function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function fillForm(url = "https://maximo.test/", name = "MAXADMIN@dev", key = KEY): Promise<void> {
  await act(async () => {
    setValue(q<HTMLInputElement>('input[type="url"]')!, url);
    setValue(q<HTMLInputElement>('input[name="username"]')!, name);
  });
  q<HTMLInputElement>('input[name="password"]')!.value = key;
}

/** submit を投げて、その直後（await の前）のパスワード欄の値を返す */
async function submit(): Promise<string> {
  const form = q<HTMLFormElement>("form.connect-form")!;
  const password = q<HTMLInputElement>('input[name="password"]')!;
  let afterSubmit = "";
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    afterSubmit = password.value;
  });
  return afterSubmit;
}

describe("設定画面のフォーム", () => {
  it("パスワードマネージャーが保存できる標準のログインフォームになっている", async () => {
    await render({ vault: new FakeVault() });
    const form = q<HTMLFormElement>("form.connect-form");
    expect(form).not.toBeNull();
    // 初めは「接続」のタブが見えている
    expect(visiblePanels()).toEqual(["connection"]);
    expect(panel("connection").contains(form)).toBe(true);
    expect(container.querySelector("iframe")).toBeNull();

    const url = q<HTMLInputElement>('input[name="maximo-url"]')!;
    expect(url.getAttribute("type")).toBe("url");
    const user = q<HTMLInputElement>('input[name="username"]')!;
    expect(user.getAttribute("type")).toBe("text");
    expect(user.getAttribute("autocomplete")).toBe("username");
    const password = q<HTMLInputElement>('input[name="password"]')!;
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    const submitButton = form!.querySelector('button[type="submit"]')!;
    expect(submitButton.textContent).toBe("接続");

    // 接続名 → API キーの順（パスワードマネージャーが対にできる並び）
    const names = Array.from(form!.querySelectorAll("input")).map((i) => i.name);
    expect(names.indexOf("username")).toBeLessThan(names.indexOf("password"));
    const via = form!.querySelector<HTMLSelectElement>('select[name="via"]')!;
    expect(Array.from(via.options).map((o) => o.value)).toEqual(["proxy", "direct"]);
  });

  it("送信するとキーを keyvault に渡し、入力欄をすぐ空にする", async () => {
    const vault = new FakeVault();
    const storage = memoryStorage();
    const replaceUrl = vi.fn();
    const create = vi.fn((id: string, password: string) => ({ id, password: password.length }));
    const store = vi.fn(async () => undefined);
    await render({ vault, storage, replaceUrl, passwordCredential: { create, store } });
    await fillForm();

    expect(await submit()).toBe("");
    expect(vault.calls).toEqual([{ baseUrl: "https://maximo.test", via: "proxy", connectionName: "MAXADMIN@dev", apiKey: KEY }]);
    // whoami に成功してからパスワードマネージャーに保存し、URL を置き換えてフォームを外す
    expect(create).toHaveBeenCalledWith("MAXADMIN@dev", KEY);
    expect(store).toHaveBeenCalledTimes(1);
    expect(replaceUrl).toHaveBeenCalledWith(CONNECTED_URL);
    expect(store.mock.invocationCallOrder[0]).toBeLessThan(replaceUrl.mock.invocationCallOrder[0] ?? 0);
    expect(q("form.connect-form")).toBeNull();
    expect(container.textContent).toContain("接続しました");
    expect(container.textContent).toContain("MAXADMIN@dev");
    // 保存するのは URL と接続方式だけ
    expect(storage.map.get(STORAGE_KEYS.baseUrl)).toBe("https://maximo.test");
    expect(Array.from(storage.map.values()).join("|")).not.toContain(KEY);
  });

  it("失敗したら理由を出し、フォームを残す（キーは残さない）", async () => {
    const vault = new FakeVault();
    vault.result = async () => {
      throw toMaximoError(401, { Error: { reasonCode: "BMXAA0021E", message: "invalid" } });
    };
    const replaceUrl = vi.fn();
    const store = vi.fn(async () => undefined);
    await render({ vault, replaceUrl, passwordCredential: { create: () => ({}), store } });
    await fillForm();

    expect(await submit()).toBe("");
    // Carbon の TextInput は文字数の読み上げ用に空の role="alert" を持つので、知らせ（.notice）に絞って探す
    expect(q('.notice[role="alert"]')?.textContent).toContain("API キーが無効");
    expect(q("form.connect-form")).not.toBeNull();
    expect(replaceUrl).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });

  it("入力の誤りは送信前に止める", async () => {
    const vault = new FakeVault();
    await render({ vault });
    await fillForm("", "MAXADMIN@dev", KEY);
    const password = q<HTMLInputElement>('input[name="password"]')!;
    await submit();
    expect(vault.calls).toEqual([]);
    expect(container.textContent).toContain("Maximo URL を入力してください。");
    // 検査で止めた場合はキーを消さない（入力し直しを強いない）
    expect(password.value).toBe(KEY);
  });

  it("ロック中はその理由とフォームを出す", async () => {
    const vault = new FakeVault();
    vault.view = { kind: "locked", info: INFO, reason: "idle" };
    await render({ vault });
    expect(container.textContent).toContain("無操作が 30 分続いた");
    expect(q("form.connect-form")).not.toBeNull();
    expect(q<HTMLInputElement>('input[name="username"]')?.value).toBe("MAXADMIN@dev");
  });

  it("AI アシスタントの接続は登録の説明だけ（URL もトークンも出さない）", async () => {
    await render({ vault: new FakeVault() });
    await selectTab("assistants");
    const text = panel("assistants").textContent ?? "";
    expect(text).toContain("AI アシスタントの接続");
    expect(text).toContain("AI アシスタント（Claude Desktop・Claude Code・Antigravity・Codex・IBM Bob）に MX Stage を登録します。");
    expect(text).toContain("claude mcp list");
    expect(container.textContent).not.toContain("/mcp");
    expect(container.textContent).not.toContain("個人トークン");
    expect(container.textContent).not.toContain("Cloudflare");
    expect(q('input[name="token-name"]')).toBeNull();
  });

  it("Skill と辞書: 今の接続先の置き場所・辞書・Skill・AI の案、この PC だけの Skill、畳んだ標準の Skill と問題を出す", async () => {
    const vault = new FakeVault();
    vault.view = { kind: "connected", info: { ...INFO, connectionName: "北部", savedId: "c_00000000000000a1" } };
    const bridge = fakeSkillsBridge({
      list: {
        userSkillsDir: "/home/u/.config/mxstage/skills",
        skills: [
          { name: "mxstage-workbench", version: "2.0.0", description: "Index", origin: "default", category: "index" },
          { name: "mxstage-core-load", version: "1.0.0", description: "Load", origin: "default", category: "core" },
          { name: "mxstage-obj-asset", version: "1.0.0", description: "Assets", origin: "default", category: "object" },
          { name: "my-flow", version: "0.1.0", description: "業務の手順", origin: "user", category: "user" },
        ],
        problems: [{ name: "broken", level: "error", message: "SKILL.md がありません。" }],
        connection: {
          label: "北部クリーンセンター（本番）",
          folder: { path: "C:\\OneDrive - 北部CC\\共有", sync: "onedrive-business", reachable: true, writable: true, root: "C:\\OneDrive - 北部CC\\共有\\MX Stage", isDefault: false, rootSync: null },
          skills: [{ name: "kita-tagno", description: "WO の説明から TAGNO を選び直す", version: "1.2.0", place: "connection", versionId: "20261002T051000000Z_m_00000000000000ff", updatedAt: "2026-10-02T05:10:00Z", updatedBy: "田中" }],
          deleted: [],
          problems: [],
          drafts: [{ name: "kita-daily-report", description: "日報と作業指示の突き合わせ", version: "0.1.0", createdAt: "2026-10-16T00:40:00Z", basedOn: null, draftScope: "c_00000000000000a1" }],
        },
      },
      places: [
        { scope: "c_00000000000000a1", label: "北部クリーンセンター（本番）", folder: { path: "C:\\OneDrive - 北部CC\\共有", sync: "onedrive-business", reachable: true, writable: true, isDefault: false }, dictionaries: 3, skills: 1, drafts: 1, members: 3 },
        { scope: "c_00000000000000b2", label: "南部工場（テスト）", folder: { path: null, sync: null, reachable: true, writable: true, root: "C:\\Users\\u\\Documents\\MX Stage\\南部工場（テスト）", isDefault: true, rootSync: null }, dictionaries: 1, skills: 0, drafts: 0, members: null },
      ],
      dictionaries: [{ id: "d_0000000000000001", name: "北部 設備名の呼び方", kind: "alias", description: "", createdAt: "", createdBy: "", count: 23, updatedAt: "2026-10-13T01:00:00Z", updatedBy: "武藤" }],
    });
    const openDictionary = vi.fn();
    await render({ vault, ...bridge, openDictionary });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await selectTab("skills");
    const section = panel("skills").querySelector<HTMLElement>(".skills-and-dictionaries")!;
    const text = section.textContent ?? "";
    expect(section.querySelector("h2")?.textContent).toBe("Skill と辞書");
    // AI の案は一番上に、確かめるボタンと一緒に
    expect(section.querySelector('[data-testid="skill-drafts"]')?.textContent).toContain("kita-daily-report");
    // 置き場所: 共有フォルダの接続先と、既定のフォルダの接続先
    const cards = Array.from(section.querySelectorAll<HTMLElement>(".place-card"));
    expect(cards.map((c) => c.dataset.scope)).toEqual(["c_00000000000000a1", "c_00000000000000b2"]);
    expect(cards[0]!.textContent).toContain("接続中");
    expect(cards[0]!.textContent).toContain("OneDrive（会社）");
    expect(cards[0]!.textContent).toContain("メンバーと共有");
    expect(cards[1]!.textContent).toContain("Documents\\MX Stage\\南部工場（テスト）");
    expect(cards[1]!.textContent).toContain("既定");
    expect(cards[1]!.textContent).toContain("この PC だけ");
    // 今の接続先の辞書と Skill
    expect(text).toContain("北部クリーンセンター（本番） の辞書");
    expect(text).toContain("北部 設備名の呼び方");
    expect(text).toContain("北部クリーンセンター（本番） の Skill");
    expect(text).toContain("kita-tagno");
    // この PC だけの Skill と、畳んだ標準の Skill（日本語の短い説明）
    expect(text.indexOf("my-flow")).toBeGreaterThan(text.indexOf("この PC だけの Skill"));
    const builtIns = section.querySelector<HTMLDetailsElement>("details.sk-builtins")!;
    expect(builtIns.open).toBe(false);
    expect(builtIns.querySelector("summary")?.textContent).toContain("MX Stage の標準の Skill（3）");
    expect(builtIns.textContent).toContain("目次: どの作業でも守る決まり");
    expect(text).toContain("broken");
    // 辞書の［開く］は作業画面で開く
    const openButton = Array.from(section.querySelectorAll("button")).find((b) => b.textContent === "開く" && b.closest(".sk-row")?.textContent?.includes("北部 設備名の呼び方"));
    await act(async () => {
      openButton!.click();
    });
    expect(openDictionary).toHaveBeenCalledWith("北部 設備名の呼び方");
    // 接続のタブには共有フォルダの欄を出さない
    expect(panel("connection").querySelector(".shared-folder")).toBeNull();
  });

  it("AI の案を開いて確かめ、保存すると接続先の置き場所に保存し、案を片づける", async () => {
    const vault = new FakeVault();
    vault.view = { kind: "connected", info: { ...INFO, savedId: "c_00000000000000a1" } };
    const bridge = fakeSkillsBridge({
      list: {
        connection: {
          label: "北部",
          folder: { path: null, sync: null, reachable: true, writable: true, isDefault: true },
          skills: [],
          deleted: [],
          problems: [],
          drafts: [{ name: "kita-daily-report", description: "日報", version: "0.1.0", createdAt: "2026-10-16T00:40:00Z", basedOn: null, draftScope: "c_00000000000000a1" }],
        },
      },
      get: (q) =>
        q.get("place") === "draft"
          ? { ok: true, draft: { name: "kita-daily-report", description: "日報", version: "0.1.0", createdAt: "2026-10-16T00:40:00Z", basedOn: null, draftScope: "c_00000000000000a1", body: "# 手順\n\n1. 日報を読む。" } }
          : { ok: true, skill: { name: "kita-daily-report", description: "日報", version: "0.1.0", place: "connection", versionId: "v1", updatedAt: null, updatedBy: null, body: "# 手順" }, history: [] },
      post: (path) => (path === "/_mxstage/skills/save" ? { body: { ok: true, created: true, warnings: [], skill: { name: "kita-daily-report", description: "日報", version: "0.1.0", place: "connection", versionId: "v1", updatedAt: null, updatedBy: null, body: "# 手順" } } } : { body: { ok: true } }),
    });
    const notify = vi.fn();
    await render({ vault, ...bridge, notify });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await selectTab("skills");
    const review = Array.from(panel("skills").querySelectorAll("button")).find((b) => b.textContent === "確かめる")!;
    await act(async () => {
      review.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const page = panel("skills").querySelector<HTMLElement>(".skill-page")!;
    expect(page.textContent).toContain("AI の案です");
    expect(page.querySelector<HTMLTextAreaElement>("textarea")?.value).toContain("日報を読む");
    const save = Array.from(page.querySelectorAll("button")).find((b) => b.textContent === "保存してメンバーと共有")!;
    await act(async () => {
      save.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const saved = bridge.calls.find((c) => c.path === "/_mxstage/skills/save")!;
    expect(saved.body).toMatchObject({ scope: "c_00000000000000a1", place: "connection", name: "kita-daily-report", baseVersion: null, draft: "c_00000000000000a1" });
    expect(notify).toHaveBeenCalledWith("保存し、メンバーと共有しました。");
  });

  it("接続方式の proxy は橋渡し経由と書く", async () => {
    await render({ vault: new FakeVault() });
    const proxy = Array.from(container.querySelectorAll("option")).find((o) => o.getAttribute("value") === "proxy");
    expect(proxy?.textContent).toContain("橋渡し");
    expect(proxy?.textContent).not.toContain("Cloudflare");
  });
});

describe("設定画面のタブ", () => {
  it("接続・デモ・AI アシスタント・Skill と辞書・更新・言語のタブがあり（ライセンスを渡さなければライセンスのタブは無い）、各パネルはタブの名前を持つ", async () => {
    await render({ vault: new FakeVault() });
    const tablist = q<HTMLElement>('[role="tablist"]')!;
    expect(tablist.getAttribute("aria-label")).toBe("設定の項目");
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs.map((t) => t.dataset.tab)).toEqual(["connection", "demo", "assistants", "skills", "updates", "language"]);
    expect(tabs.map((t) => t.textContent)).toEqual(["接続", "デモ", "AI アシスタント", "Skill と辞書", "更新", "言語"]);
    for (const tab of tabs) {
      const p = container.querySelector<HTMLElement>(`[role="tabpanel"][data-tab="${tab.dataset.tab}"]`)!;
      // パネルの名前はタブ、中にも見出しがある
      expect(p.getAttribute("aria-labelledby")).toBe(tab.id);
      expect(tab.getAttribute("aria-controls")).toBe(p.id);
      expect(p.querySelector("h2")?.textContent).toBeTruthy();
    }
    expect(tabButton("connection").getAttribute("aria-selected")).toBe("true");
  });

  it("URL のハッシュでタブを開く（/settings#skills）", async () => {
    window.history.replaceState(null, "", "/settings#skills");
    await render({ vault: new FakeVault() });
    expect(visiblePanels()).toEqual(["skills"]);
    expect(tabButton("skills").getAttribute("aria-selected")).toBe("true");
    // ほかのパネルも描いたまま（隠すだけ）なので、接続のフォームは残っている
    expect(panel("connection").hidden).toBe(true);
    expect(q("form.connect-form")).not.toBeNull();
  });

  it("知らないハッシュと、無いタブ（ライセンス無しの #license）は「接続」を開く", async () => {
    window.history.replaceState(null, "", "/settings#nope");
    await render({ vault: new FakeVault() });
    expect(visiblePanels()).toEqual(["connection"]);
    await act(async () => root.unmount());
    root = createRoot(container);
    window.history.replaceState(null, "", "/settings#license");
    await render({ vault: new FakeVault() });
    expect(visiblePanels()).toEqual(["connection"]);
  });

  it("タブを切り替えるとハッシュが変わる（履歴は積まない）。入力途中の値は失わない", async () => {
    await render({ vault: new FakeVault() });
    await act(async () => {
      setValue(q<HTMLInputElement>('input[name="maximo-url"]')!, "https://typed.test");
    });
    const before = window.history.length;
    for (const id of ["assistants", "skills", "language", "connection"] as const) {
      await selectTab(id);
      expect(window.location.hash).toBe(`#${id}`);
      expect(window.location.pathname).toBe("/settings");
    }
    expect(window.history.length).toBe(before);
    expect(q<HTMLInputElement>('input[name="maximo-url"]')?.value).toBe("https://typed.test");
  });

  it("ハッシュが外から変わったら（リンク・戻る・手で書き換え）そのタブにする", async () => {
    await render({ vault: new FakeVault() });
    await act(async () => {
      navigate("/settings#language");
    });
    expect(visiblePanels()).toEqual(["language"]);
    await act(async () => {
      window.history.replaceState(null, "", "/settings#skills");
      window.dispatchEvent(new Event("hashchange"));
    });
    expect(visiblePanels()).toEqual(["skills"]);
    await act(async () => {
      window.history.replaceState(null, "", "/settings");
      window.dispatchEvent(new Event(NAVIGATE_EVENT));
    });
    expect(visiblePanels()).toEqual(["connection"]);
  });

  it("タブの名前は 7 つ（URL に出す名前）", () => {
    expect([...SETTINGS_TABS]).toEqual(["connection", "demo", "license", "assistants", "skills", "updates", "language"]);
  });
});

describe("過去の作業のステータス", () => {
  it("接続中は接続先ごとに選べ、既定は完了（COMP）。選ぶとすぐこの PC に覚える", async () => {
    const vault = new FakeVault();
    vault.view = { kind: "connected", info: INFO };
    const storage = memoryStorage();
    await render({ vault, storage });
    const comp = q<HTMLInputElement>("#mx-past-comp")!;
    const close = q<HTMLInputElement>("#mx-past-close")!;
    expect(comp.checked).toBe(true);
    expect(close.checked).toBe(false);
    await act(async () => {
      close.click();
    });
    expect(close.checked).toBe(true);
    expect(JSON.parse(storage.map.get("mxstage.maximo.pastStatus")!)).toEqual({ "https://maximo.test": "CLOSE" });
  });
});
