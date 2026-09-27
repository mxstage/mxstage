// 作業画面 /app: 上部バー（シートタブを含む）、グリッド、サイドパネル（表示の切替・反映・変更履歴）。
// 保存・確定ボタンは置かない（グリッドの変更はその場で作業状態に入る）。

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Runtime } from "../boot/runtime";
import type { ObjectStructureCatalog } from "../catalog/catalog";
import { formatCellValue } from "../grid/cellStyle";
import { SheetGrid, type LinkFilter } from "../grid/SheetGrid";
import type { VaultView } from "../keyvault/client";
import type { ViewKind } from "../store";
import { Corners } from "../ui/Corners";
import { Link } from "../ui/Link";
import { SETTINGS_PATH } from "../ui/routes";
import { Toasts, type ToastStore } from "../ui/toast";
import { CommitPanel } from "./CommitPanel";
import { HistoryPanel } from "./HistoryPanel";
import { useFrameVersion, useWindowWidth } from "./hooks";
import { HIDE_SIDE_WIDTH, showOnePane } from "../grid/layout";
import { PaneBar } from "./PaneBar";
import { PANE_DRAG_TYPE, PaneHeader } from "./PaneHeader";
import { addPane, arrangePanes, EMPTY_LAYOUT, ownPanes, panesFor, swapPanes, togglePane, type LayoutChange, type PaneLayout, type PaneSpec } from "./panes";
import { closeSheet, SheetTabs, type SheetTabInfo } from "./SheetTabs";
import { hostOf, maximoBadge, relayBadge, reopenHint, shouldSuggestReopen } from "./status";
import { TopBar } from "./TopBar";

/** どのペインのどの行を選んだか（他のペインをこれに連動させる） */
interface LinkedSelection {
  paneKey: string;
  sheet: string;
  parentKey: string;
  /** 参照先のマスタを絞るための値（ペインのつながりで使う列だけ） */
  values: Record<string, string>;
}

/** そのペインを、選ばれた行にどう連動させるか（選んだペイン自身は絞らない） */
export function paneLink(pane: PaneSpec, linked: LinkedSelection): LinkFilter | null {
  if (pane.key === linked.paneKey) return null;
  if (pane.link !== undefined) {
    if (pane.link.sheet !== linked.sheet) return null;
    const value = linked.values[pane.link.from];
    return value === undefined || value === "" ? null : { kind: "value", col: pane.link.to, value };
  }
  if (pane.sheet !== linked.sheet) return null;
  return { kind: "parent", parentKey: linked.parentKey };
}

export interface AppVault {
  getView(): VaultView;
  subscribe(listener: () => void): () => void;
}

export interface AppPageProps {
  runtime: Runtime;
  vault: AppVault;
  toasts: ToastStore;
  /** オブジェクト構造の読み込みの進み具合を上部バーに出す */
  catalog?: ObjectStructureCatalog;
  onEndWork: () => void;
  confirm?: (message: string) => boolean;
  reload?: () => void;
}

const VIEWS: Array<{ kind: ViewKind; label: string }> = [
  { kind: "final", label: "最終" },
  { kind: "diff", label: "差分" },
  { kind: "base", label: "元の値" },
];

