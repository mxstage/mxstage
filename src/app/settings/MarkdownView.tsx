// Skill の本文（Markdown）を読みやすく出す。見出し・箇条書き・番号付きの箇条・表・コード・段落だけを扱う小さな描き方。
// HTML は作らず React の要素にする（本文は共有フォルダから読むので、innerHTML に入れない）。

import type { ReactNode } from "react";

/** 行の中: `コード` と **太字** */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const t = m[0];
    out.push(t.startsWith("`") ? <code key={`${key}-${i++}`}>{t.slice(1, -1)}</code> : <strong key={`${key}-${i++}`}>{t.slice(2, -2)}</strong>);
    last = at + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownView({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = () => `b${n++}`;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      blocks.push(<pre key={key()}>{code.join("\n")}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const k = key();
      const level = h[1]!.length;
      const content = inline(h[2]!, k);
      blocks.push(level <= 1 ? <h3 key={k}>{content}</h3> : level === 2 ? <h4 key={k}>{content}</h4> : <h5 key={k}>{content}</h5>);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i]!)) {
        let item = lines[i]!.replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/, "");
        i++;
        // 続きの行（字下げ）は同じ項目に足す
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]!)) item += ` ${lines[i++]!.trim()}`;
        items.push(item);
      }
      const k = key();
      const lis = items.map((it, j) => <li key={`${k}-${j}`}>{inline(it, `${k}-${j}`)}</li>);
      blocks.push(ordered ? <ol key={k}>{lis}</ol> : <ul key={k}>{lis}</ul>);
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        const cells = lines[i]!.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const k = key();
      const [head, ...body] = rows;
      blocks.push(
        <table key={k}>
          {head && (
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c, `${k}-h${j}`)}</th>)}</tr>
            </thead>
          )}
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `${k}-${ri}-${j}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,4}\s|```|\s*[-*]\s+|\s*\d+\.\s+|\s*\|)/.test(lines[i]!)) para.push(lines[i++]!.trim());
    const k = key();
    blocks.push(<p key={k}>{inline(para.join(" "), k)}</p>);
  }
  return <div className="markdown">{blocks}</div>;
}
