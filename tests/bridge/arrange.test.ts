// 作業画面と AI アシスタントの窓を左右に並べる（src/bridge/arrangeWindows.ts と /_mxstage/arrange）。
// 本物の窓は動かさない（PowerShell の代わりに出力を返す）。

import { afterEach, describe, expect, it } from "vitest";
import { arrangeWindows, parseArrangeOutput } from "../../src/bridge/arrangeWindows.ts";
import { ARRANGE_PATH } from "../../src/bridge/server.ts";
import { rawRequest, startTestBridge, stopAll } from "./support.ts";

afterEach(async () => {
  await stopAll();
});

describe("窓を並べる", () => {
  it("PowerShell の出力を読む（アプリの種類だけを返し、題名は返さない）", () => {
    expect(parseArrangeOutput('noise\r\n{"ok":true,"process":"codex"}\r\n')).toEqual({ ok: true, assistant: "Codex" });
    expect(parseArrangeOutput('{"ok":true,"process":"windowsterminal"}')).toEqual({ ok: true, assistant: "Terminal" });
    expect(parseArrangeOutput('{"ok":false,"reason":"no_assistant"}')).toEqual({ ok: false, reason: "no_assistant" });
    expect(parseArrangeOutput('{"ok":false,"reason":"inside_assistant"}')).toEqual({ ok: false, reason: "inside_assistant" });
    expect(parseArrangeOutput("")).toMatchObject({ ok: false, reason: "failed" });
  });

  it("Windows 以外ではしない。印の形が違えば動かさない", async () => {
    let ran = 0;
    const run = async () => {
      ran++;
      return '{"ok":true,"process":"claude"}';
    };
    expect(await arrangeWindows("abcdefgh1234", { platform: "darwin", run })).toEqual({ ok: false, reason: "unsupported" });
    expect(await arrangeWindows("bad token!", { platform: "win32", run })).toMatchObject({ ok: false, reason: "failed" });
    expect(ran).toBe(0);
    expect(await arrangeWindows("abcdefgh1234", { platform: "win32", run })).toEqual({ ok: true, assistant: "Claude" });
  });

  it("入口: できるかを返し、並べるのは作業画面（同一オリジン）からだけ", async () => {
    const tokens: string[] = [];
    const bridge = await startTestBridge({
      arrange: {
        platform: "win32",
        run: async (token) => {
          tokens.push(token);
          return { ok: false, reason: "no_assistant" };
        },
      },
    });
    expect(JSON.parse((await rawRequest(bridge, ARRANGE_PATH)).body)).toEqual({ ok: true, supported: true });
    const body = JSON.stringify({ token: "abcdefgh1234" });
    const blocked = await rawRequest(bridge, ARRANGE_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect(blocked.status).toBe(403);
    const res = await rawRequest(bridge, ARRANGE_PATH, { method: "POST", headers: { "Content-Type": "application/json", Origin: bridge.origin }, body });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: "no_assistant" });
    expect(tokens).toEqual(["abcdefgh1234"]);
  });
});
