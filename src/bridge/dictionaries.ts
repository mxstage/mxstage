// 客先の辞書と共有フォルダ。橋渡しが読み書きし、作業画面には /_mxstage/dictionaries の入口で渡す。
// - 共有フォルダは接続先（保存した接続先・デモ・保存していない接続先の Maximo）ごとに 1 つ。設定は状態フォルダの shared-folders.json。
//   共有フォルダが無ければ、状態フォルダの local-share/<接続先> に置く（この PC だけ）。あとからフォルダを選べば移す。
// - 中身は <共有フォルダ>/MX Stage/ の下だけに書く:
//     README.txt
//     project.json                      客先の名前と接続先（名前・URL・環境）。API キーは書かない
//     members/<メンバーID>.json         表示名
//     dictionaries/<辞書ID>/dictionary.json         名前・種類・説明
//     dictionaries/<辞書ID>/changes/<メンバーID>.jsonl  そのメンバーの変更（追記だけ）
// - メンバーは自分のファイルにだけ追記する。OneDrive などは 2 人が同じファイルを同時に書くと「競合のコピー」を作るが、
//   書くファイルが人ごとに分かれていれば起きない。読むときに全員のファイルを合わせ、項目ごとに一番新しい変更を使う。
// - フォルダから読んだものは検査してから使う（形の合わない行は使わず problems に入れる）。ファイル名は検査した ID からだけ作る。

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, cpSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  DICTIONARY_DESCRIPTION_MAX,
  DICTIONARY_ID_RE,
  DICTIONARY_KINDS,
  DICTIONARY_NAME_MAX,
  ENTRY_COLUMN_MAX,
  ENTRY_FIELD_MAX,
  ENTRY_FIND_MAX,
  ENTRY_ID_RE,
  ENTRY_SCOPE_MAX,
  ENTRY_NOTE_MAX,
  ENTRY_TO_MAX,
  entryProblem,
  MAX_ENTRIES,
  MEMBER_ID_RE,
  MEMBER_NAME_MAX,
  parseEntryMode,
  SAVE_ID_RE,
  type DictionaryEntry,
  type DictionaryEntryInput,
  type DictionaryKind,
  type DictionaryMeta,
  type EntryProblem,
} from "../shared/dictionary.ts";

export const SHARE_DIR_NAME = "MX Stage";
export const SHARED_FOLDERS_FILE = "shared-folders.json";
export const MEMBER_FILE = "member.json";
export const LOCAL_SHARE_DIR = "local-share";
const DICTIONARY_FORMAT = "mxstage-dictionary/1";
const PROJECT_FORMAT = "mxstage-project/1";
/** 1 つの変更のファイルで読む上限（壊れた・大きすぎるファイルで止まらないように） */
const CHANGES_FILE_MAX_BYTES = 8 * 1024 * 1024;
/** 1 回の保存で送れる変更の数 */
export const MAX_SAVE_OPS = 2000;
/** 履歴に返す保存の数 */
const HISTORY_LIMIT = 100;
const README = [
  "This folder is used by MX Stage to share dictionaries and Skills with the project members.",
  "Do not edit the files in it directly. Open them in the MX Stage work screen.",
  "",
  "MX Stage がメンバーと辞書と Skill を共有するために使うフォルダです。",
  "中のファイルを直接書き換えないでください。MX Stage の作業画面で開いてください。",
  "",
].join("\r\n");

export type SyncKind = "onedrive-business" | "onedrive" | "sharepoint" | "box" | "google-drive" | "dropbox" | "network" | "local";

export interface FolderInfo {
  /** 共有フォルダ（選んだフォルダ）。null ならこの PC だけ */
  path: string | null;
  sync: SyncKind | null;
  /** フォルダに届くか（同期の止まり・ネットワークの切断で届かないことがある） */
  reachable: boolean;
  /** 書けるか（読み取りだけの権限なら false） */
  writable: boolean;
}

export interface Member {
  id: string;
  name: string;
}

