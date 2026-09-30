// アプリ既定の Skill（リポジトリの skills/<name>/SKILL.md）を検証し、src/bridge/defaultSkills.ts を生成する。
// 生成物は橋渡しの list_skills / get_skill が同梱する。Claude Code へは導入（scripts/setup-local.mjs）が
// skills/ からそのまま ~/.claude/skills へ写す。
// 利用者の Skill（~/.config/mxstage/skills/）はここでは扱わない（橋渡しが読むたびに同じ規則で検証する）。
// 実行: node --experimental-strip-types scripts/build-skills.ts [--check]
//   --check: 検証と generated.ts が最新かの確認だけを行い、ファイルを書かない。
// Node 標準モジュールだけを使う。検証に失敗したら終了コード 1。
// 検証・生成の関数は tests/app/skills-build.test.ts が import して試験する（import しただけでは何も書き込まない）。

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { byteLength, normalizeText, SKILL_FILE, validateSkill, type KnownNames, type SkillSource } from "../src/shared/skillFile.ts";

export {
  BODY_MAX_BYTES,
  DESCRIPTION_MAX_CHARS,
  normalizeText,
  validateSkill,
  type KnownNames,
  type SkillSource,
} from "../src/shared/skillFile.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(ROOT, "skills");
export const TOOL_DEFS_FILE = join(ROOT, "src", "shared", "toolDefs.ts");
export const MODEL_FILE = join(ROOT, "src", "shared", "model.ts");
export const GENERATED_FILE = join(ROOT, "src", "bridge", "defaultSkills.ts");

/** 先頭に並べる Skill（利用者の Skill が前提にする基本手順） */
export const PRIMARY_SKILL = "mxstage-workbench";

