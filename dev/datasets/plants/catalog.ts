// ごみ焼却施設 3 か所の架空データの「型」: 分類と仕様、故障コードの階層、設備の構成、保全計画、部品、人名。
// 名前はすべて架空（実在の自治体・会社を使わない）。コード・ID は ASCII、説明は日本語。

export type SiteCode = "KITA" | "MINAMI" | "HIGASHI";

export interface SiteDef {
  siteid: SiteCode;
  /** 場所コードとタグの接頭辞（2 文字） */
  prefix: string;
  description: string;
  /** 竣工（稼働開始） */
  start: { y: number; m: number };
  lines: number;
  /** 1 炉あたりの処理能力（t/日） */
  tonPerLine: number;
  /** 受電電圧（V） */
  receiveV: number;
  /** 発電出力（kW） */
  turbineKw: number;
  /** 建設したプラントメーカー（COMPANIES のコード） */
  epc: string;
  /** ASSETNUM の先頭の数字 */
  assetBase: number;
}

export const ORGID = "KANKYO";
export const ORG_DESCRIPTION = "MX 広域環境事業組合（架空）";
export const ITEMSETID = "SET1";

export const SITES: SiteDef[] = [
  { siteid: "KITA", prefix: "KT", description: "北部クリーンセンター", start: { y: 2006, m: 4 }, lines: 3, tonPerLine: 100, receiveV: 66000, turbineKw: 6000, epc: "MKR-PLA", assetBase: 1_000_000 },
  { siteid: "MINAMI", prefix: "MN", description: "南部クリーンセンター", start: { y: 2013, m: 4 }, lines: 2, tonPerLine: 120, receiveV: 66000, turbineKw: 5500, epc: "MKR-PLB", assetBase: 2_000_000 },
  { siteid: "HIGASHI", prefix: "HG", description: "東部クリーンセンター", start: { y: 2021, m: 4 }, lines: 2, tonPerLine: 95, receiveV: 6600, turbineKw: 4200, epc: "MKR-PLC", assetBase: 3_000_000 },
];

// ---------------------------------------------------------------------------
// 単位・仕様の属性
// ---------------------------------------------------------------------------

export const MEASURE_UNITS: Array<[string, string]> = [
  ["KW", "キロワット"], ["W", "ワット"], ["V", "ボルト"], ["A", "アンペア"], ["RPM", "回転/分"], ["HZ", "ヘルツ"],
  ["M3/H", "立方メートル/時"], ["L/MIN", "リットル/分"], ["M", "メートル"], ["MM", "ミリメートル"], ["M3/MIN", "立方メートル/分"],
  ["KPA", "キロパスカル"], ["MPA", "メガパスカル"], ["T/H", "トン/時"], ["T/D", "トン/日"], ["T", "トン"], ["M3", "立方メートル"],
  ["M2", "平方メートル"], ["DEGC", "℃"], ["M3N/H", "ノルマル立方メートル/時"], ["PCS", "本"], ["KVA", "キロボルトアンペア"],
  ["KA", "キロアンペア"], ["MIN", "分"], ["KG", "キログラム"], ["M/MIN", "メートル/分"], ["L", "リットル"], ["L/H", "リットル/時"],
  ["HOURS", "時間"], ["MWH", "メガワット時"], ["CYCLES", "回"], ["MM/S", "ミリメートル/秒"], ["EA", "個"], ["SET", "式"],
  ["BOX", "箱"], ["CAN", "缶"], ["KGBAG", "袋"],
];

export interface AttrDef {
  id: string;
  desc: string;
  type: "ALN" | "NUMERIC";
  unit?: string;
  /** 値の既定の範囲（NUMERIC: [最小, 最大, 小数桁]）または候補（ALN） */
  def?: [number, number, number] | string[];
}

export const ATTRS: AttrDef[] = [
  { id: "RATED_POWER", desc: "定格出力", type: "NUMERIC", unit: "KW", def: [1.5, 30, 1] },
  { id: "RATED_VOLTAGE", desc: "定格電圧", type: "NUMERIC", unit: "V", def: [400, 400, 0] },
  { id: "RATED_CURRENT", desc: "定格電流", type: "NUMERIC", unit: "A", def: [5, 60, 1] },
  { id: "RATED_SPEED", desc: "定格回転数", type: "NUMERIC", unit: "RPM", def: [1450, 1480, 0] },
  { id: "POLES", desc: "極数", type: "NUMERIC", def: [4, 4, 0] },
  { id: "FREQUENCY", desc: "周波数", type: "NUMERIC", unit: "HZ", def: [50, 50, 0] },
  { id: "PROTECTION", desc: "保護方式", type: "ALN", def: ["全閉外扇形", "全閉外扇形", "全閉外扇形", "防爆形", "開放防滴形"] },
  { id: "INSULATION", desc: "耐熱クラス", type: "ALN", def: ["F種", "F種", "E種", "B種"] },
  { id: "FRAME_NO", desc: "枠番号", type: "ALN", def: ["112M", "132S", "160M", "180L", "200L", "225S", "250M", "280S"] },
  { id: "MODEL", desc: "型式", type: "ALN" },
  { id: "MFG_YEAR", desc: "製造年", type: "NUMERIC" },
  { id: "MATERIAL", desc: "主要材質", type: "ALN", def: ["FC200", "SCS13", "SCS14", "SS400", "SUS304", "SUS316L"] },
  { id: "FLOW", desc: "定格流量", type: "NUMERIC", unit: "M3/H", def: [5, 60, 1] },
  { id: "HEAD", desc: "全揚程", type: "NUMERIC", unit: "M", def: [10, 60, 0] },
  { id: "PUMP_TYPE", desc: "ポンプ形式", type: "ALN", def: ["片吸込渦巻", "片吸込渦巻", "両吸込渦巻", "多段タービン", "水中", "ギヤ", "ダイヤフラム"] },
  { id: "BORE", desc: "口径", type: "NUMERIC", unit: "MM", def: [25, 150, 0] },
  { id: "AIRFLOW", desc: "風量", type: "NUMERIC", unit: "M3/MIN", def: [50, 900, 0] },
  { id: "STATIC_PRESS", desc: "静圧", type: "NUMERIC", unit: "KPA", def: [1, 8, 1] },
  { id: "DISCH_PRESS", desc: "吐出圧力", type: "NUMERIC", unit: "MPA", def: [0.69, 0.85, 2] },
  { id: "COMP_TYPE", desc: "圧縮機形式", type: "ALN", def: ["油冷式スクリュー", "オイルフリースクリュー", "レシプロ"] },
  { id: "CONV_TYPE", desc: "コンベヤ形式", type: "ALN", def: ["ベルト", "スクリュー", "チェーン", "エプロン"] },
  { id: "BELT_WIDTH", desc: "ベルト幅", type: "NUMERIC", unit: "MM", def: [450, 900, 0] },
  { id: "CONV_LENGTH", desc: "機長", type: "NUMERIC", unit: "M", def: [5, 40, 1] },
  { id: "CAPACITY_TH", desc: "処理能力", type: "NUMERIC", unit: "T/H", def: [0.5, 10, 1] },
  { id: "LIFT_CAPACITY", desc: "定格荷重", type: "NUMERIC", unit: "T", def: [5, 15, 1] },
  { id: "SPAN", desc: "スパン", type: "NUMERIC", unit: "M", def: [15, 30, 1] },
  { id: "LIFT_HEIGHT", desc: "揚程", type: "NUMERIC", unit: "M", def: [25, 40, 1] },
  { id: "BUCKET_CAPACITY", desc: "バケット容量", type: "NUMERIC", unit: "M3", def: [3, 8, 1] },
  { id: "CRANE_TYPE", desc: "クレーン形式", type: "ALN", def: ["天井走行クレーン（グラブバケット付）"] },
  { id: "GRATE_TYPE", desc: "火格子形式", type: "ALN", def: ["階段式", "並行揺動式", "逆送式"] },
  { id: "GRATE_AREA", desc: "火格子面積", type: "NUMERIC", unit: "M2", def: [10, 40, 1] },
  { id: "FEEDER_TYPE", desc: "供給装置形式", type: "ALN", def: ["プッシャ式", "スクリュー式", "テーブル式", "ロータリー式"] },
  { id: "OUTPUT_KW", desc: "発電出力", type: "NUMERIC", unit: "KW", def: [4000, 6000, 0] },
  { id: "STEAM_FLOW", desc: "蒸発量", type: "NUMERIC", unit: "T/H", def: [12, 20, 1] },
  { id: "STEAM_PRESS", desc: "蒸気圧力", type: "NUMERIC", unit: "MPA", def: [3.0, 4.0, 1] },
  { id: "STEAM_TEMP", desc: "蒸気温度", type: "NUMERIC", unit: "DEGC", def: [300, 400, 0] },
  { id: "TURBINE_TYPE", desc: "タービン形式", type: "ALN", def: ["抽気復水タービン", "背圧タービン"] },
  { id: "CAPACITY", desc: "容量", type: "NUMERIC", unit: "M3", def: [1, 50, 1] },
  { id: "RATIO", desc: "減速比", type: "NUMERIC", def: [5, 20, 1] },
  { id: "SB_TYPE", desc: "スートブロワ形式", type: "ALN", def: ["長抜差式", "定置回転式"] },
  { id: "MEDIUM", desc: "噴射媒体", type: "ALN", def: ["蒸気"] },
  { id: "HEAT_AREA", desc: "伝熱面積", type: "NUMERIC", unit: "M2", def: [50, 900, 0] },
  { id: "BOILER_TYPE", desc: "ボイラ形式", type: "ALN", def: ["自然循環式水管ボイラ"] },
  { id: "HEX_TYPE", desc: "熱交換器形式", type: "ALN", def: ["シェルアンドチューブ", "プレート式", "フィンチューブ", "空冷式"] },
  { id: "DESIGN_PRESS", desc: "設計圧力", type: "NUMERIC", unit: "MPA", def: [0.5, 4.5, 2] },
  { id: "DESIGN_TEMP", desc: "設計温度", type: "NUMERIC", unit: "DEGC", def: [80, 450, 0] },
  { id: "GAS_FLOW", desc: "処理ガス量", type: "NUMERIC", unit: "M3N/H", def: [20000, 45000, 0] },
  { id: "FILTER_AREA", desc: "ろ過面積", type: "NUMERIC", unit: "M2", def: [1500, 3000, 0] },
  { id: "BAG_COUNT", desc: "ろ布本数", type: "NUMERIC", unit: "PCS", def: [100, 500, 0] },
  { id: "COMPARTMENTS", desc: "室数", type: "NUMERIC", def: [6, 6, 0] },
  { id: "BAG_MATERIAL", desc: "ろ布材質", type: "ALN", def: ["PTFE", "PTFE", "ガラス繊維", "PPS/PTFE混紡"] },
  { id: "BAG_SIZE", desc: "ろ布寸法", type: "ALN", def: ["φ160×6000", "φ150×5000"] },
  { id: "CATALYST_VOLUME", desc: "触媒量", type: "NUMERIC", unit: "M3", def: [8, 20, 1] },
  { id: "CATALYST_TYPE", desc: "触媒形式", type: "ALN", def: ["ハニカム", "板状"] },
  { id: "TOWER_DIA", desc: "塔径", type: "NUMERIC", unit: "M", def: [3, 6, 1] },
  { id: "TOWER_HEIGHT", desc: "塔高", type: "NUMERIC", unit: "M", def: [12, 25, 1] },
  { id: "STACK_HEIGHT", desc: "煙突高さ", type: "NUMERIC", unit: "M", def: [59, 100, 0] },
  { id: "FLUE_COUNT", desc: "内筒数", type: "NUMERIC", def: [2, 3, 0] },
  { id: "DAMPER_TYPE", desc: "ダンパ形式", type: "ALN", def: ["バタフライ", "ルーバ", "ギロチン"] },
  { id: "SIZE_MM", desc: "呼び寸法", type: "NUMERIC", unit: "MM", def: [300, 1600, 0] },
  { id: "ACTUATOR", desc: "操作方式", type: "ALN", def: ["電動", "空気式", "手動"] },
  { id: "REFR_MATERIAL", desc: "耐火材質", type: "ALN", def: ["SiC質", "高アルミナ質", "キャスタブル", "プラスチック耐火物"] },
  { id: "REFR_AREA", desc: "施工面積", type: "NUMERIC", unit: "M2", def: [80, 250, 0] },
  { id: "WATER_FLOW", desc: "処理水量", type: "NUMERIC", unit: "M3/H", def: [2, 50, 1] },
  { id: "COOL_CAPACITY", desc: "冷却能力", type: "NUMERIC", unit: "KW", def: [1000, 8000, 0] },
  { id: "TREAT_TYPE", desc: "処理方式", type: "ALN", def: ["イオン交換", "逆浸透膜", "砂ろ過", "凝集沈殿"] },
  { id: "BURNER_CAP", desc: "バーナ容量", type: "NUMERIC", unit: "L/H", def: [100, 600, 0] },
  { id: "FUEL", desc: "燃料", type: "ALN", def: ["灯油", "A重油", "都市ガス"] },
  { id: "DOOR_TYPE", desc: "扉形式", type: "ALN", def: ["観音開き式", "シャッター式"] },
  { id: "DRIVE", desc: "駆動方式", type: "ALN", def: ["油圧", "電動"] },
  { id: "DOOR_SIZE", desc: "開口寸法", type: "ALN", def: ["W3500×H6000", "W4000×H6500"] },
  { id: "WEIGH_CAP", desc: "ひょう量", type: "NUMERIC", unit: "T", def: [30, 30, 0] },
  { id: "PLATFORM", desc: "載台寸法", type: "ALN", def: ["3.0m×10.0m", "3.0m×12.0m"] },
  { id: "TANK_CAP", desc: "油タンク容量", type: "NUMERIC", unit: "L", def: [200, 2000, 0] },
  { id: "PRESS_RATING", desc: "圧力クラス", type: "ALN", def: ["JIS10K", "JIS10K", "JIS20K", "JIS30K"] },
  { id: "VALVE_TYPE", desc: "弁形式", type: "ALN", def: ["玉形弁", "バタフライ弁", "ボール弁", "仕切弁"] },
  { id: "CV_VALUE", desc: "容量係数(Cv)", type: "NUMERIC", def: [5, 250, 0] },
  { id: "SET_PRESS", desc: "吹出し圧力", type: "NUMERIC", unit: "MPA", def: [3.5, 4.5, 2] },
  { id: "BLOW_CAPACITY", desc: "吹出し量", type: "NUMERIC", unit: "T/H", def: [5, 20, 1] },
  { id: "RATED_KVA", desc: "定格容量", type: "NUMERIC", unit: "KVA", def: [50, 2000, 0] },
  { id: "PRIMARY_V", desc: "一次電圧", type: "NUMERIC", unit: "V", def: [6600, 6600, 0] },
  { id: "SECONDARY_V", desc: "二次電圧", type: "NUMERIC", unit: "V", def: [420, 420, 0] },
  { id: "COOLING", desc: "冷却方式", type: "ALN", def: ["油入自冷式", "モールド式", "油入風冷式"] },
  { id: "BREAK_CURRENT", desc: "定格遮断電流", type: "NUMERIC", unit: "KA", def: [12.5, 31.5, 1] },
  { id: "BREAKER_TYPE", desc: "遮断器形式", type: "ALN", def: ["VCB", "VCB", "GCB", "ACB"] },
  { id: "PANEL_COUNT", desc: "面数", type: "NUMERIC", def: [4, 16, 0] },
  { id: "POWER_FACTOR", desc: "力率", type: "NUMERIC", def: [0.8, 0.9, 2] },
  { id: "GEN_TYPE", desc: "発電機形式", type: "ALN", def: ["三相同期発電機"] },
  { id: "BACKUP_MIN", desc: "停電補償時間", type: "NUMERIC", unit: "MIN", def: [10, 60, 0] },
  { id: "BATTERY_TYPE", desc: "蓄電池形式", type: "ALN", def: ["制御弁式鉛蓄電池", "アルカリ蓄電池", "リチウムイオン蓄電池"] },
  { id: "ENGINE", desc: "原動機", type: "ALN", def: ["ディーゼル機関", "ガスタービン"] },
  { id: "MEAS_TYPE", desc: "測定種別", type: "ALN" },
  { id: "MEAS_RANGE", desc: "測定範囲", type: "ALN" },
  { id: "SIGNAL", desc: "出力信号", type: "ALN", def: ["4-20mA DC", "4-20mA DC", "4-20mA DC+HART", "FOUNDATION Fieldbus"] },
  { id: "ANALYTE", desc: "測定成分", type: "ALN" },
  { id: "MEAS_METHOD", desc: "測定方式", type: "ALN" },
  { id: "DCS_ROLE", desc: "機能", type: "ALN" },
  { id: "COOL_KW", desc: "冷房能力", type: "NUMERIC", unit: "KW", def: [10, 80, 1] },
  { id: "HEAT_KW", desc: "暖房能力", type: "NUMERIC", unit: "KW", def: [10, 90, 1] },
  { id: "REFRIGERANT", desc: "冷媒", type: "ALN", def: ["R410A", "R32"] },
  { id: "LOAD_KG", desc: "積載量", type: "NUMERIC", unit: "KG", def: [750, 1500, 0] },
  { id: "SPEED_MMIN", desc: "定格速度", type: "NUMERIC", unit: "M/MIN", def: [45, 90, 0] },
  { id: "STOPS", desc: "停止階数", type: "NUMERIC", def: [4, 7, 0] },
  // 場所の仕様
  { id: "CAPACITY_TD", desc: "処理能力", type: "NUMERIC", unit: "T/D" },
  { id: "LINES", desc: "炉数", type: "NUMERIC" },
  { id: "COMMISSIONED", desc: "竣工年月", type: "ALN" },
  { id: "FURNACE_TYPE", desc: "炉形式", type: "ALN" },
];

