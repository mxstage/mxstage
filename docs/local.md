# 使い方（入れる・毎日・更新・取り消し）

MX Stage は **この PC の中だけ**で動きます。画面（作業画面）も、Claude との MCP 接続も、Maximo への中継も、
**橋渡し**（この PC で動く Node のプロセス）が引き受けます。

**橋渡しは 1 つだけ**です。ポートは `8788` に固定で、作業画面も Claude Code も、その 1 つを共有します。

- 最初に起動した橋渡しが `8788` を持ちます（ログイン時の自動起動、導入したその場での起動、または Claude が起動したもの）。
- あとから起動した橋渡し（Claude Code が MCP サーバとして起動する分）は、自分ではポートを持たず、`8788` の橋渡しに**中継**します。
- 橋渡しは `http://127.0.0.1:8788/_mxstage/health` に `{"name":"mxstage-bridge", …}` と応えます。導入と `--status` はこれで確かめます。

ログインもトークンもありません（`127.0.0.1` に来られる＝この PC の利用者、として扱います）。
Maximo の API キーは、設定で「この PC に保存」を選ぶと、橋渡しが AES-256-GCM で暗号化して `~\.config\mxstage\connections.json` に置きます
（暗号化の鍵は Windows のデータ保護（DPAPI）で包んで `connections.key` に置く。作業画面には渡しません）。
保存しないで接続したときは**ブラウザの作業タブの中**にだけ置き、橋渡しには呼び出しごとにヘッダで渡すだけで、ディスクにも設定ファイルにもログにも書きません。

---

## 1. 入れる

**Claude Code（Claude Desktop の Code タブでもよい）に、リポジトリの URL と「インストールして」と伝えます。**
Claude Code は README の「導入手順（Claude Code 向け）」に沿って、取得（`%USERPROFILE%\mxstage`）と導入
（`node scripts/setup-local.mjs --json`）を行います。コマンドごとに確認が出ます。

手で入れるときは、取得したフォルダで次のどちらかを実行します（中身は同じです）。

```
node scripts/setup-local.mjs
.\mxstage.cmd
```

