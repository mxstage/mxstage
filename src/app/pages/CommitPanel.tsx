// 反映パネル。Maximo への書き込みは、利用者がここで [Maximo に反映] を押して確認したときだけ行う。

import { Accordion, AccordionItem, Button, Checkbox, ListItem, NumberInput, RadioButton, RadioButtonGroup, Table, TableBody, TableCell, TableRow, UnorderedList } from "@carbon/react";
import { useEffect, useId, useMemo, useState } from "react";
import { diffReportFileName, diffReportMessages, diffReportXlsx, takeReportSnapshot } from "../commit/diffReport";
import { commitMessages } from "../commit/messages";
import type { LicenseClient } from "../license/client";
import type { Workspace } from "../store";
import type { CommitBatchSize, CommitController, CommitPanelState } from "../runtime/contracts";
import { DEFAULT_COMMIT_BATCH } from "../maximo/commit";
import { batchSizeOf } from "../commit/controller";
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
  statusTargetsText,
  withBom,
  writeLogFileName,
  type ConfirmChecks,
} from "./commitLogic";
import { isIrreversibleStatus } from "../../shared/status";

export interface CommitPanelProps {
  commits: CommitController;
  sheet: string;
  /** 再描画のきっかけ */
  version: number;
  connected: boolean;
  locked: boolean;
  onMessage: (text: string, tone: "info" | "error") => void;
  /** 差分レポート（Excel）を作るのに使う。無ければボタンを出さない */
  workspace?: Workspace;
  /** 差分レポートに環境（テスト・本番）を書くのに使う */
  license?: LicenseClient;
}

const MAX_RESULT_ROWS = 200;

/** 「1 回の反映数」を覚えておく localStorage のキー（この窓・このブラウザだけ） */
const BATCH_STORAGE_KEY = "mxstage.commit.batch";
/** 件数を指定するときの上限（入力の打ち間違いで桁が増えすぎないように） */
const MAX_BATCH = 100_000;

interface BatchSetting {
  mode: "all" | "count";
  count: number;
}

function loadBatch(): BatchSetting {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage?.getItem(BATCH_STORAGE_KEY) : null;
    if (raw) {
      const v = JSON.parse(raw) as Partial<BatchSetting>;
      const count = typeof v.count === "number" && Number.isFinite(v.count) && v.count >= 1 ? Math.min(MAX_BATCH, Math.floor(v.count)) : DEFAULT_COMMIT_BATCH;
      return { mode: v.mode === "all" ? "all" : "count", count };
    }
  } catch {
    // 読めなければ既定に戻す
  }
  return { mode: "count", count: DEFAULT_COMMIT_BATCH };
}

function saveBatch(b: BatchSetting): void {
  try {
    window.localStorage?.setItem(BATCH_STORAGE_KEY, JSON.stringify(b));
  } catch {
    // 覚えられなくても、この画面の間は選んだ値で動く
  }
}

const batchSizeFrom = (b: BatchSetting): CommitBatchSize => (b.mode === "all" ? "all" : b.count);

function safePanel(commits: CommitController, sheet: string): CommitPanelState | null {
  try {
    return commits.panel(sheet);
  } catch {
    return null;
  }
}

