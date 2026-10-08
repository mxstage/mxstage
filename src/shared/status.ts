// Maximo のステータスの決まり（書き込みエンジン src/app/maximo/commit.ts と、仮想 Maximo src/demo/fakeMaximo.ts が共に使う）。
// 実機の既定の値（内部値）に合わせる。客先が付けた呼び名（同義語）は、ここでは扱わない（実機で確かめる項目。docs/status.md）。
//   - 作業指示の移り方は IBM の「Allowable Status Changes for Work Orders」
//   - クローズ・取消になると履歴（HISTORYFLAG）になり、中身もステータスも変えられない（管理者の「履歴の作業指示の編集」は別）
//   - 注文書は承認の後に中身を変えるには改訂（Revise PO → PNDREV → 承認）が要る
//   - 資産は作ると準備中（NOT READY）。撤去済み（DECOMMISSIONED）からは他のステータスへ移れない。
//     撤去が子の資産に及ぶこと・閉じていない作業指示があると断られることは Maximo に任せる（仮想 Maximo は src/demo/fakeMaximo.ts で再現する）

export type StatusObjectKind = "WORKORDER" | "PO" | "SR" | "ASSET";

export interface StatusRule {
  /** 作ったときのステータス */
  initial: string;
  /** 履歴になるステータス（中身もステータスも変えられない） */
  history: readonly string[];
  /** 中身を直せるステータス（無ければ履歴でない限り直せる） */
  editable?: readonly string[];
}

export const STATUS_RULES: Readonly<Record<StatusObjectKind, StatusRule>> = {
  WORKORDER: { initial: "WAPPR", history: ["CLOSE", "CAN"] },
  PO: { initial: "WAPPR", history: ["CLOSE", "CAN", "REVISE"], editable: ["WAPPR", "PNDREV"] },
  SR: { initial: "NEW", history: ["CLOSED", "CANCELLED"] },
  ASSET: { initial: "NOT READY", history: [] },
};

/** 資産の撤去済み。ここからは他のステータスへ移れない */
export const ASSET_DECOMMISSIONED = "DECOMMISSIONED";

/** 作業指示のステータスの移り方（今のステータス → 移れる先） */
export const WO_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  WAPPR: ["INPRG", "CAN", "WMATL", "COMP", "WPCOND", "APPR", "CLOSE", "WSCH"],
  APPR: ["INPRG", "WMATL", "COMP", "WPCOND", "WAPPR", "CLOSE", "WSCH"],
  WSCH: ["INPRG", "WMATL", "COMP", "WPCOND", "WAPPR", "CLOSE", "APPR"],
  WMATL: ["INPRG", "COMP", "WPCOND", "WAPPR", "CLOSE", "APPR", "WSCH"],
  WPCOND: ["INPRG", "WMATL", "COMP", "WAPPR", "CLOSE", "APPR", "WSCH"],
  INPRG: ["WMATL", "COMP", "WAPPR", "CLOSE"],
  COMP: ["CLOSE"],
  CLOSE: [],
  CAN: [],
};

/** 戻せないステータス（クローズ・取消・撤去・廃止）。反映の画面で人の確認が要る */
export const IRREVERSIBLE_STATUSES: ReadonlySet<string> = new Set(["CLOSE", "CLOSED", "CAN", "CANCEL", "CANCELLED", "DECOMMISSIONED", "OBSOLETE"]);

export function isIrreversibleStatus(status: string): boolean {
  return IRREVERSIBLE_STATUSES.has(status.trim().toUpperCase());
}

/** 移れるか。分からない（作業指示・資産以外・知らないステータス）なら null（Maximo に任せる） */
export function canChangeStatus(kind: StatusObjectKind | null, from: string, to: string): boolean | null {
  if (kind === "ASSET") {
    const f = from.trim().toUpperCase();
    return f === ASSET_DECOMMISSIONED && to.trim().toUpperCase() !== f ? false : null;
  }
  if (kind !== "WORKORDER") return null;
  const next = WO_TRANSITIONS[from.trim().toUpperCase()];
  return next === undefined ? null : next.includes(to.trim().toUpperCase());
}

/** 属性の名前（大文字）から、ステータスの決まりを当てるオブジェクトを見分ける */
export function statusObjectKind(attrNames: Iterable<string>): StatusObjectKind | null {
  const names = new Set([...attrNames].map((a) => a.toUpperCase()));
  if (!names.has("STATUS")) return null;
  if (names.has("WONUM")) return "WORKORDER";
  if (names.has("PONUM") && names.has("REVISIONNUM")) return "PO";
  if (names.has("TICKETID")) return "SR";
  // 資産を指す属性を持つほかのオブジェクト（作業指示・SR は上で見分けた。予防保全は PMNUM を持つ）は資産としない
  if (names.has("ASSETNUM") && !names.has("PMNUM")) return "ASSET";
  return null;
}
