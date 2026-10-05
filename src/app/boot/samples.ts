// 開発サーバ（vite dev）でだけ使うサンプルデータ。`?samples=1` を付けて開くと、Maximo に接続しなくても
// 画面（関連する表の同時表示・列の絞り込み・反映パネル）を確かめられる。
//
// 本番のビルドには入らない（main.tsx が import.meta.env.DEV の中で動的に import する）。
// ここで作るのは「Maximo から読み込んだ形」のシート。作業指示（MXAPIWODETAIL）＋機器台帳＋ロケーションを模した架空のデータ。

import type { CellValue, ColumnSchema } from "../../shared/model";
import { makeChildRowKey, makeParentKey, type SheetMeta, type SheetRow } from "../../shared/sheet";
import type { Workspace } from "../store";

const STATUSES = ["作成中", "承認済み", "工事中", "工事完了", "キャンセル"];

function column(name: string, type: ColumnSchema["type"], title: string, child?: string): ColumnSchema {
  const c: ColumnSchema = { name, type };
  if (title) c.title = title;
  if (child) c.child = child;
  return c;
}

function parentRow(values: Record<string, CellValue>, keys: string[]): SheetRow {
  const key = makeParentKey(keys.map((k) => values[k] ?? null));
  return { rowKey: key, parentKey: key, childName: null, values };
}

/** 工事管理（親）＋ 複数機器（子 MULTIASSETLOCCI） */
function workOrders(): { meta: SheetMeta; rows: SheetRow[] } {
  const columns = [
    column("SITEID", "string", "サイト"),
    column("WONUM", "string", "工事管理No."),
    column("STATUS", "string", "ステータス"),
    column("DESCRIPTION", "string", "説明"),
    // 長文・改行のあるセル（実機の「作業内容（詳細）」は 1000 文字まで）
    column("EXT_WORKDETAIL", "string", "作業内容（詳細）"),
    column("PERSONGROUP", "string", "工事担当部署"),
    column("ASSETNUM", "string", "資産"),
    column("LOCATION", "string", "ロケーション"),
    column("MULTIASSETLOCCI.MULTIID", "integer", "MULTI ID", "MULTIASSETLOCCI"),
    column("MULTIASSETLOCCI.ASSETNUM", "string", "資産", "MULTIASSETLOCCI"),
    column("MULTIASSETLOCCI.LOCATION", "string", "ロケーション", "MULTIASSETLOCCI"),
    column("MULTIASSETLOCCI.ISPRIMARY", "boolean", "プライマリーですか", "MULTIASSETLOCCI"),
  ];
  const meta: SheetMeta = {
    name: "工事管理",
    source: { kind: "maximo", os: "MXAPIWODETAIL", select: columns.map((c) => c.name), where: [], baseUrl: "https://demo.example.com", structureLoadedAt: Date.now() },
    columns,
    keyColumns: ["SITEID", "WONUM"],
    childIdAttrs: { MULTIASSETLOCCI: "MULTIID" },
  };
  const rows: SheetRow[] = [];
  let multiId = 17000;
  for (let i = 0; i < 24; i++) {
    const wonum = `WO10${String(1000 + i)}`;
    const base: Record<string, CellValue> = {
      SITEID: "BEDFORD",
      WONUM: wonum,
      STATUS: STATUSES[i % STATUSES.length] as string,
      DESCRIPTION: i % 3 === 0 ? `P-25${String(i).padStart(2, "0")}B動作不良の件` : `FS-25${String(i).padStart(2, "0")}指示不良の件`,
      EXT_WORKDETAIL:
        i % 4 === 0
          ? null
          : `P-25${String(i).padStart(2, "0")}B の分解点検を行う。\n・保温着脱、開放清掃、ﾒｶﾆｶﾙｼｰﾙ交換（部品は別伝票で手配済み）\n・復旧後に試運転を行い、振動と軸受温度を記録する\n※ 現場責任者の立会いのもとで実施すること`,
      PERSONGROUP: ["MECH", "ELEC", "INST", "CIVIL"][i % 4] as string,
      ASSETNUM: `A${String(50000 + i)}`,
      LOCATION: `P-25${String(i).padStart(2, "0")}B`,
    };
    const parentKey = makeParentKey([base.SITEID ?? null, base.WONUM ?? null]);
    // 3 件に 1 件は複数機器を持つ（1〜2 行）
    const childCount = i % 3 === 0 ? (i % 6 === 0 ? 2 : 1) : 0;
    if (childCount === 0) {
      rows.push(parentRow({ ...base, "MULTIASSETLOCCI.MULTIID": null, "MULTIASSETLOCCI.ASSETNUM": null, "MULTIASSETLOCCI.LOCATION": null, "MULTIASSETLOCCI.ISPRIMARY": null }, ["SITEID", "WONUM"]));
      continue;
    }
    for (let c = 0; c < childCount; c++) {
      const id = ++multiId;
      rows.push({
        rowKey: makeChildRowKey(parentKey, "MULTIASSETLOCCI", id),
        parentKey,
        childName: "MULTIASSETLOCCI",
        values: {
          ...base,
          "MULTIASSETLOCCI.MULTIID": id,
          // わざと本体と関係のない機器を入れてある（振り直しの練習用）
          "MULTIASSETLOCCI.ASSETNUM": c === 0 ? "A10001" : `A${String(50000 + i + 1)}`,
          "MULTIASSETLOCCI.LOCATION": c === 0 ? "GEN-01" : `P-25${String(i + 1).padStart(2, "0")}B`,
          "MULTIASSETLOCCI.ISPRIMARY": false,
        },
      });
    }
  }
  return { meta, rows };
}

