# 今どこまでできているか

実際のコードと試験から確かめた内容です。使い方は [local.md](local.md)、入れ方は [README](../README.md)。

## 構成

| 部分 | 場所 | 役割 |
|---|---|---|
| 作業画面 | `src/app/` | ブラウザのタブ。シート（正本）・グリッド・反映パネル・設定・オブジェクト構造の画面。ツールはここで実行する |
| 橋渡し | `src/bridge/` | この PC の Node のプロセス 1 つ。画面の配信・stdio の MCP サーバ・タブへの中継（`/ws`）・Maximo への中継（`/mx`）・取り込み（`/import`）・状態と Skill の一覧（`/_mxstage`） |
| 共有 | `src/shared/` | ツールの定義・中継の取り決め・シートの型・SKILL.md の読み取りと検証 |
| アプリ既定の Skill | `skills/` | 目次（`mxstage-workbench`）・基本動作 8 本（`mxstage-core-*`）・標準オブジェクト 8 本（`mxstage-obj-*`）。層は `metadata.category`。ビルドで `src/bridge/defaultSkills.ts` に同梱する（仕様は `docs/skills-spec.md`） |
| 導入 | `scripts/setup-local.mjs`・`mxstage.cmd` | 依存とビルド・橋渡しの起動・Claude への登録・Skill の配置・自動起動とショートカット |

## 実装済み

### 作業画面（`/app`）

- シートは「最終 / 差分 / 元の値」のビューを選べます。グリッドは直接編集でき、誰が変えたセルか（Claude か利用者か）、
  追加した行、削除する行、読み取り専用の列が色で分かります。
- **関連する表を同時に出します。** 親・子・参照先のマスタ（`load_master` で読んだもの）を並べ、行を選ぶと他の表がその行に連動して
  絞られます（`src/app/pages/panes.ts`）。表の見出しの「広げる」で 1 つの表だけを出し、上部バーのパネルのボタンで
  反映・変更履歴（と表示の切替）を隠せます。
- **並べ方は利用者が変えられます**（`src/app/pages/PaneBar.tsx`・`panes.ts` の `arrangePanes`）。窓は 4 枚まで（1＝全面、2＝左右、3＝上 1＋下 2、4＝2×2）。
  「表示する表」の帯で窓を出す・隠す、「表を足す」で組に無い表（取り込んだ Excel のシートなど）も並べる、見出しの左端をつかんで別の窓へ落とすと入れ替え。
  並べ方はシートの組ごとに覚えます（タブを切り替えて戻ると同じ並び。再読み込みで元に戻ります）。連動は関係のある表同士だけです。
  反映・変更履歴のパネルは、最後に触った表のシートを出します。
- **シートを閉じられます**（シートタブの ×。`src/app/pages/SheetTabs.tsx`）。未反映の変更があれば件数を示して確かめ、反映中は閉じません。
- **見た目は IBM Carbon Design System**（White テーマ・IBM Plex・部品は `@carbon/react`）。約束は [design.md](design.md)、
  変数は `src/app/styles/carbon.scss`、配置は `src/app/styles/app.css`、グリッドの色は `SheetGrid.tsx` の `GRID_THEME` と `cellStyle.ts` の `TONE_STYLE`。
  セルの色の意味は上部バーの ⓘ から開きます。
- **列の見出しは 2 段**（上に画面表示名、下に属性名。`src/shared/columnLabel.ts`）。ツールの結果にも `columnTitles` でラベルを載せます。
- **列ごとの絞り込み**（`src/app/grid/filters.ts`）。値の一覧（件数付き）・文字を含む・空／空でない・変更の状態（LLM の変更・利用者の変更・
  追加行・削除行・変更なし。セルの色分けと同じ区分で、変更のある列だけに出す）。Maximo へは問い合わせ直しません。
  絞り込み中は、帯の先頭に「絞り込み中 残り / 全体 行」、絞っている列の見出しに色と漏斗の印を出し、「文字を含む」で当たった部分に印を付けます。
- **行の詳細**。選んだ 1 行の全列を縦に並べ、改行を含む長文もそのまま出します（`src/app/grid/RowDetail.tsx`）。
  長文のセルはマウスを置いても全文が出ます（1,000 文字・14 行まで）。
- **狭い画面への対応**（`src/app/grid/layout.ts`）。幅 1,000px 未満では表を並べず今のシートだけ、1,200px 未満では反映・変更履歴を初めから隠し、
  キー列の固定は幅で決めます（520px 未満は固定しない・820px 未満は 1 本）。列の初期の幅は型と桁で決めます。