`mxstage.cmd` はダブルクリックでも動き、最後に入力待ちで止まります。コマンドプロンプトからは `.\` を付けてください
（`NoDefaultCurrentDirectoryInExePath` が有効な PC では、付けないと見つかりません）。
`node scripts/setup-local.mjs --help` で全オプションが出ます。

終わったら **Claude Code を終了して開き直してください**（新しいセッションからツールと Skill が使えます）。
Claude Desktop が入っていれば（設定フォルダがあれば。Microsoft Store 版を含む）そちらにも登録されるので、Claude Desktop を使っているならそちらも開き直します
（タスクトレイのアイコンから終了します。ウィンドウの × では終わりません）。Claude Desktop に拡張機能（`.mcpb`）の MX Stage を入れて有効にしているときは、
設定ファイルには登録しません（同じ MX Stage が二重に出ないように。前にこの導入が書いた分は外します）。
Antigravity（2.0・IDE・`agy` CLI）が入っていれば（`~\.gemini` があれば）そちらにも登録されます。新しい会話からツールと Skill が使えます
（`agy` CLI は Skill のファイルを別の場所から読むので、基本手順はツールの結果で届く分だけです。2 章の「Skill」）。
Codex（ChatGPT デスクトップアプリの Codex・CLI・IDE 拡張）が入っていれば（`~\.codex` があれば）そちらにも登録されます。Codex を開き直すと、新しい会話からツールと Skill が使えます。
IBM Bob が入っていれば（`~\.bob` があれば）そちらにも登録されます。IBM Bob を再起動すると、ツールと Skill が使えます。
環境ごとの設定ファイルと、画面のどこで確かめるかは README の「環境ごとの置き場所」にまとめています。

### 何が起きるか（何度実行しても壊れません）

| 手順 | 内容 |
|---|---|
| Node の版 | 22.6 未満なら**何も書き換えずに止まります**（橋渡しは `--experimental-strip-types` で `.ts` をそのまま動かすため） |
| 依存とビルド | `node_modules` が無いか、`package-lock.json` の方が新しければ `npm install`。`dist\app` が無いか、画面と Skill のもと（`src\app`・`src\shared`・`skills`・`public`・`vite.config.ts`・`package-lock.json`）の方が新しければ `npm run build` |
| ポート | `8788` を使います。**ずらしません。** 既に橋渡しが動いていればそれを使います。橋渡しではない別のプログラムが `8788` を使っているときは、**何も書き換えずに NG で止まります**（そのプログラムを止めるか、`--port <番号>` で別の番号を指定します） |
| 橋渡しの起動 | `node --experimental-strip-types src\bridge\cli.ts --no-mcp --port 8788` を裏で起動し、応えるまで（最大 20 秒）待ちます。`--no-mcp` は「画面と中継だけで、stdio の MCP は開かない」という意味です。ウィンドウは出しません。既に橋渡しが動いていれば起動し直しません |
| Claude Code | `~\.claude.json` の `mcpServers.mxstage` に登録（`claude mcp add --scope user MX Stage -- <node> --experimental-strip-types <入口> --port 8788` と同じ内容）。**Claude Desktop に拡張機能（`.mcpb`）の MX Stage が入っていて有効なら登録しません**（Claude Desktop の Code タブは拡張機能から MX Stage を受け取るので、両方にあるとツールが二重に出ます）。前にこの導入が書いた分は控えを取ってから外し、利用者が手で書いたものは残して警告します。ターミナルの Claude Code でも使うときは `--claude-code`（記録に残り、次回からも登録します。`--uninstall` で消えます）。`--no-claude-desktop` のときは Claude Desktop を見ないので、これまでどおり登録します。Skill は拡張機能では入らないので、いつもどおり写します |
| Claude Desktop | 設定フォルダがある置き場所すべての `claude_desktop_config.json` の `mcpServers.mxstage` に登録します。ふつうの版は `%APPDATA%\Claude\`、Microsoft Store 版（MSIX）は `%LOCALAPPDATA%\Packages\Claude_<発行元 ID>\LocalCache\Roaming\Claude\`（パッケージが `%APPDATA%` に新しく作るフォルダはここへ振り替えられます。`%APPDATA%\Claude` が先にあればそちらが使われます）。どちらの設定フォルダも無ければ（入れていない・一度も起動していない）何も作りません。その置き場所に**拡張機能（`.mcpb`）の MX Stage が入っていて有効なら登録せず**、前にこの導入が書いた `mxstage` を外します（拡張機能は同じ設定フォルダの `Claude Extensions\<id>\`・`Claude Extensions Settings\<id>.json` の `isEnabled`・`extensions-installations.json` で見分けます。利用者が手で書いた `mxstage` は残して警告します）。登録しないときは `--no-claude-desktop` |
| Antigravity | `~\.gemini` があるときだけ、`~\.gemini\config\mcp_config.json` の `mcpServers.mxstage` に登録（2.0・IDE・`agy` CLI が同じファイルを読みます）。無ければ何も作りません。登録しないときは `--no-antigravity` |
| Codex | `~\.codex`（`CODEX_HOME` があればそこ）があるときだけ、`config.toml` に `[mcp_servers.mxstage]` の表を 1 つだけ足します（デスクトップ・CLI・IDE 拡張が同じファイルを読みます。ほかの行・コメントには触りません）。表ではない書き方の MX Stage があれば触りません。登録しないときは `--no-codex` |
| IBM Bob | `~\.bob` があるときだけ、`~\.bob\settings\mcp.json` の `mcpServers.mxstage` に登録（Claude Desktop と同じ stdio の形）。無ければ何も作りません。登録しないときは `--no-bob` |
| Skill | アプリ既定（リポジトリの `skills\`）と利用者の Skill（`~\.config\mxstage\skills\`）を `~\.claude\skills\<名前>\SKILL.md` に写す（2 章の「Skill」）。Antigravity に登録したときは `~\.gemini\config\skills\<名前>\SKILL.md`（2.0・IDE が読む場所）、Codex に登録したときは `~\.agents\skills\<名前>\SKILL.md`、IBM Bob に登録したときは `~\.bob\skills\<名前>\SKILL.md` にも写す。以前の導入が `~\.gemini\skills` に写した分は、書き換えられていなければ片付けます。入れないときは `--no-skills` |
| 自動起動 | スタートアップに `mxstage-bridge.lnk`（最小化で橋渡しを起動） |
| ショートカット | デスクトップに `mxstage.lnk`（Chrome か Edge の**アプリ窓**で `/app` を開く。どちらも無ければ `mxstage.url` で既定のブラウザ） |
| 橋渡しの確認 | 最後に `/_mxstage/health` に聞き、「橋渡しが 1 つ動いています」と出します。古い版の橋渡しや、取り決めの版（`protocol`）が違う橋渡しが動いていれば警告します |
| 記録 | `~\.config\mxstage\setup.json`（ポート・入口・置き換える前の設定の控えの場所。秘密は書きません） |
| 最後に | 作業画面を開きます（`--no-open` で開かない） |

`--port <番号>` で番号を指定したときは、その番号を記録し、次に `--port` なしで実行したときも引き継ぎます。

**書き換える前に必ず控え（バックアップ）を取ります。** 控えは `~\.config\mxstage\backup\` に
`<元のファイル名>.<日時>.bak` の名前で置かれ、画面にもその場所が出ます。控えは消しません。
控えは元の設定ファイルの**まるごとの写し**なので、元のファイルに入っていたトークンも含みます。要らなくなったら手で消してください。

**既にある設定は消しません。** `mcpServers` の中の**ほかのサーバはそのまま**で、`mxstage` の 1 ブロックだけを足します。
`mxstage` という名前の設定が既にあるときは置き換え、置き換える前の設定が何だったかで扱いを分けます。

| 置き換える前の `mxstage` | 取り消し（`--uninstall`）で戻す先として記録するか | 画面 |
|---|---|---|
| 利用者の設定（別の方法で登録していたもの） | **記録する**。取り消しで控えから元に戻る | `[警告] 置き換えた前の設定（値は伏せています）: …` |
| 前回この導入が書いた設定 | 記録しない | `[OK  ] …前回この導入が書いたものなので、…戻す先としては記録しません。` |
| **壊れた登録**（`command` や `args` が指すファイルが無い） | **記録しない**（取り消しで動かない設定に戻さないため） | `[警告] …指しているファイルが見つからないので…` と、控えの場所 |

画面と記録（`setup.json`）には、置き換えた設定を**値を伏せた要約**でだけ出します（ヘッダ・環境変数の値、URL のクエリ、
トークンらしい部分は `<伏せ>` になります）。設定ファイルが壊れていて JSON として読めないときは、**何も書かずに NG を出して止まります**。

---

## 2. 毎日の使い方

1. **作業画面**: デスクトップの `mxstage` を開く（または `http://127.0.0.1:8788/app`）。ここが正本です。開いていないと Claude のツールは動きません。
2. 設定画面で Maximo につなぐ（API キーはここで入れます）。「この PC に保存」を選ぶと、橋渡しが API キーを OS の保護付きで
   暗号化して `~/.config/mxstage/connections.json` に保存し（鍵は Windows は DPAPI、macOS はキーチェーン）、次からはどの窓で開いても
   自動でつながります。接続先が複数あれば、設定の「保存した接続先」で選んで切り替えます。保存しないときは、キーはタブのメモリにだけ置きます。
