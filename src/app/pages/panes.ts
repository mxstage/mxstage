// 関連する表を同時に見せるための「ペイン」の決め方（純ロジック）。
//
// 1 回の作業で見る表は 1 つではない。工事管理を直すには、その子（複数機器）と、参照先の機器台帳・ロケーションを
// 同時に見る必要がある。シートをタブで 1 枚ずつ切り替える作りだと、他の表が見えないまま作業することになる。
//
// - 親（工事管理）と子（複数機器）は 1 枚のシートに平坦に入っている（Maximo へ反映するときの単位がこれ）。
//   画面では親の列だけ／子の列だけに分けて別のペインに出す。編集はどちらも同じシートの同じ行に入る。
// - load_master で読んだマスタ（機器台帳・ロケーション）は別のシートで、meta.link で参照元とつながっている。

import type { SheetLink, SheetMeta } from "../../shared/sheet";

export type PaneScope = { kind: "all" } | { kind: "parent" } | { kind: "child"; name: string };

export interface PaneSpec {
  /** React の key と、ペインの識別（シート名＋範囲） */
  key: string;
  /** ペインの見出し */
  title: string;
  /** 見出しの下の説明（どのシートの何か） */
  subtitle: string;
  sheet: string;
  scope: PaneScope;
  /** 参照元とのつながり（選んだ行に連動させる） */
  link?: SheetLink;
}

export const MAX_PANES = 4;

/**
 * いま見ているシートを含む「関連する表」をペインの一覧にする。
 * 並びは 親 → 子（複数あれば定義の順）→ 参照先のマスタ。max を超える分は落とす（落ちた数は呼び出し側で出す）。
 */
export function panesFor(metas: readonly SheetMeta[], current: string, max: number = MAX_PANES): PaneSpec[] {
  const byName = new Map(metas.map((m) => [m.name, m]));
  const currentMeta = byName.get(current);
  if (currentMeta === undefined) return [];
  // マスタのシートを見ているときは、その参照元の組を出す
  const rootName = currentMeta.link !== undefined && byName.has(currentMeta.link.sheet) ? currentMeta.link.sheet : current;
  const root = byName.get(rootName) as SheetMeta;

  const panes: PaneSpec[] = [];
  const children = Object.keys(root.childIdAttrs);
  if (children.length === 0) {
    panes.push({ key: `${root.name}::all`, title: root.name, subtitle: sourceLabel(root), sheet: root.name, scope: { kind: "all" } });
  } else {
    panes.push({ key: `${root.name}::parent`, title: root.name, subtitle: sourceLabel(root), sheet: root.name, scope: { kind: "parent" } });
    for (const child of children) {
      panes.push({ key: `${root.name}::child:${child}`, title: child, subtitle: `${root.name} の子`, sheet: root.name, scope: { kind: "child", name: child } });
    }
  }
  for (const m of metas) {
    if (m.link === undefined || m.link.sheet !== root.name) continue;
    panes.push({ key: `${m.name}::all`, title: m.name, subtitle: `${m.link.from} → ${m.link.to}`, sheet: m.name, scope: { kind: "all" }, link: m.link });
  }
  // いま見ているシートのペインは必ず残す
  const kept = panes.slice(0, Math.max(1, max));
  if (!kept.some((p) => p.sheet === current)) {
    const mine = panes.find((p) => p.sheet === current);
    if (mine !== undefined) kept.splice(kept.length - 1, 1, mine);
  }
  return kept;
}

function sourceLabel(meta: SheetMeta): string {
  return meta.source.kind === "maximo" ? meta.source.os : meta.source.kind === "excel" ? meta.source.fileName : "シート";
}

/** ペインに出す列（親のペインは親の列だけ、子のペインはキー列とその子の列だけ） */
export function scopeColumns<T extends { name: string; child?: string }>(columns: readonly T[], keyColumns: readonly string[], scope: PaneScope): T[] {
  if (scope.kind === "all") return [...columns];
  if (scope.kind === "parent") return columns.filter((c) => c.child === undefined);
  const keys = new Set(keyColumns.map((k) => k.toUpperCase()));
  return columns.filter((c) => (c.child === undefined && keys.has(c.name.toUpperCase())) || c.child === scope.name);
}

