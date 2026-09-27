// オブジェクト構造と、それを使って読み込んだシートの対応。
// 同じ構造を複数のシートで使ってよい。シートは読み込んだ接続先を持つので、同じ接続先のシートだけを数える。

import type { Workspace } from "../store";
import { normalizeScope } from "./catalog";

/** 接続先のオブジェクト構造名 → それを使って読み込んだシートの名前（シートの並び順） */
export function sheetsByStructure(workspace: Pick<Workspace, "sheets">, baseUrl: string): Map<string, string[]> {
  const scope = normalizeScope(baseUrl);
  const out = new Map<string, string[]>();
  for (const [name, sheet] of workspace.sheets) {
    const src = sheet.meta.source;
    if (src.kind !== "maximo") continue;
    // 接続先を持たないシート（以前の版で読み込んだもの）は、今の接続先のものとみなす
    if (src.baseUrl !== undefined && normalizeScope(src.baseUrl) !== scope) continue;
    out.set(src.os, [...(out.get(src.os) ?? []), name]);
  }
  return out;
}
