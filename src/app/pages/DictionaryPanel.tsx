// 右のパネル（辞書のタブのとき）: 保存前の変更の数、保存（メンバーと共有）、メンバー全員の変更履歴と元に戻す。

import { Button } from "@carbon/react";
import { useState } from "react";
import { DICT_FIND, DICT_MODE, DICT_NOTE, DICT_TO, DICT_UPDATED } from "../../shared/dictionarySheet";
import { buildXlsx, XLSX_STYLE } from "../commit/xlsxWriter";
import { dictionaryMessages } from "../dictionaries/messages";
import type { DictionaryService } from "../dictionaries/service";
import { pendingChanges } from "../dictionaries/sheet";
import { formatColumnValue } from "../grid/cellStyle";
import type { Workspace } from "../store";
import { Notice } from "../ui/Notice";

export interface DictionaryPanelProps {
  service: DictionaryService;
  workspace: Workspace;
  sheet: string;
  /** 再描画のきっかけ */
  version: number;
  onMessage: (text: string, tone: "info" | "error") => void;
}

/** 書き出す Excel の列の幅 */
const EXPORT_WIDTHS: Record<string, number> = { [DICT_FIND]: 28, [DICT_TO]: 28, [DICT_MODE]: 14, [DICT_NOTE]: 40, [DICT_UPDATED]: 22 };

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function download(bytes: Uint8Array, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function DictionaryPanel({ service, workspace, sheet, onMessage }: DictionaryPanelProps) {
  const t = dictionaryMessages().panel;
  const [busy, setBusy] = useState(false);
  const od = service.openOf(sheet);
  const listing = service.snapshot().listing;
  const folder = listing?.folder ?? null;
  const shared = folder !== null && folder.path !== null;
  const readOnly = folder !== null && folder.path !== null && folder.reachable && !folder.writable;
  if (!workspace.hasSheet(sheet) || od === null) return null;
  const pending = pendingChanges(workspace.getSheet(sheet));
  const total = pending.added + pending.changed + pending.deleted + pending.problems.length;

  const save = async () => {
    setBusy(true);
    try {
      const res = await service.save(sheet);
      if (res.ok) onMessage(t.saved(res.saved), "info");
      else onMessage(res.problems ? res.message : t.failed(res.message), "error");
    } finally {
      setBusy(false);
    }
  };

  const revert = async (saveId: string) => {
    const res = await service.revert(sheet, saveId);
    if (res.ok) onMessage(t.reverted(res.reverted, res.skipped), "info");
    else onMessage(t.failed(res.message), "error");
  };

  const exportExcel = () => {
    // 辞書の種類ごとの列（呼び名・言葉 → コード・値の置き換え）と見出しを、タブに出しているとおりに書き出す
    const s = workspace.getSheet(sheet);
    const cols = s.meta.columns;
    const header = cols.map((col) => col.title ?? col.name);
    const rows = s.viewRows("final").map((r) => ({ cells: cols.map((col) => formatColumnValue(col, s.finalValue(r, col.name))) }));
    const widths = cols.map((col) => EXPORT_WIDTHS[col.name] ?? 20);
    download(buildXlsx([{ name: od.name.slice(0, 31) || "dictionary", rows: [{ cells: header, style: XLSX_STYLE.header }, ...rows], widths }]), `${od.name}.xlsx`);
  };

  return (
    <section className="panel dictionary-panel" aria-label={t.title}>
      <h2>{t.title}</h2>
      {od.newerBy !== null && <Notice kind="info">{t.newer(od.newerBy)}</Notice>}
      {readOnly && <Notice kind="warning">{t.readOnly}</Notice>}
      {total === 0 ? (
        <p className="muted small">{t.nothing}</p>
      ) : (
        <dl className="counts">
          <div>
            <dt>{t.added}</dt>
            <dd>{pending.added}</dd>
          </div>
          <div>
            <dt>{t.changed}</dt>
            <dd>{pending.changed}</dd>
          </div>
          <div>
            <dt>{t.deleted}</dt>
            <dd>{pending.deleted}</dd>
          </div>
        </dl>
      )}
      {pending.problems.length > 0 && <p className="small error-text">{t.problems(pending.problems.length)}</p>}
      <Button kind="primary" size="lg" className="commit-button" disabled={busy || od.saving || readOnly || total === 0} onClick={() => void save()}>
        {od.saving || busy ? t.saving : shared ? t.saveShared : t.saveLocal}
      </Button>
      <p className="muted small">{shared ? t.helpShared : t.helpLocal}</p>
      <div className="dictionary-links">
        <Button kind="ghost" size="sm" onClick={exportExcel}>
          {t.exportExcel}
        </Button>
      </div>
      {od.problems.length > 0 && <p className="small error-text">{t.fileProblems(od.problems.length)}</p>}
      <h2 className="history-title">{t.history}</h2>
      {od.history.length === 0 ? (
        <p className="muted small">{t.historyEmpty}</p>
      ) : (
        <ul className="history dictionary-history">
          {od.history.slice(0, 30).map((h) => (
            <li key={h.saveId}>
              <div className="history-head">
                <strong>{h.by}</strong>
                <span className="muted small">{shortTime(h.at)}</span>
                {h.revertible && (
                  <Button kind="ghost" size="sm" className="history-undo" title={t.revertTitle} onClick={() => void revert(h.saveId)}>
                    {t.revert}
                  </Button>
                )}
              </div>
              <div className="small">{t.historyLine(h.sample, h.added, h.changed, h.deleted)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