3. **Claude Code に指示する。** ツール（`mxstage` の MCP）は自動でつながり、この作業画面に届きます。
4. Maximo への書き込みは、作業画面の [Maximo に反映] を押したときだけです。

`localhost` と `127.0.0.1` はブラウザでは別のサイトとして扱われます（保存した設定やパスワードマネージャーの記憶が分かれます）。
ショートカットと `open_grid` は `127.0.0.1` を使うので、**`127.0.0.1` にそろえてください**。

### オブジェクト構造（作業画面の設定）

作業画面は **Maximo に接続すると、API で使えるすべてのオブジェクト構造の定義（キー列・子オブジェクト・属性の名前・日本語ラベル・型・桁・必須）を
自動で読み込み**、ブラウザに保存します（Claude の操作は要りません。数百件で数分ほど）。進み具合は上部の「オブジェクト構造」に出ます。

- 対象は、Maximo の API の一覧（apimeta）に、**apimeta に載らない構造（利用者が作った構造など）を Maximo の定義（MXAPIINTOBJECT）から足したもの**です。
  apimeta には利用者が作った構造が載らないことがあるためです。
- 移行マネージャー用など、API では使えない適用先の構造は読み込みません。画面に「Maximo に定義された N 件のうち API で使える M 件」と出ます。
- API キーの利用者に MXAPIINTOBJECT を読む権限が無いと、apimeta に載る構造だけになります（画面に理由が出ます）。
- Claude には、構造名やテーブル名を言わずに、扱いたいデータを業務の言葉で頼めます。
  Claude は保存した構造からその言葉に当たる候補（構造と属性のラベル）を探し、あなたに確かめてからシートを読み込みます。
