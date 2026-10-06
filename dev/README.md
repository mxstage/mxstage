# 開発用のライセンスキー

MX Stage を開発・試験するためのキーです。本物の Maximo にも、ふだんの MX Stage にも使えません。

- `fake-maximo.license.key`: 偽の Maximo（`https://127.0.0.1:9797`）だけに使えるキー。決済の試験用の鍵（s1）で署名してあり、
  橋渡しを `--dev-license` 付きで起動したときだけ有効です（ふだんの製品は試験用の鍵のキーを受け付けません）。

## 使い方

```bash
npm run dev:fake-maximo
```

```bash
npm run dev:bridge
```

1. 作業画面（http://127.0.0.1:8790/app）の接続先に `https://127.0.0.1:9797` と API キー `test-api-key` を入れる
2. 環境を「本番」にすると、このキーで「Maximo に反映」まで試せる（上部に「本番（MX Stage development のライセンス）」と出る）
3. ライセンスが無いときの動きを試すときは、`npm run bridge -- --no-mcp --port 8790 --insecure --allow-host 127.0.0.1`（`--dev-license` 無し）で起動する

ポート 8788 はデモ・ふだん使いの橋渡しが使うので、開発では使いません。

## 決まり

- ここに置くのは、試験用の鍵（s1）で署名した、`https://127.0.0.1:9797` だけのキーに限ります。本番用の鍵（p1）のキーは決して置きません
  （`tests/bridge/repo.test.ts` が確かめます）。
- 署名の鍵（秘密鍵）は開発メンバーにも渡しません。別のキーが要るときは、販売サイトの試験用の環境（Paddle のサンドボックス）で発行します。

# デモ・開発用の大きなデータ（ごみ焼却施設 3 か所、日本語・英語。第 2 版）

偽の Maximo に、実際の顧客に近い規模・中身のデータを載せて試すためのものです（`dev/datasets/plants/`）。
架空の広域事業組合（ORGID `KANKYO`）が、ごみ焼却施設を 3 か所（サイト）運営している想定です。名前はすべて架空です。
同じものを Cloudflare Pages に置き、MX Stage のデモ（Maximo を持たない人が試す）で使います（`npm run demo:build`、公開の手順は `docs/demo-ops.md`）。

```bash
npm run dev:fake-maximo -- --dataset plants             # 日本語
npm run dev:fake-maximo -- --dataset plants --lang en   # 英語
npm run dev:bridge
```

- 起動すると、オブジェクト構造ごとの件数・メモリ・起動までの時間を出します（データの生成は約 2 秒、メモリ約 0.5 GB）。
- フラグを付けなければ、これまでどおりの小さなデータ（試験の `sampleSeed`）です。自動の試験の app・bridge も小さなデータのままです。
- 乱数は種付きなので、毎回同じデータになります（作業指示番号・資産番号も同じ）。基準日は 2026-09-30 17:00（これより後の実績はありません）。
- **日本語と英語は同じ乱数で作る**ので、ID・件数・日付・ステータスは同じです（違うのは文・人の ID・金額の通貨）。
  英語の文は `dev/datasets/plants/en.ts` の辞書（日本語の正本 → 英語）と `text.ts` の組み立てで作ります。英語の金額は 1 USD = 150 円で換算します。
- 書き込み（「Maximo に反映」）もできます。偽の Maximo を止めると元に戻ります。

## 施設と Maximo を入れた時期

| サイト | 名前 | 竣工 | Maximo を入れた月 | 炉 | 場所の接頭辞 | 資産番号 |
|---|---|---|---|---|---|---|
| `KITA` | 北部クリーンセンター / North Clean Center | 2006-04 | 2018-04（旧台帳から移行） | 3 炉 × 100 t/日。洗煙設備あり、受電 66 kV | `KT-` | 1000001〜 |
| `MINAMI` | 南部クリーンセンター / South Clean Center | 2013-04 | 2018-04（旧台帳から移行） | 2 炉 × 120 t/日。場外余熱供給あり | `MN-` | 2000001〜 |
| `HIGASHI` | 東部クリーンセンター / East Clean Center | 2021-04 | 2021-04（竣工から） | 2 炉 × 95 t/日。受電 6.6 kV | `HG-` | 3000001〜 |

