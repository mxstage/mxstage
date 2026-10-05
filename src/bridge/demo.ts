// Maximo が無くても試せるデモ（設定の「デモ」）。橋渡しの中で、架空のデータを載せた仮想 Maximo を動かす。
// - 落とすのは、利用者が「データを落としてつなぐ」を押したときだけ。置き場所は Cloudflare Pages の静的なファイル（何も送らない）。
// - 目録（manifest.json）は製品に埋め込んだ SHA-256（src/shared/demo.ts）と照らし、各ファイルは目録の SHA-256 と照らす。
//   中身は JSON と Excel だけで、コードは落とさない。落とし先は状態フォルダの demo/v<版>/。次からはネットにつながずに使う。
// - 仮想 Maximo は 1 言語ずつメモリに持つ（約 0.5 GB）。初めて /mx に来たときに読み、使わないまま idleMs が過ぎるか、
//   「デモを閉じる」か、橋渡しの再起動で放す。書き込みはこの PC のメモリの写しにだけ効き、放すと初めの状態に戻る。
// - /mx は予約の接続先 ID（demo-ja・demo-en）だけをここに回す（src/bridge/server.ts）。普通の中継と同じ検査（パス・転送するヘッダ・
//   応答のヘッダ）を使い回す。

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createFakeMaximo, type FakeMaximo, type FakeSeed } from "../demo/fakeMaximo.ts";
import { DEMO_FORMAT, filesToSeed, sha256, type DemoManifest, type ManifestFile } from "../demo/format.ts";
import {
  DEMO_CLOSE_PATH,
  DEMO_DATA_URL,
  DEMO_DATA_VERSION,
  DEMO_DOWNLOAD_PATH,
  DEMO_EXCEL_PREFIX,
  DEMO_LANGS,
  DEMO_MANIFEST_SHA256,
  DEMO_ORIGINS,
  DEMO_PATH,
  DEMO_REMOVE_PATH,
  DEMO_RESET_PATH,
  isDemoExcelId,
  isDemoLang,
  type DemoExcelEntry,
  type DemoLang,
  type DemoLanguageStatus,
  type DemoStatus,
} from "../shared/demo.ts";
import { checkProxyPath, forwardHeaders, sanitizeUpstreamHeaders } from "./mx.ts";
import { readBody } from "./peer.ts";

/** 置き場所を差し替える環境変数（公開の前の確かめ用。目録の SHA-256 は変えられないので、同じデータしか読めない） */
export const DEMO_DATA_URL_ENV = "MXSTAGE_DEMO_DATA_URL";
export const DEMO_MANIFEST_LIMIT = 1024 * 1024;
export const DEMO_FILE_LIMIT = 25 * 1024 * 1024;
export const DEMO_LANGUAGE_LIMIT = 64 * 1024 * 1024;
/** 仮想 Maximo へ送る本文の上限 */
export const DEMO_REQUEST_BODY_LIMIT = 32 * 1024 * 1024;
/** 使わないまま過ぎたらメモリから放す */
export const DEMO_IDLE_UNLOAD_MS = 60 * 60 * 1000;
/** 落としている途中で、この間なにも届かなければ切る */
export const DEMO_STALL_MS = 60_000;
const DEMO_PATHS: readonly string[] = [DEMO_PATH, DEMO_DOWNLOAD_PATH, DEMO_RESET_PATH, DEMO_CLOSE_PATH, DEMO_REMOVE_PATH];

export type DemoProblem =
  | "manifest_unreachable"
  | "manifest_mismatch"
  | "manifest_invalid"
  | "file_unreachable"
  | "file_mismatch"
  | "too_large"
  | "write_failed"
  | "not_downloaded"
  | "unreadable"
  | "busy";

export class DemoError extends Error {
  readonly problem: DemoProblem;
  constructor(problem: DemoProblem, message?: string) {
    super(message ?? problem);
    this.problem = problem;
    this.name = "DemoError";
  }
}

export interface DemoManagerOptions {
  /** 状態フォルダの下の demo フォルダ（~/.config/mxstage/demo） */
  dir: string;
  /** 置き場所（既定は環境変数 MXSTAGE_DEMO_DATA_URL か DEMO_DATA_URL） */
  dataUrl?: string;
  version?: number;
  manifestSha256?: string;
  fetch?: typeof fetch;
  now?: () => number;
  idleMs?: number;
  stallMs?: number;
  log?: (line: string) => void;
}