// ---------------------------------------------------------------------------
// 分類（CLASSSTRUCTURE）。親の分類は仕様を持たず、葉の分類に仕様を付ける
// ---------------------------------------------------------------------------

export interface ClassDef {
  id: string;
  desc: string;
  parent: string | null;
  useWith: Array<"ASSET" | "LOCATIONS">;
  specs?: string[];
  /** 資産の故障クラス（ASSET.FAILURECODE） */
  failure?: string;
  /** 1 台あたり年間の故障（是正保全）の件数の目安 */
  cmRate?: number;
  /** 寿命（年）。過ぎると更新する。無ければ更新しない */
  life?: [number, number];
  /** 稼働時間などのメーター */
  meters?: string[];
}

export const CLASSES: ClassDef[] = [
  { id: "MECH", desc: "機械設備", parent: null, useWith: ["ASSET"] },
  { id: "ROT", desc: "回転機械", parent: "MECH", useWith: ["ASSET"] },
  { id: "PUMP", desc: "ポンプ", parent: "ROT", useWith: ["ASSET"], specs: ["PUMP_TYPE", "FLOW", "HEAD", "BORE", "MATERIAL", "MODEL", "MFG_YEAR"], failure: "PUMP", cmRate: 0.3, life: [14, 22], meters: ["RUNHOURS", "VIBRATION"] },
  { id: "FAN", desc: "送風機", parent: "ROT", useWith: ["ASSET"], specs: ["AIRFLOW", "STATIC_PRESS", "RATED_SPEED", "MATERIAL", "MODEL", "MFG_YEAR"], failure: "FAN", cmRate: 0.3, life: [22, 30], meters: ["RUNHOURS", "VIBRATION"] },
  { id: "COMP", desc: "空気圧縮機", parent: "ROT", useWith: ["ASSET"], specs: ["COMP_TYPE", "AIRFLOW", "DISCH_PRESS", "MODEL", "MFG_YEAR"], failure: "COMPR", cmRate: 0.5, life: [12, 16], meters: ["RUNHOURS"] },
  { id: "CONV", desc: "コンベヤ", parent: "ROT", useWith: ["ASSET"], specs: ["CONV_TYPE", "BELT_WIDTH", "CONV_LENGTH", "CAPACITY_TH", "MODEL", "MFG_YEAR"], failure: "CONVEY", cmRate: 0.8, life: [14, 20], meters: ["RUNHOURS"] },
  { id: "CRANE", desc: "クレーン", parent: "ROT", useWith: ["ASSET"], specs: ["CRANE_TYPE", "LIFT_CAPACITY", "SPAN", "LIFT_HEIGHT", "MODEL", "MFG_YEAR"], failure: "CRANE", cmRate: 2.0, meters: ["RUNHOURS", "CRANECYCLE"] },
  { id: "GRAB", desc: "グラブバケット", parent: "ROT", useWith: ["ASSET"], specs: ["BUCKET_CAPACITY", "MODEL", "MFG_YEAR"], failure: "CRANE", cmRate: 0.6, life: [7, 10] },
  { id: "GRATE", desc: "火格子", parent: "ROT", useWith: ["ASSET"], specs: ["GRATE_TYPE", "GRATE_AREA", "MATERIAL", "MODEL", "MFG_YEAR"], failure: "STOKER", cmRate: 0.8 },
  { id: "FEEDER", desc: "供給装置", parent: "ROT", useWith: ["ASSET"], specs: ["FEEDER_TYPE", "CAPACITY_TH", "MODEL", "MFG_YEAR"], failure: "FEEDER", cmRate: 0.6, meters: ["RUNHOURS"] },
  { id: "TURBINE", desc: "蒸気タービン", parent: "ROT", useWith: ["ASSET"], specs: ["TURBINE_TYPE", "OUTPUT_KW", "STEAM_PRESS", "STEAM_TEMP", "RATED_SPEED", "MODEL", "MFG_YEAR"], failure: "TURBINE", cmRate: 0.6, meters: ["RUNHOURS", "STARTS"] },
  { id: "MIXER", desc: "撹拌機・混練機", parent: "ROT", useWith: ["ASSET"], specs: ["CAPACITY", "RATED_SPEED", "MODEL", "MFG_YEAR"], failure: "MECHGEN", cmRate: 0.5, life: [15, 20], meters: ["RUNHOURS"] },
  { id: "GEARBOX", desc: "減速機", parent: "ROT", useWith: ["ASSET"], specs: ["RATIO", "MODEL", "MFG_YEAR"], failure: "MECHGEN", cmRate: 0.1 },
  { id: "SOOTBL", desc: "スートブロワ", parent: "ROT", useWith: ["ASSET"], specs: ["SB_TYPE", "MEDIUM", "MODEL", "MFG_YEAR"], failure: "MECHGEN", cmRate: 0.5, life: [12, 18] },
  { id: "STAT", desc: "静止機器", parent: "MECH", useWith: ["ASSET"] },
  { id: "BOILER", desc: "ボイラ", parent: "STAT", useWith: ["ASSET"], specs: ["BOILER_TYPE", "STEAM_FLOW", "STEAM_PRESS", "STEAM_TEMP", "HEAT_AREA", "MODEL", "MFG_YEAR"], failure: "BOILER", cmRate: 1.0 },
  { id: "HEX", desc: "熱交換器", parent: "STAT", useWith: ["ASSET"], specs: ["HEX_TYPE", "HEAT_AREA", "DESIGN_PRESS", "DESIGN_TEMP", "MATERIAL", "MFG_YEAR"], failure: "HEATEX", cmRate: 0.2 },
  { id: "TANK", desc: "タンク・槽", parent: "STAT", useWith: ["ASSET"], specs: ["CAPACITY", "MATERIAL", "MFG_YEAR"], failure: "STATIC", cmRate: 0.05 },
  { id: "BAGF", desc: "ろ過式集じん器", parent: "STAT", useWith: ["ASSET"], specs: ["GAS_FLOW", "FILTER_AREA", "BAG_COUNT", "COMPARTMENTS", "MODEL", "MFG_YEAR"], failure: "BAGFLT", cmRate: 0.8 },
  { id: "FBAG", desc: "ろ布", parent: "STAT", useWith: ["ASSET"], specs: ["BAG_MATERIAL", "BAG_SIZE", "BAG_COUNT"], failure: "BAGFLT", cmRate: 0.2, life: [4, 6] },
  { id: "SCR", desc: "触媒反応塔", parent: "STAT", useWith: ["ASSET"], specs: ["GAS_FLOW", "CATALYST_VOLUME", "CATALYST_TYPE", "DESIGN_TEMP", "MFG_YEAR"], failure: "STATIC", cmRate: 0.1 },
  { id: "TOWER", desc: "塔（減温塔・洗煙塔）", parent: "STAT", useWith: ["ASSET"], specs: ["GAS_FLOW", "TOWER_DIA", "TOWER_HEIGHT", "MATERIAL", "MFG_YEAR"], failure: "STATIC", cmRate: 0.3 },
  { id: "STACK", desc: "煙突", parent: "STAT", useWith: ["ASSET"], specs: ["STACK_HEIGHT", "FLUE_COUNT", "MATERIAL", "MFG_YEAR"], failure: "STATIC", cmRate: 0.02 },
  { id: "SILO", desc: "サイロ・貯槽", parent: "STAT", useWith: ["ASSET"], specs: ["CAPACITY", "MATERIAL", "MFG_YEAR"], failure: "STATIC", cmRate: 0.15 },
  { id: "DAMPER", desc: "ダンパ", parent: "STAT", useWith: ["ASSET"], specs: ["DAMPER_TYPE", "SIZE_MM", "ACTUATOR", "MFG_YEAR"], failure: "VALVE", cmRate: 0.2 },
  { id: "REFR", desc: "耐火物", parent: "STAT", useWith: ["ASSET"], specs: ["REFR_MATERIAL", "REFR_AREA", "MFG_YEAR"], failure: "STATIC", cmRate: 0.3 },
  { id: "CTWR", desc: "冷却塔", parent: "STAT", useWith: ["ASSET"], specs: ["COOL_CAPACITY", "WATER_FLOW", "MODEL", "MFG_YEAR"], failure: "STATIC", cmRate: 0.2 },
  { id: "WTREAT", desc: "水処理装置", parent: "STAT", useWith: ["ASSET"], specs: ["TREAT_TYPE", "WATER_FLOW", "MODEL", "MFG_YEAR"], failure: "STATIC", cmRate: 0.4 },
  { id: "BURNER", desc: "バーナ", parent: "STAT", useWith: ["ASSET"], specs: ["BURNER_CAP", "FUEL", "MODEL", "MFG_YEAR"], failure: "MECHGEN", cmRate: 0.3 },
  { id: "DOOR", desc: "投入扉", parent: "STAT", useWith: ["ASSET"], specs: ["DOOR_TYPE", "DRIVE", "DOOR_SIZE", "MFG_YEAR"], failure: "MECHGEN", cmRate: 0.7 },
  { id: "WBRIDGE", desc: "計量機", parent: "STAT", useWith: ["ASSET"], specs: ["WEIGH_CAP", "PLATFORM", "MODEL", "MFG_YEAR"], failure: "MECHGEN", cmRate: 0.3, life: [15, 18] },
  { id: "HYDU", desc: "油圧ユニット", parent: "STAT", useWith: ["ASSET"], specs: ["TANK_CAP", "DISCH_PRESS", "MODEL", "MFG_YEAR"], failure: "MECHGEN", cmRate: 0.4 },
  { id: "AIRDRY", desc: "除湿乾燥機", parent: "STAT", useWith: ["ASSET"], specs: ["AIRFLOW", "MODEL", "MFG_YEAR"], failure: "MECHGEN", cmRate: 0.3, life: [10, 14] },
  { id: "VALVE", desc: "弁", parent: "MECH", useWith: ["ASSET"] },
  { id: "CVALVE", desc: "調節弁", parent: "VALVE", useWith: ["ASSET"], specs: ["VALVE_TYPE", "BORE", "PRESS_RATING", "CV_VALUE", "ACTUATOR", "MATERIAL", "MODEL"], failure: "VALVE", cmRate: 0.12, life: [18, 25] },
  { id: "MOV", desc: "電動弁", parent: "VALVE", useWith: ["ASSET"], specs: ["VALVE_TYPE", "BORE", "PRESS_RATING", "MATERIAL", "MODEL"], failure: "VALVE", cmRate: 0.1, life: [18, 25] },
  { id: "SAFV", desc: "安全弁", parent: "VALVE", useWith: ["ASSET"], specs: ["BORE", "SET_PRESS", "BLOW_CAPACITY", "MATERIAL", "MODEL"], failure: "VALVE", cmRate: 0.05 },
  { id: "ELEC", desc: "電気設備", parent: null, useWith: ["ASSET"] },
  { id: "MOTOR", desc: "電動機", parent: "ELEC", useWith: ["ASSET"], specs: ["RATED_POWER", "RATED_VOLTAGE", "RATED_CURRENT", "RATED_SPEED", "POLES", "FREQUENCY", "PROTECTION", "INSULATION", "FRAME_NO", "MODEL", "MFG_YEAR"], failure: "MOTOR", cmRate: 0.06, life: [16, 25] },
  { id: "INV", desc: "インバータ", parent: "ELEC", useWith: ["ASSET"], specs: ["RATED_KVA", "RATED_VOLTAGE", "MODEL", "MFG_YEAR"], failure: "ELECEQ", cmRate: 0.15, life: [9, 13] },
  { id: "TRANSF", desc: "変圧器", parent: "ELEC", useWith: ["ASSET"], specs: ["RATED_KVA", "PRIMARY_V", "SECONDARY_V", "COOLING", "MODEL", "MFG_YEAR"], failure: "ELECEQ", cmRate: 0.02 },
  { id: "BRKR", desc: "遮断器", parent: "ELEC", useWith: ["ASSET"], specs: ["BREAKER_TYPE", "RATED_VOLTAGE", "RATED_CURRENT", "BREAK_CURRENT", "MODEL", "MFG_YEAR"], failure: "ELECEQ", cmRate: 0.03, life: [20, 25] },
  { id: "SWGR", desc: "配電盤・コントロールセンタ", parent: "ELEC", useWith: ["ASSET"], specs: ["RATED_VOLTAGE", "PANEL_COUNT", "MODEL", "MFG_YEAR"], failure: "ELECEQ", cmRate: 0.1 },
  { id: "GEN", desc: "発電機", parent: "ELEC", useWith: ["ASSET"], specs: ["GEN_TYPE", "RATED_KVA", "RATED_VOLTAGE", "RATED_SPEED", "POWER_FACTOR", "MODEL", "MFG_YEAR"], failure: "ELECEQ", cmRate: 0.1, meters: ["POWERGEN"] },
  { id: "UPS", desc: "無停電電源・直流電源装置", parent: "ELEC", useWith: ["ASSET"], specs: ["RATED_KVA", "BACKUP_MIN", "BATTERY_TYPE", "MODEL", "MFG_YEAR"], failure: "ELECEQ", cmRate: 0.15, life: [9, 12] },
  { id: "EGEN", desc: "非常用発電設備", parent: "ELEC", useWith: ["ASSET"], specs: ["RATED_KVA", "ENGINE", "FUEL", "MODEL", "MFG_YEAR"], failure: "ELECEQ", cmRate: 0.2, meters: ["RUNHOURS", "STARTS"] },
  { id: "INST", desc: "計装設備", parent: null, useWith: ["ASSET"] },
  { id: "XMTR", desc: "伝送器", parent: "INST", useWith: ["ASSET"], specs: ["MEAS_TYPE", "MEAS_RANGE", "SIGNAL", "MODEL", "MFG_YEAR"], failure: "INSTR", cmRate: 0.07, life: [11, 16] },
  { id: "ANLZ", desc: "排ガス分析計", parent: "INST", useWith: ["ASSET"], specs: ["ANALYTE", "MEAS_METHOD", "MEAS_RANGE", "MODEL", "MFG_YEAR"], failure: "ANALYZ", cmRate: 1.0, life: [9, 12] },
  { id: "DCS", desc: "制御装置", parent: "INST", useWith: ["ASSET"], specs: ["DCS_ROLE", "MODEL", "MFG_YEAR"], failure: "CONTROL", cmRate: 0.2, life: [13, 13] },
  { id: "BLDG", desc: "建築設備", parent: null, useWith: ["ASSET"] },
  { id: "HVAC", desc: "空調設備", parent: "BLDG", useWith: ["ASSET"], specs: ["COOL_KW", "HEAT_KW", "REFRIGERANT", "MODEL", "MFG_YEAR"], failure: "BLDGEQ", cmRate: 0.3, life: [13, 16] },
  { id: "ELEV", desc: "昇降機", parent: "BLDG", useWith: ["ASSET"], specs: ["LOAD_KG", "SPEED_MMIN", "STOPS", "MODEL", "MFG_YEAR"], failure: "BLDGEQ", cmRate: 0.3 },
  // 場所の分類
  { id: "LOC", desc: "場所", parent: null, useWith: ["LOCATIONS"] },
  { id: "LOC-PLANT", desc: "施設", parent: "LOC", useWith: ["LOCATIONS"], specs: ["CAPACITY_TD", "LINES", "COMMISSIONED", "FURNACE_TYPE"] },
  { id: "LOC-SYSTEM", desc: "設備系統", parent: "LOC", useWith: ["LOCATIONS"] },
  { id: "LOC-LINE", desc: "炉系列", parent: "LOC", useWith: ["LOCATIONS"], specs: ["CAPACITY_TD"] },
  { id: "LOC-UNIT", desc: "装置", parent: "LOC", useWith: ["LOCATIONS"] },
  { id: "LOC-POS", desc: "機能位置", parent: "LOC", useWith: ["LOCATIONS"] },
  { id: "LOC-STORE", desc: "倉庫", parent: "LOC", useWith: ["LOCATIONS"] },
];

