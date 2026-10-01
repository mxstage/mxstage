// 反映パネル。Maximo への書き込みは、利用者がここで [Maximo に反映] を押して確認したときだけ行う。

import { Accordion, AccordionItem, Button, Checkbox, ListItem, Table, TableBody, TableCell, TableRow, UnorderedList } from "@carbon/react";
import { useEffect, useId, useMemo, useState } from "react";
import { commitMessages } from "../commit/messages";
import type { CommitController, CommitPanelState } from "../runtime/contracts";
import { Dialog } from "../ui/Dialog";
import { Notice } from "../ui/Notice";
import { hostOf } from "./status";
import {
  canCancelCommit,
  canConfirmCommit,
  commitButtonState,
  commitStateLabel,
  confirmLines,
  displayRowKey,
  resultStatusLabel,
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
  const checkId = useId();
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

  const t = commitMessages().panel;
  const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : commitMessages().unknownError);
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
      onMessage(t.runFailed(errorText(e)), "error");
    }
  };

  // 中止しても送信済みの分は取り消せない。残りを送るのをやめるだけ
  const cancel = () => {
    try {
      commits.cancel(sheet);
      onMessage(t.cancelling, "info");
    } catch (e) {
      onMessage(t.cancelFailed(errorText(e)), "error");
    }
  };

  return (
    <section className={`panel commit-panel${panel.state === "requested" ? " requested" : ""}`} aria-label={t.title}>
      <div className="commit-head">
        <h2>{t.title}</h2>
        {panel.target && (
          <p className="commit-target" title={t.targetTitle}>
            <span className="mono">{panel.target.os}</span>
            {panel.target.baseUrl && <> → {hostOf(panel.target.baseUrl)}</>}
          </p>
        )}
      </div>
      {panel.state === "requested" && (
        <div className="request-note">
          {/* 知らせの中にはボタンを置けない（Carbon が拒む）ので、「依頼を閉じる」は知らせの下に置く */}
          <Notice kind="info">
            <div className="request-head" title={t.requestTitle}>
              {t.requested}
            </div>
            {panel.note && <p className="note">{panel.note}</p>}
          </Notice>
          <Button kind="ghost" size="sm" onClick={() => commits.dismiss(sheet)}>
            {t.dismissRequest}
          </Button>
        </div>
      )}
      {/* 数字を上に出す（dt を先に置いたまま CSS で並びを逆にする） */}
      <dl className="counts">
        <div>
          <dt>{t.counts.parents}</dt>
          <dd>{c.parents}</dd>
        </div>
        <div>
          <dt>{t.counts.changedCells}</dt>
          <dd>{c.changedCells}</dd>
        </div>
        <div>
          <dt>{t.counts.addedRows}</dt>
          <dd>{c.addedRows}</dd>
        </div>
        <div>
          <dt>{t.counts.deletedRows}</dt>
          <dd>{c.deletedRows}</dd>
        </div>
      </dl>
      {panel.blockers.length > 0 && (
        <UnorderedList className="blockers">
          {panel.blockers.map((b, i) => (
            <ListItem key={i}>{b}</ListItem>
          ))}
        </UnorderedList>
      )}
      {/* 作業画面で常に出ている primary のボタンはこれ 1 つだけ */}
      <Button
        kind="primary"
        size="lg"
        className="commit-button"
        disabled={!button.enabled}
        onClick={() => {
          setChecks({ deletes: false, nulls: false });
          setConfirming(true);
        }}
      >
        {t.commitButton}
      </Button>
      <div className="commit-status">
        <span>{t.status(commitStateLabel(panel.state))}</span>
        {hasLog && (
          <Button kind="ghost" size="sm" className="log-link" onClick={() => downloadText(withBom(commits.writeLogCsv()), writeLogFileName(new Date()))}>
            {t.writeLog}
          </Button>
        )}
      </div>
      {canCancelCommit(panel) && (
        <Button kind="secondary" size="md" className="cancel" onClick={cancel}>
          {t.cancelCommit}
        </Button>
      )}
      {button.reason && <p className="muted small">{button.reason}</p>}
      {panel.message && (
        <p className="commit-message small" role="status">
          {panel.message}
        </p>
      )}

      {panel.results.length > 0 && (
        <Accordion size="sm" align="start">
          <AccordionItem className="results" open title={t.results(resultSummary(panel.results))}>
            <div className="table-wrap">
              <Table size="xs">
                <TableBody>
                  {panel.results.slice(0, MAX_RESULT_ROWS).map((r, i) => (
                    <TableRow key={`${r.rowKey}-${i}`} className={`result-${r.status}`}>
                      <TableCell className="mono">{displayRowKey(r.rowKey)}</TableCell>
                      <TableCell>{resultStatusLabel(r.status)}</TableCell>
                      <TableCell className="muted">
                        {r.httpStatus ? `HTTP ${r.httpStatus}` : ""}
                        {r.reasonCode ? ` ${r.reasonCode}` : ""}
                        {r.message ? ` ${r.message}` : ""}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {panel.results.length > MAX_RESULT_ROWS && <p className="muted small">{t.resultsTruncated(MAX_RESULT_ROWS)}</p>}
          </AccordionItem>
        </Accordion>
      )}

      {confirming && (
        <Dialog
          title={t.confirmTitle}
          onClose={() => setConfirming(false)}
          actions={
            <>
              <Button kind="secondary" onClick={() => setConfirming(false)}>
                {t.confirmCancel}
              </Button>
              <Button kind="primary" disabled={!canConfirmCommit(panel, checks)} onClick={() => void start()}>
                {t.confirmCommit}
              </Button>
            </>
          }
        >
          <ul className="plain">
            {confirmLines(panel).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="muted small">{t.canaryNote}</p>
          {panel.needsDeleteConfirm && (
            <Checkbox
              id={`${checkId}-deletes`}
              labelText={t.confirmDeletes(c.deletedRows)}
              checked={checks.deletes}
              onChange={(_, { checked }) => setChecks((s) => ({ ...s, deletes: checked }))}
            />
          )}
          {panel.needsNullConfirm && (
            <Checkbox
              id={`${checkId}-nulls`}
              labelText={t.confirmNulls}
              checked={checks.nulls}
              onChange={(_, { checked }) => setChecks((s) => ({ ...s, nulls: checked }))}
            />
          )}
        </Dialog>
      )}

      {canary && (
        <Dialog
          title={t.canaryTitle}
          actions={
            <>
              <Button kind="secondary" onClick={cancel}>
                {t.canaryStop}
              </Button>
              <Button kind="primary" onClick={() => commits.continueCanary(sheet, true)}>
                {t.canaryContinue}
              </Button>
            </>
          }
        >
          <p>
            <span className="mono">{displayRowKey(canary.rowKey)}</span>: <strong>{resultStatusLabel(canary.status)}</strong>
          </p>
          {(canary.httpStatus || canary.reasonCode) && (
            <p className="small">
              {canary.httpStatus ? `HTTP ${canary.httpStatus}` : ""}
              {canary.reasonCode ? ` ${canary.reasonCode}` : ""}
            </p>
          )}
          {canary.message && <p className="muted small">{canary.message}</p>}
          <p>{t.canaryCheck}</p>
        </Dialog>
      )}
    </section>
  );
}
