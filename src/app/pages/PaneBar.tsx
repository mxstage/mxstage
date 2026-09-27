// 表の窓の上に出す「表示する表」の帯。組の表（親・子・参照先のマスタ）と足した表を並べ、押すと窓に出す・隠す。
// 「表を足す」で、組に無い表（取り込んだ Excel のシートなど）も同じ画面に出せる。

import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import type { ArrangedPane, PaneSpec } from "./panes";

export interface PaneBarProps {
  panes: readonly ArrangedPane[];
  /** 足せる表（組にも窓にも無いもの） */
  addable: readonly PaneSpec[];
  onToggle: (key: string) => void;
  onAdd: (key: string) => void;
}

export function PaneBar({ panes, addable, onToggle, onAdd }: PaneBarProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // メニューの外を押したら閉じる
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="pane-bar" role="toolbar" aria-label="表示する表">
      <span className="pane-bar-label">表示する表</span>
      {panes.map((p) => (
        <button
          key={p.key}
          type="button"
          className={`pane-chip${p.extra ? " extra" : ""}`}
          aria-pressed={p.shown}
          title={`${p.subtitle}${p.shown ? "（押すと隠す）" : "（押すと出す）"}`}
          onClick={() => onToggle(p.key)}
        >
          {p.title}
        </button>
      ))}
      {addable.length > 0 && (
        <div className="pane-add" ref={ref}>
          <button type="button" className="btn-ghost" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
            <Icon name="plus" size={12} />
            表を足す
          </button>
          {open && (
            <ul className="pane-add-menu plain" role="menu" aria-label="足す表">
              {addable.map((a) => (
                <li key={a.key} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      onAdd(a.key);
                    }}
                  >
                    <span className="value">{a.title}</span>
                    <span className="muted small">{a.subtitle}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
