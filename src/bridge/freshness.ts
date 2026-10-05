// 更新の知らせ。橋渡しが動いているあいだにリポジトリが更新されても、動いているものは古いまま:
//   - MCP を話す橋渡しは、起動したときのコード（ツールの定義・基本手順の Skill）で動き続ける
//   - ポートを持つ橋渡し（primary）も、起動したときのコードで作業タブへの中継を続ける
//   - 作業画面は dist/app のビルド。元（src/app など）を直しても、ビルドし直すまで変わらない
//   - Claude Code・Antigravity の Skill は、導入（scripts/setup-local.mjs）が配った写し。導入し直すまで変わらない
// どれも MCP のクライアントには知らせが届かない（ツールの一覧の変更通知も出していない）。
// そこで get_status と会話で最初のツール呼び出しの結果に、古くなっているものと直し方を添える（src/bridge/mcp.ts）。
// primary が古いかは /_mxstage/health の stale で知らせ合う（src/bridge/peer.ts）。導入の --status も同じ値を読む。

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { isReservedSkillName, NAME_PATTERN, SKILL_FILE, normalizeText } from "../shared/skillFile.ts";

/** 橋渡しが起動したときに読み込むコード（リポジトリの根からの位置）。ここが変わったら、起動し直すまで古い */
export const BRIDGE_CODE_PATHS: readonly string[] = ["src/bridge", "src/shared", "src/demo", "package.json"];

/**
 * 作業画面と Skill のビルドのもと。どれかが dist/app/index.html より新しければビルドし直しが要る。
 * scripts/setup-local.mjs の BUILD_SOURCES と同じ（試験で揃っていることを確かめる）。
 */
export const BUILD_SOURCES: readonly string[] = ["src/app", "src/shared", "skills", "public", "vite.config.ts", "package-lock.json"];

// ---------------------------------------------------------------------------
// コードの指紋
// ---------------------------------------------------------------------------

/** フォルダの下のファイル（node_modules と . で始まるものは除く）。見つからなければ空 */
function listFiles(target: string): string[] {
  let info;
  try {
    info = statSync(target);
  } catch {
    return [];
  }
  if (!info.isDirectory()) return [target];
  const out: string[] = [];
  for (const name of readdirSync(target)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    out.push(...listFiles(join(target, name)));
  }
  return out;
}

/**
 * 更新時刻の粒度の余裕（ミリ秒）。印を作ったときに、これより新しいファイルがあったら、次は印が同じでも中身を読み直す。
 * 同じ大きさのまま、更新時刻の粒度の中で続けて書き直されると、印が変わらず見逃すため（git の racy clean と同じ考え方）。
 */
const RACY_MS = 2_000;

interface Snapshot {
  /** 位置・大きさ・更新時刻から作る軽い印。同じなら中身を読み直さない（書かれたばかりのファイルがあったときを除く） */
  signature: string;
  /** 位置と中身の sha256 */
  hash: string;
  /** 印を作った時刻と、そのときいちばん新しかったファイルの更新時刻 */
  takenAt: number;
  newestMtime: number;
}

function snapshot(root: string, paths: readonly string[], previous: Snapshot | null): Snapshot {
  const takenAt = Date.now();
  const files = paths.flatMap((p) => listFiles(join(root, p))).sort();
  let newestMtime = 0;
  const stats = files.map((f) => {
    try {
      const s = statSync(f);
      newestMtime = Math.max(newestMtime, s.mtimeMs);
      return `${relative(root, f)}:${s.size}:${s.mtimeMs}`;
    } catch {
      return `${relative(root, f)}:gone`;
    }
  });
  const signature = stats.join("\n");
  if (previous !== null && previous.signature === signature && previous.takenAt - previous.newestMtime > RACY_MS) return previous;
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(relative(root, f).replace(/\\/g, "/"));
    hash.update("\0");
    try {
      hash.update(readFileSync(f));
    } catch {
      hash.update("<gone>");
    }
    hash.update("\0");
  }
  return { signature, hash: hash.digest("hex"), takenAt, newestMtime };
}

/**
 * 起動したときのコードの指紋を覚え、今のファイルと比べる。
 * 更新時刻だけが変わった（同じ中身で書き直した・git が触った）ときは古いと見なさない。
 * 印が同じあいだは中身を読み直さないので、health のたびに呼んでも重くない。
 */
export class CodeFingerprint {
  // 引数プロパティ（constructor(private …)）は使わない。橋渡しは --experimental-strip-types で動き、型を消すだけでは動かない書き方だから
  private readonly root: string;
  private readonly paths: readonly string[];
  private readonly initial: Snapshot;
  private last: Snapshot;

  constructor(root: string, paths: readonly string[] = BRIDGE_CODE_PATHS) {
    this.root = root;
    this.paths = paths;
    this.initial = snapshot(root, paths, null);
    this.last = this.initial;
  }

  /** 起動したあとにコードが変わったか */
  changed(): boolean {
    try {
      this.last = snapshot(this.root, this.paths, this.last);
    } catch {
      return false;
    }
    return this.last.hash !== this.initial.hash;
  }
}

