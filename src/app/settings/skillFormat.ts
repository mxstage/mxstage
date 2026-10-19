// 「Skill と辞書」の表示の小さな整え方。

/** 2026-10-16T00:40:00Z → 10/16 09:40（この PC の時刻）。読めなければそのまま */
export function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 本文のバイト数（UTF-8） */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
