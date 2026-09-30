// 反映の関門の判定（src/app/commit/controller.ts が使う）。
// テスト環境には何も求めない。本番の接続先への反映にだけ、期限内のキー（接続先がキーの本番の接続先に含まれるもの）を求める。
// 環境を申告していない接続先には、どちらか選ぶまで反映させない。

import { licenseHostOf } from "../../shared/license";
import { EXPIRY_WARNING_DAYS, daysUntilExpiry } from "./client";
import type { AuthorizeOutcome, LicenseGate } from "./client";
import { licenseMessages as m } from "./messages";

/** 接続先に反映できないライセンス・環境の理由（反映できるなら null） */
export function licenseBlocker(gate: LicenseGate, baseUrl: string): string | null {
  const environment = gate.environmentOf(baseUrl);
  if (environment === null) return m().blocker.undeclared;
  if (environment === "test") return null;
  if (gate.licenseFor(baseUrl) !== null) return null;
  const snap = gate.snapshot();
  if (snap.status !== "ready") return m().blocker.unavailable;
  const host = licenseHostOf(baseUrl) ?? baseUrl;
  const matching = snap.licenses.filter((e) => (e.hosts ?? []).includes(host));
  if (matching.some((e) => e.state === "revoked")) return m().blocker.revoked(host);
  if (matching.some((e) => e.state === "expired")) return m().blocker.expired(host);
  const licensed = [...new Set(snap.licenses.filter((e) => e.state === "valid").flatMap((e) => e.hosts ?? []))];
  return m().blocker.noLicense(host, licensed);
}

/** 上部バーの環境の札 */
export interface EnvironmentBadge {
  kind: "test" | "licensed" | "readonly" | "undeclared";
  text: string;
  /** 期限まで EXPIRY_WARNING_DAYS 日以内なら、その日数 */
  expiresInDays: number | null;
}

/** 接続先の環境の札（テスト / 本番・ライセンスあり / 本番・読むだけ / 未設定） */
export function environmentBadge(gate: LicenseGate, baseUrl: string, now: number): EnvironmentBadge {
  const environment = gate.environmentOf(baseUrl);
  if (environment === null) return { kind: "undeclared", text: m().badge.undeclared, expiresInDays: null };
  if (environment === "test") return { kind: "test", text: m().badge.test, expiresInDays: null };
  const license = gate.licenseFor(baseUrl);
  if (license === null) return { kind: "readonly", text: m().badge.productionReadOnly, expiresInDays: null };
  const days = daysUntilExpiry(license, now);
  return { kind: "licensed", text: m().badge.productionLicensed(license.org ?? license.licenseId), expiresInDays: days !== null && days <= EXPIRY_WARNING_DAYS ? Math.max(days, 0) : null };
}

/** 反映の直前の確かめ（橋渡し）で断られたときの文 */
export function authorizeFailure(outcome: Extract<AuthorizeOutcome, { ok: false }>, baseUrl: string): string {
  const host = licenseHostOf(baseUrl) ?? baseUrl;
  switch (outcome.problem) {
    case "expired":
      return m().blocker.expired(host);
    case "revoked":
      return m().blocker.revoked(host);
    case "unavailable":
      return m().blocker.unavailable;
    default:
      return m().blocker.noLicense(host, outcome.licensedHosts);
  }
}
