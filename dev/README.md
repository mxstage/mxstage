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

# 開発用の大きなデータ（ごみ焼却施設 3 か所）

偽の Maximo に、実際の顧客に近い規模・中身のデータを載せて試すためのものです（`dev/datasets/plants/`）。
架空の広域事業組合（ORGID `KANKYO`）が、ごみ焼却施設を 3 か所（サイト）運営している想定です。名前はすべて架空です。

```bash
npm run dev:fake-maximo -- --dataset plants
npm run dev:bridge
```

- 起動すると、オブジェクト構造ごとの件数・メモリ・起動までの時間を出します（データの生成は約 1.5 秒、起動まで約 2.5 秒、メモリ約 0.8 GB）。
- フラグを付けなければ、これまでどおりの小さなデータ（試験の `sampleSeed`）です。自動の試験（`npx vitest run`）も小さなデータのままです。
- 乱数は種付きなので、毎回同じデータになります（作業指示番号・資産番号も同じ）。基準日は 2026-09-30 17:00（これより後の実績はありません）。
- 書き込み（「Maximo に反映」）もできます。偽の Maximo を止めると元に戻ります。

## 施設

| サイト | 名前 | 竣工 | 炉 | 場所の接頭辞 | 資産番号 |
|---|---|---|---|---|---|
| `KITA` | 北部クリーンセンター | 2006-04（約 20 年） | 3 炉 × 100 t/日。洗煙設備あり、受電 66 kV | `KT-` | 1000001〜 |
| `MINAMI` | 南部クリーンセンター | 2013-04（約 13 年） | 2 炉 × 120 t/日。場外余熱供給あり | `MN-` | 2000001〜 |
| `HIGASHI` | 東部クリーンセンター | 2021-04（約 5 年） | 2 炉 × 95 t/日。受電 6.6 kV | `HG-` | 3000001〜 |

場所の階層（LOCHIERARCHY、システム `PRIMARY`）は 施設（`KT`）→ 炉系列（`KT-L1`〜）・共通設備（`KT-CM`）→ 設備系統（`KT-1-20` 1号炉 燃焼設備）→
装置（`KT-1-20-ST` ストーカ）→ 機能位置（`KT-1-GR-201`）です。機能位置の場所コードは「施設の接頭辞-タグ番号」で、
タグ番号（ASSETTAG）の命名規則は `<炉（共通は 0）>-<種別>-<番号><号機>`（例 `1-P-202A` 1号炉 油圧ポンプ A号機、`0-P-651B` ボイラ給水ポンプ B号機）です。

設備系統は 受入・供給 / 燃焼 / 燃焼ガス冷却（ボイラ）/ 排ガス処理（減温塔・ろ過式集じん器・薬剤噴霧・触媒脱硝・洗煙）/ 通風（押込・誘引送風機・煙突）/
余熱利用（蒸気タービン発電・復水・冷却水・場外余熱供給）/ 給水 / 灰出し / 排水処理 / 電気（受変電・低圧動力・非常用電源）/ 計装（DCS・排ガス分析計）/
建築・ユーティリティ（圧縮空気・空調換気・消防・昇降機・給排水）です。

- 資産は機能位置ごとに据え、ポンプ・送風機の電動機やインバータ、クレーンの電動機・バケットは子の資産（PARENT）です。
- 分類（CLASSSTRUCTURE）は 機械設備 → 回転機械 → ポンプ のような階層で、葉の分類に仕様（CLASSSPEC）があり、資産に ASSETSPEC があります
  （定格出力 kW・電圧・電流・回転数・流量・揚程・材質・型式・製造年など。電動機の電流は出力と電圧から計算）。
- 寿命のある分類（ポンプ・電動機・インバータ・伝送器・分析計・ろ布・DCS・UPS など）は年数がたつと更新され、古い資産は `DECOMMISSIONED`
  で撤去品置場（`KT-SALVAGE`）へ移り、同じ機能位置に新しい資産が付きます。北部の DCS は 2019 年、南部の DCS は 2026 年に一斉更新。
