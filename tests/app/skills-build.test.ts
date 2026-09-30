// scripts/build-skills.ts を関数単位で試験する。
// skills.test.ts は規則を独立に実装して正本を検査する。こちらはビルドスクリプト自身について次を確かめる。
//   - 不正な SKILL.md を拒むこと（常に通るだけの検証になっていないこと）
//   - toolDefs.ts / model.ts を正規表現で読んだ結果が、実際の定義とずれていないこと
//   - src/bridge/defaultSkills.ts（アプリ既定の Skill）がビルドの出力と 1 文字も違わないこと
//   - scripts/ はどの tsconfig にも含まれないため、Node の型と --experimental-strip-types の制約で型検査が通ること
// build-skills.ts は import しただけではファイルを書かない。
//
// build-skills.ts は Node の型に依存する。app の tsconfig（DOM 用、Node の型なし）に取り込まれないよう、
// 静的 import ではなく tsc が辿らない動的 import で読み、必要な形だけをここで宣言する。
// スクリプト自体の型検査は最後の試験で TypeScript を直接呼んで行う。

import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import type { ConflictInfo } from "../../src/shared/model";
import { TOOL_DEFS } from "../../src/shared/toolDefs";

interface SkillSource {
  name: string;
  description: string;
  version: string;
  body: string;
  text: string;
}

interface KnownNames {
  tools: ReadonlySet<string>;
  conflictReasons: ReadonlySet<string>;
}

/** scripts/build-skills.ts の export のうち試験で使うもの */
interface BuildSkillsModule {
  ROOT: string;
  PRIMARY_SKILL: string;
  validateSkill(dirName: string, rawText: string, known: KnownNames, errors: string[]): SkillSource | null;
  readToolNames(source: string, errors: string[]): Set<string>;
  readConflictReasons(source: string, errors: string[]): Set<string>;
  renderGenerated(skills: readonly SkillSource[], conflictReasons: readonly string[]): string;
  collectSkills(): { skills: SkillSource[]; problems: string[]; conflictReasons: string[] };
  normalizeText(text: string): string;
  DESCRIPTION_MAX_CHARS: number;
}

const BUILD_SCRIPT = "../../scripts/build-skills.ts";

