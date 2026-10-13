// 作業画面の辞書: 今の接続先の辞書の一覧、辞書のシートを開く・保存する・作る・元に戻す、ほかのメンバーの保存を取り込む。
// - 接続先（scope）は、保存した接続先なら その ID、それ以外は Maximo の URL。デモは予約の ID（demo-ja など）。
// - 辞書はシート（source.kind = "dictionary"）として開く。保存前の変更はシートの上の変更（色・元に戻す・差分が今と同じに使える）。
// - 保存すると共有フォルダに書き、シートを保存後の中身で作り直す（保存前の変更の色は消える）。
// - 15 秒ごと（画面が見えている間だけ）に一覧の印を確かめ、ほかのメンバーが保存していれば、開いている辞書を新しくする。
//   保存前の変更があるシートは作り直さず、「新しい保存が届いています」と出す（保存すると橋渡しが合わせる）。

import type { ConnectionProvider } from "../runtime/contracts";
import type { Workspace } from "../store";
import { DictionaryClient, type BridgeResult, type DictionaryListing, type DictionaryProblem, type DictionaryState, type HistoryItem, type ProjectInfo } from "./client";
import { dictionarySheetMeta, entriesToRows, pendingChanges, problemText } from "./sheet";
import { dictionaryMessages } from "./messages";

export const DICTIONARY_POLL_MS = 15_000;

export interface DictionarySnapshot {
  /** 今の接続先（つないでいなければ null） */
  scope: string | null;
  status: "idle" | "loading" | "ready" | "failed";
  listing: DictionaryListing | null;
  error: string | null;
}

export interface OpenDictionary {
  sheet: string;
  scope: string;
  id: string;
  name: string;
  history: HistoryItem[];
  problems: DictionaryProblem[];
  /** ほかのメンバーの新しい保存が届いているが、保存前の変更があるので取り込んでいない（その人の名前） */
  newerBy: string | null;
  saving: boolean;
  version: string;
}

export type Notify = (text: string, tone: "info" | "error") => void;

export interface DictionaryServiceOptions {
  workspace: Workspace;
  connection: ConnectionProvider;
  client?: DictionaryClient;
  /** 試験で差し替える */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  isVisible?: () => boolean;
}

export class DictionaryService {
  readonly client: DictionaryClient;
  private readonly workspace: Workspace;
  private readonly connection: ConnectionProvider;
  private readonly listeners = new Set<() => void>();
  private snap: DictionarySnapshot = { scope: null, status: "idle", listing: null, error: null };
  private readonly open = new Map<string, OpenDictionary>();
  private notify: Notify = () => undefined;
  private timer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly isVisible: () => boolean;

  constructor(opts: DictionaryServiceOptions) {
    this.workspace = opts.workspace;
    this.connection = opts.connection;
    this.client = opts.client ?? new DictionaryClient();
    this.setIntervalFn = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.isVisible = opts.isVisible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
  }

  /** 今の接続先の辞書の置き場の ID（保存した接続先・デモの ID、それ以外は Maximo の URL）。つないでいなければ null */
  currentScope(): string | null {
    const c = this.connection.current();
    if (c === null) return null;
    return c.info.savedId ?? c.info.baseUrl;
  }

  start(): void {
    if (this.unsubscribe !== null) return;
    const offConnection = this.connection.subscribe(() => {
      if (this.currentScope() !== this.snap.scope) void this.refresh();
    });
    // 閉じたシートは開いている辞書から外す
    const offWorkspace = this.workspace.subscribe((e) => {
      if (e.kind === "sheet_removed" && e.sheet !== null) this.forget(e.sheet);
    });
    this.unsubscribe = () => {
      offConnection();
      offWorkspace();
    };
    this.adopt();
    this.timer = this.setIntervalFn(() => {
      if (this.isVisible()) void this.refresh();
    }, DICTIONARY_POLL_MS);
    void this.refresh();
  }

