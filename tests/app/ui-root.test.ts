// 画面のルート（/app と /settings の切り替え、中継を始める条件、作業終了）の試験。
// 画面はこのパソコンの橋渡しが配る。ログインも作業キーも無いので、画面は「ログインの確認」をしない。

import { act, createElement } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectStructureCatalog } from "../../src/app/catalog/catalog";
import type { Runtime } from "../../src/app/boot/runtime";
import type { AppServices } from "../../src/app/boot/types";
import { AutoConnector } from "../../src/app/connections/auto";
import { SavedConnectionsClient } from "../../src/app/connections/client";
import type { KeyVault, VaultView } from "../../src/app/keyvault/client";
import { LicenseClient } from "../../src/app/license/client";
import { REOPEN_HINT_AFTER } from "../../src/app/pages/status";
import type { RelayStatus } from "../../src/app/relay";
import type { CommitController, CommitPanelState } from "../../src/app/runtime/contracts";
import { Workspace } from "../../src/app/store";
import { Root } from "../../src/app/ui/Root";
import { navigate } from "../../src/app/ui/routes";
import { getLocale } from "../../src/shared/i18n";
import { ToastStore } from "../../src/app/ui/toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RELAY_OPEN: RelayStatus = {
  state: "open",
  tabId: "tab-1",
  role: "primary",
  primaryTabId: "tab-1",
  heartbeatMs: 20_000,
  attempt: 0,
  nextRetryMs: null,
  lastCloseCode: null,
};

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

