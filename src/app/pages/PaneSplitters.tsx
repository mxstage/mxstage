// 並べた窓の間の境目。つかんで動かすと窓の大きさが変わる（列の境目は左右、段の境目は上下）。
// ダブルクリックで半分ずつに戻す。キーボードでは矢印キーで動かせる。

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { pagesMessages } from "./messages";
import { EVEN_SPLIT, clampSplit, splitAxes, type PaneSplit } from "./panes";

export interface PaneSplittersProps {
  /** 窓の枚数（1 枚なら境目は出さない） */
  count: number;
  split: PaneSplit;
  onChange: (split: PaneSplit) => void;
}

/** 矢印キー 1 回で動かす割合 */
const KEY_STEP = 0.05;

export function PaneSplitters({ count, split, onChange }: PaneSplittersProps) {
  const axes = splitAxes(count);
  // つかんでいる間の、窓の枠（.panes）の位置と大きさ
  const dragRef = useRef<{ axis: "col" | "row"; rect: DOMRect } | null>(null);

  const start = (axis: "col" | "row") => (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const box = e.currentTarget.parentElement;
    if (box === null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { axis, rect: box.getBoundingClientRect() };
    document.body.classList.add(axis === "col" ? "resizing-col" : "resizing-row");
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d === null) return;
    if (d.axis === "col") onChange({ ...split, col: clampSplit((e.clientX - d.rect.left) / d.rect.width, d.rect.width) });
    else onChange({ ...split, row: clampSplit((e.clientY - d.rect.top) / d.rect.height, d.rect.height) });
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("resizing-col", "resizing-row");
  };
  const key = (axis: "col" | "row") => (e: KeyboardEvent<HTMLDivElement>) => {
    const back = axis === "col" ? "ArrowLeft" : "ArrowUp";
    const fwd = axis === "col" ? "ArrowRight" : "ArrowDown";
    let next: number | null = null;
    if (e.key === back) next = split[axis] - KEY_STEP;
    else if (e.key === fwd) next = split[axis] + KEY_STEP;
    else if (e.key === "Home" || e.key === "Enter") next = EVEN_SPLIT[axis];
    if (next === null) return;
    e.preventDefault();
    const box = e.currentTarget.parentElement?.getBoundingClientRect();
    onChange({ ...split, [axis]: clampSplit(next, box ? (axis === "col" ? box.width : box.height) : 0) });
  };

  const t = pagesMessages().splitters;
  const handle = (axis: "col" | "row") => {
    const pct = Math.round(split[axis] * 100);
    const style =
      axis === "col"
        ? // 3 枚のときは上の段（親）が横いっぱいなので、列の境目は下の段にだけ出す
          { left: `${split.col * 100}%`, top: count === 3 ? `${split.row * 100}%` : 0 }
        : { top: `${split.row * 100}%` };
    return (
      <div
        key={axis}
        className={`pane-split ${axis}`}
        role="separator"
        aria-orientation={axis === "col" ? "vertical" : "horizontal"}
        aria-label={axis === "col" ? t.col : t.row}
        aria-valuemin={10}
        aria-valuemax={90}
        aria-valuenow={pct}
        tabIndex={0}
        title={t.title}
        style={style}
        onPointerDown={start(axis)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onDoubleClick={() => onChange({ ...split, [axis]: EVEN_SPLIT[axis] })}
        onKeyDown={key(axis)}
      />
    );
  };

  return (
    <>
      {axes.row && handle("row")}
      {axes.col && handle("col")}
    </>
  );
}
