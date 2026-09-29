# 画面の見た目の約束（IBM Carbon Design System）

mxstudio の画面（`src/app`）は [IBM Carbon Design System](https://carbondesignsystem.com) の **White テーマ** に合わせる。
部品は `@carbon/react`、アイコンは `@carbon/icons-react`、書体は IBM Plex。ダークテーマは作らない。

## どこに何があるか

| もの | 置き場所 |
|---|---|
| Carbon の変数（`--cds-*`）と、使う部品の SCSS | `src/app/styles/carbon.scss` |
| このアプリの変数（`--mx-*`）| `carbon.scss` の `:root`（書体の並び・シートタブの件数の色）、`app.css` の `:root`（サイドパネルの幅） |
| 画面の配置と、Carbon に無い部品（シートタブ・ペイン・行の詳細・変更履歴など） | `src/app/styles/app.css` |
| グリッド（canvas）の色と寸法 | `src/app/grid/SheetGrid.tsx`（`GRID_THEME` とその下の定数）、`src/app/grid/cellStyle.ts`（`TONE_STYLE`） |
| 知らせ・ダイアログ・通知・リンク | `src/app/ui/Notice.tsx`・`Dialog.tsx`・`toast.tsx`・`Link.tsx` |

- 部品を足したら、`carbon.scss` にもその部品の SCSS を足す（全部を読むと CSS が数百 KB 増えるので、使うものだけを読んでいる）。
- `app.css` では、`.cds--` で始まるセレクタは末尾の「Carbon の部品への意図した上書き」の欄にだけ書く。
  Carbon の部品に付けた自前の class（`commit-button`・`notice` など）には幅や余白などの配置だけを書く。
- 要素のセレクタ（`p`・`ul` など）は自前の範囲の中で `:where()` に包む（Carbon の部品の規則に勝たないように）。

## グリッド（canvas）の色

canvas には CSS の変数が届かないので、Carbon の White テーマの値を JavaScript に写している。テーマの値を変えたら、ここも合わせる。

| 役割 | 値 | Carbon の名前 |
|---|---|---|
| 選んだセルの枠・アクセント | `#0f62fe` | interactive（blue 60） |
| 見出しの地 / hover / focus | `#e0e0e0` / `#d1d1d1` / `#c6c6c6` | layer-accent-01 など（DataTable の見出しと同じ） |
| 行の間の罫線 / 見出しの下の罫線 | `#e0e0e0` / `#c6c6c6` | border-subtle-00 / border-subtle-01 |
| 文字 | `#161616` / `#525252` / `#6f6f6f` | text-primary / text-secondary / text-helper |
| 選んだ行の塗り | `rgba(141,141,141,.20)` | background-selected（利用者の変更の青と紛れないよう灰色） |
| 絞り込み中の列の見出し（地・文字・漏斗） | `#d0e2ff` / `#002d9c` / `#0f62fe` | blue 20 / 80 / 60 |
| 「文字を含む」で当たった部分 | `rgba(15,98,254,.20)` と下線 `#0043ce` | blue 60 / 70 |

行の高さは 32px（DataTable の sm）、見出しは 1 段 32px・2 段 48px。見出しの ▾ と漏斗は Carbon の `chevron--down` と `filter` の形を描く。

### セルの色（`TONE_STYLE`）

変更したセルは 20 の段（数が少なく、目立たせる）、行ごとの色は 10 の段（行全体が騒がしくならないように）。文字と地のコントラストはどれも 4.5:1 以上。

| 種類 | 地 | 文字 | 文字と地のコントラスト |
|---|---|---|---|
| 普通 | `#ffffff` | `#161616` | 18.1 |
| 読み取り専用 | `#ffffff` | `#6f6f6f`（text-helper） | 5.0 |
| LLM の変更 | `#e8daff`（purple 20） | `#6929c4`（purple 70） | 5.9 |
| 利用者の変更 | `#d0e2ff`（blue 20） | `#0043ce`（blue 70） | 5.9 |
| 追加行 | `#defbe6`（green 10） | `#161616` | 16.4 |
| 削除行 | `#fff1f1`（red 10） | `#a2191f`（red 70）＋ 取り消し線 | 7.1 |

凡例（上部バーの ⓘ）・絞り込みの色見本・変更履歴の作者の印・行の詳細の文字の色は、この値を読む。

## 書体

- IBM Plex Sans（400・600）、IBM Plex Sans JP（400・600）、IBM Plex Mono（400）を `@fontsource` で同梱する（外部 CDN を使わない）。
  Carbon の生産的な文字（productive type）は 400 と 600 しか使わないので、ほかの太さは入れない。
- 日本語の書体は分割しない 1 ファイル（1 つの太さで約 0.9MB）を読む。大きいので Service Worker の先読みから外し、
  初めて使ったときに保存する（`src/app/pwa/cacheRules.ts`）。オフラインで初めて開いたときは、日本語だけ OS の字体で出る。
- canvas は書体を読み終えても描き直さないので、`SheetGrid.tsx` は `document.fonts.load()` が済んだら描き直す。

## 部品の約束

- **作業画面で常に出ている primary のボタンは「Maximo に反映」だけ。** ダイアログと絞り込みのメニューには、それぞれ primary を 1 つずつ置く。
- **アイコンだけのボタンは `IconButton`。** `label` がツールチップ、`aria-label` は読み上げと試験のための名前（今までの文言を変えない）。
- **ダイアログ（`ui/Dialog.tsx`）は開いている間だけ描く**（`{open && <Dialog …/>}`）。Carbon のモーダルは閉じても中身を DOM に残すため。
  最初のフォーカスは「やめる」側。閉じてはいけないダイアログ（カナリアの判断待ち）は `onClose` を渡さない（× も Esc も効かない）。
- **知らせ（`ui/Notice.tsx`）の中にはボタンやリンクを置かない**（Carbon の InlineNotification が拒む）。操作は知らせの下に置く。
  読み上げのアイコンの説明は日本語（エラー・注意・完了・お知らせ）。
- **シートタブは Carbon の `Tabs` を使わない**（`pages/SheetTabs.tsx`）。閉じるボタンに英語の説明が付き、Delete キーで閉じてしまい、
  中身の無いタブパネルを指すため。見た目だけ Carbon の line タブに合わせる。
- `Search`（消すボタンの文言が増える）・`PasswordInput`（鍵を見せるボタンが付く）・`CodeSnippet`（英語の「Copied!」）・`Tile`（見出しの意味が失われる）は使わない。
- 状態の色は Carbon の support の色（誤りは赤・注意は黄・成功は緑）。接続の ○ も同じ。黄は白の上で見えにくいので濃い縁を付ける。

## 重なりの順（z-index）

| もの | z-index |
|---|---|
| ペインの境目（`.pane-split`） | 5 |
| セルにマウスを置いたときの説明（`.cell-tooltip`） | 1000 |
| セルの編集欄（Glide の `#portal`。`index.html` に書いてある） | 1200 |
| Carbon のツールチップ・Toggletip・Popover | 6000 |
| 列ごとの絞り込みのメニュー（`.column-filter`） | 6000 |
| Carbon のメニュー・モーダル | 9000 |
| 通知（`.toasts`。モーダルより上） | 9500 |

## 依存を入れるとき

`@carbon/react` と `@carbon/icons-react` は、入れるときに IBM のテレメトリ（`@ibm/telemetry-js`）を動かす。
`IBM_TELEMETRY_DISABLED=true` を付けて入れる（導入スクリプト `scripts/setup-local.mjs` は自分で付ける）。
