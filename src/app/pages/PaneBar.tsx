// 表の窓の上に出す「表示する表」の帯。組の表（親・子・参照先のマスタ）と足した表を並べ、押すと窓に出す・隠す。
// 「表を足す」で、組に無い表（取り込んだ Excel のシートなど）も同じ画面に出せる。

import { MenuButton, MenuItem, SelectableTag, Tooltip } from "@carbon/react";
import { pagesMessages } from "./messages";
import type { ArrangedPane, PaneSpec } from "./panes";

export interface PaneBarProps {
  panes: readonly ArrangedPane[];
  /** 足せる表（組にも窓にも無いもの） */
  addable: readonly PaneSpec[];
  onToggle: (key: string) => void;
  onAdd: (key: string) => void;
}

export function PaneBar({ panes, addable, onToggle, onAdd }: PaneBarProps) {
  const t = pagesMessages().paneBar;
  return (
    <div className="pane-bar" role="toolbar" aria-label={t.label}>
      <span className="pane-bar-label">{t.label}</span>
      {panes.map((p) => (
        // 札を押すと出す・隠す（Carbon の SelectableTag）。構造名と操作の説明はツールチップに出す
        <Tooltip key={p.key} align="bottom" description={`${p.subtitle}${p.shown ? t.hideHint : t.showHint}`}>
          <SelectableTag
            className={`pane-chip${p.extra ? " extra" : ""}`}
            size="md"
            text={p.title}
            selected={p.shown}
            onChange={() => onToggle(p.key)}
          />
        </Tooltip>
      ))}
      {addable.length > 0 && (
        // メニューは body に出る（Carbon の Menu）。選ぶと閉じる
        <MenuButton className="pane-add" kind="ghost" size="sm" label={t.add} menuAlignment="bottom-start">
          {addable.map((a) => (
            <MenuItem key={a.key} label={a.title} shortcut={a.subtitle} onClick={() => onAdd(a.key)} />
          ))}
        </MenuButton>
      )}
    </div>
  );
}