- **北部・南部の 2018 年 3 月より前の作業指示・SR・メーターの読みは Maximo に無く**、星取表と旧設備台帳（Excel）にだけあります。
  Maximo を入れる前に撤去した資産も Maximo にありません。移行に由来するデータ品質の問題は、移した資産に集まります。
- 場所の階層（LOCHIERARCHY）は 2 つ。`PRIMARY` は 施設（`KT`）→ 炉系列（`KT-L1`〜）・共通設備（`KT-CM`）→ 設備系統（`KT-1-20`）→ 装置（`KT-1-20-ST`）→
  機能位置（`KT-1-GR-201`）。`ELEC`（電気の系統）は 受電遮断器 → 主変圧器 → 高圧配電盤 → 動力変圧器 → コントロールセンタ → 電動機のある機器。
  子を持つ場所は `children` が立っています。
- 場所のタイプ: 運転（OPERATING）のほか、部品倉庫 `KT-STORE`・電気計装倉庫 `KT-ESTORE`（STOREROOM）、修理中 `KT-REPAIR`（REPAIR）、撤去品置場 `KT-SALVAGE`（SALVAGE）。
- タグ番号（ASSETTAG）の命名規則は `<炉（共通は 0）>-<種別>-<番号><号機>`（例 `1-P-202A`）。
- 寿命のある分類は年数がたつと更新され、古い資産は `DECOMMISSIONED` で撤去品置場へ移ります。
- **回転資産**: 電動機・インバータ・伝送器・調節弁は回転品目（ITEM.ROTATING、`RMT-`・`RIV-`・`RXM-`・`RCV-`）で、資産に ITEMNUM があります。
  予備品の資産（資産番号 x8xxxxx）は倉庫の棚にあり、回転品目の在庫数（INVENTORY.CURBALTOTAL）は倉庫にある予備品の台数と同じです（一部は修理中）。
- **在庫と払い出し**: 在庫（INVENTORY・INVBALANCES・INVCOST）の発注点・最大在庫・ABC は使った量から決め、残高は払い出し（INVUSE・INVUSELINE。
  作業指示への払い出しと、月 1 回のグリース）と補充から計算します。資産には予備品の一覧（SPAREPART）があります。
- **外注**: 外注の作業指示には業者（VENDOR）と、発注の独自属性（`EXT_PONUM`・`EXT_ASSESSAMT` 査定・`EXT_ORDERAMT` 発注・`EXT_ACCEPTAMT` 検収・
  `EXT_PODATE`・`EXT_ACCEPTDATE`・`EXT_LEGAL` 法規対応・`EXT_DEPT` 部署）があります。2026 年 3 月までは入力済み、
  **2026 年度上半期（4〜9 月）は未入力で、完了しても COMP のまま**です（発注リストの Excel にだけある）。
  年間の委託（受変電の年次点検・分析計・DCS・昇降機・消防）は作業指示ごとの金額が無く、契約番号だけです。
  実機では計算で決まる標準の費用（`ESTSERVCOST`・`ESTATAPPRSERVCOST`・`ACTSERVCOST`）は読み取り専用です。
- **東部の資産の登録は 2025 年 4 月から止まっています**（その後の更新・増設・仕様の変更・撤去は、東部の機器台帳の Excel にだけある）。

## 件数（日英で同じ）