- 稼働時間・起動回数・クレーン運転回数・発電電力量のメーター（ASSETMETER）と、月 1 回の読み（METERREADING）があります。
- 保全計画（JOBPLAN 49 件、JOBTASK・JOBLABOR・JOBMATERIAL）と PM は、ポンプ 3 か月点検・4 年分解整備、送風機 6 か月点検、電動機の絶縁抵抗測定、
  伝送器の年次校正（CAL）、排ガス分析計の月次校正（CAL）、装置ごとの月例点検（INSP）、炉の定期整備（春・秋、子の作業指示つき）、
  法定点検（【法定】クレーン月例・年次自主検査、ボイラ性能検査、安全弁、受変電設備の月次・年次点検、タービン定期事業者検査、消防用設備、昇降機、計量機）などです。
- 是正保全（CM）・緊急保全（EM）は分類ごとの故障率（初期故障と経年で増える）から作り、故障クラス・問題・原因・処置（FAILURECODE / FAILURELIST、
  作業指示の FAILUREREPORT）を付けます。約半分は運転員のサービス要求（SR）から起票され、SR と作業指示は ORIGRECORDID / RELATEDRECORD でつながります。
- ステータスの履歴（WOSTATUS / TKSTATUS）は日付の順で、WAPPR → APPR →（WMATL）→ INPRG → COMP → CLOSE、一部 CAN。基準日に近いものは未完了です。
- 担当者（PERSON・LABOR）は在籍期間があり、退職者は INACTIVE。作業指示の監督者・リードはその時点に在籍した人です。協力会社の作業責任者もいます。

## 件数

| 表（オブジェクト構造） | KITA | MINAMI | HIGASHI | 組織全体 |
|---|---:|---:|---:|---:|
| LOCATIONS（MXAPIOPERLOC） | 686 | 512 | 505 | |
| ASSET（MXAPIASSET） | 1,224（うち撤去済み 463） | 702（126） | 562（5） | |
| ASSETSPEC / ASSETMETER（MXAPIASSET の子） | | | | 14,045 / 777 |
| PM（MXAPIPM） | 684 | 520 | 514 | |
| WORKORDER（MXAPIWODETAIL・MXAPIWO） | 54,913 | 27,243 | 10,930 | 93,086 |
| WOSTATUS / FAILUREREPORT（MXAPIWODETAIL の子） | | | | 452,271 / 34,034 |
| SR（MXAPISR） | 7,628 | 3,533 | 1,447 | 12,608 |
| METERREADING（MXAPIMETERREADING） | 36,260 | 18,515 | 7,345 | 62,120 |
| INVENTORY（MXAPIINVENTORY） | 132 | 135 | 137 | |
| ITEM / JOBPLAN / CLASSSTRUCTURE / ASSETATTRIBUTE | | | | 183 / 49 / 60 / 107 |
| FAILURECODE / FAILURELIST | | | | 105 / 1,235 |
| PERSON・LABOR / PERSONGROUP / CRAFT | | | | 201 / 15 / 6 |
| MEASUREUNIT / METER / COMPANIES / MAXDOMAIN | | | | 37 / 5 / 32 / 15 |

作業指示の作業タイプ: PM 28,391、INSP 35,845、CAL 12,880、CM 14,067、EM 1,903。
ステータス: CLOSE 86,378、CAN 3,564、COMP 1,960、INPRG 849、APPR 281、WAPPR 45、WMATL 9。

## オブジェクト構造

