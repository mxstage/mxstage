// PWA（manifest・Service Worker の判断・登録）の試験。
// Service Worker の中身そのものは試験できないので、判断は cacheRules.ts の純関数として確かめる。

import { describe, expect, it, vi } from "vitest";
import {
  APP_SHELL_PATH,
  BUILD_MARKER,
  CACHE_PREFIX,
  PRECACHE_MARKER,
  STATIC_PRECACHE,
  asBuildId,
  asFileList,
  buildIdFrom,
  cacheNameOf,
  hasModuleSyntax,
  isNeverCached,
  isStaleCache,
  mayStore,
  planFor,
  precacheList,
  precachePlanFor,
  replaceMarker,
  shouldPrecache,
} from "../../src/app/pwa/cacheRules";
import {
  SW_URL,
  UPDATE_READY_MESSAGE,
  isUpdateReady,
  registerServiceWorker,
  type RegistrationLike,
  type ServiceWorkerContainerLike,
  type ServiceWorkerLike,
} from "../../src/app/pwa/register";

// 画面と同じ読み方（vite）で実物を読む。node のファイル API は使わない（画面側の型に node を混ぜないため）
import manifestRaw from "../../public/manifest.webmanifest?raw";
import indexHtmlRaw from "../../src/app/index.html?raw";

const iconFiles = import.meta.glob("../../public/*.png");

const ORIGIN = "http://127.0.0.1:7787";

function req(url: string, over: { method?: string; mode?: string } = {}) {
  return { method: over.method ?? "GET", mode: over.mode ?? "no-cors", url };
}

describe("manifest", () => {
  const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;

  it("standalone で名前とアイコンがある", () => {
    expect(manifest.name).toBe("mxstudio");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/app");
    expect(manifest.scope).toBe("/");
    expect(manifest.lang).toBe("ja");
  });

  it("192・512 と maskable のアイコンが実在する", () => {
    const icons = manifest.icons as Array<{ src: string; sizes: string; type: string; purpose: string }>;
    const sizes = icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    const files = Object.keys(iconFiles);
    for (const icon of icons) {
      expect(icon.type).toBe("image/png");
      expect(files).toContain(`../../public${icon.src}`);
    }
  });

  it("先読みの一覧に manifest とアイコンが入っている（バンドルに現れないため）", () => {
    const icons = (manifest.icons as Array<{ src: string }>).map((i) => i.src);
    for (const src of [...icons, "/manifest.webmanifest"]) expect(STATIC_PRECACHE).toContain(src);
  });

  it("index.html が manifest を参照している", () => {
    expect(indexHtmlRaw).toContain('rel="manifest"');
    expect(indexHtmlRaw).toContain("/manifest.webmanifest");
  });

  it("index.html の body の最後に、セル編集エディタの置き場（#portal）がある（無いとグリッドのセルを編集できない）", () => {
    const body = /<body>([\s\S]*)<\/body>/.exec(indexHtmlRaw)?.[1] ?? "";
    const lastElement = body.replace(/<!--[\s\S]*?-->/g, "").trim().split(/\r?\n/).at(-1)?.trim() ?? "";
    expect(lastElement).toMatch(/^<div id="portal"[^>]*><\/div>$/);
  });
});

describe("キャッシュしないもの", () => {
  it("Maximo の応答・中継・取り込み・橋渡しの状態と Skill の一覧は保存しない", () => {
    for (const p of ["/mx", "/mx/maximo/api/os/mxapiwo", "/ws", "/import/abc", "/_mxstudio/skills", "/_mxstudio/health"]) {
      expect(isNeverCached(p)).toBe(true);
    }
  });

  it("画面のファイルは対象外（保存してよい）", () => {
    for (const p of ["/", "/app", "/settings", "/structures", "/index.html", "/assets/index-abc123.js", "/icon-192.png", "/mxsomething"]) {
      expect(isNeverCached(p)).toBe(false);
    }
  });
});

