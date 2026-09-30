// LLM が読む文は英語だけにする（ツールの名前・説明・入力スキーマ、サーバの案内、最初の呼び出しに添える基本手順、
// 更新の知らせ、中継のエラー文、橋渡しの --help）。利用者への返事は LLM が利用者の言葉にする。
// 漢字・かなが入ったら落ちる。LLM が実際に受け取る形（tools/list と initialize の instructions）で確かめる。

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { updateNotices, updatesText } from "../../src/bridge/freshness.ts";
import { SERVER_INSTRUCTIONS, buildBridgeMcpServer, sessionGuide } from "../../src/bridge/mcp.ts";
import { HELP_TEXT } from "../../src/bridge/options.ts";
import { SKILLS } from "../../src/bridge/defaultSkills.ts";
import { RelayErrorCode, relayErrorMessage } from "../../src/shared/protocol.ts";
import type { HubRpc } from "../../src/shared/protocol.ts";
import { TOOL_NAMES } from "../../src/shared/toolDefs.ts";

const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿！-｠]/u;

/** 日本語の文字を含む箇所（前後を少し添える）。無ければ空 */
function japaneseSpots(text: string): string[] {
  const spots: string[] = [];
  for (const m of text.matchAll(new RegExp(JAPANESE.source, "gu"))) {
    const at = m.index ?? 0;
    spots.push(text.slice(Math.max(0, at - 30), at + 30));
    if (spots.length >= 5) break;
  }
  return spots;
}

async function connect() {
  const server = buildBridgeMcpServer({
    origin: "http://127.0.0.1:1",
    hub: { invoke: () => Promise.reject(new Error("unused")), status: () => Promise.reject(new Error("unused")) } as unknown as HubRpc,
    tickets: { create: () => Promise.reject(new Error("unused")) },
    version: "0.0.0",
    userSkillsDir: null,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

describe("LLM が読む文は英語だけ", () => {
  it("tools/list の名前・題・説明・入力スキーマ", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBe(TOOL_NAMES.length);
    for (const t of tools) expect(japaneseSpots(JSON.stringify(t)), t.name).toEqual([]);
  });

  it("サーバの案内（initialize の instructions）", async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
    expect(japaneseSpots(instructions)).toEqual([]);
    expect(instructions).toMatch(/language they use/);
  });

  it("最初の呼び出しに添える基本手順（既定の Skill）と利用者の Skill の案内", () => {
    expect(japaneseSpots(sessionGuide(null))).toEqual([]);
    for (const s of SKILLS) {
      expect(japaneseSpots(s.description), s.name).toEqual([]);
      expect(japaneseSpots(s.body), s.name).toEqual([]);
    }
  });

  it("更新の知らせ", () => {
    const text =
      updatesText(
        updateNotices({
          selfStale: true,
          isPrimary: false,
          primaryStale: true,
          staleBuild: ["src/app"],
          skillCopies: [{ label: "Claude Code", dir: "/skills", changed: ["a"], missing: ["b"] }],
        }),
      ) ?? "";
    expect(text).not.toBe("");
    expect(japaneseSpots(text)).toEqual([]);
  });

  it("中継のエラー文", () => {
    for (const code of Object.values(RelayErrorCode)) {
      expect(japaneseSpots(relayErrorMessage(code, "http://127.0.0.1:1")), String(code)).toEqual([]);
    }
  });

  it("橋渡しの --help", () => {
    expect(japaneseSpots(HELP_TEXT)).toEqual([]);
  });
});

describe("実装していないツールは載せない", () => {
  it("import_rows と export_sheet は tools/list に無い", () => {
    expect(TOOL_NAMES).not.toContain("import_rows");
    expect(TOOL_NAMES).not.toContain("export_sheet");
  });
});
