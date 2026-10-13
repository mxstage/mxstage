// 右のパネル（取り込んだファイルのシートのとき）: Maximo には反映しないので反映の欄は出さず、
// 取り込んだファイル（ファイル名・シート・帳票の数・行の数）と、突き合わせの結果を出す。

import { BLOCK_COLUMN } from "../imports/shape";
import { dictionaryMessages } from "../dictionaries/messages";
import type { MatchView } from "../match/views";
import type { Workspace } from "../store";

export interface ImportPanelProps {
  workspace: Workspace;
  sheet: string;
  match: MatchView | null;
  /** 再描画のきっかけ */
  version: number;
  onOnlyUnmatched?: () => void;
}

export function ImportPanel({ workspace, sheet, match, onOnlyUnmatched }: ImportPanelProps) {
  const t = dictionaryMessages().importPanel;
  const b = dictionaryMessages().band;
  if (!workspace.hasSheet(sheet)) return null;
  const s = workspace.getSheet(sheet);
  const src = s.meta.source;
  if (src.kind !== "excel") return null;
  const rows = s.viewRows("final");
  const forms = s.hasColumn(BLOCK_COLUMN) ? new Set(rows.map((r) => String(s.finalValue(r, BLOCK_COLUMN) ?? ""))).size : 0;
  const dictionaries = match?.args.extra.dictionaries ?? [];
  return (
    <section className="panel import-panel" aria-label={t.title}>
      <h2>{t.title}</h2>
      <p className="kv">
        <strong>{src.fileName}</strong> › {src.sheetName}
      </p>
      <p className="kv muted">{[forms > 0 ? t.forms(forms) : null, t.rows(rows.length)].filter((x) => x !== null).join(" ・ ")}</p>
      <h2 className="history-title">{t.matchTitle}</h2>
      {match === null ? (
        <p className="muted small">{t.noMatch}</p>
      ) : (
        <>
          <p className="kv muted">{t.with(match.args.right)}</p>
          <dl className="counts">
            <div>
              <dt>{b.matched}</dt>
              <dd>{match.counts.matched}</dd>
            </div>
            <div>
              <dt>{b.ambiguous}</dt>
              <dd>{match.counts.ambiguous}</dd>
            </div>
            <div>
              <dt>{b.unmatched}</dt>
              <dd>{match.counts.unmatched > 0 && onOnlyUnmatched ? (
                <button type="button" className="link count-link" onClick={onOnlyUnmatched}>
                  {match.counts.unmatched}
                </button>
              ) : (
                match.counts.unmatched
              )}</dd>
            </div>
          </dl>
          {dictionaries.length > 0 && (
            <p className="kv muted small">
              {t.usedDictionaries} {dictionaries.join("・")}
            </p>
          )}
        </>
      )}
      <p className="muted small">{t.noCommit}</p>
    </section>
  );
}
