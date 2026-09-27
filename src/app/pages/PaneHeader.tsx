// ペイン（関連する表 1 つ分）の見出し。つかむ所（入れ替え）・表の名前・連動・行数・行の詳細・広げる・隠す。
// 行数と行の詳細の開閉はグリッド（SheetGrid）の中の状態なので、SheetGrid の renderHeader から描く。

import { Icon } from "../ui/Icon";

/** ペインをドラッグして入れ替えるときの dataTransfer の種類（ファイルのドロップと区別する） */
export const PANE_DRAG_TYPE = "application/x-mxstudio-pane";

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
  return (
    <header className="pane-head" onClick={p.onSelect}>
      {p.dragKey !== undefined && (
        <span
          className="pane-grip"
          draggable
          title="つかんで別の表へ落とすと入れ替えます"
          onDragStart={(e) => {
            e.dataTransfer.setData(PANE_DRAG_TYPE, p.dragKey as string);
            e.dataTransfer.effectAllowed = "move";
          }}
        >
          <Icon name="grip-vertical" size={14} />
        </span>
      )}
      <span className={`pane-mark${p.current ? " on" : ""}`} aria-hidden="true" />
      <span className="pane-title" title={p.subtitle}>
        {p.title}
      </span>
      {p.onUnlink && (
        <button
          type="button"
          className="btn-ghost linked"
          aria-label="連動を外す"
          title="連動を外す"
          onClick={(e) => {
            e.stopPropagation();
            p.onUnlink?.();
          }}
        >
          連動中
          <Icon name="x" size={11} />
        </button>
      )}
      <span className="row-count" title={p.rowCountTitle}>
        {p.rowCount}
      </span>
      <button
        type="button"
        className="btn-ghost icon-btn size-26"
        aria-pressed={p.detailOpen}
        aria-label="行の詳細"
        title="選んだ行の全列を縦に並べて読む"
        onClick={(e) => {
          e.stopPropagation();
          p.onToggleDetail();
        }}
      >
        <Icon name="panel-bottom" size={14} />
      </button>
      {p.maximize && (
        <button
          type="button"
          className="btn-ghost icon-btn size-26"
          aria-pressed={p.maximize.pressed}
          aria-label={p.maximize.pressed ? "並べて表示" : "広げる"}
          title={p.maximize.pressed ? "他の表も出す" : "この表だけを広げる"}
          onClick={(e) => {
            e.stopPropagation();
            p.maximize?.onToggle();
          }}
        >
          <Icon name="maximize-2" size={14} />
        </button>
      )}
      {p.onHide && (
        <button
          type="button"
          className="btn-ghost icon-btn size-26"
          aria-label="隠す"
          title="この表を隠す（上の帯から戻せます）"
          onClick={(e) => {
            e.stopPropagation();
            p.onHide?.();
          }}
        >
          <Icon name="eye-off" size={14} />
        </button>
      )}
    </header>
  );
}