interface Loaded {
  lang: DemoLang;
  fake: FakeMaximo;
  loadedAt: number;
  lastUsedAt: number;
}

/** 置き場所の URL（https、または試験・確かめ用の http://127.0.0.1・localhost だけ）。末尾の / は外す */
export function normalizeDataUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "") return DEMO_DATA_URL;
  try {
    const u = new URL(value);
    const local = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
    if ((u.protocol === "https:" || local) && !u.username && !u.password && !u.search && !u.hash) return u.href.replace(/\/+$/, "");
  } catch {
    // 下で既定に戻す
  }
  return DEMO_DATA_URL;
}

const PATH_RE = /^(ja|en)\/(osdefs\.json\.gz|os\/[A-Za-z0-9_]+\.ndjson\.gz|excel\/[a-z0-9-]+\.xlsx)$/;

function isManifestFile(v: unknown): v is ManifestFile {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.path === "string" &&
    PATH_RE.test(f.path) &&
    (f.kind === "osdefs" || f.kind === "records" || f.kind === "excel") &&
    typeof f.bytes === "number" &&
    Number.isInteger(f.bytes) &&
    f.bytes >= 0 &&
    typeof f.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(f.sha256)
  );
}

/** 目録を読む（形が違えば DemoError） */
export function parseManifest(bytes: Uint8Array, version: number): DemoManifest {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new DemoError("manifest_invalid");
  }
  const m = value as Partial<DemoManifest> | null;
  if (!m || typeof m !== "object" || m.format !== DEMO_FORMAT || m.version !== version || !m.languages || typeof m.languages !== "object") {
    throw new DemoError("manifest_invalid");
  }
  for (const lang of DEMO_LANGS) {
    const entry = m.languages[lang];
    if (!entry || !Array.isArray(entry.files) || !entry.files.every(isManifestFile) || !entry.files.every((f) => f.path.startsWith(`${lang}/`))) {
      throw new DemoError("manifest_invalid");
    }
    if (entry.files.filter((f) => f.kind === "osdefs").length !== 1) throw new DemoError("manifest_invalid");
    let total = 0;
    for (const f of entry.files) {
      if (f.bytes > DEMO_FILE_LIMIT) throw new DemoError("too_large");
      total += f.bytes;
    }
    if (total > DEMO_LANGUAGE_LIMIT) throw new DemoError("too_large");
  }
  return m as DemoManifest;
}

function emptyLanguage(): DemoLanguageStatus {
  return { state: "none", totalBytes: null, receivedBytes: 0, error: null };
}

export class DemoManager {
  private readonly dir: string;
  private readonly dataUrl: string;
  private readonly version: number;
  private readonly manifestSha256: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly stallMs: number;
  private readonly log: (line: string) => void;
  private readonly downloads: Record<DemoLang, DemoLanguageStatus> = { ja: emptyLanguage(), en: emptyLanguage() };
  private readonly running = new Map<DemoLang, Promise<void>>();
  private current: Loaded | null = null;
  private loading: { lang: DemoLang; promise: Promise<FakeMaximo> } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 確かめた目録（落とし済みの言語があるとき） */
  private manifestCache: DemoManifest | null = null;

  constructor(opts: DemoManagerOptions) {
    this.dir = opts.dir;
    this.dataUrl = normalizeDataUrl(opts.dataUrl ?? process.env[DEMO_DATA_URL_ENV]);
    this.version = opts.version ?? DEMO_DATA_VERSION;
    this.manifestSha256 = opts.manifestSha256 ?? DEMO_MANIFEST_SHA256;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? DEMO_IDLE_UNLOAD_MS;
    this.stallMs = opts.stallMs ?? DEMO_STALL_MS;
    this.log = opts.log ?? (() => undefined);
  }

  private get versionDir(): string {
    return join(this.dir, `v${this.version}`);
  }

  private markerPath(lang: DemoLang): string {
    return join(this.versionDir, `${lang}.complete`);
  }

  private localPath(path: string): string {
    return join(this.versionDir, ...path.split("/"));
  }

  /** 手元に置いた目録（埋め込んだ SHA-256 と合うものだけ） */
  private localManifest(): DemoManifest | null {
    if (this.manifestCache) return this.manifestCache;
    const file = join(this.versionDir, "manifest.json");
    if (!existsSync(file)) return null;
    try {
      const bytes = readFileSync(file);
      if (sha256(bytes) !== this.manifestSha256) return null;
      this.manifestCache = parseManifest(bytes, this.version);
      return this.manifestCache;
    } catch {
      return null;
    }
  }

