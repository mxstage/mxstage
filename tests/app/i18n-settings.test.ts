// 設定画面・API キーの保管・カタログの文言の英語と、設定の「言語」の切り替え。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectInput, VaultView } from "../../src/app/keyvault/client";
import { VaultCore } from "../../src/app/keyvault/core";
import { toMaximoError } from "../../src/app/maximo/client";
import type { MaximoConnectionInfo } from "../../src/app/runtime/contracts";
import { SettingsPage, type SettingsVault } from "../../src/app/settings/SettingsPage";
import { connectErrorMessage, localClientStatus, validateSettingsForm, viaOptionLabel, type SkillList } from "../../src/app/settings/logic";
import {
  catalogMessages,
  importErrorMessages,
  localizeVaultMessage,
  settingsMessages,
  vaultClientMessages,
  vaultMessages,
} from "../../src/app/settings/messages";
import { VaultRequestError } from "../../src/app/keyvault/client";
import type { SettingsTab } from "../../src/app/ui/routes";
import { LOCALE_STORAGE_KEY, getLocale, setLocale } from "../../src/shared/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const INFO: MaximoConnectionInfo = { baseUrl: "https://maximo.test", via: "proxy", connectionName: "MAXADMIN@dev", userName: "MAXADMIN", connectedAt: 1 };
const NO_SKILLS = async (): Promise<SkillList> => ({ skills: [], problems: [], userSkillsDir: null });

class FakeVault implements SettingsVault {
  view: VaultView = { kind: "disconnected" };
  connect = async (input: ConnectInput): Promise<MaximoConnectionInfo> => ({ ...INFO, baseUrl: input.baseUrl });
  getView = (): VaultView => this.view;
  subscribe = (): (() => void) => () => undefined;
  disconnect = (): void => undefined;
}

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

/** 文言の木をたどり、関数の文言は見本の引数で呼んで、すべての文を集める */
function collect(tree: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof tree === "string") {
    out.push({ path, text: tree });
  } else if (typeof tree === "function") {
    const fn = tree as (...args: unknown[]) => unknown;
    for (const args of [["sample"], [3, "BMXAA0021E"], [1, null], ["sample", true], ["sample", false], [null]]) {
      const text = fn(...args);
      if (typeof text === "string") out.push({ path: `${path}(${args.join(",")})`, text });
    }
  } else if (typeof tree === "object" && tree !== null) {
    for (const [k, v] of Object.entries(tree)) collect(v, path === "" ? k : `${path}.${k}`, out);
  }
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

/** 設定のタブを選び、そのパネルだけが見えていることを確かめて返す */
async function selectTab(id: SettingsTab): Promise<HTMLElement> {
  await act(async () => container.querySelector<HTMLButtonElement>(`[role="tab"][data-tab="${id}"]`)!.click());
  const visible = Array.from(container.querySelectorAll<HTMLElement>('[role="tabpanel"]')).filter((p) => !p.hidden);
  expect(visible.map((p) => p.dataset.tab)).toEqual([id]);
  return visible[0]!;
}

async function render(storage = memoryStorage(), vault: SettingsVault = new FakeVault()) {
  await act(async () => {
    root.render(createElement(SettingsPage, { vault, storage, passwordCredential: null, replaceUrl: () => undefined, clipboard: null, loadSkills: NO_SKILLS }));
  });
  return storage;
}

