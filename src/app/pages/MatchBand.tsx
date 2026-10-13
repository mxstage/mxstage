// 突き合わせの帯（左のシートの表の上）: 一致・候補が複数・見つからないの数、行の絞り込み、AI が使った条件。

import { Close } from "@carbon/icons-react";
import { Button, IconButton, Toggletip, ToggletipButton, ToggletipContent } from "@carbon/react";
import { dictionaryMessages } from "../dictionaries/messages";
import type { MatchView } from "../match/views";

export type MatchBandFilter = "all" | "unmatched" | "ambiguous";

export interface MatchBandProps {
  view: MatchView;
  conditions: readonly string[];
  filter: MatchBandFilter;
  onFilter: (f: MatchBandFilter) => void;
  onClose: () => void;
}

export function MatchBand({ view, conditions, filter, onFilter, onClose }: MatchBandProps) {
  const t = dictionaryMessages().band;
  const c = view.counts;
  return (
    <div className="match-band" role="status">
      <strong>{t.title}</strong>
      <span className="match-pair">{t.pair(view.args.left, view.args.right)}</span>
      <span className="match-count">
        <span className="mark mark-ok" aria-hidden="true" />
        {t.matched} <b>{c.matched}</b>
      </span>
      <span className="match-count">
        <span className="mark mark-warn" aria-hidden="true" />
        {c.ambiguous > 0 ? (
          <button type="button" className={`link${filter === "ambiguous" ? " on" : ""}`} onClick={() => onFilter(filter === "ambiguous" ? "all" : "ambiguous")}>
            {t.ambiguous} <b>{c.ambiguous}</b>
          </button>
        ) : (
          <>
            {t.ambiguous} <b>0</b>
          </>
        )}
      </span>
      <span className="match-count">
        <span className="mark mark-none" aria-hidden="true" />
        {t.unmatched} <b>{c.unmatched}</b>
      </span>
      {c.unmatched > 0 && (
        <Button kind={filter === "unmatched" ? "primary" : "ghost"} size="sm" className="match-only" onClick={() => onFilter(filter === "unmatched" ? "all" : "unmatched")}>
          {filter === "unmatched" ? t.showAll : t.onlyUnmatched}
        </Button>
      )}
      <Toggletip align="bottom" className="match-conditions">
        <ToggletipButton label={t.conditions}>
          <span className="link">{t.conditions}</span>
        </ToggletipButton>
        <ToggletipContent>
          <ul className="plain conditions">
            {conditions.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </ToggletipContent>
      </Toggletip>
      <IconButton kind="ghost" size="sm" align="bottom-end" label={t.close} wrapperClasses="match-close" onClick={onClose}>
        <Close />
      </IconButton>
    </div>
  );
}
