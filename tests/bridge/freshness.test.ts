// 更新の知らせ（src/bridge/freshness.ts）と、それを get_status・最初のツール呼び出しに添える MCP の包み（src/bridge/mcp.ts）。
// 書くのは一時フォルダだけ。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILD_SOURCES,
  CodeFingerprint,
  checkUpdates,
  isDefaultAppDir,
  skillCopyProblems,
  sourceSkills,
  staleBuildSources,
  updateNotices,
  updatesText,
} from "../../src/bridge/freshness.ts";
import type { UpdateNotice, UpdateState } from "../../src/bridge/freshness.ts";
import { buildBridgeMcpServer, withUpdates } from "../../src/bridge/mcp.ts";
import { PEER_HEALTH_PATH, probeBridgeHealth } from "../../src/bridge/peer.ts";
import type { HubInvokeRequest, HubInvokeResponse, HubRpc, HubStatus } from "../../src/shared/protocol.ts";
import { REPO_ROOT, rawRequest, startTestBridge, stopAll } from "./support.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mxs-fresh-"));
});

afterEach(async () => {
  await stopAll();
  rmSync(dir, { recursive: true, force: true });
});

function put(rel: string, text: string, mtime?: Date): string {
  const file = join(dir, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text, "utf8");
  if (mtime) utimesSync(file, mtime, mtime);
  return file;
}

const skill = (name: string, body = "本文") => `---\nname: ${name}\ndescription: "説明"\nmetadata:\n  version: "0.1.0"\n---\n\n# ${body}\n`;

describe("CodeFingerprint", () => {
  it("中身が変わったときだけ古いと言う（更新時刻だけの変化・元に戻したときは言わない）", () => {
    const file = put("src/bridge/a.ts", "export const a = 1;\n");
    put("package.json", "{}\n");
    const code = new CodeFingerprint(dir);
    expect(code.changed()).toBe(false);

    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
    expect(code.changed()).toBe(false);

    writeFileSync(file, "export const a = 2;\n", "utf8");
    expect(code.changed()).toBe(true);

    writeFileSync(file, "export const a = 1;\n", "utf8");
    expect(code.changed()).toBe(false);

    put("src/shared/new.ts", "export {};\n");
    expect(code.changed()).toBe(true); // ファイルが増えても古い
  });

  it("node_modules と . で始まるものは見ない", () => {
    put("src/bridge/a.ts", "1");
    const code = new CodeFingerprint(dir);
    put("src/bridge/node_modules/x.js", "x");
    put("src/bridge/.cache", "x");
    expect(code.changed()).toBe(false);
  });
});

describe("staleBuildSources", () => {
  it("ビルドが無ければ dist/app、元の方が新しければその場所を返す", () => {
    expect(staleBuildSources(dir)).toEqual(["dist/app"]);
    const past = new Date(Date.now() - 60_000);
    put("src/app/main.tsx", "x", past);
    put("dist/app/index.html", "<html>");
    expect(staleBuildSources(dir)).toEqual([]);
    put("skills/a/SKILL.md", skill("a"), new Date(Date.now() + 60_000));
    expect(staleBuildSources(dir)).toEqual(["skills"]);
  });

  it("もとの一覧は導入（setup-local.mjs）の BUILD_SOURCES と同じ", () => {
    const text = readFileSync(join(REPO_ROOT, "scripts", "setup-local.mjs"), "utf8");
    const m = /export const BUILD_SOURCES = (\[[^\]]*\]);/.exec(text);
    expect(m).not.toBeNull();
    expect(JSON.parse(m?.[1] ?? "[]")).toEqual([...BUILD_SOURCES]);
  });

  it("isDefaultAppDir: 既定の dist/app だけ", () => {
    expect(isDefaultAppDir(dir, join(dir, "dist", "app"))).toBe(true);
    expect(isDefaultAppDir(dir, join(dir, "other"))).toBe(false);
  });
});