/** ペインに出す行（親のペインは親ごとに 1 行、子のペインはその子の行だけ） */
export function scopeRows<T extends { parentKey: string; childName: string | null }>(rows: readonly T[], scope: PaneScope): T[] {
  if (scope.kind === "all") return [...rows];
  if (scope.kind === "child") return rows.filter((r) => r.childName === scope.name);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.parentKey)) continue;
    seen.add(r.parentKey);
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 並べ方（利用者が隠す・戻す・入れ替える・組に無い表を足す）
//
// 組（親・子・参照先のマスタ）は今までどおり自動で決め、その上に利用者の並べ方を重ねる。
// 並べ方はシートの組ごとに持つ（タブを切り替えて戻ると同じ並び）。窓は MAX_PANES 枚まで。
// ---------------------------------------------------------------------------

export interface PaneLayout {
  /** 並び（ペインのキー）。ここに無いペインは後ろに足す */
  order: string[];
  /** 隠したペイン */
  hidden: string[];
  /** 組に無いのに足したペイン（別のシートの表） */
  extras: string[];
}

export const EMPTY_LAYOUT: PaneLayout = { order: [], hidden: [], extras: [] };

export interface ArrangedPane extends PaneSpec {
  /** 窓に出しているか */
  shown: boolean;
  /** 組に無いのに足したペインか */
  extra: boolean;
}

export interface ArrangedPanes {
  /** 組と足したペイン（並びの順。隠したものも含む） */
  all: ArrangedPane[];
  /** 窓に出すペイン（並びの順。MAX_PANES 枚まで） */
  shown: PaneSpec[];
}

/** 1 つのシート自身のペイン（子があれば親と子ごと、無ければ全体）。「表を足す」の候補にする */
export function ownPanes(meta: SheetMeta): PaneSpec[] {
  const children = Object.keys(meta.childIdAttrs);
  if (children.length === 0) return [{ key: `${meta.name}::all`, title: meta.name, subtitle: sourceLabel(meta), sheet: meta.name, scope: { kind: "all" } }];
  return [
    { key: `${meta.name}::parent`, title: meta.name, subtitle: sourceLabel(meta), sheet: meta.name, scope: { kind: "parent" } },
    ...children.map((child) => ({ key: `${meta.name}::child:${child}`, title: child, subtitle: `${meta.name} の子`, sheet: meta.name, scope: { kind: "child" as const, name: child } })),
  ];
}

/**
 * 組のペインと足したペインに、利用者の並べ方を重ねる。
 * 隠していないペインを並びの順に max 枚まで出す（あふれた分は出さず、帯で選べるようにする）
 */
export function arrangePanes(group: readonly PaneSpec[], candidates: ReadonlyMap<string, PaneSpec>, layout: PaneLayout, max: number = MAX_PANES): ArrangedPanes {
  const groupKeys = new Set(group.map((p) => p.key));
  const extras = layout.extras.flatMap((k) => {
    const p = candidates.get(k);
    return p !== undefined && !groupKeys.has(k) ? [p] : [];
  });
  const extraKeys = new Set(extras.map((p) => p.key));
  const byKey = new Map([...group, ...extras].map((p) => [p.key, p]));
  const keys = [...layout.order.filter((k) => byKey.has(k)), ...Array.from(byKey.keys()).filter((k) => !layout.order.includes(k))];
  const hidden = new Set(layout.hidden);
  const shownKeys: string[] = [];
  for (const k of keys) if (!hidden.has(k) && shownKeys.length < max) shownKeys.push(k);
  const shownSet = new Set(shownKeys);
  return {
    all: keys.map((k) => ({ ...(byKey.get(k) as PaneSpec), shown: shownSet.has(k), extra: extraKeys.has(k) })),
    shown: shownKeys.map((k) => byKey.get(k) as PaneSpec),
  };
}