// ---------------------------------------------------------------------------
// メーター
// ---------------------------------------------------------------------------

export const METERS: Array<{ name: string; desc: string; type: "CONTINUOUS" | "GAUGE"; unit: string }> = [
  { name: "RUNHOURS", desc: "稼働時間", type: "CONTINUOUS", unit: "HOURS" },
  { name: "STARTS", desc: "起動回数", type: "CONTINUOUS", unit: "CYCLES" },
  { name: "CRANECYCLE", desc: "クレーン運転回数", type: "CONTINUOUS", unit: "CYCLES" },
  { name: "POWERGEN", desc: "発電電力量", type: "CONTINUOUS", unit: "MWH" },
  { name: "VIBRATION", desc: "軸受振動速度", type: "GAUGE", unit: "MM/S" },
];

// ---------------------------------------------------------------------------
// 故障コード（FAILURECODE / FAILURELIST）
// ---------------------------------------------------------------------------

export const FAILURE_CLASSES: Record<string, string> = {
  PUMP: "ポンプ", FAN: "送風機", COMPR: "圧縮機", CONVEY: "コンベヤ", CRANE: "クレーン", STOKER: "火格子・ストーカ",
  FEEDER: "供給装置", TURBINE: "蒸気タービン", BOILER: "ボイラ", HEATEX: "熱交換器", BAGFLT: "ろ過式集じん器",
  VALVE: "弁・ダンパ", MOTOR: "電動機", ELECEQ: "電気機器", INSTR: "計器", ANALYZ: "分析計", CONTROL: "制御装置",
  STATIC: "静止機器", MECHGEN: "一般機械", BLDGEQ: "建築設備",
};

export const PROBLEMS: Record<string, string> = {
  LEAK: "漏れ", VIB: "振動大", NOISE: "異音", LOWPERF: "性能低下", OVERHEAT: "温度上昇・過熱", NOSTART: "起動不能",
  TRIP: "トリップ・停止", JAM: "噛込み・停止", WEAR: "摩耗・焼損", BREAK: "破損・切断", MEANDER: "蛇行",
  MALFUNC: "動作不良", WIREDMG: "ワイヤロープ損傷", GRABDMG: "バケット損傷", STUCK: "固着・作動不良", CRACK: "亀裂",
  FALLASH: "落じん量増加", CLOG: "詰まり・閉塞", PRESSDROP: "差圧上昇", DRIFT: "指示異常", INSUL: "絶縁低下",
  DAMAGE: "損傷・焼損", ALARM: "警報発報", NOSIGNAL: "信号断",
};

export const CAUSES: Record<string, string> = {
  SEALWEAR: "軸封部・パッキンの摩耗", BRGDMG: "軸受の損傷", MISALIGN: "芯ずれ", ADHESION: "羽根車へのダスト付着",
  LOOSE: "締付け不良・緩み", CORROSION: "腐食・減肉", AGING: "経年劣化", LUBE: "潤滑不良", FOREIGN: "異物の噛込み",
  CAVIT: "キャビテーション", WEARIMP: "羽根車の摩耗", FOULED: "異物による閉塞", AIRLOCK: "エア噛み", OVERLOAD: "過負荷",
  ELECFAIL: "電気部品の故障", SEIZE: "固着", OPERR: "操作・運転の誤り", COOLFAIL: "冷却不良", LINKAGE: "リンク機構の不良",
  SENSOR: "検出器の故障", FILTERCLOG: "フィルタの目詰まり", VALVEWEAR: "弁の摩耗", ASHFIX: "灰の固着",
  HEATDMG: "熱による損傷", CLINKER: "クリンカの付着", HYDRAULIC: "油圧系の不良", GAPWIDE: "隙間の拡大",
  MOISTURE: "湿気による固結", BRIDGE: "ブリッジ", SCALE: "スケールの付着", EROSION: "摩耗減肉（エロージョン）",
  ACIDCORR: "低温腐食（酸露点腐食）", BLIND: "ろ布の目詰まり", PULSEFAIL: "払落し装置の不良", SEATDMG: "弁座の損傷",
  ACTFAIL: "駆動部の故障", CALOFF: "校正ずれ", WATER: "浸水・結露", DUST: "粉じんの堆積", IMPULSECLOG: "導圧管の詰まり",
  WIRING: "配線不良", PROBECLOG: "サンプリング系の詰まり", DRAINFAIL: "ドレン排出不良", SAMPLEPUMP: "サンプリングポンプの不良",
  SOFTWARE: "ソフトウェアの不具合", BATTERY: "蓄電池の劣化", RELAY: "保護継電器の誤動作", REFLEAK: "冷媒漏れ",
  UNKNOWN: "原因不明",
};

export const REMEDIES: Record<string, string> = {
  REPLACE: "部品交換", REPAIR: "補修", ADJUST: "調整", CLEAN: "清掃・除去", RETIGHTEN: "増締め", LUBRICATE: "給油・給脂",
  RENEW: "機器更新", RESET: "リセット・再起動", CALIB: "校正", TEMP: "応急処置", WELD: "溶接補修", NOACTION: "処置なし（経過観察）",
};

export const CAUSE_REMEDIES: Record<string, string[]> = {
  SEALWEAR: ["REPLACE", "ADJUST"], BRGDMG: ["REPLACE"], MISALIGN: ["ADJUST"], ADHESION: ["CLEAN", "REPAIR"],
  LOOSE: ["RETIGHTEN", "REPLACE"], CORROSION: ["REPAIR", "WELD", "REPLACE", "RENEW"], AGING: ["REPLACE", "RENEW", "REPAIR"],
  LUBE: ["LUBRICATE", "REPLACE"], FOREIGN: ["CLEAN", "REPAIR"], CAVIT: ["ADJUST", "REPAIR"], WEARIMP: ["REPLACE", "REPAIR"],
  FOULED: ["CLEAN"], AIRLOCK: ["ADJUST", "RESET"], OVERLOAD: ["ADJUST", "RESET", "REPLACE"], ELECFAIL: ["REPLACE", "RESET", "REPAIR"],
  SEIZE: ["REPAIR", "REPLACE", "LUBRICATE"], OPERR: ["RESET", "NOACTION"], COOLFAIL: ["CLEAN", "REPAIR"], LINKAGE: ["ADJUST", "REPAIR"],
  SENSOR: ["REPLACE", "CALIB"], FILTERCLOG: ["CLEAN", "REPLACE"], VALVEWEAR: ["REPLACE"], ASHFIX: ["CLEAN"],
  HEATDMG: ["REPLACE", "REPAIR", "WELD"], CLINKER: ["CLEAN"], HYDRAULIC: ["REPAIR", "REPLACE", "ADJUST"], GAPWIDE: ["ADJUST", "REPLACE"],
  MOISTURE: ["CLEAN", "ADJUST"], BRIDGE: ["CLEAN", "ADJUST"], SCALE: ["CLEAN"], EROSION: ["WELD", "REPLACE", "TEMP"],
  ACIDCORR: ["REPAIR", "REPLACE", "WELD"], BLIND: ["CLEAN", "REPLACE"], PULSEFAIL: ["REPLACE", "ADJUST"], SEATDMG: ["REPAIR", "REPLACE"],
  ACTFAIL: ["REPAIR", "REPLACE", "ADJUST"], CALOFF: ["CALIB", "ADJUST"], WATER: ["REPAIR", "CLEAN", "REPLACE"], DUST: ["CLEAN"],
  IMPULSECLOG: ["CLEAN"], WIRING: ["REPAIR", "REPLACE"], PROBECLOG: ["CLEAN", "REPLACE"], DRAINFAIL: ["CLEAN", "REPAIR"],
  SAMPLEPUMP: ["REPLACE", "REPAIR"], SOFTWARE: ["RESET", "REPAIR"], BATTERY: ["REPLACE"], RELAY: ["CALIB", "REPLACE", "RESET"],
  REFLEAK: ["REPAIR", "REPLACE"], UNKNOWN: ["NOACTION", "TEMP", "RESET"],
};