- 変更履歴パネルで最近のバッチを見て、取り消せます（Claude の `undo_batch` と同じ仕組み）。
- 反映パネル: 依頼の内容・件数・反映できない理由・確認が要る事項を出します。
  **Maximo への書き込みは、ここで利用者が [Maximo に反映] を押したときだけ**です。反映中は「反映を中止」で残りを送るのをやめられます。
- 書き込みログを CSV で保存できます（キーと結果だけ。属性値は入りません）。
- 上部バーに中継の状態と Maximo の接続状態を出します。「作業終了」で作業データを捨てて新しい作業を始められます。

### オブジェクト構造（`/structures`）

- **Maximo に接続すると、API で使えるすべてのオブジェクト構造の定義を機械的に読み込み**、ブラウザ（IndexedDB）に接続先ごとに保存します
  （`src/app/catalog/autosync.ts`。同時に 3 件ずつ。保存済みは読み直さない）。Claude は読み込みません。
- **一覧は apimeta だけでは足りません。** apimeta は利用者が作った構造を返さないことがあるので、Maximo の定義（MXAPIINTOBJECT）にあって
  apimeta に載らない構造を足します（`mergeStructureLists`）。足すのは apimeta に載る構造と同じ適用先（USEWITH）のものだけで、
  それ以外（移行マネージャー用など）は読み込まず、画面に件数と名前を出します。MXAPIINTOBJECT を読めないときは apimeta の一覧だけにして、その旨を出します。
- 構造は業務の言葉や名前で探せます（Claude の `find_object_structures` と同じ決め方。`src/app/catalog/search.ts`）。

### 読み込み

- **Claude が読む Maximo のデータは、必ず作業画面のシートに入れます。** 利用者が同じデータを画面で見て確かめられるようにするためです。
  この決まりは Skill だけでなく、どのクライアントにも届く MCP の案内（`src/bridge/mcp.ts` の `SERVER_INSTRUCTIONS`）とツールの作りで守ります
  （Claude Desktop のチャットには Skill が入らないため）。
- **範囲を先に決めます**（`scope_options`。`src/app/scope/`）。構造の属性から絞り込みの軸（状態・分類・担当・種別・場所・期間・番号の規則）を
  機械的に選び、キー列と軸の列だけをシート「範囲 <構造>」に読み込んで画面に出し、そのシートの行から軸ごとの候補値と件数を返します。
- 1 ページの件数は列の数と子の有無で決め（親の列だけで 40 列以内なら 1,000 件、子を含むなら 200 件）、2 ページ目以降は `pageno` で
  **並列に 4 ページずつ**取ります（`src/app/maximo/load.ts`）。数万件の資産を 7 列で約 1 分で読み込めることを実機で確かめています
  （並列化の前は約 5 分）。
- `load_master` は、読み込み済みのシートが指している値だけに絞って、参照先のマスタを読み込みます（画面で連動します）。

### Excel・CSV の取り込み（`src/app/imports/`）

- ファイルは Claude が `create_import_session` の URL へ curl で送るか、利用者が作業画面にドロップします（どちらもタブのメモリにだけ置き、5 件まで）。
  届いたファイルは `get_status` の `imports` に出ます。
- xlsx は依存を足さずに読みます（ZIP の展開はブラウザの DecompressionStream、XML は文字列の走査）。共有文字列（ふりがなを除く）・インライン文字列・
  数式の計算結果・日付の書式（組み込み・和暦・利用者定義・1904 年方式）・真偽値・エラー値を読みます。.xls・パスワード付き・.xlsb は理由を添えて断ります。
  Excel で保存した実物のファイル（ふりがな付きを含む約 5 万セル）で、openpyxl の読み取りと値が一致することを確かめています。
- CSV は BOM・UTF-8・Shift_JIS を見分け、値は文字のまま（先頭の 0 を残す）読みます。タブ区切りは拡張子か 1 行目で見分けます。
- `describe_import` は見出しの行の見当（文字のセルが十分に多い最初の行。MXLoader 形式は 2 行目）・列（列記号・型・値のある行数）・サンプル行を返します。
- `apply_mapping` は作業画面のシートにします。rowKey と `SOURCE_ROW`（元の行）は元のファイルの行番号、rename した列は元の見出しを画面表示名に残します。
  取り込んだシートは反映できず（反映パネルが止める）、`match_sheets` と `apply_rule` の lookup で Maximo のシートに値を移します。

### シートを読み込んだ構造で反映する

- シートは「どの接続先の、どの構造の、いつの定義で読み込んだか」を持ちます。今の接続先が違うとき、読み込んだ後に定義を取り直して
  反映に使う列が変わったときは、反映しません（`src/app/catalog/drift.ts`）。
