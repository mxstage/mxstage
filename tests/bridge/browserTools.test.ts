// 作業画面は MX Stage の道具で扱い、ブラウザ・画面の操作の道具（Claude in Chrome・computer use など）で開かない・読まない、の決まり。
// 作業画面の守り（guard.ts の forbidden_origin）はそういう道具からの呼び出しを断るので、AI がブラウザに回ると作業が止まる（2026-11-24）。
// AI が受け取る文（サーバの案内・ツールの説明・作業画面を開いたときの文・目次と基本動作の Skill・プラグインの Skill）に決まりがあることを確かめる。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_INSTRUCTIONS, sessionGuide } from "../../src/bridge/mcp.ts";
import { SKILLS } from "../../src/bridge/defaultSkills.ts";
import { MXSTAGE_TOOLS_MISSING, RelayErrorCode, WORK_SCREEN_TOOLS_ONLY, relayErrorMessage, workScreenOpenMessage } from "../../src/shared/protocol.ts";
import type { WorkScreenOpenOutcome } from "../../src/shared/protocol.ts";
import { TOOL_DEFS } from "../../src/shared/toolDefs.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const APP_URL = "http://127.0.0.1:8788";

/** ブラウザ・画面の操作の道具を名指しで断る文か */
function forbidsBrowserTools(text: string, label: string): void {
  expect(text, label).toMatch(/browser or screen control tools/);
  expect(text, label).toContain("Claude in Chrome");
  expect(text, label).toContain("computer use");
}

/** 道具が見えないときにブラウザへ回らず、待って見直すか開き直しを頼む文か */
function handlesMissingTools(text: string, label: string): void {
  expect(text, label).toMatch(/not visible/);
  expect(text, label).toMatch(/tool list again/);
  expect(text, label).toMatch(/ask (the user )?in one line to restart Claude/);
}

function skillBody(name: string): string {
  const body = SKILLS.find((s) => s.name === name)?.body;
  expect(body, name).toBeDefined();
  return body ?? "";
}

describe("作業画面は MX Stage の道具で扱う（ブラウザの道具を使わない）", () => {
  it("決まりの文は、読む・書く・見せるを道具で行い、断られること、道具を呼べば開くことを言う", () => {
    forbidsBrowserTools(WORK_SCREEN_TOOLS_ONLY, "WORK_SCREEN_TOOLS_ONLY");
    expect(WORK_SCREEN_TOOLS_ONLY).toMatch(/Read, change and show the work screen only with the MX Stage tools/);
    expect(WORK_SCREEN_TOOLS_ONLY).toMatch(/open, click or read/);
    expect(WORK_SCREEN_TOOLS_ONLY).toMatch(/refuses/);
    expect(WORK_SCREEN_TOOLS_ONLY).toMatch(/call an MX Stage tool and MX Stage opens it/);
    handlesMissingTools(MXSTAGE_TOOLS_MISSING, "MXSTAGE_TOOLS_MISSING");
    expect(MXSTAGE_TOOLS_MISSING).toMatch(/do not turn to a browser/);
  });

  it("サーバの案内（initialize の instructions）に両方の決まりがある", () => {
    expect(SERVER_INSTRUCTIONS).toContain(WORK_SCREEN_TOOLS_ONLY);
    expect(SERVER_INSTRUCTIONS).toContain(MXSTAGE_TOOLS_MISSING);
  });

  it("作業画面に触れるツール（get_status・open_grid）の説明が、ブラウザの道具を断る", () => {
    for (const name of ["get_status", "open_grid"] as const) {
      const d = TOOL_DEFS[name].description;
      forbidsBrowserTools(d, name);
      expect(d, name).toMatch(/refuses/);
    }
  });

  it("作業画面を開いた・開けなかったときの文と NO_TAB の文が、ブラウザの道具で開かないよう言う（URL の案内は残す）", () => {
    const outcomes: WorkScreenOpenOutcome[] = ["opened", "waiting", "failed", "gave_up", "off"];
    for (const o of outcomes) expect(workScreenOpenMessage(o, APP_URL), o).toMatch(/browser or screen control tools/);
    const noTab = relayErrorMessage(RelayErrorCode.NO_TAB, APP_URL);
    expect(noTab).toMatch(/browser or screen control tools/);
    expect(noTab).toContain(`open ${APP_URL}/app`);
  });

  it("目次の Skill（どのクライアントにも最初の結果で届く）の決まりにある", () => {
    const body = skillBody("mxstage-workbench");
    const rules = body.slice(body.indexOf("## Rules"), body.indexOf("## Updating MX Stage"));
    forbidsBrowserTools(rules, "mxstage-workbench の Rules");
    expect(rules).toMatch(/MX Stage tools only/);
    expect(rules).toMatch(/refuses them/);
    expect(rules).toMatch(/A tool call opens it/);
    expect(rules).toMatch(/No MX Stage tools \(after a restart\)\?/);
    expect(rules).toMatch(/recheck the tool list/);
    expect(rules).toMatch(/ask in one line to restart Claude; no browser/);
    // 最初のツール呼び出しに添える案内にも、そのまま入る
    expect(sessionGuide(null)).toContain(rules.trim());
  });

  it("作業画面と読み込みの基本動作の Skill も、ブラウザの道具で開かない・読まないと言う", () => {
    forbidsBrowserTools(skillBody("mxstage-core-screen"), "mxstage-core-screen");
    expect(skillBody("mxstage-core-load")).toMatch(/browser or screen control tools/);
  });

  it("プラグインの Skill（mxstage）は、道具があるときの決まりと、道具が見えないときにブラウザに回らないことを言う", () => {
    const text = readFileSync(join(ROOT, "plugin", "skills", "mxstage", "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    forbidsBrowserTools(text, "plugin/skills/mxstage");
    expect(text).toMatch(/call an MX Stage tool and MX Stage opens it/);
    const trouble = text.slice(text.indexOf("**No MX Stage tools in the chat**"));
    expect(trouble).toMatch(/do not turn to a browser/);
    expect(trouble).toMatch(/tool list again/);
    expect(trouble).toMatch(/ask the user in one line to restart Claude/);
  });
});