/** 故障クラス → 問題 → 原因 */
export const FAILURE_TREE: Record<string, Record<string, string[]>> = {
  PUMP: { LEAK: ["SEALWEAR", "LOOSE", "CORROSION", "AGING"], VIB: ["BRGDMG", "MISALIGN", "LOOSE", "CAVIT"], NOISE: ["BRGDMG", "FOREIGN", "LUBE", "CAVIT"], LOWPERF: ["WEARIMP", "FOULED", "AIRLOCK"], OVERHEAT: ["LUBE", "BRGDMG", "OVERLOAD"], NOSTART: ["ELECFAIL", "SEIZE", "OPERR"] },
  FAN: { VIB: ["ADHESION", "BRGDMG", "MISALIGN", "LOOSE"], NOISE: ["BRGDMG", "LUBE", "FOREIGN"], OVERHEAT: ["LUBE", "BRGDMG", "COOLFAIL"], LOWPERF: ["ADHESION", "LINKAGE", "CORROSION"], TRIP: ["ELECFAIL", "OVERLOAD", "SENSOR"] },
  COMPR: { LOWPERF: ["FILTERCLOG", "VALVEWEAR", "AGING"], OVERHEAT: ["COOLFAIL", "LUBE"], LEAK: ["SEALWEAR", "LOOSE", "AGING"], TRIP: ["ELECFAIL", "SENSOR", "OVERLOAD"], NOISE: ["BRGDMG", "LOOSE"] },
  CONVEY: { JAM: ["FOREIGN", "ASHFIX", "OVERLOAD"], WEAR: ["AGING", "FOREIGN", "ASHFIX"], BREAK: ["AGING", "OVERLOAD", "MISALIGN"], MEANDER: ["MISALIGN", "ASHFIX"], NOISE: ["BRGDMG", "LUBE"] },
  CRANE: { MALFUNC: ["ELECFAIL", "SENSOR", "OPERR"], WIREDMG: ["AGING", "OVERLOAD", "LUBE"], GRABDMG: ["OVERLOAD", "FOREIGN", "AGING"], LEAK: ["SEALWEAR", "LOOSE", "AGING"], TRIP: ["ELECFAIL", "OVERLOAD", "OPERR"], NOISE: ["BRGDMG", "LUBE"] },
  STOKER: { WEAR: ["HEATDMG", "AGING", "CLINKER"], STUCK: ["CLINKER", "FOREIGN", "HYDRAULIC"], CRACK: ["HEATDMG", "AGING"], FALLASH: ["GAPWIDE", "AGING"] },
  FEEDER: { CLOG: ["MOISTURE", "FOREIGN", "BRIDGE"], LOWPERF: ["AGING", "MOISTURE"], STUCK: ["FOREIGN", "HYDRAULIC", "ELECFAIL"], LEAK: ["SEALWEAR", "LOOSE"] },
  TURBINE: { VIB: ["SCALE", "BRGDMG", "MISALIGN"], TRIP: ["SENSOR", "ELECFAIL", "OPERR", "LUBE"], LEAK: ["SEALWEAR", "LOOSE", "AGING"], LOWPERF: ["SCALE", "AGING"], OVERHEAT: ["LUBE", "COOLFAIL"] },
  BOILER: { LEAK: ["CORROSION", "EROSION", "ACIDCORR", "HEATDMG"], CLOG: ["ASHFIX", "CLINKER"], CRACK: ["HEATDMG", "AGING"], LOWPERF: ["ASHFIX", "SCALE"] },
  HEATEX: { LEAK: ["CORROSION", "ACIDCORR", "LOOSE"], LOWPERF: ["SCALE", "ASHFIX"], CLOG: ["ASHFIX", "SCALE"] },
  BAGFLT: { PRESSDROP: ["BLIND", "MOISTURE", "PULSEFAIL"], BREAK: ["HEATDMG", "AGING", "ACIDCORR"], LEAK: ["CORROSION", "LOOSE", "ACIDCORR"], STUCK: ["ELECFAIL", "ASHFIX"] },
  VALVE: { LEAK: ["SEATDMG", "SEALWEAR", "CORROSION"], STUCK: ["FOREIGN", "SCALE", "ACTFAIL"], DRIFT: ["ACTFAIL", "SENSOR", "CALOFF"] },
  MOTOR: { OVERHEAT: ["OVERLOAD", "COOLFAIL", "BRGDMG"], INSUL: ["WATER", "AGING", "DUST"], VIB: ["BRGDMG", "MISALIGN", "LOOSE"], NOISE: ["BRGDMG", "LUBE"], NOSTART: ["ELECFAIL", "WATER"] },
  ELECEQ: { TRIP: ["ELECFAIL", "OVERLOAD", "RELAY"], INSUL: ["WATER", "DUST", "AGING"], OVERHEAT: ["LOOSE", "COOLFAIL", "OVERLOAD"], DAMAGE: ["OVERLOAD", "AGING", "ELECFAIL"], ALARM: ["BATTERY", "SENSOR", "ELECFAIL"] },
  INSTR: { DRIFT: ["CALOFF", "SENSOR", "IMPULSECLOG", "WATER"], NOSIGNAL: ["WIRING", "ELECFAIL", "WATER"], DAMAGE: ["HEATDMG", "CORROSION", "AGING"] },
  ANALYZ: { DRIFT: ["CALOFF", "SENSOR", "PROBECLOG"], NOSIGNAL: ["ELECFAIL", "WIRING"], ALARM: ["PROBECLOG", "DRAINFAIL", "SENSOR", "SAMPLEPUMP"] },
  CONTROL: { ALARM: ["ELECFAIL", "SOFTWARE", "AGING"], DAMAGE: ["AGING", "ELECFAIL", "COOLFAIL"], NOSIGNAL: ["WIRING", "ELECFAIL"] },
  STATIC: { LEAK: ["CORROSION", "ACIDCORR", "LOOSE", "AGING"], CRACK: ["HEATDMG", "AGING", "CORROSION"], DAMAGE: ["FOREIGN", "OPERR", "AGING"], CLOG: ["ASHFIX", "CLINKER", "SCALE"] },
  MECHGEN: { STUCK: ["FOREIGN", "HYDRAULIC", "LUBE"], LEAK: ["SEALWEAR", "LOOSE"], NOISE: ["BRGDMG", "LUBE", "LOOSE"], DAMAGE: ["OVERLOAD", "AGING", "OPERR"], WEAR: ["AGING", "FOREIGN"] },
  BLDGEQ: { MALFUNC: ["ELECFAIL", "SENSOR", "AGING"], NOISE: ["BRGDMG", "LOOSE"], LOWPERF: ["FILTERCLOG", "REFLEAK", "AGING"], LEAK: ["CORROSION", "AGING"] },
};

// ---------------------------------------------------------------------------
// 設備の構成（場所の階層と、機能位置に据える資産）
// ---------------------------------------------------------------------------

/** 子の資産（例 ポンプの電動機） */
export interface ChildDef {
  t: string;
  c: string;
  n: string;
  /** 電動機の出力（kW）の範囲 */
  kw?: [number, number];
}

export interface ItemDef {
  /** タグの種別（英大文字 1〜2 字） */
  t: string;
  /** 分類 */
  c: string;
  n: string;
  /** 台数（既定 1）。ab:true なら A・B… の号機、そうでなければ別の番号 */
  q?: number;
  ab?: boolean;
  /** 電動機を子に付ける（kW の範囲） */
  m?: [number, number];
  /** インバータも子に付ける */
  inv?: boolean;
  ch?: ChildDef[];
  /** 仕様の値（範囲・固定値・候補） */
  p?: Record<string, number | string | [number, number] | string[]>;
  /** 資産の重要度（ASSET.PRIORITY。1 が最重要） */
  pr?: number;
  /** この施設にだけある */
  only?: SiteCode[];
  /** 後から増設した年（施設ごと） */
  added?: Partial<Record<SiteCode, number>>;
}

export interface UnitDef {
  code: string;
  name: string;
  perLine: boolean;
  items: ItemDef[];
  /** 計器（例 "PT2 TT3"） */
  x?: string;
  /** 弁（例 "CV2 MV1"） */
  v?: string;
  only?: SiteCode[];
}

export interface SystemDef {
  code: string;
  /** タグ番号の帯（3 桁の先頭） */
  band: number;
  name: string;
  units: UnitDef[];
}

const CRANE_CHILDREN: ChildDef[] = [
  { t: "MH", c: "MOTOR", n: "巻上用電動機", kw: [75, 110] },
  { t: "MT", c: "MOTOR", n: "横行用電動機", kw: [3.7, 7.5] },
  { t: "MR", c: "MOTOR", n: "走行用電動機", kw: [7.5, 15] },
  { t: "BK", c: "GRAB", n: "グラブバケット" },
  { t: "IV", c: "INV", n: "巻上用インバータ" },
];

