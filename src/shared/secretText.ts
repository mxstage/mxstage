// Skill の本文に API キー・パスワードらしいものが入っていないかを見る（保存の前に。Skill はメンバーと AI に読まれるため）。
// 見つけたら保存しない。誤って止めることもあるので、どの行の何に見えたかを返し、利用者が直せるようにする。
// Node の標準モジュールに依存しない（作業画面・橋渡しのどちらからでも import できる）。

export interface SecretFinding {
  /** 1 から数えた行 */
  line: number;
  /** 何に見えたか */
  kind: "private_key" | "assignment" | "bearer" | "token";
  /** 見つけたところ（値は伏せる） */
  excerpt: string;
}

/** 名前の後に値を書いたもの（apikey: xxx、password=xxx など）。値は 6 文字以上で、空白・括弧・山括弧を含まない */
const ASSIGNMENT = /\b(api[_-]?key|apikey|maxauth|password|passwd|pwd|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|token)\b\s*[:=：]\s*["'`]?([^\s"'`<>(){}[\],;]{6,})/i;
const BEARER = /\b(bearer|basic)\s+([A-Za-z0-9+/=._-]{16,})/i;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** 長い乱数のような語（英字と数字がまじり、24 文字以上）。ハイフンだけでつないだ名前（Skill の名前など）は外す */
const TOKEN = /(?<![A-Za-z0-9_+/=-])([A-Za-z0-9_+/=-]{24,})(?![A-Za-z0-9_+/=-])/g;

/** 値が置き場所の印（<API キー>、xxxx、*** など）なら、秘密ではない */
function placeholder(value: string): boolean {
  return /^(x+|\*+|\.+|_+|-+)$/i.test(value) || /^(your|my|example|sample|dummy|placeholder|redacted|none|null|undefined)/i.test(value) || /^\$\{?[A-Z_]+\}?$/.test(value);
}

function looksRandom(word: string): boolean {
  if (!/[0-9]/.test(word) || !/[A-Za-z]/.test(word)) return false;
  // 小文字・数字・ハイフンだけで、ハイフンで区切った語が短いもの（名前・日付・番号）は外す
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(word) && word.split("-").every((p) => p.length <= 12)) return false;
  const letters = word.replace(/[^A-Za-z]/g, "").length;
  const digits = word.replace(/[^0-9]/g, "").length;
  return letters >= 6 && digits >= 4;
}

function mask(text: string, value: string): string {
  const shown = value.length <= 4 ? "" : value.slice(0, 2);
  return text.replace(value, `${shown}…`).trim().slice(0, 80);
}

/** 本文の中の API キー・パスワードらしいもの（最大 5 件） */
export function findSecrets(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((raw, i) => {
    if (out.length >= 5) return;
    const line = i + 1;
    if (PRIVATE_KEY.test(raw)) {
      out.push({ line, kind: "private_key", excerpt: "-----BEGIN … PRIVATE KEY-----" });
      return;
    }
    const a = ASSIGNMENT.exec(raw);
    if (a && !placeholder(a[2]!)) {
      out.push({ line, kind: "assignment", excerpt: mask(a[0], a[2]!) });
      return;
    }
    const b = BEARER.exec(raw);
    if (b) {
      out.push({ line, kind: "bearer", excerpt: mask(b[0], b[2]!) });
      return;
    }
    for (const m of raw.matchAll(TOKEN)) {
      if (looksRandom(m[1]!)) {
        out.push({ line, kind: "token", excerpt: mask(m[1]!, m[1]!) });
        return;
      }
    }
  });
  return out;
}