describe("要求の扱い方", () => {
  it("画面の遷移はネットワーク優先（navigate）", () => {
    expect(planFor(req(`${ORIGIN}/app`, { mode: "navigate" }), ORIGIN)).toBe("navigate");
  });

  it("同一オリジンの静的ファイルはキャッシュ優先", () => {
    expect(planFor(req(`${ORIGIN}/assets/index-abc.js`), ORIGIN)).toBe("cache-first");
    expect(planFor(req(`${ORIGIN}/icon-192.png`), ORIGIN)).toBe("cache-first");
  });

  it("Maximo の応答・ツールの結果・中継には触らない", () => {
    expect(planFor(req(`${ORIGIN}/mx/maximo/api/os/mxapiasset?oslc.select=*`), ORIGIN)).toBe("network-only");
    expect(planFor(req(`${ORIGIN}/_mxstudio/skills`), ORIGIN)).toBe("network-only");
    expect(planFor(req(`${ORIGIN}/ws`), ORIGIN)).toBe("network-only");
  });

  it("他オリジン（direct 方式の Maximo）と GET 以外には触らない", () => {
    expect(planFor(req("https://maximo.example.com/maximo/api/os/mxapiwo"), ORIGIN)).toBe("network-only");
    expect(planFor(req(`${ORIGIN}/assets/index-abc.js`, { method: "POST" }), ORIGIN)).toBe("network-only");
    expect(planFor({ method: "GET", mode: "cors", url: "javascript:void(0)" }, ORIGIN)).toBe("network-only");
  });

  it("取り込みや橋渡しの URL への遷移には枠を返さない", () => {
    for (const p of ["/import/abc", "/_mxstudio/health"]) {
      expect(planFor(req(`${ORIGIN}${p}`, { mode: "navigate" }), ORIGIN)).toBe("network-only");
    }
    // 画面が持っているパスの遷移は、これまでどおりネットワーク優先（オフラインのときだけ枠を返す）
    for (const p of ["/", "/app", "/settings"]) {
      expect(planFor(req(`${ORIGIN}${p}`, { mode: "navigate" }), ORIGIN)).toBe("navigate");
    }
  });

  it("保存してよいのは、同一オリジンの静的ファイルの 200 だけ", () => {
    const asset = req(`${ORIGIN}/assets/index-abc.js`);
    expect(mayStore(asset, ORIGIN, { status: 200, type: "basic" })).toBe(true);
    expect(mayStore(asset, ORIGIN, { status: 404, type: "basic" })).toBe(false);
    expect(mayStore(asset, ORIGIN, { status: 200, type: "opaque" })).toBe(false);
    expect(mayStore(req(`${ORIGIN}/mx/x`), ORIGIN, { status: 200, type: "basic" })).toBe(false);
    expect(mayStore(req(`${ORIGIN}/app`, { mode: "navigate" }), ORIGIN, { status: 200, type: "basic" })).toBe(false);
  });

  it("先読みの応答: 転送を経た枠は詰め直す（そのまま遷移に返すとネットワークエラー）", () => {
    expect(precachePlanFor({ status: 200, type: "basic", redirected: false })).toBe("store");
    expect(precachePlanFor({ status: 200, type: "basic", redirected: true })).toBe("rewrap");
    // 取れなかった・同一オリジンでない応答は保存しない（install は止めない）
    expect(precachePlanFor({ status: 404, type: "basic" })).toBe("skip");
    expect(precachePlanFor({ status: 503, type: "basic" })).toBe("skip");
    expect(precachePlanFor({ status: 200, type: "opaque" })).toBe("skip");
    expect(precachePlanFor({ status: 200, type: "cors", redirected: true })).toBe("skip");
  });

  it("HTML は保存しない（/app は作業キーの有無で中身が変わる。枠は先読み済み）", () => {
    // 画面の遷移ではない fetch("/app") でも、HTML は保存しない
    expect(mayStore(req(`${ORIGIN}/app`), ORIGIN, { status: 200, type: "basic", contentType: "text/html; charset=utf-8" })).toBe(false);
    expect(mayStore(req(`${ORIGIN}/assets/index-abc.js`), ORIGIN, { status: 200, type: "basic", contentType: "text/javascript" })).toBe(true);
  });
});

