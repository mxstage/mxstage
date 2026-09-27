// 橋渡しのフレーム解釈（タブから届くメッセージの読み取りと、ツール結果の正規化）。
// 期待値 frames.golden.json は、以前あった Hub Durable Object の実装と一致していた時点の出力を固定したもの。
// ここが落ちたら、解釈を変えたのが意図どおりかを確かめてから期待値を作り直す。

import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeToolResult, parseTabMessage, utf8Bytes } from "../../src/bridge/frames.ts";
import { CORPUS, RESULTS } from "./frames.corpus.ts";

const golden = JSON.parse(readFileSync(new URL("./frames.golden.json", import.meta.url), "utf8")) as { parse: unknown[]; normalize: unknown[] };

const TYPES = new Set(["hello", "tab.focus", "tool.ack", "tool.progress", "tool.chunk", "tool.result", "tool.error", "sheet.ops"]);

describe("フレームの解釈", () => {
  it("代表的なメッセージは固定した期待値どおりに読む", () => {
    CORPUS.forEach((value, i) => {
      expect(parseTabMessage(JSON.stringify(value)) ?? null, JSON.stringify(value)).toEqual(golden.parse[i]);
    });
  });

  it("JSON でない入力は null", () => {
    for (const text of ["", "{", "[", "not json", "undefined"]) expect(parseTabMessage(text)).toBeNull();
  });

  it("結果の正規化は固定した期待値どおり", () => {
    RESULTS.forEach((value, i) => {
      expect(normalizeToolResult(value) ?? null, JSON.stringify(value)).toEqual(golden.normalize[i]);
    });
  });

  it("任意のメッセージで例外を出さず、読めたものは既知の種類だけ", () => {
    const arb = fc.record(
      {
        type: fc.constantFrom("hello", "tab.focus", "tool.ack", "tool.progress", "tool.chunk", "tool.result", "tool.error", "sheet.ops", "ほか"),
        tabId: fc.oneof(fc.string(), fc.integer()),
        id: fc.oneof(fc.string(), fc.integer()),
        progress: fc.oneof(fc.double({ noNaN: true }), fc.string()),
        seq: fc.oneof(fc.integer(), fc.string()),
        data: fc.oneof(fc.string(), fc.integer()),
        last: fc.oneof(fc.boolean(), fc.string()),
        revision: fc.oneof(fc.integer(), fc.string()),
        code: fc.oneof(fc.integer(), fc.constantFrom(-32001, -32011, -32602)),
      },
      { requiredKeys: ["type"] },
    );
    fc.assert(
      fc.property(arb, (value) => {
        const parsed = parseTabMessage(JSON.stringify(value)) as { type?: unknown } | null;
        if (parsed !== null) expect(TYPES.has(String(parsed.type))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("バイト数は UTF-8 で数える", () => {
    for (const s of ["", "abc", "日本語", "😀", "a".repeat(1000)]) expect(utf8Bytes(s)).toBe(Buffer.byteLength(s, "utf8"));
  });
});