| 表（オブジェクト構造） | KITA | MINAMI | HIGASHI | 組織全体 |
|---|---:|---:|---:|---:|
| LOCATIONS（MXAPIOPERLOC） | 688 | 514 | 510 | |
| ASSET（MXAPIASSET。うち撤去済み / 予備品） | 1,190（374 / 54） | 729（118 / 40） | 597（0 / 40） | |
| ASSETSPEC / ASSETMETER / SPAREPART（MXAPIASSET の子） | | | | 14,806 / 777 / 911 |
| PM（MXAPIPM） | 684 | 520 | 514 | |
| WORKORDER（MXAPIWODETAIL・MXAPIWO） | 23,643 | 17,179 | 10,930 | 51,752 |
| WOSTATUS / FAILUREREPORT（MXAPIWODETAIL の子） | | | | 247,921 / 19,857 |
| SR（MXAPISR） | 3,477 | 2,223 | 1,447 | 7,147 |
| METERREADING（MXAPIMETERREADING） | 15,096 | 11,730 | 7,345 | 34,171 |
| INVENTORY（MXAPIINVENTORY） | 176 | 163 | 164 | |
| INVUSE / INVUSELINE（MXAPIINVUSE） | 3,272 | 2,188 | 1,451 | 6,911 / 7,273 |
| ITEM（うち回転品目） / JOBPLAN / CLASSSTRUCTURE / ASSETATTRIBUTE | | | | 344（159） / 49 / 60 / 107 |
| FAILURECODE / FAILURELIST | | | | 105 / 1,235 |
| PERSON・LABOR / PERSONGROUP / CRAFT | | | | 201 / 15 / 6 |
| MEASUREUNIT / METER / COMPANIES / MAXDOMAIN | | | | 37 / 5 / 32 / 17 |

作業指示の作業タイプ: PM 15,500、INSP 19,686、CAL 7,255、CM 8,231、EM 1,080（ほかに値の一覧だけの CP 更新工事）。
ステータス: CLOSE 44,770、COMP 4,188、CAN 2,012、INPRG 466、APPR 267、WAPPR 43、WMATL 6。
クローズは年度末にまとめて行います（終わった年度の次の 4 月）。今年度（2026 年度、基準日 2026-09-30）に終わった作業指示は COMP のままで、中身を直せます（第 3 版から。第 2 版は終わりの 1〜30 日後にクローズしていた）。

## オブジェクト構造

`MXAPIOPERLOC`（子 LOCHIERARCHY・LOCATIONSPEC）、`MXAPIASSET`（子 ASSETSPEC・ASSETMETER・SPAREPART）、`MXAPIWODETAIL`（子 WOSTATUS・FAILUREREPORT）、
`MXAPIWO`（子なし。MXAPIWODETAIL と同じ行）、`MXAPISR`（子 TKSTATUS・RELATEDRECORD）、`MXAPIPM`、`MXAPIJOBPLAN`（子 JOBTASK・JOBLABOR・JOBMATERIAL）、
`MXAPICLASSSTRUCTURE`（子 CLASSSPEC・CLASSUSEWITH）、`MXAPIASSETATTRIBUTE`、`MXAPIMEASUREUNIT`、`MXAPIFAILURECODE`、`MXAPIFAILURELIST`、
`MXAPIMETER`、`MXAPIMETERREADING`、`MXAPIITEM`、`MXAPIINVENTORY`（子 INVBALANCES・INVCOST）、`MXAPIINVUSE`（子 INVUSELINE）、`MXAPIPERSON`、
`MXAPILABOR`（子 LABORCRAFTRATE）、`MXAPICRAFT`、`MXAPIPERSONGROUP`（子 PERSONGROUPTEAM）、`MXAPICOMPANY`、`MXAPIDOMAIN`（子 SYNONYMDOMAIN・ALNDOMAIN）、
`MXAPIORGANIZATION`（子 SITE）、`MXAPIINTOBJECT`。

ステータス・作業タイプ・サイト・分類・故障コード・担当者・単位・業者・部署などには値の一覧（getlist）があります。
作業計画の番号（JPNUM）は 10 文字、故障コードは 8 文字に収めています（実機の長さ）。

実機での名前・属性を確かめていないもの（偽の Maximo で試すための仮の形）:

- 構造名: `MXAPIASSETATTRIBUTE`、`MXAPIMEASUREUNIT`、`MXAPIMETERREADING`（実機は MXAPIMETERDATA / MXMETERDATA で読みを入れる）、`MXAPICRAFT`、`MXAPICOMPANY`、
  `MXAPIORGANIZATION`、`MXAPICLASSSTRUCTURE` と `MXAPIFAILURECODE` / `MXAPIFAILURELIST` の子の形
- 子の組み合わせ: MXAPIOPERLOC の LOCHIERARCHY、MXAPISR の TKSTATUS・RELATEDRECORD、MXAPIWODETAIL の WOSTATUS（実機の MXAPIWODETAIL には他にも多くの子がある）、
  MXAPIASSET の SPAREPART、MXAPIINVENTORY の INVCOST、MXAPIINVUSE の INVUSELINE の属性
