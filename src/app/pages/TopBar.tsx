// 作業画面の上部バー（1 段）。接続の ○、シートタブ、色の意味、オブジェクト構造、設定・作業終了・パネルの出し入れ。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ObjectStructureCatalog } from "../catalog/catalog";
import { LEGEND_TONES, TONE_LABEL, TONE_STYLE } from "../grid/cellStyle";
import { Icon } from "../ui/Icon";
import { Link } from "../ui/Link";
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
    <Link to={STRUCTURES_PATH} className="text-link" title="Maximo から読み込んだオブジェクト構造（キー列・子オブジェクト・属性）を見る">
      オブジェクト構造{sync !== null && sync.state === "running" ? `（読み込み中 ${sync.done}/${sync.total}）` : ""}
    </Link>
  );
}

/** ⓘ から開く色の意味（セルの色の凡例）。外側を押すか Esc で閉じる */
function LegendButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span className="legend-anchor" ref={ref}>
      <button
        type="button"
        className="btn-ghost icon-btn size-26"
        aria-label="色の意味"
        title="色の意味"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="info" size={15} />
      </button>
      {open && (
        <div className="legend-pop" role="tooltip">
          <div className="legend-head">セルの色</div>
          <ul className="legend-list">
            {LEGEND_TONES.map((tone) => (
              <li key={tone}>
                <span className="legend-dot" style={{ background: TONE_STYLE[tone].bg }} />
                {TONE_LABEL[tone]}
              </li>
            ))}
          </ul>
          <p className="legend-note">セルにマウスを置くと作者・根拠・変更前後を表示します</p>
        </div>
      )}
    </span>
  );
}

export function TopBar(p: TopBarProps) {
  const conn = connectionIndicator(p.relay, p.maximo, p.workspaceName);
  return (
    <header className="topbar">
      <span className={`conn-dot tone-${conn.tone}`} role="status" aria-label={conn.label} title={conn.title} />
      {p.relay.showReload && (
        <button type="button" className="small" onClick={p.onReload}>
          再読み込み
        </button>
      )}
      {p.reopen && (
        <span className="conn-note" title={p.reopen.title}>
          {p.reopen.text}
        </span>
      )}
      {p.maximo.settingsLink && (
        <Link to={SETTINGS_PATH} className="text-link">
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
        <Link to={SETTINGS_PATH} className="btn-ghost icon-btn size-30" aria-label="設定" title="設定">
          <Icon name="settings" />
        </Link>
        <button type="button" className="btn-ghost icon-btn size-30" aria-label="作業終了" title="作業終了" onClick={p.onEndWork}>
          <Icon name="log-out" />
        </button>
      </div>
      {!p.sidePanel && p.viewHint && (
        <span className="view-hint" title="表示の切替はパネルの中にあります">
          {p.viewHint}
        </span>
      )}
      <button
        type="button"
        className="btn-ghost icon-btn size-30"
        aria-pressed={p.sidePanel}
        aria-label="反映と変更履歴のパネル"
        title="反映と変更履歴のパネルを出し入れする"
        onClick={p.onToggleSide}
      >
        <Icon name="panel-right" />
      </button>
    </header>
  );
}