export const SYSTEMS: SystemDef[] = [
  {
    code: "10", band: 100, name: "受入・供給設備",
    units: [
      { code: "WB", name: "計量設備", perLine: false, items: [{ t: "WB", c: "WBRIDGE", n: "計量機", q: 2, ab: true }] },
      {
        code: "PF", name: "プラットホーム", perLine: false,
        items: [
          { t: "DR", c: "DOOR", n: "ごみ投入扉", q: 6 },
          { t: "HU", c: "HYDU", n: "投入扉油圧ユニット", q: 2, ab: true, m: [7.5, 11] },
          { t: "F", c: "FAN", n: "エアカーテン", q: 2, ab: true, m: [3.7, 5.5], p: { AIRFLOW: [150, 250] } },
        ],
      },
      {
        code: "PT", name: "ごみピット", perLine: false, x: "LT1",
        items: [
          { t: "T", c: "TANK", n: "ごみピット", p: { CAPACITY: [6000, 12000], MATERIAL: "RC" } },
          { t: "P", c: "PUMP", n: "ピット汚水ポンプ", q: 2, ab: true, m: [2.2, 5.5], p: { PUMP_TYPE: "水中", FLOW: [5, 15], HEAD: [15, 25] } },
          { t: "F", c: "FAN", n: "脱臭用送風機", m: [15, 22], p: { AIRFLOW: [300, 500] } },
        ],
      },
      { code: "CR", name: "ごみクレーン", perLine: false, items: [{ t: "CR", c: "CRANE", n: "ごみクレーン", q: 2, ab: true, ch: CRANE_CHILDREN, pr: 1 }] },
    ],
  },
  {
    code: "20", band: 200, name: "燃焼設備",
    units: [
      {
        code: "HP", name: "投入ホッパ・給じん装置", perLine: true, x: "LT1",
        items: [
          { t: "T", c: "TANK", n: "ごみ投入ホッパ", p: { CAPACITY: [30, 60], MATERIAL: "SS400" } },
          { t: "FD", c: "FEEDER", n: "給じん装置", p: { FEEDER_TYPE: "プッシャ式", CAPACITY_TH: [4, 5.5] }, pr: 1 },
        ],
      },
      {
        code: "ST", name: "ストーカ", perLine: true, x: "TT6 PT2",
        items: [
          { t: "GR", c: "GRATE", n: "乾燥火格子", p: { GRATE_AREA: [8, 12] }, pr: 1 },
          { t: "GR", c: "GRATE", n: "燃焼火格子", p: { GRATE_AREA: [12, 18] }, pr: 1 },
          { t: "GR", c: "GRATE", n: "後燃焼火格子", p: { GRATE_AREA: [6, 10] }, pr: 1 },
          { t: "RF", c: "REFR", n: "炉体耐火物" },
          { t: "D", c: "DAMPER", n: "火格子下空気ダンパ", q: 4, p: { DAMPER_TYPE: "バタフライ", SIZE_MM: [300, 500] } },
        ],
      },
      {
        code: "HY", name: "油圧装置", perLine: true, x: "PT2 TT1",
        items: [
          { t: "HU", c: "HYDU", n: "火格子油圧ユニット", p: { TANK_CAP: [1000, 2000], DISCH_PRESS: [14, 21] } },
          { t: "P", c: "PUMP", n: "油圧ポンプ", q: 2, ab: true, m: [22, 37], p: { PUMP_TYPE: "ギヤ", FLOW: [6, 12], HEAD: [1400, 2100] } },
          { t: "E", c: "HEX", n: "作動油冷却器", p: { HEX_TYPE: "プレート式", HEAT_AREA: [5, 15] } },
        ],
      },
      {
        code: "BN", name: "助燃装置", perLine: true, v: "MV2",
        items: [
          { t: "BN", c: "BURNER", n: "助燃バーナ" },
          { t: "BN", c: "BURNER", n: "再燃バーナ" },
          { t: "P", c: "PUMP", n: "燃料油ポンプ", q: 2, ab: true, m: [1.5, 2.2], p: { PUMP_TYPE: "ギヤ", FLOW: [0.5, 1.5], HEAD: [50, 80] } },
          { t: "F", c: "FAN", n: "バーナ用送風機", m: [7.5, 11], p: { AIRFLOW: [80, 150] } },
        ],
      },
    ],
  },
  {
    code: "30", band: 300, name: "燃焼ガス冷却設備",
    units: [
      {
        code: "BL", name: "ボイラ本体", perLine: true, x: "PT3 TT4 LT2 FT2", v: "CV3 MV2",
        items: [
          { t: "B", c: "BOILER", n: "ボイラ", pr: 1 },
          { t: "E", c: "HEX", n: "過熱器", p: { HEX_TYPE: "フィンチューブ", HEAT_AREA: [300, 600], DESIGN_PRESS: [4.0, 4.5], DESIGN_TEMP: [400, 450], MATERIAL: "STBA24" } },
          { t: "E", c: "HEX", n: "エコノマイザ", p: { HEX_TYPE: "フィンチューブ", HEAT_AREA: [500, 900], DESIGN_PRESS: [4.5, 5.0], DESIGN_TEMP: [250, 300], MATERIAL: "STB340" } },
          { t: "T", c: "TANK", n: "蒸気ドラム", p: { CAPACITY: [8, 15], MATERIAL: "SB410" } },
          { t: "SV", c: "SAFV", n: "安全弁", q: 3, p: { BORE: [50, 80] } },
        ],
      },
      { code: "SB", name: "スートブロワ", perLine: true, items: [{ t: "SB", c: "SOOTBL", n: "スートブロワ", q: 6, m: [0.4, 0.75] }] },
      { code: "BD", name: "ブロー装置", perLine: true, v: "CV1", items: [{ t: "T", c: "TANK", n: "連続ブロータンク", p: { CAPACITY: [0.5, 1.5] } }] },
    ],
  },
  {
    code: "40", band: 400, name: "排ガス処理設備",
    units: [
      {
        code: "GC", name: "減温塔", perLine: true, x: "TT2 PT1 FT1", v: "CV1",
        items: [
          { t: "TW", c: "TOWER", n: "減温塔" },
          { t: "P", c: "PUMP", n: "噴霧水ポンプ", q: 2, ab: true, m: [5.5, 11], p: { PUMP_TYPE: "多段タービン", FLOW: [3, 8], HEAD: [200, 300] } },
        ],
      },
      {
        code: "BF", name: "ろ過式集じん器", perLine: true, x: "DT2 TT2",
        items: [
          { t: "BF", c: "BAGF", n: "ろ過式集じん器", pr: 1 },
          { t: "FB", c: "FBAG", n: "ろ布", q: 6 },
          { t: "D", c: "DAMPER", n: "集じん器入口・出口ダンパ", q: 2, p: { DAMPER_TYPE: "ギロチン", SIZE_MM: [1200, 1600] } },
        ],
      },
      {
        code: "CH", name: "薬剤供給装置", perLine: true,
        items: [
          { t: "FD", c: "FEEDER", n: "消石灰定量供給装置", m: [1.5, 2.2], p: { FEEDER_TYPE: "テーブル式", CAPACITY_TH: [0.05, 0.2] } },
          { t: "FD", c: "FEEDER", n: "活性炭定量供給装置", m: [0.75, 1.5], p: { FEEDER_TYPE: "スクリュー式", CAPACITY_TH: [0.005, 0.02] } },
          { t: "F", c: "FAN", n: "薬剤搬送ブロワ", q: 2, ab: true, m: [7.5, 11], p: { AIRFLOW: [5, 15], STATIC_PRESS: [40, 60] } },
        ],
      },
      {
        code: "DN", name: "触媒脱硝装置", perLine: true, x: "TT2 FT1", v: "CV1",
        items: [
          { t: "RX", c: "SCR", n: "触媒反応塔", pr: 1 },
          { t: "E", c: "HEX", n: "排ガス再加熱器", p: { HEX_TYPE: "シェルアンドチューブ", HEAT_AREA: [200, 400], DESIGN_TEMP: [230, 260] } },
          { t: "P", c: "PUMP", n: "アンモニア水噴霧ポンプ", q: 2, ab: true, m: [0.75, 1.5], p: { PUMP_TYPE: "ダイヤフラム", FLOW: [0.02, 0.1], HEAD: [30, 60] } },
        ],
      },
      {
        code: "SC", name: "洗煙設備", perLine: true, only: ["KITA"], x: "PT1 LT1", v: "CV1",
        items: [
          { t: "TW", c: "TOWER", n: "洗煙塔", p: { MATERIAL: "FRP" } },
          { t: "P", c: "PUMP", n: "洗煙循環ポンプ", q: 2, ab: true, m: [30, 45], p: { FLOW: [150, 250], HEAD: [20, 30], MATERIAL: "SCS14" } },
          { t: "P", c: "PUMP", n: "苛性ソーダ注入ポンプ", q: 2, ab: true, m: [0.2, 0.4], p: { PUMP_TYPE: "ダイヤフラム", FLOW: [0.05, 0.2] } },
        ],
      },
    ],
  },
  {
    code: "50", band: 500, name: "通風設備",
    units: [
      {
        code: "FD", name: "押込送風系", perLine: true, x: "PT2 FT2 TT1",
        items: [
          { t: "F", c: "FAN", n: "押込送風機", m: [90, 160], inv: true, pr: 1, p: { AIRFLOW: [500, 800], STATIC_PRESS: [5, 7] } },
          { t: "F", c: "FAN", n: "二次送風機", m: [30, 55], inv: true, p: { AIRFLOW: [200, 350], STATIC_PRESS: [4, 6] } },
          { t: "E", c: "HEX", n: "蒸気式空気予熱器", p: { HEX_TYPE: "フィンチューブ", HEAT_AREA: [100, 300] } },
          { t: "D", c: "DAMPER", n: "燃焼空気ダンパ", q: 2, p: { DAMPER_TYPE: "ルーバ", SIZE_MM: [600, 1000] } },
        ],
      },
      {
        code: "ID", name: "誘引送風系", perLine: true, x: "PT2 TT1",
        items: [
          { t: "F", c: "FAN", n: "誘引送風機", m: [200, 315], inv: true, pr: 1, p: { AIRFLOW: [800, 1300], STATIC_PRESS: [6, 9], MATERIAL: "SS400" } },
          { t: "D", c: "DAMPER", n: "誘引送風機入口ダンパ", p: { DAMPER_TYPE: "ルーバ", SIZE_MM: [1200, 1600] } },
        ],
      },
      { code: "ST", name: "煙突", perLine: false, items: [{ t: "ST", c: "STACK", n: "煙突", p: { MATERIAL: "SUS316L（内筒）" } }] },
    ],
  },
  {
    code: "60", band: 600, name: "余熱利用設備",
    units: [
      {
        code: "TG", name: "蒸気タービン発電設備", perLine: false, x: "PT4 TT4 FT1", v: "CV2 MV2",
        items: [
          { t: "TB", c: "TURBINE", n: "蒸気タービン", pr: 1 },
          { t: "GB", c: "GEARBOX", n: "タービン減速機", p: { RATIO: [3, 5] } },
          { t: "G", c: "GEN", n: "発電機", pr: 1 },
          { t: "P", c: "PUMP", n: "潤滑油ポンプ", q: 2, ab: true, m: [5.5, 7.5], p: { PUMP_TYPE: "ギヤ", FLOW: [10, 20], HEAD: [30, 50] } },
          { t: "HU", c: "HYDU", n: "タービン制御油ユニット" },
        ],
      },
      {
        code: "CD", name: "復水設備", perLine: false, x: "LT2 PT1",
        items: [
          { t: "E", c: "HEX", n: "低圧蒸気復水器", p: { HEX_TYPE: "空冷式", HEAT_AREA: [3000, 6000] } },
          { t: "F", c: "FAN", n: "復水器ファン", q: 6, m: [30, 45], p: { AIRFLOW: [3000, 5000], STATIC_PRESS: [0.1, 0.3] } },
          { t: "P", c: "PUMP", n: "復水ポンプ", q: 2, ab: true, m: [11, 18.5], p: { FLOW: [20, 40], HEAD: [60, 90] } },
          { t: "T", c: "TANK", n: "復水タンク", p: { CAPACITY: [15, 30], MATERIAL: "SUS304" } },
        ],
      },
      {
        code: "CW", name: "機器冷却水設備", perLine: false, x: "TT2 FT1",
        items: [
          { t: "CT", c: "CTWR", n: "冷却塔" },
          { t: "F", c: "FAN", n: "冷却塔ファン", q: 2, ab: true, m: [11, 15] },
          { t: "P", c: "PUMP", n: "機器冷却水ポンプ", q: 2, ab: true, m: [15, 22], p: { FLOW: [80, 150], HEAD: [25, 35] } },
        ],
      },
      {
        code: "HS", name: "場外余熱供給設備", perLine: false, only: ["KITA", "MINAMI"], x: "TT2 FT1",
        items: [
          { t: "E", c: "HEX", n: "温水熱交換器", p: { HEX_TYPE: "プレート式", HEAT_AREA: [30, 80] } },
          { t: "P", c: "PUMP", n: "温水循環ポンプ", q: 2, ab: true, m: [7.5, 11], p: { FLOW: [40, 80], HEAD: [25, 40] } },
        ],
      },
    ],
  },
  {
    code: "65", band: 650, name: "給水設備",
    units: [
      {
        code: "FW", name: "ボイラ給水設備", perLine: false, x: "PT2 LT2 FT1", v: "CV2",
        items: [
          { t: "P", c: "PUMP", n: "ボイラ給水ポンプ", q: -1, ab: true, m: [90, 160], pr: 1, p: { PUMP_TYPE: "多段タービン", FLOW: [15, 25], HEAD: [450, 550], MATERIAL: "SCS1" } },
          { t: "T", c: "TANK", n: "脱気器", p: { CAPACITY: [15, 25], MATERIAL: "SB410" } },
          { t: "T", c: "TANK", n: "ボイラ給水タンク", p: { CAPACITY: [30, 60], MATERIAL: "SUS304" } },
        ],
      },
      {
        code: "WT", name: "純水装置", perLine: false,
        items: [
          { t: "WT", c: "WTREAT", n: "純水装置", p: { TREAT_TYPE: ["イオン交換", "逆浸透膜"], WATER_FLOW: [5, 10] } },
          { t: "P", c: "PUMP", n: "純水移送ポンプ", q: 2, ab: true, m: [3.7, 5.5], p: { FLOW: [5, 10], HEAD: [30, 40] } },
          { t: "T", c: "TANK", n: "純水タンク", p: { CAPACITY: [20, 40], MATERIAL: "SUS304" } },
        ],
      },
      {
        code: "CI", name: "ボイラ薬注装置", perLine: false,
        items: [
          { t: "P", c: "PUMP", n: "清缶剤注入ポンプ", q: 2, ab: true, m: [0.2, 0.4], p: { PUMP_TYPE: "ダイヤフラム", FLOW: [0.005, 0.02] } },
          { t: "P", c: "PUMP", n: "脱酸素剤注入ポンプ", q: 2, ab: true, m: [0.2, 0.4], p: { PUMP_TYPE: "ダイヤフラム", FLOW: [0.005, 0.02] } },
        ],
      },
    ],
  },
  {
    code: "70", band: 700, name: "灰出し設備",
    units: [
      {
        code: "AE", name: "主灰排出装置", perLine: true,
        items: [
          { t: "FD", c: "FEEDER", n: "灰押出装置", m: [3.7, 5.5], p: { FEEDER_TYPE: "プッシャ式", CAPACITY_TH: [0.5, 1.2] } },
          { t: "BC", c: "CONV", n: "落じんコンベヤ", m: [2.2, 3.7], p: { CONV_TYPE: "チェーン" } },
        ],
      },
      { code: "FA", name: "飛灰搬送装置", perLine: true, items: [{ t: "SC", c: "CONV", n: "集じん灰搬送コンベヤ", m: [2.2, 3.7], p: { CONV_TYPE: "スクリュー" } }] },
      {
        code: "AC", name: "灰搬送・灰ピット", perLine: false,
        items: [
          { t: "BC", c: "CONV", n: "灰搬送コンベヤ", q: 2, ab: true, m: [7.5, 11], p: { CONV_TYPE: "エプロン" } },
          { t: "T", c: "TANK", n: "灰ピット", p: { CAPACITY: [500, 1200], MATERIAL: "RC" } },
          { t: "CR", c: "CRANE", n: "灰クレーン", ch: CRANE_CHILDREN, p: { LIFT_CAPACITY: [3, 5] } },
        ],
      },
      {
        code: "FT", name: "飛灰処理設備", perLine: false, x: "LT1",
        items: [
          { t: "SL", c: "SILO", n: "飛灰貯槽", p: { CAPACITY: [80, 150] } },
          { t: "FD", c: "FEEDER", n: "飛灰定量切出装置", m: [1.5, 2.2], p: { FEEDER_TYPE: "ロータリー式", CAPACITY_TH: [0.3, 0.8] } },
          { t: "MX", c: "MIXER", n: "混練機", q: 2, ab: true, m: [22, 37], p: { CAPACITY: [0.5, 1.5] } },
          { t: "P", c: "PUMP", n: "キレート薬剤ポンプ", q: 2, ab: true, m: [0.75, 1.5], p: { PUMP_TYPE: "ダイヤフラム", FLOW: [0.02, 0.1] } },
        ],
      },
    ],
  },
  {
    code: "75", band: 750, name: "排水処理設備",
    units: [
      {
        code: "WW", name: "プラント排水処理設備", perLine: false, x: "LT2 AT2",
        items: [
          { t: "T", c: "TANK", n: "排水受槽", p: { CAPACITY: [30, 80], MATERIAL: "RC" } },
          { t: "P", c: "PUMP", n: "排水移送ポンプ", q: 2, ab: true, m: [3.7, 5.5], p: { PUMP_TYPE: "水中", FLOW: [5, 15], HEAD: [15, 25] } },
          { t: "T", c: "TANK", n: "凝集沈殿槽", p: { CAPACITY: [20, 50], MATERIAL: "SS400" } },
          { t: "AG", c: "MIXER", n: "凝集槽撹拌機", q: 2, m: [0.75, 1.5] },
          { t: "WT", c: "WTREAT", n: "砂ろ過器", p: { TREAT_TYPE: "砂ろ過", WATER_FLOW: [5, 15] } },
          { t: "P", c: "PUMP", n: "排水薬注ポンプ", q: 4, m: [0.2, 0.4], p: { PUMP_TYPE: "ダイヤフラム", FLOW: [0.005, 0.03] } },
          { t: "P", c: "PUMP", n: "再利用水ポンプ", q: 2, ab: true, m: [5.5, 7.5], p: { FLOW: [10, 20], HEAD: [30, 45] } },
        ],
      },
    ],
  },
  {
    code: "80", band: 800, name: "電気設備",
    units: [
      {
        code: "RC", name: "受変電設備", perLine: false,
        items: [
          { t: "CB", c: "BRKR", n: "受電遮断器", pr: 1 },
          { t: "TR", c: "TRANSF", n: "主変圧器", pr: 1, p: { COOLING: "油入自冷式" } },
          { t: "CB", c: "BRKR", n: "高圧遮断器", q: 8 },
          { t: "SW", c: "SWGR", n: "高圧配電盤", p: { RATED_VOLTAGE: 6600, PANEL_COUNT: [10, 16] } },
        ],
      },
      {
        code: "LV", name: "低圧動力設備", perLine: false,
        items: [
          { t: "TR", c: "TRANSF", n: "動力変圧器", q: 3, p: { COOLING: "モールド式", RATED_KVA: [750, 1500] } },
          { t: "SW", c: "SWGR", n: "コントロールセンタ", q: 10, p: { RATED_VOLTAGE: 400, PANEL_COUNT: [4, 10] } },
        ],
      },
      {
        code: "EG", name: "非常用電源設備", perLine: false,
        items: [
          { t: "EG", c: "EGEN", n: "非常用発電機", pr: 1, p: { RATED_KVA: [500, 1000] } },
          { t: "UP", c: "UPS", n: "無停電電源装置", p: { RATED_KVA: [30, 75] } },
          { t: "UP", c: "UPS", n: "直流電源装置", p: { RATED_KVA: [10, 30], BATTERY_TYPE: ["制御弁式鉛蓄電池", "アルカリ蓄電池"] } },
        ],
      },
      { code: "GS", name: "発電機連系設備", perLine: false, items: [{ t: "CB", c: "BRKR", n: "発電機遮断器", pr: 1 }] },
    ],
  },
  {
    code: "85", band: 850, name: "計装設備",
    units: [
      {
        code: "DC", name: "中央制御設備", perLine: false,
        items: [
          { t: "DC", c: "DCS", n: "DCSコントローラ", q: -1, p: { DCS_ROLE: "コントローラ" }, pr: 1 },
          { t: "DC", c: "DCS", n: "オペレータステーション", q: 4, p: { DCS_ROLE: "オペレータステーション" } },
          { t: "DC", c: "DCS", n: "エンジニアリングステーション", p: { DCS_ROLE: "エンジニアリングステーション" } },
          { t: "DC", c: "DCS", n: "情報管理サーバ", p: { DCS_ROLE: "サーバ" } },
        ],
      },
      {
        code: "EM", name: "排ガス分析設備", perLine: true,
        items: [
          { t: "AN", c: "ANLZ", n: "NOx計", p: { ANALYTE: "NOx", MEAS_METHOD: "化学発光方式", MEAS_RANGE: "0-200ppm" } },
          { t: "AN", c: "ANLZ", n: "SOx計", p: { ANALYTE: "SOx", MEAS_METHOD: "赤外線吸収方式", MEAS_RANGE: "0-200ppm" } },
          { t: "AN", c: "ANLZ", n: "HCl計", p: { ANALYTE: "HCl", MEAS_METHOD: "イオン電極方式", MEAS_RANGE: "0-500ppm" } },
          { t: "AN", c: "ANLZ", n: "CO計", p: { ANALYTE: "CO", MEAS_METHOD: "赤外線吸収方式", MEAS_RANGE: "0-200ppm" } },
          { t: "AN", c: "ANLZ", n: "O2計", p: { ANALYTE: "O2", MEAS_METHOD: "ジルコニア方式", MEAS_RANGE: "0-25%" } },
          { t: "AN", c: "ANLZ", n: "ばいじん計", p: { ANALYTE: "ばいじん", MEAS_METHOD: "光散乱方式", MEAS_RANGE: "0-50mg/m3N" } },
          { t: "AN", c: "ANLZ", n: "水銀計", p: { ANALYTE: "Hg", MEAS_METHOD: "還元気化原子吸光方式", MEAS_RANGE: "0-100μg/m3N" }, added: { KITA: 2018 } },
        ],
      },
    ],
  },
  {
    code: "90", band: 900, name: "建築・ユーティリティ設備",
    units: [
      {
        code: "AR", name: "圧縮空気設備", perLine: false, x: "PT2",
        items: [
          { t: "C", c: "COMP", n: "空気圧縮機", q: 3, ab: true, m: [37, 55], p: { AIRFLOW: [5, 9] } },
          { t: "AD", c: "AIRDRY", n: "除湿乾燥機", q: 2, ab: true, p: { AIRFLOW: [5, 10] } },
          { t: "T", c: "TANK", n: "空気槽", q: 2, ab: true, p: { CAPACITY: [3, 6] } },
        ],
      },
      {
        code: "HV", name: "空調換気設備", perLine: false,
        items: [
          { t: "AC", c: "HVAC", n: "中央制御室空調機", q: 2, ab: true },
          { t: "AC", c: "HVAC", n: "電気室空調機", q: 4 },
          { t: "F", c: "FAN", n: "換気送風機", q: 8, m: [1.5, 7.5], p: { AIRFLOW: [100, 400], STATIC_PRESS: [0.2, 0.6] } },
        ],
      },
      {
        code: "FP", name: "消防設備", perLine: false,
        items: [
          { t: "P", c: "PUMP", n: "消火ポンプ", m: [30, 37], p: { FLOW: [60, 90], HEAD: [70, 90] } },
          { t: "P", c: "PUMP", n: "補助加圧ポンプ", m: [1.5, 2.2], p: { FLOW: [2, 5], HEAD: [70, 90] } },
          { t: "T", c: "TANK", n: "消火水槽", p: { CAPACITY: [40, 80], MATERIAL: "RC" } },
        ],
      },
      {
        code: "EV", name: "昇降機設備", perLine: false,
        items: [
          { t: "EV", c: "ELEV", n: "乗用エレベータ" },
          { t: "EV", c: "ELEV", n: "人荷用エレベータ", p: { LOAD_KG: [1500, 2000] } },
        ],
      },
      {
        code: "WS", name: "給排水設備", perLine: false,
        items: [
          { t: "P", c: "PUMP", n: "上水ポンプ", q: 2, ab: true, m: [3.7, 5.5], p: { FLOW: [5, 15], HEAD: [40, 60] } },
          { t: "P", c: "PUMP", n: "プラント用水ポンプ", q: 2, ab: true, m: [7.5, 11], p: { FLOW: [20, 40], HEAD: [40, 60] } },
          { t: "T", c: "TANK", n: "プラント用水受水槽", p: { CAPACITY: [100, 200], MATERIAL: "RC" } },
        ],
      },
    ],
  },
];

