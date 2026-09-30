// 作業画面の試験の共通の準備（vitest.config.ts の app の setupFiles）。
// 画面の文言は英語が正だが、これまでの試験は日本語の文言で確かめているので、日本語に固定して始める。
// 英語を確かめる試験は、その中で setLocale("en") にする（次の試験の前に日本語へ戻る）。

import { beforeEach } from "vitest";
import { setLocale } from "../../src/shared/i18n";

setLocale("ja");

beforeEach(() => {
  setLocale("ja");
});
