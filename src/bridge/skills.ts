// Skill（作業手順書）の一覧。3 か所を分けて持つ。
//   - アプリ既定: リポジトリの skills/ から生成した defaultSkills.ts。アプリと一緒に更新される。利用者は書き換えない。
//   - 接続先の Skill: 接続先の置き場所（既定のフォルダか共有フォルダ）の skills/。客先ごとの手順をメンバーと共有する
//     （src/bridge/sharedSkills.ts）。作業画面が今つないでいる接続先のものだけを AI に渡す。
//   - この PC だけの Skill: ~/.config/mxstage/skills/<name>/SKILL.md。どの接続先の会話でも読む。
//     リポジトリの外なので、アプリを更新しても消えず、公開もされない。読むたびに既定と同じ規則で検証する。
// 同じ名前なら既定を優先し、利用者の方は読み込まずに問題として返す（既定の手順を黙って差し替えないため）。
// 接続先の Skill とこの PC だけの Skill が同じ名前なら、接続先の方を使う（客先の手順を優先する）。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isReservedSkillName, NAME_PATTERN, SKILL_FILE, validateSkill } from "../shared/skillFile.ts";
import type { SkillCategory } from "../shared/skillFile.ts";
import { TOOL_NAMES } from "../shared/toolDefs.ts";
import { CONFLICT_REASONS, SKILLS as DEFAULT_SKILLS } from "./defaultSkills.ts";

/** 利用者の Skill を置くフォルダ名（橋渡しの状態フォルダ ~/.config/mxstage の下） */
export const USER_SKILLS_DIR_NAME = "skills";

export type SkillOrigin = "default" | "user" | "connection";

export interface SkillEntry {
  name: string;
  description: string;
  version: string;
  /** frontmatter を除いた本文 */
  body: string;
  origin: SkillOrigin;
  /** index / core / object (built-in), user */
  category: SkillCategory;
}

export interface SkillProblem {
  /** フォルダ名 */
  name: string;
  /** error: 読み込んでいない / warn: 読み込んだが直した方がよい */
  level: "error" | "warn";
  message: string;
}

export interface SkillCatalog {
  skills: SkillEntry[];
  /** 利用者の Skill の問題（既定の Skill はビルド時に検証済み） */
  problems: SkillProblem[];
  /** 利用者の Skill のフォルダ（無ければ null） */
  userDir: string | null;
  /** 作業画面が今つないでいる接続先（分からなければ null） */
  connection: ConnectionSkills | null;
}

/** 今の接続先の Skill（src/bridge/sharedSkills.ts で読んだもの） */
export interface ConnectionSkills {
  /** 接続先の名前（保存した接続先の名前・デモ・Maximo のホスト名） */
  label: string;
  skills: readonly { name: string; description: string; version: string; body: string }[];
}

export function userSkillsDirOf(stateDir: string): string {
  return join(stateDir, USER_SKILLS_DIR_NAME);
}

/**
 * 既定・今の接続先・この PC だけの Skill を合わせて返す。既定を先に、続けて接続先の Skill、この PC だけの Skill（どちらも名前順）。
 * 接続先の Skill と同じ名前のこの PC だけの Skill は外して、問題（warn）として返す
 */
export function readSkillCatalog(userDir: string | null, connection: ConnectionSkills | null = null): SkillCatalog {
  const pc = readUserSkills(userDir);
  const skills: SkillEntry[] = DEFAULT_SKILLS.map((s) => ({ ...s, origin: "default" as const }));
  const problems = [...pc.problems];
  const connectionNames = new Set<string>();
  for (const s of connection?.skills ?? []) {
    skills.push({ name: s.name, description: s.description, version: s.version, body: s.body, origin: "connection", category: "user" });
    connectionNames.add(s.name);
  }
  for (const s of pc.skills) {
    if (connectionNames.has(s.name)) {
      problems.push({ name: s.name, level: "warn", message: `Not used with ${connection?.label ?? "this connection"}: the connection has a Skill of the same name, which is used instead.` });
      continue;
    }
    skills.push(s);
  }
  return { skills, problems, userDir, connection };
}