export function AppPage({ runtime, vault, toasts, catalog, onEndWork, confirm, reload }: AppPageProps) {
  const { workspace, commits } = runtime;
  const confirmFn = confirm ?? ((m: string) => window.confirm(m));
  const reloadFn = reload ?? (() => window.location.reload());

  const wsSubscribe = useCallback((l: () => void) => workspace.subscribe(() => l()), [workspace]);
  const version = useFrameVersion(wsSubscribe);
  const commitSubscribe = useCallback((l: () => void) => commits.subscribe(() => l()), [commits]);
  const commitVersion = useFrameVersion(commitSubscribe);
  const vaultView = useSyncExternalStore(
    useCallback((l: () => void) => vault.subscribe(l), [vault]),
    useCallback(() => vault.getView(), [vault]),
  );
  const relayStatus = useSyncExternalStore(
    useCallback((l: () => void) => runtime.subscribeRelay(l), [runtime]),
    useCallback(() => runtime.relayStatus(), [runtime]),
  );

  const onMessage = useCallback((text: string, tone: "info" | "error") => toasts.show(text, tone), [toasts]);

  // 開いているシートタブ（選択中のシートが消えたら先頭へ）。窓に並べる表の組はこのシートから決める
  const sheetNames = Array.from(workspace.sheets.keys());
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected !== null && workspace.hasSheet(selected) ? selected : (sheetNames[0] ?? null);
  // 最後に触った表のシート（反映・変更履歴のパネルはこのシートを出す）。組に無い表を足すと、タブのシートと違うことがある
  const [focused, setFocused] = useState<string | null>(null);
  const [view, setView] = useState<ViewKind>("final");

  const isRunning = (sheet: string) => {
    try {
      return commits.isRunning(sheet);
    } catch {
      return false;
    }
  };

  // 関連する表（親・子・参照先のマスタ）の組を同時に出す。行を選ぶと他のペインがその行に連動する。
  // 組に利用者の並べ方（隠す・戻す・入れ替える・組に無い表を足す）を重ねる。並べ方は組ごとに覚える
  const metas = useMemo(() => Array.from(workspace.sheets.values()).map((s) => s.meta), [workspace, version]);
  const group = useMemo(() => (current === null ? [] : panesFor(metas, current, Number.POSITIVE_INFINITY)), [metas, current]);
  const groupKey = group[0]?.sheet ?? current ?? "";
  const [layouts, setLayouts] = useState<Record<string, PaneLayout>>({});
  const layout = layouts[groupKey] ?? EMPTY_LAYOUT;
  const candidates = useMemo(() => new Map(metas.flatMap(ownPanes).map((p) => [p.key, p] as const)), [metas]);
  const arranged = useMemo(() => arrangePanes(group, candidates, layout), [group, candidates, layout]);
  const panes = arranged.shown;
  const addable = useMemo(() => Array.from(candidates.values()).filter((p) => !arranged.all.some((a) => a.key === p.key)), [candidates, arranged]);
  const applyLayout = (change: LayoutChange) => {
    if ("error" in change) {
      toasts.show(change.error, "error");
      return;
    }
    setLayouts((all) => ({ ...all, [groupKey]: change.layout }));
  };
  // ペインをつかんで落とす先（落とせる所を示す）
  const [dropKey, setDropKey] = useState<string | null>(null);
  const focusSheet = focused !== null && panes.some((p) => p.sheet === focused) ? focused : current;
  const busy = focusSheet !== null && isRunning(focusSheet);
  const linkColumns = useMemo(() => Array.from(new Set(panes.flatMap((p) => (p.link ? [p.link.from] : [])))), [panes]);
  const [linked, setLinked] = useState<LinkedSelection | null>(null);
  // 1 つの表だけを広げているか（列が多い表を見るため）
  const [maximized, setMaximized] = useState<string | null>(null);
  // 画面の幅。狭いとき（チャットと半々に並べたときなど）は表を並べない
  const windowWidth = useWindowWidth();
  const narrow = showOnePane(windowWidth);
  // 反映と変更履歴のパネルを出すか（隠すと表を広く使える）。狭い画面では初めから隠す
  const [sidePanel, setSidePanel] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= HIDE_SIDE_WIDTH));
  const shownPanes = useMemo(() => {
    if (maximized !== null) return panes.filter((p) => p.key === maximized);
    // 狭い画面で並べると 1 列しか見えないので、今のシートの表だけを出す（ほかの表はタブで切り替える）
    if (narrow) {
      const own = panes.filter((p) => p.sheet === focusSheet);
      return own.length > 0 ? own.slice(0, 1) : panes.slice(0, 1);
    }
    return panes;
  }, [panes, maximized, narrow, focusSheet]);
  // シートを切り替えたら連動は解く（別の組の行を指したままにしない）
  useEffect(() => setLinked(null), [current]);
  // 広げていた表が無くなったら元に戻す
  useEffect(() => {
    if (maximized !== null && !panes.some((p) => p.key === maximized)) setMaximized(null);
  }, [panes, maximized]);

  // 再接続までの残り秒数を数える
  const [now, setNow] = useState(() => Date.now());
  const [retryAt, setRetryAt] = useState<number | null>(null);
  useEffect(() => {
    if (relayStatus.state !== "reconnecting" || relayStatus.nextRetryMs === null) {
      setRetryAt(null);
      return undefined;
    }
    setRetryAt(Date.now() + relayStatus.nextRetryMs);
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [relayStatus]);

  // 再接続が続いたら、作業画面を開き直す案内を出す（WebSocket では鍵切れも回線断も同じ見え方になる）
  const suggestReopen = shouldSuggestReopen(relayStatus);
  const reopen = suggestReopen ? reopenHint() : null;

  const tabInfos: SheetTabInfo[] = sheetNames.map((name) => {
    const s = workspace.sheets.get(name);
    const counts = s ? s.counts() : null;
    // どのオブジェクト構造（と接続先）から読み込んだか。反映もこの構造に対して行う
    const src = s?.meta.source;
    const info: SheetTabInfo = { name, changes: counts ? counts.changedCells + counts.addedRows + counts.deletedRows : 0 };
    if (src?.kind === "maximo") info.origin = `${src.os}${src.baseUrl ? `（${hostOf(src.baseUrl)}）` : ""} から読み込み`;
    else if (src?.kind === "excel") info.origin = `${src.fileName} の ${src.sheetName} から取り込み`;
    return info;
  });
  const sheetTabs = (
    <SheetTabs
      tabs={tabInfos}
      current={current}
      onSelect={(name) => {
        setSelected(name);
        setFocused(name);
      }}
      onClose={(name) => {
        // 要らなくなったシートを閉じる（作業から外す）。未反映の変更があれば確かめ、反映中は閉じない
        if (closeSheet(name, { workspace, isRunning, confirm: confirmFn, notify: onMessage }) && maximized?.startsWith(`${name}::`)) setMaximized(null);
      }}
    />
  );

  return (
    <div className="app">
      <TopBar
        relay={relayBadge(relayStatus, retryAt !== null ? retryAt - now : null)}
        maximo={maximoBadge(vaultView)}
        reopen={reopen}
        workspaceName={workspace.name}
        catalog={catalog}
        baseUrl={vaultView.kind === "disconnected" ? null : vaultView.info.baseUrl}
        tabs={sheetTabs}
        sidePanel={sidePanel}
        onToggleSide={() => setSidePanel((s) => !s)}
        viewHint={view === "final" ? null : (VIEWS.find((v) => v.kind === view)?.label ?? null)}
        onReload={() => {
          if (confirmFn("再読み込みすると、このタブの作業データと API キーは消えます。再読み込みしますか？")) reloadFn();
        }}
        onEndWork={() => {
          if (confirmFn("作業を終了しますか？ すべてのシートと変更履歴を破棄します（Maximo には反映されません）。")) onEndWork();
        }}
      />
      <div className={`workarea${sidePanel ? "" : " no-side"}`}>
        <div className="grid-area">
          {current === null ? (
            <div className="empty">
              <p>シートはまだありません。</p>
              <p className="muted">
                LLM クライアントから読み込むと、ここにシートが増えます。LLM クライアントの接続方法は <Link to={SETTINGS_PATH}>設定</Link> にあります。
              </p>
            </div>
          ) : (
            <>
              {busy && <div className="busy-banner">Maximo に反映中のため、このシートは編集できません。</div>}
              {(arranged.all.length > 1 || addable.length > 0) && (
                <PaneBar
                  panes={arranged.all}
                  addable={addable}
                  onToggle={(key) => applyLayout(togglePane(layout, arranged, key))}
                  onAdd={(key) => applyLayout(addPane(layout, arranged, key))}
                />
              )}
              <div className={`panes blueprint count-${shownPanes.length}`}>
                <Corners />
                {shownPanes.length === 0 && <div className="empty">表をすべて隠しています。上の「表示する表」から出してください。</div>}
                {shownPanes.map((pane) => (
                  <section
                    key={pane.key}
                    className={`pane${dropKey === pane.key ? " drop-over" : ""}`}
                    aria-label={`${pane.title}（${pane.subtitle}）`}
                    aria-current={pane.sheet === focusSheet}
                    onDragOver={(e) => {
                      if (!Array.from(e.dataTransfer.types).includes(PANE_DRAG_TYPE)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dropKey !== pane.key) setDropKey(pane.key);
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropKey((k) => (k === pane.key ? null : k));
                    }}
                    onDrop={(e) => {
                      const from = e.dataTransfer.getData(PANE_DRAG_TYPE);
                      setDropKey(null);
                      if (from === "" || from === pane.key) return;
                      e.preventDefault();
                      applyLayout({ layout: swapPanes(layout, arranged, from, pane.key) });
                    }}
                  >
                    <SheetGrid
                      renderHeader={(h) => (
                        <PaneHeader
                          title={pane.title}
                          subtitle={pane.subtitle}
                          current={pane.sheet === focusSheet}
                          onSelect={() => setFocused(pane.sheet)}
                          dragKey={shownPanes.length > 1 ? pane.key : undefined}
                          onHide={arranged.all.length > 1 ? () => applyLayout(togglePane(layout, arranged, pane.key)) : undefined}
                          onUnlink={linked !== null && paneLink(pane, linked) !== null ? () => setLinked(null) : undefined}
                          rowCount={h.rowCount}
                          rowCountTitle={h.rowCountTitle}
                          detailOpen={h.detailOpen}
                          onToggleDetail={h.toggleDetail}
                          maximize={
                            panes.length > 1
                              ? { pressed: maximized === pane.key, onToggle: () => setMaximized((m) => (m === pane.key ? null : pane.key)) }
                              : undefined
                          }
                        />
                      )}
                      workspace={workspace}
                      sheetName={pane.sheet}
                      view={view}
                      version={version}
                      isBusy={() => commits.isRunning(pane.sheet)}
                      onMessage={onMessage}
                      scope={pane.scope}
                      linkFilter={linked === null ? null : paneLink(pane, linked)}
                      onSelectRow={(row) => {
                        setFocused(pane.sheet);
                        if (row === null) {
                          setLinked(null);
                          return;
                        }
                        const sheet = workspace.sheets.get(pane.sheet);
                        const values: Record<string, string> = {};
                        if (sheet) for (const col of linkColumns) values[col] = formatCellValue(sheet.viewValue(row, col, view));
                        setLinked({ paneKey: pane.key, sheet: pane.sheet, parentKey: row.parentKey, values });
                      }}
                    />
                  </section>
                ))}
              </div>
            </>
          )}
        </div>
        {focusSheet !== null && (
          <aside className="side">
            <div className="seg" role="radiogroup" aria-label="表示">
              {VIEWS.map((v) => (
                <label key={v.kind} className={`seg-opt${view === v.kind ? " on" : ""}`}>
                  <input type="radio" name="view" value={v.kind} checked={view === v.kind} onChange={() => setView(v.kind)} />
                  {v.label}
                </label>
              ))}
            </div>
            <CommitPanel
              commits={commits}
              sheet={focusSheet}
              version={commitVersion + version}
              connected={vaultView.kind === "connected"}
              locked={vaultView.kind === "locked"}
              onMessage={onMessage}
            />
            <HistoryPanel workspace={workspace} sheet={focusSheet} version={version} busy={busy} onMessage={onMessage} />
          </aside>
        )}
      </div>
      <Toasts store={toasts} />
    </div>
  );
}