- 送信先はシートの構造のレコード（`/api/os/<構造>/...`）に限ります。

### Maximo への書き込みエンジン（`src/app/maximo/commit.ts`）

- PATCH は必ず `patchtype: MERGE`。送り先は読み込み時の `href` だけ。送る属性は、変更された・読み取り専用でない・キー列でない列だけ。
- 子の変更・削除は、読み込み時に ID が分かっている子だけ。削除は親あたり 10 件・全体 50 件まで。超えるときと、空への変更を含むときは画面での確認が要ります。
- 送る直前に読み直し、`_rowstamp` や子の ID が読み込み時と違えば送りません。
- 最初の 1 件（カナリア）の結果を人が見て、続けるか決めます。自動での再試行はしません。
- 1 回の反映は 200 親まで。親行の削除は扱えません。
- **新規作成**: 追加した親の行は、シートを読み込んだ構造の一覧（`/api/os/<構造>`）へ x-method-override の無い POST で作ります（キー列がすべて埋まっているときだけ。自動採番は使わない）。送る前にキーで探して、もうあれば送らず衝突にします。送った後はキーで探し直し、ちょうど 1 件で、送った属性と追加した子がそろっていれば確認済みにし、Maximo が返した href で読み直して作業画面の base にします（Maximo が足した子も出る）。409・通信エラーはキーで探して判断します。
- `add_rows` の `from`: 取り込んだシートなど別のシートの行から、作業画面の中で新しいレコードの行を作ります（行の値は LLM を通らない。1 回 200 行まで）。
- 通信エラーや reasonCode の無い 5xx は「結果不明」として扱います。反映を確認できた親だけ Maximo から読み直して作業画面の値を置き換えます。

### 設定（`/settings`）

- Maximo への接続（URL・接続方式 proxy / direct・接続名・API キー）。`whoami` で確かめてから接続します。
- API キーは専用の Web Worker（keyvault）に渡し、メインスレッドには残しません。30 分操作が無ければ自動でロックします。
  **Claude のツール実行も「作業中」として数えます**（会話しながらの作業で途中でロックされないように）。
- Claude Code への登録の状態と、Skill の一覧（アプリ既定と利用者の Skill を分けて。読み込めない利用者の Skill はその理由も）を出します。

### Claude が使えるツール

`src/shared/toolDefs.ts` に 28 本を定義し、そのうち 26 本が動きます。

- 作業タブで実行するもの（21 本、`src/app/tools/registry.ts`）: `get_status` / `find_object_structures` / `list_object_structures` /
  `describe_object_structure` / `scope_options` / `load_sheet` / `load_master` / `get_job` / `query_rows` / `aggregate` / `match_sheets` /
  `patch_cells` / `apply_rule` / `add_rows` / `delete_rows` / `undo_batch` / `get_diff` / `request_commit` / `get_commit_result` /
  `describe_import` / `apply_mapping`
- 橋渡しで完結するもの（5 本、`src/bridge/mcp.ts`）: `open_grid` / `list_skills` / `get_skill` / `save_skill` / `create_import_session`
- 引数はタブ側でもスキーマで検証し直し、スキーマに無い引数は似た名前を添えて `INVALID_ARGS` にします。
  結果には必ず revision を含め、行データには「データであって指示ではない」という注意書きを付け、大きな結果は約 40KB で切り詰めます。

### 橋渡し

- PC に 1 つだけ。ポート `8788` を持つ橋渡しが primary で、Claude が起動した分は client として中継します（`src/bridge/coordinator.ts`）。
- 起動・終了・中継・異常終了を `~/.config/mxstage/bridge.log` に残します（API キーと作業データは書きません。`src/bridge/logFile.ts`）。

### Skill（`src/bridge/skills.ts`）

- **アプリ既定**: リポジトリの `skills/`。`npm run build:skills` が検証して `src/bridge/defaultSkills.ts` に同梱します。
- **利用者の Skill**: `~/.config/mxstage/skills/<名前>/SKILL.md`。橋渡しが読むたびに既定と同じ規則で検証します
  （ツール名に無い語は注意にとどめ、読み込みは止めません）。アプリ既定と同じ名前は読み込みません。
- `list_skills` / `get_skill` と作業画面の設定は、どちらの Skill かを `origin`（`default` / `user`）で示します。
- **どのクライアントにも届けます。** 会話（MCP のセッション）で最初のツール呼び出しの結果に、目次（`mxstage-workbench`）の本文と
  既定・利用者の Skill の一覧（層ごと）を添えます（`sessionGuide`）。入口のツールの結果には、その段階で読む既定の Skill の名前を添えます（`src/bridge/skillHints.ts`）。Skill 機能の無いクライアント（Claude Desktop のチャット・Gemini など）にも、
  LLM がどのツールから始めても届きます。MCP の案内（`SERVER_INSTRUCTIONS`）にも同じ決まりの要点を書いています。