  /** 落とし済みか（すべてのファイルを確かめ終えた印がある） */
  isReady(lang: DemoLang): boolean {
    if (this.downloads[lang].state === "downloading") return false;
    const marker = this.markerPath(lang);
    if (!existsSync(marker)) return false;
    try {
      if (readFileSync(marker, "utf8").trim() !== this.manifestSha256) return false;
    } catch {
      return false;
    }
    return this.localManifest() !== null;
  }

  readyLanguages(): DemoLang[] {
    return DEMO_LANGS.filter((l) => this.isReady(l));
  }

  status(): DemoStatus {
    const languages = {} as Record<DemoLang, DemoLanguageStatus>;
    const excel: DemoStatus["excel"] = {};
    const manifest = this.localManifest();
    for (const lang of DEMO_LANGS) {
      const d = this.downloads[lang];
      if (d.state === "downloading" || d.state === "failed") {
        languages[lang] = { ...d };
        continue;
      }
      if (this.isReady(lang) && manifest) {
        const files = manifest.languages[lang]?.files ?? [];
        const total = files.reduce((n, f) => n + f.bytes, 0);
        languages[lang] = { state: "ready", totalBytes: total, receivedBytes: total, error: null };
        excel[lang] = files.flatMap((f): DemoExcelEntry[] => {
          if (f.kind !== "excel") return [];
          const id = f.path.slice(`${lang}/excel/`.length, -".xlsx".length);
          return isDemoExcelId(id) ? [{ id, title: f.title ?? id, fileName: f.fileName ?? `${id}.xlsx`, bytes: f.bytes, sha256: f.sha256 }] : [];
        });
      } else {
        languages[lang] = emptyLanguage();
      }
    }
    return {
      version: this.version,
      dataHost: new URL(this.dataUrl).host,
      languages,
      loaded: this.current ? { language: this.current.lang, loadedAt: this.current.loadedAt, lastUsedAt: this.current.lastUsedAt } : null,
      loading: this.loading?.lang ?? null,
      idleUnloadMs: this.idleMs,
      excel,
    };
  }

  // -------------------------------------------------------------------------
  // 落とす
  // -------------------------------------------------------------------------

  /** 落とし始める（終わるのを待たない。進み具合は status() で見る）。落とし済みなら何もしない */
  startDownload(lang: DemoLang): void {
    if (this.running.has(lang) || this.isReady(lang)) return;
    this.downloads[lang] = { state: "downloading", totalBytes: null, receivedBytes: 0, error: null };
    const run = this.download(lang)
      .then(() => {
        this.downloads[lang] = emptyLanguage();
        this.log(`demo data (${lang}) downloaded`);
      })
      .catch((e: unknown) => {
        const problem = e instanceof DemoError ? e.problem : "file_unreachable";
        this.downloads[lang] = { ...this.downloads[lang], state: "failed", error: problem };
        this.log(`demo data (${lang}) download failed: ${problem}`);
      })
      .finally(() => this.running.delete(lang));
    this.running.set(lang, run);
  }

  /** 落とし終わるのを待つ（試験用） */
  async whenDownloaded(lang: DemoLang): Promise<void> {
    await this.running.get(lang);
  }

