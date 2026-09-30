import { describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY, defineMessages, detectLocale, getLocale, isLocale, setLocale, subscribeLocale } from "../../src/shared/i18n";

const m = defineMessages(
  { title: "Settings", saved: (n: number) => `${n} saved`, nested: { hint: "Paste the key" } },
  { title: "設定", saved: (n) => `${n} 件を保存しました`, nested: { hint: "キーを貼り付けてください" } },
);

describe("作業画面の言語（src/shared/i18n.ts）", () => {
  it("試験は日本語で始まる（tests/app/setup.ts）", () => {
    expect(getLocale()).toBe("ja");
    expect(m().title).toBe("設定");
  });

  it("呼んだときの言語の文言を返す（引数のある文言・入れ子も）", () => {
    setLocale("en");
    expect(m().title).toBe("Settings");
    expect(m().saved(3)).toBe("3 saved");
    expect(m().nested.hint).toBe("Paste the key");
    setLocale("ja");
    expect(m().saved(3)).toBe("3 件を保存しました");
    expect(m().nested.hint).toBe("キーを貼り付けてください");
  });

  it("変わったときだけ知らせ、解除できる", () => {
    const seen = vi.fn();
    const off = subscribeLocale(seen);
    setLocale("ja");
    expect(seen).not.toHaveBeenCalled();
    setLocale("en");
    expect(seen).toHaveBeenCalledWith("en");
    off();
    setLocale("ja");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("言語の決め方: 保存した設定 → ブラウザの言語が日本語なら日本語 → それ以外は英語", () => {
    expect(LOCALE_STORAGE_KEY).toBe("mxstage.locale");
    expect(detectLocale({ stored: "en", languages: ["ja-JP"] })).toBe("en");
    expect(detectLocale({ stored: "ja", languages: ["en-US"] })).toBe("ja");
    expect(detectLocale({ stored: "fr", languages: ["ja-JP", "en"] })).toBe("ja");
    expect(detectLocale({ stored: null, languages: ["JA"] })).toBe("ja");
    expect(detectLocale({ languages: ["en-GB", "ja"] })).toBe("en");
    expect(detectLocale({ languages: ["de-DE"] })).toBe("en");
    expect(detectLocale({})).toBe("en");
    expect(isLocale("ja")).toBe(true);
    expect(isLocale("jp")).toBe(false);
  });

  it("日本語の文言が英語と同じ形でなければ型検査で落ちる", () => {
    defineMessages(
      { a: "A", b: (n: number) => `${n}` },
      // @ts-expect-error b が無い
      { a: "あ" },
    );
    defineMessages(
      { a: "A" },
      // @ts-expect-error 文字列のところに関数
      { a: () => "あ" },
    );
    expect(true).toBe(true);
  });
});