  /** 別の窓から移してきた作業・再読み込みで戻した作業にある辞書のシートを、開いている辞書として扱う（履歴は読み直す） */
  private adopt(): void {
    for (const [sheet, s] of this.workspace.sheets) {
      const src = s.meta.source;
      if (src.kind !== "dictionary" || this.open.has(sheet)) continue;
      this.open.set(sheet, { sheet, scope: src.scope, id: src.dictionaryId, name: src.dictionaryName, history: [], problems: [], newerBy: null, saving: false, version: "" });
      void this.client.get(src.scope, src.dictionaryId).then((res) => {
        const od = this.open.get(sheet);
        if (!res.ok || !od) return;
        if (this.hasChanges(sheet)) {
          this.open.set(sheet, { ...od, history: res.value.history, problems: res.value.problems, version: res.value.version });
          this.emit();
        } else {
          this.load(sheet, src.scope, res.value);
        }
      });
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  setNotifier(fn: Notify): void {
    this.notify = fn;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): DictionarySnapshot {
    return this.snap;
  }

  /** 開いている辞書（シートの名前で） */
  openOf(sheet: string): OpenDictionary | null {
    return this.open.get(sheet) ?? null;
  }

  private emit(): void {
    for (const l of Array.from(this.listeners)) {
      try {
        l();
      } catch {
        // 通知先の例外で止めない
      }
    }
  }

  private set(next: Partial<DictionarySnapshot>): void {
    this.snap = { ...this.snap, ...next };
    this.emit();
  }

  /** 一覧を読み直す。印が変わっていれば、開いている辞書を新しくする */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const scope = this.currentScope();
    if (scope === null) {
      this.set({ scope: null, status: "idle", listing: null, error: null });
      return;
    }
    const changedScope = scope !== this.snap.scope;
    if (changedScope) this.set({ scope, status: "loading", listing: null, error: null });
    const res = await this.client.list(scope);
    if (this.currentScope() !== scope) return;
    if (!res.ok) {
      this.set({ status: "failed", error: res.message });
      return;
    }
    const before = this.snap.listing?.version ?? null;
    this.set({ status: "ready", listing: res.value, error: null });
    if (!changedScope && before !== null && res.value.version !== null && res.value.version !== before) await this.pullRemote(scope, res.value);
  }

  /** ほかのメンバーの保存を、開いている辞書に取り込む */
  private async pullRemote(scope: string, listing: DictionaryListing): Promise<void> {
    for (const od of Array.from(this.open.values())) {
      if (od.scope !== scope || od.saving) continue;
      const summary = listing.dictionaries.find((d) => d.id === od.id);
      if (!summary) continue;
      const res = await this.client.get(scope, od.id);
      if (!res.ok || res.value.version === od.version) continue;
      const latest = res.value.history[0];
      const by = latest && latest.byId !== listing.member.id ? latest.by : null;
      if (by === null) {
        // 自分の保存（別の窓から）。黙って新しくする
        if (!this.hasChanges(od.sheet)) this.load(od.sheet, scope, res.value);
        continue;
      }
      if (this.hasChanges(od.sheet)) {
        this.open.set(od.sheet, { ...od, newerBy: by });
        this.emit();
      } else {
        this.load(od.sheet, scope, res.value);
        this.notify(dictionaryMessages().toasts.remoteSaved(by, od.name), "info");
      }
    }
  }

  private hasChanges(sheet: string): boolean {
    if (!this.workspace.hasSheet(sheet)) return false;
    const s = this.workspace.summary(sheet);
    return s.changedCells + s.addedRows + s.deletedRows > 0;
  }

  /** 辞書の名前に合うシートの名前（データのシートと名前が重なれば「（辞書）」を付ける） */
  private sheetNameFor(name: string, id: string): string {
    for (const [sheet, od] of this.open) if (od.id === id && this.workspace.hasSheet(sheet)) return sheet;
    const taken = (n: string) => this.workspace.hasSheet(n) && this.workspace.getSheet(n).meta.source.kind !== "dictionary";
    if (!taken(name)) return name;
    const suffixed = `${name} (${dictionaryMessages().menu.button})`;
    return taken(suffixed) ? `${name} [${id.slice(2, 8)}]` : suffixed;
  }

  /** 辞書の中身でシートを作る（同じ名前のシートは置き換える） */
  private load(sheet: string, scope: string, state: DictionaryState): void {
    const ref = { id: state.dictionary.id, name: state.dictionary.name, kind: state.dictionary.kind, scope };
    this.workspace.createSheet(dictionarySheetMeta(sheet, ref), entriesToRows(state.entries));
    this.open.set(sheet, { sheet, scope, id: ref.id, name: ref.name, history: state.history, problems: state.problems, newerBy: null, saving: false, version: state.version });
    this.emit();
  }

  /** 名前か ID で辞書を開く（開いていればそのまま）。開いたシートの名前を返す */
  async openDictionary(nameOrId: string): Promise<BridgeResult<{ sheet: string; state: DictionaryState }>> {
    const scope = this.currentScope();
    if (scope === null) return { ok: false, error: "not_connected", message: dictionaryMessages().menu.notConnected, status: 0 };
    for (const od of this.open.values()) {
      if (od.scope === scope && (od.id === nameOrId || od.name === nameOrId) && this.workspace.hasSheet(od.sheet)) {
        return { ok: true, value: { sheet: od.sheet, state: { dictionary: { id: od.id, name: od.name, kind: "alias", description: "", createdAt: "", createdBy: "" }, entries: [], history: od.history, problems: od.problems, version: od.version } } };
      }
    }
    const res = await this.client.get(scope, nameOrId);
    if (!res.ok) return res;
    const sheet = this.sheetNameFor(res.value.dictionary.name, res.value.dictionary.id);
    this.load(sheet, scope, res.value);
    return { ok: true, value: { sheet, state: res.value } };
  }

  async createDictionary(name: string, description?: string): Promise<BridgeResult<{ sheet: string; state: DictionaryState }>> {
    const scope = this.currentScope();
    if (scope === null) return { ok: false, error: "not_connected", message: dictionaryMessages().menu.notConnected, status: 0 };
    const res = await this.client.create(scope, name, "alias", description);
    if (!res.ok) return res;
    const sheet = this.sheetNameFor(res.value.dictionary.name, res.value.dictionary.id);
    this.load(sheet, scope, res.value);
    void this.refresh();
    return { ok: true, value: { sheet, state: res.value } };
  }

  /** 保存前の変更を保存する。使えない項目があれば保存しない */
  async save(sheet: string): Promise<{ ok: true; saved: number } | { ok: false; message: string; problems?: number }> {
    const od = this.open.get(sheet);
    if (!od || !this.workspace.hasSheet(sheet)) return { ok: false, message: "not open" };
    const t = dictionaryMessages().panel;
    const pending = pendingChanges(this.workspace.getSheet(sheet));
    if (pending.problems.length > 0) {
      const first = pending.problems[0]!;
      return { ok: false, message: `${t.problems(pending.problems.length)} ${problemText(first.problem)}`, problems: pending.problems.length };
    }
    if (pending.ops.length === 0) return { ok: true, saved: 0 };
    this.open.set(sheet, { ...od, saving: true });
    this.emit();
    const res = await this.client.save(od.scope, od.id, pending.ops);
    const cur = this.open.get(sheet);
    if (!res.ok) {
      if (cur) this.open.set(sheet, { ...cur, saving: false });
      this.emit();
      return { ok: false, message: res.error === "unreachable" || res.status === 0 ? t.unreachable : res.message };
    }
    this.load(sheet, od.scope, res.value);
    void this.refresh();
    return { ok: true, saved: pending.ops.length };
  }

  async revert(sheet: string, saveId: string): Promise<{ ok: true; reverted: number; skipped: number } | { ok: false; message: string }> {
    const od = this.open.get(sheet);
    if (!od) return { ok: false, message: "not open" };
    const res = await this.client.revert(od.scope, od.id, saveId);
    if (!res.ok) return { ok: false, message: res.message };
    if (!this.hasChanges(sheet)) this.load(sheet, od.scope, res.value);
    else {
      this.open.set(sheet, { ...od, history: res.value.history, version: res.value.version });
      this.emit();
    }
    void this.refresh();
    return { ok: true, reverted: res.value.reverted, skipped: res.value.skipped };
  }

  /** シートを閉じたら、開いている辞書から外す */
  forget(sheet: string): void {
    if (this.open.delete(sheet)) this.emit();
  }

  /** 接続先に共有フォルダを付ける・外す */
  async setFolder(scope: string, path: string | null, project?: ProjectInfo): Promise<BridgeResult<DictionaryListing>> {
    const res = await this.client.setFolder(scope, path, project);
    if (res.ok && scope === this.currentScope()) this.set({ status: "ready", listing: res.value, error: null });
    return res;
  }
}