function fakeCommits(): CommitController {
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

interface Counters {
  created: number;
  started: number;
  disposed: number;
}

/** useSyncExternalStore の決まりどおり、同じ状態なら同じオブジェクトを返す（本物の KeyVault も this.view を返す） */
const DISCONNECTED: VaultView = { kind: "disconnected" };

function makeServices(counters: Counters, relay: RelayStatus = RELAY_OPEN): AppServices {
  const vault = {
    getView: (): VaultView => DISCONNECTED,
    subscribe: () => () => undefined,
    connect: async () => {
      throw new Error("この試験では接続しません");
    },
    disconnect: () => undefined,
    noteActivity: () => undefined,
  };
  const connections = new SavedConnectionsClient({ fetch: async () => new Response("{}", { status: 503 }) });
  return {
    vault: vault as unknown as KeyVault,
    toasts: new ToastStore(),
    catalog: new ObjectStructureCatalog(),
    // 橋渡しにつながない（ライセンスは読めないまま）
    license: new LicenseClient({ fetch: async () => new Response("{}", { status: 503 }) }),
    connections,
    // 自動の接続は始めない（この試験では接続しない）
    autoConnect: new AutoConnector({ saved: connections, vault: vault as unknown as KeyVault }),
    createRuntime: (): Runtime => {
      counters.created++;
      const workspace = new Workspace(`作業${counters.created}`);
      return {
        workspace,
        jobs: workspace.jobs,
        commits: fakeCommits(),
        tools: [],
        tabId: "tab-1",
        relayStatus: () => relay,
        subscribeRelay: () => () => undefined,
        start: () => {
          counters.started++;
        },
        dispose: () => {
          counters.disposed++;
        },
      };
    },
  };
}

let container: HTMLDivElement;
let root: ReactRoot;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

async function render(path: string, services: AppServices): Promise<void> {
  window.history.replaceState(null, "", path);
  await act(async () => {
    root.render(createElement(Root, { services }));
  });
}

function counters(): Counters {
  return { created: 0, started: 0, disposed: 0 };
}

/** 上部バーの接続の ○ の説明（作業名・中継・Maximo の状態は画面に文字で出さず、ここに入れる） */
function connectionTitle(): string {
  return container.querySelector(".conn-dot")?.getAttribute("title") ?? "";
}

/** 文言の中に「ログイン」が現れないこと（ログインの概念を画面から外したため） */
function expectNoLoginWording(): void {
  expect(container.textContent ?? "").not.toContain("ログイン");
  expect(container.querySelector('a[href^="/auth/"]')).toBeNull();
}

describe("画面のルート", () => {
  it("ログインの確認をせずに作業画面を出し、その場で中継を始める", async () => {
    const c = counters();
    const services = makeServices(c);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await render("/app", services);

    // 作業画面がそのまま出る（確認中の表示もログイン画面も挟まない）
    expect(container.querySelector("div.app")).not.toBeNull();
    expect(connectionTitle()).toContain("作業1");
    expect(c.created).toBe(1);
    expect(c.started).toBe(1);
    // 起動時にログイン状態を問い合わせない（/api/me を呼ばない）
    expect(fetchSpy).not.toHaveBeenCalled();
    expectNoLoginWording();
  });

  it("設定画面もログインの確認なしに出る（中継は始めない＝primary を奪わない）", async () => {
    const c = counters();
    await render("/settings", makeServices(c));
    expect(container.querySelector("form.connect-form")).not.toBeNull();
    expect(c.created).toBe(0);
    expectNoLoginWording();

    // 作業画面に切り替えたところで中継を始める（全画面遷移しない＝同じドキュメントのまま）
    await act(async () => {
      navigate("/app");
    });
    expect(window.location.pathname).toBe("/app");
    expect(c.created).toBe(1);
    expect(c.started).toBe(1);
    expect(connectionTitle()).toContain("作業1");
    expect(container.querySelector("form.connect-form")).toBeNull();

    // 設定に戻っても作業（Workspace と中継）は作り直さない
    await act(async () => {
      navigate("/settings");
    });
    expect(c.created).toBe(1);
    expect(c.disposed).toBe(0);
  });

  it("中継が戻らないときは、橋渡しの起動を確かめる案内を出す（ログインは前提にしない）", async () => {
    const c = counters();
    const stuck: RelayStatus = { ...RELAY_OPEN, state: "reconnecting", role: null, attempt: REOPEN_HINT_AFTER, nextRetryMs: 4_000 };
    await render("/app", makeServices(c, stuck));
    expect(container.textContent).toContain("橋渡しの起動を確かめてください");
    // 「再ログイン」の導線は出さない
    expectNoLoginWording();
    expect(container.querySelector('a[href^="/w/"]')).toBeNull();
  });

  it("一瞬の切断では開き直しの案内を出さない", async () => {
    const c = counters();
    const blip: RelayStatus = { ...RELAY_OPEN, state: "reconnecting", role: null, attempt: REOPEN_HINT_AFTER - 1, nextRetryMs: 4_000 };
    await render("/app", makeServices(c, blip));
    expect(connectionTitle()).toContain("中継: 再接続中");
    expect(container.textContent).not.toContain("橋渡しの起動を確かめてください");
  });

  it("/ と未知のパスは作業画面に置き換える", async () => {
    const c = counters();
    await render("/", makeServices(c));
    expect(window.location.pathname).toBe("/app");
    expect(c.started).toBe(1);
  });

  it("画面を閉じると中継も終える", async () => {
    const c = counters();
    await render("/app", makeServices(c));
    expect(c.started).toBe(1);
    await act(async () => {
      root.unmount();
    });
    expect(c.disposed).toBe(1);
    // afterEach の unmount は二重に呼んでも安全
  });

  it("作業終了は作業データを捨てて新しい作業を始める（作業キーはそのまま）", async () => {
    const c = counters();
    // happy-dom には window.confirm が無いので、確認ダイアログの代わりを置く
    const w = window as unknown as { confirm?: (message?: string) => boolean };
    const original = w.confirm;
    w.confirm = () => true;
    try {
      await runEndWork(c);
    } finally {
      if (original) w.confirm = original;
      else delete w.confirm;
    }
  });

  async function runEndWork(c: Counters): Promise<void> {
    await render("/app", makeServices(c));
    expect(connectionTitle()).toContain("作業1");

    const end = container.querySelector<HTMLButtonElement>('button[aria-label="作業終了"]') ?? undefined;
    expect(end).not.toBeUndefined();
    await act(async () => {
      end!.click();
    });

    // 前の作業は捨て、新しい作業で中継をつなぎ直す
    expect(c.disposed).toBe(1);
    expect(c.created).toBe(2);
    expect(c.started).toBe(2);
    expect(connectionTitle()).toContain("作業2");
    // 作業キーは変えない（開き直しや再取得の導線は出さない）
    expectNoLoginWording();
  }
});

describe("設定画面のタブと URL", () => {
  function visiblePanels(): string[] {
    return Array.from(container.querySelectorAll<HTMLElement>('[role="tabpanel"]'))
      .filter((p) => !p.hidden)
      .map((p) => p.dataset.tab ?? "");
  }

  afterEach(() => {
    window.localStorage.removeItem("mxstage.locale");
  });

  it("上部バーの「設定で接続」は接続のタブを、/settings#license はライセンスのタブを開く", async () => {
    await render("/app", makeServices(counters()));
    const link = container.querySelector<HTMLAnchorElement>("a.topbar-link")!;
    expect(link.getAttribute("href")).toBe("/settings#connection");
    await act(async () => {
      link.click();
    });
    expect(window.location.pathname).toBe("/settings");
    expect(window.location.hash).toBe("#connection");
    expect(visiblePanels()).toEqual(["connection"]);

    // 設定画面のままハッシュだけ変わっても（リンク）、そのタブにする
    await act(async () => {
      navigate("/settings#license");
    });
    expect(visiblePanels()).toEqual(["license"]);
  });

  it("言語を切り替えて画面を作り直しても、言語のタブのまま", async () => {
    await render("/settings", makeServices(counters()));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="tab"][data-tab="language"]')!.click();
    });
    expect(window.location.hash).toBe("#language");
    await act(async () => {
      container.querySelector<HTMLInputElement>("#ui-language-en")!.click();
    });
    expect(getLocale()).toBe("en");
    expect(visiblePanels()).toEqual(["language"]);
    expect(container.querySelector('[role="tab"][data-tab="language"]')?.textContent).toBe("Language");
    expect(container.querySelector<HTMLInputElement>("#ui-language-en")?.checked).toBe(true);
  });
});
