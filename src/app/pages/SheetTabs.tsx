// 上部バーのシートタブ（選ぶ・閉じる）と、シートを閉じるときの確かめ。

import type { Workspace } from "../store";
import { Icon } from "../ui/Icon";

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
  return (
    <div className="sheet-tabs" role="tablist" aria-label="シート">
      {tabs.map((t) => (
        <span key={t.name} className="sheet-tab-wrap" role="presentation">
          <button type="button" role="tab" aria-selected={t.name === current} className="sheet-tab" title={t.origin} onClick={() => onSelect(t.name)}>
            {t.name}
            {t.changes > 0 && (
              <span className="count" title="変更の件数">
                {t.changes}
              </span>
            )}
          </button>
          <button type="button" className="sheet-tab-close" aria-label={`シート ${t.name} を閉じる`} title="シートを閉じる" onClick={() => onClose(t.name)}>
            <Icon name="x" size={12} />
          </button>
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
    deps.notify(`シート ${name} は Maximo へ反映中のため閉じられません。反映が終わってから閉じてください。`, "error");
    return false;
  }
  const s = workspace.summary(name);
  const changes = s.changedCells + s.addedRows + s.deletedRows;
  if (changes > 0 && !deps.confirm(`シート ${name} には Maximo に未反映の変更が ${changes} 件あります。閉じると変更は捨てられます（Maximo には反映されません）。閉じますか？`)) {
    return false;
  }
  return workspace.removeSheet(name);
}