/** 計器のタグ種別 → 名前・測定種別・測定範囲の候補 */
export const INSTRUMENTS: Record<string, { n: string; type: string; ranges: string[] }> = {
  PT: { n: "圧力伝送器", type: "圧力", ranges: ["0-1MPa", "0-2.5MPa", "0-5MPa", "-5-5kPa", "0-10kPa"] },
  TT: { n: "温度伝送器", type: "温度", ranges: ["0-200℃", "0-500℃", "0-1200℃"] },
  FT: { n: "流量伝送器", type: "流量", ranges: ["0-30m3/h", "0-50t/h", "0-60000m3N/h"] },
  LT: { n: "レベル伝送器", type: "レベル", ranges: ["0-2000mm", "0-5000mm", "0-30m"] },
  DT: { n: "差圧伝送器", type: "差圧", ranges: ["0-3kPa", "0-5kPa"] },
  AT: { n: "pH計", type: "pH", ranges: ["pH0-14"] },
};

export const VALVES: Record<string, { n: string; c: string }> = {
  CV: { n: "調節弁", c: "CVALVE" },
  MV: { n: "電動弁", c: "MOV" },
};

// ---------------------------------------------------------------------------
// 保全計画（JOBPLAN と PM）
// ---------------------------------------------------------------------------

export interface PmProgram {
  jp: string;
  desc: string;
  /** 対象の分類（資産）。"LOC-UNIT" などは場所 */
  cls: string[];
  freq: number;
  unit: "MONTHS" | "YEARS";
  worktype: "PM" | "INSP" | "CAL";
  /** 作業時間（h） */
  dur: number;
  crew: number;
  craft: string;
  tasks: string[];
  /** 法定点検 */
  law?: boolean;
  /** 対象を絞る（電動機の出力など） */
  minKw?: number;
  /** 重要度 1 の資産だけ */
  critical?: boolean;
  /** 外注（業者が作業する） */
  contractor?: boolean;
  /** 部品（品目のキー, 数量） */
  materials?: Array<[string, number]>;
  /** 炉の定期整備の子として作る（単独の PM は作らない） */
  overhaulOnly?: boolean;
}

