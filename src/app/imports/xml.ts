// xlsx の XML を読むための小さな道具。DOMParser は使わない（数十 MB のシートで木を作らず、文字列を順に走査する）。
// xlsx の XML は機械が書くので形が決まっている。要素名の名前空間の接頭辞（x: など）が付くことだけは許す。

/** 要素名の前に付くことがある名前空間の接頭辞 */
export const NS = "(?:[A-Za-z_][\\w.-]*:)?";

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
// OOXML の文字列のエスケープ（_x000D_ は CR、_x005F_ は _ そのもの）
const OOXML_ESCAPE_RE = /_x([0-9A-Fa-f]{4})_/g;

function codePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/** XML の文字参照と OOXML の _xHHHH_ を戻す */
export function decodeXml(s: string): string {
  if (s.indexOf("&") >= 0) {
    s = s.replace(ENTITY_RE, (_, e: string) => {
      if (e.startsWith("#x")) return codePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return codePoint(parseInt(e.slice(1), 10));
      return NAMED[e] ?? "";
    });
  }
  if (s.indexOf("_x") >= 0) s = s.replace(OOXML_ESCAPE_RE, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return s;
}

const ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** 属性を「接頭辞を除いた名前 → 値」にする（r:id は id。xmlns の宣言は除く） */
export function attrsOf(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(ATTR_RE)) {
    const full = m[1] as string;
    if (full === "xmlns" || full.startsWith("xmlns:")) continue;
    const local = full.includes(":") ? full.slice(full.indexOf(":") + 1) : full;
    out.set(local, decodeXml(m[2] ?? m[3] ?? ""));
  }
  return out;
}

/** 空要素（<x .../>）と中身のある要素（<x ...>...</x>）の両方に当たる正規表現。1 = 属性、2 = 中身 */
export function elementRe(name: string, flags = "g"): RegExp {
  return new RegExp(`<${NS}${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${NS}${name}>)`, flags);
}

const PHONETIC_RE = new RegExp(`<${NS}rPh\\b[\\s\\S]*?</${NS}rPh>`, "g");
const TEXT_RE = elementRe("t");

/**
 * 共有文字列（si）やインライン文字列（is）の本文。書式ごとの断片（r の中の t）をつなぐ。
 * 日本語の Excel が付けるふりがな（rPh の中の t）は本文ではないので除く。
 */
export function richText(inner: string): string {
  const body = inner.indexOf("rPh") >= 0 ? inner.replace(PHONETIC_RE, "") : inner;
  let out = "";
  for (const m of body.matchAll(TEXT_RE)) out += decodeXml(m[2] ?? "");
  return out;
}
