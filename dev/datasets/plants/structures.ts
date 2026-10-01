// 生成した表を、Maximo の標準のオブジェクト構造（MXAPI*）として偽の Maximo に載せる形にする。
// 属性名・子の名前は Maximo 7.6 / MAS Manage の標準に合わせる（確かでないものは dev/README.md に書いた）。

import type { FakeAttrDef, FakeAttrType, FakeListItem, FakeOsSeed, FakeSeed } from "../../../tests/fakes/fake-maximo.ts";
import { CLASSES, COMPANIES, CRAFTS, MEASURE_UNITS, METERS, PM_PROGRAMS, SITES } from "./catalog.ts";
import { DOMAINS, type PlantsData, type Rec } from "./generate.ts";

type A = Record<string, FakeAttrDef>;

/** 属性の定義を短く書く: "s40" は文字列（最大 40）、"i" は整数、"n" は小数、"b" は真偽値、"dt" は日時。末尾 "*" は値の一覧あり、"!" は必須、"r" は読み取り専用 */
function attrs(spec: Record<string, string>): A {
  const out: A = {};
  for (const [name, raw] of Object.entries(spec)) {
    const [code, title] = raw.split("|");
    const m = /^(s|i|n|b|dt|d)(\d*)([*!r]*)$/.exec(code!.trim());
    if (!m) throw new Error(`bad attr spec ${name}: ${raw}`);
    const type: FakeAttrType = m[1] === "s" ? "string" : m[1] === "i" ? "integer" : m[1] === "n" ? "number" : m[1] === "b" ? "boolean" : m[1] === "d" ? "date" : "datetime";
    const def: FakeAttrDef = { type };
    if (m[2]) def.maxLength = Number(m[2]);
    if (m[3]!.includes("*")) def.hasList = true;
    if (m[3]!.includes("!")) def.required = true;
    if (m[3]!.includes("r")) def.readOnly = true;
    if (title) def.title = title;
    out[name] = def;
  }
  return out;
}

const domainList = (id: string): FakeListItem[] => {
  const d = DOMAINS.find((x) => x.domainid === id);
  if (!d) throw new Error(`domain ${id}`);
  return d.type === "SYNONYM" ? d.values.map(([, value, desc]) => ({ value, description: desc ?? "" })) : d.values.map(([value, desc]) => ({ value, description: desc ?? "" }));
};

