// 設定画面を react-dom で描画し、パスワードマネージャー向けのフォームの形と送信の流れを確かめる。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectInput, VaultView } from "../../src/app/keyvault/client";
import { toMaximoError } from "../../src/app/maximo/client";
import type { MaximoConnectionInfo } from "../../src/app/runtime/contracts";
import { CONNECTED_URL, SettingsPage, type SettingsPageProps, type SettingsVault } from "../../src/app/settings/SettingsPage";
import { STORAGE_KEYS, type SkillList } from "../../src/app/settings/logic";
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
    loadSkills: NO_SKILLS,
    ...props,
  };
  await act(async () => {
    root.render(createElement(SettingsPage, full));
  });
}

/** 試験では橋渡しの一覧を取りに行かない（同じ関数を使い回して、読み込みを繰り返させない） */
const NO_SKILLS = async (): Promise<SkillList> => ({ skills: [], problems: [], userSkillsDir: null });

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

  it("Skill はアプリ既定と利用者の Skill に分けて出し、置き場所と問題を示す（一覧は 1 回だけ読む）", async () => {
    const loadSkills = vi.fn(
      async (): Promise<SkillList> => ({
        userSkillsDir: "/home/u/.config/mxstage/skills",
        skills: [
          { name: "mxstage-workbench", version: "2.0.0", description: "目次", origin: "default", category: "index" },
          { name: "mxstage-core-load", version: "1.0.0", description: "読み込み", origin: "default", category: "core" },
          { name: "mxstage-obj-asset", version: "1.0.0", description: "資産", origin: "default", category: "object" },
          { name: "my-flow", version: "0.1.0", description: "業務の手順", origin: "user", category: "user" },
        ],
        problems: [{ name: "broken", level: "error", message: "SKILL.md がありません。" }],
      }),
    );
    await render({ vault: new FakeVault(), loadSkills });
    await act(async () => {
      await Promise.resolve();
    });
    await selectTab("skills");
    const section = panel("skills").querySelector<HTMLElement>(".skills");
    const text = section?.textContent ?? "";
    expect(text).toContain("アプリ既定");
    expect(text).toContain("利用者の Skill");
    // 既定の見出しの後に既定の Skill、利用者の見出しの後に利用者の Skill が並ぶ
    expect(text.indexOf("mxstage-workbench")).toBeGreaterThan(text.indexOf("アプリ既定"));
    expect(text.indexOf("my-flow")).toBeGreaterThan(text.indexOf("利用者の Skill"));
    // 既定の Skill は層ごとに分ける（目次・基本動作・標準オブジェクト）
    expect(text.indexOf("mxstage-workbench")).toBeGreaterThan(text.indexOf("目次（"));
    expect(text.indexOf("mxstage-core-load")).toBeGreaterThan(text.indexOf("基本動作"));
    expect(text.indexOf("mxstage-obj-asset")).toBeGreaterThan(text.indexOf("Maximo の標準オブジェクト"));
    expect(text.indexOf("基本動作")).toBeGreaterThan(text.indexOf("mxstage-workbench"));
    expect(text).toContain("/home/u/.config/mxstage/skills");
    expect(text).toContain("broken");
    expect(text).toContain("読み込めません");
    // ZIP のダウンロードは無い
    expect(section?.querySelector("a[download]")).toBeNull();
    expect(loadSkills).toHaveBeenCalledTimes(1);
  });

  it("利用者の Skill が無ければ、無いことを出す", async () => {
    await render({ vault: new FakeVault() });
    await act(async () => {
      await Promise.resolve();
    });
    await selectTab("skills");
    expect(panel("skills").querySelector(".skills")?.textContent).toContain("まだありません");
  });

  it("接続方式の proxy は橋渡し経由と書く", async () => {
    await render({ vault: new FakeVault() });
    const proxy = Array.from(container.querySelectorAll("option")).find((o) => o.getAttribute("value") === "proxy");
    expect(proxy?.textContent).toContain("橋渡し");
    expect(proxy?.textContent).not.toContain("Cloudflare");
  });
});

describe("設定画面のタブ", () => {
  it("接続・デモ・AI アシスタント・Skill・更新・言語のタブがあり（ライセンスを渡さなければライセンスのタブは無い）、各パネルはタブの名前を持つ", async () => {
    await render({ vault: new FakeVault() });
    const tablist = q<HTMLElement>('[role="tablist"]')!;
    expect(tablist.getAttribute("aria-label")).toBe("設定の項目");
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs.map((t) => t.dataset.tab)).toEqual(["connection", "demo", "assistants", "skills", "updates", "language"]);
    expect(tabs.map((t) => t.textContent)).toEqual(["接続", "デモ", "AI アシスタント", "Skill", "更新", "言語"]);
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