- ドメイン名: `PMSTATUS`、`JOBPLANSTATUS`、`PERSONSTATUS`、`LABORSTATUS`、`CATEGORY`、`DATATYPE`、`INVUSESTATUS`、`EXTDEPT`（独自）。
  作業タイプ（WORKTYPE）は実機では表なので、ドメインには入れず値の一覧だけ
- 作業タイプ `INSP`（点検・検査）と `CP`（更新工事）は Maximo の既定に無い、顧客が足す想定の値
- 作業指示の `EXT_*` は顧客が足した独自属性の想定。`ESTSERVCOST` を実機で直接書けるかは確かめていない（読み取り専用にしてある）

## 仕込んだデータ品質の問題（44 種類）

MX Stage で見つけて直す練習用に、わざと入れてある問題です（件数は 3 施設の合計。日英で同じ）。
日本語は全角・半角カナ・「No.1炉」、英語は似た字（O と 0、l と 1）・略語（PMP、MTR）・「#1 Line」で表します。

| ID | 内容 | どこに出るか | 件数 |
|---|---|---|---:|
| SPEC_MISSING_ALL | 分類はあるが仕様（ASSETSPEC）が 1 行も無い | ASSET.ASSETSPEC | 152 |
| SPEC_BLANK_VALUES | 仕様の行はあるが値が空（一部の属性） | ASSETSPEC.ALNVALUE / NUMVALUE | 299 |
| SPEC_UNIT_MIXED | 同じ属性で単位が混在（流量 m3/h と L/min、出力 kW と W、圧力 MPa と kPa） | ASSETSPEC.MEASUREUNITID / NUMVALUE | 43 |
| SPEC_NUMBER_AS_TEXT | 数値の仕様が英数字の欄に単位付きの文字で入っている | ASSETSPEC.ALNVALUE / NUMVALUE | 108 |
| ASSET_NO_CLASS | 資産に分類が無い | ASSET.CLASSSTRUCTUREID | 17 |
| TAG_FORMAT | タグ番号が命名規則に合わない（小文字・ハイフン無し・炉番号無し） | ASSET.ASSETTAG | 105 |
| CHAR_VARIANT | タグ番号・説明に全角英数字（英語は似た字）が混じる | ASSET.ASSETTAG / DESCRIPTION | 76 |
| TAG_LINE_MISMATCH | タグ番号の炉番号が機能位置の炉と食い違う | ASSET.ASSETTAG / LOCATION | 16 |
| TAG_MISSING | タグ番号が空 | ASSET.ASSETTAG | 24 |
| TRAILING_SPACE | 値の末尾に空白（半角・全角 / ノーブレークスペース） | ASSET.ASSETTAG / DESCRIPTION、LOCATIONS.DESCRIPTION | 124 |
| DESC_NOTATION_VARIANT | 説明の表記の揺れ（半角カナ / 略語・大文字） | ASSET.DESCRIPTION | 60 |
| DESC_LINE_NOTATION | 炉の表記が揺れる（1号炉 / No.1炉 / １号炉、Line 1 / #1 Line） | ASSET.DESCRIPTION / LOCATIONS.DESCRIPTION | 56 |
| SERIAL_PLACEHOLDER | 製造番号が「不明」「-」「N/A」などの仮の値 | ASSET.SERIALNUM | 94 |
| SERIAL_MISSING | 製造番号が空 | ASSET.SERIALNUM | 46 |
| ASSET_NO_INSTALLDATE | 設置日が空 | ASSET.INSTALLDATE | 24 |
| ASSET_NO_MANUFACTURER | 製造元が空 | ASSET.MANUFACTURER | 40 |
| ASSET_DUPLICATE | 同じ機能位置・同じタグの稼働中の資産が二重に登録（資産番号 x9xxxxx） | ASSET | 14 |
| DECOM_AT_POSITION | 撤去済みの資産が機能位置に残ったまま | ASSET.LOCATION / STATUS | 56 |
| LOCATION_NO_CLASS | 機能位置に分類が無い | LOCATIONS.CLASSSTRUCTUREID | 86 |
| LOC_NOT_IN_HIERARCHY | 機能位置が場所の階層（PRIMARY）に入っていない | LOCATIONS.LOCHIERARCHY | 10 |
| LOC_WRONG_PARENT | 機能位置の親が別の装置・設備系統 | LOCATIONS.LOCHIERARCHY.PARENT | 10 |
| LOC_TYPE_WRONG | 機能位置のタイプが OPERATING でない | LOCATIONS.TYPE | 6 |
| PM_DECOMMISSIONED_ASSET | PM が撤去済みの資産を指したまま（次回日が過去で止まっている） | PM.ASSETNUM / NEXTDATE | 39 |
| WO_NO_FAILURE_CODE | 是正・緊急保全に故障コードが無い | WORKORDER.FAILURECODE / PROBLEMCODE | 1,100 |
| WO_FREETEXT_ONLY | 故障の内容が件名・長い説明の自由記述だけ | WORKORDER.DESCRIPTION / DESCRIPTION_LONGDESCRIPTION | 945 |
| WO_PROBLEM_ONLY | 問題コードはあるが故障クラスが空、故障報告も無い | WORKORDER.FAILURECODE / FAILUREREPORT | 463 |
| WO_NO_LABOR_HOURS | 完了した是正保全に実績工数が無い（0） | WORKORDER.ACTLABHRS | 585 |
| WO_LOCATION_MISMATCH | 作業指示の場所が資産の機能位置と違う（装置の場所） | WORKORDER.LOCATION | 295 |
| WO_STALE_OPEN | 半年以上前に着手したまま INPRG で閉じていない | WORKORDER.STATUS / ACTFINISH | 458 |
| SR_NO_ASSET | 資産・機能位置を特定しない運転員の連絡（装置の場所だけ） | SR.ASSETNUM | 2,069 |
| ITEM_DUPLICATE | 同じ部品が別の品目番号・別の表記で重複（Z- で始まる品目） | ITEM | 10 |
| ITEM_ROTATING_FLAG_WRONG | 資産が使う回転品目に ROTATING の印が無い | ITEM.ROTATING | 2 |
| ROT_ASSET_NO_ITEM | 回転資産の分類なのに品目が付いていない | ASSET.ITEMNUM | 40 |
| ROT_BALANCE_MISMATCH | 回転品目の在庫数が倉庫の予備品の台数と合わない | INVENTORY.CURBALTOTAL / ASSET.LOCATION | 8 |
| ROT_STUCK_IN_REPAIR | 修理に出した予備品が 1 年以上戻っていない | ASSET.LOCATION（REPAIR） | 6 |
| SPAREPART_OBSOLETE_ITEM | 資産の予備品の一覧が廃止の品目を指している | ASSET.SPAREPART.ITEMNUM | 70 |
| INV_OBSOLETE_STOCK | 廃止の品目に在庫が残っている | INVENTORY.CURBALTOTAL / ITEM.STATUS | 17 |
| INV_MIN_OVER_MAX | 発注点が最大在庫を超える | INVENTORY.MINLEVEL / MAXLEVEL | 14 |
| INV_ABC_STALE | ABC 分類が使用金額と合っていない | INVENTORY.ABCTYPE | 15 |
| INV_NO_BIN | 既定の棚が空 | INVENTORY.BINNUM | 10 |
| INV_STALE_COUNT | 実地棚卸が 2 年以上前のまま | INVBALANCES.PHYSCNTDATE | 25 |
| INV_ZERO_COST | 平均単価が 0 | INVENTORY.AVGCOST / INVCOST.AVGCOST | 10 |
| INV_NO_VENDOR | 購入先が空 | INVENTORY.VENDOR | 13 |