`MXAPIOPERLOC`（子 LOCHIERARCHY・LOCATIONSPEC）、`MXAPIASSET`（子 ASSETSPEC・ASSETMETER）、`MXAPIWODETAIL`（子 WOSTATUS・FAILUREREPORT）、
`MXAPIWO`（子なし。MXAPIWODETAIL と同じ行）、`MXAPISR`（子 TKSTATUS・RELATEDRECORD）、`MXAPIPM`、`MXAPIJOBPLAN`（子 JOBTASK・JOBLABOR・JOBMATERIAL）、
`MXAPICLASSSTRUCTURE`（子 CLASSSPEC・CLASSUSEWITH）、`MXAPIASSETATTRIBUTE`、`MXAPIMEASUREUNIT`、`MXAPIFAILURECODE`、`MXAPIFAILURELIST`、
`MXAPIMETER`、`MXAPIMETERREADING`、`MXAPIITEM`、`MXAPIINVENTORY`（子 INVBALANCES）、`MXAPIPERSON`、`MXAPILABOR`（子 LABORCRAFTRATE）、`MXAPICRAFT`、
`MXAPIPERSONGROUP`（子 PERSONGROUPTEAM）、`MXAPICOMPANY`、`MXAPIDOMAIN`（子 SYNONYMDOMAIN・ALNDOMAIN）、`MXAPIORGANIZATION`（子 SITE）、`MXAPIINTOBJECT`。

ステータス・作業タイプ・サイト・分類・故障コード・担当者・単位などには値の一覧（getlist）があります。

実機での名前・属性を確かめていないもの（偽の Maximo で試すための仮の形）:

- 構造名: `MXAPIASSETATTRIBUTE`、`MXAPIMEASUREUNIT`、`MXAPIMETERREADING`（実機は MXAPIMETERDATA / MXMETERDATA で読みを入れる）、`MXAPICRAFT`、`MXAPICOMPANY`、
  `MXAPIORGANIZATION`、`MXAPICLASSSTRUCTURE` と `MXAPIFAILURECODE` / `MXAPIFAILURELIST` の子の形
- 子の組み合わせ: MXAPIOPERLOC の LOCHIERARCHY、MXAPISR の TKSTATUS・RELATEDRECORD、MXAPIWODETAIL の WOSTATUS（実機の MXAPIWODETAIL には他にも多くの子がある）
- ドメイン名: `PMSTATUS`、`JOBPLANSTATUS`、`PERSONSTATUS`、`LABORSTATUS`、`CATEGORY`、`DATATYPE`。作業タイプ（WORKTYPE）は実機では表なので、ドメインには入れず値の一覧だけ
- 作業タイプ `INSP`（点検・検査）は Maximo の既定に無い、顧客が足す想定の値

## 仕込んだデータ品質の問題

MX Stage で見つけて直す練習用に、わざと入れてある問題です（件数は 3 施設の合計）。

