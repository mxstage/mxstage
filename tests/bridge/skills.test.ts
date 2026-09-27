// Skill の一覧（src/bridge/skills.ts）。アプリ既定と利用者の Skill を分けて持ち、
// 利用者の Skill は読むたびに既定と同じ規則で検証する。

import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILLS as DEFAULT_SKILLS } from "../../src/bridge/defaultSkills.ts";
import { readSkillCatalog, saveUserSkill, skillFileText, userSkillsDirOf } from "../../src/bridge/skills.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mxs-skills-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function skillText(name: string, opts: { description?: string; version?: string; body?: string } = {}): string {
  return [
    "---",
    `name: ${name}`,
    `description: "${opts.description ?? "業務の手順"}"`,
    "metadata:",
    `  version: "${opts.version ?? "0.1.0"}"`,
    "---",
    "",
    opts.body ?? "# 手順\n\nget_status から始め、get_diff で確かめてから request_commit する。",
    "",
  ].join("\n");
}

async function put(name: string, text: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), text, "utf8");
}

describe("Skill の一覧", () => {
  it("フォルダが無ければアプリ既定だけ（問題にしない）", () => {
    const catalog = readSkillCatalog(join(dir, "none"));
    expect(catalog.skills.map((s) => s.name)).toEqual(DEFAULT_SKILLS.map((s) => s.name));
    expect(catalog.skills.every((s) => s.origin === "default")).toBe(true);
    expect(catalog.problems).toEqual([]);
    expect(readSkillCatalog(null).skills).toHaveLength(DEFAULT_SKILLS.length);
  });

  it("利用者の Skill は既定の後ろに、出どころ user で並ぶ", async () => {
    await put("b-flow", skillText("b-flow"));
    await put("a-flow", skillText("a-flow", { version: "1.2.3" }));
    const catalog = readSkillCatalog(dir);
    expect(catalog.skills.map((s) => [s.name, s.origin])).toEqual([
      ...DEFAULT_SKILLS.map((s) => [s.name, "default"]),
      ["a-flow", "user"],
      ["b-flow", "user"],
    ]);
    expect(catalog.skills.find((s) => s.name === "a-flow")?.version).toBe("1.2.3");
    expect(catalog.skills.find((s) => s.name === "a-flow")?.body).toContain("get_status");
    expect(catalog.userDir).toBe(dir);
  });

  it("既定と同じ名前は読み込まない（既定の手順を黙って差し替えない）", async () => {
    const name = DEFAULT_SKILLS[0]!.name;
    await put(name, skillText(name, { description: "差し替え" }));
    const catalog = readSkillCatalog(dir);
    expect(catalog.skills.filter((s) => s.name === name)).toHaveLength(1);
    expect(catalog.skills.find((s) => s.name === name)?.origin).toBe("default");
    expect(catalog.problems).toEqual([expect.objectContaining({ name, level: "error", message: expect.stringContaining("アプリ既定") })]);
  });

  it("壊れた Skill は読み込まず、理由を返す", async () => {
    await put("no-front", "# frontmatter が無い\n");
    await put("wrong-name", skillText("other-name"));
    await mkdir(join(dir, "empty-dir"), { recursive: true });
    await put("Bad_Name", skillText("Bad_Name"));
    const catalog = readSkillCatalog(dir);
    expect(catalog.skills.every((s) => s.origin === "default")).toBe(true);
    const byName = new Map(catalog.problems.map((p) => [p.name, p]));
    expect(byName.get("no-front")?.level).toBe("error");
    expect(byName.get("wrong-name")?.message).toContain("フォルダ名");
    expect(byName.get("empty-dir")?.message).toContain("SKILL.md");
    expect(byName.get("Bad_Name")?.level).toBe("error");
  });

  it("ツール名にない snake_case 語は注意にとどめ、読み込みは止めない", async () => {
    await put("with-words", skillText("with-words", { body: "# 手順\n\nwork_order_type の値を確かめてから get_diff する。" }));
    const catalog = readSkillCatalog(dir);
    expect(catalog.skills.find((s) => s.name === "with-words")?.origin).toBe("user");
    expect(catalog.problems).toEqual([expect.objectContaining({ name: "with-words", level: "warn", message: expect.stringContaining("work_order_type") })]);
  });

  it("反映できない理由（lookup_ambiguous など）は実在する語として扱い、注意を出さない", async () => {
    await put("with-reason", skillText("with-reason", { body: "# 手順\n\napply_rule の conflicts に lookup_ambiguous が出た行は変えずに利用者へ確認する。" }));
    const catalog = readSkillCatalog(dir);
    expect(catalog.skills.find((s) => s.name === "with-reason")?.origin).toBe("user");
    expect(catalog.problems).toEqual([]);
  });

  it("置き場所は橋渡しの状態フォルダの下の skills", () => {
    expect(userSkillsDirOf(join("home", ".config", "mxstudio"))).toBe(join("home", ".config", "mxstudio", "skills"));
  });
});

