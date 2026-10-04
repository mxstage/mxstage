// 作業の段階に合う既定の Skill を、ツールの結果で知らせる（読み落としの手当て）。
// 目次（mxstage-workbench）にも「どの場面で読むか」は書くが、LLM が読まずに進めることがあるので、
// 入口のツール（読み込み・変更・突き合わせ・取り込み・反映）の結果に、まだ知らせていない Skill の名前を添える。
// 標準オブジェクトの Skill は、オブジェクト構造の名前（os）と読む列から決める。客先の構造（XX_ASSET など）も名前で当たる。

import type { ToolName } from "../shared/toolDefs.ts";

/** ツールごとの基本動作の Skill */
const CORE_BY_TOOL: Partial<Record<ToolName, string>> = {
  find_object_structures: "mxstage-core-load",
  describe_object_structure: "mxstage-core-load",
  scope_options: "mxstage-core-load",
  load_sheet: "mxstage-core-load",
  load_master: "mxstage-core-load",
  query_rows: "mxstage-core-analyze",
  aggregate: "mxstage-core-analyze",
  patch_cells: "mxstage-core-change",
  apply_rule: "mxstage-core-change",
  add_rows: "mxstage-core-change",
  delete_rows: "mxstage-core-change",
  match_sheets: "mxstage-core-match",
  create_import_session: "mxstage-core-import",
  describe_import: "mxstage-core-import",
  apply_mapping: "mxstage-core-import",
  get_diff: "mxstage-core-commit",
  request_commit: "mxstage-core-commit",
};

/**
 * オブジェクト構造の名前 → 標準オブジェクトの Skill。上から順に当てる（分類・メーターを資産より先に）。
 * 名前は大文字にしてから当てる
 */
const OBJECT_RULES: readonly (readonly [RegExp, string])[] = [
  [/CLASS|ASSETATTR|ATTRIBUTE/, "mxstage-obj-classification"],
  [/METER/, "mxstage-obj-asset"],
  [/ASSET/, "mxstage-obj-asset"],
  [/OPERLOC|LOCATION|LOCSYS|LOCHIER/, "mxstage-obj-location"],
  [/JOBPLAN|ROUTE|MXAPIPM|MXPM|(^|_)PM$/, "mxstage-obj-pm-jobplan"],
  [/WODETAIL|WORKORDER|MXAPIWO|MXWO|(^|_)WO$|MXAPISR|MXSR|TICKET/, "mxstage-obj-workorder"],
  [/ITEM|INVENTORY|INVBAL|STOREROOM|MXAPIINV|MXINV/, "mxstage-obj-item-inventory"],
  [/MXAPIPO|MXPO|MXAPIPR|MXPR|RECEIPT|PURCH|POLINE|PRLINE/, "mxstage-obj-purchasing"],
  [/PERSON|LABOR|CRAFT|COMPAN|DOMAIN|FAILURE|CALENDAR|AMCREW/, "mxstage-obj-reference"],
];

/** 仕様の子（ASSETSPEC・LOCATIONSPEC・ITEMSPEC・CLASSSPEC など）を読む列 */
const SPEC_CHILD = /(^|\.)[A-Z_]*SPEC[A-Z_]*\./;

export function objectSkillFor(os: string): string | null {
  const name = os.toUpperCase();
  for (const [pattern, skill] of OBJECT_RULES) if (pattern.test(name)) return skill;
  return null;
}

/** この呼び出しに合う既定の Skill（まだ知らせたかどうかは見ない） */
export function skillsForCall(tool: ToolName, args: Record<string, unknown>): string[] {
  const names: string[] = [];
  const core = CORE_BY_TOOL[tool];
  if (core !== undefined) names.push(core);
  if (tool === "scope_options" || tool === "load_sheet" || tool === "load_master") {
    const os = typeof args.os === "string" ? args.os : "";
    const object = os === "" ? null : objectSkillFor(os);
    if (object !== null) names.push(object);
    const select = Array.isArray(args.select) ? args.select.filter((c): c is string => typeof c === "string") : [];
    if (select.some((c) => SPEC_CHILD.test(c.toUpperCase()))) names.push("mxstage-obj-classification");
  }
  return [...new Set(names)];
}

/** 結果に添える文。知らせる Skill が無ければ null */
export function skillHintText(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return `[MX Stage Skills for this step: ${names.join(", ")}. If you have not read them in this conversation, read them with get_skill before you continue, and follow them.]`;
}