- シートは読み込んだ構造と接続先を覚えていて、Maximo への反映もその構造に対して行います。
  別の接続先に接続し直したときや、構造の定義が変わって反映に使う列が変わったときは、反映パネルが止めます（読み込み直してください）。
- 保存は Maximo の接続先ごとです（ブラウザの IndexedDB。API キーと行データは入れません）。

### 表の並べ方と絞り込み

- シートタブを選ぶと、そのシートと関係のある表（子・参照先のマスタ）が自動で並びます（4 枚まで。4 枚は 2×2）。
- 表の上の「表示する表」で、表を出す・隠す。「表を足す」で関係の無い表（取り込んだ Excel など）も同じ画面に並べられます。
- 表の見出しの左端（⠿）をつかんで別の表へ落とすと、位置を入れ替えます。
- 表と表の境目をつかむと、幅と高さを変えられます（ダブルクリックで半分ずつに戻ります。再読み込みすると元に戻ります）。
- セルの編集は、ダブルクリック・Enter・そのまま文字を打つ、のどれかで始めます。選んでいるセルをもう一度押すと選択が外れ、ほかの表の連動も外れます。
- 左端に固定するのは行を見分ける列（WONUM・ASSETNUM・TICKETID など）です。ほかの列は、列の見出しのメニューの「左に固定」で固定できます（3 列まで）。
- 要らなくなったシートは、シートタブの × で閉じます（未反映の変更があれば確かめます）。
- 列の見出しを押すと絞り込めます。値・文字のほか、「変更の状態」（LLM の変更・利用者の変更・追加行・削除行・変更なし）でも絞れます。

### Excel・CSV と突き合わせる

手元の Excel（.xlsx・.xlsm）や CSV の内容に合わせて Maximo のデータを直せます。

1. **ファイルを渡す。** Claude Code のチャットにファイルを添えて頼みます。Claude がファイルの場所を分かれば、自分で作業画面へ送ります。
   分からないと言われたら、**開いている作業画面にファイルをドロップ**してください（新しいタブで作業画面を開き直すと、そちらが作業の対象に替わるので開き直さない）。
2. **Claude が中身を確かめます。** シート・見出しの行・列・件数を示すので、どのシートの何行目が見出しかを確かめて答えます（MXLoader 形式のファイルは 2 行目の属性名を見出しにします）。
3. **作業画面にシートとして出ます。** 列名は Maximo の属性名にそろえられ、元の見出しは画面表示名として残ります。「元の行」の列は元のファイルの行番号です。
4. **Claude が Maximo のシートと突き合わせ、値を移します。** あとは通常と同じく、差分を確かめて反映パネルで承認します。取り込んだシート自体は Maximo へ反映できません。

- 読めるのは .xlsx・.xlsm と CSV・TSV（UTF-8・Shift_JIS）です。.xls（Excel 97-2003）・パスワード付き・.xlsb は、Excel で .xlsx として保存し直してください。
- 1 ファイル 20MB まで、1 シート 20 万行・500 列までです。数式のセルは Excel が保存した計算結果を読みます。
- 受け取ったファイルは作業画面のメモリにだけ置きます。作業画面を再読み込みするか作業終了で消えます。

### Skill（作業手順書）

Claude に MX Stage の使い方を教えるファイルです。**アプリ既定**と**利用者の Skill** に分けています。