export interface DictionarySummary extends DictionaryMeta {
  count: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface HistoryItem {
  saveId: string;
  at: string;
  by: string;
  byId: string;
  added: number;
  changed: number;
  deleted: number;
  /** 見出しに使う項目（最初の 1 件の書き方） */
  sample: string | null;
  /** 元に戻せるか（その保存の変更のどれかが、まだ一番新しい） */
  revertible: boolean;
}

export interface DictionaryProblem {
  file: string;
  line: number | null;
  message: string;
  by: string | null;
}

export interface DictionaryState {
  dictionary: DictionaryMeta;
  entries: DictionaryEntry[];
  history: HistoryItem[];
  problems: DictionaryProblem[];
  version: string;
}

export type DictionaryErrorCode =
  | "invalid_scope"
  | "invalid_request"
  | "not_found"
  | "name_taken"
  | "unreachable"
  | "not_writable"
  | "too_many"
  | "invalid_entry"
  | "invalid_folder";

export class DictionaryError extends Error {
  readonly code: DictionaryErrorCode;
  readonly detail: Record<string, unknown> | undefined;
  constructor(code: DictionaryErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "DictionaryError";
    this.code = code;
    this.detail = detail;
  }
}

/** 1 行の変更（changes/<メンバーID>.jsonl） */
interface ChangeLine {
  v: 1;
  op: "put" | "delete";
  id: string;
  rev: number;
  at: string;
  save: string;
  /** 1 回の保存の中の順（同じ時刻の項目を、足した順に並べるため） */
  n?: number;
  entry?: DictionaryEntryInput;
}

interface ChangeEvent extends ChangeLine {
  by: string;
}

export type SaveOp = { op: "put"; id?: string; entry: DictionaryEntryInput } | { op: "delete"; id: string };

export interface ProjectConnection {
  name: string;
  baseUrl: string;
  environment: "production" | "test" | null;
}

export interface DictionaryStoreOptions {
  /** 状態フォルダ（~/.config/mxstage） */
  stateDir: string;
  now?: () => number;
  /** 環境変数（OneDrive の場所の見分けに使う。試験で差し替える） */
  env?: NodeJS.ProcessEnv;
}

/**
 * 作業画面が送る接続先を、設定のキーにする。
 *   c_<16 桁>（保存した接続先）・demo-ja / demo-en（デモ）はそのまま。https のオリジン（保存していない接続先）は o_<16 桁>。
 */
export function scopeKeyOf(scope: unknown): string | null {
  if (typeof scope !== "string") return null;
  if (/^c_[0-9a-f]{16}$/.test(scope) || /^demo-(ja|en)$/.test(scope)) return scope;
  let u: URL;
  try {
    u = new URL(scope);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  return `o_${createHash("sha256").update(u.origin).digest("hex").slice(0, 16)}`;
}

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** 一時ファイルに書いてから名前を変える（途中で止まっても壊れたファイルを残さない） */
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function isString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length <= max;
}

/** 変更の行の形を確かめる */
function parseChangeLine(raw: unknown): ChangeLine | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (v.v !== 1 || (v.op !== "put" && v.op !== "delete")) return null;
  if (typeof v.id !== "string" || !ENTRY_ID_RE.test(v.id)) return null;
  if (typeof v.rev !== "number" || !Number.isSafeInteger(v.rev) || v.rev < 1) return null;
  if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null;
  if (typeof v.save !== "string" || !SAVE_ID_RE.test(v.save)) return null;
  const n = typeof v.n === "number" && Number.isSafeInteger(v.n) && v.n >= 0 ? { n: v.n } : {};
  if (v.op === "delete") return { v: 1, op: "delete", id: v.id, rev: v.rev, at: v.at, save: v.save, ...n };
  const e = v.entry as Record<string, unknown> | undefined;
  if (!e || typeof e !== "object") return null;
  const mode = parseEntryMode(e.mode);
  if (mode === null || !isString(e.find, ENTRY_FIND_MAX) || !isString(e.to ?? "", ENTRY_TO_MAX) || !isString(e.note ?? "", ENTRY_NOTE_MAX)) return null;
  if (!isString(e.field ?? "", ENTRY_FIELD_MAX) || !isString(e.scope ?? "", ENTRY_SCOPE_MAX) || !isString(e.column ?? "", ENTRY_COLUMN_MAX)) return null;
  return { v: 1, op: "put", id: v.id, rev: v.rev, at: v.at, save: v.save, ...n, entry: entryInputOf(e, mode) };
}