describe("設定画面の英語", () => {
  it("英語の文言に日本語の文字が無い（言語の名前「日本語」だけは例外）", () => {
    setLocale("en");
    const texts: { path: string; text: string }[] = [];
    for (const [name, m] of Object.entries({ settingsMessages, vaultMessages, vaultClientMessages, catalogMessages, importErrorMessages })) collect(m(), name, texts);
    expect(texts.length).toBeGreaterThan(100);
    const japanese = texts.filter((t) => JAPANESE.test(t.text.replaceAll("日本語", "")));
    expect(japanese).toEqual([]);
  });

  it("英語で描画する（見出し・ラベル・ボタン・言語の選択）", async () => {
    setLocale("en");
    await render();
    const text = container.textContent ?? "";
    expect(container.querySelector("h1")?.textContent).toBe("Settings");
    expect(text).toContain("Back to work screen");
    // タブ（ライセンスを渡していないのでライセンスのタブは無い）
    expect(container.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Settings sections");
    expect(Array.from(container.querySelectorAll('[role="tab"]')).map((t) => t.textContent)).toEqual(["Connection", "AI assistants", "Skills", "Language"]);
    const connection = container.querySelector<HTMLElement>('[role="tabpanel"][data-tab="connection"]')!;
    expect(connection.hidden).toBe(false);
    expect(connection.textContent).toContain("Maximo connection");
    expect(connection.textContent).toContain("Connection name");
    expect(connection.textContent).toContain("API key");
    expect(connection.querySelector('form.connect-form button[type="submit"]')?.textContent).toBe("Connect");
    expect((await selectTab("skills")).textContent).toContain("Skills (work procedures)");
    expect((await selectTab("assistants")).textContent).toContain("LLM client connection");
    expect((await selectTab("language")).textContent).toContain("Used for the work screen. The AI replies in the language you write in.");
    expect(JAPANESE.test(text.replaceAll("日本語", ""))).toBe(false);
    // 言語の名前は、どちらの言語でもその言語自身の書き方
    const labels = Array.from(container.querySelectorAll('input[name="ui-language"]')).map((i) => container.querySelector(`label[for="${i.id}"]`)?.textContent);
    expect(labels).toEqual(["English", "日本語"]);
  });

  it("設定の純ロジックも英語で返す", () => {
    setLocale("en");
    expect(validateSettingsForm({ baseUrl: "", via: "proxy", connectionName: "", apiKey: "" })).toEqual({
      baseUrl: "Enter the Maximo URL.",
      connectionName: "Enter a connection name (for example, MAXADMIN@mas-dev).",
      apiKey: "Enter the API key.",
    });
    expect(viaOptionLabel("direct")).toBe("Direct (from the browser; Maximo needs CORS settings)");
    expect(connectErrorMessage(toMaximoError(401, null), "proxy")).toBe("The API key is not valid, or this connection does not have permission.");
    expect(localClientStatus().summary).toBe("Registered with Claude Code.");
  });

  it("Worker の文言（いつも英語）を、画面では今の言語に直す", () => {
    // Worker の中では言語を切り替えないので英語で作られる
    setLocale("en");
    const core = new VaultCore({ origin: "https://app.test" });
    let message = "";
    try {
      core.unlock({ apiKey: "", via: "proxy", baseUrl: "https://maximo.test" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("The API key is empty or contains characters that cannot be used.");
    expect(connectErrorMessage(new VaultRequestError("bad_request", message), "proxy")).toBe(message);
    setLocale("ja");
    expect(connectErrorMessage(new VaultRequestError("bad_request", message), "proxy")).toBe("API キーが空か、使えない文字を含んでいます。");
    // 引数のある文言（ヘッダ名）も直す。知らない文言はそのまま
    expect(localizeVaultMessage("The header cookie is not allowed.")).toBe("ヘッダ cookie は付けられません。");
    expect(localizeVaultMessage("something else")).toBe("something else");
  });
});

describe("設定の「言語」", () => {
  it("選ぶと言語を切り替え、mxstage.locale に覚える", async () => {
    const storage = await render();
    expect(getLocale()).toBe("ja");
    const panel = await selectTab("language");
    expect(panel.querySelector("h2")?.textContent).toBe("言語");
    const ja = container.querySelector<HTMLInputElement>("#ui-language-ja")!;
    const en = container.querySelector<HTMLInputElement>("#ui-language-en")!;
    expect(ja.checked).toBe(true);
    await act(async () => {
      en.click();
    });
    expect(getLocale()).toBe("en");
    expect(storage.map.get(LOCALE_STORAGE_KEY)).toBe("en");
    expect(en.checked).toBe(true);
    await act(async () => {
      ja.click();
    });
    expect(getLocale()).toBe("ja");
    expect(storage.map.get(LOCALE_STORAGE_KEY)).toBe("ja");
  });
});