/** この PC だけの Skill（~/.config/mxstage/skills） */
function readUserSkills(userDir: string | null): { skills: SkillEntry[]; problems: SkillProblem[] } {
  const skills: SkillEntry[] = [];
  const problems: SkillProblem[] = [];
  if (userDir === null || !existsSync(userDir)) return { skills, problems };

  const defaultNames = new Set(DEFAULT_SKILLS.map((s) => s.name));
  const known = { tools: new Set<string>(TOOL_NAMES), conflictReasons: new Set<string>(CONFLICT_REASONS) };
  let names: string[];
  try {
    names = readdirSync(userDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (e) {
    problems.push({ name: "", level: "error", message: `Could not read the user Skills folder: ${e instanceof Error ? e.message : String(e)}` });
    return { skills, problems };
  }

  for (const name of names) {
    if (!NAME_PATTERN.test(name)) {
      problems.push({ name, level: "error", message: "Use only lowercase letters, digits and hyphens in the folder name (it must equal the Skill name)." });
      continue;
    }
    if (defaultNames.has(name) || isReservedSkillName(name)) {
      problems.push({ name, level: "error", message: "Not loaded because names starting with mxstage are reserved for built-in Skills. Rename the folder and the name (for example <customer>-<task>)." });
      continue;
    }
    const file = join(userDir, name, SKILL_FILE);
    if (!existsSync(file) || !statSync(file).isFile()) {
      problems.push({ name, level: "error", message: `${SKILL_FILE} is missing.` });
      continue;
    }
    const errors: string[] = [];
    const warnings: string[] = [];
    const skill = validateSkill(name, readFileSync(file, "utf8"), known, errors, { unknownWords: "warn", warnings });
    if (skill === null || errors.length > 0) {
      problems.push({ name, level: "error", message: errors.join(" / ") || "Could not be read." });
      continue;
    }
    if (skill.category !== null && skill.category !== "user") {
      warnings.push(`metadata.category "${skill.category}" is only for built-in Skills; this Skill is treated as a user Skill.`);
    }
    for (const w of warnings) problems.push({ name, level: "warn", message: w });
    skills.push({ name: skill.name, description: skill.description, version: skill.version, body: skill.body, origin: "user", category: "user" });
  }
  return { skills, problems };
}

// ---------------------------------------------------------------------------
// 利用者の Skill を保存する（チャットの中で利用者と決めた手順を save_skill で残す）
// ---------------------------------------------------------------------------

export interface SaveSkillInput {
  name: string;
  description: string;
  body: string;
  /** 省くと 0.1.0 */
  version?: string;
  /** 既にある利用者の Skill を書き換える */
  overwrite?: boolean;
}

export type SaveSkillResult =
  | { ok: true; name: string; version: string; path: string; created: boolean; warnings: string[] }
  | { ok: false; message: string; errors?: string[] };

export const DEFAULT_USER_SKILL_VERSION = "0.1.0";

/** SKILL.md の中身を組み立てる（description は 1 行にし、JSON と同じ書き方の二重引用符で囲む） */
export function skillFileText(input: SaveSkillInput): string {
  const description = input.description.replace(/\s+/g, " ").trim();
  const body = input.body.replace(/\r\n?/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
  const version = input.version ?? DEFAULT_USER_SKILL_VERSION;
  return `---\nname: ${input.name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  version: "${version}"\n  category: "user"\n---\n\n${body}\n`;
}

/**
 * 利用者の Skill を ~/.config/mxstage/skills/<name>/SKILL.md に保存する。
 * 読むときと同じ規則で検証し、通らなければ書かない。アプリ既定と同じ名前、無断の上書きはしない。
 * 書き込みは一時ファイルから置き換える（途中で止まっても半端な SKILL.md を残さない）
 */
export function saveUserSkill(userDir: string | null, input: SaveSkillInput): SaveSkillResult {
  if (userDir === null) return { ok: false, message: "The folder for user Skills is not known (the bridge state folder is unknown)." };
  const name = input.name.trim();
  if (!NAME_PATTERN.test(name)) return { ok: false, message: `Use only lowercase letters, digits and hyphens in name "${name}" (e.g. permit-date-update).` };
  if (DEFAULT_SKILLS.some((s) => s.name === name) || isReservedSkillName(name)) {
    return { ok: false, message: "Names starting with mxstage are reserved for built-in Skills. Use another name (for example <customer>-<task>)." };
  }
  const dir = join(userDir, name);
  const file = join(dir, SKILL_FILE);
  const exists = existsSync(file);
  if (exists && input.overwrite !== true) {
    return { ok: false, message: `The user Skill ${name} already exists. To replace it, get the user's agreement and call again with overwrite: true (and raise the version).` };
  }
  const text = skillFileText({ ...input, name });
  const known = { tools: new Set<string>(TOOL_NAMES), conflictReasons: new Set<string>(CONFLICT_REASONS) };
  const errors: string[] = [];
  const warnings: string[] = [];
  const skill = validateSkill(name, text, known, errors, { unknownWords: "warn", warnings });
  if (skill === null || errors.length > 0) return { ok: false, message: "Not saved because the Skill does not follow the format rules.", errors };
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${SKILL_FILE}.${process.pid}.tmp`);
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
  } catch (e) {
    return { ok: false, message: `Could not save: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, name, version: skill.version, path: file, created: !exists, warnings };
}
