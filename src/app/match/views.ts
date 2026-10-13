// 突き合わせの結果（作業画面の「突き合わせ先」の列と帯、辞書の「効いた行」）。
// - AI が match_sheets を呼ぶと、左のシートごとに最後の結果を覚える（行ごとの相手・候補・効いた辞書の項目）。
// - 結果が使うシート（左・右・名前を引くシート・辞書）が変わったら、同じ条件で突き合わせ直す（少し待ってまとめて）。
//   辞書を直すと、その場で一致の数と「効いた行」が変わる。
// - シートの値ではない（差分・反映には入らない）。作業を終えると消える。

import { classifyText, replaceValue } from "../../shared/dictionary";
import type { MatchConditions, NormalizeOption, TypedFilter } from "../../shared/model";
import type { Workspace } from "../store";
import type { RowMatch } from "../store/matcher";

export interface MatchArgs {
  left: string;
  right: string;
  leftCol?: string | string[];
  rightCol?: string | string[];
  normalize: NormalizeOption[];
  extra: MatchConditions & { leftFilter?: TypedFilter[] };
}

export interface MatchRowView {
  kind: RowMatch["kind"];
  /** 相手のシートの行キー（一致なら 1 件、候補が複数なら候補） */
  targets: string[];
  label: string;
  /** この行の文を変えた辞書の項目（辞書のシートの行キー） */
  aliases: string[];
  byGroup?: boolean;
  byAbove?: boolean;
}

export interface MatchView {
  args: MatchArgs;
  rows: ReadonlyMap<string, MatchRowView>;
  counts: { matched: number; ambiguous: number; unmatched: number; unmatchedRight: number };
  /** 突き合わせた時刻 */
  at: number;
}

/** 辞書の項目ごとの、効いた行と、候補を増やした行（候補が複数の行） */
export interface EntryHits {
  hits: number;
  ambiguous: number;
}

/** apply_rule で言葉 → コード・値の置き換えの辞書を使ったところ（効いた行を数えるため、最後の使い方を覚える） */
export type DictionaryUse =
  | { kind: "code"; dictionary: string; sheet: string; col: string; textCols: string[]; field: string; scopeCol?: string }
  | { kind: "value"; dictionary: string; sheet: string; col: string; fromCol: string };

const RERUN_DELAY_MS = 400;

export class MatchViewStore {
  private readonly workspace: Workspace;
  private readonly views = new Map<string, MatchView>();
  /** 辞書の名前 + シート + 列 → 使い方 */
  private readonly uses = new Map<string, DictionaryUse>();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubscribe: () => void;
  private readonly now: () => number;

  constructor(workspace: Workspace, now: () => number = Date.now) {
    this.workspace = workspace;
    this.now = now;
    this.unsubscribe = workspace.subscribe((e) => {
      if (e.sheet === null) return;
      for (const [left, v] of this.views) if (dependsOn(v.args, e.sheet, workspace)) this.pending.add(left);
      if (this.pending.size > 0) this.schedule();
    });
  }