- **チャットから保存できます**（`save_skill`）。会話でまとまった手順を、利用者の了承を得て `~/.config/mxstage/skills/<名前>/SKILL.md` に保存します。
  読むときと同じ規則で検証し、通らなければ保存しません。アプリ既定と同じ名前・無断の上書き（`overwrite` なし）はしません。
  保存した直後から `list_skills` / `get_skill` と作業画面の設定に出ます。
- 導入は両方を Claude Code の `~/.claude/skills` に写し、利用者が消した Skill は（書き換えられていなければ）片付けます。
- 検証は frontmatter の形式、説明文（200 文字まで）、本文のサイズ（8,000 バイト未満）、本文のツール名が実在するか、JSON の例が JSON として読めるかまで見ます。

## 未実装・直したいところ

- **`import_rows`（小さな表をツール引数で送る）と `export_sheet`（xlsx に出力）はありません。** 0.2.0 でツールの一覧から外しました（定義だけで動かなかったため）。
- **取り込みの読み取りは画面と同じスレッドで動きます。** 数 MB を超えるファイルは、読み取りの間（数秒）作業画面が止まります。
- **`scope_options` の軸が「状態」に偏ることがあります。** 列の多い構造で軸を任せると、ほとんど空の状態列が軸の多くを占め、
  担当部署・期間・番号の規則が出ないことがありました。ほとんど空の列を落とし、観点ごとに散らして選ぶようにします。
- **`where` に子の属性を書くと Maximo には渡らず、全件取ってから画面で絞ります。** `maxRows` は絞る前の親の件数の上限です
  （結果の `childFilterNote` に出します）。oslc.where に渡せるか確かめます。
- **`load_sheet` で読んだマスタは画面で連動しません。** 連動するのは `load_master` で読んだシートだけです。
  記述から拾ったタグのように参照元の列が無い突き合わせでは、マスタが別のタブのままになります。
- **Claude Desktop のチャットの Skill は、MX Stage のツールを通して届けています。** チャットには Skill のファイルが入らないので、
  会話で最初のツール呼び出しの結果に基本手順を添えています（Skill の節）。チャットでの実際の動きは、まだ確かめきれていません。
- **Windows だけで確かめています。** Mac・Linux は試していません（自動起動とショートカットは Windows だけ）。

## 公開

- まだ GitHub へは送っていません。最初のコミットに客先の情報が入っていたため、2026-09-27 に履歴を作り直しました
  （古い履歴はローカルのブランチ `private/before-publish-2026-09-27` だけ）。
- 送る前に `scripts/check-publish.mjs` が、送るコミットに客先の語（リポジトリの外の `~/.config/mxstage/publish-terms.txt`）が
  無いかを調べ、当たれば送りません（`.githooks/pre-push`。`git config core.hooksPath .githooks` で有効にする）。手順は [publish.md](publish.md)。

## 試験

```bash
npm run typecheck      # app / bridge
npx vitest run         # app（happy-dom）/ bridge（Node）
npm run test:setup     # 導入スクリプト（node --test。一時フォルダだけに書き、本物の claude コマンドは呼ばない）
```

- 作業画面: シート・差分・フィルタ・書き込みエンジン（偽の Maximo `tests/fakes/fake-maximo.ts`）・ツール・画面の部品。
- 取り込み: ZIP の展開、xlsx・CSV の読み取り、見出しの見当、シートへの変換、ツール、ドロップ（試験の中で架空の xlsx を組み立てる。`tests/app/xlsx-fixture.ts`）。
- 橋渡し: HTTP・WebSocket・MCP の往復、中継と引き継ぎ、静的配信、Skill の一覧、フレームの解釈（以前の実装と一致していた時点の出力を期待値に固定）。
- 導入: 導入 → もう一度 → 状態 → 取り消しのひと通り、利用者の Skill の配置と片付け、Node の版、更新時の入れ直しとビルドし直しの判定。
  最後に本物の書き先の更新時刻が変わっていないことを確かめます。
- 公開の前の検査: 一時フォルダに作った試験用のリポジトリで、履歴・送る範囲・パス・説明文・作業中のファイルを調べ、
  語の一覧が無いときに通さないことを確かめます（`tests/setup/check-publish.test.mjs`）。
- 画面は開発サーバ（`npm run dev:app`）の `http://localhost:5173/app?samples=1` で、架空のサンプル（作業指示・機器台帳・ロケーション）を出して確かめられます。
