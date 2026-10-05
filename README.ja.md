# MX Stage

[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.mxstage%2Fmxstage-0a7bbb)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.mxstage/mxstage)
[![Latest release](https://img.shields.io/github/v/release/mxstage/mxstage?label=release)](https://github.com/mxstage/mxstage/releases/latest)
[![Claude Desktop extension](https://img.shields.io/badge/Claude_Desktop-.mcpb_extension-d97757)](https://github.com/mxstage/mxstage/releases/latest)
[![ChatGPT desktop](https://img.shields.io/badge/ChatGPT_desktop-Codex_%7C_Work-10a37f)](#ほかの-ai-アシスタント導入スクリプト)
[![IBM Maximo / MAS Manage](https://img.shields.io/badge/IBM_Maximo-MAS_Manage-0f62fe)](#必要なもの)
[![EAM / CMMS](https://img.shields.io/badge/category-EAM_%7C_CMMS-6f42c1)](#必要なもの)
[![MCP server](https://img.shields.io/badge/MCP-server-555555)](https://modelcontextprotocol.io)
[![テスト環境は無償](https://img.shields.io/badge/free-test_environments-2ea44f)](https://mxstage.tsunagi.app/ja/pricing)
[![License: BSL 1.1](https://img.shields.io/badge/license-BSL_1.1_%E2%86%92_Apache_2.0-blue)](LICENSE)
[![Windows](https://img.shields.io/badge/platform-Windows-0078d4)](#必要なもの)

[English](README.md) | 日本語

Maximo（MAS Manage）のデータ整備を、利用者の LLM クライアント（Claude Desktop・ChatGPT デスクトップの Codex・IBM Bob・Claude Code・Antigravity）と
一緒に行うためのツール。画面（作業画面）と MCP サーバを、利用者の PC の中だけで動かす。
サイト: https://mxstage.tsunagi.app/ja/ 。問い合わせ: mxstage@tsunagi.app

- **データの正本はブラウザの作業タブだけ。** LLM のツール呼び出しは作業タブに届き、その場でグリッドに
  反映される。読み込んだ表はタブの外には保存しない。
- **外へ通信するのは、Maximo と AI アシスタントだけ。** ただし設定の「更新」で **自動で更新する** をオンにしたとき（既定はオフ）だけ、
  橋渡しが 1 日 1 回 GitHub に最新の版の番号を問い合わせる。導入スクリプトで入れたものは作業中でないときに自動で入れ替わり、
  Claude Desktop の拡張機能は新しいファイルをダウンロードして確かめるところまで行う（入れるのは利用者）。
  また、設定の「デモ」で **データを落としてつなぐ** を押したときだけ、`mxstage-demo.pages.dev` から架空のデータを 1 回落とす（何も送らない）。
- **Maximo の API キーは、この PC の橋渡しが OS の保護付きで保存し、ブラウザには渡さない**（Windows は DPAPI、macOS はキーチェーンで暗号化）。
  作業画面はどの窓（インストールしたアプリ・ブラウザのタブ・AI アシスタントの中のブラウザ）で開いても、PC を再起動したあとでも自動でつながり、
  Maximo の環境が複数あれば設定で選んで切り替えられる（保存せずに接続することもでき、そのときキーはタブのメモリにだけ置く）。
- **Maximo への書き込みは、利用者が作業画面で [Maximo に反映] を押したときだけ。** LLM のツールからは書き込めない。
- **外部のサーバを使わない。** この PC で動く「橋渡し」（Node のプロセス 1 つ）が、画面の配信・LLM との MCP 接続・
  Maximo への中継を引き受ける。Maximo は橋渡しが直接呼ぶので、Maximo 側の CORS 設定も要らない。

## 入れ方

### Claude Desktop（いちばん簡単）

1. [最新のリリース](https://github.com/mxstage/mxstage/releases/latest)から `mxstage-<版>.mcpb` を取得する。
2. Claude Desktop の「Settings → Extensions」で「Advanced settings → Install Extension…」を押してファイルを選ぶ（ファイルをダブルクリックするか、Extensions の画面にドラッグしてもよい）。「Install」を押す。
3. Chrome か Edge で `http://127.0.0.1:8788/app` を開き、**設定で Maximo の URL と API キーを入れる。** API キーはチャットに書かない。
4. 新しいチャットで「MX Stage の状態を見せて」と頼む。

拡張には Node.js も Git も要らない（Claude Desktop が動かす）。ほかの AI アシスタント（ChatGPT デスクトップ・IBM Bob・ターミナルの Claude Code・Antigravity）でも使うときは、下の導入スクリプトを使う。拡張が入っていれば、二重には登録しない。

### Maximo が無くても試す

Maximo が手元に無くても、組み込みのデモで試せる。架空のごみ焼却施設 3 か所（機器・場所・約 5.2 万件の作業指示・在庫と、移行で残りがちなデータ品質の問題）の Maximo を、日本語か英語のデータで、この PC の橋渡しの中で動かす。

1. MX Stage を入れて（上）、`http://127.0.0.1:8788/settings#demo` を開く。
2. **データを落としてつなぐ** を押す。`mxstage-demo.pages.dev` から架空のデータ（約 10 MB。プログラムは含まない）を 1 回落とし、この版に埋め込んだ SHA-256 で確かめる。
3. AI に頼む。例: 「北部クリーンセンターの稼働中の機器のデータ品質を調べて、問題を件数付きで一覧にして」

反映はこの PC の中の写しにだけ効き（**初めの状態に戻す** で戻せる）、ライセンスは要らない。使っている間はメモリを約 0.5 GB 使う。Maximo と突き合わせるサンプルの Excel（作業指示番号の無い発注一覧・旧設備台帳・修理記録・Maximo より進んだ機器台帳・星取表）も同じタブにある。詳しくは [docs/demo.md](docs/demo.md)。

### Claude の plugin（Skill）

[`plugin/`](plugin) の `mxstage` plugin は、Claude に Skill を 2 つ足す（Maximo のデータを安全に一括で直す段取りと、MX Stage の説明・入れ方・困ったときの確かめ方）。Claude Code と Cowork では、`npx @mxstage/mxstage` で MX Stage のサーバも起動する（Node.js 20 以上）。チャットはローカルのサーバを起動しないので、チャットでは拡張を使う。Claude Code では `/plugin marketplace add mxstage/mxstage` のあと `/plugin install mxstage@mxstage`。

### ほかの AI アシスタント（導入スクリプト）

**Claude Code（Claude Desktop の Code タブでもよい）に、このリポジトリの URL と「インストールして」とだけ伝える。**
Claude Code が下の「導入手順（Claude Code 向け）」に沿って入れる。コマンドを実行する前に、Claude Code が確認を求める。

手で入れるときは、取得したフォルダ（`%USERPROFILE%\mxstage`）で `node scripts/setup-local.mjs` を実行する。

**導入は 1 回で、この PC に入っている環境すべてに登録する**（次の「環境ごとの置き場所」）。環境ごとに別の手順は要らない。
終わったら、使う環境を開き直す。デスクトップの `mxstage`（または `http://127.0.0.1:8788/app`）を開き、
**設定で Maximo の URL と API キーを入れる。** API キーはチャットに書かない。

npm でサーバを起動する MCP クライアントでは、`npx -y @mxstage/mxstage` でサーバだけを動かすこともできる（Node.js 20 以上。Skill やショートカットは導入スクリプトでだけ入る）。

更新は「MX Stage を更新して」、取り消しは「MX Stage をアンインストールして」と Claude Code に伝える（下の「アンインストール」）。

### 必要なもの

- Windows（Mac・Linux は試していない）
- Node.js 22.6 以上、Git（無ければ導入の途中で入れてよいか確認される）
- Chrome か Edge
- 次のどれか 1 つ以上。導入を頼むのは Claude Code か Claude Desktop の Code タブを想定している（ほかの環境から頼むのは試していない。手で実行してもよい）
  - Claude Code（CLI）、Claude Desktop（チャット・Code タブ）
  - Antigravity（2.0・IDE・`agy` CLI）
  - Codex（ChatGPT デスクトップアプリの Codex・CLI・IDE 拡張）
  - IBM Bob

## 環境ごとの置き場所

`~` は `%USERPROFILE%`（例 `C:\Users\<名前>`）。導入は、入っていない環境には何も作らない
（Claude Desktop は設定フォルダ、Antigravity は `~\.gemini`、Codex は `~\.codex`、IBM Bob は `~\.bob` があるかで見分ける）。
入っていても登録しないときは、導入に `--no-claude-desktop`・`--no-antigravity`・`--no-codex`・`--no-bob` を付ける（Skill を写さないときは `--no-skills`）。拡張機能が有効でも Claude Code に登録するときは `--claude-code`。

| 環境 | MCP（ツール）の設定 | Skill の置き場所 | 導入・更新のあと |
|---|---|---|---|
| Claude Code（CLI） | `~\.claude.json` の `mcpServers.mxstage`。**Claude Desktop に拡張機能（`.mcpb`）の MX Stage が入っていて有効なら登録しない**（Code タブは拡張機能から MX Stage を受け取るので、両方にあるとツールが二重に出る。前にこの導入が書いた分は外す）。ターミナルの Claude Code でも使うときは `--claude-code` を付ける（次回からも引き継ぐ） | `~\.claude\skills\<名前>\SKILL.md` | Claude Code を終了して開き直す |
| Claude Desktop の Code タブ | Claude Code と同じ（下のチャットの設定も読む。どちらも同じ `mxstage`）。拡張機能（`.mcpb`）が有効なら拡張機能から受け取る | Claude Code と同じ | Claude Desktop をタスクトレイのアイコンから終了して開き直す |
| Claude Desktop のチャット | `%APPDATA%\Claude\claude_desktop_config.json` の `mcpServers.mxstage`。Microsoft Store 版は、`%LOCALAPPDATA%\Packages\Claude_<発行元 ID>\LocalCache\Roaming\Claude\` があればそこの `claude_desktop_config.json` にも書く。**拡張機能（`.mcpb`）の MX Stage が入っていて有効なら登録しない**（前にこの導入が書いた分は外す） | ファイルは置かない（下の「Skill」） | タスクトレイのアイコンから終了して開き直す（ウィンドウの × では終わらない） |
| Antigravity（2.0・IDE・`agy` CLI） | `~\.gemini\config\mcp_config.json` の `mcpServers.mxstage`（3 つとも同じファイル） | `~\.gemini\config\skills\<名前>\SKILL.md`（2.0・IDE が読む。`agy` CLI は別の場所を読むので置かない） | 新しい会話を始める |
| Codex（ChatGPT デスクトップアプリの Codex・CLI・IDE 拡張） | `~\.codex\config.toml` の `[mcp_servers.mxstage]`（3 つとも同じファイル。`CODEX_HOME` があればそこ） | `~\.agents\skills\<名前>\SKILL.md`（ほかのエージェントも読むことがある） | Codex を終了して開き直す |
| IBM Bob | `~\.bob\settings\mcp.json` の `mcpServers.mxstage` | `~\.bob\skills\<名前>\SKILL.md` | IBM Bob を再起動する |

入る Skill は、アプリ既定の 17 本（目次の `mxstage-workbench`・基本動作の `mxstage-core-*`・標準オブジェクトの `mxstage-obj-*`）と、利用者の Skill（`~\.config\mxstage\skills\` にあるもの）。
Skill のファイルを置かない環境（Claude Desktop のチャット・`agy` CLI）にも、目次と Skill の一覧はツールの結果で届く（下の「Skill」）。
どの環境の設定も、書き換える前に控え（`~\.config\mxstage\backup\`）を取り、`mxstage` 以外の設定には触らない。
今どの環境に入っているかは `node scripts/setup-local.mjs --status` で見られる（何も書き換えない）。

### 画面での確かめ方

画面の名前は、各製品の資料（2026-09 時点・英語の表示）のもの。

| 環境 | MCP（`mxstage` とそのツール） | Skill（`mxstage-workbench` など） |
|---|---|---|
| Claude Code（CLI） | 会話で `/mcp`（一覧と接続の状態）。シェルでは `claude mcp list`・`claude mcp get mxstage` | 会話で `/skills`。`/` を打つと `/mxstage-workbench` として出る |
| Claude Desktop の Code タブ | 入力欄の **+** →「Connectors」 | 入力欄で `/` を打つか、**+** →「Slash commands」 |
| Claude Desktop のチャット | 入力欄の **+** →「Connectors」→「Manage connectors」でツールが見える。接続の状態とログは Settings の「Developer」（ログは `%APPDATA%\Claude\logs\mcp-server-mxstage.log`） | 出ない（ファイルを置かないため）。「MX Stage の Skill の一覧を見せて」と頼むと、ツールで一覧を返す |
| Antigravity 2.0 | 左下の Settings（`Ctrl+,`）→「Customizations」→「Installed MCP Servers」（更新ボタンで読み直す） | 同じ「Customizations」。会話では `/<名前>` で呼べる |
| Antigravity IDE | エージェントのパネル上部の「…」→「MCP Servers」→「Manage MCP Servers」（「View raw config」で設定ファイル） | エージェントのパネルの「Customizations」 |
| `agy` CLI | 会話で `/mcp` | 出ない（置かないため） |
| Codex（ChatGPT デスクトップアプリ） | Settings →「MCP servers」。入力欄で `/mcp` | 左の「Skills」。入力欄で `@` を打って選ぶ |
| Codex CLI | `codex mcp list`。会話で `/mcp` | 会話で `/skills`、または `$mxstage-workbench` |
| Codex IDE 拡張 | 歯車のメニュー →「MCP servers」 | `/skills`、または `$` を打って選ぶ |

## アンインストール

### 全部外す

Claude Code に「MX Stage をアンインストールして」と伝えるか、`%USERPROFILE%\mxstage` で次を実行する。

```bash
node scripts/setup-local.mjs --uninstall
```

| 外すもの | 残すもの |
|---|---|
| 上の表の全環境の MCP 設定の `mxstage`（導入が置き換えた利用者の設定があれば、控えから元に戻す） | ほかの MCP サーバとほかの設定 |
| 導入が写した Skill（`~\.claude\skills`・`~\.gemini\config\skills`・`~\.agents\skills`・`~\.bob\skills` の下） | 写したあとに書き換えられた Skill |
| ログイン時の自動起動（スタートアップの `mxstage-bridge.lnk`）とデスクトップの `mxstage` | 利用者の Skill の元（`~\.config\mxstage\skills\`） |
| 導入が起動した橋渡し | LLM が起動した橋渡し（その LLM を終了すると止まる） |
| 導入の記録（`~\.config\mxstage\setup.json`） | 控え（`~\.config\mxstage\backup\`） |

終わったら、使っていた環境を開き直す。この PC から跡形なく消すときは、続けて次も消す。

- リポジトリのフォルダ（`%USERPROFILE%\mxstage`）
- `~\.config\mxstage`（利用者の Skill・控え・橋渡しの鍵とログ）。**控えは元の設定ファイルのまるごとの写しなので、そこに入っていたトークンも含む。**
  利用者の Skill を残したいときは、先に `skills\` を別の場所へ写す
- ブラウザに残る作業画面の設定（接続先の URL・オブジェクト構造の定義）: Chrome・Edge の設定の「サイトのデータ」で `127.0.0.1:8788` を消す

### 一部の環境だけ外す

導入には環境ごとに外す引数が無いので、その環境の設定から `mxstage` だけを消す。ほかのサーバの設定は残す。

| 環境 | MCP を外す | Skill を外す |
|---|---|---|
| Claude Code（CLI） | `claude mcp remove --scope user mxstage` | `~\.claude\skills\` の下の、MX Stage が入れたフォルダ（`mxstage-workbench`・`mxstage-core-*`・`mxstage-obj-*` と利用者の Skill の名前）を消す |
| Claude Desktop（チャット・Code タブ） | Settings の「Developer」→「Edit Config」で開く `claude_desktop_config.json` の `mcpServers` から `"mxstage"` の項目を消し、Claude Desktop を開き直す。Code タブからも外すなら、Claude Code の分も外す | チャットには置いていない。Code タブは Claude Code と同じ |
| Antigravity | `~\.gemini\config\mcp_config.json` の `mcpServers` から `"mxstage"` の項目を消す（IDE では「View raw config」で開ける） | `~\.gemini\config\skills\` の下の同じ名前のフォルダを消す |
| Codex | `~\.codex\config.toml` から `[mcp_servers.mxstage]` の表（次の `[` の行の手前まで）を消し、Codex を開き直す | `~\.agents\skills\` の下の同じ名前のフォルダを消す |
| IBM Bob | `~\.bob\settings\mcp.json` の `mcpServers` から `"mxstage"` の項目を消し、IBM Bob を再起動する | `~\.bob\skills\` の下の同じ名前のフォルダを消す |

外したあとに導入をもう一度実行すると、その環境にまた登録する。Claude Desktop・Antigravity・Codex・IBM Bob は、導入に
`--no-claude-desktop`・`--no-antigravity`・`--no-codex`・`--no-bob` を付けると登録しない（Claude Code は、登録しない引数が無い。ただし Claude Desktop に拡張機能（`.mcpb`）の MX Stage が有効なら、`--claude-code` を付けない限り登録しない）。
Claude Desktop は、拡張機能（`.mcpb`）の MX Stage を入れて有効にしておけば、導入は設定ファイルに登録しない。

## 導入手順（Claude Code 向け）

利用者に「インストールして」と頼まれたときは、次のとおりに進める。各コマンドは実行前に利用者の承認を得る。

1. **前提を確かめる**: `node --version`（22.6 以上）と `git --version`。
   足りなければ、利用者の了承を得て `winget install OpenJS.NodeJS.LTS` / `winget install Git.Git` で入れる。
   入れた直後は新しいシェルで `node` と `git` が見えることを確かめる。
2. **取得する**: 置き場所は `%USERPROFILE%\mxstage`（Mac・Linux は `~/mxstage`）。
   - 無ければ `git clone <このリポジトリの URL> "%USERPROFILE%\mxstage"`
   - 既にあれば、その中で `git pull --ff-only`（手元の変更があって進めないときは、何もせずに利用者に伝える）
3. **導入する**: そのフォルダで `node scripts/setup-local.mjs --json`。
   依存の取得（`npm install`）と画面のビルドもこの中で行う。`mxstage.cmd` は最後に入力待ちで止まるので使わない。
4. **結果を読む**: 出力の `steps` に `"level": "error"` が無ければ成功。`error` や `warn` があれば、その `message` と
   `hint` をそのまま利用者に伝え、`hint` の手順に従う。推測で設定ファイルを直さない。
5. **利用者に伝える**:
   - 使う環境を開き直すこと（「環境ごとの置き場所」の「導入・更新のあと」。新しいセッションからツールと Skill が使える）
   - 作業画面（`http://127.0.0.1:8788/app`）の設定で、Maximo の URL と API キーを入れること
   - API キーをチャットに書かないこと（受け取らない）

**更新**は 2〜4 と同じ（`git pull --ff-only` のあと `node scripts/setup-local.mjs --json`）。
橋渡しが古いまま動いていると新しいコードにならないので、終わったら使っている環境を終了して開き直してもらう。
**取り消し**は `node scripts/setup-local.mjs --uninstall --json`。**状態の確認**は `node scripts/setup-local.mjs --status --json`（何も書き換えない）。

## 導入で何が起きるか

| 対象 | 内容 |
|---|---|
| 橋渡し | ポート `8788`（固定。ずらさない）で起動する。PC に 1 つだけで、LLM クライアントが起動した分はここへ中継する |
| MCP と Skill | 上の「環境ごとの置き場所」の表のとおりに登録する。登録しないときは `--no-claude-desktop`・`--no-antigravity`・`--no-codex`・`--no-bob`・`--no-skills` |
| 自動起動・ショートカット | ログイン時に橋渡しを起動するショートカットと、デスクトップの `mxstage` を作る |

何度実行しても壊れない。詳しくは [docs/local.md](docs/local.md)。

## Skill（作業手順書）

LLM に MX Stage の使い方を教えるファイル。**アプリ既定**と**利用者の Skill** の 2 か所に分けている。

| | 置き場所 | 中身 | 更新 |
|---|---|---|---|
| アプリ既定: 目次 | `skills/mxstage-workbench` | どの作業にも共通の決まりと、どの場面でどの Skill を読むか | MX Stage と一緒に置き換わる。書き換えない |
| アプリ既定: 基本動作 | `skills/mxstage-core-*`（8 本） | 読み込み・分析・変更・突き合わせ・取り込み・反映・作業画面・Skill の作り方 | 同上 |
| アプリ既定: 標準オブジェクト | `skills/mxstage-obj-*`（8 本） | 資産とメーター・場所・分類と仕様・作業指示・予防保全と作業計画・品目と在庫・購買・基準データ。Maximo の振る舞い、MX Stage で変えられること、落とし穴 | 同上 |
| 利用者の Skill | `~/.config/mxstage/skills/<名前>/SKILL.md` | 客先の環境ごと（カスタムのオブジェクト・属性・決まり）と、繰り返す作業の手順 | 利用者が置く。MX Stage を更新しても消えず、このリポジトリにも入らない。`mxstage` で始まる名前は使えない |

- **どの環境でも届く。** MX Stage をつないだ会話では、最初にツールを使ったときの結果に、目次と全 Skill の一覧が添えられる。
  読み込み・変更・取り込み・反映などのツールの結果には、その段階で読む Skill の名前が添えられ、LLM が `get_skill` で読む（資産の仕様を読み込んだら資産と分類の Skill など）。
  Skill のファイルを置かない Claude Desktop のチャットや `agy` CLI でも、これで同じ手順になる（利用者の Skill の本文は、LLM がツールで読む）。
- **チャットから作れる。** 作業の途中で「この手順を Skill として残して」と頼むと、LLM が名前・説明・本文を示して確かめたうえで
  `~/.config/mxstage/skills/` に保存する。
- 各環境の Skill の置き場所へは、導入のたびに写す。利用者の Skill を足したり直したりしたら、導入をもう一度実行する
  （「MX Stage の Skill を入れ直して」と頼めばよい）。
- 利用者の Skill は、その客先では既定の Skill の手順より先に読み、手順を置き換えてよい。ただし目次の決まりは置き換えられない。
- `mxstage` で始まる名前は使えない。どれが入っているかは作業画面の設定の「Skill」に層ごとに出る。
- 書き方はアプリ既定の `skills/*/SKILL.md` と同じ（frontmatter に `name`・`description`・`metadata.version`。層の `metadata.category` は利用者の Skill では省くか `user`）。

## 文書

- [docs/demo.md](docs/demo.md) — Maximo が無くても試す（組み込みのデモ）
- [docs/local.md](docs/local.md) — 毎日の使い方・更新・取り消し・うまくいかないとき・どこに何を書くか
- [docs/status.md](docs/status.md) — 今どこまでできているか
- [docs/publish.md](docs/publish.md) — GitHub へ送る前の検査（客先の情報を送らない）

## 開発

```bash
npm run typecheck      # tsc（app / bridge）
npx vitest run         # 試験（app / bridge）
npm run test:setup     # 導入スクリプトの試験（一時フォルダだけに書き、本物の claude コマンドは呼ばない）
npm run build          # アプリ既定の Skill の生成と画面のビルド（dist/app）
npm run dev:app        # 画面の開発サーバ（http://localhost:5173/app?samples=1 で架空のサンプルを表示。中継は開発用の橋渡し 8790 へ）
node scripts/check-publish.mjs --worktree   # 送る前の検査（docs/publish.md）
```

依存を入れるときは、IBM のテレメトリ（`@carbon/react` などが入れるときに動く `@ibm/telemetry-js`）を止める（PowerShell なら `$env:IBM_TELEMETRY_DISABLED='true'; npm install`）。導入スクリプト（`scripts/setup-local.mjs`）は自分で止める。画面の見た目の約束は [docs/design.md](docs/design.md)。

**Maximo への反映は、開発環境の Maximo とダミーデータでだけ試すこと。** 書き込みを自動で元に戻す仕組みは無い。

## ライセンス

[Business Source License 1.1](LICENSE)（BSL）。ソースは読めるが、オープンソースではない。正式な条件は英語の [LICENSE](LICENSE) で、ここはその要約。

- **無償で使える**: 本番の Maximo への「Maximo に反映」（データを作る・変える・消す）以外のすべて。テスト環境への反映も、本番のデータの読み込み・集計・Skill づくり・作業画面での編集と差分の確認も無償。ソースを読む・直す・配ることもできる（直したものにも同じ条件が付く）。
- **商用ライセンスが要る**: MX Stage で本番の Maximo に反映すること。本番の Maximo 1 環境につき年 4,800 ドル。キーにはその環境の接続先（別名を 3 つまで）が書いてあり、接続先が合えば何人・何台の PC でも使える。
- **本番環境**: 組織が日々の業務の記録に使っている Maximo と、それに置き換わる準備中の環境（本番の切り替え前の移行先など）。**テスト環境**: それ以外のすべて（開発・検証・研修・デモ・移行のリハーサル）。本番のデータの写しを入れていてもテスト環境。
- **各版は、公開から 4 年たつと Apache License 2.0 になる。** その版は、それ以後は Apache 2.0 の条件で本番への書き込みにも使える。
- npm で入れるパッケージとフォント（IBM Carbon Design System・IBM Plex など）は、それぞれのライセンスに従う（[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。