export const PM_PROGRAMS: PmProgram[] = [
  { jp: "JP-PUMP-3M", desc: "ポンプ 定期点検（3か月）", cls: ["PUMP"], freq: 3, unit: "MONTHS", worktype: "PM", dur: 1.5, crew: 1, craft: "MECH", tasks: ["運転状態の確認（振動・異音・温度）", "軸封部の漏れ確認", "潤滑油の量・汚れの確認と補給", "基礎ボルトの緩み確認"], materials: [["GREASE", 1]] },
  { jp: "JP-PUMP-OH", desc: "ポンプ 分解整備", cls: ["PUMP"], freq: 4, unit: "YEARS", worktype: "PM", dur: 16, crew: 2, craft: "MECH", critical: true, contractor: true, tasks: ["分解", "羽根車・ケーシングの摩耗点検", "軸受の交換", "メカニカルシールの交換", "組立・芯出し", "試運転"], materials: [["BEARING", 2], ["MSEAL", 1], ["GASKET", 2]] },
  { jp: "JP-FAN-6M", desc: "送風機 定期点検（6か月）", cls: ["FAN"], freq: 6, unit: "MONTHS", worktype: "PM", dur: 3, crew: 2, craft: "MECH", tasks: ["振動測定", "軸受温度の確認", "Vベルト・カップリングの点検", "給脂"], materials: [["GREASE", 1]] },
  { jp: "JP-FAN-OH", desc: "送風機 開放点検・羽根車清掃", cls: ["FAN"], freq: 1, unit: "YEARS", worktype: "PM", dur: 12, crew: 3, craft: "MECH", critical: true, overhaulOnly: true, tasks: ["ケーシング開放", "羽根車のダスト除去・摩耗点検", "軸受の点検", "動バランス確認", "復旧・試運転"], materials: [["BEARING", 2]] },
  { jp: "JP-MOTOR-1Y", desc: "電動機 絶縁抵抗測定・点検", cls: ["MOTOR"], freq: 1, unit: "YEARS", worktype: "PM", dur: 1, crew: 1, craft: "ELEC", minKw: 5.5, tasks: ["絶縁抵抗の測定", "端子部の締付け確認", "運転電流の確認"] },
  { jp: "JP-COMP-3M", desc: "空気圧縮機 定期点検（3か月）", cls: ["COMP"], freq: 3, unit: "MONTHS", worktype: "PM", dur: 2, crew: 1, craft: "MECH", tasks: ["吸込フィルタの清掃", "ドレン排出の確認", "吐出温度・圧力の確認"], materials: [["AIRFILTER", 1]] },
  { jp: "JP-COMP-OH", desc: "空気圧縮機 オーバーホール", cls: ["COMP"], freq: 3, unit: "YEARS", worktype: "PM", dur: 16, crew: 2, craft: "MECH", contractor: true, tasks: ["本体の分解点検", "軸受・シールの交換", "冷却器の清掃", "試運転"], materials: [["BEARING", 2], ["OILCOMP", 1]] },
  { jp: "JP-CONV-3M", desc: "コンベヤ 定期点検（3か月）", cls: ["CONV"], freq: 3, unit: "MONTHS", worktype: "PM", dur: 2, crew: 2, craft: "MECH", tasks: ["チェーン・ベルトの張り確認", "ローラ・スプロケットの摩耗点検", "給油"], materials: [["GREASE", 1]] },
  { jp: "JP-CRANE-1M", desc: "【法定】クレーン 月例自主検査", cls: ["CRANE"], freq: 1, unit: "MONTHS", worktype: "INSP", dur: 3, crew: 2, craft: "MECH", law: true, tasks: ["巻過防止装置・ブレーキの作動確認", "ワイヤロープの損傷確認", "バケットの点検", "記録の作成"] },
  { jp: "JP-CRANE-1Y", desc: "【法定】クレーン 年次自主検査", cls: ["CRANE"], freq: 1, unit: "YEARS", worktype: "INSP", dur: 24, crew: 3, craft: "MECH", law: true, contractor: true, tasks: ["構造部分の点検", "荷重試験", "電気設備の点検", "ワイヤロープの交換判定", "検査記録の作成"], materials: [["WIREROPE", 1]] },
  { jp: "JP-GRAB-OH", desc: "グラブバケット 整備", cls: ["GRAB"], freq: 2, unit: "YEARS", worktype: "PM", dur: 24, crew: 2, craft: "MECH", contractor: true, tasks: ["爪の肉盛溶接", "油圧シリンダのパッキン交換", "作動確認"] },
  { jp: "JP-BOILER-1Y", desc: "【法定】ボイラ 性能検査", cls: ["BOILER"], freq: 1, unit: "YEARS", worktype: "INSP", dur: 80, crew: 4, craft: "MECH", law: true, contractor: true, tasks: ["ボイラ内部の清掃", "水管の肉厚測定", "安全弁の調整", "所轄の検査の受検"] },
  { jp: "JP-SAFV-1Y", desc: "【法定】安全弁 吹出し試験", cls: ["SAFV"], freq: 1, unit: "YEARS", worktype: "INSP", dur: 3, crew: 2, craft: "MECH", law: true, tasks: ["吹出し圧力の確認", "吹止まり圧力の確認", "記録の作成"] },
  { jp: "JP-BAGF-6M", desc: "ろ過式集じん器 定期点検", cls: ["BAGF"], freq: 6, unit: "MONTHS", worktype: "PM", dur: 6, crew: 2, craft: "MECH", tasks: ["差圧の推移確認", "払落し装置（パルス弁）の作動確認", "ホッパの灰付着確認", "ろ布の目視点検"] },
  { jp: "JP-FBAG-1Y", desc: "ろ布 抜取り検査", cls: ["FBAG"], freq: 1, unit: "YEARS", worktype: "INSP", dur: 3, crew: 2, craft: "MECH", overhaulOnly: true, tasks: ["ろ布の抜取り", "強度・通気度の試験依頼", "結果の記録"] },
  { jp: "JP-SCR-1Y", desc: "触媒 性能確認（抜取り分析）", cls: ["SCR"], freq: 1, unit: "YEARS", worktype: "INSP", dur: 8, crew: 2, craft: "MECH", overhaulOnly: true, contractor: true, tasks: ["触媒の抜取り", "脱硝性能の分析依頼", "触媒層の差圧確認"] },
  { jp: "JP-GRATE-OH", desc: "火格子 点検・火格子片交換", cls: ["GRATE"], freq: 1, unit: "YEARS", worktype: "PM", dur: 40, crew: 4, craft: "MECH", overhaulOnly: true, contractor: true, tasks: ["火格子片の摩耗測定", "損耗した火格子片の交換", "駆動部の点検", "作動確認"], materials: [["GRATEBAR", 40]] },
  { jp: "JP-REFR-OH", desc: "炉体耐火物 点検・補修", cls: ["REFR"], freq: 1, unit: "YEARS", worktype: "PM", dur: 60, crew: 4, craft: "MECH", overhaulOnly: true, contractor: true, tasks: ["耐火物の目視点検", "クリンカの除去", "損耗部の部分補修"], materials: [["REFRACT", 2]] },
  { jp: "JP-FEEDER-6M", desc: "供給装置 定期点検", cls: ["FEEDER"], freq: 6, unit: "MONTHS", worktype: "PM", dur: 3, crew: 2, craft: "MECH", tasks: ["駆動部の点検", "摺動部の摩耗確認", "給油"], materials: [["GREASE", 1]] },
  { jp: "JP-DAMPER-OH", desc: "ダンパ 作動点検", cls: ["DAMPER"], freq: 1, unit: "YEARS", worktype: "PM", dur: 3, crew: 2, craft: "MECH", overhaulOnly: true, tasks: ["全開・全閉の作動確認", "軸封部の点検", "開度指示の確認"] },
  { jp: "JP-SB-3M", desc: "スートブロワ 定期点検", cls: ["SOOTBL"], freq: 3, unit: "MONTHS", worktype: "PM", dur: 1, crew: 1, craft: "MECH", tasks: ["作動確認", "ランスチューブの曲がり確認", "給脂"] },
  { jp: "JP-HEX-2Y", desc: "熱交換器 開放清掃", cls: ["HEX"], freq: 2, unit: "YEARS", worktype: "PM", dur: 16, crew: 3, craft: "MECH", overhaulOnly: true, tasks: ["開放", "伝熱管の清掃", "肉厚測定", "復旧・漏れ確認"], materials: [["GASKET", 4]] },
  { jp: "JP-TURB-1Y", desc: "蒸気タービン 年次点検", cls: ["TURBINE"], freq: 1, unit: "YEARS", worktype: "PM", dur: 40, crew: 3, craft: "MECH", contractor: true, tasks: ["軸受の点検", "非常調速装置の作動試験", "潤滑油の分析", "制御油系統の点検"], materials: [["OILTURB", 1]] },
  { jp: "JP-TURB-4Y", desc: "【法定】蒸気タービン 定期事業者検査（開放点検）", cls: ["TURBINE"], freq: 4, unit: "YEARS", worktype: "INSP", dur: 320, crew: 6, craft: "MECH", law: true, contractor: true, tasks: ["車室の開放", "動翼・静翼の点検", "軸受の点検・交換", "組立・試運転", "検査記録の作成"] },
  { jp: "JP-GEN-1Y", desc: "発電機 年次点検", cls: ["GEN"], freq: 1, unit: "YEARS", worktype: "PM", dur: 16, crew: 2, craft: "ELEC", contractor: true, tasks: ["絶縁抵抗の測定", "励磁装置の点検", "保護継電器の試験"] },
  { jp: "JP-ELEC-1Y", desc: "【法定】受変電設備 年次点検", cls: ["TRANSF", "BRKR", "SWGR"], freq: 1, unit: "YEARS", worktype: "INSP", dur: 4, crew: 2, craft: "ELEC", law: true, contractor: true, tasks: ["停電作業の手配", "絶縁抵抗の測定", "保護継電器の試験", "端子の締付け確認", "清掃"] },
  { jp: "JP-SUBST-1M", desc: "【法定】受変電設備 月次点検", cls: ["LOC:80-RC"], freq: 1, unit: "MONTHS", worktype: "INSP", dur: 2, crew: 1, craft: "ELEC", law: true, tasks: ["外観点検", "異音・異臭の確認", "電圧・電流の記録"] },
  { jp: "JP-INV-1Y", desc: "インバータ 点検", cls: ["INV", "UPS"], freq: 1, unit: "YEARS", worktype: "PM", dur: 2, crew: 1, craft: "ELEC", tasks: ["冷却ファンの点検", "コンデンサの容量確認", "清掃"] },
  { jp: "JP-EGEN-1M", desc: "非常用発電機 無負荷試運転", cls: ["EGEN"], freq: 1, unit: "MONTHS", worktype: "PM", dur: 1, crew: 1, craft: "ELEC", tasks: ["始動試験", "電圧・周波数の確認", "燃料・冷却水の確認"] },
  { jp: "JP-EGEN-1Y", desc: "【法定】非常用発電機 負荷試験・点検", cls: ["EGEN"], freq: 1, unit: "YEARS", worktype: "INSP", dur: 6, crew: 2, craft: "ELEC", law: true, contractor: true, tasks: ["負荷運転試験", "機関の点検", "蓄電池の点検"] },
  { jp: "JP-XMTR-1Y", desc: "伝送器 校正", cls: ["XMTR"], freq: 1, unit: "YEARS", worktype: "CAL", dur: 1.5, crew: 1, craft: "INST", tasks: ["ゼロ・スパンの確認", "必要に応じて調整", "校正記録の作成"] },
  { jp: "JP-ANLZ-1M", desc: "排ガス分析計 校正", cls: ["ANLZ"], freq: 1, unit: "MONTHS", worktype: "CAL", dur: 2, crew: 1, craft: "INST", tasks: ["ゼロガス・スパンガスによる校正", "サンプリング系の点検", "記録の作成"], materials: [["CALGAS", 1]] },
  { jp: "JP-ANLZ-1Y", desc: "排ガス分析計 定期点検", cls: ["ANLZ"], freq: 1, unit: "YEARS", worktype: "PM", dur: 8, crew: 1, craft: "INST", contractor: true, tasks: ["消耗品の交換", "検出器の点検", "直線性の確認"] },
  { jp: "JP-DCS-1Y", desc: "制御装置 年次点検", cls: ["DCS"], freq: 1, unit: "YEARS", worktype: "PM", dur: 6, crew: 1, craft: "INST", contractor: true, tasks: ["自己診断履歴の確認", "冷却ファン・フィルタの清掃", "二重化の切替試験"] },
  { jp: "JP-HVAC-6M", desc: "空調機 フィルタ清掃・点検", cls: ["HVAC"], freq: 6, unit: "MONTHS", worktype: "PM", dur: 2, crew: 1, craft: "CIVIL", tasks: ["フィルタの清掃", "冷媒圧力の確認", "ドレンパンの清掃"] },
  { jp: "JP-ELEV-1M", desc: "昇降機 保守点検", cls: ["ELEV"], freq: 1, unit: "MONTHS", worktype: "PM", dur: 2, crew: 1, craft: "CIVIL", contractor: true, tasks: ["巻上機・制御盤の点検", "ブレーキの確認", "かご内の確認"] },
  { jp: "JP-ELEV-1Y", desc: "【法定】昇降機 定期検査", cls: ["ELEV"], freq: 1, unit: "YEARS", worktype: "INSP", dur: 4, crew: 1, craft: "CIVIL", law: true, contractor: true, tasks: ["定期検査", "検査報告書の作成"] },
  { jp: "JP-FIRE-6M", desc: "【法定】消防用設備 点検", cls: ["LOC:90-FP"], freq: 6, unit: "MONTHS", worktype: "INSP", dur: 6, crew: 2, craft: "CIVIL", law: true, contractor: true, tasks: ["消火ポンプの起動試験", "消火栓の点検", "自動火災報知設備の作動確認", "点検結果報告書の作成"] },
  { jp: "JP-WB-2Y", desc: "【法定】計量機 定期検査", cls: ["WBRIDGE"], freq: 2, unit: "YEARS", worktype: "INSP", dur: 4, crew: 1, craft: "MECH", law: true, contractor: true, tasks: ["分銅による器差の確認", "検査の受検"] },
  { jp: "JP-DOOR-6M", desc: "ごみ投入扉 定期点検", cls: ["DOOR"], freq: 6, unit: "MONTHS", worktype: "PM", dur: 2, crew: 2, craft: "MECH", tasks: ["開閉の作動確認", "ヒンジ・シール材の点検", "油圧シリンダの漏れ確認"] },
  { jp: "JP-HYDU-6M", desc: "油圧ユニット 定期点検", cls: ["HYDU"], freq: 6, unit: "MONTHS", worktype: "PM", dur: 2, crew: 1, craft: "MECH", tasks: ["作動油の汚れ・量の確認", "フィルタエレメントの点検", "吐出圧力の確認"], materials: [["HYDFILTER", 1]] },
  { jp: "JP-CTWR-6M", desc: "冷却塔 清掃・点検", cls: ["CTWR"], freq: 6, unit: "MONTHS", worktype: "PM", dur: 4, crew: 2, craft: "MECH", tasks: ["散水装置の清掃", "充填材の点検", "水質の確認"] },
  { jp: "JP-VALVE-2Y", desc: "調節弁・電動弁 作動点検", cls: ["CVALVE", "MOV"], freq: 2, unit: "YEARS", worktype: "PM", dur: 2, crew: 1, craft: "INST", tasks: ["全開・全閉の作動確認", "開度指示とポジショナの確認", "グランド部の漏れ確認"] },
  { jp: "JP-GEARBOX-1Y", desc: "減速機 潤滑油交換・点検", cls: ["GEARBOX"], freq: 1, unit: "YEARS", worktype: "PM", dur: 3, crew: 2, craft: "MECH", tasks: ["潤滑油の交換", "歯面の点検", "振動測定"], materials: [["OILGEAR", 1]] },
  { jp: "JP-MIXER-6M", desc: "撹拌機・混練機 定期点検", cls: ["MIXER"], freq: 6, unit: "MONTHS", worktype: "PM", dur: 2, crew: 1, craft: "MECH", tasks: ["パドル・羽根の摩耗確認", "軸封部の点検", "給脂"], materials: [["GREASE", 1]] },
  { jp: "JP-WTREAT-3M", desc: "水処理装置 定期点検", cls: ["WTREAT"], freq: 3, unit: "MONTHS", worktype: "PM", dur: 2, crew: 1, craft: "MECH", tasks: ["処理水質の確認", "ろ材・樹脂の状態確認", "薬品の補充"] },
  { jp: "JP-AIRDRY-6M", desc: "除湿乾燥機 定期点検", cls: ["AIRDRY"], freq: 6, unit: "MONTHS", worktype: "PM", dur: 1, crew: 1, craft: "MECH", tasks: ["露点の確認", "フィルタの清掃", "ドレントラップの点検"] },
  { jp: "JP-UNIT-1M", desc: "装置 月例点検", cls: ["LOC-UNIT"], freq: 1, unit: "MONTHS", worktype: "INSP", dur: 2, crew: 1, craft: "OPER", tasks: ["機器の外観点検", "漏れ・異音・異臭の確認", "計器の指示値の記録", "点検表の作成"] },
  { jp: "JP-LINE-OH", desc: "炉 定期整備（全停止）", cls: ["LOC-LINE"], freq: 6, unit: "MONTHS", worktype: "PM", dur: 240, crew: 8, craft: "MECH", contractor: true, tasks: ["炉の停止・冷却", "炉内・煙道の清掃", "各機器の点検整備", "立上げ・試運転"] },
];

/** 炉の定期整備の子 WO にする分類（そのラインの資産） */
export const OVERHAUL_CLASSES = ["GRATE", "REFR", "FEEDER", "FAN", "DAMPER", "HEX", "BAGF", "FBAG", "SCR", "SOOTBL", "TOWER", "BOILER"];

// ---------------------------------------------------------------------------
// 部品（ITEM）
// ---------------------------------------------------------------------------

export interface ItemTemplate {
  key: string;
  /** 品目番号の接頭辞 */
  prefix: string;
  desc: string;
  sizes: string[];
  unit: string;
  commodity: string;
  /** 単価（円）の範囲 */
  cost: [number, number];
}

