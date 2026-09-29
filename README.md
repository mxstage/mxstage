# mxstudio

Maximo（MAS Manage）のデータ整備を、利用者の LLM クライアント（Claude Code・Claude Desktop・Codex・Antigravity）と
一緒に行うためのツール。画面（作業画面）と MCP サーバを、利用者の PC の中だけで動かす。

- **データの正本はブラウザの作業タブだけ。** LLM のツール呼び出しは作業タブに届き、その場でグリッドに
  反映される。読み込んだ表も Maximo の API キーも、タブの外には保存しない。
- **Maximo への書き込みは、利用者が作業画面で [Maximo に反映] を押したときだけ。** LLM のツールからは書き込めない。
- **外部のサーバを使わない。** この PC で動く「橋渡し」（Node のプロセス 1 つ）が、画面の配信・LLM との MCP 接続・
  Maximo への中継を引き受ける。Maximo は橋渡しが直接呼ぶので、Maximo 側の CORS 設定も要らない。

## 入れ方

**Claude Code（Claude Desktop の Code タブでもよい）に、このリポジトリの URL と「インストールして」とだけ伝える。**
Claude Code が下の「導入手順（Claude Code 向け）」に沿って入れる。コマンドを実行する前に、Claude Code が確認を求める。

手で入れるときは、取得したフォルダ（`%USERPROFILE%\mxstudio`）で `node scripts/setup-local.mjs` を実行する。

**導入は 1 回で、この PC に入っている環境すべてに登録する**（次の「環境ごとの置き場所」）。環境ごとに別の手順は要らない。
終わったら、使う環境を開き直す。デスクトップの `mxstudio`（または `http://127.0.0.1:8788/app`）を開き、
**設定で Maximo の URL と API キーを入れる。** API キーはチャットに書かない。

更新は「mxstudio を更新して」、取り消しは「mxstudio をアンインストールして」と Claude Code に伝える（下の「アンインストール」）。

### 必要なもの

- Windows（Mac・Linux は試していない）
- Node.js 22.6 以上、Git（無ければ導入の途中で入れてよいか確認される）
- Chrome か Edge
- 次のどれか 1 つ以上。導入を頼むのは Claude Code か Claude Desktop の Code タブを想定している（ほかの環境から頼むのは試していない。手で実行してもよい）
  - Claude Code（CLI）、Claude Desktop（チャット・Code タブ）
  - Antigravity（2.0・IDE・`agy` CLI）
  - Codex（ChatGPT デスクトップアプリの Codex・CLI・IDE 拡張）

## 環境ごとの置き場所

`~` は `%USERPROFILE%`（例 `C:\Users\<名前>`）。導入は、入っていない環境には何も作らない
（Antigravity は `~\.gemini`、Codex は `~\.codex` があるかで見分ける）。

| 環境 | MCP（ツール）の設定 | Skill の置き場所 | 導入・更新のあと |
|---|---|---|---|
| Claude Code（CLI） | `~\.claude.json` の `mcpServers.mxstudio` | `~\.claude\skills\<名前>\SKILL.md` | Claude Code を終了して開き直す |
| Claude Desktop の Code タブ | Claude Code と同じ（下のチャットの設定も読む。どちらも同じ `mxstudio`） | Claude Code と同じ | Claude Desktop をタスクトレイのアイコンから終了して開き直す |
| Claude Desktop のチャット | `%APPDATA%\Claude\claude_desktop_config.json` の `mcpServers.mxstudio` | ファイルは置かない（下の「Skill」） | タスクトレイのアイコンから終了して開き直す（ウィンドウの × では終わらない） |
| Antigravity（2.0・IDE・`agy` CLI） | `~\.gemini\config\mcp_config.json` の `mcpServers.mxstudio`（3 つとも同じファイル） | `~\.gemini\config\skills\<名前>\SKILL.md`（2.0・IDE が読む。`agy` CLI は別の場所を読むので置かない） | 新しい会話を始める |
| Codex（ChatGPT デスクトップアプリの Codex・CLI・IDE 拡張） | `~\.codex\config.toml` の `[mcp_servers.mxstudio]`（3 つとも同じファイル。`CODEX_HOME` があればそこ） | `~\.agents\skills\<名前>\SKILL.md`（ほかのエージェントも読むことがある） | Codex を終了して開き直す |

