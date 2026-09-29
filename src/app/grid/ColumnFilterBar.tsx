// 列の絞り込みの操作（札の一覧と、列ごとのメニュー）。
// canvas のグリッドとは別の DOM にしてあるので、ここだけで表示と操作を試験できる。

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import { TONE_STYLE } from "./cellStyle";
import { CHANGE_LABEL, distinctValues, filterLabel, type ChangeKind, type GridFilter } from "./filters";

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
  const fmt = (n: number) => n.toLocaleString("ja-JP");
  return (
    <div className="filter-bar" role="status">
      <strong className="filter-count">{shown !== undefined && total !== undefined ? `絞り込み中 ${fmt(shown)} / ${fmt(total)} 行` : "絞り込み中"}</strong>
      {filters.map((f) => (
        <span key={f.col} className="chip" title="全角半角・大文字小文字は区別しません">
          {filterLabel(f, titleOf?.(f.col))}
          <button type="button" aria-label={`${f.col} の絞り込みを外す`} onClick={() => onRemove(f.col)}>
            ×
          </button>
        </span>
      ))}
      <button type="button" className="btn-ghost" onClick={onClearAll}>
        すべて外す
      </button>
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
    <div className="column-filter" ref={ref} style={{ left: position.x, top: position.y }} role="dialog" aria-label={`${col} の絞り込み`}>
      <div className="head">
        <span className="mono">{col}</span>
        {onTogglePin && (
          <button type="button" className="btn-ghost pin" aria-pressed={pinned} title={pinned ? "この列の固定を外す" : "この列を左端に固定する（横に動かしても見える）"} onClick={onTogglePin}>
            <Icon name={pinned ? "pin-off" : "pin"} size={12} />
            {pinned ? "固定を外す" : "左に固定"}
          </button>
        )}
      </div>
      {changeOptions.length > 0 && (
        <fieldset className="changes">
          <legend className="muted small">変更の状態</legend>
          <ul className="plain values">
            {changeOptions.map((c) => {
              const swatch = changeSwatch(c.kind);
              return (
                <li key={c.kind}>
                  <label>
                    <input type="checkbox" checked={pickedChanges.includes(c.kind)} onChange={() => toggleChange(c.kind)} />
                    {swatch !== null && <span className="swatch" style={{ background: swatch }} aria-hidden="true" />}
                    <span className="value">{CHANGE_LABEL[c.kind]}</span>
                    <span className="muted small">{c.count}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
      <input
        type="text"
        aria-label="文字を含む"
        placeholder="文字を含む"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply();
          if (e.key === "Escape") onClose();
        }}
        spellCheck={false}
      />
      <ul className="plain values">
        {options.map((o) => (
          <li key={o.value}>
            <label>
              <input type="checkbox" checked={picked.includes(o.value)} onChange={() => toggle(o.value)} />
              <span className="value">{o.value === "" ? "（空）" : o.value}</span>
              <span className="muted small">{o.count}</span>
            </label>
          </li>
        ))}
        {options.length === 0 && <li className="muted small">値がありません</li>}
      </ul>
      <div className="actions">
        <button type="button" onClick={() => onApply({ col, kind: "notEmpty" })}>
          空でない
        </button>
        <button type="button" onClick={() => onApply({ col, kind: "empty" })}>
          空
        </button>
        <button type="button" onClick={() => onApply(null)}>
          外す
        </button>
        <button type="button" className="primary" onClick={apply}>
          絞り込む
        </button>
      </div>
    </div>
  );
}

/** 列の候補を作る（行の表示値から。呼び出し側の useMemo 用） */
export function useColumnOptions<T>(rows: readonly T[], col: string | null, valueOf: (row: T, col: string) => string): Array<{ value: string; count: number }> {
  return useMemo(() => (col === null ? [] : distinctValues(rows, col, valueOf)), [rows, col, valueOf]);
}