/** 変更の行・保存の要求の項目を、決まった形にする（空の欄は持たない） */
function entryInputOf(e: Record<string, unknown>, mode: DictionaryEntryInput["mode"]): DictionaryEntryInput {
  const out: DictionaryEntryInput = { find: String(e.find ?? ""), to: typeof e.to === "string" ? e.to : "", mode, note: typeof e.note === "string" ? e.note : "" };
  if (typeof e.field === "string" && e.field.trim() !== "") out.field = e.field.trim();
  if (typeof e.scope === "string" && e.scope.trim() !== "") out.scope = e.scope.trim();
  if (typeof e.column === "string" && e.column.trim() !== "") out.column = e.column.trim();
  return out;
}

/** 同じ項目の変更のどちらが新しいか（通し番号 → 日時 → メンバーID の順に比べる。どの PC でも同じ答えになる） */
function newer(a: ChangeEvent, b: ChangeEvent): boolean {
  if (a.rev !== b.rev) return a.rev > b.rev;
  if (a.at !== b.at) return a.at > b.at;
  return a.by > b.by;
}

/** 選んだフォルダがどの仕組みで同期されているか（場所から見分ける。分からなければ local） */
export function detectSync(path: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): SyncKind {
  const p = resolve(path);
  const lower = p.toLowerCase();
  const under = (root: string | undefined) => {
    if (!root) return false;
    const r = resolve(root).toLowerCase();
    return lower === r || lower.startsWith(r.endsWith(sep) ? r : r + sep);
  };
  if (p.startsWith("\\\\") || p.startsWith("//")) return "network";
  const business = env.OneDriveCommercial;
  if (under(business)) return "onedrive-business";
  // SharePoint のライブラリを同期すると、ホームの下の「<組織名>」のフォルダに入る（OneDrive の「OneDrive - <組織名>」と同じ組織名）
  const org = business ? /OneDrive - (.+)$/.exec(resolve(business))?.[1] : undefined;
  if (org && under(join(home, org))) return "sharepoint";
  if (under(env.OneDriveConsumer) || under(env.OneDrive)) return "onedrive";
  if (/[\\/]onedrive( - [^\\/]+)?([\\/]|$)/i.test(p)) return /onedrive - /i.test(p) ? "onedrive-business" : "onedrive";
  if (/[\\/]box([\\/]|$)/i.test(p) || /[\\/]box sync([\\/]|$)/i.test(p)) return "box";
  if (/google ?drive|マイドライブ|my drive|共有ドライブ|shared drives/i.test(p)) return "google-drive";
  if (/[\\/]dropbox([\\/]|$)/i.test(p)) return "dropbox";
  return "local";
}

export class DictionaryStore {
  private readonly stateDir: string;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  /** 接続先ごとの書き込みを 1 つずつ行う */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(opts: DictionaryStoreOptions) {
    this.stateDir = opts.stateDir;
    this.now = opts.now ?? Date.now;
    this.env = opts.env ?? process.env;
  }

  // ---------------------------------------------------------------------------
  // メンバー（この PC の利用者）
  // ---------------------------------------------------------------------------

  member(): Member {
    const file = join(this.stateDir, MEMBER_FILE);
    const v = readJson(file) as Partial<Member> | null;
    if (v && typeof v.id === "string" && MEMBER_ID_RE.test(v.id) && typeof v.name === "string" && v.name.trim() !== "") return { id: v.id, name: v.name };
    let name = "";
    try {
      name = userInfo().username;
    } catch {
      name = "";
    }
    const created: Member = { id: v && typeof v.id === "string" && MEMBER_ID_RE.test(v.id) ? v.id : randomId("m"), name: name || "member" };
    mkdirSync(this.stateDir, { recursive: true });
    writeJsonAtomic(file, created);
    return created;
  }

  setMemberName(name: string): Member {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (trimmed === "" || trimmed.length > MEMBER_NAME_MAX) throw new DictionaryError("invalid_request", `Use a name of 1 to ${MEMBER_NAME_MAX} characters.`);
    const m = { ...this.member(), name: trimmed };
    writeJsonAtomic(join(this.stateDir, MEMBER_FILE), m);
    return m;
  }

  // ---------------------------------------------------------------------------
  // 共有フォルダ
  // ---------------------------------------------------------------------------

  private foldersFile(): string {
    return join(this.stateDir, SHARED_FOLDERS_FILE);
  }