export function plantsObjectStructures(data: PlantsData): FakeSeed["objectStructures"] {
  const t = data.tables;
  const rows = (name: string): Rec[] => t[name] ?? [];
  const listOf = (name: string, key: string, desc: string): FakeListItem[] =>
    rows(name).map((r) => ({ value: String(r.attrs[key]), description: String(r.attrs[desc] ?? "") }));

  const sites: FakeListItem[] = SITES.map((s) => ({ value: s.siteid, description: s.description }));
  const persons = listOf("PERSON", "personid", "displayname");
  const groups = listOf("PERSONGROUP", "persongroup", "description");
  const units: FakeListItem[] = MEASURE_UNITS.map(([v, d]) => ({ value: v, description: d }));
  const companies: FakeListItem[] = COMPANIES.map((c) => ({ value: c.company, description: c.name }));
  const classesFor = (o: "ASSET" | "LOCATIONS"): FakeListItem[] =>
    CLASSES.map((c, i) => ({ c, id: String(1001 + i) })).filter(({ c }) => c.useWith.includes(o)).map(({ c, id }) => ({ value: id, description: `${c.id} ${c.desc}` }));
  const failureClasses = rows("FAILURECODE").filter((r) => String(r.attrs.description).endsWith("（故障クラス）")).map((r) => ({ value: String(r.attrs.failurecode), description: String(r.attrs.description) }));
  const allFailureCodes = listOf("FAILURECODE", "failurecode", "description");
  const problemCodes = [...new Set(rows("FAILURELIST").filter((r) => r.attrs.type === "PROBLEM").map((r) => String(r.attrs.failurecode)))].map((v) => allFailureCodes.find((x) => x.value === v)!);
  const worktypes: FakeListItem[] = [
    { value: "PM", description: "予防保全" }, { value: "CM", description: "是正保全" }, { value: "EM", description: "緊急保全" },
    { value: "CAL", description: "校正" }, { value: "INSP", description: "点検・検査" },
  ];
  const jobplans: FakeListItem[] = PM_PROGRAMS.map((p) => ({ value: p.jp, description: p.desc }));
  const locations = listOf("LOCATIONS", "location", "description");
  const storerooms = rows("LOCATIONS").filter((r) => r.attrs.type === "STOREROOM").map((r) => ({ value: String(r.attrs.location), description: String(r.attrs.description) }));
  const attrIds = listOf("ASSETATTRIBUTE", "assetattrid", "description");
  const meters: FakeListItem[] = METERS.map((m) => ({ value: m.name, description: m.desc }));
  const crafts: FakeListItem[] = CRAFTS.map(([v, d]) => ({ value: v, description: d }));
  const items = listOf("ITEM", "itemnum", "description");
  const failTypes: FakeListItem[] = [{ value: "PROBLEM", description: "問題" }, { value: "CAUSE", description: "原因" }, { value: "REMEDY", description: "処置" }];

  const woAttrs = attrs({
    wonum: "s10!|作業指示", siteid: "s8!*|サイト", orgid: "s8r|組織", description: "s100|説明", description_longdescription: "s|長い説明",
    worktype: "s5*|作業タイプ", status: "s16*|ステータス", statusdate: "dtr|ステータスの日付", reportdate: "dt|報告日", reportedby: "s30*|報告者",
    targstartdate: "dt|目標開始", targcompdate: "dt|目標完了", schedstart: "dt|予定開始", schedfinish: "dt|予定終了", actstart: "dt|実績開始", actfinish: "dt|実績終了",
    wopriority: "i|優先度", assetnum: "s12|資産", location: "s12|場所", pmnum: "s8|PM", jpnum: "s10*|作業計画", failurecode: "s8*|故障クラス", problemcode: "s8*|問題コード",
    estdur: "n|見積期間（時）", estlabhrs: "n|見積工数", actlabhrs: "nr|実績工数", supervisor: "s30*|監督者", lead: "s30*|リード", ownergroup: "s8*|所有者グループ",
    woclass: "s16r|クラス", historyflag: "br|履歴", istask: "br|タスク", parent: "s10|親の作業指示", origrecordid: "s10|元のレコード", origrecordclass: "s16|元のレコードのクラス",
    downtime: "b|ダウンタイム", workorderid: "ir|作業指示 ID",
  });
  const woLists: Record<string, FakeListItem[]> = {
    siteid: sites, worktype: worktypes, status: domainList("WOSTATUS"), reportedby: persons, jpnum: jobplans, failurecode: failureClasses, problemcode: problemCodes,
    supervisor: persons, lead: persons, ownergroup: groups,
  };
  const wodetail: FakeOsSeed = {
    description: "Work Order Detail",
    mbo: "WORKORDER",
    keyAttrs: ["wonum", "siteid"],
    attrs: woAttrs,
    children: {
      wostatus: { idAttr: "wostatusid", attrs: attrs({ wostatusid: "ir", status: "s16*|ステータス", changedate: "dt|変更日", changeby: "s30|変更者", memo: "s50|メモ" }) },
      failurereport: { idAttr: "failurereportid", attrs: attrs({ failurereportid: "ir", type: "s8*|タイプ", failurecode: "s8*|故障コード", linenum: "i|行", assetnum: "s12|資産" }) },
    },
    lists: { ...woLists, "wostatus.status": domainList("WOSTATUS"), "failurereport.type": failTypes, "failurereport.failurecode": allFailureCodes },
    records: rows("WORKORDER"),
  };

  const os: FakeSeed["objectStructures"] = {
    MXAPIORGANIZATION: {
      description: "Organization",
      mbo: "ORGANIZATION",
      keyAttrs: ["orgid"],
      attrs: attrs({ orgid: "s8!|組織", description: "s100|説明", active: "b|有効", basecurrency1: "s8|基本通貨", itemsetid: "s8|品目セット", companysetid: "s8|会社セット", clearingacct: "s20|清算勘定" }),
      children: { site: { idAttr: "siteuid", attrs: attrs({ siteuid: "ir", siteid: "s8|サイト", description: "s100|説明", active: "b|有効", orgid: "s8|組織" }) } },
      records: rows("ORGANIZATION"),
    },
    MXAPIOPERLOC: {
      description: "Operating Location",
      mbo: "LOCATIONS",
      keyAttrs: ["location", "siteid"],
      attrs: attrs({
        location: "s12!|場所", siteid: "s8!*|サイト", orgid: "s8r|組織", description: "s100|説明", type: "s16*|タイプ", status: "s20*|ステータス",
        classstructureid: "s20*|分類", disabled: "b|無効", changeby: "s30r|変更者", locationsid: "ir|場所 ID",
      }),
      children: {
        lochierarchy: { idAttr: "lochierarchyid", attrs: attrs({ lochierarchyid: "ir", systemid: "s8*|システム", parent: "s12|親", children: "b|子あり", siteid: "s8|サイト", orgid: "s8|組織" }) },
        locationspec: { idAttr: "locationspecid", attrs: attrs({ locationspecid: "ir", assetattrid: "s20*|属性", classstructureid: "s20|分類", displaysequence: "i|表示順", alnvalue: "s254|英数字の値", numvalue: "n|数値", measureunitid: "s16*|単位" }) },
      },
      lists: {
        siteid: sites, type: domainList("LOCTYPE"), status: domainList("LOCASSETSTATUS"), classstructureid: classesFor("LOCATIONS"),
        "lochierarchy.systemid": [{ value: "PRIMARY", description: "主系統" }], "locationspec.assetattrid": attrIds, "locationspec.measureunitid": units,
      },
      records: rows("LOCATIONS"),
    },
    MXAPIASSET: {
      description: "Asset",
      mbo: "ASSET",
      keyAttrs: ["assetnum", "siteid"],
      attrs: attrs({
        assetnum: "s12!|資産", siteid: "s8!*|サイト", orgid: "s8r|組織", description: "s100|説明", assettag: "s20|資産タグ", location: "s12*|場所", parent: "s12|親",
        status: "s20*|ステータス", statusdate: "dtr|ステータスの日付", installdate: "dt|設置日", serialnum: "s64|製造番号", manufacturer: "s12*|製造元", vendor: "s12*|購入先",
        priority: "i|優先度", classstructureid: "s20*|分類", failurecode: "s8*|故障クラス", isrunning: "b|稼働中", assetid: "ir|資産 ID", changeby: "s30r|変更者", changedate: "dtr|変更日",
      }),
      children: {
        assetspec: {
          idAttr: "assetspecid",
          attrs: attrs({ assetspecid: "ir", assetattrid: "s20*|属性", classstructureid: "s20|分類", displaysequence: "i|表示順", alnvalue: "s254|英数字の値", numvalue: "n|数値", measureunitid: "s16*|単位", changedate: "dtr|変更日", changeby: "s30r|変更者" }),
        },
        assetmeter: {
          idAttr: "assetmeterid",
          attrs: attrs({ assetmeterid: "ir", metername: "s10*|メーター", active: "b|有効", lastreading: "s18|最新の読み", lastreadingdate: "dt|最新の読みの日付", measureunitid: "s16|単位" }),
        },
      },
      lists: {
        siteid: sites, location: locations, status: domainList("LOCASSETSTATUS"), manufacturer: companies, vendor: companies, classstructureid: classesFor("ASSET"),
        failurecode: failureClasses, "assetspec.assetattrid": attrIds, "assetspec.measureunitid": units, "assetmeter.metername": meters,
      },
      records: rows("ASSET"),
    },
    MXAPICLASSSTRUCTURE: {
      description: "Classification",
      mbo: "CLASSSTRUCTURE",
      keyAttrs: ["classstructureid"],
      attrs: attrs({
        classstructureid: "s20!|分類 ID", classificationid: "s20|分類", description: "s100|説明", parent: "s20|親", hierarchypath: "sr|階層パス", haschildren: "br|子あり",
        orgid: "s8|組織", siteid: "s8|サイト", genassetdesc: "b|説明を生成", useclassindesc: "b|分類を説明に使う", type: "s20|タイプ",
      }),
      children: {
        classspec: { idAttr: "classspecid", attrs: attrs({ classspecid: "ir", assetattrid: "s20*|属性", measureunitid: "s16*|単位", displaysequence: "i|表示順", classstructureid: "s20|分類", orgid: "s8|組織" }) },
        classusewith: { idAttr: "classusewithid", attrs: attrs({ classusewithid: "ir", objectname: "s30*|オブジェクト", description: "s100|説明", toplevel: "b|最上位" }) },
      },
      lists: {
        "classspec.assetattrid": attrIds, "classspec.measureunitid": units,
        "classusewith.objectname": [{ value: "ASSET", description: "資産" }, { value: "LOCATIONS", description: "場所" }],
      },
      records: rows("CLASSSTRUCTURE"),
    },
    MXAPIASSETATTRIBUTE: {
      description: "Asset Attribute",
      mbo: "ASSETATTRIBUTE",
      keyAttrs: ["assetattrid", "orgid"],
      attrs: attrs({ assetattrid: "s20!|属性", description: "s100|説明", datatype: "s8*|データ型", measureunitid: "s16*|単位", orgid: "s8|組織", domainid: "s18|ドメイン" }),
      lists: { datatype: domainList("DATATYPE"), measureunitid: units },
      records: rows("ASSETATTRIBUTE"),
    },
    MXAPIMEASUREUNIT: {
      description: "Unit of Measure",
      mbo: "MEASUREUNIT",
      keyAttrs: ["measureunitid"],
      attrs: attrs({ measureunitid: "s16!|単位", description: "s100|説明", abbreviation: "s8|略称", orgid: "s8|組織" }),
      records: rows("MEASUREUNIT"),
    },
    MXAPIFAILURECODE: {
      description: "Failure Code",
      mbo: "FAILURECODE",
      keyAttrs: ["failurecode", "orgid"],
      attrs: attrs({ failurecode: "s8!|故障コード", description: "s100|説明", orgid: "s8|組織" }),
      records: rows("FAILURECODE"),
    },
    MXAPIFAILURELIST: {
      description: "Failure Hierarchy",
      mbo: "FAILURELIST",
      keyAttrs: ["failurelist"],
      attrs: attrs({ failurelist: "i!|故障リスト", failurecode: "s8*|故障コード", parent: "i|親", type: "s8*|タイプ", orgid: "s8|組織" }),
      lists: { failurecode: allFailureCodes, type: failTypes },
      records: rows("FAILURELIST"),
    },
    MXAPIJOBPLAN: {
      description: "Job Plan",
      mbo: "JOBPLAN",
      keyAttrs: ["jpnum", "pluscrevnum", "orgid", "siteid"],
      attrs: attrs({
        jpnum: "s10!|作業計画", description: "s100|説明", status: "s16*|ステータス", orgid: "s8|組織", siteid: "s8|サイト", pluscrevnum: "i|改訂",
        jpduration: "n|期間（時）", jobplanid: "ir|作業計画 ID", interruptible: "b|中断可", templatetype: "s20|テンプレートのタイプ", laborcode: "s30|作業員", crewid: "s8|クルー",
      }),
      children: {
        jobtask: { idAttr: "jobtaskid", attrs: attrs({ jobtaskid: "ir", jptask: "i|タスク", description: "s100|説明", orgid: "s8|組織", siteid: "s8|サイト" }) },
        joblabor: { idAttr: "joblaborid", attrs: attrs({ joblaborid: "ir", craft: "s8*|職種", skilllevel: "s15|技能レベル", quantity: "i|人数", laborhrs: "n|作業時間", orgid: "s8|組織" }) },
        jobmaterial: { idAttr: "jobmaterialid", attrs: attrs({ jobmaterialid: "ir", itemnum: "s30*|品目", itemsetid: "s8|品目セット", itemqty: "n|数量", orgid: "s8|組織" }) },
      },
      lists: { status: domainList("JOBPLANSTATUS"), "joblabor.craft": crafts, "jobmaterial.itemnum": items },
      records: rows("JOBPLAN"),
    },
    MXAPIPM: {
      description: "Preventive Maintenance",
      mbo: "PM",
      keyAttrs: ["pmnum", "siteid"],
      attrs: attrs({
        pmnum: "s8!|PM", siteid: "s8!*|サイト", orgid: "s8r|組織", description: "s100|説明", status: "s16*|ステータス", assetnum: "s12|資産", location: "s12|場所",
        jpnum: "s10*|作業計画", frequency: "i|頻度", frequnit: "s8*|頻度の単位", worktype: "s5*|作業タイプ", leadtime: "i|リードタイム（日）", nextdate: "dt|次回日",
        lastcompdate: "dt|最終完了日", laststartdate: "dt|最終開始日", ownergroup: "s8*|所有者グループ", priority: "i|優先度", usetargetdate: "b|目標日を使う", pmid: "ir|PM ID",
      }),
      lists: { siteid: sites, status: domainList("PMSTATUS"), jpnum: jobplans, frequnit: domainList("FREQUNIT"), worktype: worktypes, ownergroup: groups },
      records: rows("PM"),
    },
    MXAPIWODETAIL: wodetail,
    // 作業指示の簡易な構造（子なし）。行は MXAPIWODETAIL と同じ（同じ WORKORDER の表）
    MXAPIWO: { description: "Work Order", mbo: "WORKORDER", keyAttrs: ["wonum", "siteid"], attrs: woAttrs, lists: woLists, recordsFrom: "MXAPIWODETAIL" },
    MXAPISR: {
      description: "Service Request",
      mbo: "SR",
      keyAttrs: ["ticketid", "class"],
      attrs: attrs({
        ticketid: "s10!|サービス要求", class: "s16r|クラス", siteid: "s8*|サイト", orgid: "s8r|組織", description: "s100|件名", description_longdescription: "s|詳細",
        status: "s10*|ステータス", statusdate: "dtr|ステータスの日付", reportedby: "s30*|報告者", affectedperson: "s30*|影響を受けた人", reportdate: "dt|報告日",
        assetnum: "s12|資産", assetsiteid: "s8|資産のサイト", location: "s12|場所", internalpriority: "i|内部優先度", reportedpriority: "i|報告優先度",
        ownergroup: "s8*|所有者グループ", actualstart: "dt|実績開始", actualfinish: "dt|実績終了", ticketuid: "ir|チケット ID",
      }),
      children: {
        tkstatus: { idAttr: "tkstatusid", attrs: attrs({ tkstatusid: "ir", status: "s10*|ステータス", changedate: "dt|変更日", changeby: "s30|変更者" }) },
        relatedrecord: { idAttr: "relatedrecordid", attrs: attrs({ relatedrecordid: "ir", relatedreckey: "s10|関連レコード", relatedrecclass: "s16|関連レコードのクラス", relatetype: "s16|関係", relatedrecsiteid: "s8|サイト" }) },
      },
      lists: { siteid: sites, status: domainList("SRSTATUS"), reportedby: persons, affectedperson: persons, ownergroup: groups, "tkstatus.status": domainList("SRSTATUS") },
      records: rows("SR"),
    },
    MXAPIMETER: {
      description: "Meter",
      mbo: "METER",
      keyAttrs: ["metername"],
      attrs: attrs({ metername: "s10!|メーター", description: "s100|説明", metertype: "s16*|タイプ", measureunitid: "s16*|単位", readingtype: "s10|読みのタイプ", rollover: "n|ロールオーバー", domainid: "s18|ドメイン" }),
      lists: { metertype: domainList("METERTYPE"), measureunitid: units },
      records: rows("METER"),
    },
    MXAPIMETERREADING: {
      description: "Meter Reading",
      mbo: "METERREADING",
      keyAttrs: ["meterreadingid"],
      attrs: attrs({
        meterreadingid: "i!r|メーターの読み ID", assetnum: "s12|資産", siteid: "s8*|サイト", orgid: "s8|組織", metername: "s10*|メーター", reading: "n|読み",
        delta: "n|差分", readingdate: "dt|読みの日付", inspector: "s30|検査者", enterby: "s30|入力者", isdelta: "b|差分入力",
      }),
      lists: { siteid: sites, metername: meters },
      records: rows("METERREADING"),
    },
    MXAPIITEM: {
      description: "Item",
      mbo: "ITEM",
      keyAttrs: ["itemnum", "itemsetid"],
      attrs: attrs({
        itemnum: "s30!|品目", itemsetid: "s8!|品目セット", description: "s100|説明", status: "s16*|ステータス", orderunit: "s16*|発注単位", issueunit: "s16*|払出単位",
        commoditygroup: "s8|商品グループ", rotating: "b|回転資産", lottype: "s8|ロットのタイプ", itemtype: "s8|品目のタイプ", inspectionrequired: "b|検査が必要", itemid: "ir|品目 ID",
      }),
      lists: { status: domainList("ITEMSTATUS"), orderunit: units, issueunit: units },
      records: rows("ITEM"),
    },
    MXAPIINVENTORY: {
      description: "Inventory",
      mbo: "INVENTORY",
      keyAttrs: ["itemnum", "itemsetid", "location", "siteid"],
      attrs: attrs({
        itemnum: "s30!|品目", itemsetid: "s8!|品目セット", siteid: "s8!*|サイト", orgid: "s8r|組織", location: "s12!*|倉庫", binnum: "s8|既定の棚",
        category: "s4*|在庫区分", status: "s16*|ステータス", minlevel: "n|発注点", maxlevel: "n|最大在庫", orderqty: "n|発注量", orderunit: "s16|発注単位",
        issueunit: "s16|払出単位", abctype: "s1*|ABC 分類", curbaltotal: "nr|現在の残高", avgcost: "nr|平均単価", lastissuedate: "dtr|最終払出日", inventoryid: "ir|在庫 ID",
      }),
      children: {
        invbalances: { idAttr: "invbalancesid", attrs: attrs({ invbalancesid: "ir", binnum: "s8|棚", lotnum: "s8|ロット", curbal: "nr|現在の残高", physcnt: "n|実地棚卸数", physcntdate: "dt|実地棚卸日", conditioncode: "s30|状態コード" }) },
      },
      lists: { siteid: sites, location: storerooms, category: domainList("CATEGORY"), status: domainList("ITEMSTATUS"), abctype: domainList("ABCTYPE") },
      records: rows("INVENTORY"),
    },
    MXAPIPERSON: {
      description: "Person",
      mbo: "PERSON",
      keyAttrs: ["personid"],
      attrs: attrs({
        personid: "s30!|担当者", displayname: "s62|表示名", lastname: "s50|姓", firstname: "s50|名", status: "s16*|ステータス", title: "s50|役職",
        department: "s30|部署", locationsite: "s8*|サイト", locationorg: "s8|組織", employeetype: "s20|従業員のタイプ", statusdate: "dtr|ステータスの日付",
      }),
      lists: { status: domainList("PERSONSTATUS"), locationsite: sites },
      records: rows("PERSON"),
    },
    MXAPILABOR: {
      description: "Labor",
      mbo: "LABOR",
      keyAttrs: ["laborcode", "orgid"],
      attrs: attrs({ laborcode: "s30!|作業員", personid: "s30|担当者", orgid: "s8|組織", worksite: "s8*|作業サイト", status: "s16*|ステータス", laborid: "ir|作業員 ID" }),
      children: { laborcraftrate: { idAttr: "laborcraftrateid", attrs: attrs({ laborcraftrateid: "ir", craft: "s8*|職種", skilllevel: "s15|技能レベル", defaultcraft: "b|既定の職種", orgid: "s8|組織" }) } },
      lists: { worksite: sites, status: domainList("LABORSTATUS"), "laborcraftrate.craft": crafts },
      records: rows("LABOR"),
    },
    MXAPICRAFT: {
      description: "Craft",
      mbo: "CRAFT",
      keyAttrs: ["craft", "orgid"],
      attrs: attrs({ craft: "s8!|職種", description: "s100|説明", orgid: "s8|組織" }),
      records: rows("CRAFT"),
    },
    MXAPIPERSONGROUP: {
      description: "Person Group",
      mbo: "PERSONGROUP",
      keyAttrs: ["persongroup"],
      attrs: attrs({ persongroup: "s8!|担当者グループ", description: "s100|説明", siteid: "s8|サイト", orgid: "s8|組織" }),
      children: {
        persongroupteam: { idAttr: "persongroupteamid", attrs: attrs({ persongroupteamid: "ir", respparty: "s30*|担当者", resppartygroupseq: "i|順序", groupdefault: "b|グループの既定", useforsite: "s8|サイト", usefororg: "s8|組織" }) },
      },
      lists: { "persongroupteam.respparty": persons },
      records: rows("PERSONGROUP"),
    },
    MXAPICOMPANY: {
      description: "Company",
      mbo: "COMPANIES",
      keyAttrs: ["company", "orgid"],
      attrs: attrs({ company: "s12!|会社", name: "s100|名前", type: "s1*|タイプ", orgid: "s8|組織", currencycode: "s8|通貨", disabled: "b|無効" }),
      lists: { type: domainList("COMPTYPE") },
      records: rows("COMPANIES"),
    },
    MXAPIDOMAIN: {
      description: "Domain",
      mbo: "MAXDOMAIN",
      keyAttrs: ["domainid"],
      attrs: attrs({ domainid: "s18!|ドメイン", description: "s100|説明", domaintype: "s16*|ドメインのタイプ", maxtype: "s8|データ型", length: "i|長さ", internal: "br|内部" }),
      children: {
        synonymdomain: { idAttr: "synonymdomainid", attrs: attrs({ synonymdomainid: "ir", maxvalue: "s50|内部値", value: "s50|値", description: "s100|説明", defaults: "b|既定", orgid: "s8|組織", siteid: "s8|サイト" }) },
        alndomain: { idAttr: "alndomainid", attrs: attrs({ alndomainid: "ir", value: "s50|値", description: "s100|説明", orgid: "s8|組織", siteid: "s8|サイト" }) },
      },
      lists: {
        domaintype: [{ value: "ALN", description: "英数字" }, { value: "SYNONYM", description: "同義語" }, { value: "NUMERIC", description: "数値" }, { value: "TABLE", description: "表" }, { value: "CROSSOVER", description: "クロスオーバー" }],
      },
      records: rows("MAXDOMAIN"),
    },
  };
  return os;
}
