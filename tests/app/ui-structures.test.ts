// オブジェクト構造の画面 /structures を描画して確かめる。
// - 接続すると作業画面が機械的に読み込んだ構造が一覧に出て、読み込みの進み具合が分かる
// - 業務の言葉で探せる（LLM の find_object_structures と同じ決め方）
// - その構造を使って読み込んだシートが分かる（同じ構造を複数のシートで使ってよい）
// - 未接続でも保存済みの定義は見られる。「すべて取り直す」は確認してから行う

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObjectStructureCatalog } from "../../src/app/catalog/catalog";
import { createMemoryCatalogStorage } from "../../src/app/catalog/storage";
import type { VaultView } from "../../src/app/keyvault/client";
import { MaximoClient, type FetchLike } from "../../src/app/maximo/client";
import type { MaximoConnection } from "../../src/app/runtime/contracts";
import { STORAGE_KEYS, type StorageLike } from "../../src/app/settings/logic";
import { Workspace } from "../../src/app/store";
import { filterColumns, groupByUseWith, loadErrorMessage, normalizeOsName } from "../../src/app/structures/logic";
import { StructuresPage, type StructuresPageProps, type StructuresVault } from "../../src/app/structures/StructuresPage";
import { resolveRoute } from "../../src/app/ui/routes";
import { ToastStore } from "../../src/app/ui/toast";
import type { SheetMeta } from "../../src/shared/sheet";
import { createFakeMaximo, sampleSeed, withDefinitions, type FakeMaximo } from "../fakes/fake-maximo";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

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
});

function seed() {
  const s = sampleSeed();
  // 業務の言葉で探せることを確かめるため、許可申請の子とタグ番号に日本語のラベルを付ける
  s.objectStructures.MXAPIWO!.children!.ext_wopermit!.attrs.ext_permitdate = { type: "date", title: "申請完了日" };
  s.objectStructures.MXASSET!.attrs.ext_equiptag = { type: "string", maxLength: 30, title: "タグ番号" };
  return s;
}

class FakeVault implements StructuresVault {
  view: VaultView;
  conn: MaximoConnection | null;
  private readonly listeners = new Set<() => void>();
  constructor(fake: FakeMaximo, connected: boolean, fetchWrap?: (f: FetchLike) => FetchLike) {
    const client = new MaximoClient({ baseUrl: fake.baseUrl, apiKey: () => fake.apiKey, via: "direct", fetchImpl: fetchWrap ? fetchWrap(fake.fetch) : fake.fetch, sleep: async () => {} });
    const info = { baseUrl: fake.baseUrl, via: "direct" as const, connectionName: "MAXADMIN@test", userName: "MAXADMIN", connectedAt: 1 };
    this.conn = connected ? { info, client } : null;
    this.view = connected ? { kind: "connected", info } : { kind: "disconnected" };
  }
  getView = () => this.view;
  current = () => this.conn;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
}