describe("先読みする一覧", () => {
  it("画面のファイルだけを選ぶ（sw.js 自身とソースマップは入れない）", () => {
    expect(shouldPrecache("index.html")).toBe(true);
    expect(shouldPrecache("assets/index-abc.js")).toBe(true);
    expect(shouldPrecache("assets/index-abc.css")).toBe(true);
    expect(shouldPrecache("sw.js")).toBe(false);
    expect(shouldPrecache("assets/index-abc.js.map")).toBe(false);
    expect(shouldPrecache("stats.json")).toBe(false);
  });

  it("書体は .woff2 だけを先読みし、日本語の書体（大きい）は先読みせずに初めて使ったときに保存する", () => {
    expect(shouldPrecache("assets/ibm-plex-sans-latin-400-normal-abc.woff2")).toBe(true);
    expect(shouldPrecache("assets/ibm-plex-mono-latin-400-normal-abc.woff2")).toBe(true);
    expect(shouldPrecache("assets/ibm-plex-sans-latin-400-normal-abc.woff")).toBe(false);
    const jp = "assets/ibm-plex-sans-jp-japanese-400-normal-abc.woff2";
    expect(shouldPrecache(jp)).toBe(false);
    const font = req(`${ORIGIN}/${jp}`);
    expect(planFor(font, ORIGIN)).toBe("cache-first");
    expect(mayStore(font, ORIGIN, { status: 200, type: "basic", contentType: "font/woff2" })).toBe(true);
  });

  it("先頭に / を付け、manifest とアイコンを足し、並びを固定する", () => {
    const list = precacheList(["index.html", "assets/a-1.js", "assets/a-1.js.map", "sw.js"], ["/manifest.webmanifest"]);
    expect(list).toEqual(["/assets/a-1.js", "/index.html", "/manifest.webmanifest"]);
    expect(list).toContain(APP_SHELL_PATH);
  });

  it("版は一覧から決まる（ファイルが変われば別のキャッシュになる）", () => {
    const a = buildIdFrom(["/index.html", "/assets/a-1.js"]);
    expect(buildIdFrom(["/assets/a-1.js", "/index.html"])).toBe(a);
    expect(buildIdFrom(["/index.html", "/assets/a-2.js"])).not.toBe(a);
    expect(cacheNameOf(a).startsWith(CACHE_PREFIX)).toBe(true);
  });

  it("古いキャッシュだけを消す（他のサイトのものは消さない）", () => {
    const current = cacheNameOf("aaaa1111");
    expect(isStaleCache(cacheNameOf("bbbb2222"), current)).toBe(true);
    expect(isStaleCache(current, current)).toBe(false);
    expect(isStaleCache("other-app-cache", current)).toBe(false);
  });

  it("差し込み前の値でも壊れない", () => {
    expect(asFileList(PRECACHE_MARKER)).toEqual([]);
    expect(asFileList(["/a.js", "b.js", 1])).toEqual(["/a.js"]);
    expect(asBuildId(BUILD_MARKER)).toBe("dev");
    expect(asBuildId("abc123")).toBe("abc123");
  });
});

describe("ビルド時の差し込み", () => {
  it("目印を JSON に置き換える", () => {
    const code = `const a="${PRECACHE_MARKER}";`;
    expect(replaceMarker(code, PRECACHE_MARKER, ["/a.js"])).toBe('const a=["/a.js"];');
    expect(replaceMarker(`const a='${BUILD_MARKER}';`, BUILD_MARKER, "x1")).toBe('const a="x1";');
  });

  it("目印が無い・2 つ以上あるときは止める（黙って差し込みに失敗しない）", () => {
    expect(() => replaceMarker("const a=1;", PRECACHE_MARKER, [])).toThrow();
    expect(() => replaceMarker(`"${PRECACHE_MARKER}";'${PRECACHE_MARKER}';`, PRECACHE_MARKER, [])).toThrow();
  });

  it("import / export が残っているかを見分ける", () => {
    expect(hasModuleSyntax('import{a}from"./x.js";')).toBe(true);
    expect(hasModuleSyntax('import("./x.js")')).toBe(true);
    expect(hasModuleSyntax("export{a};")).toBe(true);
    expect(hasModuleSyntax('const a=1;self.addEventListener("fetch",()=>{});')).toBe(false);
  });
});

