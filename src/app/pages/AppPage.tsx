// 作業画面 /app: 上部バー（シートタブを含む）、グリッド、サイドパネル（表示の切替・反映・変更履歴）。
// 保存・確定ボタンは置かない（グリッドの変更はその場で作業状態に入る）。

import { Button, ContentSwitcher, Switch } from "@carbon/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Runtime } from "../boot/runtime";
import type { ObjectStructureCatalog } from "../catalog/catalog";
import type { LicenseClient } from "../license/client";
import { formatCellValue } from "../grid/cellStyle";
import { SheetGrid, type GridHeaderInfo, type LinkFilter } from "../grid/SheetGrid";
import { PivotGrid } from "../grid/PivotGrid";
import { pivotSpecFor, preferPivot, type PivotSpec } from "../grid/pivot";
import { browserStorage } from "../boot/migrate";
import type { RowState } from "../store/sheet";
import { loadOrientations, orientationKey, saveOrientations, type Orientation } from "./orientation";
import type { VaultView } from "../keyvault/client";
import type { ViewKind } from "../store";
import { Link } from "../ui/Link";
import { uiMessages } from "../ui/messages";
import { Notice } from "../ui/Notice";
import { SETTINGS_PATH } from "../ui/routes";
import { Toasts, type ToastStore } from "../ui/toast";
import { CommitPanel } from "./CommitPanel";
import { HistoryPanel } from "./HistoryPanel";
import { pagesMessages } from "./messages";
import { useFrameVersion, useWindowWidth } from "./hooks";
import { HIDE_SIDE_WIDTH, showOnePane } from "../grid/layout";
import { PaneBar } from "./PaneBar";
import { PANE_DRAG_TYPE, PaneHeader } from "./PaneHeader";
import {
  addPane,
  arrangePanes,
  EMPTY_LAYOUT,
  EVEN_SPLIT,
  ownPanes,
  paneGridTemplate,
  panesFor,
  swapPanes,
  togglePane,
  type LayoutChange,
  type PaneLayout,
  type PaneSpec,
  type PaneSplit,
} from "./panes";
import { PaneSplitters } from "./PaneSplitters";
import { AiFollower } from "./follow";
import { closeSheet, SheetTabs, type SheetTabInfo } from "./SheetTabs";
import { hostOf, maximoBadge, relayBadge, reopenHint, shouldSuggestReopen } from "./status";
import { TopBar } from "./TopBar";

/** 狭い画面で上下に並べる表の数（3 枚以上は表が低くなりすぎる） */
const NARROW_MAX_PANES = 2;

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
  /** 接続中の Maximo の環境（テスト／本番）を上部バーに出す */
  license?: LicenseClient;
  onEndWork: () => void;
  /** 別の窓にある作業をこの窓へ移す（作業が空で、別の窓が primary のときに出す） */
  onMoveWorkHere?: () => Promise<void>;
  confirm?: (message: string) => boolean;
  reload?: () => void;
  /** 再読み込みの前に作業を預ける（預けられたら true）。省くと預けずに再読み込みする */
  keepWorkForReload?: () => Promise<boolean>;
}

const VIEW_KINDS: readonly ViewKind[] = ["final", "diff", "base"];

/** 表示の切替（最終・差分・元の値）。文言は今の言語 */
function viewOptions(): Array<{ kind: ViewKind; label: string }> {
  const labels = pagesMessages().app.views;
  return VIEW_KINDS.map((kind) => ({ kind, label: labels[kind] }));
}

