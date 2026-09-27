// グリッドの選択範囲を、今の行数・列数の中に収める（純関数）。
// LLM が行を消した直後やシートを読み込み直した直後は、選択が無くなった行を指しうる。
// 範囲外のまま渡すと、コピーや貼り付けが見えていない行に当たる。

import type { CompactSelection, GridSelection, Rectangle } from "@glideapps/glide-data-grid";

/** count 以上の番号を取り除く（範囲内だけなら同じものを返す） */
function clampIndexes(sel: CompactSelection, count: number): CompactSelection {
  const last = sel.last();
  if (last === undefined || last < count) return sel;
  if (count <= 0) return sel.remove([0, last + 1]);
  return sel.remove([count, last + 1]);
}

/** 範囲を行数・列数で切り詰める。1 マスも残らなければ null */
function clampRect(r: Readonly<Rectangle>, rowCount: number, colCount: number): Readonly<Rectangle> | null {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  if (x >= colCount || y >= rowCount) return null;
  const width = Math.min(r.x + r.width, colCount) - x;
  const height = Math.min(r.y + r.height, rowCount) - y;
  if (width <= 0 || height <= 0) return null;
  if (x === r.x && y === r.y && width === r.width && height === r.height) return r;
  return { x, y, width, height };
}

/**
 * 行数・列数が減ったときに、範囲外を指す選択を切り詰める。
 * 選択中のセル自体が消えていれば選択を外す（消えた行に書き込ませないため）。
 * 変わらないときは同じオブジェクトを返す（React の再描画を増やさない）。
 */
export function clampSelection(selection: GridSelection, rowCount: number, colCount: number): GridSelection {
  const rows = clampIndexes(selection.rows, rowCount);
  const columns = clampIndexes(selection.columns, colCount);
  const cur = selection.current;
  let current: GridSelection["current"] = cur;
  if (cur !== undefined) {
    const [cx, cy] = cur.cell;
    const range = clampRect(cur.range, rowCount, colCount);
    if (cx >= colCount || cy >= rowCount || range === null) {
      current = undefined;
    } else {
      const stack: Array<Readonly<Rectangle>> = [];
      let stackChanged = false;
      for (const r of cur.rangeStack) {
        const clamped = clampRect(r, rowCount, colCount);
        if (clamped === null) stackChanged = true;
        else {
          if (clamped !== r) stackChanged = true;
          stack.push(clamped);
        }
      }
      if (range !== cur.range || stackChanged) current = { cell: cur.cell, range, rangeStack: stack };
    }
  }
  if (rows === selection.rows && columns === selection.columns && current === cur) return selection;
  return current === undefined ? { rows, columns } : { rows, columns, current };
}
