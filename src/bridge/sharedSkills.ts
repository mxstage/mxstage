// 接続先ごとの Skill（客先の作業の手順）・この PC だけの Skill・AI の案。
// - 接続先の Skill は、辞書と同じ置き場所（既定のフォルダか <共有フォルダ>/MX Stage）の skills/ に置き、メンバーと共有する:
//     skills/<名前>/versions/<時刻>_<メンバーID>.md        保存した版（SKILL.md の全体）
//     skills/<名前>/versions/<時刻>_<メンバーID>.deleted   削除の印（変更履歴から元に戻せる）
//   保存のたびに新しいファイルを足すだけで、同じファイルを 2 人が書かない（OneDrive などの「競合のコピー」を作らない）。
//   今の版は時刻（同じならメンバーID）の一番新しいもの。
// - この PC だけの Skill は、今まで通り状態フォルダの skills/<名前>/SKILL.md（どの接続先の会話でも読む）。
//   保存・削除の前の中身を skill-history/<名前>/ に残し、変更履歴から戻せるようにする。
// - AI の案は状態フォルダの skill-drafts/<接続先>/<名前>.json。人が確かめて保存するまで、メンバーにも AI にも届かない。
// - 読むたびに既定の Skill と同じ規則（src/shared/skillFile.ts）で確かめ、API キーらしいもの（src/shared/secretText.ts）を断る。

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findSecrets, type SecretFinding } from "../shared/secretText.ts";
import { isReservedSkillName, NAME_PATTERN, SKILL_FILE, validateSkill, type SkillSource } from "../shared/skillFile.ts";
import { TOOL_NAMES } from "../shared/toolDefs.ts";
import { CONFLICT_REASONS, SKILLS as DEFAULT_SKILLS } from "./defaultSkills.ts";
import { fallbackLabelOf, scopeKeyOf, type DictionaryStore } from "./dictionaries.ts";
import { DEFAULT_USER_SKILL_VERSION, skillFileText, type ConnectionSkills } from "./skills.ts";

export const SHARED_SKILLS_DIR = "skills";
export const SKILL_DRAFTS_DIR = "skill-drafts";
export const SKILL_HISTORY_DIR = "skill-history";
/** 接続先の無い案（AI の会話に作業画面がつながっていなかった） */
export const PC_DRAFT_SCOPE = "pc";
/** 1 つの版のファイルで読む上限 */
const VERSION_FILE_MAX_BYTES = 64 * 1024;
const VERSION_FILE_RE = /^(\d{8}T\d{9}Z)_(m_[0-9a-f]{16})\.(md|deleted)$/;
/** 変更履歴に返す版の数 */
const HISTORY_LIMIT = 50;

export type SkillPlace = "connection" | "pc";

export interface SkillVersion {
  /** <時刻>_<メンバーID> */
  id: string;
  at: string;
  by: string;
  byId: string;
  deleted: boolean;
  /** SKILL.md の metadata.version（削除の印・読めない版は null） */
  version: string | null;
}

export interface SharedSkillSummary {
  name: string;
  description: string;
  version: string;
  place: SkillPlace;
  /** 今の版（この PC だけの Skill で履歴が無ければ null） */
  versionId: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SharedSkill extends SharedSkillSummary {
  body: string;
  /** SKILL.md の全体 */
  text: string;
}

export interface SkillShelfProblem {
  name: string;
  place: SkillPlace;
  level: "error" | "warn";
  message: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  version: string;
  /** 接続先（PC_DRAFT_SCOPE なら接続先の無い案） */
  scope: string;
  createdAt: string;
  /** 同じ名前の Skill を直す案なら、そのときの版 */
  basedOn: string | null;
}

export interface SkillInput {
  name: string;
  description: string;
  body: string;
  version?: string;
}

export interface SkillCheck {
  errors: string[];
  warnings: string[];
  secrets: SecretFinding[];
  bytes: number;
}

export type SkillSaveResult =
  | { ok: true; skill: SharedSkill; created: boolean; warnings: string[] }
  | { ok: false; code: "invalid" | "secret" | "reserved" | "conflict" | "exists" | "not_found" | "unreachable" | "not_writable"; message: string; check?: SkillCheck; conflict?: SkillVersion };

const KNOWN = { tools: new Set<string>(TOOL_NAMES), conflictReasons: new Set<string>(CONFLICT_REASONS) };
const DEFAULT_NAMES = new Set(DEFAULT_SKILLS.map((s) => s.name));

/** 時刻をファイル名の形（20261018T094012345Z）にする */
function stampOf(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, "");
}