export function AppPage({ runtime, vault, toasts, catalog, license, onEndWork, onMoveWorkHere, confirm, reload, keepWorkForReload }: AppPageProps) {
  const { workspace, commits } = runtime;
  const confirmFn = confirm ?? ((m: string) => window.confirm(m));
  const reloadFn = reload ?? (() => window.location.reload());
  const t = pagesMessages().app;
  const views = viewOptions();

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
  // AI が作った・変えた・反映を頼んだシートへ表示を移す（AI の作業を目で追えるように）。人がタブを選んだ直後は動かさない
  const follower = useRef<AiFollower | null>(null);
  useEffect(() => {
    const f = new AiFollower({
      workspace,
      commits,
      show: (sheet) => {
        setSelected(sheet);
        setFocused(sheet);
      },
    });
    follower.current = f;
    const stop = f.start();
    return () => {
      stop();
      follower.current = null;
    };
  }, [workspace, commits]);
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
  // 窓の大きさ（境目をつかんで動かした割合）。並べ方と同じく組ごとに覚える
  const [splits, setSplits] = useState<Record<string, PaneSplit>>({});
  const split = splits[groupKey] ?? EVEN_SPLIT;
  // ペインをつかんで落とす先（落とせる所を示す）
  const [dropKey, setDropKey] = useState<string | null>(null);
  const focusSheet = focused !== null && panes.some((p) => p.sheet === focused) ? focused : current;
  const busy = focusSheet !== null && isRunning(focusSheet);
  const linkColumns = useMemo(() => Array.from(new Set(panes.flatMap((p) => (p.link ? [p.link.from] : [])))), [panes]);
  // 子の表の縦持ち・横持ち。利用者が選んだものを構造と子ごとに覚え、選んでいなければ表の形から決める（grid/pivot.ts）
  const [orientations, setOrientations] = useState<Record<string, Orientation>>(() => loadOrientations(browserStorage()));
  const pivotFor = (pane: PaneSpec): { spec: PivotSpec; key: string; horizontal: boolean } | null => {
    if (pane.scope.kind !== "child") return null;
    const sheet = workspace.sheets.get(pane.sheet);
    if (!sheet) return null;
    const spec = pivotSpecFor(sheet.meta, pane.scope.name);
    if (spec === null) return null;
    const key = orientationKey(sheet.meta, pane.scope.name);
    const chosen = orientations[key];
    const horizontal = chosen !== undefined ? chosen === "horizontal" : preferPivot(sheet.viewRows("final"), spec, (row, col) => sheet.finalValue(row, col));
    return { spec, key, horizontal };
  };
  const toggleOrientation = (key: string, horizontal: boolean) => {
    setOrientations((all) => {
      const next = { ...all, [key]: horizontal ? ("vertical" as const) : ("horizontal" as const) };
      saveOrientations(browserStorage(), next);
      return next;
    });
  };
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
    // 狭い画面（チャットと半々に並べたときなど）では、左右に並べると表が細くなりすぎるので、上下に 2 枚まで並べる。
    // 親と子は同じシートなので、1 枚だけにすると子の表へ切り替える手段が無くなる（表示する表の札で選び直せる）
    if (narrow) return panes.slice(0, NARROW_MAX_PANES);
    return panes;
  }, [panes, maximized, narrow]);
  const stacked = narrow && maximized === null && shownPanes.length > 1;
  const gridTemplate = stacked ? { rows: `repeat(${shownPanes.length}, minmax(0, 1fr))` } : paneGridTemplate(shownPanes.length, split);
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
  // 作業が別の窓にある（この窓はミラーで、primary の窓にシートがある）
  const elsewhere = relayStatus.role === "mirror" ? (relayStatus.primarySheets ?? 0) : 0;
  const reopen = suggestReopen ? reopenHint() : null;

  const tabInfos: SheetTabInfo[] = sheetNames.map((name) => {
    const s = workspace.sheets.get(name);
    const counts = s ? s.counts() : null;
    // どのオブジェクト構造（と接続先）から読み込んだか。反映もこの構造に対して行う
    const src = s?.meta.source;
    const info: SheetTabInfo = { name, changes: counts ? counts.changedCells + counts.addedRows + counts.deletedRows : 0 };
    if (src?.kind === "maximo") info.origin = t.originMaximo(src.os, src.baseUrl ? hostOf(src.baseUrl) : null);
    else if (src?.kind === "excel") info.origin = t.originExcel(src.fileName, src.sheetName);
    return info;
  });
  const sheetTabs = (
    <SheetTabs
      tabs={tabInfos}
      current={current}
      onSelect={(name) => {
        follower.current?.userSelected();
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
        {...(license ? { license } : {})}
        baseUrl={vaultView.kind === "disconnected" ? null : vaultView.info.baseUrl}
        tabs={sheetTabs}
        sidePanel={sidePanel}
        onToggleSide={() => setSidePanel((s) => !s)}
        viewHint={view === "final" ? null : (views.find((v) => v.kind === view)?.label ?? null)}
        onReload={() => {
          // 作業が無ければそのまま。あれば橋渡しに預けてから再読み込みし、開き直したあとに戻す（boot/handoff.ts）
          if (workspace.sheets.size === 0 || !keepWorkForReload) {
            if (workspace.sheets.size === 0 || confirmFn(t.confirmReload)) reloadFn();
            return;
          }
          if (!confirmFn(t.confirmReloadKeep)) return;
          void keepWorkForReload().then((kept) => {
            if (kept || confirmFn(t.reloadKeepFailed)) reloadFn();
          });
        }}
        onEndWork={() => {
          if (confirmFn(t.confirmEndWork)) onEndWork();
        }}
      />
      <div className={`workarea${sidePanel ? "" : " no-side"}`}>
        <div className="grid-area">
          {current === null && elsewhere > 0 && onMoveWorkHere ? (
            <MoveWorkHere sheets={elsewhere} onMove={onMoveWorkHere} />
          ) : current === null ? (
            <div className="empty">
              <p>{t.emptyTitle}</p>
              <p className="muted">
                {t.emptyBefore}
                <Link to={SETTINGS_PATH}>{t.emptyLink}</Link>
                {t.emptyAfter}
              </p>
            </div>
          ) : (
            <>
              {busy && (
                <Notice kind="warning" className="busy-banner">
                  {t.busy}
                </Notice>
              )}
              {(arranged.all.length > 1 || addable.length > 0) && (
                <PaneBar
                  panes={arranged.all}
                  addable={addable}
                  onToggle={(key) => applyLayout(togglePane(layout, arranged, key))}
                  onAdd={(key) => applyLayout(addPane(layout, arranged, key))}
                />
              )}
              <div
                className={`panes count-${shownPanes.length}${stacked ? " stacked" : ""}`}
                style={{ gridTemplateColumns: gridTemplate.columns, gridTemplateRows: gridTemplate.rows }}
              >
                <PaneSplitters count={stacked ? 1 : shownPanes.length} split={split} onChange={(next) => setSplits((all) => ({ ...all, [groupKey]: next }))} />
                {shownPanes.length === 0 && <div className="empty">{t.allHidden}</div>}
                {shownPanes.map((pane) => (
                  <section
                    key={pane.key}
                    className={`pane${dropKey === pane.key ? " drop-over" : ""}`}
                    aria-label={t.paneLabel(pane.title, pane.subtitle)}
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
                    {(() => {
                      const pivot = pivotFor(pane);
                      const header = (h: GridHeaderInfo) => (
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
                          {...(pivot ? { orientation: { horizontal: pivot.horizontal, onToggle: () => toggleOrientation(pivot.key, pivot.horizontal) } } : {})}
                        />
                      );
                      const selectRow = (row: RowState | null) => {
                        setFocused(pane.sheet);
                        if (row === null) {
                          setLinked(null);
                          return;
                        }
                        const sheet = workspace.sheets.get(pane.sheet);
                        const values: Record<string, string> = {};
                        if (sheet) for (const col of linkColumns) values[col] = formatCellValue(sheet.viewValue(row, col, view));
                        setLinked({ paneKey: pane.key, sheet: pane.sheet, parentKey: row.parentKey, values });
                      };
                      if (pivot?.horizontal) {
                        return (
                          <PivotGrid
                            renderHeader={header}
                            workspace={workspace}
                            sheetName={pane.sheet}
                            view={view}
                            version={version}
                            isBusy={() => commits.isRunning(pane.sheet)}
                            onMessage={onMessage}
                            spec={pivot.spec}
                            onSelectRow={selectRow}
                          />
                        );
                      }
                      return (
                    <SheetGrid
                      renderHeader={header}
                      workspace={workspace}
                      valueLists={runtime.valueLists}
                      sheetName={pane.sheet}
                      view={view}
                      version={version}
                      isBusy={() => commits.isRunning(pane.sheet)}
                      onMessage={onMessage}
                      scope={pane.scope}
                      linkFilter={linked === null ? null : paneLink(pane, linked)}
                      onSelectRow={selectRow}
                    />
                      );
                    })()}
                  </section>
                ))}
              </div>
            </>
          )}
        </div>
        {focusSheet !== null && (
          <aside className="side">
            <ContentSwitcher
              className="view-switch"
              size="sm"
              aria-label={t.viewSwitch}
              selectedIndex={Math.max(0, views.findIndex((v) => v.kind === view))}
              onChange={({ index }) => {
                const next = views[index ?? 0];
                if (next) setView(next.kind);
              }}
            >
              {views.map((v) => (
                <Switch key={v.kind} name={v.kind} text={v.label} />
              ))}
            </ContentSwitcher>
            <CommitPanel
              commits={commits}
              sheet={focusSheet}
              version={commitVersion + version}
              connected={vaultView.kind === "connected"}
              locked={vaultView.kind === "locked"}
              onMessage={onMessage}
              workspace={workspace}
              {...(license ? { license } : {})}
            />
            <HistoryPanel workspace={workspace} sheet={focusSheet} version={version} busy={busy} onMessage={onMessage} />
          </aside>
        )}
      </div>
      <Toasts store={toasts} />
    </div>
  );
}

/** 作業が別の窓にあるときの案内と「この窓に移す」 */
function MoveWorkHere({ sheets, onMove }: { sheets: number; onMove: () => Promise<void> }) {
  const t = uiMessages().handoff;
  const [moving, setMoving] = useState(false);
  return (
    <div className="empty move-work">
      <p>{t.elsewhere(sheets)}</p>
      <Button
        kind="primary"
        size="md"
        disabled={moving}
        onClick={() => {
          setMoving(true);
          void onMove().finally(() => setMoving(false));
        }}
      >
        {moving ? t.moving : t.move}
      </Button>
    </div>
  );
}