function downloadText(text: string, fileName: string): void {
  downloadBlob(new Blob([text], { type: "text/csv;charset=utf-8" }), fileName);
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function CommitPanel({ commits, sheet, version, connected, locked, onMessage, workspace, license }: CommitPanelProps) {
  const [confirming, setConfirming] = useState(false);
  const [checks, setChecks] = useState<ConfirmChecks>({ deletes: false, nulls: false, irreversible: false });
  const [batch, setBatch] = useState<BatchSetting>(loadBatch);
  const checkId = useId();
  const updateBatch = (b: BatchSetting) => {
    setBatch(b);
    saveBatch(b);
  };
  const panel = safePanel(commits, sheet);

  // シートを切り替えたら確認をやり直す（別のシートの件数で確認したまま、このシートを反映しないため）
  useEffect(() => {
    setConfirming(false);
    setChecks({ deletes: false, nulls: false, irreversible: false });
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
        irreversibleConfirmed: panel.needsIrreversibleConfirm === true ? checks.irreversible === true : false,
        batchSize: batchSizeFrom(batch),
      });
      // 反映しなかった理由は controller が message で返す（無ければボタンの条件から推測する）
      const outcome = runOutcomeMessage(result, { connected, locked });
      onMessage(outcome.text, outcome.tone);
    } catch (e) {
      onMessage(t.runFailed(errorText(e)), "error");
    }
  };

  // 差分レポート（Excel）。作業画面のメモリにある差分だけから作り、どこにも送らない。
  // 反映の後に編集が無ければ、反映した回の写しとその回の書き込みログ（反映した行は差分から消えているため）。
  // それ以外は今の差分（反映の前の承認の証跡）
  const hasDiff = c.changedCells + c.addedRows + c.deletedRows > 0;
  const last = commits.lastRun(sheet);
  const lastFresh = workspace !== undefined && last !== null && last.endRevision !== null && last.endRevision === workspace.revision;
  const saveReport = () => {
    if (workspace === undefined) return;
    try {
      const now = new Date();
      const env = panel.target?.baseUrl ? (license?.environmentOf(panel.target.baseUrl) ?? null) : null;
      const r = diffReportMessages();
      const bytes = diffReportXlsx({
        ...(lastFresh && last !== null ? { snapshot: last.snapshot, writeLog: last.log } : { snapshot: takeReportSnapshot(workspace, sheet, panel, now.getTime()) }),
        environment: env === null ? null : r.environments[env],
        now: now.getTime(),
      });
      const name = diffReportFileName(sheet, now);
      downloadBlob(new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), name);
      onMessage(r.saved(name), "info");
    } catch (e) {
      onMessage(`${diffReportMessages().failed}: ${errorText(e)}`, "error");
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
        {(c.newRecords ?? 0) > 0 && (
          <div>
            <dt>{t.counts.newRecords}</dt>
            <dd>{c.newRecords}</dd>
          </div>
        )}
        {(c.statusChanges ?? 0) > 0 && (
          <div>
            <dt>{t.counts.statusChanges}</dt>
            <dd title={statusTargetsText(c)}>{c.statusChanges}</dd>
          </div>
        )}
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
      {/* 1 回の反映数（すべて・件数）。[Maximo に反映] の上に置く */}
      <div className="commit-batch">
        <RadioButtonGroup
          legendText={t.batchLegend}
          name={`${checkId}-batch`}
          orientation="horizontal"
          valueSelected={batch.mode}
          disabled={panel.state === "running"}
          onChange={(v) => updateBatch({ ...batch, mode: v === "all" ? "all" : "count" })}
        >
          <RadioButton labelText={t.batchAll} value="all" id={`${checkId}-batch-all`} />
          <RadioButton labelText={t.batchCount} value="count" id={`${checkId}-batch-count`} />
        </RadioButtonGroup>
        {batch.mode === "count" && (
          <NumberInput
            id={`${checkId}-batch-n`}
            label={t.batchCountLabel}
            hideLabel
            size="sm"
            min={1}
            max={MAX_BATCH}
            step={1}
            value={batch.count}
            disabled={panel.state === "running"}
            onChange={(_, { value }) => {
              const n = typeof value === "number" ? value : Number(value);
              if (Number.isFinite(n) && n >= 1) updateBatch({ ...batch, count: Math.min(MAX_BATCH, Math.floor(n)) });
            }}
          />
        )}
      </div>
      {/* 作業画面で常に出ている primary のボタンはこれ 1 つだけ */}
      <Button
        kind="primary"
        size="lg"
        className="commit-button"
        disabled={!button.enabled}
        onClick={() => {
          setChecks({ deletes: false, nulls: false, irreversible: false });
          setConfirming(true);
        }}
      >
        {t.commitButton}
      </Button>
      <div className="commit-status">
        <span>{t.status(commitStateLabel(panel.state))}</span>
        {workspace !== undefined && (hasDiff || lastFresh) && panel.state !== "running" && (
          <Button kind="ghost" size="sm" className="report-link" title={diffReportMessages().buttonTitle} onClick={saveReport}>
            {diffReportMessages().button}
          </Button>
        )}
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
                      <TableCell className="mono" title={displayRowKey(r.rowKey)}>
                        {displayRowKey(r.rowKey)}
                      </TableCell>
                      <TableCell title={resultStatusLabel(r.status)}>{resultStatusLabel(r.status)}</TableCell>
                      <TableCell className="muted" title={`${r.httpStatus ? `HTTP ${r.httpStatus}` : ""}${r.reasonCode ? ` ${r.reasonCode}` : ""}${r.message ? ` ${r.message}` : ""}`.trim()}>
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
          {batchSizeOf(batchSizeFrom(batch), c.parents) < c.parents && <p className="small">{t.batchLine(batchSizeOf(batchSizeFrom(batch), c.parents), c.parents)}</p>}
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
          {panel.needsIrreversibleConfirm === true && (
            <Checkbox
              id={`${checkId}-irreversible`}
              labelText={t.confirmIrreversible(c.irreversible ?? 0, Object.keys(c.statusTargets ?? {}).filter(isIrreversibleStatus).join(", "))}
              checked={checks.irreversible === true}
              onChange={(_, { checked }) => setChecks((s) => ({ ...s, irreversible: checked }))}
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