/** toolDefs.ts の TOOL_DEFS からツール名を読み取る（import せず正規表現で読む） */
export function readToolNames(source: string, errors: string[]): Set<string> {
  const text = normalizeText(source);
  const start = text.indexOf("export const TOOL_DEFS = {");
  const end = start < 0 ? -1 : text.indexOf("} as const;", start);
  if (start < 0 || end < 0) {
    errors.push("toolDefs.ts に export const TOOL_DEFS = { ... } as const; が見つからない");
    return new Set();
  }
  const block = text.slice(start, end);
  const keys = new Set([...block.matchAll(/^ {2}([a-z][a-z0-9_]*): tool\(\{/gm)].map((m) => m[1] ?? ""));
  const names = new Set([...block.matchAll(/^ {4}name: "([a-z][a-z0-9_]*)",$/gm)].map((m) => m[1] ?? ""));
  if (keys.size === 0) errors.push("toolDefs.ts からツール名を読み取れない（書式が変わった可能性がある）");
  for (const key of keys) if (!names.has(key)) errors.push(`toolDefs.ts: ${key} の name がキーと一致しない`);
  for (const name of names) if (!keys.has(name)) errors.push(`toolDefs.ts: name "${name}" に対応するキーが無い`);
  return keys;
}

/** model.ts の ConflictInfo.reason の文字列リテラルを読み取る（import せず正規表現で読む） */
export function readConflictReasons(source: string, errors: string[]): Set<string> {
  const text = normalizeText(source);
  const block = /^export interface ConflictInfo \{\n([\s\S]*?)\n\}/m.exec(text)?.[1];
  const union = block === undefined ? undefined : /^\s*reason:\s*([^;]+);/m.exec(block)?.[1];
  if (union === undefined) {
    errors.push("model.ts に ConflictInfo の reason が見つからない（書式が変わった可能性がある）");
    return new Set();
  }
  const reasons = new Set([...union.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1] ?? ""));
  if (reasons.size === 0) errors.push("model.ts の ConflictInfo.reason から値を読み取れない");
  return reasons;
}

export function renderGenerated(skills: readonly SkillSource[], conflictReasons: readonly string[]): string {
  const lines = [
    "// アプリ既定の Skill。scripts/build-skills.ts が skills/*/SKILL.md から生成する。手で編集しない。",
    "export interface BundledSkill {",
    "  name: string;",
    "  description: string;",
    "  version: string;",
    "  /** frontmatter を除いた SKILL.md の本文 */",
    "  body: string;",
    "}",
    "",
  ];
  if (skills.length === 0) {
    lines.push("export const SKILLS: readonly BundledSkill[] = [];");
  } else {
    lines.push("export const SKILLS: readonly BundledSkill[] = [");
    for (const skill of skills) {
      lines.push(
        "  {",
        `    name: ${JSON.stringify(skill.name)},`,
        `    description: ${JSON.stringify(skill.description)},`,
        `    version: ${JSON.stringify(skill.version)},`,
        `    body: ${JSON.stringify(skill.body)},`,
        "  },",
      );
    }
    lines.push("];");
  }
  lines.push(
    "",
    "/** Skill の本文に書いてよい ConflictInfo.reason（src/shared/model.ts から読む）。利用者の Skill の検証に使う */",
    `export const CONFLICT_REASONS: readonly string[] = ${JSON.stringify([...conflictReasons].sort())};`,
  );
  return `${lines.join("\n")}\n`;
}

/** 基本手順を先頭に、残りを名前順に並べる */
function orderSkills(skills: readonly SkillSource[]): SkillSource[] {
  return [...skills].sort((a, b) => {
    if (a.name === PRIMARY_SKILL) return -1;
    if (b.name === PRIMARY_SKILL) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

export interface CollectResult {
  /** 検証を通った Skill（基本手順を先頭に並べたもの） */
  skills: SkillSource[];
  /** 見つかった問題（"ファイル: 内容" の形）。1 件でもあれば出力しない */
  problems: string[];
  /** model.ts から読んだ ConflictInfo.reason */
  conflictReasons: string[];
}

/** skills/ を読み、すべての SKILL.md を検証する。ファイルは書かない */
export function collectSkills(): CollectResult {
  const problems: string[] = [];

  const toolErrors: string[] = [];
  const tools = readToolNames(readFileSync(TOOL_DEFS_FILE, "utf8"), toolErrors);
  problems.push(...toolErrors.map((e) => `src/shared/toolDefs.ts: ${e}`));
  const modelErrors: string[] = [];
  const conflictReasons = readConflictReasons(readFileSync(MODEL_FILE, "utf8"), modelErrors);
  problems.push(...modelErrors.map((e) => `src/shared/model.ts: ${e}`));
  const known: KnownNames = { tools, conflictReasons };

  const entries = existsSync(SKILLS_DIR) ? readdirSync(SKILLS_DIR, { withFileTypes: true }) : [];
  for (const entry of entries) {
    if (!entry.isDirectory()) problems.push(`skills/${entry.name}: skills/ 直下にはフォルダだけを置く`);
  }
  const dirNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (dirNames.length === 0) problems.push("skills/: Skill が 1 つも無い");

  const skills: SkillSource[] = [];
  for (const dirName of dirNames) {
    const label = `skills/${dirName}/${SKILL_FILE}`;
    const dir = join(SKILLS_DIR, dirName);
    const extra = readdirSync(dir).filter((file) => file !== SKILL_FILE);
    if (extra.length > 0) problems.push(`skills/${dirName}: ${SKILL_FILE} 以外のファイルは配布されない（${extra.join(", ")}）`);
    const file = join(dir, SKILL_FILE);
    if (!existsSync(file) || !statSync(file).isFile()) {
      problems.push(`${label}: ファイルが無い`);
      continue;
    }
    const errors: string[] = [];
    const skill = validateSkill(dirName, readFileSync(file, "utf8"), known, errors);
    problems.push(...errors.map((e) => `${label}: ${e}`));
    if (skill && errors.length === 0) skills.push(skill);
  }
  if (dirNames.length > 0 && !dirNames.includes(PRIMARY_SKILL)) problems.push(`skills/: 基本手順の ${PRIMARY_SKILL} が無い`);

  return { skills: orderSkills(skills), problems, conflictReasons: [...conflictReasons] };
}

function main(): number {
  const checkOnly = process.argv.includes("--check");
  const { skills, problems, conflictReasons } = collectSkills();

  if (problems.length > 0) {
    console.error(`Skill の検証に失敗しました（${problems.length} 件）`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  const generated = renderGenerated(skills, conflictReasons);
  const current = existsSync(GENERATED_FILE) ? normalizeText(readFileSync(GENERATED_FILE, "utf8")) : "";

  if (checkOnly) {
    if (current !== generated) {
      console.error("src/bridge/defaultSkills.ts が skills/ と一致しません。npm run build:skills を実行してください。");
      return 1;
    }
    console.log(`Skill ${skills.length} 件を検証しました（defaultSkills.ts は最新）`);
    return 0;
  }

  if (current !== generated) writeFileSync(GENERATED_FILE, generated, "utf8");
  for (const skill of skills) {
    console.log(`  ${skill.name} ${skill.version}（本文 ${byteLength(skill.body)} バイト）`);
  }
  console.log(`アプリ既定の Skill ${skills.length} 件を src/bridge/defaultSkills.ts に出力しました`);
  return 0;
}

/** node で直接実行されたときだけ true（試験から import したときは main を動かさない） */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  const target = resolve(entry);
  return process.platform === "win32" ? self.toLowerCase() === target.toLowerCase() : self === target;
}

if (isDirectRun()) process.exitCode = main();