// ---------------------------------------------------------------------------
// 作業画面のビルド
// ---------------------------------------------------------------------------

function newestMtime(target: string): number {
  let newest = 0;
  for (const f of listFiles(target)) {
    try {
      newest = Math.max(newest, statSync(f).mtimeMs);
    } catch {
      // 数えている間に消えたファイルは飛ばす
    }
  }
  return newest;
}

/** ビルドし直しが要るなら、元の方が新しい場所の一覧。要らなければ空（ビルドが無いときは ["dist/app"]） */
export function staleBuildSources(repoRoot: string): string[] {
  let built = 0;
  try {
    built = statSync(join(repoRoot, "dist", "app", "index.html")).mtimeMs;
  } catch {
    return ["dist/app"];
  }
  return BUILD_SOURCES.filter((rel) => newestMtime(join(repoRoot, rel)) > built);
}

// ---------------------------------------------------------------------------
// 配った Skill の写し
// ---------------------------------------------------------------------------

/** 導入の記録（setup.json）のうち、ここで読む部分。scripts/setup-local.mjs が書く */
interface SetupRecord {
  installed?: Record<string, unknown>;
  skillDirs?: Record<string, unknown>;
}

/**
 * 写した先。導入は setup.json の skillDirs に「installed の下の名前 → 写した場所」を書く（写す先が増えてもここは変えなくてよい）。
 * 名前が分かるものだけ表示名を付け、分からなければ名前のまま出す。
 */
const COPY_LABELS: Record<string, string> = { skills: "Claude Code", antigravitySkills: "Antigravity", codexSkills: "Codex" };
/** skillDirs を書く前の導入の記録には、Claude Code の分しか無い。その場所は Claude Code と同じ決め方で決める */
const LEGACY_TARGETS: Record<string, () => string> = {
  skills: () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills"),
};

function copyTargets(record: SetupRecord): { record: string; label: string; dir: string }[] {
  const dirs =
    record.skillDirs && typeof record.skillDirs === "object"
      ? Object.entries(record.skillDirs).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "")
      : Object.entries(LEGACY_TARGETS).map(([key, dir]) => [key, dir()] as [string, string]);
  return dirs.map(([key, dir]) => ({ record: key, label: COPY_LABELS[key] ?? key, dir }));
}

export interface SkillCopyProblem {
  label: string;
  dir: string;
  /** 写しの中身が元と違う */
  changed: string[];
  /** 元にはあるが、写しが無い（新しく足した・保存した Skill など） */
  missing: string[];
}

