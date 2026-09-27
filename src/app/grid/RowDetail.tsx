// 選んだ 1 行の全列を縦に並べて出す。列が多いシートや、工事内容のような長文・改行のある値を読むためのもの。
// グリッドは canvas なので、こちらは DOM で出す（試験で中身を確かめられる）。
// 開け閉めはペインの見出しのボタンで行う（ここには閉じるボタンを置かない）。

import { TONE_STYLE } from "./cellStyle";
import type { DetailItem } from "./detailItems";
import { sortDetailItems } from "./detailItems";

export interface RowDetailProps {
  /** 見出し（例 BEDFORD / WO101001） */
  title: string;
  items: readonly DetailItem[];
  /** 空の列を後ろにまとめるか */
  emptyLast?: boolean;
}

export function RowDetail({ title, items, emptyLast = true }: RowDetailProps) {
  const shown = emptyLast ? sortDetailItems(items) : [...items];
  const filled = items.filter((i) => !i.empty).length;
  return (
    <section className="row-detail" aria-label={`行の詳細 ${title}`}>
      <header>
        <span className="title">{title}</span>
        <span className="filled">
          {filled} / {items.length} 列に値
        </span>
      </header>
      <dl>
        {shown.map((item) => (
          <div key={item.name} className={`item${item.long ? " long" : ""}${item.empty ? " blank" : ""}${item.changed ? " changed" : ""}`}>
            <dt title={item.attr ?? undefined}>
              <span className="label">{item.label}</span>
            </dt>
            <dd style={item.changed && item.author ? { color: TONE_STYLE[item.author].fg } : undefined}>{item.empty ? "（空）" : item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
