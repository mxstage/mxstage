// ペイン（関連する表 1 つ分）の見出し。つかむ所（入れ替え）・表の名前・連動・行数・行の詳細・広げる・隠す。
// 行数と行の詳細の開閉はグリッド（SheetGrid）の中の状態なので、SheetGrid の renderHeader から描く。

import { Close, Draggable, Maximize, OpenPanelBottom, ViewOff } from "@carbon/icons-react";
import { Button, IconButton } from "@carbon/react";
import { pagesMessages } from "./messages";

/** ペインをドラッグして入れ替えるときの dataTransfer の種類（ファイルのドロップと区別する） */
export const PANE_DRAG_TYPE = "application/x-mxstage-pane";

export interface PaneHeaderProps {
  title: string;
  /** 構造名や親子の関係（画面には出さず title に入れる） */
  subtitle: string;
  /** 選択中のシートのペインか（左端に縦棒を出す） */
  current: boolean;
  /** 他のペインで選んだ行に連動しているときの外し方（連動していなければ省く） */
  onUnlink?: () => void;
  rowCount: string;
  rowCountTitle: string;
  detailOpen: boolean;
  onToggleDetail: () => void;
  /** 広げる（ペインが 1 つだけのときは省く） */
  maximize?: { pressed: boolean; onToggle: () => void };
  /** 見出しを押したとき（そのペインのシートを選ぶ） */
  onSelect: () => void;
  /** つかんで別のペインへ落とすと入れ替える（ペインが 1 つだけのときは省く） */
  dragKey?: string;
  /** 窓を隠す（上の帯から戻せる） */
  onHide?: () => void;
}

export function PaneHeader(p: PaneHeaderProps) {
  const t = pagesMessages().paneHeader;
  return (
    <header className="pane-head" onClick={p.onSelect}>
      {p.dragKey !== undefined && (
        <span
          className="pane-grip"
          draggable
          title={t.grip}
          onDragStart={(e) => {
            e.dataTransfer.setData(PANE_DRAG_TYPE, p.dragKey as string);
            e.dataTransfer.effectAllowed = "move";
          }}
        >
          <Draggable />
        </span>
      )}
      <span className={`pane-mark${p.current ? " on" : ""}`} aria-hidden="true" />
      <span className="pane-title" title={p.subtitle}>
        {p.title}
      </span>
      {p.onUnlink && (
        <Button
          kind="ghost"
          size="sm"
          className="linked"
          renderIcon={Close}
          iconDescription={t.unlink}
          aria-label={t.unlink}
          title={t.unlink}
          onClick={(e) => {
            e.stopPropagation();
            p.onUnlink?.();
          }}
        >
          {t.linked}
        </Button>
      )}
      <span className="row-count" title={p.rowCountTitle}>
        {p.rowCount}
      </span>
      <IconButton
        kind="ghost"
        size="sm"
        align="bottom"
        isSelected={p.detailOpen}
        aria-pressed={p.detailOpen}
        aria-label={t.detail}
        label={t.detailTitle}
        onClick={(e) => {
          e.stopPropagation();
          p.onToggleDetail();
        }}
      >
        <OpenPanelBottom />
      </IconButton>
      {p.maximize && (
        <IconButton
          kind="ghost"
          size="sm"
          align="bottom"
          isSelected={p.maximize.pressed}
          aria-pressed={p.maximize.pressed}
          aria-label={p.maximize.pressed ? t.tile : t.maximize}
          label={p.maximize.pressed ? t.tileTitle : t.maximizeTitle}
          onClick={(e) => {
            e.stopPropagation();
            p.maximize?.onToggle();
          }}
        >
          <Maximize />
        </IconButton>
      )}
      {p.onHide && (
        <IconButton
          kind="ghost"
          size="sm"
          align="bottom-end"
          aria-label={t.hide}
          label={t.hideTitle}
          onClick={(e) => {
            e.stopPropagation();
            p.onHide?.();
          }}
        >
          <ViewOff />
        </IconButton>
      )}
    </header>
  );
}
