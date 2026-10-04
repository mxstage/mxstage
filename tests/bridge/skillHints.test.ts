// 段階に合う既定の Skill の知らせ（src/bridge/skillHints.ts）と、最初の結果に添える目次の一覧（sessionGuide）。

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILLS as DEFAULT_SKILLS } from "../../src/bridge/defaultSkills.ts";
import { nextSkillHints, sessionGuide } from "../../src/bridge/mcp.ts";
import { objectSkillFor, skillHintText, skillsForCall } from "../../src/bridge/skillHints.ts";
import { TOOL_NAMES } from "../../src/shared/toolDefs.ts";

const BUILT_IN = new Set(DEFAULT_SKILLS.map((s) => s.name));

describe("標準オブジェクトの Skill の決め方", () => {
  it.each([
    ["MXAPIASSET", "mxstage-obj-asset"],
    ["MXAPIMETER", "mxstage-obj-asset"],
    ["MXAPIOPERLOC", "mxstage-obj-location"],
    ["MXAPICLASSSTRUCTURE", "mxstage-obj-classification"],
    ["MXAPIASSETATTRIBUTE", "mxstage-obj-classification"],
    ["MXAPIWODETAIL", "mxstage-obj-workorder"],
    ["MXAPIWO", "mxstage-obj-workorder"],
    ["MXAPISR", "mxstage-obj-workorder"],
    ["MXAPIPM", "mxstage-obj-pm-jobplan"],
    ["MXAPIJOBPLAN", "mxstage-obj-pm-jobplan"],
    ["MXAPIITEM", "mxstage-obj-item-inventory"],
    ["MXAPIINVENTORY", "mxstage-obj-item-inventory"],
    ["MXAPIPO", "mxstage-obj-purchasing"],
    ["MXAPIPR", "mxstage-obj-purchasing"],
    ["MXAPIPERSONGROUP", "mxstage-obj-reference"],
    ["MXAPIDOMAIN", "mxstage-obj-reference"],
    ["mxapiasset", "mxstage-obj-asset"],
  ])("%s → %s", (os, skill) => {
    expect(objectSkillFor(os)).toBe(skill);
    expect(BUILT_IN.has(skill)).toBe(true);
  });

  it("当てはまらない構造は null（推測で Skill を割り当てない）", () => {
    expect(objectSkillFor("MXAPIINTOBJECT")).toBeNull();
  });
});

describe("呼び出しごとの Skill", () => {
  it("仕様の子を読むと、読み込み・資産・分類の Skill", () => {
    expect(skillsForCall("load_sheet", { os: "MXAPIASSET", select: ["ASSETNUM", "ASSETSPEC.ASSETATTRID", "ASSETSPEC.NUMVALUE"] })).toEqual([
      "mxstage-core-load",
      "mxstage-obj-asset",
      "mxstage-obj-classification",
    ]);
  });

  it("基本動作の Skill はツールで決まり、名前はすべて同梱の Skill にある", () => {
    expect(skillsForCall("apply_rule", {})).toEqual(["mxstage-core-change"]);
    expect(skillsForCall("describe_import", {})).toEqual(["mxstage-core-import"]);
    expect(skillsForCall("request_commit", {})).toEqual(["mxstage-core-commit"]);
    expect(skillsForCall("get_status", {})).toEqual([]);
    for (const tool of TOOL_NAMES) {
      for (const name of skillsForCall(tool, { os: "MXAPIASSET", select: ["ASSETSPEC.ALNVALUE"] })) expect(BUILT_IN.has(name), `${tool}: ${name}`).toBe(true);
    }
  });

  it("同じ会話で読んだ・知らせた Skill は繰り返さない", () => {
    const hinted = new Set<string>(["mxstage-core-load"]);
    expect(nextSkillHints("scope_options", { os: "MXAPIWODETAIL" }, hinted)).toEqual(["mxstage-obj-workorder"]);
    expect(nextSkillHints("load_sheet", { os: "MXAPIWODETAIL", select: ["WONUM"] }, hinted)).toEqual([]);
    expect(skillHintText([])).toBeNull();
    expect(skillHintText(["mxstage-core-change"])).toContain("get_skill");
  });
});

describe("最初の結果に添える目次", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mxstage-guide-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("目次の本文と、層ごとの既定の Skill、利用者の Skill を並べる", async () => {
    await mkdir(join(dir, "plant-a-spec-fill"), { recursive: true });
    await writeFile(
      join(dir, "plant-a-spec-fill", "SKILL.md"),
      '---\nname: plant-a-spec-fill\ndescription: "Plant A specifications"\nmetadata:\n  version: "0.1.0"\n---\n\nUse get_diff.\n',
    );
    const guide = sessionGuide(dir);
    const index = DEFAULT_SKILLS.find((s) => s.category === "index")!;
    expect(guide).toContain("[MX Stage rules and Skill index (Skill: mxstage-workbench)");
    expect(guide).toContain(index.body);
    const basic = guide.indexOf("### Basic operations");
    const objects = guide.indexOf("### Standard Maximo objects");
    const users = guide.indexOf("## User Skills on this PC");
    expect(basic).toBeGreaterThan(0);
    expect(objects).toBeGreaterThan(basic);
    expect(users).toBeGreaterThan(objects);
    for (const s of DEFAULT_SKILLS.filter((s) => s.category === "core")) {
      const at = guide.indexOf(`- ${s.name}: ${s.description}`);
      expect(at, s.name).toBeGreaterThan(basic);
      expect(at, s.name).toBeLessThan(objects);
    }
    for (const s of DEFAULT_SKILLS.filter((s) => s.category === "object")) {
      const at = guide.indexOf(`- ${s.name}: ${s.description}`);
      expect(at, s.name).toBeGreaterThan(objects);
      expect(at, s.name).toBeLessThan(users);
    }
    expect(guide.indexOf("- plant-a-spec-fill: Plant A specifications")).toBeGreaterThan(users);
  });

  it("利用者の Skill が無ければ作り方の Skill を案内する", () => {
    expect(sessionGuide(dir)).toContain("follow mxstage-core-skills");
  });
});