describe("skillCopyProblems", () => {
  function setup(record: Record<string, unknown>) {
    const repo = join(dir, "repo");
    const state = join(dir, "state");
    const user = join(state, "skills");
    const copies = join(dir, "claude-skills");
    put("repo/skills/base/SKILL.md", skill("base"));
    put("state/skills/mine/SKILL.md", skill("mine"));
    put("state/skills/wrong/SKILL.md", skill("other-name"));
    put("state/skills/base/SKILL.md", skill("base", "同じ名前の利用者の Skill"));
    put("state/setup.json", JSON.stringify({ skillDirs: { skills: copies }, ...record }));
    return { repo, state, user, copies };
  }

  it("導入が写すのは既定と、名前の合う利用者の Skill（既定と同じ名前は写さない）", () => {
    const { repo, user } = setup({});
    expect([...sourceSkills(repo, user).keys()].sort()).toEqual(["base", "mine"]);
  });

  it("写しが元と同じなら何も言わない。違う・無いものを名前で返す", () => {
    const { repo, state, user, copies } = setup({ installed: { skills: [{ name: "base" }, { name: "mine" }] } });
    put("claude-skills/base/SKILL.md", skill("base").replace(/\n/g, "\r\n"));
    put("claude-skills/mine/SKILL.md", skill("mine"));
    expect(skillCopyProblems({ repoRoot: repo, stateDir: state, userSkillsDir: user })).toEqual([]);

    writeFileSync(join(copies, "base", "SKILL.md"), skill("base", "古い本文"), "utf8");
    rmSync(join(copies, "mine"), { recursive: true });
    expect(skillCopyProblems({ repoRoot: repo, stateDir: state, userSkillsDir: user })).toEqual([
      { label: "Claude Code", dir: copies, changed: ["base"], missing: ["mine"] },
    ]);
  });

  it("写した先は記録（skillDirs）どおりに見る。記録に無い古い導入は Claude Code の場所（CLAUDE_CONFIG_DIR）を見る", () => {
    const { repo, state, user } = setup({});
    const codex = join(dir, "agents-skills");
    writeFileSync(
      join(state, "setup.json"),
      JSON.stringify({ skillDirs: { codexSkills: codex }, installed: { codexSkills: [{ name: "base" }] } }),
      "utf8",
    );
    expect(skillCopyProblems({ repoRoot: repo, stateDir: state, userSkillsDir: user })).toEqual([
      { label: "Codex", dir: codex, changed: [], missing: ["base", "mine"] },
    ]);

    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(dir, "claude-config");
    try {
      writeFileSync(join(state, "setup.json"), JSON.stringify({ installed: { skills: [{ name: "base" }] } }), "utf8");
      expect(skillCopyProblems({ repoRoot: repo, stateDir: state, userSkillsDir: user })).toEqual([
        { label: "Claude Code", dir: join(dir, "claude-config", "skills"), changed: [], missing: ["base", "mine"] },
      ]);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
  });

  it("導入の記録が無い・その先に写していないなら見ない", () => {
    const { repo, state, user } = setup({ installed: { skills: [] } });
    expect(skillCopyProblems({ repoRoot: repo, stateDir: state, userSkillsDir: user })).toEqual([]);
    rmSync(join(state, "setup.json"));
    expect(skillCopyProblems({ repoRoot: repo, stateDir: state, userSkillsDir: user })).toEqual([]);
  });
});

describe("updateNotices", () => {
  const base: UpdateState = { selfStale: false, isPrimary: false, primaryStale: false, staleBuild: [], skillCopies: [] };

  it("古いものが無ければ知らせない", () => {
    expect(updateNotices(base)).toEqual([]);
    expect(updatesText([])).toBeNull();
  });

  it("primary なら自分の古さを 1 つだけ言う（中継も含めて）", () => {
    const notices = updateNotices({ ...base, selfStale: true, isPrimary: true, primaryStale: true });
    expect(notices.map((n) => n.kind)).toEqual(["mcp_code"]);
    expect(notices[0]?.message).toMatch(/中継/);
  });

  it("client なら自分と primary を分けて言い、ビルドと Skill の写しも直し方と一緒に出す", () => {
    const notices = updateNotices({
      ...base,
      selfStale: true,
      primaryStale: true,
      staleBuild: ["src/app"],
      skillCopies: [{ label: "Antigravity", dir: "D:\\g\\skills", changed: ["a"], missing: ["b"] }],
    });
    expect(notices.map((n) => n.kind)).toEqual(["mcp_code", "bridge_code", "app_build", "skill_copies"]);
    expect(notices[3]?.message).toMatch(/中身が元と違う: a／まだ配っていない: b/);
    for (const n of notices) expect(n.action).not.toBe("");
    expect(updatesText(notices)).toMatch(/^【mxstudio の更新】/);
  });

  it("checkUpdates: primary には primary の古さを聞かない。調べる途中の失敗では止まらない", async () => {
    put("src/bridge/a.ts", "1");
    const self = new CodeFingerprint(dir);
    let asked = false;
    const notices = await checkUpdates({
      repoRoot: dir,
      stateDir: join(dir, "no-state"),
      userSkillsDir: null,
      self,
      checkBuild: false,
      isPrimary: () => true,
      primaryStale: async () => {
        asked = true;
        return true;
      },
    });
    expect(notices).toEqual([]);
    expect(asked).toBe(false);
    const client = await checkUpdates({
      repoRoot: dir,
      stateDir: join(dir, "no-state"),
      userSkillsDir: null,
      self,
      checkBuild: false,
      isPrimary: () => false,
      primaryStale: () => Promise.reject(new Error("届かない")),
    });
    expect(client).toEqual([]);
  });
});

describe("health の stale", () => {
  it("codeStale を渡したときだけ載せ、probeBridgeHealth が読む", async () => {
    let stale = false;
    const bridge = await startTestBridge({ version: "1.2.3", codeStale: () => stale });
    expect(JSON.parse((await rawRequest(bridge, PEER_HEALTH_PATH)).body)).toMatchObject({ stale: false });
    stale = true;
    expect(await probeBridgeHealth(bridge.port)).toMatchObject({ kind: "bridge", health: { stale: true } });

    const plain = await startTestBridge({ version: "1.2.3" });
    expect("stale" in JSON.parse((await rawRequest(plain, PEER_HEALTH_PATH)).body)).toBe(false);
  });
});

describe("MCP の結果に添える", () => {
  const notice: UpdateNotice = { kind: "app_build", message: "作業画面のビルドが古い", action: "導入をもう一度" };

  it("withUpdates: get_status の structuredContent に updates を足し、文も足す。知らせが無ければそのまま", () => {
    const result = { content: [{ type: "text" as const, text: "{}" }], structuredContent: { tabConnected: true } };
    expect(withUpdates(result, [])).toBe(result);
    const out = withUpdates(result, [notice]);
    expect(out.structuredContent).toEqual({ tabConnected: true, updates: [notice] });
    expect(out.content?.[1]).toMatchObject({ type: "text", text: expect.stringMatching(/作業画面のビルドが古い → 導入をもう一度/) });
  });

  /** タブの代わり。get_status にだけ答える */
  const fakeHub: HubRpc = {
    invoke: async (req: HubInvokeRequest): Promise<HubInvokeResponse> => {
      const value = { tabConnected: true, tool: req.tool };
      return { ok: true, revision: 0, result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value } };
    },
    status: async (): Promise<HubStatus> => ({ tabs: [] }) as unknown as HubStatus,
  } as unknown as HubRpc;

  async function connect(checkUpdates: () => Promise<UpdateNotice[]>) {
    const server = buildBridgeMcpServer({
      origin: "http://127.0.0.1:1",
      hub: fakeHub,
      tickets: { create: () => Promise.reject(new Error("使わない")) },
      version: "0.0.0",
      userSkillsDir: null,
      checkUpdates,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    return client;
  }

  const texts = (r: { content?: unknown }) => ((r.content ?? []) as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");

  it("最初の呼び出しと get_status のたびに添える。get_status 以外の structuredContent は変えない", async () => {
    let calls = 0;
    const client = await connect(async () => {
      calls += 1;
      return [notice];
    });
    const first = await client.callTool({ name: "open_grid", arguments: {} });
    expect(texts(first)).toMatch(/【mxstudio の更新】/);
    expect(texts(first)).toMatch(/【mxstudio の基本手順と禁止事項/);
    expect(first.structuredContent).not.toHaveProperty("updates");

    const second = await client.callTool({ name: "open_grid", arguments: {} });
    expect(texts(second)).not.toMatch(/【mxstudio の更新】/);

    const status = await client.callTool({ name: "get_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({ tabConnected: true, updates: [notice] });
    expect(texts(status)).toMatch(/【mxstudio の更新】/);
    expect(calls).toBe(2);
    await client.close();
  });

  it("最初が get_status なら知らせは 1 回だけ。調べるのに失敗しても結果は返す", async () => {
    const client = await connect(() => Promise.reject(new Error("調べられない")));
    const status = await client.callTool({ name: "get_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    expect(status.structuredContent).toEqual({ tabConnected: true, tool: "get_status" });
    expect(texts(status)).not.toMatch(/【mxstudio の更新】/);
    await client.close();

    const once = await connect(async () => [notice]);
    const r = await once.callTool({ name: "get_status", arguments: {} });
    expect(texts(r).match(/【mxstudio の更新】/g)?.length).toBe(1);
    await once.close();
  });
});