入る Skill は、アプリ既定の `mxstudio-workbench` と、利用者の Skill（`~\.config\mxstudio\skills\` にあるもの）。
Skill のファイルを置かない環境（Claude Desktop のチャット・`agy` CLI）にも、基本手順はツールの結果で届く（下の「Skill」）。
どの環境の設定も、書き換える前に控え（`~\.config\mxstudio\backup\`）を取り、`mxstudio` 以外の設定には触らない。
今どの環境に入っているかは `node scripts/setup-local.mjs --status` で見られる（何も書き換えない）。

### 画面での確かめ方

画面の名前は、各製品の資料（2026-09 時点・英語の表示）のもの。

| 環境 | MCP（`mxstudio` とそのツール） | Skill（`mxstudio-workbench` など） |
|---|---|---|
| Claude Code（CLI） | 会話で `/mcp`（一覧と接続の状態）。シェルでは `claude mcp list`・`claude mcp get mxstudio` | 会話で `/skills`。`/` を打つと `/mxstudio-workbench` として出る |
| Claude Desktop の Code タブ | 入力欄の **+** →「Connectors」 | 入力欄で `/` を打つか、**+** →「Slash commands」 |
| Claude Desktop のチャット | 入力欄の **+** →「Connectors」→「Manage connectors」でツールが見える。接続の状態とログは Settings の「Developer」（ログは `%APPDATA%\Claude\logs\mcp-server-mxstudio.log`） | 出ない（ファイルを置かないため）。「mxstudio の Skill の一覧を見せて」と頼むと、ツールで一覧を返す |
| Antigravity 2.0 | 左下の Settings（`Ctrl+,`）→「Customizations」→「Installed MCP Servers」（更新ボタンで読み直す） | 同じ「Customizations」。会話では `/<名前>` で呼べる |
| Antigravity IDE | エージェントのパネル上部の「…」→「MCP Servers」→「Manage MCP Servers」（「View raw config」で設定ファイル） | エージェントのパネルの「Customizations」 |
| `agy` CLI | 会話で `/mcp` | 出ない（置かないため） |
| Codex（ChatGPT デスクトップアプリ） | Settings →「MCP servers」。入力欄で `/mcp` | 左の「Skills」。入力欄で `@` を打って選ぶ |
| Codex CLI | `codex mcp list`。会話で `/mcp` | 会話で `/skills`、または `$mxstudio-workbench` |
| Codex IDE 拡張 | 歯車のメニュー →「MCP servers」 | `/skills`、または `$` を打って選ぶ |

## アンインストール

### 全部外す

Claude Code に「mxstudio をアンインストールして」と伝えるか、`%USERPROFILE%\mxstudio` で次を実行する。

```bash
node scripts/setup-local.mjs --uninstall
```

| 外すもの | 残すもの |
|---|---|
| 上の表の全環境の MCP 設定の `mxstudio`（導入が置き換えた利用者の設定があれば、控えから元に戻す） | ほかの MCP サーバとほかの設定 |
| 導入が写した Skill（`~\.claude\skills`・`~\.gemini\config\skills`・`~\.agents\skills` の下） | 写したあとに書き換えられた Skill |
| ログイン時の自動起動（スタートアップの `mxstudio-bridge.lnk`）とデスクトップの `mxstudio` | 利用者の Skill の元（`~\.config\mxstudio\skills\`） |
| 導入が起動した橋渡し | LLM が起動した橋渡し（その LLM を終了すると止まる） |
| 導入の記録（`~\.config\mxstudio\setup.json`） | 控え（`~\.config\mxstudio\backup\`） |

終わったら、使っていた環境を開き直す。この PC から跡形なく消すときは、続けて次も消す。

- リポジトリのフォルダ（`%USERPROFILE%\mxstudio`）
- `~\.config\mxstudio`（利用者の Skill・控え・橋渡しの鍵とログ）。**控えは元の設定ファイルのまるごとの写しなので、そこに入っていたトークンも含む。**
  利用者の Skill を残したいときは、先に `skills\` を別の場所へ写す
- ブラウザに残る作業画面の設定（接続先の URL・オブジェクト構造の定義）: Chrome・Edge の設定の「サイトのデータ」で `127.0.0.1:8788` を消す

### 一部の環境だけ外す

導入には環境ごとに外す引数が無いので、その環境の設定から `mxstudio` だけを消す。ほかのサーバの設定は残す。

| 環境 | MCP を外す | Skill を外す |
|---|---|---|
| Claude Code（CLI） | `claude mcp remove --scope user mxstudio` | `~\.claude\skills\` の下の、mxstudio が入れたフォルダ（`mxstudio-workbench` と利用者の Skill の名前）を消す |
| Claude Desktop（チャット・Code タブ） | Settings の「Developer」→「Edit Config」で開く `claude_desktop_config.json` の `mcpServers` から `"mxstudio"` の項目を消し、Claude Desktop を開き直す。Code タブからも外すなら、Claude Code の分も外す | チャットには置いていない。Code タブは Claude Code と同じ |
| Antigravity | `~\.gemini\config\mcp_config.json` の `mcpServers` から `"mxstudio"` の項目を消す（IDE では「View raw config」で開ける） | `~\.gemini\config\skills\` の下の同じ名前のフォルダを消す |
| Codex | `~\.codex\config.toml` から `[mcp_servers.mxstudio]` の表（次の `[` の行の手前まで）を消し、Codex を開き直す | `~\.agents\skills\` の下の同じ名前のフォルダを消す |

外したあとに導入をもう一度実行すると、その環境にまた登録する。Antigravity と Codex は、導入に `--no-antigravity`・`--no-codex` を付けると登録しない
（Claude Code と Claude Desktop は、登録しない引数が無い）。

## 導入手順（Claude Code 向け）

利用者に「インストールして」と頼まれたときは、次のとおりに進める。各コマンドは実行前に利用者の承認を得る。

1. **前提を確かめる**: `node --version`（22.6 以上）と `git --version`。
   足りなければ、利用者の了承を得て `winget install OpenJS.NodeJS.LTS` / `winget install Git.Git` で入れる。
   入れた直後は新しいシェルで `node` と `git` が見えることを確かめる。
2. **取得する**: 置き場所は `%USERPROFILE%\mxstudio`（Mac・Linux は `~/mxstudio`）。
   - 無ければ `git clone <このリポジトリの URL> "%USERPROFILE%\mxstudio"`
   - 既にあれば、その中で `git pull --ff-only`（手元の変更があって進めないときは、何もせずに利用者に伝える）
3. **導入する**: そのフォルダで `node scripts/setup-local.mjs --json`。
   依存の取得（`npm install`）と画面のビルドもこの中で行う。`mxstudio.cmd` は最後に入力待ちで止まるので使わない。
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
| MCP と Skill | 上の「環境ごとの置き場所」の表のとおりに登録する。登録しないときは `--no-antigravity`・`--no-codex`・`--no-skills` |
| 自動起動・ショートカット | ログイン時に橋渡しを起動するショートカットと、デスクトップの `mxstudio` を作る |

何度実行しても壊れない。詳しくは [docs/local.md](docs/local.md)。

## Skill（作業手順書）

LLM に mxstudio の使い方を教えるファイル。**アプリ既定**と**利用者の Skill** の 2 か所に分けている。

| | 置き場所 | 中身 | 更新 |
|---|---|---|---|
| アプリ既定 | このリポジトリの `skills/`（今は `mxstudio-workbench` の 1 本） | どの業務にも共通の基本手順と禁止事項 | mxstudio と一緒に置き換わる。書き換えない |
| 利用者の Skill | `~/.config/mxstudio/skills/<名前>/SKILL.md` | 業務や客先ごとの手順 | 利用者が置く。mxstudio を更新しても消えず、このリポジトリにも入らない |

- **どの環境でも届く。** mxstudio をつないだ会話では、最初にツールを使ったときの結果に、基本手順と利用者の Skill の一覧が添えられる。
  Skill のファイルを置かない Claude Desktop のチャットや `agy` CLI でも、これで同じ手順になる（利用者の Skill の本文は、LLM がツールで読む）。
- **チャットから作れる。** 作業の途中で「この手順を Skill として残して」と頼むと、LLM が名前・説明・本文を示して確かめたうえで
  `~/.config/mxstudio/skills/` に保存する。
- 各環境の Skill の置き場所へは、導入のたびに写す。利用者の Skill を足したり直したりしたら、導入をもう一度実行する
  （「mxstudio の Skill を入れ直して」と頼めばよい）。
- アプリ既定と同じ名前は使えない。どちらが入っているかは作業画面の設定の「Skill」に出る。
- 書き方はアプリ既定の `skills/mxstudio-workbench/SKILL.md` と同じ（frontmatter に `name`・`description`・`metadata.version`）。

## 文書

- [docs/local.md](docs/local.md) — 毎日の使い方・更新・取り消し・うまくいかないとき・どこに何を書くか
- [docs/status.md](docs/status.md) — 今どこまでできているか
- [docs/publish.md](docs/publish.md) — GitHub へ送る前の検査（客先の情報を送らない）

## 開発

```bash
npm run typecheck      # tsc（app / bridge）
npx vitest run         # 試験（app / bridge）
npm run test:setup     # 導入スクリプトの試験（一時フォルダだけに書き、本物の claude コマンドは呼ばない）
npm run build          # アプリ既定の Skill の生成と画面のビルド（dist/app）
npm run dev:app        # 画面の開発サーバ（http://localhost:5173/app?demo=1 で架空のサンプルを表示）
node scripts/check-publish.mjs --worktree   # 送る前の検査（docs/publish.md）
```

依存を入れるときは、IBM のテレメトリ（`@carbon/react` などが入れるときに動く `@ibm/telemetry-js`）を止める（PowerShell なら `$env:IBM_TELEMETRY_DISABLED='true'; npm install`）。導入スクリプト（`scripts/setup-local.mjs`）は自分で止める。画面の見た目の約束は [docs/design.md](docs/design.md)。

**Maximo への反映は、開発環境の Maximo とダミーデータでだけ試すこと。** 書き込みを自動で元に戻す仕組みは無い。