function memoryStorage(init: Record<string, string> = {}): StorageLike {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

async function render(props: StructuresPageProps): Promise<void> {
  await act(async () => {
    root.render(createElement(StructuresPage, props));
  });
  await flush();
}

/** 保存先の読み出しや Maximo の偽物の応答を待つ */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const q = <T extends Element>(selector: string) => container.querySelector<T>(selector);
const qa = <T extends Element>(selector: string) => Array.from(container.querySelectorAll<T>(selector));
const text = () => container.textContent ?? "";

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error("クリックする要素がありません");
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

const attrNames = () => qa<HTMLTableCellElement>(".attr-table tbody td:first-child").map((td) => td.textContent);
const listedNames = () => qa<HTMLElement>(".os-item .os-item-head .mono").map((e) => e.textContent);
const osCount = Object.keys(sampleSeed().objectStructures).length;

/** 構造を使って読み込んだシート（行は無くてよい） */
function addSheet(workspace: Workspace, name: string, os: string, baseUrl: string): void {
  const meta: SheetMeta = {
    name,
    source: { kind: "maximo", os, select: ["WONUM"], where: [], baseUrl, structureLoadedAt: 1 },
    columns: [{ name: "WONUM", type: "string" }],
    keyColumns: ["WONUM"],
    childIdAttrs: {},
  };
  workspace.createSheet(meta, []);
}

describe("オブジェクト構造の画面", () => {
  it("/structures は構造の画面に解決される", () => {
    expect(resolveRoute("/structures")).toEqual({ kind: "structures" });
    expect(resolveRoute("/structures/")).toEqual({ kind: "structures" });
  });

  it("接続して機械的に読み込むあいだ進み具合を出し、読み終えたら一覧とキー列・子オブジェクト・属性が見られる", async () => {
    const fake = createFakeMaximo(seed());
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // 定義の読み込みを止めておき、読み込み中の表示を確かめる
    const vault = new FakeVault(fake, true, (f) => async (url, init) => {
      if (url.includes("/jsonschemas/")) await gate;
      return f(url, init);
    });
    const catalog = new ObjectStructureCatalog();
    await render({ catalog, vault, toasts: new ToastStore(), storage: memoryStorage() });

    let finished = false;
    void catalog.syncAll(vault.conn!.client, fake.baseUrl).then(() => {
      finished = true;
    });
    await flush();
    expect(text()).toContain(`Maximo から読み込んでいます（0 / ${osCount}）`);
    expect(q("progress")).not.toBeNull();

    await act(async () => {
      release();
    });
    for (let i = 0; i < 50 && !finished; i++) await flush();
    await flush();
    expect(text()).toContain(`保存済み ${osCount} 件`);
    expect(listedNames()).toEqual(expect.arrayContaining(["MXAPIWO", "MXASSET"]));

    await click(qa<HTMLButtonElement>(".os-item").find((b) => b.textContent?.includes("MXAPIWO")) ?? null);
    expect(q(".structure-detail h2")?.textContent).toBe("MXAPIWO");
    expect(text()).toContain("SITEID, WONUM");
    const childRows = qa<HTMLTableRowElement>(".structure-detail table:not(.attr-table) tbody tr").map((tr) => Array.from(tr.cells).map((c) => c.textContent));
    expect(childRows).toContainEqual(["EXT_WOPERMIT", "EXT_WOPERMITID", "5"]);
    expect(attrNames()).toContain("EXT_WOPERMIT.EXT_PERMITDATE");
    // 範囲を「親だけ」にすると子の属性は出ない
    await act(async () => {
      setValue(q<HTMLSelectElement>('select[aria-label="範囲"]')!, "parent");
    });
    expect(attrNames()).not.toContain("EXT_WOPERMIT.EXT_PERMITDATE");
  });

  it("業務の言葉で構造を探すと、当たった構造に絞り、選ぶと当たった属性を出す", async () => {
    const fake = createFakeMaximo(seed());
    const vault = new FakeVault(fake, true);
    const catalog = new ObjectStructureCatalog();
    await catalog.syncAll(vault.conn!.client, fake.baseUrl);
    await render({ catalog, vault, toasts: new ToastStore(), storage: memoryStorage() });

    await act(async () => {
      setValue(q<HTMLInputElement>('input[aria-label="オブジェクト構造を探す"]')!, "申請完了日");
    });
    expect(listedNames()).toEqual(["MXAPIWO"]);
    expect(text()).toContain("当たった構造 1 件");
    expect(q(".os-item")?.textContent).toContain("申請完了日");
    expect(q(".structure-detail h2")?.textContent).toBe("MXAPIWO");
    expect(attrNames()).toEqual(["EXT_WOPERMIT.EXT_PERMITDATE"]);

    await act(async () => {
      setValue(q<HTMLInputElement>('input[aria-label="オブジェクト構造を探す"]')!, "タグ番号");
    });
    expect(listedNames()).toEqual(["MXASSET"]);
    expect(q(".structure-detail h2")?.textContent).toBe("MXASSET");
  });

  it("その構造を使って読み込んだシートを出す（同じ構造を複数のシートで使ってよい）", async () => {
    const fake = createFakeMaximo(seed());
    const vault = new FakeVault(fake, true);
    const catalog = new ObjectStructureCatalog();
    await catalog.syncAll(vault.conn!.client, fake.baseUrl);
    const workspace = new Workspace("作業");
    addSheet(workspace, "許可申請", "MXAPIWO", fake.baseUrl);
    addSheet(workspace, "WO一覧", "MXAPIWO", fake.baseUrl);
    // 別の接続先から読み込んだシートは数えない
    addSheet(workspace, "別の Maximo", "MXAPIWO", "https://other.example.com/maximo");
    await render({ catalog, vault, toasts: new ToastStore(), storage: memoryStorage(), workspace });

    const woItem = qa<HTMLButtonElement>(".os-item").find((b) => b.textContent?.includes("MXAPIWO"))!;
    expect(woItem.querySelector(".badge")?.textContent).toBe("シート 2");
    await click(woItem);
    expect(q(".used-sheets")?.textContent).toBe("許可申請、WO一覧");

    // シートが増えたら描き直す
    await act(async () => {
      addSheet(workspace, "追加", "MXAPIWO", fake.baseUrl);
    });
    await flush();
    expect(q(".used-sheets")?.textContent).toBe("許可申請、WO一覧、追加");
  });

  it("「すべて取り直す」は確認してから行い、使っているシートがあれば注意を出す", async () => {
    const fake = createFakeMaximo(seed());
    const vault = new FakeVault(fake, true);
    const catalog = new ObjectStructureCatalog();
    await catalog.syncAll(vault.conn!.client, fake.baseUrl);
    const workspace = new Workspace("作業");
    addSheet(workspace, "許可申請", "MXAPIWO", fake.baseUrl);
    const asked: string[] = [];
    let answer = false;
    await render({ catalog, vault, toasts: new ToastStore(), storage: memoryStorage(), workspace, confirm: (m) => (asked.push(m), answer) });
    const schemaRequests = () => fake.state.requests.filter((r) => r.path.includes("/jsonschemas/")).length;
    const before = schemaRequests();
    const refreshAll = () => qa<HTMLButtonElement>("button").find((b) => b.textContent === "すべて取り直す")!;

    await click(refreshAll());
    expect(asked[0]).toContain("許可申請");
    expect(schemaRequests()).toBe(before);

    answer = true;
    await click(refreshAll());
    for (let i = 0; i < 20 && catalog.snapshot(fake.baseUrl).sync.state === "running"; i++) await flush();
    expect(schemaRequests()).toBe(before + osCount);
    expect(catalog.snapshot(fake.baseUrl).sync).toMatchObject({ state: "done", refresh: true });
  });

  it("未接続でも、設定画面に保存した接続先の保存済みの定義は見られる（読み込みと取り直しはできない）", async () => {
    const fake = createFakeMaximo(seed());
    const storage = createMemoryCatalogStorage();
    const earlier = new ObjectStructureCatalog({ storage });
    await earlier.syncAll(new FakeVault(fake, true).conn!.client, fake.baseUrl);

    // ブラウザを開き直した後（同じ保存先の新しいカタログ）で、まだ接続していない
    const catalog = new ObjectStructureCatalog({ storage });
    await render({ catalog, vault: new FakeVault(fake, false), toasts: new ToastStore(), storage: memoryStorage({ [STORAGE_KEYS.baseUrl]: fake.baseUrl }) });

    expect(text()).toContain(`保存済み ${osCount} 件`);
    expect(text()).toContain("Maximo に接続していないため");
    expect(qa<HTMLButtonElement>("button").find((b) => b.textContent === "すべて取り直す")!.disabled).toBe(true);
    expect(qa<HTMLButtonElement>(".structure-detail button").find((b) => b.textContent === "再読み込み")!.disabled).toBe(true);
    expect(fake.state.requests.filter((r) => r.path.includes("/jsonschemas/")).length).toBe(osCount);
  });

  it("接続先がまだ無ければ設定へ案内する", async () => {
    const fake = createFakeMaximo(seed());
    await render({ catalog: new ObjectStructureCatalog(), vault: new FakeVault(fake, false), toasts: new ToastStore(), storage: memoryStorage() });
    expect(text()).toContain("Maximo の接続先がまだありません");
  });

  it("Maximo に定義された数・API で使える数（apimeta に載らず足した数）と、API で使えないため読み込まない構造を出す", async () => {
    const s = seed();
    s.objectStructures.EXT_WOPERMIT = { description: "許可申請", hiddenFromApimeta: true, keyAttrs: ["ext_wopermitid"], attrs: { ext_wopermitid: { type: "integer" } } };
    withDefinitions(s, [
      { name: "DMMAXAPPS", usewith: "マイグレーション・マネージャー" },
      { name: "DMMAXMENU", usewith: "マイグレーション・マネージャー" },
      { name: "WOSINVBAL", usewith: "WOS" },
    ]);
    const fake = createFakeMaximo(s);
    const vault = new FakeVault(fake, true);
    const catalog = new ObjectStructureCatalog();
    await catalog.syncAll(vault.conn!.client, fake.baseUrl);
    await render({ catalog, vault, toasts: new ToastStore(), storage: memoryStorage() });

    expect(q(".list-summary")?.textContent).toBe("Maximo に定義されたオブジェクト構造 7 件のうち、API で使える 4 件を読み込みます（apimeta に載らない 1 件を含む）。");
    expect(listedNames()).toContain("EXT_WOPERMIT");
    const notApi = qa<HTMLDetailsElement>("details").find((d) => d.textContent?.includes("API で使えないため"))!;
    expect(notApi.querySelector("summary")?.textContent).toBe("API で使えないため読み込まない構造（3 件: マイグレーション・マネージャー 2 件、WOS 1 件）");
    expect(notApi.textContent).toContain("DMMAXAPPS, DMMAXMENU");
    expect(text()).not.toContain("MXAPIINTOBJECT）を読めなかった");
  });

  it("Maximo の定義の一覧を読めなければ、apimeta に載る構造だけを読み込んだことと理由を出す", async () => {
    // sampleSeed には MXAPIINTOBJECT が無い（404）
    const fake = createFakeMaximo(seed());
    const vault = new FakeVault(fake, true);
    const catalog = new ObjectStructureCatalog();
    await catalog.syncAll(vault.conn!.client, fake.baseUrl);
    await render({ catalog, vault, toasts: new ToastStore(), storage: memoryStorage() });
    expect(q(".list-summary")?.textContent).toBe(`API で使えるオブジェクト構造 ${osCount} 件を読み込みます。`);
    expect(text()).toContain("Maximo の定義の一覧（MXAPIINTOBJECT）を読めなかったため、apimeta に載る構造だけを読み込みました");
    expect(text()).toContain("404");
  });

  it("読めなかった構造は件数と理由を出す", async () => {
    const fake = createFakeMaximo(seed());
    const vault = new FakeVault(fake, true, (f) => async (url, init) =>
      url.includes("/jsonschemas/mxasset") ? new Response(JSON.stringify({ Error: { message: "権限がありません" } }), { status: 403, headers: { "content-type": "application/json" } }) : f(url, init),
    );
    const catalog = new ObjectStructureCatalog();
    await catalog.syncAll(vault.conn!.client, fake.baseUrl);
    await render({ catalog, vault, toasts: new ToastStore(), storage: memoryStorage() });
    expect(text()).toContain("読み込めなかった構造（1 件）");
    expect(q("details")?.textContent).toContain("MXASSET");
  });
});

describe("オブジェクト構造の画面の純ロジック", () => {
  it("filterColumns は名前・ラベルを全角半角と大文字小文字を区別せずに探す", () => {
    const cols = [
      { name: "EXT_EQUIPTAG", type: "string" as const, title: "タグ番号" },
      { name: "ASSETSPEC.ALNVALUE", type: "string" as const, title: "英数字の値", child: "ASSETSPEC" },
    ];
    expect(filterColumns(cols, { kind: "all" }, "ｅｑｕｉｐｔａｇ").map((c) => c.name)).toEqual(["EXT_EQUIPTAG"]);
    expect(filterColumns(cols, { kind: "all" }, "英数字").map((c) => c.name)).toEqual(["ASSETSPEC.ALNVALUE"]);
    expect(filterColumns(cols, { kind: "child", name: "ASSETSPEC" }, "").map((c) => c.name)).toEqual(["ASSETSPEC.ALNVALUE"]);
    expect(filterColumns(cols, { kind: "parent" }, "").map((c) => c.name)).toEqual(["EXT_EQUIPTAG"]);
  });

  it("groupByUseWith は適用先ごとにまとめ、多い順（同数なら適用先の名前順）に並べる", () => {
    const d = (name: string, usewith: string) => ({ name, description: "", usewith });
    expect(groupByUseWith([d("WOSA", "WOS"), d("DM1", "マイグレーション・マネージャー"), d("DM2", "マイグレーション・マネージャー"), d("X", "OTHER")])).toEqual([
      { usewith: "マイグレーション・マネージャー", names: ["DM1", "DM2"] },
      { usewith: "OTHER", names: ["X"] },
      { usewith: "WOS", names: ["WOSA"] },
    ]);
    expect(groupByUseWith([])).toEqual([]);
  });

  it("normalizeOsName と loadErrorMessage", () => {
    expect(normalizeOsName(" mxapiwo ")).toBe("MXAPIWO");
    expect(normalizeOsName("MX-API")).toBeNull();
    expect(loadErrorMessage("X", new Error("boom"))).toBe("X を読み込めませんでした: boom。");
  });
});