  private readFolders(): Record<string, { path: string; setAt: string }> {
    const v = readJson(this.foldersFile()) as { folders?: Record<string, unknown> } | null;
    const out: Record<string, { path: string; setAt: string }> = {};
    if (v && v.folders && typeof v.folders === "object") {
      for (const [k, raw] of Object.entries(v.folders)) {
        const f = raw as { path?: unknown; setAt?: unknown };
        if (typeof f?.path === "string" && isAbsolute(f.path)) out[k] = { path: f.path, setAt: typeof f.setAt === "string" ? f.setAt : "" };
      }
    }
    return out;
  }

  /** 接続先の共有フォルダ（選んだフォルダ）。無ければ null */
  sharedFolderOf(scopeKey: string): string | null {
    return this.readFolders()[scopeKey]?.path ?? null;
  }

  /** 接続先の辞書と Skill を置くところ（<共有フォルダ>/MX Stage か、この PC の local-share/<接続先>） */
  rootOf(scopeKey: string): string {
    const folder = this.sharedFolderOf(scopeKey);
    return folder === null ? join(this.stateDir, LOCAL_SHARE_DIR, scopeKey) : join(folder, SHARE_DIR_NAME);
  }

  folderInfo(scopeKey: string): FolderInfo {
    const folder = this.sharedFolderOf(scopeKey);
    if (folder === null) return { path: null, sync: null, reachable: true, writable: true };
    let reachable = false;
    try {
      reachable = statSync(folder).isDirectory();
    } catch {
      reachable = false;
    }
    return { path: folder, sync: detectSync(folder, this.env), reachable, writable: reachable && canWrite(folder) };
  }

  /**
   * 接続先に共有フォルダを付ける（null で外す）。この PC だけに置いていた辞書と Skill は、選んだフォルダへ写す
   * （元はこの PC に「moved-<日時>」の名前で残す。消さない）。
   */
  async setSharedFolder(scopeKey: string, path: string | null, project?: { name: string; connections: ProjectConnection[] }): Promise<FolderInfo> {
    return this.serial(scopeKey, async () => {
      const folders = this.readFolders();
      if (path === null) {
        delete folders[scopeKey];
        this.writeFolders(folders);
        return this.folderInfo(scopeKey);
      }
      if (typeof path !== "string" || !isAbsolute(path)) throw new DictionaryError("invalid_folder", "Choose a folder with a full path.");
      const folder = resolve(path);
      let isDir = false;
      try {
        isDir = statSync(folder).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) throw new DictionaryError("invalid_folder", "The folder does not exist.");
      if (!canWrite(folder)) throw new DictionaryError("not_writable", "MX Stage cannot write to this folder.");
      const root = join(folder, SHARE_DIR_NAME);
      ensureRoot(root);
      // この PC だけに置いていたものを写す（同じ ID のファイルがあれば上書きしない）
      const local = join(this.stateDir, LOCAL_SHARE_DIR, scopeKey);
      if (existsSync(local) && resolve(local) !== resolve(root)) {
        cpSync(local, root, { recursive: true, force: false, errorOnExist: false });
        renameSync(local, `${local}.moved-${nowIso(this.now()).replace(/[:.]/g, "-")}`);
      }
      if (project) this.writeProject(root, project);
      const member = this.member();
      writeJsonAtomic(join(root, "members", `${member.id}.json`), { name: member.name, updatedAt: nowIso(this.now()) });
      folders[scopeKey] = { path: folder, setAt: nowIso(this.now()) };
      this.writeFolders(folders);
      return this.folderInfo(scopeKey);
    });
  }

  private writeFolders(folders: Record<string, { path: string; setAt: string }>): void {
    mkdirSync(this.stateDir, { recursive: true });
    writeJsonAtomic(this.foldersFile(), { version: 1, folders });
  }

