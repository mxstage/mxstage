// 画面の言語を選んで覚える（設定の「言語」から使う）。決め方と切り替えの仕組みは src/shared/i18n.ts。

import { LOCALE_STORAGE_KEY, setLocale, type Locale } from "../../shared/i18n";
import { browserStorage } from "../boot/migrate";

/** 言語を切り替え、次に開いたときも同じ言語にする（保存できなくても切り替えはする） */
export function chooseLocale(locale: Locale, storage: Pick<Storage, "setItem"> | null = browserStorage()): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // 保存できない（プライベートモードなど）。今のタブだけ切り替える
  }
  setLocale(locale);
}