  private async download(lang: DemoLang): Promise<void> {
    const manifestBytes = await this.fetchBytes(`${this.dataUrl}/v${this.version}/manifest.json`, DEMO_MANIFEST_LIMIT, "manifest_unreachable");
    if (sha256(manifestBytes) !== this.manifestSha256) throw new DemoError("manifest_mismatch");
    const manifest = parseManifest(manifestBytes, this.version);
    const files = manifest.languages[lang]!.files;
    const status = this.downloads[lang];
    status.totalBytes = files.reduce((n, f) => n + f.bytes, 0);
    try {
      mkdirSync(this.versionDir, { recursive: true });
      this.writeAtomic(join(this.versionDir, "manifest.json"), manifestBytes);
    } catch {
      throw new DemoError("write_failed");
    }
    this.manifestCache = null;
    for (const f of files) {
      const target = this.localPath(f.path);
      // 途中で切れたときのやり直しでは、確かめ済みのファイルを落とし直さない
      if (existsSync(target)) {
        try {
          const have = readFileSync(target);
          if (have.byteLength === f.bytes && sha256(have) === f.sha256) {
            status.receivedBytes += f.bytes;
            continue;
          }
        } catch {
          // 落とし直す
        }
      }
      const before = status.receivedBytes;
      const bytes = await this.fetchBytes(`${this.dataUrl}/v${this.version}/${f.path}`, f.bytes, "file_unreachable", (n) => {
        status.receivedBytes = before + n;
      });
      if (bytes.byteLength !== f.bytes || sha256(bytes) !== f.sha256) throw new DemoError("file_mismatch");
      try {
        mkdirSync(join(target, ".."), { recursive: true });
        this.writeAtomic(target, bytes);
      } catch {
        throw new DemoError("write_failed");
      }
      status.receivedBytes = before + f.bytes;
    }
    try {
      this.writeAtomic(this.markerPath(lang), Buffer.from(`${this.manifestSha256}\n`, "utf8"));
    } catch {
      throw new DemoError("write_failed");
    }
  }

  private writeAtomic(file: string, bytes: Uint8Array): void {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
  }