  /** 客先の名前と接続先（API キーは書かない）。同じフォルダを選んだメンバーが接続先を足すのに使う */
  private writeProject(root: string, project: { name: string; connections: ProjectConnection[] }): void {
    const file = join(root, "project.json");
    const prev = readJson(file) as { connections?: unknown[] } | null;
    const known = new Map<string, ProjectConnection>();
    for (const raw of prev?.connections ?? []) {
      const c = raw as Partial<ProjectConnection>;
      if (typeof c?.baseUrl === "string" && typeof c.name === "string") known.set(c.baseUrl, { name: c.name, baseUrl: c.baseUrl, environment: c.environment === "production" || c.environment === "test" ? c.environment : null });
    }
    for (const c of project.connections) {
      if (/^https:\/\/[^/?#]+$/.test(c.baseUrl)) known.set(c.baseUrl, { name: c.name.slice(0, 128), baseUrl: c.baseUrl, environment: c.environment });
    }
    writeJsonAtomic(file, { format: PROJECT_FORMAT, name: project.name.slice(0, 128), connections: Array.from(known.values()) });
  }

  // ---------------------------------------------------------------------------
  // 辞書
  // ---------------------------------------------------------------------------

  private dictionariesDir(scopeKey: string): string {
    return join(this.rootOf(scopeKey), "dictionaries");
  }

  /** 共有フォルダに届かなければ unreachable */
  private assertReachable(scopeKey: string): void {
    const info = this.folderInfo(scopeKey);
    if (!info.reachable) throw new DictionaryError("unreachable", "The shared folder cannot be reached. Check that it is synced and the network is connected.");
  }

  /** 変わったかを見分ける印（辞書のファイルの大きさと更新時刻から作る） */
  version(scopeKey: string): string {
    const dir = this.dictionariesDir(scopeKey);
    const h = createHash("sha256");
    for (const id of listDirs(dir)) {
      if (!DICTIONARY_ID_RE.test(id)) continue;
      h.update(id);
      for (const f of [join(dir, id, "dictionary.json"), ...listFiles(join(dir, id, "changes")).map((n) => join(dir, id, "changes", n))]) {
        try {
          const s = statSync(f);
          h.update(`${f}:${s.size}:${s.mtimeMs}`);
        } catch {
          // 読めないファイルは印に入れない
        }
      }
    }
    return h.digest("hex").slice(0, 16);
  }

  list(scopeKey: string): DictionarySummary[] {
    this.assertReachable(scopeKey);
    const dir = this.dictionariesDir(scopeKey);
    const out: DictionarySummary[] = [];
    for (const id of listDirs(dir)) {
      if (!DICTIONARY_ID_RE.test(id)) continue;
      const meta = this.readMeta(scopeKey, id);
      if (meta === null) continue;
      const { entries } = this.merge(scopeKey, id);
      const last = entries.reduce<DictionaryEntry | null>((a, e) => (a === null || e.updatedAt > a.updatedAt ? e : a), null);
      out.push({ ...meta, count: entries.length, updatedAt: last?.updatedAt ?? null, updatedBy: last?.updatedBy ?? null });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    return out;
  }

  private readMeta(scopeKey: string, id: string): DictionaryMeta | null {
    const v = readJson(join(this.dictionariesDir(scopeKey), id, "dictionary.json")) as Record<string, unknown> | null;
    if (!v || v.format !== DICTIONARY_FORMAT || v.id !== id) return null;
    if (!isString(v.name, DICTIONARY_NAME_MAX) || v.name.trim() === "") return null;
    const kind = DICTIONARY_KINDS.includes(v.kind as DictionaryKind) ? (v.kind as DictionaryKind) : null;
    if (kind === null) return null;
    return {
      id,
      name: v.name,
      kind,
      description: isString(v.description, DICTIONARY_DESCRIPTION_MAX) ? v.description : "",
      createdAt: typeof v.createdAt === "string" ? v.createdAt : "",
      createdBy: typeof v.createdBy === "string" ? v.createdBy : "",
    };
  }

  /** 名前か ID で辞書を探す */
  find(scopeKey: string, nameOrId: string): DictionaryMeta | null {
    const dir = this.dictionariesDir(scopeKey);
    if (DICTIONARY_ID_RE.test(nameOrId)) return this.readMeta(scopeKey, nameOrId);
    const want = nameOrId.normalize("NFKC").trim().toLowerCase();
    for (const id of listDirs(dir)) {
      if (!DICTIONARY_ID_RE.test(id)) continue;
      const m = this.readMeta(scopeKey, id);
      if (m !== null && m.name.normalize("NFKC").trim().toLowerCase() === want) return m;
    }
    return null;
  }

  async create(scopeKey: string, input: { name: string; kind: DictionaryKind; description?: string }): Promise<DictionaryMeta> {
    return this.serial(scopeKey, async () => {
      this.assertReachable(scopeKey);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (name === "" || name.length > DICTIONARY_NAME_MAX) throw new DictionaryError("invalid_request", `Give a dictionary name of 1 to ${DICTIONARY_NAME_MAX} characters.`);
      if (!DICTIONARY_KINDS.includes(input.kind)) throw new DictionaryError("invalid_request", `kind must be one of ${DICTIONARY_KINDS.join(", ")}.`);
      const description = typeof input.description === "string" ? input.description.slice(0, DICTIONARY_DESCRIPTION_MAX) : "";
      if (this.find(scopeKey, name) !== null) throw new DictionaryError("name_taken", `A dictionary named ${name} already exists.`, { name });
      if (!this.folderInfo(scopeKey).writable) throw new DictionaryError("not_writable", "MX Stage cannot write to the shared folder (read only).");
      const root = this.rootOf(scopeKey);
      ensureRoot(root);
      const member = this.member();
      const id = randomId("d");
      const dir = join(root, "dictionaries", id);
      mkdirSync(join(dir, "changes"), { recursive: true });
      const meta: DictionaryMeta = { id, name, kind: input.kind, description, createdAt: nowIso(this.now()), createdBy: member.name };
      writeJsonAtomic(join(dir, "dictionary.json"), { format: DICTIONARY_FORMAT, ...meta, createdById: member.id });
      this.touchMember(root, member);
      return meta;
    });
  }

  /** 全員の変更を合わせた、今の辞書 */
  get(scopeKey: string, id: string): DictionaryState {
    this.assertReachable(scopeKey);
    const meta = this.readMeta(scopeKey, id);
    if (meta === null) throw new DictionaryError("not_found", `There is no dictionary ${id}.`, { id });
    const merged = this.merge(scopeKey, id);
    return { dictionary: meta, entries: merged.entries, history: merged.history, problems: merged.problems, version: this.version(scopeKey) };
  }

  /** 保存する。新しい項目には ID を付ける（ids は ops と同じ並び。delete は消した ID） */
  async save(scopeKey: string, id: string, ops: readonly SaveOp[]): Promise<{ saveId: string; ids: string[]; state: DictionaryState }> {
    return this.serial(scopeKey, async () => {
      this.assertReachable(scopeKey);
      const meta = this.readMeta(scopeKey, id);
      if (meta === null) throw new DictionaryError("not_found", `There is no dictionary ${id}.`, { id });
      if (!Array.isArray(ops) || ops.length === 0) throw new DictionaryError("invalid_request", "Send at least one change.");
      if (ops.length > MAX_SAVE_OPS) throw new DictionaryError("invalid_request", `Send at most ${MAX_SAVE_OPS} changes at once.`);
      if (!this.folderInfo(scopeKey).writable) throw new DictionaryError("not_writable", "MX Stage cannot write to the shared folder (read only).");
      const merged = this.merge(scopeKey, id);
      const current = new Map(merged.events.map((e) => [e.id, e] as const));
      const live = merged.entries.length;
      const member = this.member();
      const save = randomId("s");
      const at = nowIso(this.now());
      const lines: ChangeLine[] = [];
      const ids: string[] = [];
      let added = 0;
      ops.forEach((raw, index) => {
        const op = raw as Record<string, unknown>;
        if (op?.op === "delete") {
          if (typeof op.id !== "string" || !ENTRY_ID_RE.test(op.id)) throw new DictionaryError("invalid_request", `Change #${index} has no valid id.`, { index });
          const prev = current.get(op.id);
          lines.push({ v: 1, op: "delete", id: op.id, rev: (prev?.rev ?? 0) + 1, at, save, n: index });
          ids.push(op.id);
          return;
        }
        if (op?.op !== "put" || !op.entry || typeof op.entry !== "object") throw new DictionaryError("invalid_request", `Change #${index} must be put or delete.`, { index });
        const e = op.entry as Record<string, unknown>;
        const problem = entryProblem({ find: e.find, to: e.to ?? "", mode: e.mode, note: e.note ?? "", field: e.field, scope: e.scope, column: e.column }, meta.kind);
        if (problem !== null) throw new DictionaryError("invalid_entry", `Change #${index} cannot be used (${problem.code}).`, { index, problem });
        const entry = entryInputOf(e, parseEntryMode(e.mode) ?? "text");
        let entryId: string;
        if (typeof op.id === "string") {
          if (!ENTRY_ID_RE.test(op.id)) throw new DictionaryError("invalid_request", `Change #${index} has an invalid id.`, { index });
          entryId = op.id;
        } else {
          entryId = randomId("e");
          added++;
        }
        const prev = current.get(entryId);
        lines.push({ v: 1, op: "put", id: entryId, rev: (prev?.rev ?? 0) + 1, at, save, n: index, entry });
        ids.push(entryId);
      });
      if (live + added > MAX_ENTRIES) throw new DictionaryError("too_many", `A dictionary can hold at most ${MAX_ENTRIES} entries.`);
      const changes = join(this.dictionariesDir(scopeKey), id, "changes");
      mkdirSync(changes, { recursive: true });
      appendFileSync(join(changes, `${member.id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      this.touchMember(this.rootOf(scopeKey), member);
      return { saveId: save, ids, state: this.get(scopeKey, id) };
    });
  }

  /**
   * 保存を 1 回分、元に戻す。その保存のあとに別の人が同じ項目を変えていれば、その項目は戻さない（skipped）。
   * 戻すのも新しい保存として追記する（履歴は消えない）
   */
  async revert(scopeKey: string, id: string, saveId: string): Promise<{ reverted: number; skipped: number; state: DictionaryState }> {
    if (!SAVE_ID_RE.test(saveId)) throw new DictionaryError("invalid_request", "saveId is not valid.");
    const merged = this.merge(scopeKey, id);
    const target = merged.all.filter((e) => e.save === saveId);
    if (target.length === 0) throw new DictionaryError("not_found", "That save was not found.");
    const latest = new Map(merged.events.map((e) => [e.id, e] as const));
    const ops: SaveOp[] = [];
    let skipped = 0;
    for (const ev of target) {
      const now = latest.get(ev.id);
      if (now === undefined || now.save !== saveId) {
        skipped++;
        continue;
      }
      // この保存より前の、その項目の一番新しい変更に戻す（無ければ消す）
      const before = merged.all.filter((e) => e.id === ev.id && e !== now && newer(now, e)).reduce<ChangeEvent | null>((a, e) => (a === null || newer(e, a) ? e : a), null);
      if (before === null || before.op === "delete" || !before.entry) ops.push({ op: "delete", id: ev.id });
      else ops.push({ op: "put", id: ev.id, entry: before.entry });
    }
    if (ops.length === 0) return { reverted: 0, skipped, state: this.get(scopeKey, id) };
    const res = await this.save(scopeKey, id, ops);
    return { reverted: ops.length, skipped, state: res.state };
  }

  /** 全員の変更のファイルを読んで合わせる */
  private merge(scopeKey: string, id: string): { entries: DictionaryEntry[]; events: ChangeEvent[]; all: ChangeEvent[]; history: HistoryItem[]; problems: DictionaryProblem[] } {
    const root = this.rootOf(scopeKey);
    const dir = join(root, "dictionaries", id, "changes");
    const problems: DictionaryProblem[] = [];
    const all: ChangeEvent[] = [];
    const names = this.memberNames(root);
    for (const file of listFiles(dir)) {
      const m = /^(m_[0-9a-f]{16})\.jsonl$/.exec(file);
      if (!m) continue;
      const by = m[1]!;
      const path = join(dir, file);
      let text: string;
      try {
        if (statSync(path).size > CHANGES_FILE_MAX_BYTES) {
          problems.push({ file, line: null, message: "too_large", by: names.get(by) ?? null });
          continue;
        }
        text = readFileSync(path, "utf8");
      } catch {
        problems.push({ file, line: null, message: "unreadable", by: names.get(by) ?? null });
        continue;
      }
      text.split(/\r?\n/).forEach((line, i) => {
        if (line.trim() === "") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          problems.push({ file, line: i + 1, message: "not_json", by: names.get(by) ?? null });
          return;
        }
        const c = parseChangeLine(parsed);
        if (c === null) {
          problems.push({ file, line: i + 1, message: "invalid_change", by: names.get(by) ?? null });
          return;
        }
        all.push({ ...c, by });
      });
    }
    const latest = new Map<string, ChangeEvent>();
    // 最初に足された時刻と、その保存の中の順（表の並びに使う）
    const first = new Map<string, ChangeEvent>();
    for (const e of all) {
      const cur = latest.get(e.id);
      if (cur === undefined || newer(e, cur)) latest.set(e.id, e);
      const f = first.get(e.id);
      if (f === undefined || e.at < f.at || (e.at === f.at && (e.n ?? 0) < (f.n ?? 0))) first.set(e.id, e);
    }
    const order = (id: string) => first.get(id);
    const events = Array.from(latest.values());
    // 並びは最初に足された順（同じ時刻なら ID の順）。表の並びが保存のたびに変わらないように
    const entries: DictionaryEntry[] = events
      .filter((e) => e.op === "put" && e.entry)
      .sort((a, b) => {
        const fa = order(a.id);
        const fb = order(b.id);
        return (fa?.at ?? "").localeCompare(fb?.at ?? "") || (fa?.n ?? 0) - (fb?.n ?? 0) || a.id.localeCompare(b.id);
      })
      .map((e) => ({ id: e.id, ...(e.entry as DictionaryEntryInput), rev: e.rev, updatedAt: e.at, updatedBy: names.get(e.by) ?? e.by }));
    return { entries, events, all, history: buildHistory(all, latest, names), problems };
  }

  private memberNames(root: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const file of listFiles(join(root, "members"))) {
      const m = /^(m_[0-9a-f]{16})\.json$/.exec(file);
      if (!m) continue;
      const v = readJson(join(root, "members", file)) as { name?: unknown } | null;
      if (v && isString(v.name, MEMBER_NAME_MAX) && v.name.trim() !== "") out.set(m[1]!, v.name);
    }
    const me = this.member();
    out.set(me.id, me.name);
    return out;
  }

  private touchMember(root: string, member: Member): void {
    const file = join(root, "members", `${member.id}.json`);
    const prev = readJson(file) as { name?: unknown } | null;
    if (prev?.name === member.name) return;
    mkdirSync(join(root, "members"), { recursive: true });
    writeJsonAtomic(file, { name: member.name, updatedAt: nowIso(this.now()) });
  }

  /** 名前を変えたら、共有フォルダの自分の表示名も変える */
  renameMemberEverywhere(): void {
    const member = this.member();
    for (const { path } of Object.values(this.readFolders())) {
      const root = join(path, SHARE_DIR_NAME);
      if (existsSync(root)) {
        try {
          this.touchMember(root, member);
        } catch {
          // 届かないフォルダは次に保存するときに直す
        }
      }
    }
  }

  private serial<T>(scopeKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(scopeKey) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(
      scopeKey,
      next.catch(() => undefined),
    );
    return next;
  }
}

function buildHistory(all: readonly ChangeEvent[], latest: ReadonlyMap<string, ChangeEvent>, names: ReadonlyMap<string, string>): HistoryItem[] {
  const bySave = new Map<string, ChangeEvent[]>();
  for (const e of all) {
    const list = bySave.get(e.save);
    if (list) list.push(e);
    else bySave.set(e.save, [e]);
  }
  const items: HistoryItem[] = [];
  for (const [saveId, events] of bySave) {
    const first = events[0]!;
    let added = 0;
    let changed = 0;
    let deleted = 0;
    for (const e of events) {
      if (e.op === "delete") deleted++;
      else if (e.rev === 1) added++;
      else changed++;
    }
    const sample = events.find((e) => e.op === "put" && e.entry)?.entry?.find ?? null;
    items.push({
      saveId,
      at: first.at,
      by: names.get(first.by) ?? first.by,
      byId: first.by,
      added,
      changed,
      deleted,
      sample,
      revertible: events.some((e) => latest.get(e.id) === e),
    });
  }
  items.sort((a, b) => b.at.localeCompare(a.at));
  return items.slice(0, HISTORY_LIMIT);
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
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

function ensureRoot(root: string): void {
  mkdirSync(join(root, "dictionaries"), { recursive: true });
  mkdirSync(join(root, "members"), { recursive: true });
  const readme = join(root, "README.txt");
  if (!existsSync(readme)) writeFileSync(readme, README);
}

/** そのフォルダに書けるか（試しに小さなファイルを作って消す） */
function canWrite(folder: string): boolean {
  const probe = join(folder, `.mxstage-write-test-${process.pid}-${randomBytes(3).toString("hex")}`);
  try {
    writeFileSync(probe, "");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export type { EntryProblem };