function isoOfStamp(stamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stamp);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z` : stamp;
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function readSmall(file: string): string | null {
  try {
    if (statSync(file).size > VERSION_FILE_MAX_BYTES) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

/** 名前が利用者の Skill に使えるか。使えなければ理由 */
export function skillNameProblem(name: string): string | null {
  if (!NAME_PATTERN.test(name)) return `Use only lowercase letters, digits and hyphens in name "${name}" (e.g. kita-daily-report).`;
  if (DEFAULT_NAMES.has(name) || isReservedSkillName(name)) return "Names starting with mxstage are reserved for built-in Skills. Use another name (for example <customer>-<task>).";
  return null;
}

/** 保存する前に確かめる（形・API キーらしいもの）。errors か secrets があれば保存しない */
export function checkSkill(input: SkillInput): SkillCheck {
  const text = skillFileText({ ...input, name: input.name.trim() });
  const errors: string[] = [];
  const warnings: string[] = [];
  const nameProblem = skillNameProblem(input.name.trim());
  if (nameProblem !== null) errors.push(nameProblem);
  else validateSkill(input.name.trim(), text, KNOWN, errors, { unknownWords: "warn", warnings });
  return { errors, warnings, secrets: findSecrets(`${input.description}\n${input.body}`), bytes: new TextEncoder().encode(input.body).length };
}

interface VersionFile {
  id: string;
  stamp: string;
  byId: string;
  deleted: boolean;
  file: string;
}

export interface SkillShelfOptions {
  store: DictionaryStore;
  /** この PC だけの Skill のフォルダ（~/.config/mxstage/skills）。null ならこの PC だけの Skill は無い */
  userSkillsDir: string | null;
  now?: () => number;
}

export class SkillShelf {
  private readonly store: DictionaryStore;
  private readonly userDir: string | null;
  private readonly now: () => number;

  constructor(opts: SkillShelfOptions) {
    this.store = opts.store;
    this.userDir = opts.userSkillsDir;
    this.now = opts.now ?? Date.now;
  }

  // ---------------------------------------------------------------------------
  // 接続先の Skill
  // ---------------------------------------------------------------------------

  /**
   * 作業画面が送る接続先（保存した接続先の ID・デモの ID・Maximo の URL）の Skill（AI に渡すもの）。
   * 接続先が分からなければ null。共有フォルダに届かなければ、Skill の無い接続先として返す
   */
  connectionSkills(rawScope: string | null): (ConnectionSkills & { scopeKey: string }) | null {
    const scopeKey = scopeKeyOf(rawScope);
    if (scopeKey === null) return null;
    this.store.ensurePlace(scopeKey, fallbackLabelOf(rawScope));
    const label = this.store.labelFor(scopeKey, fallbackLabelOf(rawScope)) ?? scopeKey;
    if (!this.store.folderInfo(scopeKey).reachable) return { scopeKey, label, skills: [] };
    return { scopeKey, label, skills: this.listConnection(scopeKey).skills };
  }

  private skillsDir(scopeKey: string): string {
    return join(this.store.rootOf(scopeKey), SHARED_SKILLS_DIR);
  }

  private versionsOf(scopeKey: string, name: string): VersionFile[] {
    const dir = join(this.skillsDir(scopeKey), name, "versions");
    const out: VersionFile[] = [];
    for (const file of listFiles(dir)) {
      const m = VERSION_FILE_RE.exec(file);
      if (!m) continue;
      out.push({ id: `${m[1]}_${m[2]}`, stamp: m[1]!, byId: m[2]!, deleted: m[3] === "deleted", file: join(dir, file) });
    }
    // 古い順（同じ時刻ならメンバーID の順。どの PC でも同じ並び）
    out.sort((a, b) => a.stamp.localeCompare(b.stamp) || a.byId.localeCompare(b.byId) || (a.deleted ? 1 : 0) - (b.deleted ? 1 : 0));
    return out;
  }

  private readVersion(name: string, v: VersionFile, errors: string[], warnings: string[]): SkillSource | null {
    const text = readSmall(v.file);
    if (text === null) {
      errors.push("The file could not be read (missing, or larger than 64 KB).");
      return null;
    }
    return validateSkill(name, text, KNOWN, errors, { unknownWords: "warn", warnings });
  }

  private summaryOf(scopeKey: string, name: string, source: SkillSource, v: VersionFile, names: ReadonlyMap<string, string>): SharedSkill {
    return {
      name,
      description: source.description,
      version: source.version,
      place: "connection",
      versionId: v.id,
      updatedAt: isoOfStamp(v.stamp),
      updatedBy: names.get(v.byId) ?? v.byId,
      body: source.body,
      text: source.text,
    };
  }

  /** 接続先の Skill（今の版）。消したもの・読めないものは出さず、読めないものは problems に入れる */
  listConnection(scopeKey: string): { skills: SharedSkill[]; deleted: { name: string; at: string; by: string }[]; problems: SkillShelfProblem[] } {
    const dir = this.skillsDir(scopeKey);
    const names = this.store.memberNamesOf(scopeKey);
    const skills: SharedSkill[] = [];
    const deleted: { name: string; at: string; by: string }[] = [];
    const problems: SkillShelfProblem[] = [];
    for (const name of listDirs(dir)) {
      const nameProblem = skillNameProblem(name);
      if (nameProblem !== null) {
        problems.push({ name, place: "connection", level: "error", message: nameProblem });
        continue;
      }
      const versions = this.versionsOf(scopeKey, name);
      const latest = versions[versions.length - 1];
      if (latest === undefined) continue;
      if (latest.deleted) {
        deleted.push({ name, at: isoOfStamp(latest.stamp), by: names.get(latest.byId) ?? latest.byId });
        continue;
      }
      const errors: string[] = [];
      const warnings: string[] = [];
      const source = this.readVersion(name, latest, errors, warnings);
      if (source === null || errors.length > 0) {
        problems.push({ name, place: "connection", level: "error", message: errors.join(" / ") || "Could not be read." });
        continue;
      }
      for (const w of warnings) problems.push({ name, place: "connection", level: "warn", message: w });
      skills.push(this.summaryOf(scopeKey, name, source, latest, names));
    }
    return { skills, deleted, problems };
  }

  getConnection(scopeKey: string, name: string): { skill: SharedSkill | null; history: SkillVersion[]; problem: string | null } {
    if (skillNameProblem(name) !== null) return { skill: null, history: [], problem: "not_found" };
    const versions = this.versionsOf(scopeKey, name);
    const history = this.historyOf(scopeKey, name, versions);
    const latest = versions[versions.length - 1];
    if (latest === undefined || latest.deleted) return { skill: null, history, problem: latest === undefined ? "not_found" : "deleted" };
    const errors: string[] = [];
    const source = this.readVersion(name, latest, errors, []);
    if (source === null || errors.length > 0) return { skill: null, history, problem: errors.join(" / ") || "Could not be read." };
    return { skill: this.summaryOf(scopeKey, name, source, latest, this.store.memberNamesOf(scopeKey)), history, problem: null };
  }

  private historyOf(scopeKey: string, name: string, versions: readonly VersionFile[]): SkillVersion[] {
    const names = this.store.memberNamesOf(scopeKey);
    return versions
      .slice(-HISTORY_LIMIT)
      .reverse()
      .map((v) => {
        let version: string | null = null;
        if (!v.deleted) {
          const m = /^\s*version:\s*"?([0-9.]+)"?\s*$/m.exec(readSmall(v.file) ?? "");
          version = m?.[1] ?? null;
        }
        return { id: v.id, at: isoOfStamp(v.stamp), by: names.get(v.byId) ?? v.byId, byId: v.byId, deleted: v.deleted, version };
      });
  }

  /**
   * 接続先の Skill を保存する（新しい版を足す）。baseVersion は編集を始めたときの版（新しく作るなら null）。
   * その後にほかの人（または別の窓）が保存していれば conflict を返す（force で置き換える。置き換えた版も履歴に残る）
   */
  saveConnection(scopeKey: string, input: SkillInput, opts: { baseVersion?: string | null; force?: boolean } = {}): SkillSaveResult {
    const name = input.name.trim();
    const check = checkSkill({ ...input, name });
    if (check.errors.length > 0) return { ok: false, code: "invalid", message: "The Skill does not follow the format rules.", check };
    if (check.secrets.length > 0) return { ok: false, code: "secret", message: "The Skill seems to contain an API key or a password. Remove it before saving.", check };
    const folder = this.store.folderInfo(scopeKey);
    if (!folder.reachable) return { ok: false, code: "unreachable", message: "The shared folder cannot be reached." };
    if (!folder.writable) return { ok: false, code: "not_writable", message: "MX Stage cannot write to the shared folder (read only)." };
    const versions = this.versionsOf(scopeKey, name);
    const latest = versions[versions.length - 1];
    const live = latest !== undefined && !latest.deleted;
    if (opts.force !== true) {
      if (opts.baseVersion === null || opts.baseVersion === undefined) {
        if (live) return { ok: false, code: "exists", message: `The Skill ${name} already exists in this connection.`, conflict: this.historyOf(scopeKey, name, versions)[0]! };
      } else if (latest !== undefined && latest.id !== opts.baseVersion) {
        return { ok: false, code: "conflict", message: "Someone saved this Skill after you opened it.", conflict: this.historyOf(scopeKey, name, versions)[0]! };
      }
    }
    const text = skillFileText({ ...input, name });
    const member = this.store.member();
    const dir = join(this.skillsDir(scopeKey), name, "versions");
    mkdirSync(dir, { recursive: true });
    const file = this.freeVersionFile(dir, member.id, "md");
    writeAtomic(file, text);
    this.store.touchMemberOf(scopeKey);
    const got = this.getConnection(scopeKey, name);
    if (got.skill === null) return { ok: false, code: "invalid", message: got.problem ?? "Could not be read after saving." };
    return { ok: true, skill: got.skill, created: !live, warnings: check.warnings };
  }

  /** 同じミリ秒に同じ人が 2 回保存しても、別のファイルにする */
  private freeVersionFile(dir: string, memberId: string, ext: "md" | "deleted"): string {
    let ms = this.now();
    for (;;) {
      const file = join(dir, `${stampOf(ms)}_${memberId}.${ext}`);
      if (!existsSync(file)) return file;
      ms += 1;
    }
  }

  /** 接続先の Skill を消す（削除の印を足す。変更履歴から元に戻せる） */
  removeConnection(scopeKey: string, name: string): boolean {
    const versions = this.versionsOf(scopeKey, name);
    const latest = versions[versions.length - 1];
    if (latest === undefined || latest.deleted) return false;
    const dir = join(this.skillsDir(scopeKey), name, "versions");
    writeAtomic(this.freeVersionFile(dir, this.store.member().id, "deleted"), "");
    return true;
  }

  /** 前の版に戻す（その版の中身を新しい版として足す） */
  revertConnection(scopeKey: string, name: string, versionId: string): SkillSaveResult {
    const v = this.versionsOf(scopeKey, name).find((x) => x.id === versionId && !x.deleted);
    if (v === undefined) return { ok: false, code: "not_found", message: "That version was not found." };
    const errors: string[] = [];
    const source = this.readVersion(name, v, errors, []);
    if (source === null || errors.length > 0) return { ok: false, code: "invalid", message: errors.join(" / ") || "That version could not be read." };
    return this.saveConnection(scopeKey, { name, description: source.description, body: source.body, version: source.version }, { force: true });
  }

  // ---------------------------------------------------------------------------
  // この PC だけの Skill
  // ---------------------------------------------------------------------------

  private historyDir(name: string): string {
    return join(this.store.stateFolder, SKILL_HISTORY_DIR, name);
  }

  getPc(name: string): { skill: SharedSkill | null; history: SkillVersion[] } {
    if (this.userDir === null || skillNameProblem(name) !== null) return { skill: null, history: [] };
    const history = this.pcHistory(name);
    const text = readSmall(join(this.userDir, name, SKILL_FILE));
    if (text === null) return { skill: null, history };
    const errors: string[] = [];
    const source = validateSkill(name, text, KNOWN, errors, { unknownWords: "warn", warnings: [] });
    if (source === null || errors.length > 0) return { skill: null, history };
    const latest = history.find((h) => !h.deleted) ?? null;
    return {
      skill: { name, description: source.description, version: source.version, place: "pc", versionId: latest?.id ?? null, updatedAt: latest?.at ?? null, updatedBy: latest?.by ?? null, body: source.body, text: source.text },
      history,
    };
  }

  private pcHistory(name: string): SkillVersion[] {
    const dir = this.historyDir(name);
    const me = this.store.member();
    const out: SkillVersion[] = [];
    for (const file of listFiles(dir)) {
      const m = VERSION_FILE_RE.exec(file);
      if (!m) continue;
      const deleted = m[3] === "deleted";
      const vm = deleted ? null : /^\s*version:\s*"?([0-9.]+)"?\s*$/m.exec(readSmall(join(dir, file)) ?? "");
      out.push({ id: `${m[1]}_${m[2]}`, at: isoOfStamp(m[1]!), by: m[2] === me.id ? me.name : m[2]!, byId: m[2]!, deleted, version: vm?.[1] ?? null });
    }
    out.sort((a, b) => b.id.localeCompare(a.id));
    return out.slice(0, HISTORY_LIMIT);
  }

  /**
   * この PC だけの Skill を保存する。保存した中身を skill-history にも残す（元に戻せるように）。
   * 前からある Skill を履歴の無いまま直すときは、直す前の中身も残す
   */
  savePc(input: SkillInput, opts: { overwrite?: boolean } = {}): SkillSaveResult {
    if (this.userDir === null) return { ok: false, code: "not_writable", message: "The folder for Skills of this PC is not known." };
    const name = input.name.trim();
    const check = checkSkill({ ...input, name });
    if (check.errors.length > 0) return { ok: false, code: "invalid", message: "The Skill does not follow the format rules.", check };
    if (check.secrets.length > 0) return { ok: false, code: "secret", message: "The Skill seems to contain an API key or a password. Remove it before saving.", check };
    const file = join(this.userDir, name, SKILL_FILE);
    const exists = existsSync(file);
    if (exists && opts.overwrite !== true) return { ok: false, code: "exists", message: `The Skill ${name} already exists on this PC.` };
    const member = this.store.member();
    const hist = this.historyDir(name);
    mkdirSync(hist, { recursive: true });
    if (exists && this.pcHistory(name).length === 0) {
      const before = readSmall(file);
      if (before !== null) writeAtomic(this.freeVersionFile(hist, member.id, "md"), before);
    }
    const text = skillFileText({ ...input, name });
    mkdirSync(join(this.userDir, name), { recursive: true });
    writeAtomic(file, text);
    writeAtomic(this.freeVersionFile(hist, member.id, "md"), text);
    const got = this.getPc(name);
    if (got.skill === null) return { ok: false, code: "invalid", message: "Could not be read after saving." };
    return { ok: true, skill: got.skill, created: !exists, warnings: check.warnings };
  }

  /** この PC だけの Skill を消す（フォルダを skill-history へ動かす。変更履歴から元に戻せる） */
  removePc(name: string): boolean {
    if (this.userDir === null || skillNameProblem(name) !== null) return false;
    const dir = join(this.userDir, name);
    const file = join(dir, SKILL_FILE);
    if (!existsSync(file)) return false;
    const member = this.store.member();
    const hist = this.historyDir(name);
    mkdirSync(hist, { recursive: true });
    if (this.pcHistory(name).length === 0) {
      const before = readSmall(file);
      if (before !== null) writeAtomic(this.freeVersionFile(hist, member.id, "md"), before);
    }
    writeAtomic(this.freeVersionFile(hist, member.id, "deleted"), "");
    renameSync(dir, join(hist, `removed-${stampOf(this.now())}`));
    return true;
  }

  revertPc(name: string, versionId: string): SkillSaveResult {
    const m = /^(\d{8}T\d{9}Z)_(m_[0-9a-f]{16})$/.exec(versionId);
    if (!m || skillNameProblem(name) !== null) return { ok: false, code: "not_found", message: "That version was not found." };
    const text = readSmall(join(this.historyDir(name), `${versionId}.md`));
    if (text === null) return { ok: false, code: "not_found", message: "That version was not found." };
    const errors: string[] = [];
    const source = validateSkill(name, text, KNOWN, errors, { unknownWords: "warn", warnings: [] });
    if (source === null || errors.length > 0) return { ok: false, code: "invalid", message: errors.join(" / ") || "That version could not be read." };
    return this.savePc({ name, description: source.description, body: source.body, version: source.version }, { overwrite: true });
  }

  /** この PC だけの Skill を接続先へ移す（接続先に保存してから、この PC の方を消す） */
  movePcToConnection(scopeKey: string, name: string, opts: { force?: boolean } = {}): SkillSaveResult {
    const got = this.getPc(name);
    if (got.skill === null) return { ok: false, code: "not_found", message: `There is no Skill ${name} on this PC.` };
    const saved = this.saveConnection(scopeKey, { name, description: got.skill.description, body: got.skill.body, version: got.skill.version }, { baseVersion: null, ...(opts.force === true ? { force: true } : {}) });
    if (saved.ok) this.removePc(name);
    return saved;
  }

  // ---------------------------------------------------------------------------
  // AI の案
  // ---------------------------------------------------------------------------

  private draftsDir(scope: string): string {
    return join(this.store.stateFolder, SKILL_DRAFTS_DIR, scope);
  }

  /** AI の案を残す（同じ名前の案は置き換える）。形が通らない・API キーらしいものがあれば残さない */
  saveDraft(scope: string, input: SkillInput): { ok: true; draft: SkillDraft; warnings: string[] } | { ok: false; code: "invalid" | "secret"; message: string; check: SkillCheck } {
    const name = input.name.trim();
    const check = checkSkill({ ...input, name });
    if (check.errors.length > 0) return { ok: false, code: "invalid", message: "The Skill does not follow the format rules.", check };
    if (check.secrets.length > 0) return { ok: false, code: "secret", message: "The Skill seems to contain an API key or a password. Remove it and send it again.", check };
    const basedOn = scope === PC_DRAFT_SCOPE ? (this.getPc(name).skill?.versionId ?? null) : (this.getConnection(scope, name).skill?.versionId ?? null);
    const draft: SkillDraft = {
      name,
      description: input.description.replace(/\s+/g, " ").trim(),
      body: input.body,
      version: input.version ?? DEFAULT_USER_SKILL_VERSION,
      scope,
      createdAt: new Date(this.now()).toISOString(),
      basedOn,
    };
    const dir = this.draftsDir(scope);
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, `${name}.json`), `${JSON.stringify(draft, null, 2)}\n`);
    return { ok: true, draft, warnings: check.warnings };
  }

  listDrafts(scope: string): SkillDraft[] {
    const out: SkillDraft[] = [];
    for (const file of listFiles(this.draftsDir(scope))) {
      const m = /^([a-z0-9-]{1,64})\.json$/.exec(file);
      if (!m) continue;
      const d = this.getDraft(scope, m[1]!);
      if (d !== null) out.push(d);
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  getDraft(scope: string, name: string): SkillDraft | null {
    if (!NAME_PATTERN.test(name)) return null;
    const text = readSmall(join(this.draftsDir(scope), `${name}.json`));
    if (text === null) return null;
    try {
      const v = JSON.parse(text) as Partial<SkillDraft>;
      if (v.name !== name || typeof v.description !== "string" || typeof v.body !== "string" || typeof v.createdAt !== "string") return null;
      return { name, description: v.description, body: v.body, version: typeof v.version === "string" ? v.version : DEFAULT_USER_SKILL_VERSION, scope, createdAt: v.createdAt, basedOn: typeof v.basedOn === "string" ? v.basedOn : null };
    } catch {
      return null;
    }
  }

  /** 案を捨てる（状態フォルダの下の skill-drafts/<接続先>/discarded へ動かす） */
  discardDraft(scope: string, name: string): boolean {
    if (!NAME_PATTERN.test(name)) return false;
    const file = join(this.draftsDir(scope), `${name}.json`);
    if (!existsSync(file)) return false;
    const done = join(this.draftsDir(scope), "discarded");
    mkdirSync(done, { recursive: true });
    renameSync(file, join(done, `${name}-${stampOf(this.now())}.json`));
    return true;
  }
}
