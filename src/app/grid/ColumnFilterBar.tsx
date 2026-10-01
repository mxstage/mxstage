// 列の絞り込みの操作（札の一覧と、列ごとのメニュー）。
// canvas のグリッドとは別の DOM にしてあるので、ここだけで表示と操作を試験できる。

import { Pin, PinFilled } from "@carbon/icons-react";
import { Button, Checkbox, DismissibleTag, FormGroup, Layer, TextInput } from "@carbon/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { TONE_STYLE } from "./cellStyle";
import { getLocale } from "../../shared/i18n";
import { changeLabel, distinctValues, filterLabel, type ChangeKind, type GridFilter } from "./filters";
import { gridMessages } from "./messages";

export interface ColumnFilterBarProps {
  filters: readonly GridFilter[];
  /** 絞り込んだ後の行数と、絞り込む前の行数（他の表への連動の後） */
  shown?: number;
  total?: number;
  /** 札に出す列の名前（画面表示名）。無ければ列名 */
  titleOf?: (col: string) => string;
  onRemove: (col: string) => void;
  onClearAll: () => void;
}

/**
 * 今かかっている絞り込みの札。列の見出しの ▾ から足す。
 * 絞り込み中は先頭に「絞り込み中 残り / 全体 行」を出す（行が減っていることを見落とさないように）。
 * 絞り込みが無いときは帯を出さない（行数はペインの見出しに出ている）
 */
export function ColumnFilterBar({ filters, shown, total, titleOf, onRemove, onClearAll }: ColumnFilterBarProps) {
  if (filters.length === 0) return null;
  const t = gridMessages().filterBar;
  const fmt = (n: number) => n.toLocaleString(getLocale() === "ja" ? "ja-JP" : "en-US");
  return (
    <div className="filter-bar" role="status">
      <strong className="filter-count">{shown !== undefined && total !== undefined ? t.filteringCount(fmt(shown), fmt(total)) : t.filtering}</strong>
      {filters.map((f) => (
        <DismissibleTag
          key={f.col}
          className="chip"
          type="blue"
          size="md"
          text={filterLabel(f, titleOf?.(f.col))}
          tagTitle={t.chipTitle}
          // 外すボタンの読み上げとツールチップ（文字が切れているときも同じ文言にする）
          title={t.remove(f.col)}
          dismissTooltipLabel={t.remove(f.col)}
          onClose={() => onRemove(f.col)}
        />
      ))}
      <Button kind="ghost" size="sm" onClick={onClearAll}>
        {t.clearAll}
      </Button>
    </div>
  );
}

export interface ColumnFilterMenuProps {
  col: string;
  /** 候補（多い順。値と件数） */
  options: Array<{ value: string; count: number }>;
  /** 変更の状態ごとの件数（その列のセルの色分けと同じ区分） */
  changes?: Array<{ kind: ChangeKind; count: number }>;
  current: GridFilter | null;
  /** 画面上の位置（列の見出しの下） */
  position: { x: number; y: number };
  onApply: (filter: GridFilter | null) => void;
  onClose: () => void;
  /** この列を左に固定しているか（onTogglePin が無ければ固定の操作は出さない） */
  pinned?: boolean;
  onTogglePin?: () => void;
}

/** 変更の状態の色見本（セルの色と同じ）。変更なしは見本を出さない */
function changeSwatch(kind: ChangeKind): string | null {
  return kind === "none" ? null : TONE_STYLE[kind].bg;
}