  dispose(): void {
    this.unsubscribe();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  get(left: string): MatchView | null {
    return this.views.get(left) ?? null;
  }

  all(): MatchView[] {
    return Array.from(this.views.values());
  }

  clear(left: string): void {
    if (this.views.delete(left)) this.emit();
  }

  /** 突き合わせて覚える（失敗すれば投げる。ツールのエラーと同じ） */
  record(args: MatchArgs): MatchView {
    const view = this.compute(args);
    this.views.set(args.left, view);
    this.emit();
    return view;
  }

  /** 同じ条件で突き合わせ直す。突き合わせられなくなった（シートが無いなど）ら忘れる */
  rerun(left: string): MatchView | null {
    const v = this.views.get(left);
    if (!v) return null;
    try {
      return this.record(v.args);
    } catch {
      this.views.delete(left);
      this.emit();
      return null;
    }
  }

  /** 引数に辞書を足して突き合わせ直す（「読み替えを足す」で、まだ辞書を使っていなかったとき） */
  rerunWithDictionary(left: string, dictionary: string): MatchView | null {
    const v = this.views.get(left);
    if (!v) return null;
    const names = v.args.extra.dictionaries ?? [];
    const args: MatchArgs = names.includes(dictionary) ? v.args : { ...v.args, extra: { ...v.args.extra, dictionaries: [...names, dictionary] } };
    return this.record(args);
  }

  /** apply_rule で言葉 → コード・値の置き換えの辞書を使った（効いた行に出す） */
  recordUse(use: DictionaryUse): void {
    this.uses.set(`${use.dictionary}\u0000${use.sheet}\u0000${use.col}`, use);
    this.emit();
  }

  /**
   * 辞書の項目ごとの効いた行。呼び名はその辞書を使った突き合わせの結果から、
   * 言葉 → コード・値の置き換えは最後に使ったシートの今の値から数える
   */
  hitsFor(dictionaryName: string): { used: boolean; hits: Map<string, EntryHits> } {
    const hits = new Map<string, EntryHits>();
    let used = false;
    const add = (ids: readonly string[], ambiguous: boolean) => {
      for (const id of ids) {
        const h = hits.get(id) ?? { hits: 0, ambiguous: 0 };
        h.hits++;
        if (ambiguous) h.ambiguous++;
        hits.set(id, h);
      }
    };
    for (const use of this.uses.values()) {
      if (use.dictionary !== dictionaryName || !this.workspace.hasSheet(use.sheet)) continue;
      const sheet = this.workspace.getSheet(use.sheet);
      try {
        if (use.kind === "code") {
          const rules = this.workspace.codeRules(use.dictionary);
          used = true;
          for (const r of sheet.viewRows("final")) {
            const text = use.textCols.map((c) => (sheet.hasColumn(c) ? String(sheet.finalValue(r, c) ?? "") : "")).join(" ");
            const scope = use.scopeCol !== undefined && sheet.hasColumn(use.scopeCol) ? String(sheet.finalValue(r, use.scopeCol) ?? "") : null;
            const res = classifyText(rules, text, use.field, scope);
            add(res.applied, res.kind === "ambiguous");
          }
        } else {
          const rules = this.workspace.valueRules(use.dictionary);
          used = true;
          if (!sheet.hasColumn(use.fromCol)) continue;
          for (const r of sheet.viewRows("final")) {
            const v = sheet.finalValue(r, use.fromCol);
            if (v === null || v === "") continue;
            const res = replaceValue(rules, use.col, String(v));
            if (res.kind !== "none") add(res.applied, res.kind === "ambiguous");
          }
        }
      } catch {
        // 辞書が閉じられた・種類が違う: 数えない
      }
    }
    for (const v of this.views.values()) {
      if (!(v.args.extra.dictionaries ?? []).includes(dictionaryName)) continue;
      used = true;
      for (const row of v.rows.values()) {
        for (const id of row.aliases) {
          const h = hits.get(id) ?? { hits: 0, ambiguous: 0 };
          h.hits++;
          if (row.kind === "ambiguous") h.ambiguous++;
          hits.set(id, h);
        }
      }
    }
    return { used, hits };
  }

  private compute(args: MatchArgs): MatchView {
    const d = this.workspace.matchDetail(args.left, args.right, args.leftCol, args.rightCol, args.normalize, args.extra);
    const rows = new Map<string, MatchRowView>();
    const counts = { matched: 0, ambiguous: 0, unmatched: 0, unmatchedRight: 0 };
    const hit = new Set<string>();
    for (const { rowKey, match: m } of d.rows) {
      const aliases = m.aliases ?? [];
      if (m.kind === "matched") {
        counts.matched++;
        hit.add(m.id);
        rows.set(rowKey, { kind: "matched", targets: [d.targetRowKey(m.id)], label: m.label, aliases, ...(m.byGroup ? { byGroup: true } : {}), ...(m.byAbove ? { byAbove: true } : {}) });
      } else if (m.kind === "ambiguous") {
        counts.ambiguous++;
        for (const id of m.ids) hit.add(id);
        rows.set(rowKey, { kind: "ambiguous", targets: m.ids.map((id) => d.targetRowKey(id)), label: m.label, aliases });
      } else {
        counts.unmatched++;
        rows.set(rowKey, { kind: "unmatched", targets: [], label: m.label, aliases });
      }
    }
    counts.unmatchedRight = d.targetIds.filter((id) => !hit.has(id)).length;
    // 左を親で数えたときは、同じ親の子の行にも同じ結果を出す（表では子の行も並ぶため）
    if (d.byParent && this.workspace.hasSheet(args.left)) {
      const sheet = this.workspace.getSheet(args.left);
      const byParent = new Map<string, MatchRowView>();
      for (const [rowKey, view] of rows) {
        const r = sheet.row(rowKey);
        if (r) byParent.set(r.parentKey, view);
      }
      for (const r of sheet.viewRows("final")) {
        if (!rows.has(r.rowKey)) {
          const v = byParent.get(r.parentKey);
          if (v) rows.set(r.rowKey, v);
        }
      }
    }
    return { args, rows, counts, at: this.now() };
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const lefts = Array.from(this.pending);
      this.pending.clear();
      for (const left of lefts) this.rerun(left);
    }, RERUN_DELAY_MS);
  }
}

/** その突き合わせが、このシートの値を使うか（左・右・名前を引くシート・辞書） */
function dependsOn(args: MatchArgs, sheet: string, ws: Workspace): boolean {
  if (sheet === args.left || sheet === args.right) return true;
  if (args.extra.contains?.via?.sheet === sheet) return true;
  for (const name of args.extra.dictionaries ?? []) {
    const d = ws.dictionarySheet(name);
    if (d !== null && d.meta.name === sheet) return true;
  }
  return false;
}
