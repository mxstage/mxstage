// 作業画面の上の知らせ: AI が Skill の案を作った（会話で「この手順を Skill に残して」と頼まれたとき）。
// 案は人が設定の「Skill と辞書」で確かめて保存するまで、メンバーにも AI にも届かない。［確かめる］でそこへ移る。
// 閉じた知らせは、この窓では同じ案について出し直さない。

import { Button } from "@carbon/react";
import { useState } from "react";
import type { SkillDraftNote } from "../dictionaries/client";
import { skillMessages } from "../settings/skillMessages";
import { navigate, settingsPath } from "../ui/routes";

export function SkillDraftNotice({ drafts }: { drafts: readonly SkillDraftNote[] }) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const keyOf = (d: SkillDraftNote) => `${d.draftScope}/${d.name}/${d.createdAt}`;
  const shown = drafts.filter((d) => !closed.has(keyOf(d)));
  const first = shown[0];
  if (first === undefined) return null;
  const t = skillMessages().notice;
  return (
    <div className="skill-draft-notice" role="status" data-testid="skill-draft-notice">
      <span>{t.text(first.name, first.description)}</span>
      <span className="skill-draft-notice-actions">
        <Button kind="primary" size="sm" onClick={() => navigate(settingsPath("skills"))}>
          {t.check}
        </Button>
        <Button kind="ghost" size="sm" onClick={() => setClosed((s) => new Set([...s, ...shown.map(keyOf)]))}>
          {t.dismiss}
        </Button>
      </span>
    </div>
  );
}