| ID | 内容 | どこに出るか | 件数 |
|---|---|---|---:|
| SPEC_MISSING_ALL | 分類はあるが仕様（ASSETSPEC）が 1 行も無い | ASSET.ASSETSPEC | 183 |
| SPEC_BLANK_VALUES | 仕様の行はあるが値が空（一部の属性） | ASSETSPEC.ALNVALUE / NUMVALUE | 360 |
| SPEC_UNIT_MIXED | 同じ属性で単位が混在（流量 m3/h と L/min、出力 kW と W、圧力 MPa と kPa） | ASSETSPEC.MEASUREUNITID / NUMVALUE | 46 |
| SPEC_NUMBER_AS_TEXT | 数値の仕様が英数字の欄に単位付きの文字（全角を含む）で入っている | ASSETSPEC.ALNVALUE / NUMVALUE | 94 |
| ASSET_NO_CLASS | 資産に分類が無い | ASSET.CLASSSTRUCTUREID | 16 |
| TAG_FORMAT | タグ番号が命名規則に合わない（小文字・ハイフン無し・炉番号無し） | ASSET.ASSETTAG | 101 |
| TAG_FULLWIDTH | タグ番号・説明に全角英数字が混じる | ASSET.ASSETTAG / DESCRIPTION | 98 |
| TAG_LINE_MISMATCH | タグ番号の炉番号が機能位置の炉と食い違う | ASSET.ASSETTAG / LOCATION | 13 |
| TAG_MISSING | タグ番号が空 | ASSET.ASSETTAG | 46 |
| TRAILING_SPACE | 値の末尾に空白（半角・全角） | ASSET.ASSETTAG / DESCRIPTION、LOCATIONS.DESCRIPTION | 124 |
| DESC_HALFWIDTH_KANA | 説明に半角カナが混じる | ASSET.DESCRIPTION | 54 |
| DESC_LINE_NOTATION | 炉の表記が揺れる（1号炉 / No.1炉 / １号炉） | ASSET.DESCRIPTION / LOCATIONS.DESCRIPTION | 64 |
| SERIAL_PLACEHOLDER | 製造番号が「不明」「-」「N/A」などの仮の値 | ASSET.SERIALNUM | 72 |
| ASSET_NO_INSTALLDATE | 設置日が空 | ASSET.INSTALLDATE | 24 |
| ASSET_DUPLICATE | 同じ機能位置・同じタグの稼働中の資産が二重に登録（説明の表記違い・仕様なし・設置日なし。資産番号 x9xxxxx） | ASSET | 18 |
| DECOM_AT_POSITION | 撤去済みの資産が機能位置に残ったまま | ASSET.LOCATION / STATUS | 61 |
| LOCATION_NO_CLASS | 機能位置に分類が無い | LOCATIONS.CLASSSTRUCTUREID | 105 |
| PM_DECOMMISSIONED_ASSET | PM が撤去済みの資産を指したまま（次回日が過去で止まっている） | PM.ASSETNUM / NEXTDATE | 45 |
| WO_NO_FAILURE_CODE | 是正・緊急保全に故障コードが無い | WORKORDER.FAILURECODE / PROBLEMCODE | 1,980 |
| WO_FREETEXT_ONLY | 故障の内容が件名・長い説明の自由記述だけ（「振動ｱﾘ」「止まった件」など） | WORKORDER.DESCRIPTION / DESCRIPTION_LONGDESCRIPTION | 1,583 |
| WO_PROBLEM_ONLY | 問題コードはあるが故障クラスが空、故障報告も無い | WORKORDER.FAILURECODE / FAILUREREPORT | 769 |
| WO_NO_LABOR_HOURS | 完了した是正保全に実績工数が無い（0） | WORKORDER.ACTLABHRS | 929 |
| WO_LOCATION_MISMATCH | 作業指示の場所が資産の機能位置と違う（装置の場所） | WORKORDER.LOCATION | 495 |
| WO_STALE_OPEN | 半年以上前に着手したまま INPRG で閉じていない | WORKORDER.STATUS / ACTFINISH | 842 |
| SR_NO_ASSET | 資産・機能位置を特定しない運転員の連絡（装置の場所だけ） | SR.ASSETNUM | 3,825 |
| ITEM_DUPLICATE | 同じ部品が別の品目番号・別の表記で重複（Z- で始まる品目） | ITEM | 10 |
| INV_OBSOLETE_STOCK | 廃止の品目に在庫が残っている | INVENTORY.CURBALTOTAL / ITEM.STATUS | 17 |
| INV_MIN_OVER_MAX | 発注点が最大在庫を超える | INVENTORY.MINLEVEL / MAXLEVEL | 9 |

旧台帳から移行した想定の北部・南部に多く、東部は少なめです。件数は `generatePlants().problems` でも取れます。

## 試験

`tests/dev/plants-dataset.test.ts` が、東部の全期間と北部の直近 1 年を作って、場所・親・分類の仕様・PM・作業計画の参照、
作業指示の日付の順序とステータスの履歴、値の一覧に無い値が無いこと、偽の Maximo での読み込み（子・絞り込み・ページ送り・getlist・書き込み後の結果）を確かめます。