describe("利用者の Skill を保存する（save_skill）", () => {
  const input = {
    name: "permit-date-update",
    description: "mxstudio で、作業指示の子の許可申請の完了日を\n一括で変えるときに使う。",
    body: "# 許可申請の完了日\n\n1. get_status から始める。\n2. apply_rule で dryRun してから変え、get_diff で確かめて request_commit する。",
  };

  it("~/.config/mxstudio/skills/<name>/SKILL.md に保存し、読むときと同じ規則で読める", async () => {
    const saved = saveUserSkill(dir, input);
    expect(saved).toMatchObject({ ok: true, name: "permit-date-update", version: "0.1.0", created: true, warnings: [] });
    const text = await readFile(join(dir, "permit-date-update", "SKILL.md"), "utf8");
    // description は 1 行にまとめ、二重引用符で囲む
    expect(text.split("\n").slice(0, 5)).toEqual([
      "---",
      "name: permit-date-update",
      'description: "mxstudio で、作業指示の子の許可申請の完了日を 一括で変えるときに使う。"',
      "metadata:",
      '  version: "0.1.0"',
    ]);
    const catalog = readSkillCatalog(dir);
    expect(catalog.skills.find((s) => s.name === "permit-date-update")).toMatchObject({ origin: "user", version: "0.1.0" });
    expect(catalog.problems).toEqual([]);
    // 一時ファイルを残さない
    expect(await readdir(join(dir, "permit-date-update"))).toEqual(["SKILL.md"]);
  });

  it("既にある Skill は overwrite が無ければ書き換えない。overwrite で版を上げて書き換える", () => {
    expect(saveUserSkill(dir, input).ok).toBe(true);
    const again = saveUserSkill(dir, input);
    expect(again).toMatchObject({ ok: false, message: expect.stringContaining("overwrite: true") });
    const updated = saveUserSkill(dir, { ...input, version: "0.2.0", overwrite: true });
    expect(updated).toMatchObject({ ok: true, created: false, version: "0.2.0" });
  });

  it("アプリ既定と同じ名前・名前の決まりに合わない・書き方の誤り（description の < >）は保存しない", () => {
    const primary = DEFAULT_SKILLS[0]!.name;
    expect(saveUserSkill(dir, { ...input, name: primary })).toMatchObject({ ok: false, message: expect.stringContaining("アプリ既定") });
    expect(saveUserSkill(dir, { ...input, name: "../escape" })).toMatchObject({ ok: false });
    expect(saveUserSkill(dir, { ...input, name: "Permit_Date" })).toMatchObject({ ok: false });
    const bad = saveUserSkill(dir, { ...input, description: "<b>太字</b> の説明" });
    expect(bad).toMatchObject({ ok: false, errors: [expect.stringContaining("< >")] });
    expect(readSkillCatalog(dir).skills.filter((s) => s.origin === "user")).toEqual([]);
  });

  it("ツール名に無い snake_case 語は注意として返し、保存は止めない。置き場所が無ければ保存しない", () => {
    const saved = saveUserSkill(dir, { ...input, body: "# 手順\n\nwork_order_type を確かめてから get_diff する。" });
    expect(saved).toMatchObject({ ok: true, warnings: [expect.stringContaining("work_order_type")] });
    expect(saveUserSkill(null, input)).toMatchObject({ ok: false });
  });

  it("保存する中身は、読んだときに本文が元のとおりになる", () => {
    const text = skillFileText(input);
    expect(text.endsWith("request_commit する。\n")).toBe(true);
    expect(text).toContain("\n---\n\n# 許可申請の完了日\n");
  });
});
