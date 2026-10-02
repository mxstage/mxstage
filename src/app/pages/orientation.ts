// 子の表の縦持ち・横持ちを、利用者が選んだとおりに覚える（構造と子ごと。このブラウザの localStorage）。
// 選んでいない表は、表の形から決める（grid/pivot.ts の preferPivot）。

import type { SheetMeta } from "../../shared/sheet";

export type Orientation = "vertical" | "horizontal";

export const ORIENTATIONS_STORAGE_KEY = "mxstage.grid.orientations";

export interface OrientationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 覚えるときの名前。Maximo の構造なら構造名と子（例 MXAPIASSET/ASSETSPEC）、それ以外はシート名と子 */
export function orientationKey(meta: Pick<SheetMeta, "name" | "source">, child: string): string {
  const base = meta.source.kind === "maximo" ? meta.source.os : `sheet:${meta.name}`;
  return `${base}/${child}`;
}

export function loadOrientations(storage: OrientationStorage | null): Record<string, Orientation> {
  try {
    const raw = storage?.getItem(ORIENTATIONS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, Orientation] => e[1] === "vertical" || e[1] === "horizontal"));
  } catch {
    return {};
  }
}

export function saveOrientations(storage: OrientationStorage | null, all: Record<string, Orientation>): void {
  try {
    storage?.setItem(ORIENTATIONS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // 覚えられなくても、表の形から決める
  }
}
