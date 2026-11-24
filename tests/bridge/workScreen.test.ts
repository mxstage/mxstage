// タブが無いのにツールが作業画面を要るとき、橋渡しが既定のブラウザで作業画面を開く（src/bridge/workScreen.ts・src/bridge/mcp.ts）。
// 開く命令は差し替える（本物のブラウザは起動しない）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OPEN_WAIT_MS, runTabTool, runWorkerTool } from "../../src/bridge/mcp.ts";
import type { BridgeMcpDeps } from "../../src/bridge/mcp.ts";
import { MAX_OPENS_WITHOUT_TAB, REOPEN_AFTER_MS, WorkScreenOpener, browserCommand, launchDefaultBrowser } from "../../src/bridge/workScreen.ts";
import { RelayErrorCode, relayErrorMessage, workScreenOpenMessage } from "../../src/shared/protocol.ts";
import type { HubInvokeRequest, HubInvokeResponse, HubRpc, HubStatus, WorkScreenOpenOutcome } from "../../src/shared/protocol.ts";
import { REPO_ROOT } from "./support.ts";

const ORIGIN = "http://127.0.0.1:8788";
const APP_URL = `${ORIGIN}/app`;

/** 開く命令の偽物。呼ばれた URL を覚える */
function fakeLauncher(ok: boolean | (() => boolean) = true) {
  const calls: string[] = [];
  const launch = async (url: string) => {
    calls.push(url);
    return typeof ok === "function" ? ok() : ok;
  };
  return { calls, launch };
}

/** タブの有無を切り替えられる Hub の偽物。タブが無ければ NO_TAB を返す */
class FakeHub implements HubRpc {
  tabConnected = false;
  /** 開く命令が呼ばれたら（ブラウザがタブを開いたことにして）つなぐ */
  connectOnOpen = false;
  readonly invoked: HubInvokeRequest[] = [];

  async invoke(req: HubInvokeRequest): Promise<HubInvokeResponse> {
    this.invoked.push(req);
    if (!this.tabConnected) return { ok: false, code: RelayErrorCode.NO_TAB, message: relayErrorMessage(RelayErrorCode.NO_TAB, ORIGIN), retryable: false };
    return { ok: true, result: { content: [{ type: "text", text: `answered ${req.tool}` }] }, revision: 1 };
  }

  async status(): Promise<HubStatus> {
    return this.tabConnected
      ? { tabs: [{ tabId: "t1", role: "primary" as never, workspace: null, appVersion: "test", connectedAt: 0 }], primaryTabId: "t1" }
      : { tabs: [], primaryTabId: null };
  }

  async pushImport(): Promise<{ delivered: boolean }> {
    return { delivered: false };
  }
}

