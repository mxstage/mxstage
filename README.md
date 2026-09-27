# mxstudio

Maximo（MAS Manage）のデータ整備を、利用者の Claude Code と一緒に行うためのツール。
画面（作業画面）と MCP サーバを、利用者の PC の中だけで動かす。

- **データの正本はブラウザの作業タブだけ。** Claude のツール呼び出しは作業タブに届き、その場でグリッドに
  反映される。読み込んだ表も Maximo の API キーも、タブの外には保存しない。
- **Maximo への書き込みは、利用者が作業画面で [Maximo に反映] を押したときだけ。** Claude のツールからは書き込めない。
- **外部のサーバを使わない。** この PC で動く「橋渡し」（Node のプロセス 1 つ）が、画面の配信・Claude との MCP 接続・
  Maximo への中継を引き受ける。Maximo は橋渡しが直接呼ぶので、Maximo 側の CORS 設定も要らない。

## 入れ方

**Claude Code（Claude Desktop の Code タブでもよい）に、このリポジトリの URL と「インストールして」とだけ伝える。**
Claude Code が下の「導入手順（Claude Code 向け）」に沿って入れる。コマンドを実行する前に、Claude Code が確認を求める。

終わったら、**Claude Code を終了して開き直す**（新しいセッションからツールと Skill が使える）。
デスクトップの `mxstudio`（または `http://127.0.0.1:8788/app`）を開き、**設定で Maximo の URL と API キーを入れる。**
API キーはチャットに書かない。

更新は「mxstudio を更新して」、取り消しは「mxstudio をアンインストールして」と伝える。

### 必要なもの

- Windows（Mac・Linux は試していない）
- Node.js 22.6 以上、Git（無ければ導入の途中で入れてよいか確認される）
- Chrome か Edge
- Claude Code、または Claude Desktop（Code タブ）
- Antigravity（2.0・IDE・`agy` CLI）でも使える（入っていれば導入が登録する。導入そのものは Claude Code に頼む）

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
   - Claude Code を終了して開き直すこと（新しいセッションからツールと Skill が使える）
   - 作業画面（`http://127.0.0.1:8788/app`）の設定で、Maximo の URL と API キーを入れること
   - API キーをチャットに書かないこと（受け取らない）

**更新**は 2〜4 と同じ（`git pull --ff-only` のあと `node scripts/setup-local.mjs --json`）。
橋渡しが古いまま動いていると新しいコードにならないので、終わったら Claude Code と Claude Desktop を終了して開き直してもらう。
**取り消し**は `node scripts/setup-local.mjs --uninstall --json`。**状態の確認**は `node scripts/setup-local.mjs --status --json`（何も書き換えない）。

## 導入で何が起きるか

| 対象 | 内容 |
|---|---|
| 橋渡し | ポート `8788`（固定。ずらさない）で起動する。PC に 1 つだけで、Claude が起動した分はここへ中継する |
| Claude Code | `~/.claude.json` に MCP サーバ `mxstudio` として登録する |
| Claude Desktop | 入っていれば、その設定にも登録する |
| Antigravity | `~/.gemini` があれば `~/.gemini/config/mcp_config.json` にも登録する（2.0・IDE・`agy` CLI 共通） |
| Skill | アプリ既定と利用者の Skill を `~/.claude/skills`（Antigravity に登録したときは `~/.gemini/skills` にも）に入れる（下の「Skill」） |
| 自動起動・ショートカット | ログイン時に橋渡しを起動するショートカットと、デスクトップの `mxstudio` を作る |

書き換える前に必ず控え（`~/.config/mxstudio/backup/`）を取り、既にあるほかの設定は消さない。
詳しくは [docs/local.md](docs/local.md)。

## Skill（作業手順書）

Claude に mxstudio の使い方を教えるファイル。**アプリ既定**と**利用者の Skill** の 2 か所に分けている。

| | 置き場所 | 中身 | 更新 |
|---|---|---|---|
| アプリ既定 | このリポジトリの `skills/`（今は `mxstudio-workbench` の 1 本） | どの業務にも共通の基本手順と禁止事項 | mxstudio と一緒に置き換わる。書き換えない |
| 利用者の Skill | `~/.config/mxstudio/skills/<名前>/SKILL.md` | 業務や客先ごとの手順 | 利用者が置く。mxstudio を更新しても消えず、このリポジトリにも入らない |

利用者の Skill を足したら、もう一度導入すると Claude Code に入る（「mxstudio の Skill を入れ直して」と頼めばよい）。
アプリ既定と同じ名前は使えない。どちらが入っているかは作業画面の設定の「Skill」に出る。
書き方はアプリ既定の `skills/mxstudio-workbench/SKILL.md` と同じ（frontmatter に `name`・`description`・`metadata.version`）。

## 文書

- [docs/local.md](docs/local.md) — 毎日の使い方・更新・取り消し・うまくいかないとき・どこに何を書くか
- [docs/status.md](docs/status.md) — 今どこまでできているか

## 開発

```bash
npm run typecheck      # tsc（app / bridge）
npx vitest run         # 試験（app / bridge）
npm run test:setup     # 導入スクリプトの試験（一時フォルダだけに書き、本物の claude コマンドは呼ばない）
npm run build          # アプリ既定の Skill の生成と画面のビルド（dist/app）
npm run dev:app        # 画面の開発サーバ（http://localhost:5173/app?demo=1 で架空のサンプルを表示）
```

**Maximo への反映は、開発環境の Maximo とダミーデータでだけ試すこと。** 書き込みを自動で元に戻す仕組みは無い。
