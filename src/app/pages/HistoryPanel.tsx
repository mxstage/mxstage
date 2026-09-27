// 変更履歴（最近のバッチと取り消し）。

import type { Workspace } from "../store";
import { AUTHOR_LABEL, TONE_STYLE } from "../grid/cellStyle";
import { conflictSummary, storeErrorMessage } from "../grid/edits";
import { Icon } from "../ui/Icon";

export interface HistoryPanelProps {
  workspace: Workspace;
  sheet: string;
  /** 再描画のきっかけ */
  version: number;
  busy: boolean;
  onMessage: (text: string, tone: "info" | "error") => void;
}

const MAX_ITEMS = 50;

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function HistoryPanel({ workspace, sheet, busy, onMessage }: HistoryPanelProps) {
  const recent = workspace.listBatches(sheet).slice(-MAX_ITEMS).reverse();

  const undo = (batchId: string) => {
    try {
      const res = workspace.undoBatch(batchId, { author: "user" });
      const msg = conflictSummary(res.conflicts, "取り消し");
      if (msg) onMessage(`${msg}取り消せたセルだけ元に戻しました。`, "error");
    } catch (e) {
      onMessage(storeErrorMessage(e, "取り消せませんでした。"), "error");
    }
  };

  return (
    <section className="panel history-panel" aria-label="変更履歴">
      <h2>変更履歴</h2>
      {recent.length === 0 ? (
        <p className="muted small">まだ変更はありません。</p>
      ) : (
        <ul className="history">
          {recent.map((b) => (
            <li key={b.batchId} className={b.undone ? "undone" : undefined}>
              {/* 作者はセルの色と同じ色の ○ で示す */}
              <span className="author-dot" style={{ background: TONE_STYLE[b.author].bg }} aria-hidden="true" />
              <div className="history-body">
                <div className="history-head">
                  <span className="author">{AUTHOR_LABEL[b.author]}</span>
                  <span className="ops">{b.opCount} 件</span>
                  <time>{formatTime(b.createdAt)}</time>
                </div>
                {b.reason && <div className="reason">{b.reason}</div>}
              </div>
              <button
                type="button"
                className="btn-ghost icon-btn size-24"
                disabled={b.undone || busy}
                aria-label={b.undone ? "取り消し済み" : "取り消す"}
                title={b.undone ? "取り消し済み" : "取り消す"}
                onClick={() => undo(b.batchId)}
              >
                <Icon name="undo-2" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