function setup(opts: { enabled?: boolean; ok?: boolean | (() => boolean) } = {}) {
  const hub = new FakeHub();
  const launcher = fakeLauncher(opts.ok ?? true);
  let clock = 1_000_000;
  const opener = new WorkScreenOpener({
    enabled: opts.enabled ?? true,
    url: APP_URL,
    launch: async (url) => {
      const ok = await launcher.launch(url);
      if (ok && hub.connectOnOpen) hub.tabConnected = true;
      return ok;
    },
    now: () => clock,
  });
  const deps: BridgeMcpDeps = {
    origin: ORIGIN,
    hub,
    tickets: { create: () => Promise.reject(new Error("unused")) },
    version: "test",
    workScreen: opener,
    // 待つあいだは時計だけ進める（本当には待たない）
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return {
    hub,
    launcher,
    opener,
    deps,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

function errorOf(result: { structuredContent?: unknown }): { code: number; name: string; message: string; browserOpened?: boolean } {
  return (result.structuredContent as { error: { code: number; name: string; message: string; browserOpened?: boolean } }).error;
}

describe("WorkScreenOpener（何度も開かない）", () => {
  it("1 回開いたら、60 秒のあいだは開き直さない。過ぎたらもう 1 回だけ開き、それでもつながらなければ諦める", async () => {
    const { opener, launcher, advance } = setup();
    expect(await opener.request()).toBe("opened");
    expect(await opener.request()).toBe("waiting");
    advance(REOPEN_AFTER_MS - 1);
    expect(await opener.request()).toBe("waiting");
    expect(launcher.calls).toEqual([APP_URL]);
    advance(1);
    expect(await opener.request()).toBe("opened");
    advance(REOPEN_AFTER_MS);
    expect(MAX_OPENS_WITHOUT_TAB).toBe(2);
    expect(await opener.request()).toBe("gave_up");
    expect(launcher.calls).toHaveLength(2);
  });

  it("同時に頼まれても、開く命令は 1 回", async () => {
    const { opener, launcher } = setup();
    const outcomes = await Promise.all([opener.request(), opener.request(), opener.request()]);
    expect(launcher.calls).toHaveLength(1);
    expect(outcomes.filter((o) => o === "opened")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "waiting")).toHaveLength(2);
  });

  it("タブがつながったら数え直し、次にタブが無くなったときは、すぐまた開ける", async () => {
    const { opener, launcher } = setup();
    expect(await opener.request()).toBe("opened");
    opener.tabSeen();
    expect(await opener.request()).toBe("opened");
    expect(launcher.calls).toHaveLength(2);
  });

  it("--no-open（enabled: false）では開かない", async () => {
    const { opener, launcher } = setup({ enabled: false });
    expect(await opener.request()).toBe("off");
    expect(launcher.calls).toEqual([]);
  });

  it("開けなかった（命令が失敗・例外）ら failed", async () => {
    const { opener } = setup({ ok: false });
    expect(await opener.request()).toBe("failed");
    const throwing = new WorkScreenOpener({ enabled: true, url: APP_URL, launch: () => Promise.reject(new Error("no browser")) });
    expect(await throwing.request()).toBe("failed");
  });
});

describe("タブが無いときのツールの呼び出し", () => {
  it("タブが無い → 開く命令は 1 回だけ。つながったら、その呼び出しを送り直して答えを返す（開いたことも添える）", async () => {
    const { hub, launcher, deps } = setup();
    hub.connectOnOpen = true;
    const result = await runTabTool(deps, "query_rows", {});
    expect(launcher.calls).toEqual([APP_URL]);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ text: "answered query_rows" });
    expect(JSON.stringify(result.content)).toContain("opened it in the default browser");
    // 1 回目は NO_TAB、2 回目（送り直し）で答えた。どちらも同じ呼び出し（同じ冪等キー）
    expect(hub.invoked).toHaveLength(2);
    expect(hub.invoked[1]?.idempotencyKey).toBe(hub.invoked[0]?.idempotencyKey);
  });

  it("開いたがまだつながらない → 「開いた。開いたら続ける」を返し、URL を打たせない。続けて呼んでも開き直さない", async () => {
    const { hub, launcher, deps, now } = setup();
    const startedAt = now();
    const first = await runTabTool(deps, "get_status", {});
    expect(launcher.calls).toHaveLength(1);
    // 締切（25 秒）の中で待つ
    expect(now() - startedAt).toBeLessThanOrEqual(OPEN_WAIT_MS);
    expect(first.structuredContent).toMatchObject({ tabConnected: false, appUrl: APP_URL, browserOpened: true, message: workScreenOpenMessage("opened", ORIGIN) });
    expect(String((first.structuredContent as { message: string }).message)).not.toMatch(/Ask the user to open/);

    const second = await runTabTool(deps, "load_sheet", {});
    expect(launcher.calls).toHaveLength(1);
    expect(second.isError).toBe(true);
    expect(errorOf(second)).toMatchObject({ code: RelayErrorCode.NO_TAB, name: "NO_TAB", browserOpened: true, message: workScreenOpenMessage("waiting", ORIGIN) });

    // タブがつながったら止める（以後の呼び出しはそのまま通る）
    hub.tabConnected = true;
    const third = await runTabTool(deps, "get_status", {});
    expect(third.content[0]).toMatchObject({ text: "answered get_status" });
    expect(launcher.calls).toHaveLength(1);
  });

  it("--no-open では開かず、今までどおり URL を案内する", async () => {
    const { launcher, deps } = setup({ enabled: false });
    const status = await runTabTool(deps, "get_status", {});
    expect(launcher.calls).toEqual([]);
    expect(status.structuredContent).toMatchObject({ tabConnected: false, browserOpened: false, message: relayErrorMessage(RelayErrorCode.NO_TAB, ORIGIN) });
    const other = await runTabTool(deps, "load_sheet", {});
    expect(errorOf(other)).toMatchObject({ code: RelayErrorCode.NO_TAB, browserOpened: false });
    expect(errorOf(other).message).toContain(`open ${APP_URL}`);
  });

  it("開けなかったら（ブラウザが無い・失敗）URL を案内する", async () => {
    const { launcher, deps } = setup({ ok: false });
    const status = await runTabTool(deps, "get_status", {});
    expect(launcher.calls).toHaveLength(1);
    expect(status.structuredContent).toMatchObject({ tabConnected: false, browserOpened: false });
    expect(String((status.structuredContent as { message: string }).message)).toContain(`open ${APP_URL}`);
  });

  it("開く仕組みを渡さなければ（古い呼び方）今までと同じ答え", async () => {
    const { deps } = setup();
    const plain = { ...deps, workScreen: undefined };
    const status = await runTabTool(plain, "get_status", {});
    expect(status.structuredContent).toEqual({ tabConnected: false, appUrl: APP_URL, message: relayErrorMessage(RelayErrorCode.NO_TAB, ORIGIN) });
  });

  it("タブがつながっていれば開かない", async () => {
    const { hub, launcher, deps } = setup();
    hub.tabConnected = true;
    await runTabTool(deps, "get_status", {});
    const grid = await runWorkerTool(deps, "open_grid", {});
    expect(grid.structuredContent).toMatchObject({ tabConnected: true });
    expect(grid.structuredContent).not.toHaveProperty("browserOpened");
    expect(launcher.calls).toEqual([]);
  });

  it("open_grid: タブが無ければ開く（待たない）。続けて呼んでも開き直さない", async () => {
    const { launcher, deps } = setup();
    const grid = await runWorkerTool(deps, "open_grid", {});
    expect(grid.structuredContent).toMatchObject({ appUrl: APP_URL, tabConnected: false, browserOpened: true, message: workScreenOpenMessage("opened", ORIGIN) });
    const again = await runWorkerTool(deps, "open_grid", {});
    expect(again.structuredContent).toMatchObject({ browserOpened: true, message: workScreenOpenMessage("waiting", ORIGIN) });
    expect(launcher.calls).toHaveLength(1);
  });

  it("AI 向けの文は英語で、開いたときは URL を打たせず、開けなかったときだけ URL を開いてもらう", () => {
    const outcomes: WorkScreenOpenOutcome[] = ["opened", "waiting", "failed", "gave_up", "off"];
    for (const o of outcomes) expect(workScreenOpenMessage(o, ORIGIN), o).not.toMatch(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
    for (const o of ["opened", "waiting"] as const) {
      expect(workScreenOpenMessage(o, ORIGIN)).toMatch(/do not open it again|Do not open it again/);
      expect(workScreenOpenMessage(o, ORIGIN)).not.toMatch(/Ask the user to open/);
    }
    for (const o of ["failed", "gave_up", "off"] as const) expect(workScreenOpenMessage(o, ORIGIN)).toContain(`open ${APP_URL}`);
  });
});

describe("既定のブラウザを開く命令", () => {
  function fakeSpawn(behaviour: { exit?: number; error?: boolean; throws?: boolean }) {
    const calls: { file: string; args: readonly string[] }[] = [];
    const spawn = (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      if (behaviour.throws) throw new Error("spawn failed");
      const listeners: Record<string, (v: never) => void> = {};
      const child = {
        on(event: string, listener: (v: never) => void) {
          listeners[event] = listener;
          return child;
        },
        unref() {},
      };
      queueMicrotask(() => {
        if (behaviour.error) listeners.error?.(new Error("ENOENT") as never);
        else if (behaviour.exit !== undefined) listeners.exit?.(behaviour.exit as never);
      });
      return child;
    };
    return { calls, spawn };
  }

  it("OS ごとの命令（Windows は cmd /c start、macOS は open、ほかは xdg-open）", () => {
    expect(browserCommand(APP_URL, "win32")).toEqual({ file: "cmd", args: ["/c", "start", "", APP_URL] });
    expect(browserCommand(APP_URL, "darwin")).toEqual({ file: "open", args: [APP_URL] });
    expect(browserCommand(APP_URL, "linux")).toEqual({ file: "xdg-open", args: [APP_URL] });
  });

  it("0 で終われば開けた。0 以外・起動できない・例外なら開けなかった。終わらなければ開けたとみなす", async () => {
    const ok = fakeSpawn({ exit: 0 });
    expect(await launchDefaultBrowser(APP_URL, { spawn: ok.spawn, platform: "linux" })).toBe(true);
    expect(ok.calls).toEqual([{ file: "xdg-open", args: [APP_URL] }]);
    expect(await launchDefaultBrowser(APP_URL, { spawn: fakeSpawn({ exit: 3 }).spawn, platform: "linux" })).toBe(false);
    expect(await launchDefaultBrowser(APP_URL, { spawn: fakeSpawn({ error: true }).spawn, platform: "linux" })).toBe(false);
    expect(await launchDefaultBrowser(APP_URL, { spawn: fakeSpawn({ throws: true }).spawn, platform: "linux" })).toBe(false);
    expect(await launchDefaultBrowser(APP_URL, { spawn: fakeSpawn({}).spawn, platform: "win32", waitMs: 5 })).toBe(true);
  });
});

describe("Claude Desktop の拡張機能の設定", () => {
  it("既定は開く。切れば --open-work-screen false が橋渡しに渡る", () => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "mcpb", "manifest.template.json"), "utf8")) as {
      server: { mcp_config: { args: string[] } };
      user_config: Record<string, { type: string; default: unknown }>;
    };
    const args = manifest.server.mcp_config.args;
    expect(args.slice(args.indexOf("--open-work-screen"), args.indexOf("--open-work-screen") + 2)).toEqual(["--open-work-screen", "${user_config.open_work_screen}"]);
    expect(manifest.user_config.open_work_screen).toMatchObject({ type: "boolean", default: true });
    expect(args).not.toContain("--no-open");
  });
});
