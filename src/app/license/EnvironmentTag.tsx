// 上部バーの環境の札。接続中の Maximo がテストか本番か、本番ならライセンスがあるか（無ければ読むだけ）を常に見せる。
// 本番の反映にライセンスが要ることを、反映を押す前から分かるようにする。

import { Tag } from "@carbon/react";
import { useCallback, useSyncExternalStore } from "react";
import { Link } from "../ui/Link";
import { settingsPath } from "../ui/routes";
import type { LicenseClient } from "./client";
import { environmentBadge } from "./gate";
import { licenseMessages as m } from "./messages";

const TAG_TYPE = { test: "gray", licensed: "blue", readonly: "warm-gray", undeclared: "magenta" } as const;

export function EnvironmentTag({ license, baseUrl, now = Date.now }: { license: LicenseClient; baseUrl: string; now?: () => number }) {
  // 一覧と申告が変わったら描き直す（version が変わる）
  const version = useSyncExternalStore(
    useCallback((l: () => void) => license.subscribe(l), [license]),
    useCallback(() => license.snapshot().version, [license]),
  );
  const badge = environmentBadge(license, baseUrl, now());
  // 環境が未設定なら、環境を選ぶ「接続」のタブへ。それ以外はライセンスのタブへ
  const to = settingsPath(badge.kind === "undeclared" ? "connection" : "license");
  return (
    <span className="env-tags" data-version={version}>
      <Link to={to} className="env-tag-link" title={m().environment.help}>
        <Tag type={TAG_TYPE[badge.kind]} size="sm" className={`env-tag env-${badge.kind}`}>
          {badge.text}
        </Tag>
      </Link>
      {badge.expiresInDays !== null && (
        <Tag type="red" size="sm" className="env-tag env-expiring">
          {m().badge.expiresSoon(badge.expiresInDays)}
        </Tag>
      )}
    </span>
  );
}
