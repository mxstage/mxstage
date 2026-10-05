// ライセンスと環境（本番／テスト）の文言。英語が正、日本語は同じ形（src/shared/i18n.ts）。
// 反映の関門の文（blocker）は、作業画面と LLM（request_commit・get_status の結果）の両方に出る。
// LLM はこの文を読んで利用者に買い方を説明できるように、理由・次にすること・無償で続けられることを入れる。

import { defineMessages } from "../../shared/i18n";

/** 本番ライセンスの説明と購入のページ（作業画面の言語に合わせる） */
export const LICENSE_URL = { en: "https://mxstage.tsunagi.app/license", ja: "https://mxstage.tsunagi.app/ja/license" } as const;

export const licenseMessages = defineMessages(
  {
    environment: {
      label: "Environment",
      production: "Production",
      test: "Test",
      productionOption: "Production (committing needs a license)",
      testOption: "Test / development / training / rehearsal (free)",
      required: "Choose whether this Maximo is production or test.",
      help: "Production is the Maximo your organization uses to record day-to-day operations, including a new environment being prepared to replace it (for example, the migration target before go-live). Everything else is test, even if it holds a copy of production data.",
      licensedBy: (org: string) => `Production — licensed to ${org}`,
      licensedLocked: "This URL is in a license key, so it is always production.",
    },
    badge: {
      test: "Test",
      productionLicensed: (org: string) => `Production · ${org}`,
      productionReadOnly: "Production · read only (no license)",
      undeclared: "Environment not set",
      expiresSoon: (days: number) => `License expires in ${days} day${days === 1 ? "" : "s"}`,
    },
    blocker: {
      undeclared: "Choose whether this Maximo is a production or a test environment in Settings before committing.",
      noLicense: (host: string, licensed: readonly string[]) =>
        `Committing to a production Maximo needs a license. ${host} is not covered by a license key on this PC` +
        (licensed.length > 0 ? ` (licensed: ${licensed.join(", ")})` : "") +
        `. Buy a license at ${LICENSE_URL.en} and paste the key in Settings → License. Loading data, Skills and editing stay free.`,
      expired: (host: string) => `The license for ${host} has expired. Paste the renewed key in Settings → License (${LICENSE_URL.en}).`,
      revoked: (host: string) => `The license for ${host} has been revoked. Contact mxstage@tsunagi.app.`,
      unavailable: "The license could not be checked because the bridge did not answer. Commits to production are paused; test environments are not affected.",
    },
    section: {
      title: "License",
      intro: "Committing to a production Maximo needs a license (one license per production environment). Test environments, and loading, Skills and editing in production, are free.",
      pasteLabel: "License key",
      pastePlaceholder: "MXS1.…",
      save: "Add key",
      saving: "Checking…",
      saved: (org: string) => `Added the license for ${org}.`,
      remove: "Remove",
      removed: "Removed the key.",
      none: "No license keys on this PC.",
      unavailable: "The bridge does not answer, so the license keys cannot be read.",
      buy: "Buy a license",
      org: "Organization",
      hosts: "Production URLs",
      expires: "Expires",
      licenseId: "License ID",
      state: { valid: "Valid", expired: "Expired", revoked: "Revoked", invalid: "Cannot be used" },
      test: "Test key (payment sandbox)",
      bundled: "Development key (read by the bridge)",
      share: "Share the key with your team as it is: anyone can use it on any PC, as long as they connect to the production URLs in the key.",
    },
    problem: {
      empty: "Paste a license key.",
      too_long: "This is not a license key (too long).",
      format: "This is not a license key. Paste the whole key, starting with MXS1.",
      payload: "The key is damaged. Paste it again from the email.",
      signature: "The key has been changed or is not from MX Stage.",
      unknown_key: "This key was signed by an unknown key. Update MX Stage and try again.",
      test_key: "This is a test key from the payment sandbox. It only works in development.",
      expired: "This key has expired. Paste the renewed key.",
      revoked: "This key has been revoked. Contact mxstage@tsunagi.app.",
      older: "A newer key for the same license is already added.",
      too_many: "Too many keys on this PC. Remove keys you no longer use.",
      unavailable: "The bridge did not answer. Check that MX Stage is running.",
    },
  },
  {
    environment: {
      label: "環境",
      production: "本番",
      test: "テスト",
      productionOption: "本番（反映にライセンスが要る）",
      testOption: "テスト・開発・研修・移行のリハーサル（無償）",
      required: "この Maximo が本番かテストかを選んでください。",
      help: "本番は、組織が日々の業務の記録に使っている Maximo と、それに置き換わる準備中の環境（本番の切り替え前の移行先など）です。それ以外はすべてテストです（本番のデータの写しを入れていても）。",
      licensedBy: (org) => `本番（${org} のライセンス）`,
      licensedLocked: "この URL はライセンスキーに書かれているので、いつも本番です。",
    },
    badge: {
      test: "テスト",
      productionLicensed: (org) => `本番 · ${org}`,
      productionReadOnly: "本番 · 読むだけ（ライセンス無し）",
      undeclared: "環境が未設定",
      expiresSoon: (days) => `ライセンスの期限まで ${days} 日`,
    },
    blocker: {
      undeclared: "反映の前に、この Maximo が本番かテストかを設定で選んでください",
      noLicense: (host, licensed) =>
        `本番の Maximo への反映にはライセンスが要ります。${host} はこの PC のライセンスキーに含まれていません` +
        (licensed.length > 0 ? `（ライセンスの本番: ${licensed.join(", ")}）` : "") +
        `。${LICENSE_URL.ja} で購入し、キーを設定の「ライセンス」に貼ってください。読み込み・Skill・編集はライセンス無しで続けられます`,
      expired: (host) => `${host} のライセンスの期限が切れています。更新したキーを設定の「ライセンス」に貼ってください（${LICENSE_URL.ja}）`,
      revoked: (host) => `${host} のライセンスは取り消されています。mxstage@tsunagi.app にお問い合わせください`,
      unavailable: "橋渡しが応えないため、ライセンスを確かめられません。本番への反映は止めています（テスト環境には影響しません）",
    },
    section: {
      title: "ライセンス",
      intro: "本番の Maximo への反映にはライセンスが要ります（1 ライセンス = 1 本番環境）。テスト環境と、本番での読み込み・Skill・編集は無償です。",
      pasteLabel: "ライセンスキー",
      pastePlaceholder: "MXS1.…",
      save: "キーを追加",
      saving: "確かめています…",
      saved: (org) => `${org} のライセンスを追加しました。`,
      remove: "外す",
      removed: "キーを外しました。",
      none: "この PC にライセンスキーはありません。",
      unavailable: "橋渡しが応えないため、ライセンスキーを読めません。",
      buy: "ライセンスを購入",
      org: "組織",
      hosts: "本番の URL",
      expires: "期限",
      licenseId: "ライセンス ID",
      state: { valid: "有効", expired: "期限切れ", revoked: "取り消し", invalid: "使えません" },
      test: "試験用のキー（決済のサンドボックス）",
      bundled: "開発用のキー（橋渡しが読んだもの）",
      share: "キーはそのままチームに共有してください。キーに書かれた本番の URL につなぐ限り、誰がどの PC で使ってもかまいません。",
    },
    problem: {
      empty: "ライセンスキーを貼り付けてください。",
      too_long: "ライセンスキーではありません（長すぎます）。",
      format: "ライセンスキーではありません。MXS1. で始まるキーを最後まで貼り付けてください。",
      payload: "キーが壊れています。メールからもう一度貼り付けてください。",
      signature: "キーが書き換えられているか、MX Stage のキーではありません。",
      unknown_key: "知らない鍵で署名されたキーです。MX Stage を更新してから、もう一度試してください。",
      test_key: "決済のサンドボックスの試験用のキーです。開発のときだけ使えます。",
      expired: "期限が切れたキーです。更新したキーを貼り付けてください。",
      revoked: "取り消されたキーです。mxstage@tsunagi.app にお問い合わせください。",
      older: "同じライセンスの新しいキーがすでに追加されています。",
      too_many: "この PC のキーが多すぎます。使わないキーを外してください。",
      unavailable: "橋渡しが応えません。MX Stage が動いているか確かめてください。",
    },
  },
);
