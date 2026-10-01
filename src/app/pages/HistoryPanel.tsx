// 変更履歴（最近のバッチと取り消し）。

import { Undo } from "@carbon/icons-react";
import { IconButton } from "@carbon/react";
import type { Workspace } from "../store";
import { TONE_STYLE, authorLabel } from "../grid/cellStyle";
import { conflictSummary, storeErrorMessage } from "../grid/edits";
import { pagesMessages } from "./messages";

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
  const t = pagesMessages().history;

  const undo = (batchId: string) => {
    try {
      const res = workspace.undoBatch(batchId, { author: "user" });
      const msg = conflictSummary(res.conflicts, "undo");
      if (msg) onMessage(t.partlyUndone(msg), "error");
    } catch (e) {
      onMessage(storeErrorMessage(e, t.undoFailed), "error");
    }
  };

  return (
    <section className="panel history-panel" aria-label={t.title}>
      <h2>{t.title}</h2>
      {recent.length === 0 ? (
        <p className="muted small">{t.empty}</p>
      ) : (
        <ul className="history">
          {recent.map((b) => (
            <li key={b.batchId} className={b.undone ? "undone" : undefined}>
              {/* 作者はセルの色と同じ色の ○ で示す */}
              <span className="author-dot" style={{ background: TONE_STYLE[b.author].bg }} aria-hidden="true" />
              <div className="history-body">
                <div className="history-head">
                  <span className="author">{authorLabel(b.author)}</span>
                  <span className="ops">{t.ops(b.opCount)}</span>
                  <time>{formatTime(b.createdAt)}</time>
                </div>
                {b.reason && <div className="reason">{b.reason}</div>}
              </div>
              <IconButton
                kind="ghost"
                size="sm"
                align="left"
                className="undo"
                disabled={b.undone || busy}
                label={b.undone ? t.undone : t.undo}
                aria-label={b.undone ? t.undone : t.undo}
                onClick={() => undo(b.batchId)}
              >
                <Undo />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