| | 置き場所 | 中身 |
|---|---|---|
| アプリ既定 | リポジトリの `skills\`（目次の `mxstage-workbench`、基本動作の `mxstage-core-*`、標準オブジェクトの `mxstage-obj-*`） | どの業務にも共通の決まり、基本動作、Maximo の標準オブジェクトごとの振る舞い。MX Stage と一緒に置き換わるので、書き換えないでください |
| 利用者の Skill | `~\.config\mxstage\skills\<名前>\SKILL.md` | 業務や客先ごとの手順。MX Stage を更新しても消えず、リポジトリにも入りません |

- **どの LLM クライアントでも使えます。** Claude Code・Claude Desktop のチャット・Gemini など、MX Stage をつないだクライアントには、
  会話で最初にツールを使ったときに基本手順と利用者の Skill の一覧が届きます（クライアント側の Skill の設定は要りません）。
- **チャットから Skill を作れます。** 作業の途中で「この手順を Skill として残して」と頼むと、LLM が名前・説明・本文を示して確かめたうえで、
  `~\.config\mxstage\skills\` に保存します。次の会話から使えます（既にある Skill を書き換えるときも確かめます）。
- 導入のたびに、両方を Claude Code の `~\.claude\skills\` に写します。利用者の Skill を手で足したり直したりしたら、導入をもう一度実行すると Claude Code の Skill 機能にも載ります。
- 利用者の Skill を消してから導入すると、前に写したもの（書き換えていなければ）も `~\.claude\skills\` から消えます。
- アプリ既定と同じ名前の利用者の Skill は入れません（`[警告]` が出ます）。frontmatter の `name` はフォルダ名と同じにします。
- 作業画面の設定の「Skill」に、アプリ既定と利用者の Skill が分かれて出ます。読み込めない利用者の Skill はその理由も出ます。
- Claude Code は新しいセッションから読みます。

### 橋渡しの起動と、Claude が起動した橋渡し

橋渡しはログイン時に自動で起動します（最小化された「node」のウィンドウが 1 つ残ります）。
導入したその場で起動した橋渡しはウィンドウを出しません。

Claude が先に起動して橋渡しを立てると、その橋渡しがポートを持ちます。その状態で Claude を終了すると、
ポートを持っていた橋渡しも終わります。ほかに Claude が起動した橋渡しが動いていれば、それが約 2 秒ごとに確かめてポートを引き継ぎます。
**何も動いていなければ、作業画面はつながらなくなります。** そのときは導入をもう一度実行するか、スタートアップの `mxstage-bridge.lnk` を実行してください。

いまの状態を見るには（**何も書き換えません**）:

```
node scripts/setup-local.mjs --status
```

---

## 3. 更新する

Claude Code に「MX Stage を更新して」と頼むか、手で次を実行します。

```
git pull --ff-only
node scripts/setup-local.mjs
```

導入は、依存と画面が古ければ入れ直し・ビルドし直します（1 章の表）。**ただし、既に動いている橋渡しは起動し直しません**
（画面に「これを使います（起動し直しはしません）」と出ます）。橋渡しが古いまま動いていると、新しいツールや修正が効きません。
**更新のあとは Claude Code と Claude Desktop を終了して開き直してください。** Claude が起動した橋渡しは Claude と一緒に終わり、
開き直したときに新しいコードで立ち上がります。

それでも古い橋渡しが残るとき（手で起動したものなど）は、止めてから入れ直します。

```
（Claude Code と Claude Desktop を終了する）
node scripts/setup-local.mjs --uninstall
node scripts/setup-local.mjs
```

取り決めの版（`protocol`）が上がる更新のあと、古い橋渡しが動いたままだと
`[警告] ポート 8788 で動いている橋渡しは、このリポジトリの橋渡しと取り決めの版が違います` と出ます。上の手順で入れ直してください。

### 古くなっているものの知らせ

動いているものは、更新しても古いままです。そこで、古くなっているものと直し方を 2 か所で知らせます（`src/bridge/freshness.ts`）。

- **LLM へ**: `get_status` の結果（`updates`）と、会話で最初のツール呼び出しの結果に `【MX Stage の更新】` として添えます。
  どのクライアント（Claude Code・Claude Desktop・Antigravity など）にも届き、LLM が利用者に伝えます。
- **利用者へ**: `node scripts/setup-local.mjs --status` の `[警告]` の行。

| 知らせ | 何が古いか | 直し方 |
|---|---|---|
| この会話の MX Stage | 会話の MCP を話す橋渡しのコード（`src/bridge`・`src/shared`・`package.json`）が、起動したあとに変わった | 会話を始め直す（Claude Desktop は再起動） |
| 中継している橋渡し | ポートを持つ橋渡しのコードが、起動したあとに変わった（`/_mxstage/health` の `stale`） | その橋渡しを止めて起動し直す |
| 作業画面のビルド | `dist/app` が元（`src/app`・`skills` など）より古い | 導入をもう一度実行して、作業画面を再読み込み |
| Skill の写し | 配った写し（`~\.claude\skills`・`~\.gemini\config\skills` など）が、元（`skills\` と利用者の Skill）と中身が違う・まだ無い | 導入をもう一度実行して、新しい会話から使う |

コードは中身で比べるので、更新時刻が変わっただけでは知らせません。写した先は導入の記録（`setup.json` の `skillDirs`）から読みます。

---

## 4. 取り消す（全部戻す）

Claude Code に「MX Stage をアンインストールして」と頼むか、手で次を実行します。

```
node scripts/setup-local.mjs --uninstall
```

- 橋渡しを止めます。記録にあるポートで待ち受けているプロセスのうち、**コマンドラインに橋渡しの入口の絶対パス**と `--no-mcp` が
  含まれるものだけを止めます。ファイル名が同じだけの別のプロセスは止めません。
- ポートを持っているのが Claude の起動した橋渡し（`--no-mcp` の無いもの）なら、**止めずに**警告します
  （Claude の中で使っている最中のツールを、Claude に知らせずに切らないためです。Claude を終了すると止まります）。
- Claude Code / Claude Desktop（Microsoft Store 版を含む）/ Antigravity / Codex / IBM Bob の設定から `mxstage` を外します。**置き換える前の利用者の設定があれば、控えから読み直して元に戻します。**
  ほかの MCP サーバとほかの設定には触りません。
- スタートアップとデスクトップのショートカットを消します。
- この導入が入れた Skill（`~\.claude\skills\<名前>`・`~\.gemini\config\skills\<名前>`・`~\.agents\skills\<名前>`・`~\.bob\skills\<名前>`。以前の導入のまま取り消すときは `~\.gemini\skills\<名前>`）を消します。**書き換えられている Skill は残します。**
  **利用者の Skill の元（`~\.config\mxstage\skills\`）は消しません。**
- 記録（`setup.json`）を消します。**控え（`backup\`）は残します。**

**一部だけやめる**こともできます。

| やめたいこと | やり方 |
|---|---|
| ログイン時の自動起動だけ | スタートアップの `mxstage-bridge.lnk` を**消すだけ**（`shell:startup` で開くフォルダ） |
| デスクトップのショートカットだけ | `mxstage.lnk`（または `mxstage.url`）を消すだけ |
| Claude Code からだけ外す | `claude mcp remove --scope user mxstage` |
| 今すぐ橋渡しを止める | 自動起動の分は、最小化されている「node」のウィンドウを閉じる。ウィンドウの無い分は、タスクマネージャーの「詳細」タブで、コマンドラインに `src\bridge\cli.ts` を含む `node.exe` を終了する（コマンドラインの列は、列の見出しを右クリック →「列の選択」で出します）。または `node scripts/setup-local.mjs --uninstall` |

---

## 5. うまくいかないとき

### ツールが「作業画面を開いてください」と返す

`node scripts/setup-local.mjs --status` で状態を見ます。

| 出た行 | 意味と直し方 |
|---|---|
| `[OK  ] ポート 8788 で橋渡しが 1 つ動いています` | 橋渡しは動いています。**作業画面のタブが開いていない**だけです。デスクトップの `mxstage` を開いてから、もう一度頼んでください |
| `[警告] …取り決めの版が違います` | 更新前の橋渡しが動いたままです。3 章の手順で入れ直してください |
| `[警告] ポート 8788 で橋渡しは動いていません` | 導入をもう一度実行するか、スタートアップの `mxstage-bridge.lnk` を実行してください |
| `[警告] ポート 8788 には MX Stage の橋渡しではないものが応えています` | 別のプログラムが `8788` を使っています。下へ |

### 「ポート 8788 を、MX Stage の橋渡しではないプログラムが使っています」と出る

橋渡しは Claude と同じポートを共有するので、**別のポートへはずらしません**。この表示のときは何も書き換えていません。
そのプログラムを止めてから入れ直すか、空いている番号を指定して入れ直します（`node scripts/setup-local.mjs --port 8900`。
Claude の設定・自動起動・ショートカットもその番号で作られ、次からは `--port` を付けなくてもその番号を使います）。

### 「橋渡しが 20 秒たっても応答しません」「橋渡しが起動してすぐに終了しました」と出る

画面に、橋渡しを手で起動するコマンドが出ます。そのまま実行すると理由が読めます。橋渡しのログ
（`~\.config\mxstage\bridge.log`）にも残ります。よくある原因は `dist\app` が無いこと（`npm run build` を実行してから、もう一度）です。

### Claude Code にツールが出てこない

- **Claude Code を開き直してください**（起動中のセッションには新しい MCP 設定が反映されません）。
- `claude mcp list` に `mxstage` が出るか確認してください。
- 導入の途中で Claude Code が `~\.claude.json` を同時に書くことがあります。出てこなければ、もう一度導入してください。

### 作業画面が開かない

- ブラウザで `http://127.0.0.1:8788/app` を直接開いてください（`--port` で番号を変えたときは、その番号。`--status` に出ます）。
- デスクトップにショートカットが無いときは、デスクトップが OneDrive に移されていることがあります。そちらを見てください。

