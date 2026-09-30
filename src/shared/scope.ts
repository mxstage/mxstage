// Maximo の接続先を比べるための形。作業画面（オブジェクト構造の保存・接続ごとの環境の申告）と
// 橋渡し（本番の環境をライセンスに結びつける）が同じ決め方を使う。

/** 前後の空白と末尾の / を取り、スキームとホストを小文字にする（パスの大文字小文字は残す） */
export function normalizeScope(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed;
  }
}
