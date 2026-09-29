// 作業画面の上部バー（1 段）。接続の ○、シートタブ、色の意味、オブジェクト構造、設定・作業終了・パネルの出し入れ。

import { Information, Logout, OpenPanelRight, Settings } from "@carbon/icons-react";
import { Button, IconButton, Toggletip, ToggletipButton, ToggletipContent } from "@carbon/react";
import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import type { ObjectStructureCatalog } from "../catalog/catalog";
import { LEGEND_TONES, TONE_LABEL, TONE_STYLE } from "../grid/cellStyle";
import { Link, spaClick } from "../ui/Link";
import { SETTINGS_PATH, STRUCTURES_PATH } from "../ui/routes";
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
}

/**
 * 「オブジェクト構造」へのリンク。読み込み中は進み具合を出す。
 * 読み込みは 1 件ごとに知らせてくるので、作業画面全体（グリッド）を描き直さないよう、このリンクだけが購読する。
 */
function StructuresLink({ catalog, baseUrl }: { catalog?: ObjectStructureCatalog; baseUrl?: string | null }) {
  const sync = useSyncExternalStore(
    useCallback((l: () => void) => (catalog ? catalog.subscribe(l) : () => undefined), [catalog]),
    useCallback(() => (catalog && baseUrl ? catalog.snapshot(baseUrl).sync : null), [catalog, baseUrl]),
  );
  return (
    <Link to={STRUCTURES_PATH} className="topbar-link" title="Maximo から読み込んだオブジェクト構造（キー列・子オブジェクト・属性）を見る">
      オブジェクト構造{sync !== null && sync.state === "running" ? `（読み込み中 ${sync.done}/${sync.total}）` : ""}
    </Link>
  );
}

/** ⓘ から開く色の意味（セルの色の凡例）。外側を押すか Esc で閉じる（Carbon の Toggletip） */
function LegendButton() {
  return (
    <Toggletip align="bottom-end" className="legend-anchor">
      <ToggletipButton label="色の意味">
        <Information />
      </ToggletipButton>
      <ToggletipContent>
        <div className="legend">
          <div className="legend-head">セルの色</div>
          <ul className="legend-list">
            {LEGEND_TONES.map((tone) => (
              <li key={tone}>
                <span className="legend-dot" style={{ background: TONE_STYLE[tone].bg, borderColor: TONE_STYLE[tone].fg }} />
                {TONE_LABEL[tone]}
              </li>
            ))}
          </ul>
          <p className="legend-note">セルにマウスを置くと作者・根拠・変更前後を表示します</p>
        </div>
      </ToggletipContent>
    </Toggletip>
  );
}

export function TopBar(p: TopBarProps) {
  const conn = connectionIndicator(p.relay, p.maximo, p.workspaceName);
  return (
    <header className="topbar">
      <span className={`conn-dot tone-${conn.tone}`} role="status" aria-label={conn.label} title={conn.title} />
      {p.relay.showReload && (
        <Button kind="tertiary" size="sm" onClick={p.onReload}>
          再読み込み
        </Button>
      )}
      {p.reopen && (
        <span className="conn-note" title={p.reopen.title}>
          {p.reopen.text}
        </span>
      )}
      {p.maximo.settingsLink && (
        <Link to={SETTINGS_PATH} className="topbar-link">
          {p.maximo.settingsLink}
        </Link>
      )}
      {p.tabs}
      <span className="spacer" />
      <nav className="topbar-links" aria-label="画面">
        <LegendButton />
        <StructuresLink catalog={p.catalog} baseUrl={p.baseUrl} />
      </nav>
      <div className="topbar-icons">
        <IconButton kind="ghost" size="md" align="bottom" label="設定" aria-label="設定" href={SETTINGS_PATH} onClick={spaClick(SETTINGS_PATH)}>
          <Settings />
        </IconButton>
        <IconButton kind="ghost" size="md" align="bottom" label="作業終了" aria-label="作業終了" onClick={p.onEndWork}>
          <Logout />
        </IconButton>
        {!p.sidePanel && p.viewHint && (
          <span className="view-hint" title="表示の切替はパネルの中にあります">
            {p.viewHint}
          </span>
        )}
        <IconButton
          kind="ghost"
          size="md"
          align="bottom-end"
          isSelected={p.sidePanel}
          aria-pressed={p.sidePanel}
          aria-label="反映と変更履歴のパネル"
          label="反映と変更履歴のパネルを出し入れする"
          onClick={p.onToggleSide}
        >
          <OpenPanelRight />
        </IconButton>
      </div>
    </header>
  );
}