describe("Service Worker の登録", () => {
  class FakeWorker implements ServiceWorkerLike {
    state = "installing";
    private readonly listeners: Array<() => void> = [];
    addEventListener(_type: "statechange", listener: () => void): void {
      this.listeners.push(listener);
    }
    become(state: string): void {
      this.state = state;
      for (const l of this.listeners) l();
    }
  }

  class FakeRegistration implements RegistrationLike {
    installing: FakeWorker | null = null;
    waiting: FakeWorker | null = null;
    private readonly found: Array<() => void> = [];
    addEventListener(_type: "updatefound", listener: () => void): void {
      this.found.push(listener);
    }
    updateFound(worker: FakeWorker): void {
      this.installing = worker;
      for (const l of this.found) l();
    }
  }

  function container(registration: RegistrationLike, controller: unknown = null): ServiceWorkerContainerLike & { register: ReturnType<typeof vi.fn> } {
    const register = vi.fn(async () => registration);
    return { controller, register };
  }

  it("初回は更新を知らせない（まだ制御している Service Worker が無い）", () => {
    expect(isUpdateReady("installed", false)).toBe(false);
    expect(isUpdateReady("installed", true)).toBe(true);
    expect(isUpdateReady("installing", true)).toBe(false);
  });

  it("2 回目以降に新しい版が入ったら 1 回だけ知らせる", async () => {
    const reg = new FakeRegistration();
    const c = container(reg, {});
    const onUpdate = vi.fn();
    await registerServiceWorker({ container: c, onUpdate });
    expect(c.register).toHaveBeenCalledWith(SW_URL, { scope: "/" });

    const worker = new FakeWorker();
    reg.updateFound(worker);
    expect(onUpdate).not.toHaveBeenCalled();
    worker.become("installed");
    worker.become("activated");
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(UPDATE_READY_MESSAGE);
  });

  it("初回の登録では、activate の clients.claim() で controller が付いても知らせない", async () => {
    // 実ブラウザの navigator.serviceWorker.controller は生きた値で、初回でも activate の claim() の後に付く。
    // 都度いまの値を見る作りだと、まっさらな PC の 1 回目の起動で「新しい版を用意しました」と出てしまう。
    const reg = new FakeRegistration();
    const worker = new FakeWorker();
    reg.installing = worker;
    let controller: unknown = null;
    const register = vi.fn(async () => reg as RegistrationLike);
    const live: ServiceWorkerContainerLike = {
      get controller() {
        return controller;
      },
      register,
    };
    const onUpdate = vi.fn();
    await registerServiceWorker({ container: live, onUpdate });

    worker.become("installed");
    controller = {}; // clients.claim() で、いま開いている画面が制御下に入る
    worker.become("activating");
    worker.become("activated");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("待機中の版が既にあれば、その場で知らせる", async () => {
    const reg = new FakeRegistration();
    const waiting = new FakeWorker();
    waiting.state = "installed";
    reg.waiting = waiting;
    const onUpdate = vi.fn();
    await registerServiceWorker({ container: container(reg, {}), onUpdate });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("登録できなくても画面は動く（例外にしない）", async () => {
    const failing: ServiceWorkerContainerLike = {
      controller: null,
      register: async () => {
        throw new Error("登録できません");
      },
    };
    const onUpdate = vi.fn();
    await expect(registerServiceWorker({ container: failing, onUpdate })).resolves.toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
