// 上部バーのシートタブ（選ぶ・閉じる）と、シートを閉じるときの確かめ。
// Carbon の Tabs は使わない（閉じるボタンに英語の説明が付き、Delete キーで閉じてしまい、中身の無いタブパネルを指す）。
// 見た目だけ Carbon の line タブに合わせる（app.css）。

import { Close } from "@carbon/icons-react";
import { IconButton } from "@carbon/react";
import type { Workspace } from "../store";
import { pagesMessages } from "./messages";

export interface SheetTabInfo {
  name: string;
  /** 未反映の変更の件数（変更セル・追加行・削除行） */
  changes: number;
  /** どこから読み込んだか（タブの説明） */
  origin?: string;
}

export interface SheetTabsProps {
  tabs: readonly SheetTabInfo[];
  current: string | null;
  onSelect: (name: string) => void;
  onClose: (name: string) => void;
}

export function SheetTabs({ tabs, current, onSelect, onClose }: SheetTabsProps) {
  const t = pagesMessages().sheetTabs;
  return (
    <div className="sheet-tabs" role="tablist" aria-label={t.label}>
      {tabs.map((tab) => (
        <span key={tab.name} className="sheet-tab-wrap" role="presentation">
          <button type="button" role="tab" aria-selected={tab.name === current} className="sheet-tab" title={tab.origin} onClick={() => onSelect(tab.name)}>
            {tab.name}
            {tab.changes > 0 && (
              <span className="count" title={t.changes}>
                {tab.changes}
              </span>
            )}
          </button>
          <IconButton
            kind="ghost"
            size="xs"
            align="bottom"
            className="sheet-tab-close"
            wrapperClasses="sheet-tab-close-wrap"
            label={t.close}
            aria-label={t.closeNamed(tab.name)}
            onClick={() => onClose(tab.name)}
          >
            <Close />
          </IconButton>
        </span>
      ))}
    </div>
  );
}

export interface CloseSheetDeps {
  workspace: Workspace;
  isRunning: (sheet: string) => boolean;
  confirm: (message: string) => boolean;
  notify: (text: string, tone: "info" | "error") => void;
}

/**
 * 要らなくなったシートを閉じる（作業から外す）。閉じたら true。
 * 反映中は閉じない。未反映の変更があれば、捨ててよいか確かめる（Maximo には何も送らない）。
 */
export function closeSheet(name: string, deps: CloseSheetDeps): boolean {
  const { workspace } = deps;
  if (!workspace.hasSheet(name)) return false;
  if (deps.isRunning(name)) {
    deps.notify(pagesMessages().sheetTabs.running(name), "error");
    return false;
  }
  const s = workspace.summary(name);
  const changes = s.changedCells + s.addedRows + s.deletedRows;
  if (changes > 0 && !deps.confirm(pagesMessages().sheetTabs.confirmDiscard(name, changes))) {
    return false;
  }
  return workspace.removeSheet(name);
}
