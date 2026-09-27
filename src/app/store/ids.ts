// バッチ ID・ジョブ ID の推測されにくい接尾辞。
// 作業を作り直すと連番が 1 から始まるため、古い作業の ID で別のバッチを取り消さないように付ける。

export function randomHex(bytes: number): string {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") {
    return Array.from(c.getRandomValues(new Uint8Array(bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
  }
  let s = "";
  for (let i = 0; i < bytes; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return s;
}
