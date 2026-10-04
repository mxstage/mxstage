// SKILL.md の読み取りと検証。アプリ既定の Skill（リポジトリの skills/。scripts/build-skills.ts が検証して同梱する）と、
// 利用者の Skill（~/.config/mxstage/skills/。橋渡しが読むたびに検証する）で同じ規則を使う。
// Node の標準モジュールにも依存しない（ブラウザ・橋渡し・ビルドのどこからでも import できる）。

/** Skill の本文ファイル名 */
export const SKILL_FILE = "SKILL.md";

export const NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
/**
 * description の上限。Agent Skills の仕様は 1024 文字だが、claude.ai の Skill は 200 文字まで。
 * 同じ SKILL.md をどこでも読めるよう、狭い方に合わせる（短い説明の方が、使う場面で選ばれやすい）。
 */
export const DESCRIPTION_MAX_CHARS = 200;
/** 本文は 8KB 未満。8,192 ではなく 8,000 バイトで保守的に判定する */
export const BODY_MAX_BYTES = 8000;
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
export const ALLOWED_KEYS = new Set(["name", "description", "metadata"]);
export const ALLOWED_METADATA_KEYS = new Set(["version", "category"]);
/**
 * Skill の層（metadata.category）。index: 目次（共通の決まりと一覧）/ core: どのオブジェクトにも共通の基本動作 /
 * object: Maximo の標準オブジェクトごとの振る舞い / user: 利用者が客先の環境ごとに作る Skill。
 * 既定の Skill（リポジトリの skills/）は index・core・object のどれかを必ず持つ。利用者の Skill は省くか user
 */
export const SKILL_CATEGORIES = ["index", "core", "object", "user"] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];
/** 既定の Skill の名前の頭。利用者の Skill には使えない（既定の Skill と取り違えないため） */
export const RESERVED_NAME_PREFIX = "mxstage";