### Maximo に届かない

- 橋渡しは **Maximo を直接呼びます**（ブラウザの CORS 制約を避けるため）。**Maximo 側の CORS 設定は要りません。**
  会社のプロキシや証明書が間にある場合は、橋渡しのプロセスから Maximo に届くかどうかが問題になります。
- 設定画面の「接続」で失敗したときは、橋渡しが返した理由に合わせた案内が出ます。
  `path_not_allowed`・`invalid_path`・`method_not_allowed` は **API キーの誤りではありません**（作業画面を読み込み直し、
  直らなければ導入をやり直す）。`missing_apikey` は API キーを入れ直す、`upstream_timeout` は Maximo とネットワーク（VPN・プロキシ）を確かめる、が次の手です。
- 保存しないで接続した API キーは作業タブの中にだけあり、タブを閉じると消えます（開き直したら入れ直す）。「この PC に保存」を選んだ接続先は、橋渡しが暗号化して保存し、どの窓からも自動でつながります。どちらも Claude には渡りません。

### 入れる前の状態に戻したい

`node scripts/setup-local.mjs --uninstall` で戻ります。それでも足りないときは、控え（`~\.config\mxstage\backup\` の
`.claude.json.<日時>.bak` / `claude_desktop_config.json.<日時>.bak`）から戻してください。中身はそのときの設定ファイルのまるごとの写しです。

---

## 6. どこに何を書くか（一覧）

| 場所 | 何を |
|---|---|
| `~\.claude.json` の `mcpServers.mxstage` | Claude Code の MCP 設定（stdio・`node <入口> --port <番号>`） |
| `%APPDATA%\Claude\claude_desktop_config.json` の `mcpServers.mxstage` | Claude Desktop の MCP 設定（`%APPDATA%\Claude` があるときだけ。拡張機能（`.mcpb`）の MX Stage が有効なら書かない） |
| `%LOCALAPPDATA%\Packages\Claude_<発行元 ID>\LocalCache\Roaming\Claude\claude_desktop_config.json` の `mcpServers.mxstage` | Microsoft Store 版の Claude Desktop の MCP 設定（そのフォルダがあるときだけ。拡張機能の扱いは同じ） |
| `~\.gemini\config\mcp_config.json` の `mcpServers.mxstage` | Antigravity の MCP 設定（`~\.gemini` があるときだけ） |
| `~\.gemini\config\skills\<名前>\SKILL.md` | Antigravity（2.0・IDE）の Skill（Claude Code の分と同じ中身・同じ扱い）。以前の導入は `~\.gemini\skills`（Gemini CLI の置き場所）に写していました |
| `~\.codex\config.toml` の `[mcp_servers.mxstage]` | Codex の MCP 設定（`~\.codex` があるときだけ。デスクトップ・CLI・IDE 拡張共通） |
| `~\.agents\skills\<名前>\SKILL.md` | Codex が読む個人の Skill（Claude Code の分と同じ中身・同じ扱い。ほかのエージェントも読むことがあります） |
| `~\.bob\settings\mcp.json` の `mcpServers.mxstage` | IBM Bob の MCP 設定（`~\.bob` があるときだけ） |
| `~\.bob\skills\<名前>\SKILL.md` | IBM Bob の Skill（Claude Code の分と同じ中身・同じ扱い） |
| `~\.claude\skills\<名前>\SKILL.md` | Claude Code の Skill（アプリ既定と利用者の Skill の写し。記録には名前・出どころ・中身のハッシュだけを書き、取り消しでは書き換えられていないものだけを消す） |
| スタートアップフォルダ（`shell:startup`） | `mxstage-bridge.lnk` |
| デスクトップ | `mxstage.lnk` または `mxstage.url` |
| `~\.config\mxstage\setup.json` | 導入の記録（ポート・入口・控えの場所。**秘密は書きません**） |
| `~\.config\mxstage\backup\` | 書き換える前の設定ファイルの控え |
| `~\.config\mxstage\skills\` | **利用者の Skill**（利用者が置く。導入も取り消しも消さない） |
| `~\.config\mxstage\bridge.key` | **橋渡しが作ります**。橋渡し同士（ポートを持つ橋渡しと中継する橋渡し）の認証に使う乱数の鍵。取り消しでは消しません |
| `~\.config\mxstage\connections.json`・`connections.key` | **橋渡しが作ります**（「この PC に保存」を選んだとき）。保存した接続先と、AES-256-GCM で暗号化した API キー。暗号化の鍵は DPAPI で包んで `connections.key` に置く |
| `~\.config\mxstage\updates.json`・`updates\` | **橋渡しが作ります**。更新の設定と、確かめた版・ダウンロードした拡張機能のファイル |
| `~\.config\mxstage\licenses\` | 設定の「ライセンス」で貼ったライセンスキー |
| `~\.config\mxstage\demo\` | **橋渡しが作ります**（設定の「デモ」でデータを落としたとき）。デモの架空のデータ。設定の「デモ」で消せる |
| `~\.config\mxstage\bridge.log` | **橋渡しが書きます**。起動・終了・中継・異常終了の記録（API キーと作業データは書きません。512KB で 1 世代だけ残して切り替え） |

`~\.config\mxstage` は、Windows では `%USERPROFILE%\.config\mxstage` です。

**`%LOCALAPPDATA%` に置かない理由。** Claude Desktop は MSIX パッケージのアプリで、Claude Desktop（とその Code タブ）が起動したプロセスが
`%LOCALAPPDATA%` に書いたファイルは、パッケージ専用の場所に振り替えられてパッケージの外からは見えません。
鍵ファイルをそこに置くと、Claude が起動した橋渡しとログイン時の自動起動の橋渡しが別々の鍵を持ち、中継が認証に失敗します。
ホーム直下は振り替えられないので、`~\.config\mxstage` に置きます。

これ以外は書き換えません。レジストリもサービスも触りません。
`claude` コマンドで登録したときは、`claude` コマンド自身が `~\.claude\backups\` に自分の控えを作ります。

### 試験のときの決まり

`npm run test:setup` は印 `MXSTAGE_SETUP_TEST=1` を立てて動きます。この印があるときは、本物の `claude` コマンドを探さず、
書き先（`--state-dir`・`--claude-code-config`・`--claude-desktop-config`・`--startup-dir`・`--desktop-dir`。登録する環境の分は
`--claude-skills-dir`・`--antigravity-dir`・`--codex-dir`・`--agents-skills-dir`・`--bob-dir` も。Microsoft Store 版の Claude Desktop は
`--claude-desktop-packages-dir` を指定したときだけ探します）が
すべて一時フォルダの中で、`--port`（`8788` 以外）・`--bridge`・`--no-open`・`--no-install`・`--no-build` がそろっていなければ、
何もせずに終了コード 2 で止まります。最後の試験で、本物の書き先の更新時刻が試験の前後で変わっていないことを確かめます。

手で本物の橋渡しを試すときは、環境変数 `MXSTAGE_BRIDGE_KEY_FILE` を一時フォルダのファイルに向けてください
（向けないと本物の `~\.config\mxstage\bridge.key` を作ります）。**その値を設定したままのシェルで導入を実行しないでください**
（画面用の橋渡しだけがその鍵を使い、Claude が起動する橋渡しと鍵が食い違います。導入はこのとき警告を出します）。
