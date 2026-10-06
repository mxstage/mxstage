// 接続先ごとの「過去の作業のステータス」。apply_rule の phase で past を省いたときに使う。
// 客先によって、過去の作業を完了（COMP）のままにするか、クローズ（CLOSE）まで進めるかが違う。既定は COMP
// （CLOSE は戻せず、クローズした記録は中身も直せなくなるため、選んだ客先だけにする）。
// 作業画面の設定（接続）で選び、この PC のブラウザ（localStorage）に接続先ごとに覚える。

import { normalizeScope } from "../../shared/scope";

export const PAST_STATUS_STORAGE_KEY = "mxstage.maximo.pastStatus";
export const PAST_STATUS_CHOICES = ["COMP", "CLOSE"] as const;
export type PastStatus = (typeof PAST_STATUS_CHOICES)[number];
export const DEFAULT_PAST_STATUS: PastStatus = "COMP";

export interface PastStatusStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface StatusPrefs {
  pastStatusOf(baseUrl: string): PastStatus;
}

const isPastStatus = (v: unknown): v is PastStatus => typeof v === "string" && (PAST_STATUS_CHOICES as readonly string[]).includes(v);

function readAll(storage: PastStatusStorage | null): Record<string, PastStatus> {
  try {
    const raw = storage?.getItem(PAST_STATUS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, PastStatus] => isPastStatus(e[1])));
  } catch {
    return {};
  }
}

/** 接続先の過去の作業のステータス（選んでいなければ COMP） */
export function pastStatusOf(storage: PastStatusStorage | null, baseUrl: string): PastStatus {
  return readAll(storage)[normalizeScope(baseUrl)] ?? DEFAULT_PAST_STATUS;
}

export function setPastStatus(storage: PastStatusStorage | null, baseUrl: string, status: PastStatus): void {
  const all = { ...readAll(storage), [normalizeScope(baseUrl)]: status };
  try {
    storage?.setItem(PAST_STATUS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // 保存できなくても、既定（COMP）で動く
  }
}

export function createStatusPrefs(storage: PastStatusStorage | null): StatusPrefs {
  return { pastStatusOf: (baseUrl) => pastStatusOf(storage, baseUrl) };
}
