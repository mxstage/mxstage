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
export const ALLOWED_METADATA_KEYS = new Set(["version"]);
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
  if (text === "") return { ok: false, error: "値が空" };
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) return { ok: false, error: "二重引用符が閉じていない" };
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value !== "string") return { ok: false, error: "二重引用符の値を解釈できない" };
      return { ok: true, scalar: { value, quoted: true } };
    } catch {
      return { ok: false, error: '二重引用符の中の書式が不正（エスケープは \\" \\\\ \\n \\uXXXX など JSON と共通のものだけ使える）' };
    }
  }
  if (text.startsWith("'")) {
    const inner = text.slice(1, -1);
    if (text.length < 2 || !text.endsWith("'") || inner.replace(/''/g, "").includes("'")) {
      return { ok: false, error: "単一引用符が閉じていないか、中の ' が '' になっていない" };
    }
    return { ok: true, scalar: { value: inner.replace(/''/g, "'"), quoted: true } };
  }
  if (/^[[\]{}>|*&!%@`#,]/.test(text) || /^[-?:](?:\s|$)/.test(text) || text.includes(": ") || text.includes(" #") || text.endsWith(":")) {
    return { ok: false, error: "YAML の記号を含む値は二重引用符で囲む" };
  }
  return { ok: true, scalar: { value: text, quoted: false } };
}

/** SKILL.md を frontmatter と本文に分ける。使える形は "key: 値" と 2 字下げの "  key: 値" だけ */
function parseSkillFile(text: string, errors: string[]): { frontmatter: Frontmatter; body: string } | null {
  const lines = text.split("\n");
  if (lines[0] !== "---") {
    errors.push("1 行目は --- にする（frontmatter が無い）");
    return null;
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) {
    errors.push("frontmatter が --- で閉じていない");
    return null;
  }
  const frontmatter: Frontmatter = { scalars: new Map(), maps: new Map() };
  let currentMap: Map<string, Scalar> | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    const where = `frontmatter ${i + 1} 行目`;
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (line.includes("\t")) {
      errors.push(`${where}: タブ文字は使えない`);
      continue;
    }
    const top = /^([A-Za-z0-9_.-]+):(?:\s(.*))?$/.exec(line);
    if (top) {
      const key = top[1] ?? "";
      const raw = top[2] ?? "";
      if (frontmatter.scalars.has(key) || frontmatter.maps.has(key)) errors.push(`${where}: キー ${key} が重複している`);
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
      if (currentMap.has(key)) errors.push(`${where}: キー ${key} が重複している`);
      const parsed = parseScalar(nested[2] ?? "");
      if (parsed.ok) currentMap.set(key, parsed.scalar);
      else errors.push(`${where}: ${key}: ${parsed.error}`);
      continue;
    }
    errors.push(`${where}: 解釈できない（使える形は "key: 値" と 2 字下げの "  key: 値" だけ）`);
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
    errors.push(`${key} は YAML で文字列以外に読まれるので引用符で囲む`);
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
    if (!ALLOWED_KEYS.has(key)) errors.push(`frontmatter のキー ${key} は使えない（使えるのは name, description, metadata.version だけ）`);
  }

  const nameScalar = frontmatter.scalars.get("name");
  const name = nameScalar?.value ?? "";
  if (!nameScalar) {
    errors.push(frontmatter.maps.has("name") ? "name は文字列にする" : "name が無い");
  } else {
    requireStringScalar("name", nameScalar, errors);
    if (!NAME_PATTERN.test(name)) errors.push(`name "${name}" は ^[a-z0-9-]{1,64}$ に合わない`);
    if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) errors.push(`name "${name}" の先頭・末尾のハイフンと連続ハイフンは使えない`);
    if (name !== dirName) errors.push(`name "${name}" がフォルダ名 "${dirName}" と一致しない`);
    for (const word of RESERVED_NAME_WORDS) {
      if (name.includes(word)) errors.push(`name に予約語 ${word} を含めない`);
    }
  }

  const descriptionScalar = frontmatter.scalars.get("description");
  const description = descriptionScalar?.value ?? "";
  if (!descriptionScalar) {
    errors.push(frontmatter.maps.has("description") ? "description は文字列にする" : "description が無い");
  } else {
    requireStringScalar("description", descriptionScalar, errors);
    const chars = [...description].length;
    if (description.trim() === "") errors.push("description が空");
    if (chars > DESCRIPTION_MAX_CHARS) errors.push(`description が ${chars} 文字（${DESCRIPTION_MAX_CHARS} 文字以内にする）`);
    if (/[<>]/.test(description)) errors.push("description に < > を含めない（XML タグとみなされる）");
  }

  let version = "";
  if (frontmatter.scalars.has("metadata")) errors.push("metadata は version を持つ map にする");
  const metadata = frontmatter.maps.get("metadata");
  if (!metadata) {
    if (!frontmatter.scalars.has("metadata")) errors.push("metadata.version が無い");
  } else {
    for (const key of metadata.keys()) {
      if (!ALLOWED_METADATA_KEYS.has(key)) errors.push(`metadata のキー ${key} は使えない（使えるのは version だけ）`);
    }
    const versionScalar = metadata.get("version");
    if (!versionScalar) {
      errors.push("metadata.version が無い");
    } else {
      version = versionScalar.value;
      if (!versionScalar.quoted) errors.push('metadata.version は文字列として引用符で囲む（例 "0.1.0"）');
      if (!VERSION_PATTERN.test(version)) errors.push(`metadata.version "${version}" は 数字.数字.数字 の形にする`);
    }
  }

  const bodyBytes = byteLength(body);
  if (body === "") errors.push("本文が空");
  if (bodyBytes >= BODY_MAX_BYTES) errors.push(`本文が ${bodyBytes} バイト（${BODY_MAX_BYTES} バイト未満にする）`);
  if (CLIENT_SPECIFIC_SYNTAX.test(body)) errors.push("本文にクライアント固有の置換・実行構文（$ARGUMENTS、!` など）を使わない");

  const unknownWords = new Set<string>();
  for (const source of [description, body]) {
    for (const match of source.matchAll(SNAKE_CASE_PATTERN)) {
      const word = match[0];
      if (!known.tools.has(word) && !known.conflictReasons.has(word) && !NON_TOOL_SNAKE_CASE.has(word)) unknownWords.add(word);
    }
  }
  for (const word of unknownWords) {
    (options.unknownWords === "warn" ? (options.warnings ?? []) : errors).push(`${word} は TOOL_DEFS のツール名にも ConflictInfo の reason にも無い（綴りを直すか、ツール名でなければ書き方を変える）`);
  }

  for (const match of body.matchAll(JSON_CODE_SPAN)) {
    const code = match[1] ?? "";
    try {
      JSON.parse(code);
    } catch {
      errors.push(`本文の JSON の例が JSON として読めない: ${code.slice(0, 80)}`);
    }
  }

  return { name, description, version, body, text };
}