const RAW = import.meta.glob<string>(["../../src/shared/toolDefs.ts", "../../src/shared/model.ts", "../../src/bridge/defaultSkills.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

function raw(path: string): string {
  const text = RAW[path];
  if (text === undefined) throw new Error(`${path} を読めない`);
  return text;
}

/** model.ts の ConflictInfo.reason と過不足があれば型検査で落ちる */
const CONFLICT_REASONS = {
  changed_since_read: true,
  user_editing: true,
  read_only_column: true,
  row_not_found: true,
  column_not_found: true,
  invalid_value: true,
  lookup_ambiguous: true,
} satisfies Record<ConflictInfo["reason"], true>;

const KNOWN: KnownNames = { tools: new Set(Object.keys(TOOL_DEFS)), conflictReasons: new Set(["lookup_ambiguous"]) };

let build: BuildSkillsModule;

beforeAll(async () => {
  build = (await import(/* @vite-ignore */ BUILD_SCRIPT)) as BuildSkillsModule;
});

interface Parts {
  name?: string;
  description?: string;
  version?: string;
  /** description の後に足す frontmatter の行 */
  extra?: string;
  body?: string;
}

const DEFAULT_BODY = '# 見出し\n\nget_status を呼ぶ。conflicts の lookup_ambiguous を見る。例 `{"attr": "SITEID", "op": "eq", "value": "X"}`';

function skillText(p: Parts = {}): string {
  const lines = ["---", `name: ${p.name ?? "sample-skill"}`, `description: ${p.description ?? '"試験用の Skill。get_status を呼ぶときに使う。"'}`];
  if (p.extra !== undefined) lines.push(p.extra);
  lines.push("metadata:", `  version: ${p.version ?? '"1.0.0"'}`, "---", "", p.body ?? DEFAULT_BODY);
  return lines.join("\n");
}

function errorsOf(text: string, dirName = "sample-skill"): string[] {
  const errors: string[] = [];
  build.validateSkill(dirName, text, KNOWN, errors);
  return errors;
}

function bodyOfBytes(bytes: number): string {
  const head = "# h\n\nget_status\n\n";
  return head + "a".repeat(bytes - new TextEncoder().encode(head).length);
}

describe("build-skills: validateSkill", () => {
  it("正しい SKILL.md は通り、本文と版を取り出す（BOM と CRLF も受け付ける）", () => {
    const errors: string[] = [];
    const skill = build.validateSkill("sample-skill", `﻿${skillText().replace(/\n/g, "\r\n")}`, KNOWN, errors);
    expect(errors).toEqual([]);
    expect(skill?.name).toBe("sample-skill");
    expect(skill?.version).toBe("1.0.0");
    expect(skill?.body).toBe(DEFAULT_BODY);
    expect(skill?.text.startsWith("---\nname: sample-skill\n")).toBe(true);
  });

  it("本文は 7999 バイトまで通り、8000 バイトで落ちる", () => {
    expect(errorsOf(skillText({ body: bodyOfBytes(7999) }))).toEqual([]);
    expect(errorsOf(skillText({ body: bodyOfBytes(8000) })).join("\n")).toMatch(/keep it under 8000/);
  });

  it("description は 200 文字まで通り、201 文字で落ちる（Claude のスキルのアップロードの上限）", () => {
    expect(build.DESCRIPTION_MAX_CHARS).toBe(200);
    expect(errorsOf(skillText({ description: `"${"あ".repeat(200)}"` }))).toEqual([]);
    expect(errorsOf(skillText({ description: `"${"あ".repeat(201)}"` })).join("\n")).toMatch(/keep it within 200/);
  });

  const invalid: Array<{ title: string; text: string; error: RegExp; dirName?: string }> = [
    { title: "frontmatter が無い", text: "# 本文だけ\n\nget_status", error: /no frontmatter/ },
    { title: "frontmatter が閉じていない", text: "---\nname: sample-skill\n\n# 本文", error: /not closed/ },
    { title: "name がフォルダ名と違う", text: skillText(), error: /does not match the folder name/, dirName: "other-skill" },
    { title: "name の書式が違う", text: skillText({ name: "Sample_Skill" }), error: /does not match \^\[a-z0-9-\]/, dirName: "Sample_Skill" },
    { title: "name に連続ハイフン", text: skillText({ name: "sample--skill" }), error: /consecutive hyphens/, dirName: "sample--skill" },
    { title: "name に予約語", text: skillText({ name: "claude-helper" }), error: /reserved word claude/, dirName: "claude-helper" },
    { title: "許可外のキー", text: skillText({ extra: "license: MIT" }), error: /key license is not allowed/ },
    { title: "metadata の許可外のキー", text: skillText({ version: '"1.0.0"\n  author: someone' }), error: /metadata key author/ },
    { title: "版が引用符なし", text: skillText({ version: "1.0.0" }), error: /put metadata\.version in quotes/ },
    { title: "版の書式が違う", text: skillText({ version: '"v1"' }), error: /number\.number\.number/ },
    { title: "版が無い", text: skillText().replace(/metadata:\n {2}version: .*\n/, ""), error: /metadata\.version is missing/ },
    { title: "description が無い", text: skillText().replace(/^description: .*\n/m, ""), error: /description is missing/ },
    { title: "description が YAML で真偽値に読まれる", text: skillText({ description: "yes" }), error: /other than a string/ },
    { title: "description に XML タグ", text: skillText({ description: '"<b>強調</b> を使う"' }), error: /< or >/ },
    { title: "キーの重複", text: skillText({ extra: "name: sample-skill" }), error: /duplicate key/ },
    { title: "ブロックスカラー", text: skillText({ description: "|" }), error: /YAML symbols/ },
    { title: "タブ文字", text: skillText({ extra: "\tfoo: bar" }), error: /tab characters/ },
    { title: "本文が空", text: skillText({ body: "" }), error: /body is empty/ },
    { title: "クライアント固有の置換", text: skillText({ body: "# h\n\nget_status に $ARGUMENTS を渡す" }), error: /client-specific/ },
    { title: "TOOL_DEFS に無いツール名", text: skillText({ body: "# h\n\nload_sheets を呼ぶ" }), error: /load_sheets is neither a tool name in TOOL_DEFS/ },
    { title: "知らない reason 名", text: skillText({ body: "# h\n\nget_status の結果の user_editing_now を見る" }), error: /user_editing_now is neither a tool name in TOOL_DEFS/ },
    { title: "JSON の例が壊れている", text: skillText({ body: '# h\n\nget_status。例 `{"attr": "SITEID", "op": }`' }), error: /not valid JSON/ },
  ];

  it.each(invalid)("拒否する: $title", ({ text, error, dirName }) => {
    const errors = errorsOf(text, dirName);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toMatch(error);
  });
});

describe("build-skills: 定義の読み取り", () => {
  it("toolDefs.ts から読んだツール名が TOOL_DEFS のキーと一致する", () => {
    const errors: string[] = [];
    const names = build.readToolNames(raw("../../src/shared/toolDefs.ts"), errors);
    expect(errors).toEqual([]);
    expect([...names].sort()).toEqual(Object.keys(TOOL_DEFS).sort());
  });

  it("model.ts から読んだ ConflictInfo の reason が型と一致する", () => {
    const errors: string[] = [];
    const reasons = build.readConflictReasons(raw("../../src/shared/model.ts"), errors);
    expect(errors).toEqual([]);
    expect([...reasons].sort()).toEqual(Object.keys(CONFLICT_REASONS).sort());
  });

  it("書式が変わって読めないときはエラーにする（空の集合で素通りしない）", () => {
    const toolErrors: string[] = [];
    expect(build.readToolNames("export const OTHER = {};", toolErrors).size).toBe(0);
    expect(toolErrors.length).toBeGreaterThan(0);

    const mismatch: string[] = [];
    build.readToolNames('export const TOOL_DEFS = {\n  get_status: tool({\n    name: "get_state",\n  }),\n} as const;', mismatch);
    expect(mismatch.join("\n")).toMatch(/一致しない/);

    const modelErrors: string[] = [];
    expect(build.readConflictReasons("export interface Other {\n  reason: string;\n}", modelErrors).size).toBe(0);
    expect(modelErrors.length).toBeGreaterThan(0);
  });
});

describe("build-skills: 正本と生成物", () => {
  it("正本の Skill はすべて検証を通り、defaultSkills.ts はビルドの出力と一致する", () => {
    const { skills, problems, conflictReasons } = build.collectSkills();
    expect(problems).toEqual([]);
    expect(skills[0]?.name).toBe(build.PRIMARY_SKILL);
    expect([...conflictReasons].sort()).toEqual(Object.keys(CONFLICT_REASONS).sort());
    expect(build.normalizeText(raw("../../src/bridge/defaultSkills.ts"))).toBe(build.renderGenerated(skills, conflictReasons));
  });

  it("scripts/build-skills.ts は Node の型と strip-types の制約で型検査が通る", () => {
    const script = `${build.ROOT}/scripts/build-skills.ts`;
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ["lib.es2022.d.ts"],
      types: ["node"],
      typeRoots: [`${build.ROOT}/node_modules/@types`],
      strict: true,
      noUncheckedIndexedAccess: true,
      isolatedModules: true,
      verbatimModuleSyntax: true,
      // --experimental-strip-types で動かせない構文（enum、namespace、引数プロパティ）を禁止する
      erasableSyntaxOnly: true,
      // strip-types は拡張子付きの import を解決する（src/shared/skillFile.ts）
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      noEmit: true,
    };
    const program = ts.createProgram({ rootNames: [script], options });
    // 空振り（対象や Node の型を読めていないのに診断が空）を防ぐ
    expect(program.getSourceFiles().some((f) => /build-skills\.ts$/.test(f.fileName))).toBe(true);
    expect(program.getSourceFiles().some((f) => /@types\/node\//.test(f.fileName))).toBe(true);
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => {
      const where = d.file && d.start !== undefined ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}: ` : "";
      return where + ts.flattenDiagnosticMessageText(d.messageText, "\n");
    });
    expect(diagnostics).toEqual([]);
  }, 60_000);
});