export const ITEM_TEMPLATES: ItemTemplate[] = [
  { key: "BEARING", prefix: "BRG", desc: "玉軸受", sizes: ["6204ZZ", "6205ZZ", "6206ZZ", "6207ZZ", "6208ZZ", "6209ZZ", "6210ZZ", "6211ZZ", "6212ZZ", "6305ZZ", "6306ZZ", "6307ZZ", "6308ZZ", "6309ZZ", "6310ZZ", "6311ZZ", "6312ZZ", "6313ZZ", "6314ZZ", "6316C3"], unit: "EA", commodity: "MECH", cost: [1500, 30000] },
  { key: "BEARING", prefix: "BRR", desc: "自動調心ころ軸受", sizes: ["22210", "22212", "22214", "22216", "22218", "22220", "22222", "22224"], unit: "EA", commodity: "MECH", cost: [30000, 150000] },
  { key: "MSEAL", prefix: "MSL", desc: "メカニカルシール 軸径", sizes: ["25mm", "30mm", "35mm", "40mm", "45mm", "50mm", "55mm", "60mm", "65mm", "70mm"], unit: "SET", commodity: "MECH", cost: [40000, 250000] },
  { key: "PACKING", prefix: "GPK", desc: "グランドパッキン 角", sizes: ["8mm", "10mm", "12.5mm", "16mm", "19mm"], unit: "M", commodity: "MECH", cost: [2000, 8000] },
  { key: "VBELT", prefix: "VBT", desc: "Vベルト", sizes: ["B-40", "B-45", "B-50", "B-55", "B-60", "B-70", "B-80", "C-80", "C-90", "C-100", "C-120"], unit: "EA", commodity: "MECH", cost: [1500, 6000] },
  { key: "GASKET", prefix: "GSK", desc: "ガスケット JIS10K", sizes: ["25A", "32A", "40A", "50A", "65A", "80A", "100A", "125A", "150A", "200A", "250A", "300A"], unit: "EA", commodity: "MECH", cost: [500, 6000] },
  { key: "GASKET", prefix: "GSH", desc: "うず巻形ガスケット JIS30K", sizes: ["25A", "40A", "50A", "80A", "100A", "150A"], unit: "EA", commodity: "MECH", cost: [3000, 20000] },
  { key: "FILTERBAG", prefix: "FBG", desc: "ろ布", sizes: ["PTFE φ160×6000", "PTFE φ150×5000", "ガラス繊維 φ160×6000", "PPS/PTFE φ160×6000"], unit: "PCS", commodity: "BAGF", cost: [18000, 40000] },
  { key: "BAGCAGE", prefix: "FBC", desc: "ろ布用リテーナ", sizes: ["φ155×6000", "φ145×5000"], unit: "EA", commodity: "BAGF", cost: [8000, 15000] },
  { key: "PULSEVALVE", prefix: "PVL", desc: "パルス弁 ダイヤフラム", sizes: ["40A", "50A", "65A"], unit: "EA", commodity: "BAGF", cost: [12000, 30000] },
  { key: "GRATEBAR", prefix: "GRB", desc: "火格子片", sizes: ["乾燥段 KT形", "燃焼段 KT形", "後燃焼段 KT形", "乾燥段 MN形", "燃焼段 MN形", "後燃焼段 MN形", "乾燥段 HG形", "燃焼段 HG形", "後燃焼段 HG形"], unit: "EA", commodity: "STOKER", cost: [15000, 45000] },
  { key: "REFRACT", prefix: "RFM", desc: "耐火物", sizes: ["SiC質れんが 230×114×65", "高アルミナ質れんが 230×114×65", "キャスタブル 25kg", "プラスチック耐火物 20kg", "耐火モルタル 25kg"], unit: "T", commodity: "STOKER", cost: [60000, 400000] },
  { key: "OILTURB", prefix: "OIL", desc: "タービン油", sizes: ["VG32 200L", "VG46 200L"], unit: "CAN", commodity: "LUBE", cost: [80000, 120000] },
  { key: "OILCOMP", prefix: "OIC", desc: "圧縮機油", sizes: ["VG32 20L", "VG46 20L"], unit: "CAN", commodity: "LUBE", cost: [15000, 30000] },
  { key: "OILHYD", prefix: "OIH", desc: "作動油", sizes: ["VG32 200L", "VG46 200L", "VG68 200L"], unit: "CAN", commodity: "LUBE", cost: [60000, 90000] },
  { key: "OILGEAR", prefix: "OIG", desc: "ギヤ油", sizes: ["VG150 20L", "VG220 20L", "VG320 20L"], unit: "CAN", commodity: "LUBE", cost: [15000, 25000] },
  { key: "GREASE", prefix: "GRS", desc: "グリース", sizes: ["リチウム系 2号 16kg", "リチウム系 2号 400g", "耐熱 ウレア系 16kg"], unit: "CAN", commodity: "LUBE", cost: [1500, 40000] },
  { key: "HYDFILTER", prefix: "HFE", desc: "油圧フィルタエレメント", sizes: ["10μm", "25μm", "吸込用 100μm"], unit: "EA", commodity: "MECH", cost: [8000, 25000] },
  { key: "AIRFILTER", prefix: "AFE", desc: "圧縮機吸込フィルタ", sizes: ["37kW用", "55kW用"], unit: "EA", commodity: "MECH", cost: [6000, 12000] },
  { key: "WIREROPE", prefix: "WRP", desc: "ワイヤロープ 6×Fi(29)", sizes: ["φ20 L=150m", "φ22 L=180m", "φ24 L=200m"], unit: "EA", commodity: "CRANE", cost: [200000, 500000] },
  { key: "GRABTOOTH", prefix: "GBT", desc: "バケット爪", sizes: ["8m3用", "6m3用", "3m3用"], unit: "EA", commodity: "CRANE", cost: [50000, 120000] },
  { key: "TC", prefix: "TCK", desc: "熱電対 K", sizes: ["φ8 L=500", "φ8 L=1000", "φ12 L=1500", "φ12 L=2000"], unit: "EA", commodity: "INST", cost: [15000, 60000] },
  { key: "RTD", prefix: "RTD", desc: "測温抵抗体 Pt100", sizes: ["φ6 L=300", "φ8 L=500"], unit: "EA", commodity: "INST", cost: [12000, 30000] },
  { key: "CALGAS", prefix: "CGS", desc: "校正ガス", sizes: ["NO 180ppm 3.4L", "SO2 180ppm 3.4L", "CO 180ppm 3.4L", "O2 21% 3.4L", "ゼロガス N2 3.4L"], unit: "EA", commodity: "INST", cost: [20000, 45000] },
  { key: "ANLZPART", prefix: "ANP", desc: "分析計用消耗品", sizes: ["サンプリングポンプ ダイヤフラム", "メンブレンフィルタ", "除湿器エレメント", "イオン電極", "ジルコニアセンサ"], unit: "EA", commodity: "INST", cost: [5000, 180000] },
  { key: "FUSE", prefix: "FUS", desc: "ヒューズ", sizes: ["3A", "5A", "10A", "15A", "20A", "30A", "高圧限流 7.2kV G20A", "高圧限流 7.2kV G50A"], unit: "EA", commodity: "ELEC", cost: [300, 30000] },
  { key: "CONTACTOR", prefix: "MCN", desc: "電磁接触器", sizes: ["AC200V 9A", "AC200V 25A", "AC200V 50A", "AC200V 100A"], unit: "EA", commodity: "ELEC", cost: [5000, 40000] },
  { key: "RELAY", prefix: "RLY", desc: "補助リレー", sizes: ["DC24V 2c", "DC24V 4c", "AC100V 4c"], unit: "EA", commodity: "ELEC", cost: [1500, 5000] },
  { key: "LAMP", prefix: "LMP", desc: "LED表示灯", sizes: ["赤 DC24V", "緑 DC24V", "橙 DC24V", "白 AC100V"], unit: "EA", commodity: "ELEC", cost: [1500, 4000] },
  { key: "BATTERY", prefix: "BAT", desc: "蓄電池", sizes: ["制御弁式 12V 100Ah", "制御弁式 2V 300Ah", "アルカリ 1.2V 100Ah"], unit: "EA", commodity: "ELEC", cost: [30000, 120000] },
  { key: "DCSCARD", prefix: "DCC", desc: "DCS入出力カード", sizes: ["AI 16点", "AO 8点", "DI 32点", "DO 32点", "CPU"], unit: "EA", commodity: "INST", cost: [150000, 1200000] },
  { key: "CATALYST", prefix: "CAT", desc: "脱硝触媒エレメント", sizes: ["ハニカム 150×150×1000"], unit: "EA", commodity: "STOKER", cost: [80000, 120000] },
  { key: "NOZZLE", prefix: "NZL", desc: "噴霧ノズル", sizes: ["二流体 減温塔用", "アンモニア水用"], unit: "EA", commodity: "MECH", cost: [30000, 90000] },
  { key: "CHEM", prefix: "CHM", desc: "薬品", sizes: ["消石灰 特号 25kg", "活性炭 粉末 15kg", "キレート剤 20kg", "苛性ソーダ 25% 20L", "アンモニア水 25% 20L", "清缶剤 20L", "脱酸素剤 20L", "凝集剤 PAC 20kg"], unit: "KGBAG", commodity: "CHEM", cost: [1500, 25000] },
];

// ---------------------------------------------------------------------------
// 会社（製造元・購入先）
// ---------------------------------------------------------------------------

export const COMPANIES: Array<{ company: string; name: string; type: "M" | "V" }> = [
  { company: "MKR-PLA", name: "プラントメーカーＡ", type: "V" },
  { company: "MKR-PLB", name: "プラントメーカーＢ", type: "V" },
  { company: "MKR-PLC", name: "プラントメーカーＣ", type: "V" },
  { company: "MKR-PA", name: "ポンプメーカーＡ", type: "M" },
  { company: "MKR-PB", name: "ポンプメーカーＢ", type: "M" },
  { company: "MKR-PC", name: "ポンプメーカーＣ", type: "M" },
  { company: "MKR-FA", name: "送風機メーカーＡ", type: "M" },
  { company: "MKR-FB", name: "送風機メーカーＢ", type: "M" },
  { company: "MKR-EA", name: "重電メーカーＡ", type: "M" },
  { company: "MKR-EB", name: "重電メーカーＢ", type: "M" },
  { company: "MKR-EC", name: "電機メーカーＣ", type: "M" },
  { company: "MKR-IA", name: "計装メーカーＡ", type: "M" },
  { company: "MKR-IB", name: "計装メーカーＢ", type: "M" },
  { company: "MKR-AN", name: "分析計メーカーＡ", type: "M" },
  { company: "MKR-AB", name: "分析計メーカーＢ", type: "M" },
  { company: "MKR-CR", name: "クレーンメーカーＡ", type: "M" },
  { company: "MKR-VA", name: "バルブメーカーＡ", type: "M" },
  { company: "MKR-VB", name: "バルブメーカーＢ", type: "M" },
  { company: "MKR-CP", name: "圧縮機メーカーＡ", type: "M" },
  { company: "MKR-HV", name: "空調機メーカーＡ", type: "M" },
  { company: "MKR-EV", name: "昇降機メーカーＡ", type: "M" },
  { company: "MKR-CV", name: "コンベヤメーカーＡ", type: "M" },
  { company: "MKR-WB", name: "計量機メーカーＡ", type: "M" },
  { company: "MKR-BG", name: "ろ布メーカーＡ", type: "M" },
  { company: "MKR-CT", name: "触媒メーカーＡ", type: "M" },
  { company: "MKR-TB", name: "タービンメーカーＡ", type: "M" },
  { company: "MKR-BL", name: "ボイラメーカーＡ", type: "M" },
  { company: "VND-MA", name: "機械整備業者Ａ", type: "V" },
  { company: "VND-MB", name: "機械整備業者Ｂ", type: "V" },
  { company: "VND-EA", name: "電気工事業者Ａ", type: "V" },
  { company: "VND-IA", name: "計装工事業者Ａ", type: "V" },
  { company: "VND-SA", name: "商社Ａ", type: "V" },
];

/** 分類 → 製造元の候補 */
export const CLASS_MAKERS: Record<string, string[]> = {
  PUMP: ["MKR-PA", "MKR-PB", "MKR-PC"], FAN: ["MKR-FA", "MKR-FB"], COMP: ["MKR-CP"], CONV: ["MKR-CV"], CRANE: ["MKR-CR"], GRAB: ["MKR-CR"],
  TURBINE: ["MKR-TB"], GEN: ["MKR-EA", "MKR-EB"], MOTOR: ["MKR-EA", "MKR-EB", "MKR-EC"], INV: ["MKR-EA", "MKR-EC"], TRANSF: ["MKR-EA", "MKR-EB"],
  BRKR: ["MKR-EA", "MKR-EB"], SWGR: ["MKR-EB", "MKR-EC"], UPS: ["MKR-EC"], EGEN: ["MKR-EB"], XMTR: ["MKR-IA", "MKR-IB"], ANLZ: ["MKR-AN", "MKR-AB"],
  DCS: ["MKR-IA"], CVALVE: ["MKR-VA", "MKR-VB"], MOV: ["MKR-VA", "MKR-VB"], SAFV: ["MKR-VA"], HVAC: ["MKR-HV"], ELEV: ["MKR-EV"], WBRIDGE: ["MKR-WB"],
  FBAG: ["MKR-BG"], SCR: ["MKR-CT"], BOILER: ["MKR-BL"], AIRDRY: ["MKR-CP"], MIXER: ["MKR-CV"], GEARBOX: ["MKR-CV", "MKR-EA"],
};

/** 型式の接頭辞 */
export const MODEL_PREFIX: Record<string, string> = {
  PUMP: "CP", FAN: "TF", COMP: "SC", CONV: "CV", CRANE: "OC", GRAB: "GB", GRATE: "SG", FEEDER: "FD", TURBINE: "ST", MIXER: "KM",
  GEARBOX: "RG", SOOTBL: "SB", BOILER: "WB", BAGF: "BF", HYDU: "HU", BURNER: "BN", WBRIDGE: "TS", AIRDRY: "AD", CTWR: "CT", WTREAT: "WT",
  CVALVE: "CVG", MOV: "MV", SAFV: "SV", MOTOR: "TK", INV: "VF", TRANSF: "TR", BRKR: "VB", SWGR: "MC", GEN: "SG", UPS: "UP", EGEN: "DG",
  XMTR: "EJ", ANLZ: "GA", DCS: "CS", HVAC: "PA", ELEV: "EL",
};

// ---------------------------------------------------------------------------
// 人（PERSON / LABOR / CRAFT / PERSONGROUP）
// ---------------------------------------------------------------------------

export const CRAFTS: Array<[string, string]> = [
  ["MECH", "機械保全"], ["ELEC", "電気保全"], ["INST", "計装保全"], ["OPER", "運転"], ["CIVIL", "建築・設備管理"], ["CONTR", "外部委託作業"],
];

/** 役割 → 同時に在籍する人数（炉 1 基あたりの加算）、肩書、職種 */
export const ROLES: Array<{ role: string; title: string; craft: string; base: number; perLine: number; supervisor?: boolean }> = [
  { role: "MGR", title: "所長", craft: "MECH", base: 1, perLine: 0, supervisor: true },
  { role: "MECHL", title: "機械係長", craft: "MECH", base: 1, perLine: 0, supervisor: true },
  { role: "ELECL", title: "電気計装係長", craft: "ELEC", base: 1, perLine: 0, supervisor: true },
  { role: "OPERL", title: "運転係長", craft: "OPER", base: 1, perLine: 0, supervisor: true },
  { role: "MECH", title: "機械保全担当", craft: "MECH", base: 3, perLine: 1 },
  { role: "ELEC", title: "電気保全担当", craft: "ELEC", base: 2, perLine: 0.5 },
  { role: "INST", title: "計装保全担当", craft: "INST", base: 1, perLine: 0.5 },
  { role: "OPER", title: "運転員", craft: "OPER", base: 8, perLine: 2 },
  { role: "CIVIL", title: "設備管理担当", craft: "CIVIL", base: 1, perLine: 0 },
];

export const SURNAMES: Array<[string, string]> = [
  ["佐藤", "SATO"], ["鈴木", "SUZUKI"], ["高橋", "TAKAHASHI"], ["田中", "TANAKA"], ["伊藤", "ITO"], ["渡辺", "WATANABE"],
  ["山本", "YAMAMOTO"], ["中村", "NAKAMURA"], ["小林", "KOBAYASHI"], ["加藤", "KATO"], ["吉田", "YOSHIDA"], ["山田", "YAMADA"],
  ["佐々木", "SASAKI"], ["山口", "YAMAGUCHI"], ["松本", "MATSUMOTO"], ["井上", "INOUE"], ["木村", "KIMURA"], ["林", "HAYASHI"],
  ["斎藤", "SAITO"], ["清水", "SHIMIZU"], ["山崎", "YAMAZAKI"], ["森", "MORI"], ["池田", "IKEDA"], ["橋本", "HASHIMOTO"],
  ["阿部", "ABE"], ["石川", "ISHIKAWA"], ["山下", "YAMASHITA"], ["中島", "NAKAJIMA"], ["石井", "ISHII"], ["小川", "OGAWA"],
  ["前田", "MAEDA"], ["岡田", "OKADA"], ["長谷川", "HASEGAWA"], ["藤田", "FUJITA"], ["後藤", "GOTO"], ["近藤", "KONDO"],
  ["村上", "MURAKAMI"], ["遠藤", "ENDO"], ["青木", "AOKI"], ["坂本", "SAKAMOTO"], ["西村", "NISHIMURA"], ["福田", "FUKUDA"],
];

export const GIVEN_NAMES: Array<[string, string]> = [
  ["健一", "KENICHI"], ["誠", "MAKOTO"], ["浩二", "KOJI"], ["隆", "TAKASHI"], ["大輔", "DAISUKE"], ["翔太", "SHOTA"],
  ["拓也", "TAKUYA"], ["直樹", "NAOKI"], ["和也", "KAZUYA"], ["亮", "RYO"], ["裕子", "YUKO"], ["恵", "MEGUMI"],
  ["美咲", "MISAKI"], ["陽介", "YOSUKE"], ["智子", "TOMOKO"], ["剛", "TSUYOSHI"], ["修", "OSAMU"], ["健太", "KENTA"],
  ["悠斗", "YUTO"], ["真由美", "MAYUMI"], ["勇気", "YUKI"], ["達也", "TATSUYA"], ["聡", "SATOSHI"], ["光", "HIKARU"],
  ["優花", "YUKA"], ["俊介", "SHUNSUKE"], ["貴之", "TAKAYUKI"], ["正樹", "MASAKI"], ["奈々", "NANA"], ["蓮", "REN"],
];
