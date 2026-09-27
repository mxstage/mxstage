// 反映パネル。Maximo への書き込みは、利用者がここで [Maximo に反映] を押して確認したときだけ行う。

import { useEffect, useMemo, useState } from "react";
import type { CommitController, CommitPanelState } from "../runtime/contracts";
import { Corners } from "../ui/Corners";
import { Dialog } from "../ui/Dialog";
import { hostOf } from "./status";
import {
  COMMIT_STATE_LABEL,
  RESULT_STATUS_LABEL,
  canCancelCommit,
  canConfirmCommit,
  commitButtonState,
  confirmLines,
  displayRowKey,
  resultSummary,
  runOutcomeMessage,
  withBom,
  writeLogFileName,
  type ConfirmChecks,
} from "./commitLogic";

export interface CommitPanelProps {
  commits: CommitController;
  sheet: string;
  /** 再描画のきっかけ */
  version: number;
  connected: boolean;
  locked: boolean;
  onMessage: (text: string, tone: "info" | "error") => void;
}

const MAX_RESULT_ROWS = 200;

function safePanel(commits: CommitController, sheet: string): CommitPanelState | null {
  try {
    return commits.panel(sheet);
  } catch {
    return null;
  }
}

function downloadText(text: string, fileName: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function CommitPanel({ commits, sheet, version, connected, locked, onMessage }: CommitPanelProps) {
  const [confirming, setConfirming] = useState(false);
  const [checks, setChecks] = useState<ConfirmChecks>({ deletes: false, nulls: false });
  const panel = safePanel(commits, sheet);

  // シートを切り替えたら確認をやり直す（別のシートの件数で確認したまま、このシートを反映しないため）
  useEffect(() => {
    setConfirming(false);
    setChecks({ deletes: false, nulls: false });
  }, [sheet]);

  // 書き込みログの有無。version は別のシートの反映でも増えるので、そちらで増えたときも見直す。
  // ただし writeLog() は全件（最大 1 万件）を複製するので、LLM の変更で version が毎フレーム増える間に
  // 数え直させない。ログは減らず、作業終了では controller ごと作り直すので、1 度入ったことを覚えれば足りる。
  // 反映中（1 行ごとに再描画する）は CSV を出さない。
  const logSeen = useMemo(() => ({ value: false }), [commits]);
  const hasLog = useMemo(() => {
    if (!logSeen.value && commits.writeLog().length > 0) logSeen.value = true;
    return logSeen.value && panel !== null && panel.state !== "running";
  }, [commits, logSeen, panel?.state, panel?.results.length, version]);

  if (!panel) return null;

  const button = commitButtonState(panel, { connected, locked });
  const c = panel.counts;
  const canary = panel.awaitingCanary;

  const start = async () => {
    setConfirming(false);
    try {
      const result = await commits.run(sheet, {
        allowNull: panel.needsNullConfirm ? checks.nulls : false,
        deletesConfirmed: panel.needsDeleteConfirm ? checks.deletes : false,
      });
      // 反映しなかった理由は controller が message で返す（無ければボタンの条件から推測する）
      const outcome = runOutcomeMessage(result, { connected, locked });
      onMessage(outcome.text, outcome.tone);
    } catch (e) {
      onMessage(`反映できませんでした: ${e instanceof Error && e.message ? e.message : "不明なエラー"}`, "error");
    }
  };

  // 中止しても送信済みの分は取り消せない。残りを送るのをやめるだけ
  const cancel = () => {
    try {
      commits.cancel(sheet);
      onMessage("反映を中止します。送信済みの分は取り消されません。", "info");
    } catch (e) {
      onMessage(`中止できませんでした: ${e instanceof Error && e.message ? e.message : "不明なエラー"}`, "error");
    }
  };

  return (
    <section className={`panel commit-panel${panel.state === "requested" ? " requested" : ""}`} aria-label="Maximo への反映">
      <div className="commit-head">
        <h2>Maximo への反映</h2>
        {panel.target && (
          <p className="commit-target" title="シートを読み込んだオブジェクト構造と接続先に反映します">
            <span className="mono">{panel.target.os}</span>
            {panel.target.baseUrl && <> → {hostOf(panel.target.baseUrl)}</>}
          </p>
        )}
      </div>
      {panel.state === "requested" && (
        <div className="request-note" role="status">
          <div className="request-head" title="差分を確認してから反映してください。">
            LLM から反映の依頼があります
          </div>
          {panel.note && <p className="note">{panel.note}</p>}
          <button type="button" className="btn-ghost" onClick={() => commits.dismiss(sheet)}>
            依頼を閉じる
          </button>
        </div>
      )}
      {/* 数字を上に出す（dt を先に置いたまま CSS で並びを逆にする） */}
      <dl className="counts">
        <div>
          <dt>親レコード</dt>
          <dd>{c.parents}</dd>
        </div>
        <div>
          <dt>変更セル</dt>
          <dd>{c.changedCells}</dd>
        </div>
        <div>
          <dt>追加行</dt>
          <dd>{c.addedRows}</dd>
        </div>
        <div>
          <dt>削除行</dt>
          <dd>{c.deletedRows}</dd>
        </div>
      </dl>
      {panel.blockers.length > 0 && (
        <ul className="blockers">
          {panel.blockers.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="primary commit-button blueprint"
        disabled={!button.enabled}
        onClick={() => {
          setChecks({ deletes: false, nulls: false });
          setConfirming(true);
        }}
      >
        <Corners />
        Maximo に反映
      </button>
      <div className="commit-status">
        <span>状態: {COMMIT_STATE_LABEL[panel.state]}</span>
        {hasLog && (
          <button type="button" className="link" onClick={() => downloadText(withBom(commits.writeLogCsv()), writeLogFileName(new Date()))}>
            書き込みログ（CSV）
          </button>
        )}
      </div>
      {canCancelCommit(panel) && (
        <button type="button" className="wide cancel" onClick={cancel}>
          反映を中止
        </button>
      )}
      {button.reason && <p className="muted small">{button.reason}</p>}
      {panel.message && (
        <p className="commit-message small" role="status">
          {panel.message}
        </p>
      )}

      {panel.results.length > 0 && (
        <details className="results" open>
          <summary>行ごとの結果（{resultSummary(panel.results)}）</summary>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {panel.results.slice(0, MAX_RESULT_ROWS).map((r, i) => (
                  <tr key={`${r.rowKey}-${i}`} className={`result-${r.status}`}>
                    <td className="mono">{displayRowKey(r.rowKey)}</td>
                    <td>{RESULT_STATUS_LABEL[r.status]}</td>
                    <td className="muted">
                      {r.httpStatus ? `HTTP ${r.httpStatus}` : ""}
                      {r.reasonCode ? ` ${r.reasonCode}` : ""}
                      {r.message ? ` ${r.message}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {panel.results.length > MAX_RESULT_ROWS && <p className="muted small">先頭の {MAX_RESULT_ROWS} 件だけ表示しています。全件は書き込みログにあります。</p>}
        </details>
      )}

      {confirming && (
        <Dialog
          title="Maximo に反映しますか？"
          onClose={() => setConfirming(false)}
          actions={
            <>
              <button type="button" onClick={() => setConfirming(false)}>
                やめる
              </button>
              <button type="button" className="primary" disabled={!canConfirmCommit(panel, checks)} onClick={() => void start()}>
                反映する
              </button>
            </>
          }
        >
          <ul className="plain">
            {confirmLines(panel).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="muted small">最初の 1 件を送ったところで結果を確認してから、残りを送ります。自動では再試行しません。</p>
          {panel.needsDeleteConfirm && (
            <label className="check">
              <input type="checkbox" checked={checks.deletes} onChange={(e) => setChecks((s) => ({ ...s, deletes: e.target.checked }))} />
              削除 {c.deletedRows} 件を含むことを確認しました
            </label>
          )}
          {panel.needsNullConfirm && (
            <label className="check">
              <input type="checkbox" checked={checks.nulls} onChange={(e) => setChecks((s) => ({ ...s, nulls: e.target.checked }))} />
              空（null）への変更を含むことを確認しました
            </label>
          )}
        </Dialog>
      )}

      {canary && (
        <Dialog
          title="最初の 1 件の結果"
          actions={
            <>
              <button type="button" onClick={cancel}>
                中止
              </button>
              <button type="button" className="primary" onClick={() => commits.continueCanary(sheet, true)}>
                続行
              </button>
            </>
          }
        >
          <p>
            <span className="mono">{displayRowKey(canary.rowKey)}</span>: <strong>{RESULT_STATUS_LABEL[canary.status]}</strong>
          </p>
          {(canary.httpStatus || canary.reasonCode) && (
            <p className="small">
              {canary.httpStatus ? `HTTP ${canary.httpStatus}` : ""}
              {canary.reasonCode ? ` ${canary.reasonCode}` : ""}
            </p>
          )}
          {canary.message && <p className="muted small">{canary.message}</p>}
          <p>Maximo で内容を確かめてから、残りを送るか決めてください。</p>
        </Dialog>
      )}
    </section>
  );
}