  /** 1 つのファイルを落とす（limit を超えたら止める。DEMO_STALL_MS の間なにも届かなければ切る） */
  private async fetchBytes(url: string, limit: number, problem: DemoProblem, onProgress?: (n: number) => void): Promise<Buffer> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), this.stallMs);
    };
    arm();
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { signal: controller.signal, headers: { accept: "*/*", "user-agent": "mxstage-demo" } });
      } catch {
        throw new DemoError(problem);
      }
      if (res.status !== 200 || !res.body) throw new DemoError(problem);
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limit) throw new DemoError("too_large");
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) {
            await reader.cancel().catch(() => undefined);
            throw new DemoError(problem === "manifest_unreachable" ? "too_large" : "file_mismatch");
          }
          chunks.push(Buffer.from(value));
          onProgress?.(size);
          arm();
        }
      } catch (e) {
        if (e instanceof DemoError) throw e;
        throw new DemoError(problem);
      }
      return Buffer.concat(chunks);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // メモリに載せる・放す
  // -------------------------------------------------------------------------

  /** その言語の仮想 Maximo（無ければ落とし済みのファイルから作る。同時の要求は 1 回にまとめ、別の言語は放す） */
  async load(lang: DemoLang): Promise<FakeMaximo> {
    for (;;) {
      if (this.current?.lang === lang) {
        this.touch();
        return this.current.fake;
      }
      if (this.loading?.lang === lang) return this.loading.promise;
      if (!this.loading) break;
      await this.loading.promise.catch(() => undefined);
    }
    if (!this.isReady(lang)) throw new DemoError("not_downloaded");
    // 1 言語ずつ持つ（約 0.5 GB）。読む前に前の言語を放す
    this.unload();
    const promise = this.build(lang)
      .then((fake) => {
        const at = this.now();
        this.current = { lang, fake, loadedAt: at, lastUsedAt: at };
        this.armIdle();
        this.log(`demo Maximo (${lang}) loaded`);
        return fake;
      })
      .finally(() => {
        this.loading = null;
      });
    this.loading = { lang, promise };
    return promise;
  }

  private async build(lang: DemoLang): Promise<FakeMaximo> {
    const manifest = this.localManifest();
    if (!manifest) throw new DemoError("not_downloaded");
    const files = manifest.languages[lang]!.files;
    const read = async (f: ManifestFile): Promise<Buffer> => {
      let bytes: Buffer;
      try {
        bytes = await readFile(this.localPath(f.path));
      } catch {
        throw new DemoError("unreadable");
      }
      if (sha256(bytes) !== f.sha256) throw new DemoError("unreadable");
      return bytes;
    };
    const osdefs = await read(files.find((f) => f.kind === "osdefs")!);
    const records: Array<{ os: string; bytes: Uint8Array }> = [];
    for (const f of files) {
      if (f.kind !== "records") continue;
      records.push({ os: f.os ?? f.path.slice(`${lang}/os/`.length, -".ndjson.gz".length), bytes: await read(f) });
    }
    let seed: FakeSeed;
    try {
      seed = filesToSeed(osdefs, records);
    } catch {
      throw new DemoError("unreadable");
    }
    seed.baseUrl = DEMO_ORIGINS[lang];
    // 仮想 Maximo の API キーは橋渡しの中だけで使う（画面にも外にも出ない）
    seed.apiKey = randomBytes(16).toString("hex");
    return createFakeMaximo(seed);
  }

  private touch(): void {
    if (this.current) this.current.lastUsedAt = this.now();
  }

  private armIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.current || this.idleMs <= 0) return;
    const wait = Math.max(10, this.current.lastUsedAt + this.idleMs - this.now());
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.current) return;
      if (this.now() - this.current.lastUsedAt >= this.idleMs) {
        this.log(`demo Maximo (${this.current.lang}) unloaded after idle`);
        this.unload();
      } else this.armIdle();
    }, wait);
    this.idleTimer.unref?.();
  }

  private unload(): void {
    this.current = null;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** 初めの状態に戻す（載せていれば読み直す） */
  async reset(): Promise<void> {
    if (this.loading) await this.loading.promise.catch(() => undefined);
    const lang = this.current?.lang;
    if (lang === undefined) return;
    this.unload();
    await this.load(lang);
  }

  /** メモリから放す */
  async close(): Promise<void> {
    if (this.loading) await this.loading.promise.catch(() => undefined);
    this.unload();
  }

  /** 落としたファイルを消す */
  async remove(lang: DemoLang): Promise<void> {
    if (this.running.has(lang)) throw new DemoError("busy");
    if (this.loading?.lang === lang) await this.loading.promise.catch(() => undefined);
    if (this.current?.lang === lang) this.unload();
    try {
      rmSync(this.markerPath(lang), { force: true });
      rmSync(join(this.versionDir, lang), { recursive: true, force: true });
      if (DEMO_LANGS.every((l) => !existsSync(this.markerPath(l)) && !this.running.has(l))) {
        rmSync(this.versionDir, { recursive: true, force: true });
        this.manifestCache = null;
      }
    } catch {
      throw new DemoError("write_failed");
    }
    this.downloads[lang] = emptyLanguage();
  }

  /** サンプルの Excel（落とし済みのもの） */
  async excel(lang: DemoLang, id: string): Promise<{ bytes: Buffer; fileName: string } | null> {
    if (!isDemoExcelId(id) || !this.isReady(lang)) return null;
    const manifest = this.localManifest();
    const f = manifest?.languages[lang]?.files.find((x) => x.kind === "excel" && x.path === `${lang}/excel/${id}.xlsx`);
    if (!f) return null;
    try {
      const bytes = await readFile(this.localPath(f.path));
      return sha256(bytes) === f.sha256 ? { bytes, fileName: f.fileName ?? `${id}.xlsx` } : null;
    } catch {
      return null;
    }
  }

  /** 橋渡しを止めるとき */
  dispose(): void {
    this.unload();
  }

  // -------------------------------------------------------------------------
  // /mx（予約の接続先 ID の要求）
  // -------------------------------------------------------------------------

  async handleMx(req: IncomingMessage, res: ServerResponse, url: URL, lang: DemoLang): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      req.resume();
      sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "Only GET and POST are forwarded." }, { Allow: "GET, POST" });
      return;
    }
    const path = url.pathname.slice("/mx".length);
    const pathError = checkProxyPath(path, url.search);
    if (pathError) {
      req.resume();
      sendJson(res, pathError.status, { ok: false, error: pathError.error, message: pathError.message });
      return;
    }
    let fake: FakeMaximo;
    try {
      fake = await this.load(lang);
    } catch (e) {
      req.resume();
      const problem = e instanceof DemoError ? e.problem : "unreadable";
      // connection_ で始めると、作業画面の自動接続はやり直さない（src/app/connections/auto.ts）
      if (problem === "not_downloaded") sendJson(res, 409, { ok: false, error: "connection_demo_not_downloaded", message: "Download the demo data in Settings > Demo first." });
      else sendJson(res, 500, { ok: false, error: "connection_demo_unreadable", message: "The demo data cannot be read. Remove it in Settings > Demo and download it again." });
      return;
    }
    let body: string | undefined;
    if (method === "POST") {
      const raw = await readBody(req, DEMO_REQUEST_BODY_LIMIT);
      if (raw === null) {
        sendJson(res, 413, { ok: false, error: "too_large", message: "The request body is too large." });
        return;
      }
      body = raw.toString("utf8");
    } else req.resume();
    const headers = forwardHeaders(req.headers, fake.apiKey);
    const upstream = await fake.fetch(`${DEMO_ORIGINS[lang]}${path}${url.search}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    this.touch();
    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });
    const out = Buffer.from(await upstream.arrayBuffer());
    const safe = sanitizeUpstreamHeaders(responseHeaders, upstream.status);
    delete safe["content-length"];
    res.writeHead(upstream.status, { ...safe, "Content-Length": String(out.byteLength) });
    res.end(out);
  }
}

// ---------------------------------------------------------------------------
// /_mxstage/demo の入口（作業画面の設定の「デモ」。同一オリジンからだけ受ける）
//   GET  /_mxstage/demo                      状態
//   POST /_mxstage/demo/download             { language } を落とし始める（進み具合は GET で見る）
//   POST /_mxstage/demo/reset                初めの状態に戻す
//   POST /_mxstage/demo/close                メモリから放す
//   POST /_mxstage/demo/remove               { language } の落としたファイルを消す
//   GET  /_mxstage/demo/excel/<言語>/<id>.xlsx サンプルの Excel
// ---------------------------------------------------------------------------

export function isDemoPath(pathname: string): boolean {
  return DEMO_PATHS.includes(pathname) || pathname.startsWith(DEMO_EXCEL_PREFIX);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text, "utf8")),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(text);
}

/** RFC 5987 の filename*（日本語のファイル名） */
function contentDisposition(fileName: string, fallback: string): string {
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function handleDemoRequest(req: IncomingMessage, res: ServerResponse, pathname: string, demo: DemoManager | null): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const isGet = pathname === DEMO_PATH || pathname.startsWith(DEMO_EXCEL_PREFIX);
  const allowed = isGet ? ["GET"] : ["POST"];
  if (!allowed.includes(method)) {
    req.resume();
    sendJson(res, 405, { ok: false, error: "method_not_allowed", message: `Only ${allowed.join(", ")} is accepted.` }, { Allow: allowed.join(", ") });
    return;
  }
  if (demo === null) {
    req.resume();
    sendJson(res, 404, { ok: false, error: "demo_disabled", message: "The demo is turned off in this bridge (--no-demo)." });
    return;
  }
  if (pathname.startsWith(DEMO_EXCEL_PREFIX)) {
    const m = /^([a-z]{2})\/([a-z0-9-]+)\.xlsx$/.exec(pathname.slice(DEMO_EXCEL_PREFIX.length));
    const lang = m?.[1];
    const id = m?.[2];
    const file = isDemoLang(lang) && id !== undefined ? await demo.excel(lang, id) : null;
    if (!file || id === undefined) {
      sendJson(res, 404, { ok: false, error: "not_found", message: "The sample file was not found. Download the demo data first." });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Length": String(file.bytes.byteLength),
      "Content-Disposition": contentDisposition(file.fileName, `${id}.xlsx`),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(file.bytes);
    return;
  }
  if (method === "GET") {
    sendJson(res, 200, { ok: true, ...demo.status() });
    return;
  }
  const raw = await readBody(req, 1024);
  let body: Record<string, unknown> = {};
  if (raw !== null && raw.byteLength > 0) {
    try {
      const v: unknown = JSON.parse(raw.toString("utf8"));
      if (v && typeof v === "object" && !Array.isArray(v)) body = v as Record<string, unknown>;
    } catch {
      body = {};
    }
  }
  const needsLang = pathname === DEMO_DOWNLOAD_PATH || pathname === DEMO_REMOVE_PATH;
  const lang = body.language;
  if (needsLang && !isDemoLang(lang)) {
    sendJson(res, 400, { ok: false, error: "invalid_request", message: 'Send language as "ja" or "en".' });
    return;
  }
  try {
    if (pathname === DEMO_DOWNLOAD_PATH && isDemoLang(lang)) demo.startDownload(lang);
    else if (pathname === DEMO_REMOVE_PATH && isDemoLang(lang)) await demo.remove(lang);
    else if (pathname === DEMO_RESET_PATH) await demo.reset();
    else if (pathname === DEMO_CLOSE_PATH) await demo.close();
  } catch (e) {
    const problem = e instanceof DemoError ? e.problem : "unreadable";
    sendJson(res, problem === "busy" ? 409 : 500, { ok: false, error: `demo_${problem}`, ...demo.status() });
    return;
  }
  sendJson(res, 200, { ok: true, ...demo.status() });
}
