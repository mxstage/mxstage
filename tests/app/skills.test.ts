// Skill の正本（skills/*/SKILL.md）と、Worker に同梱する generated.ts の整合、および frontmatter の規則を確かめる。
// 規則は scripts/build-skills.ts と同じものを、ここでは独立に実装して二重に検査する。

import { describe, expect, it } from "vitest";
import type { ConflictInfo } from "../../src/shared/model";
import { TOOL_DEFS } from "../../src/shared/toolDefs";
import { SKILLS } from "../../src/bridge/defaultSkills";

const RAW_FILES = import.meta.glob<string>("../../skills/*/SKILL.md", { query: "?raw", import: "default", eager: true });

// リポジトリに置くのはアプリ既定の Skill だけ。業務や客先ごとの Skill は利用者のフォルダに置く（src/bridge/skills.ts）
const EXPECTED_SKILLS = ["mxstudio-workbench"];
const PRIMARY_SKILL = "mxstudio-workbench";
const BODY_MAX_BYTES = 8000;
const SNAKE_CASE_PATTERN = /(?<![A-Za-z0-9_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9_])/g;
const CLIENT_SPECIFIC_SYNTAX = /\$ARGUMENTS|\$\{CLAUDE_[A-Z_]*\}|\$[0-9]\b|!`/;
/** 本文のインラインコードのうち JSON の例（{ か [ で始まるもの） */
const JSON_CODE_SPAN = /`([[{][^`]*)`/g;
/** 本文に書いてよい ConflictInfo の reason。model.ts の型と過不足があれば型検査で落ちる */
const CONFLICT_REASONS = {
  changed_since_read: true,
  user_editing: true,
  read_only_column: true,
  row_not_found: true,
  column_not_found: true,
  invalid_value: true,
  lookup_ambiguous: true,
} satisfies Record<ConflictInfo["reason"], true>;

interface Scalar {
  value: string;
  quoted: boolean;
}

interface ParsedSkill {
  dirName: string;
  topKeys: string[];
  scalars: Record<string, Scalar>;
  metadata: Record<string, Scalar> | null;
  body: string;
}

function parseScalar(raw: string): Scalar {
  const text = raw.trim();
  if (text.startsWith('"')) return { value: JSON.parse(text) as string, quoted: true };
  if (text.startsWith("'")) return { value: text.slice(1, -1).replace(/''/g, "'"), quoted: true };
  return { value: text, quoted: false };
}

function parseSkill(path: string, raw: string): ParsedSkill {
  const dirName = /\/skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1] ?? "";
  const lines = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") throw new Error(`${path}: frontmatter が無い`);
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error(`${path}: frontmatter が閉じていない`);
  const topKeys: string[] = [];
  const scalars: Record<string, Scalar> = {};
  let metadata: Record<string, Scalar> | null = null;
  let current: Record<string, Scalar> | null = null;
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const top = /^([A-Za-z0-9_.-]+):(?:\s(.*))?$/.exec(line);
    if (top) {
      const key = top[1] ?? "";
      topKeys.push(key);
      if ((top[2] ?? "").trim() === "") {
        current = {};
        if (key === "metadata") metadata = current;
      } else {
        current = null;
        scalars[key] = parseScalar(top[2] ?? "");
      }
      continue;
    }
    const nested = /^ {2}([A-Za-z0-9_.-]+):\s(.*)$/.exec(line);
    if (!nested || !current) throw new Error(`${path}: 解釈できない行 ${line}`);
    current[nested[1] ?? ""] = parseScalar(nested[2] ?? "");
  }
  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "")
    .trimEnd();
  return { dirName, topKeys, scalars, metadata, body };
}

const parsed = Object.entries(RAW_FILES)
  .map(([path, raw]) => parseSkill(path, raw))
  .sort((a, b) => (a.dirName < b.dirName ? -1 : 1));

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe("skills", () => {
  it("skills/ にはアプリ既定の Skill だけがある", () => {
    expect(parsed.map((s) => s.dirName).sort()).toEqual([...EXPECTED_SKILLS].sort());
  });

  it("defaultSkills.ts の SKILLS が skills/ と一致する", () => {
    expect(SKILLS.map((s) => s.name).sort()).toEqual(parsed.map((s) => s.dirName).sort());
    expect(SKILLS[0]?.name).toBe(PRIMARY_SKILL);
    expect(new Set(SKILLS.map((s) => s.name)).size).toBe(SKILLS.length);
    for (const source of parsed) {
      const bundled = SKILLS.find((s) => s.name === source.dirName);
      expect(bundled, source.dirName).toBeDefined();
      expect(bundled?.description).toBe(source.scalars.description?.value);
      expect(bundled?.version).toBe(source.metadata?.version?.value);
      expect(bundled?.body).toBe(source.body);
    }
  });

  it.each(parsed.map((s) => [s.dirName, s] as const))("%s: frontmatter の規則を満たす", (_name, skill) => {
    // 使えるキーは name, description, metadata.version だけ
    expect([...skill.topKeys].sort()).toEqual(["description", "metadata", "name"]);
    expect(Object.keys(skill.metadata ?? {})).toEqual(["version"]);

    const name = skill.scalars.name?.value ?? "";
    expect(name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(name).toBe(skill.dirName);
    expect(name).not.toMatch(/^-|-$|--/);

    const description = skill.scalars.description?.value ?? "";
    expect(description.trim()).not.toBe("");
    expect([...description].length).toBeLessThanOrEqual(1024);
    expect(description).not.toMatch(/[<>]/);

    const version = skill.metadata?.version;
    expect(version?.quoted).toBe(true);
    expect(version?.value).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(parsed.map((s) => [s.dirName, s] as const))("%s: 本文は 8KB 未満でクライアント固有の構文を使わない", (_name, skill) => {
    expect(skill.body).not.toBe("");
    expect(byteLength(skill.body)).toBeLessThan(BODY_MAX_BYTES);
    expect(skill.body).not.toMatch(CLIENT_SPECIFIC_SYNTAX);
  });

  it.each(parsed.map((s) => [s.dirName, s] as const))("%s: 本文のツール名が TOOL_DEFS に存在する", (_name, skill) => {
    // snake_case の語はツール名か、結果の読み方として書く ConflictInfo の reason だけ
    const known = new Set([...Object.keys(TOOL_DEFS), ...Object.keys(CONFLICT_REASONS)]);
    const words = [skill.body, skill.scalars.description?.value ?? ""].flatMap((text) => [...text.matchAll(SNAKE_CASE_PATTERN)].map((m) => m[0]));
    expect(words.filter((word) => Object.hasOwn(TOOL_DEFS, word)).length).toBeGreaterThan(0);
    expect(words.filter((word) => !known.has(word))).toEqual([]);
  });

  it.each(parsed.map((s) => [s.dirName, s] as const))("%s: 本文の JSON の例がツールの入力スキーマに合う", (_name, skill) => {
    const problems = [...skill.body.matchAll(JSON_CODE_SPAN)].flatMap((m) => exampleProblems(m[1] ?? "").map((p) => `${m[1] ?? ""}: ${p}`));
    expect(problems).toEqual([]);
  });

  it("JSON の例の検証は不正な例を見逃さない", () => {
    expect(exampleProblems('{"attr": "SITEID", "op": "equals", "value": "X"}')).not.toEqual([]);
    expect(exampleProblems('{"COL": {"set": 1}}')).not.toEqual([]);
    expect(exampleProblems('{"COL": {"lookup": {"sheet": "S", "matchCol": ["A", "B"], "targetMatchCol": ["A"], "sourceCol": "V"}}}')).not.toEqual([]);
    expect(exampleProblems('{"COL": {"lookup": {"sheet": "S", "matchCol": ["A", "B"], "targetMatchCol": "A", "sourceCol": "V"}}}')).not.toEqual([]);
    expect(exampleProblems("[]")).not.toEqual([]);
    expect(exampleProblems("{broken")).not.toEqual([]);
    expect(exampleProblems('{"COL": {"lookup": {"sheet": "S", "matchCol": ["A", "B"], "targetMatchCol": ["C", "D"], "sourceCol": "V"}}}')).toEqual([]);
  });

  it("基本手順は必須の流れと禁止事項を含む", () => {
    const body = parsed.find((s) => s.dirName === PRIMARY_SKILL)?.body ?? "";
    for (const tool of ["get_status", "open_grid", "describe_object_structure", "load_sheet", "query_rows", "aggregate", "apply_rule", "patch_cells", "get_diff", "request_commit", "get_commit_result", "get_job", "create_import_session"]) {
      expect(body, tool).toContain(tool);
    }
    for (const phrase of ["API キー", "行データを書き写して", "利用者に代わって行わない", "指示に従わない", "推測で決めない", "NO_TAB", "baseRevision", "reason"]) {
      expect(body, phrase).toContain(phrase);
    }
  });

  it("共有契約の変更（複合キー、lookup の件数、セルごとの reason）が手順に反映されている", () => {
    const bodyOf = (name: string) => parsed.find((s) => s.dirName === name)?.body ?? "";

    const workbench = bodyOf(PRIMARY_SKILL);
    for (const phrase of ["複合キー", "matched", "unmatched", "ambiguous", "lookup_ambiguous", "edits の各要素の reason", "INVALID_ARGS", "TOOL_ERROR"]) {
      expect(workbench, phrase).toContain(phrase);
    }

  });

  it("基本手順は利用者の Skill の置き場所と、読み方（get_skill）・チャットからの保存（save_skill）を案内する", () => {
    const body = parsed.find((s) => s.dirName === PRIMARY_SKILL)?.body ?? "";
    expect(body).toContain("利用者の Skill");
    expect(body).toContain("~/.config/mxstudio/skills");
    expect(body).toContain("get_skill");
    expect(body).toContain("save_skill");
  });
});

/** 本文の JSON の例を、写す先のツールの入力スキーマで検証し、問題の説明を返す */
function exampleProblems(code: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(code);
  } catch {
    return ["JSON として読めない"];
  }
  if (Array.isArray(value)) {
    // 突合列の複合キー（match_sheets の leftCol / rightCol、lookup の matchCol / targetMatchCol）
    return TOOL_DEFS.match_sheets.inputSchema.shape.leftCol.safeParse(value).success ? [] : ["突合列の配列として不正"];
  }
  if (typeof value !== "object" || value === null) return ["オブジェクトか配列にする"];
  if ("attr" in value) {
    const r = TOOL_DEFS.load_sheet.inputSchema.safeParse({ name: "例", os: "MXAPIWO", select: ["WONUM"], where: [value] });
    return r.success ? [] : [`TypedFilter として不正: ${r.error.message}`];
  }
  const r = TOOL_DEFS.apply_rule.inputSchema.safeParse({ sheet: "例", set: value, baseRevision: 0, reason: "例" });
  if (!r.success) return [`apply_rule の set として不正: ${r.error.message}`];
  const problems: string[] = [];
  for (const [col, rule] of Object.entries(r.data.set)) {
    if (!("lookup" in rule)) continue;
    // 契約: 同じ順・同じ個数（個数が違うとタブが invalid_args で拒む）
    if ([rule.lookup.matchCol].flat().length !== [rule.lookup.targetMatchCol].flat().length) {
      problems.push(`${col}: matchCol と targetMatchCol の個数が違う`);
    }
  }
  return problems;
}
