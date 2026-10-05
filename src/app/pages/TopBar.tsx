// 作業画面の上部バー（1 段）。接続の ○、シートタブ、色の意味、オブジェクト構造、設定・作業終了・パネルの出し入れ。

import { DataStructured, Information, Logout, OpenPanelRight, Settings } from "@carbon/icons-react";
import { Button, IconButton, Toggletip, ToggletipButton, ToggletipContent } from "@carbon/react";
import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import type { ObjectStructureCatalog } from "../catalog/catalog";
import { LEGEND_TONES, PIVOT_CELL_STYLE, PIVOT_WARN_MARK, TONE_STYLE, toneLabel } from "../grid/cellStyle";
import type { LicenseClient } from "../license/client";
import { EnvironmentTag } from "../license/EnvironmentTag";
import { Link, spaClick } from "../ui/Link";
import { SETTINGS_PATH, STRUCTURES_PATH, settingsPath } from "../ui/routes";
import { pagesMessages } from "./messages";
import { connectionIndicator, type MaximoBadge, type RelayBadge, type ReopenHint } from "./status";

export interface TopBarProps {
  relay: RelayBadge;
  maximo: MaximoBadge;
  /** 再接続が続いたときの案内（出さないときは null）。文言は構成によって変わる */
  reopen: ReopenHint | null;
  workspaceName: string;
  onReload: () => void;
  onEndWork: () => void;
  /** シートタブ（○ のすぐ右に並べる） */
  tabs?: ReactNode;
  /** 反映と変更履歴のパネルを出しているか */
  sidePanel: boolean;
  onToggleSide: () => void;
  /** パネルを隠している間に「最終」以外を見ているときの表示名（パネルの中の切替が見えないため） */
  viewHint?: string | null;
  /** オブジェクト構造の読み込みの進み具合を出す（接続先が分かるときだけ） */
  catalog?: ObjectStructureCatalog;
  baseUrl?: string | null;
  /** 接続中の Maximo の環境（テスト／本番）の札を出す */
  license?: LicenseClient;
}

/**
 * 「オブジェクト構造」へのアイコンのリンク。読み込み中は進み具合を出す。
 * 読み込みは 1 件ごとに知らせてくるので、作業画面全体（グリッド）を描き直さないよう、このリンクだけが購読する。
 */
function StructuresLink({ catalog, baseUrl }: { catalog?: ObjectStructureCatalog; baseUrl?: string | null }) {
  const sync = useSyncExternalStore(
    useCallback((l: () => void) => (catalog ? catalog.subscribe(l) : () => undefined), [catalog]),
    useCallback(() => (catalog && baseUrl ? catalog.snapshot(baseUrl).sync : null), [catalog, baseUrl]),
  );
  const t = pagesMessages().topBar;
  const loading = sync !== null && sync.state === "running" ? t.structuresLoading(sync.done, sync.total) : "";
  // ほかの操作（設定・作業の終了）と同じアイコンのボタン。名前と読み込みの進み具合はツールチップと読み上げで伝え、
  // 読み込み中だけ件数を横に小さく出す
  return (
    <span className="structures-link">
      <IconButton
        kind="ghost"
        size="md"
        align="bottom"
        label={`${t.structures}${loading}`}
        aria-label={`${t.structures}${loading}`}
        href={STRUCTURES_PATH}
        onClick={spaClick(STRUCTURES_PATH)}
      >
        <DataStructured />
      </IconButton>
      {sync !== null && sync.state === "running" && (
        <span className="structures-progress muted small" aria-hidden="true">
          {sync.done}/{sync.total}
        </span>
      )}
    </span>
  );
}

/** ⓘ から開く色の意味（セルの色の凡例）。外側を押すか Esc で閉じる（Carbon の Toggletip） */
function LegendButton() {
  const t = pagesMessages().topBar;
  return (
    <Toggletip align="bottom-end" className="legend-anchor">
      <ToggletipButton label={t.legend}>
        <Information />
      </ToggletipButton>
      <ToggletipContent>
        <div className="legend">
          <div className="legend-head">{t.legendHead}</div>
          <ul className="legend-list">
            {LEGEND_TONES.map((tone) => (
              <li key={tone}>
                <span className="legend-dot" style={{ background: TONE_STYLE[tone].bg, borderColor: TONE_STYLE[tone].fg }} />
                {toneLabel(tone)}
              </li>
            ))}
          </ul>
          <div className="legend-head">{t.legendPivotHead}</div>
          <ul className="legend-list">
            <li>
              <span className="legend-dot" style={{ background: PIVOT_CELL_STYLE.missing.bg, borderColor: "#b28600" }} />
              {t.legendMissing}
            </li>
            <li>
              <span className="legend-dot" style={{ background: PIVOT_CELL_STYLE.none.bg, borderColor: PIVOT_CELL_STYLE.none.fg }} />
              {t.legendNone}
            </li>
            <li>
              <span className="legend-mark" aria-hidden="true">
                {PIVOT_WARN_MARK}
              </span>
              {t.legendWarn}
            </li>
          </ul>
          <p className="legend-note">{t.legendNote}</p>
        </div>
      </ToggletipContent>
    </Toggletip>
  );
}

export function TopBar(p: TopBarProps) {
  const conn = connectionIndicator(p.relay, p.maximo, p.workspaceName);
  const t = pagesMessages().topBar;
  return (
    <header className="topbar">
      <span className={`conn-dot tone-${conn.tone}`} role="status" aria-label={conn.label} title={conn.title} />
      {p.relay.showReload && (
        <Button kind="tertiary" size="sm" onClick={p.onReload}>
          {t.reload}
        </Button>
      )}
      {p.reopen && (
        <span className="conn-note" title={p.reopen.title}>
          {p.reopen.text}
        </span>
      )}
      {p.maximo.settingsLink && (
        <Link to={settingsPath("connection")} className="topbar-link">
          {p.maximo.settingsLink}
        </Link>
      )}
      {p.license && p.baseUrl ? <EnvironmentTag license={p.license} baseUrl={p.baseUrl} /> : null}
      {p.tabs}
      <span className="spacer" />
      <nav className="topbar-links" aria-label={t.nav}>
        <LegendButton />
        <StructuresLink catalog={p.catalog} baseUrl={p.baseUrl} />
      </nav>
      <div className="topbar-icons">
        <IconButton kind="ghost" size="md" align="bottom" label={t.settings} aria-label={t.settings} href={SETTINGS_PATH} onClick={spaClick(SETTINGS_PATH)}>
          <Settings />
        </IconButton>
        <IconButton kind="ghost" size="md" align="bottom" label={t.endWork} aria-label={t.endWork} onClick={p.onEndWork}>
          <Logout />
        </IconButton>
        {!p.sidePanel && p.viewHint && (
          <span className="view-hint" title={t.viewHint}>
            {p.viewHint}
          </span>
        )}
        <IconButton
          kind="ghost"
          size="md"
          align="bottom-end"
          isSelected={p.sidePanel}
          aria-pressed={p.sidePanel}
          aria-label={t.sidePanel}
          label={t.sidePanelToggle}
          onClick={p.onToggleSide}
        >
          <OpenPanelRight />
        </IconButton>
      </div>
    </header>
  );
}