export type LayoutChange = { layout: PaneLayout } | { error: string };

export function tooManyPanes(max: number = MAX_PANES): string {
  return `表は ${max} 枚まで並べられます。ほかの表を隠してから出してください。`;
}

/** 窓に出す・隠す。足したペインを隠したら、組から外す（帯からも消える。「表を足す」で戻せる） */
export function togglePane(layout: PaneLayout, arranged: ArrangedPanes, key: string, max: number = MAX_PANES): LayoutChange {
  const pane = arranged.all.find((p) => p.key === key);
  if (pane === undefined) return { layout };
  if (pane.shown) {
    if (pane.extra) return { layout: { ...layout, extras: layout.extras.filter((k) => k !== key), hidden: layout.hidden.filter((k) => k !== key) } };
    return { layout: { ...layout, hidden: [...layout.hidden.filter((k) => k !== key), key] } };
  }
  if (arranged.shown.length >= max) return { error: tooManyPanes(max) };
  return { layout: { ...layout, hidden: layout.hidden.filter((k) => k !== key) } };
}

/** 組に無い表を足す（窓に空きが無ければ足さない） */
export function addPane(layout: PaneLayout, arranged: ArrangedPanes, key: string, max: number = MAX_PANES): LayoutChange {
  if (arranged.all.some((p) => p.key === key && p.shown)) return { layout };
  if (arranged.shown.length >= max) return { error: tooManyPanes(max) };
  return {
    layout: {
      order: [...arranged.all.map((p) => p.key).filter((k) => k !== key), key],
      hidden: layout.hidden.filter((k) => k !== key),
      extras: layout.extras.includes(key) ? layout.extras : [...layout.extras, key],
    },
  };
}

/** 2 つのペインの位置を入れ替える */
export function swapPanes(layout: PaneLayout, arranged: ArrangedPanes, a: string, b: string): PaneLayout {
  const order = arranged.all.map((p) => p.key);
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0 || i === j) return layout;
  [order[i], order[j]] = [order[j] as string, order[i] as string];
  return { ...layout, order };
}

// ---------------------------------------------------------------------------
// 窓の大きさ（ペインの間の境目をつかんで動かす）
//
// 並べ方は 2 列（count-2/3/4）と 2 段（count-3/4）なので、列の境目と段の境目の 2 つの割合だけを持つ。
// 4 枚のときは上下の段で列の境目を共有する（境目が揃っていたほうが表を見比べやすい）。
// ---------------------------------------------------------------------------

export interface PaneSplit {
  /** 左の列の幅の割合（0〜1） */
  col: number;
  /** 上の段の高さの割合（0〜1） */
  row: number;
}

export const EVEN_SPLIT: PaneSplit = { col: 0.5, row: 0.5 };

/** 窓がこれより細く・低くならないようにする（表の見出しと数行は見えるように） */
export const MIN_PANE_PX = 160;

/** 境目の割合を、両側が MIN_PANE_PX 以上残るように収める。大きさが分からない（0）ときは 1 割〜9 割 */
export function clampSplit(ratio: number, size: number, minPx: number = MIN_PANE_PX): number {
  const min = size > 0 ? Math.min(0.5, Math.max(0.1, minPx / size)) : 0.1;
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(1 - min, Math.max(min, ratio));
}

/** 窓の枚数に応じた、列と段の境目があるか */
export function splitAxes(count: number): { col: boolean; row: boolean } {
  return { col: count >= 2, row: count >= 3 };
}

/** 窓を並べる grid の列と段の大きさ（fr の比で渡す。合計を 1 未満にすると余白が残るので 100 に揃える） */
export function paneGridTemplate(count: number, split: PaneSplit): { columns?: string; rows?: string } {
  const axes = splitAxes(count);
  const fr = (a: number) => `minmax(0, ${(a * 100).toFixed(2)}fr) minmax(0, ${((1 - a) * 100).toFixed(2)}fr)`;
  return {
    ...(axes.col ? { columns: fr(split.col) } : {}),
    ...(axes.row ? { rows: fr(split.row) } : {}),
  };
}