件数は `generatePlants().problems` でも取れます。

## Excel のサンプル（5 種、日英）

`dev/demo/excel/builders.ts` がデータと同じ種から作るので、Maximo のデータと本当に突き合わせられます。正解は `dist/demo-data-truth/v<版>/<言語>/truth.json`（公開しない）。

| ID | ファイル | 中身と仕掛け | 突き合わせる先 |
|---|---|---|---|
| `purchase-orders` | 発注一覧（2026 年度上半期） | **作業指示番号が無い**（件名・施設・時期で結ぶ）。金額の書式の揺れ（「1,234千円」「123.4万円」「¥」/「$12,340」「12.3k」）、和暦・「5/12」の日付、姓だけの担当、部門の揺れ、施設ごとの小計の行、年間の委託（1 行で多くの作業指示）、作業指示の無い購入、変更契約の 2 行目、取消 | COMP の外注の作業指示の `EXT_*`・SUPERVISOR・VENDOR（一部は先に間違いが入っている） |
| `legacy-register` | 旧設備台帳（平成 30 年 3 月末、北部・南部） | 古い形式のタグ（`1P202A`、`1-P202A`、`1 P 202A`）、和暦（H18.4・平成18年4月）、メーカー名の揺れ、2 段の見出し。その後に更新した資産の古い製造番号を、新しい資産に写さないことが仕掛け | SERIALNUM の仮の値・空、INSTALLDATE の空、MANUFACTURER の空 |
| `repair-log` | **日本語**: 作業日報（北部、2026-04〜09、月ごとのシートに A4 縦の帳票を 1 日 1 枚、26〜34 枚）。**英語**: 修理記録の表 | 日本語: 常駐の委託業者（設備保守点検業務委託・年間）の日報は平日と修理のあった休日、業者に発注した修繕は工事の日に別の作業報告書（工事名は発注一覧の件名と書き方が違う）。作業内容の文に炉・設備・機器が通称や略語で紛れる、「〃」「同上」、定期点検・巡視・清掃の行、Maximo に無い小さな修理（月 4〜5 件）。印刷範囲・改ページ・A4 縦。英語: 自由記述、通称（IDF・BFP）、同じ日の行は日付のセルを結合、関係の無い行、「2h」「half day」、日本語と同じ Maximo に無い小さな修理 | 故障コードの無い是正・緊急保全の FAILURECODE・PROBLEMCODE・FAILUREREPORT。Maximo に無い修理の作業指示の作成も（日英とも同じ 26 件）。ACTLABHRS は読み取り専用 |
| `east-register` | 東部の機器台帳（現場管理、Maximo より新しい） | 2025-04 以降の更新・増設・仕様の変更・名前の変更・撤去。製造番号を Maximo で直したのに台帳が古いままの行（台帳の更新日が古い） | 既存の資産の更新・ASSETSPEC、新しい資産、撤去（DECOMMISSIONED） |
| `star-chart` | 星取表（北部・南部、Maximo を入れる前） | 設備系統ごとのシート、○点検 ◎分解整備 ●更新 △補修 ★法定、予定と実績の 2 行、年度は和暦と西暦の 2 段、設備の列は結合、「◎(5月)」「△(A)」の注記 | 履歴の作業指示（印 1 つを CLOSE の作業指示 1 件） |