/** 参照先のマスタ（load_master で読んだ形。link で参照元とつながる） */
function master(name: string, os: string, keyColumn: string, columns: ColumnSchema[], values: Array<Record<string, CellValue>>, from: string): { meta: SheetMeta; rows: SheetRow[] } {
  const meta: SheetMeta = {
    name,
    source: { kind: "maximo", os, select: columns.map((c) => c.name), where: [], baseUrl: "https://demo.example.com", structureLoadedAt: Date.now() },
    columns,
    keyColumns: [keyColumn],
    childIdAttrs: {},
    link: { sheet: "工事管理", from, to: keyColumn },
  };
  return { meta, rows: values.map((v) => parentRow(v, [keyColumn])) };
}

/** 開発サーバでサンプルのシートを作る（すでに何かあれば何もしない） */
export function seedSampleWorkspace(workspace: Workspace): void {
  if (workspace.sheets.size > 0) return;
  const wo = workOrders();
  workspace.createSheet(wo.meta, wo.rows);

  const assetNums = new Set<string>();
  for (const r of wo.rows) {
    for (const col of ["ASSETNUM", "MULTIASSETLOCCI.ASSETNUM"]) {
      const v = r.values[col];
      if (typeof v === "string" && v !== "") assetNums.add(v);
    }
  }
  const assets = master(
    "機器台帳",
    "MXAPIASSET",
    "ASSETNUM",
    [column("ASSETNUM", "string", "資産"), column("DESCRIPTION", "string", "説明"), column("EXT_EQUIPTAG", "string", "タグ番号"), column("LOCATION", "string", "ロケーション")],
    Array.from(assetNums).map((assetnum, i) => ({
      ASSETNUM: assetnum,
      DESCRIPTION: assetnum === "A10001" ? "発電設備（本体）" : i % 4 === 0 ? "" : `ポンプ ${assetnum}`,
      EXT_EQUIPTAG: `P-25${String(i).padStart(2, "0")}B`,
      LOCATION: `P-25${String(i).padStart(2, "0")}B`,
    })),
    "MULTIASSETLOCCI.ASSETNUM",
  );
  workspace.createSheet(assets.meta, assets.rows);

  const locations = master(
    "ロケーション",
    "MXAPILOCATION",
    "LOCATION",
    [column("LOCATION", "string", "ロケーション"), column("DESCRIPTION", "string", "説明"), column("STATUS", "string", "ステータス")],
    Array.from(new Set(wo.rows.map((r) => String(r.values.LOCATION ?? "")))).map((location) => ({ LOCATION: location, DESCRIPTION: `${location} の設備`, STATUS: "稼働" })),
    "LOCATION",
  );
  workspace.createSheet(locations.meta, locations.rows);
}