/** 既定の Skill のために取ってある名前か（mxstage・mxstage-*） */
export function isReservedSkillName(name: string): boolean {
  return name === RESERVED_NAME_PREFIX || name.startsWith(`${RESERVED_NAME_PREFIX}-`);
}
/** Claude の Skill アップロードで name に使えない語 */
export const RESERVED_NAME_WORDS = ["anthropic", "claude"];
/** ツール名らしき snake_case 名（英小文字と数字を _ でつないだ語） */
export const SNAKE_CASE_PATTERN = /(?<![A-Za-z0-9_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9_])/g;
/** ツール名・ConflictInfo の reason 以外で本文に書いてよい snake_case 名（必要になったら理由を添えて足す） */
export const NON_TOOL_SNAKE_CASE = new Set<string>();
/** クライアント固有の置換・実行構文（Claude の $ARGUMENTS、!`cmd` など）。どのクライアントでも同じ本文にする */
export const CLIENT_SPECIFIC_SYNTAX = /\$ARGUMENTS|\$\{CLAUDE_[A-Z_]*\}|\$[0-9]\b|!`/;
/** 本文のインラインコードのうち JSON の例（{ か [ で始まるもの）。LLM が引数として写すので JSON として読めること */
export const JSON_CODE_SPAN = /`([[{][^`]*)`/g;
/** YAML の単純スカラーとして書くと文字列以外に解釈されうる値 */
export const NON_STRING_PLAIN = /^(?:~|null|true|false|yes|no|on|off|[-+]?(?:\d[\d_]*)?(?:\.\d+)?(?:[eE][-+]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|[-+]?\.inf|\.nan)$/i;


interface Scalar {
  value: string;
  quoted: boolean;
}

interface Frontmatter {
  scalars: Map<string, Scalar>;
  maps: Map<string, Map<string, Scalar>>;
}

export interface SkillSource {
  name: string;
  description: string;
  version: string;
  /** frontmatter を除いた本文 */
  body: string;
  /** metadata.category（無ければ null） */
  category: SkillCategory | null;
  /** 配布用の SKILL.md 全体（BOM を除き、改行を LF にそろえたもの） */
  text: string;
}

/** 本文・description に書いてよい snake_case 名 */
export interface KnownNames {
  /** TOOL_DEFS のツール名 */
  tools: ReadonlySet<string>;
  /** ConflictInfo.reason の値（lookup_ambiguous など。結果の読み方として本文に書く） */
  conflictReasons: ReadonlySet<string>;
}

type ScalarResult = { ok: true; scalar: Scalar } | { ok: false; error: string };

/** BOM を除き、改行を LF にそろえる */
export function normalizeText(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, "\n");
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 1 行に収まる YAML スカラーだけを解釈する（ブロックスカラーや複数行は受け付けない） */
function parseScalar(raw: string): ScalarResult {
  const text = raw.trim();
  if (text === "") return { ok: false, error: "the value is empty" };
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) return { ok: false, error: "the double quote is not closed" };
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== "string") return { ok: false, error: "the double-quoted value cannot be parsed" };
      return { ok: true, scalar: { value, quoted: true } };
    } catch {
      return { ok: false, error: 'invalid text inside double quotes (only the escapes shared with JSON, such as \\" \\\\ \\n \\uXXXX, can be used)' };
    }
  }
  if (text.startsWith("'")) {
    const inner = text.slice(1, -1);
    if (text.length < 2 || !text.endsWith("'") || inner.replace(/''/g, "").includes("'")) {
      return { ok: false, error: "the single quote is not closed, or a ' inside is not written as ''" };
    }
    return { ok: true, scalar: { value: inner.replace(/''/g, "'"), quoted: true } };
  }
  if (/^[[\]{}>|*&!%@`#,]/.test(text) || /^[-?:](?:\s|$)/.test(text) || text.includes(": ") || text.includes(" #") || text.endsWith(":")) {
    return { ok: false, error: "put a value containing YAML symbols in double quotes" };
  }
  return { ok: true, scalar: { value: text, quoted: false } };
}

/** SKILL.md を frontmatter と本文に分ける。使える形は "key: 値" と 2 字下げの "  key: 値" だけ */
function parseSkillFile(text: string, errors: string[]): { frontmatter: Frontmatter; body: string } | null {
  const lines = text.split("\n");
  if (lines[0] !== "---") {
    errors.push("the first line must be --- (no frontmatter)");
    return null;
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) {
    errors.push("the frontmatter is not closed with ---");
    return null;
  }
  const frontmatter: Frontmatter = { scalars: new Map(), maps: new Map() };
  let currentMap: Map<string, Scalar> | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    const where = `frontmatter line ${i + 1}`;
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (line.includes("\t")) {
      errors.push(`${where}: tab characters are not allowed`);
      continue;
    }
    const top = /^([A-Za-z0-9_.-]+):(?:\s(.*))?$/.exec(line);
    if (top) {
      const key = top[1] ?? "";
      const raw = top[2] ?? "";
      if (frontmatter.scalars.has(key) || frontmatter.maps.has(key)) errors.push(`${where}: duplicate key ${key}`);
      if (raw.trim() === "") {
        currentMap = new Map();
        frontmatter.maps.set(key, currentMap);
        continue;
      }
      currentMap = null;
      const parsed = parseScalar(raw);
      if (parsed.ok) frontmatter.scalars.set(key, parsed.scalar);
      else errors.push(`${where}: ${key}: ${parsed.error}`);
      continue;
    }
    const nested = /^ {2}([A-Za-z0-9_.-]+):(?:\s(.*))?$/.exec(line);
    if (nested && currentMap) {
      const key = nested[1] ?? "";
      if (currentMap.has(key)) errors.push(`${where}: duplicate key ${key}`);
      const parsed = parseScalar(nested[2] ?? "");
      if (parsed.ok) currentMap.set(key, parsed.scalar);
      else errors.push(`${where}: ${key}: ${parsed.error}`);
      continue;
    }
    errors.push(`${where}: cannot be parsed (only "key: value" and "  key: value" indented by 2 spaces are allowed)`);
  }
  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "")
    .trimEnd();
  return { frontmatter, body };
}

/** 引用符なしで文字列以外に読まれる値を避けるための検査 */
function requireStringScalar(key: string, scalar: Scalar, errors: string[]): void {
  if (!scalar.quoted && NON_STRING_PLAIN.test(scalar.value)) {
    errors.push(`put ${key} in quotes: YAML would read it as something other than a string`);
  }
}

/**
 * 1 つの SKILL.md を検証する。問題は errors に足し、frontmatter を解釈できなければ null。
 * unknownWords: ツール名にも reason にも無い snake_case 語を、誤り（既定）にするか、注意（warnings）にするか。
 * 利用者の Skill は注意にする（書き手がツール名以外の語を使うことがあり、それで読み込めなくなるのは困るため）。
 */
export function validateSkill(
  dirName: string,
  rawText: string,
  known: KnownNames,
  errors: string[],
  options: { unknownWords?: "error" | "warn"; warnings?: string[] } = {},
): SkillSource | null {
  const text = normalizeText(rawText);
  const parsed = parseSkillFile(text, errors);
  if (!parsed) return null;
  const { frontmatter, body } = parsed;

  for (const key of [...frontmatter.scalars.keys(), ...frontmatter.maps.keys()]) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`the frontmatter key ${key} is not allowed (only name, description, metadata.version and metadata.category)`);
  }

  const nameScalar = frontmatter.scalars.get("name");
  const name = nameScalar?.value ?? "";
  if (!nameScalar) {
    errors.push(frontmatter.maps.has("name") ? "name must be a string" : "name is missing");
  } else {
    requireStringScalar("name", nameScalar, errors);
    if (!NAME_PATTERN.test(name)) errors.push(`name "${name}" does not match ^[a-z0-9-]{1,64}$`);
    if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) errors.push(`name "${name}" must not start or end with a hyphen or contain consecutive hyphens`);
    if (name !== dirName) errors.push(`name "${name}" does not match the folder name "${dirName}"`);
    for (const word of RESERVED_NAME_WORDS) {
      if (name.includes(word)) errors.push(`name must not contain the reserved word ${word}`);
    }
  }

  const descriptionScalar = frontmatter.scalars.get("description");
  const description = descriptionScalar?.value ?? "";
  if (!descriptionScalar) {
    errors.push(frontmatter.maps.has("description") ? "description must be a string" : "description is missing");
  } else {
    requireStringScalar("description", descriptionScalar, errors);
    const chars = [...description].length;
    if (description.trim() === "") errors.push("description is empty");
    if (chars > DESCRIPTION_MAX_CHARS) errors.push(`description has ${chars} characters (keep it within ${DESCRIPTION_MAX_CHARS})`);
    if (/[<>]/.test(description)) errors.push("description must not contain < or > (they are read as XML tags)");
  }

  let version = "";
  let category: SkillCategory | null = null;
  if (frontmatter.scalars.has("metadata")) errors.push("metadata must be a map with version");
  const metadata = frontmatter.maps.get("metadata");
  if (!metadata) {
    if (!frontmatter.scalars.has("metadata")) errors.push("metadata.version is missing");
  } else {
    for (const key of metadata.keys()) {
      if (!ALLOWED_METADATA_KEYS.has(key)) errors.push(`the metadata key ${key} is not allowed (only version and category)`);
    }
    const categoryScalar = metadata.get("category");
    if (categoryScalar) {
      const value = categoryScalar.value;
      if ((SKILL_CATEGORIES as readonly string[]).includes(value)) category = value as SkillCategory;
      else errors.push(`metadata.category "${value}" must be one of ${SKILL_CATEGORIES.join(", ")}`);
    }
    const versionScalar = metadata.get("version");
    if (!versionScalar) {
      errors.push("metadata.version is missing");
    } else {
      version = versionScalar.value;
      if (!versionScalar.quoted) errors.push('put metadata.version in quotes as a string (e.g. "0.1.0")');
      if (!VERSION_PATTERN.test(version)) errors.push(`metadata.version "${version}" must have the form number.number.number`);
    }
  }

  const bodyBytes = byteLength(body);
  if (body === "") errors.push("the body is empty");
  if (bodyBytes >= BODY_MAX_BYTES) errors.push(`the body has ${bodyBytes} bytes (keep it under ${BODY_MAX_BYTES})`);
  if (CLIENT_SPECIFIC_SYNTAX.test(body)) errors.push("do not use client-specific substitution or execution syntax ($ARGUMENTS, !` and so on) in the body");

  const unknownWords = new Set<string>();
  for (const source of [description, body]) {
    for (const match of source.matchAll(SNAKE_CASE_PATTERN)) {
      const word = match[0];
      if (!known.tools.has(word) && !known.conflictReasons.has(word) && !NON_TOOL_SNAKE_CASE.has(word)) unknownWords.add(word);
    }
  }
  for (const word of unknownWords) {
    (options.unknownWords === "warn" ? (options.warnings ?? []) : errors).push(`${word} is neither a tool name in TOOL_DEFS nor a reason in ConflictInfo (fix the spelling, or write it differently if it is not a tool name)`);
  }

  for (const match of body.matchAll(JSON_CODE_SPAN)) {
    const code = match[1] ?? "";
    try {
      JSON.parse(code);
    } catch {
      errors.push(`a JSON example in the body is not valid JSON: ${code.slice(0, 80)}`);
    }
  }

  return { name, description, version, body, category, text };
}