/** 列 1 つ分の絞り込みメニュー（変更の状態 / 文字を含む / 値を選ぶ / 空・空でない） */
export function ColumnFilterMenu({ col, options, changes = [], current, position, onApply, onClose, pinned = false, onTogglePin }: ColumnFilterMenuProps) {
  const [text, setText] = useState(current?.kind === "contains" ? current.text : "");
  const [picked, setPicked] = useState<string[]>(current?.kind === "values" ? [...current.values] : []);
  const [pickedChanges, setPickedChanges] = useState<ChangeKind[]>(current?.kind === "change" ? [...current.changes] : []);
  // 変更のある列だけ、変更の状態で絞れるようにする（変更が 1 つも無い列では選ぶ意味が無い）
  const changeOptions = changes.some((c) => c.kind !== "none" && c.count > 0) ? changes.filter((c) => c.count > 0 || pickedChanges.includes(c.kind)) : [];
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const t = gridMessages();

  // メニューの外を押したら閉じる
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const toggle = (value: string) => setPicked((p) => (p.includes(value) ? p.filter((v) => v !== value) : [...p, value]));
  const toggleChange = (kind: ChangeKind) => setPickedChanges((p) => (p.includes(kind) ? p.filter((k) => k !== kind) : [...p, kind]));
  // 1 つの列にかける絞り込みは 1 つ。変更の状態を選んでいればそれを、無ければ値・文字を使う
  const apply = () => {
    if (pickedChanges.length > 0) onApply({ col, kind: "change", changes: pickedChanges });
    else if (picked.length > 0) onApply({ col, kind: "values", values: picked });
    else if (text.trim() !== "") onApply({ col, kind: "contains", text: text.trim() });
    else onApply(null);
  };

  return (
    <div className="column-filter" ref={ref} style={{ left: position.x, top: position.y }} role="dialog" aria-label={t.filterMenu.label(col)}>
      {/* メニューは layer-01 の面。中の入力欄は一段上の面の色で描く */}
      <Layer className="column-filter-body">
        <div className="head">
          <span className="mono">{col}</span>
          {onTogglePin && (
            <Button
              kind="ghost"
              size="sm"
              className="pin"
              renderIcon={pinned ? PinFilled : Pin}
              iconDescription={pinned ? t.filterMenu.unpin : t.filterMenu.pin}
              aria-pressed={pinned}
              title={pinned ? t.filterMenu.unpinTitle : t.filterMenu.pinTitle}
              onClick={onTogglePin}
            >
              {pinned ? t.filterMenu.unpin : t.filterMenu.pin}
            </Button>
          )}
        </div>
        {changeOptions.length > 0 && (
          <FormGroup className="changes" legendText={t.filterMenu.changes}>
            <ul className="plain values">
              {changeOptions.map((c) => {
                const swatch = changeSwatch(c.kind);
                return (
                  <li key={c.kind}>
                    <Checkbox
                      id={`${id}-change-${c.kind}`}
                      checked={pickedChanges.includes(c.kind)}
                      onChange={() => toggleChange(c.kind)}
                      labelText={
                        <>
                          {swatch !== null && <span className="swatch" style={{ background: swatch }} aria-hidden="true" />}
                          <span className="value">{changeLabel(c.kind)}</span>
                          <span className="count">{c.count}</span>
                        </>
                      }
                    />
                  </li>
                );
              })}
            </ul>
          </FormGroup>
        )}
        <TextInput
          id={`${id}-contains`}
          size="sm"
          labelText={t.filterMenu.contains}
          hideLabel
          aria-label={t.filterMenu.contains}
          placeholder={t.filterMenu.contains}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") apply();
            if (e.key === "Escape") onClose();
          }}
          spellCheck={false}
          autoComplete="off"
        />
        <ul className="plain values">
          {options.map((o, i) => (
            <li key={o.value}>
              <Checkbox
                id={`${id}-value-${i}`}
                checked={picked.includes(o.value)}
                onChange={() => toggle(o.value)}
                labelText={
                  <>
                    <span className="value">{o.value === "" ? t.hover.empty : o.value}</span>
                    <span className="count">{o.count}</span>
                  </>
                }
              />
            </li>
          ))}
          {options.length === 0 && <li className="muted small">{t.filterMenu.noValues}</li>}
        </ul>
        <div className="actions">
          <Button kind="ghost" size="sm" onClick={() => onApply({ col, kind: "notEmpty" })}>
            {t.filterMenu.notEmpty}
          </Button>
          <Button kind="ghost" size="sm" onClick={() => onApply({ col, kind: "empty" })}>
            {t.filterMenu.empty}
          </Button>
          <Button kind="ghost" size="sm" onClick={() => onApply(null)}>
            {t.filterMenu.clear}
          </Button>
          <Button kind="primary" size="sm" onClick={apply}>
            {t.filterMenu.apply}
          </Button>
        </div>
      </Layer>
    </div>
  );
}

/** 列の候補を作る（行の表示値から。呼び出し側の useMemo 用） */
export function useColumnOptions<T>(rows: readonly T[], col: string | null, valueOf: (row: T, col: string) => string): Array<{ value: string; count: number }> {
  return useMemo(() => (col === null ? [] : distinctValues(rows, col, valueOf)), [rows, col, valueOf]);
}