function readText(file: string): string | null {
  try {
    return normalizeText(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** frontmatter の name（無ければ null）。導入（setup-local.mjs の skillFrontmatterName）と同じ読み方 */
function frontmatterName(text: string): string | null {
  const lines = text.split("\n");
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  for (const line of lines.slice(1, end < 0 ? 1 : end)) {
    const m = /^name:\s*["']?([a-z0-9-]+)["']?\s*$/.exec(line);
    if (m) return m[1] ?? null;
  }
  return null;
}

function skillsIn(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && NAME_PATTERN.test(e.name))
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of names) {
    const text = readText(join(dir, name, SKILL_FILE));
    if (text !== null) out.set(name, text);
  }
  return out;
}

/**
 * 導入が写す Skill（名前 → 中身）。アプリ既定（リポジトリの skills/）と、利用者の Skill のうち導入が写すもの
 * （既定と同じ名前でなく、frontmatter の name がフォルダ名と同じもの。setup-local.mjs の readUserSkills と同じ規則）。
 */
export function sourceSkills(repoRoot: string, userSkillsDir: string | null): Map<string, string> {
  const skills = skillsIn(join(repoRoot, "skills"));
  if (userSkillsDir !== null) {
    for (const [name, text] of skillsIn(userSkillsDir)) {
      if (!skills.has(name) && !isReservedSkillName(name) && frontmatterName(text) === name) skills.set(name, text);
    }
  }
  return skills;
}

/**
 * 導入が配った Skill の写しが、今の元と同じか。導入の記録が無ければ（導入していない・開発中）何も言わない。
 * 導入が写していない先（Antigravity を入れていないなど）も見ない。
 */
export function skillCopyProblems(opts: { repoRoot: string; stateDir: string; userSkillsDir: string | null }): SkillCopyProblem[] {
  let record: SetupRecord;
  try {
    record = JSON.parse(readFileSync(join(opts.stateDir, "setup.json"), "utf8")) as SetupRecord;
  } catch {
    return [];
  }
  const sources = sourceSkills(opts.repoRoot, opts.userSkillsDir);
  const problems: SkillCopyProblem[] = [];
  for (const { record: key, label, dir } of copyTargets(record)) {
    const installed = record.installed?.[key];
    if (!Array.isArray(installed) || installed.length === 0) continue;
    const changed: string[] = [];
    const missing: string[] = [];
    for (const [name, text] of sources) {
      const copy = readText(join(dir, name, SKILL_FILE));
      if (copy === null) missing.push(name);
      else if (copy !== text) changed.push(name);
    }
    if (changed.length > 0 || missing.length > 0) problems.push({ label, dir, changed, missing });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 知らせにまとめる
// ---------------------------------------------------------------------------

export type UpdateKind = "mcp_code" | "bridge_code" | "app_build" | "skill_copies";

export interface UpdateNotice {
  kind: UpdateKind;
  /** 何が古いか */
  message: string;
  /** 利用者がすること */
  action: string;
}

export interface UpdateState {
  /** この会話の MCP を話している橋渡し（このプロセス）のコードが、起動したあとに変わったか */
  selfStale: boolean;
  /** このプロセスがポートを持つ橋渡し（primary）か */
  isPrimary: boolean;
  /** primary のコードが起動したあとに変わったか（client のときに primary へ聞いた値。分からなければ null） */
  primaryStale: boolean | null;
  /** ビルドし直しが要る元の場所（要らなければ空） */
  staleBuild: string[];
  skillCopies: SkillCopyProblem[];
}

const SETUP_COMMAND = "mxstage.cmd (or node scripts/setup-local.mjs)";

export function updateNotices(state: UpdateState): UpdateNotice[] {
  const notices: UpdateNotice[] = [];
  if (state.selfStale) {
    notices.push({
      kind: "mcp_code",
      message: state.isPrimary
        ? "The code in the repository was updated after MX Stage (the MCP server and the relay to the work screen tab) started for this conversation. The tool definitions, the basic procedure and the relay are out of date."
        : "The code in the repository was updated after MX Stage (the MCP server) started for this conversation. The tool definitions and the basic procedure are out of date.",
      action: "Start a new conversation (in Claude Code or Antigravity, open a new conversation; in Claude Desktop, quit it from the system tray and open it again).",
    });
  }
  if (!state.isPrimary && state.primaryStale === true) {
    notices.push({
      kind: "bridge_code",
      message: "The code in the repository was updated after the bridge that relays to the work screen tab (the one holding the port) started. The relay is running old code.",
      action:
        "Stop that bridge and start it again (if Claude started it, quit that Claude app; if it was started at sign-in or by the setup, follow \"Stop the bridge now\" in docs/local.md and run the setup again).",
    });
  }
  if (state.staleBuild.length > 0) {
    notices.push({
      kind: "app_build",
      message: `The work screen build is older than its sources (newer sources: ${state.staleBuild.join(", ")}).`,
      action: `Run the setup (${SETUP_COMMAND}) again to rebuild, then reload the work screen.`,
    });
  }
  for (const p of state.skillCopies) {
    const parts = [
      p.changed.length > 0 ? `different from the source: ${p.changed.join(", ")}` : null,
      p.missing.length > 0 ? `not installed yet: ${p.missing.join(", ")}` : null,
    ].filter((s): s is string => s !== null);
    notices.push({
      kind: "skill_copies",
      message: `The Skill copies installed for ${p.label} (${p.dir}) do not match the current Skills (${parts.join("; ")}).`,
      action: `Run the setup (${SETUP_COMMAND}) again and use them from a new conversation (copies that were edited are backed up before being replaced).`,
    });
  }
  return notices;
}

/** 結果に添える文。知らせが無ければ null */
export function updatesText(notices: readonly UpdateNotice[]): string | null {
  if (notices.length === 0) return null;
  return [
    "[MX Stage updates] The following are out of date. Before starting work, tell the user in their language.",
    ...notices.map((n) => `- ${n.message} → ${n.action}`),
  ].join("\n");
}

/** 橋渡しの中で知らせを集める */
export interface UpdateCheckerOptions {
  repoRoot: string;
  /** ~/.config/mxstage（setup.json がある場所） */
  stateDir: string;
  userSkillsDir: string | null;
  /** このプロセスのコード */
  self: CodeFingerprint;
  /** 作業画面を既定の dist/app から配っているか（--app-dir で別の場所を指したときはビルドを見ない） */
  checkBuild: boolean;
  isPrimary: () => boolean;
  /** primary が古いか（client のときだけ呼ぶ） */
  primaryStale: () => Promise<boolean | null>;
}

export async function checkUpdates(opts: UpdateCheckerOptions): Promise<UpdateNotice[]> {
  const isPrimary = opts.isPrimary();
  const guard = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  return updateNotices({
    selfStale: opts.self.changed(),
    isPrimary,
    primaryStale: isPrimary ? null : await opts.primaryStale().catch(() => null),
    staleBuild: opts.checkBuild ? guard(() => staleBuildSources(opts.repoRoot), []) : [],
    skillCopies: guard(() => skillCopyProblems(opts), []),
  });
}

/** 既定の dist/app を配っているか */
export function isDefaultAppDir(repoRoot: string, appDir: string): boolean {
  return relative(join(repoRoot, "dist", "app"), appDir) === "";
}