## 公開するファイル

`npm run demo:build` が `dist/demo-data/` に書き出します（形は `src/demo/format.ts`）。

- `v<版>/manifest.json`: 版、ファイルごとの大きさ・SHA-256・件数。製品はこの SHA-256 を埋め込んで確かめます（`src/shared/demo.ts`）。
- `v<版>/<言語>/osdefs.json.gz`（構造の定義と値の一覧）、`v<版>/<言語>/os/<構造>.ndjson.gz`（記録）、`v<版>/<言語>/excel/<ID>.xlsx`。1 言語で約 9 MB。
- `index.html`（Excel のダウンロード）、`_headers`（キャッシュと CORS）、`robots.txt`。

## 試験

- `tests/dev/plants-dataset.test.ts`: 東部の全期間と北部の直近 1 年で、場所・親・分類の仕様・PM・作業計画の参照、作業指示の日付の順序とステータスの履歴、
  値の一覧に無い値が無いこと、偽の Maximo での読み込みと書き込み。
- `tests/dev/plants-v2.test.ts`: 全部（日英）を作って、日英で ID・件数・日付が同じ、英語に日本語が残らない、最大長、場所の階層（PRIMARY・ELEC）、
  Maximo を入れた日、回転資産と在庫・払い出し、外注、正解の参照先。
- `tests/dev/demo-files.test.ts`: Excel を作業画面の読み取りで読めるか・CRC・同じ入力から同じバイト列か、公開するファイルを読み戻すと同じ偽の Maximo になるか。
