# Handoff: mxstudio 作業画面を Industry デザインシステムに合わせる

## 概要
mxstudio（`src/app`）の見た目を Industry デザインシステム（鋼青 1 色・Barlow・角のない線画・細い罫線）に合わせ、作業画面の要素を減らしてミニマルにする。
**振る舞い・文言・データの流れは変えない。** 変えるのは見た目と、いくつかの要素の置き場所だけ。

## このフォルダのファイルについて
同梱の `.dc.html` は **HTML で作ったデザインの見本**（見た目と配置の参照）であり、そのまま使うコードではない。
やることは、mxstudio の既存の作り（React + `app.css` + Glide Data Grid）の中で、この見た目を再現すること。
見本のデータ（WO101003 など）は `boot/demo.ts` を模した架空のもの。

- ブラウザで開くと見本が表示される（`support.js` が要る。同じフォルダに置いたまま開く）。
- 見本の右上の Tweaks で「行の詳細」「LLM からの反映依頼」「確認ダイアログ」を切り替えられる。

## 忠実度
**High-fidelity。** 色・文字・余白・配置は見本どおりに作る。
表（グリッド）は本番では canvas（Glide Data Grid）なので、見本の DOM ではなく `GRID_THEME` とセルの色で同じ見え方にする。

---

## 作業画面（/app）

### 全体
- 背景は **白 `#ffffff`**（`html`・`body`・`.app`・各ペイン・ダイアログ）。
- 縦に「上部バー（高さ 52px）」→「作業領域」。上部バーは 1 段だけ。これまでの `.sheetbar`（シートタブの帯）と、下端の `.legend`（凡例の帯）は**無くす**。
- 作業領域 = 左に表の領域（`flex:1`、内側の余白 20.4px = `--space-6`）＋ 右にサイドパネル（幅 300px、右と上下の余白は 20.4px、左の余白は 0）。

### 上部バー（`TopBar.tsx` と、`AppPage.tsx` のシートタブ）
高さ 52px・左右の余白 20.4px・下に 1px の罫線（`--color-divider`）。左から次の順に並べる。

1. **接続のインジケーター**：直径 8px の○（`--color-accent` #5980a6）だけ。文字は出さない。
   中継・Maximo の状態の文言は `title` に入れる。例：`中継: primary（…）／ Maximo: 接続名（host / user）`。
   - 状態で色を変える：ok = `--color-accent`、warn = `--color-accent-400`、error = `--color-neutral-800`、muted = `--color-neutral-400`。
   - 「再読み込み」ボタンと「つながらないときは…」の案内は、該当する状態のときだけ ○ の右に出す（今と同じ条件）。
2. **シートタブ**：○ のすぐ右に置き、間を詰める（タブ列に `margin-left: -10.2px`）。左詰め。
   - 1 つのタブ：13px・左右の余白 14px・バーの高さいっぱい。
   - 選択中：文字 `--color-text`・下線 2px `--color-accent`。それ以外：文字 `--color-neutral-600`・下線なし。hover で文字を `--color-text` にする。
   - 変更の件数：数字だけ（Barlow Condensed 12px・`--color-accent-700`）。丸いバッジは使わない。
   - 反映の依頼を示す点（`.dot`）：タブからは外す。依頼はサイドパネルで示す。
3. 空き（`flex:1`）
4. **ⓘ ボタン**（Lucide `info`、15px、ボタンは 26×26）：押すと下に**凡例のツールチップ**が開き、もう一度押すと閉じる。
   - 開いている間はアイコンの色を `--color-accent-700` にする（普段は `--color-neutral-700`）。
   - ツールチップ：幅 236px・背景白・枠 1px `--color-divider`・影 `--shadow-md`・角は四角。ボタンの右端に揃え、8px 下に出す。
   - 中身：見出し「セルの色」（11px・`--color-neutral-600`）→ 凡例 4 行（○ 10px ＋ ラベル 12px・行の間 6px）→ 罫線 → 「セルにマウスを置くと作者・根拠・変更前後を表示します」（11px）。
   - 凡例の順：LLM の変更 / 利用者の変更 / 追加行 / 削除行（読み取り専用は凡例から外す。色ではなく文字の薄さで分かるため）。
   - 外側を押したら閉じる（`ColumnFilterMenu` と同じやり方）。
5. **オブジェクト構造**：文字のリンク（12px・`--color-neutral-700`、hover で `--color-accent-700`）。読み込み中の表示（`（読み込み中 n/m）`）は今のまま付ける。
6. **設定**：アイコンのボタン（Lucide `settings`・16px・ボタンは 30×30・`title="設定"`・`aria-label="設定"`）。
7. **作業終了**：アイコンのボタン（Lucide `log-out`・16px・ボタンは 30×30・`title`／`aria-label` は「作業終了」）。確認ダイアログは今のまま出す。
8. **パネルの出し入れ**：アイコンのボタン（Lucide `panel-right`・16px・30×30）。`title` は「反映と変更履歴のパネルを出し入れする」。これまでの「パネルを隠す／出す」の文字ボタンを置き換える。

アイコンのボタンは `.btn.btn-ghost` 相当にする：背景なし・hover で `color-mix(accent 10%)`・押した時は `color-mix(accent 18%)`・キーボードで選んだ時は枠 2px `--color-accent`。

### 表の領域（ペイン）
- ペイン全体を **1 つの線画の枠**で囲む（1px `--color-divider`・角は四角・四隅に「+」の印（`.blueprint` と `.corner`））。ペインごとの枠と角丸はやめる。
- ペインの間は、枠の中に 1px の罫線だけを引く（グリッドの `gap:1px` と罫線色の背景で作る）。ペインの背景は白。
- 並べ方は今と同じ（`count-2/3/4`）。

**ペインの見出し**（高さ 40px・左の余白 13.6px・右の余白 10.2px・下線なし）
- 選択中のシートのペインだけ、左端に縦棒（2×14px・`--color-accent`）を置く。これが `aria-current` の目印になる（枠の色は変えない）。
- 表の名前：Barlow Condensed 600・16px。サブタイトル（`MXAPIWODETAIL`・`工事管理 の子`・`A → B`）は `title` に入れ、画面には出さない。
- 連動しているとき：「連動中 ×」（11px・`--color-accent-700`、`btn-ghost`、Lucide `x` 11px）。押すと連動を外す（これまでの「連動を外す」）。
- 右端：行数（Barlow Condensed 13px・`--color-neutral-700`。絞り込み中は `1 / 12`、絞り込みなしは `25 行`）→「行の詳細」の開閉（Lucide `panel-bottom`・14px・26×26。開いている間は `--color-accent-700`）→「広げる」（Lucide `maximize-2`・14px・26×26。押すと「並べて表示」に戻す）。

**絞り込みの帯（`ColumnFilterBar`）**
- 絞り込みが**無いとき**は帯を出さない（件数はペインの見出しに出ている。「列の見出しの ▾ から絞り込めます」は行数の `title` に入れる）。
- 絞り込みが**あるとき**だけ、見出しの下に札の列を出す。札は角を四角にし、枠 1px `--color-divider`・12px。「すべて外す」は `btn-ghost`。
- 「行の詳細」ボタンは見出しに移したので、帯には置かない。

**グリッド（`SheetGrid.tsx` の `GRID_THEME`）**
```ts
const GRID_THEME: Partial<Theme> = {
  accentColor: "#5980a6",
  accentLight: "rgba(89, 128, 166, 0.07)",
  accentFg: "#ffffff",
  fontFamily: '"Barlow", "Hiragino Sans", "Yu Gothic UI", Meiryo, system-ui, sans-serif',
  baseFontStyle: "13px",
  headerFontStyle: "500 11.5px",
  editorFontSize: "13px",
  bgCell: "#ffffff",
  bgHeader: "#ffffff",
  bgHeaderHovered: "#f5f5f8",
  bgHeaderHasFocus: "#f5f5f8",
  borderColor: "rgba(29, 31, 32, 0.07)",   // 行の間の罫線
  horizontalBorderColor: "rgba(29, 31, 32, 0.07)",
  headerBottomBorderColor: "rgba(29, 31, 32, 0.16)",
  textDark: "#1d1f20",
  textMedium: "#7a7a7d",
  textHeader: "#424244",
  textLight: "#98989b",
};
```
- **縦の罫線は引かない**（列の間の線なし。Glide では `verticalBorder={() => false}`）。横の罫線だけ。
- 行の高さは 30px、見出しの高さは今の `headerHeightFor` のまま（見本では 2 行で 36px）。
- 列の見出し（`drawHeader`）：上の行は日本語ラベル（500・11.5px・`#424244`）、下の行は属性名（10px・`#98989b`・字間 0.04em）。▾ は Lucide `chevron-down`・10px・`#98989b`。
- セルの左右の余白は 8px。ペインの左右に 13.6px の余白を取り、表が枠に接しないようにする。
- 選んだセル：枠 1.5px `#5980a6`。同じ行の他のセル：`accentLight` の薄い塗り。

**セルの色（`cellStyle.ts` の `TONE_STYLE`）**：すべてデザインシステムの段の色にする。
```ts
export const TONE_STYLE: Record<CellTone, { bg: string; fg: string }> = {
  normal:   { bg: "#ffffff", fg: "#1d1f20" },
  readonly: { bg: "#ffffff", fg: "#7a7a7d" }, // 背景は塗らず、文字だけ薄くする（neutral-600）
  llm:      { bg: "#d6ebff", fg: "#2c455d" }, // accent-200 / accent-800
  user:     { bg: "#94bce3", fg: "#1d2d3d" }, // accent-400 / accent-900
  added:    { bg: "#e7e7ea", fg: "#1d1f20" }, // neutral-200 / text
  deleted:  { bg: "#d4d4d7", fg: "#5d5d60" }, // neutral-300 / neutral-700 ＋ 取り消し線
};
```
- 削除行の文字には取り消し線を引く（Glide ではセルの `themeOverride` だけでは引けないので、`drawCell` で線を描き足す）。
- `TONE_LABEL` は凡例用。凡例（ⓘ のツールチップ）では `readonly` を出さない。

**行の詳細（`RowDetail.tsx`）**
- ペインの下に出す。上に 1px の罫線・最大の高さ 48%・余白は上 10.2px／左右 13.6px／下 13.6px。
- 見出し：キーの値（`BEDFORD / WO101003`。Barlow Condensed 600・14px）＋「8 / 8 列に値」（11px・`--color-neutral-600`）。「閉じる」ボタンは無くす（ペインの見出しのボタンで開け閉めする）。
- 項目は `grid-template-columns: repeat(auto-fill, minmax(150px, 1fr))`・行の間 10.2px・列の間 20.4px。点線は引かない。
  - `dt`：ラベルだけ（11px・`--color-neutral-600`）。属性名は `title` に入れる。
  - `dd`：12.5px・折り返す。
  - 変更したセル：背景は塗らず、文字を作者の色（`TONE_STYLE[...].fg`）にする。
  - 長い文章（`.long`）は幅いっぱいに出す（今と同じ）。

### サイドパネル（`aside.side`）
幅 300px・左の罫線なし・背景白。中の 3 つのブロックの間は 27.2px（`--space-8`）空ける。

1. **表示の切替（最終 / 差分 / 元の値）**：`AppPage` のシート帯から**ここに移す**。「Maximo への反映」の上に置く。
   `.seg` を幅いっぱいに、3 つを均等に並べる（各 `flex:1`）。枠 1px `--color-divider`・角は四角・12px・余白は上下 5px。選択中は `--color-accent` の塗りに白い文字。
   サイドパネルを隠すと、この切替も一緒に隠れる。
2. **Maximo への反映（`CommitPanel.tsx`）**
   - `h2`「Maximo への反映」：Barlow Condensed 600・20px。
   - 反映先：`MXAPIWODETAIL → demo.example.com`（12px・`--color-neutral-700`。構造名は等幅 11.5px）。
   - 依頼があるとき（`requested`）：パネルの背景は塗らない。左に 2px `--color-accent` の線を引いた段落にし、見出し「LLM から反映の依頼があります」（600・`--color-accent-800`）→ 依頼のメモ（12.5px・最大 8em で超えたらスクロール）→「依頼を閉じる」（`btn-ghost` 11.5px）。
   - 件数：4 列の表（上下に 1px `--color-divider`・列の間の線なし）。数字は Barlow Condensed 600・24px、その下にラベル（10.5px・`--color-neutral-600`）。左に揃える。
   - **「Maximo に反映」**：画面の中で色の塗られたボタンはこれ 1 つだけ。`.btn-primary`：`--color-accent` の塗り・白い文字・角は四角・四隅に「+」の印（`.blueprint`）・幅いっぱい・余白は上下 10px・Barlow Condensed 600・15px。
     hover は `--color-accent-600`、押した時は `--color-accent-700`、使えない時は薄さ 45%。
   - その下に 1 行：左に「状態: 反映の依頼あり」、右に「書き込みログ（CSV）」の文字リンク（`--color-accent-700`）。どちらも 11.5px。
   - 「反映を中止」・止められた理由（`blockers`）・`commit-message`・行ごとの結果の表は今と同じ条件で出す。見た目は `.btn-secondary`、エラーは `--color-neutral-800` の文字（赤は使わない）、結果の表は `.table`（Industry）に合わせる。
3. **変更履歴（`HistoryPanel.tsx`）**
   - `h2`「変更履歴」：20px。
   - 1 件 = 3 列のグリッド（`8px 1fr auto`・列の間 10px・上下の余白 10px・上に `rgba(29,31,32,.07)` の罫線）。
     - 左：作者を示す ○ 8px（LLM = `#d6ebff`、利用者 = `#94bce3`、薄い輪郭付き）。作者の色付きバッジ（`.author`）はやめる。
     - 中：作者（600）・件数（`--color-neutral-700`）・時刻（右寄せ・Barlow Condensed・`--color-neutral-600`）。その下に根拠（`--color-neutral-700`）。
     - 右：取り消しのアイコンボタン（Lucide `undo-2`・13px・24×24。`title` は「取り消す」または「取り消し済み」）。
   - 取り消し済みの項目：全体の薄さ 50%・根拠に取り消し線・ボタンは使えなくする。

### 確認ダイアログ（`ui/Dialog.tsx`）
- 背景幕：`color-mix(neutral-900 50%)`。
- 本体：幅 min(440px, 100%)・背景白・枠 1px `--color-divider`・**角は四角**・四隅に「+」の印・影 `--shadow-lg`・余白 20.4px。
- タイトル：Barlow Condensed 600・20px。本文 13.5px、注意書きは 12px `--color-neutral-700`。
- チェックボックス：`accent-color: #5980a6`。
- ボタン：「やめる」は `.btn-secondary`、「反映する」は `.btn-primary`。右寄せで、間は 6.8px。

### トースト（`ui/toast.tsx`）
- 背景 `--color-neutral-900` #2b2b2d・文字白・角は四角・影 `--shadow-md`。エラーの時は背景を `--color-accent-900` #1d2d3d にする（赤は使わない）。

---

## 設定画面・オブジェクト構造の画面
見本は `settings-v1-reference.dc.html`（Tweaks で「設定」を選ぶと見られる）。ミニマル化の前の版なので、**色・文字・部品の形の参照にだけ使う**。
- `.page`：最大の幅 760px（`.wide` は 1180px）・背景白。
- `.card`：背景なし・枠 1px `--color-divider`・角は四角・四隅に「+」の印・余白 20.4px・カードの間は 27.2px。
- 見出し：`h1` Barlow Condensed 36px、`h2` 22px。
- `input` と `select`：Industry の `.input`（高さの下限 36px・枠 1px `--color-divider`・角は四角・背景 `--color-surface`。hover で枠を濃くし、選んでいる時は枠 `--color-accent`）。
- `.notice.ok`：`--color-accent-100` の背景に `--color-accent-800` の文字。`.notice.warn` と `.notice.error`：`--color-neutral-200` の背景に `--color-neutral-900` の文字、左に 2px `--color-neutral-800` の線。
- 入力の誤り（`aria-invalid`・`.field-error`）：枠と文字を `--color-neutral-900` にして、600 の太さにする。
- オブジェクト構造の画面（`.os-item`・`.attr-table`・`.badge`）も同じ規則に合わせる：角は四角、選択中は枠 `--color-accent` ＋ `--color-accent-100` の背景、表は `.table`。

---

## 振る舞いと状態
今の振る舞いは変えない。増える状態は次の 2 つだけ。
| 状態 | 置き場所 | 内容 |
|---|---|---|
| `legendOpen: boolean` | `TopBar` | ⓘ のツールチップの開閉。外側を押す・Esc で閉じる |
| 表示の切替 | `AppPage` の `view`／`setView` | そのまま。描く場所だけを `aside.side` の先頭に移す（`CommitPanel` の上） |

そのほかの注意
- サイドパネルを隠すと表示の切替も見えなくなる。今は「最終」以外を選んだまま隠せる。気になる場合は、隠している間は上部バーのパネルボタンの横に小さく「差分」などを出す（任意）。
- 狭い画面（`showOnePane` と `HIDE_SIDE_WIDTH`）の動きは今のまま。

## デザインの変数（`industry-styles.css` から）
`app.css` の `:root` をこの値に置き換え、今の `--bg`・`--accent` などは新しい変数に読み替える。
| 役割 | 変数 | 値 |
|---|---|---|
| 地（このアプリでは白を使う） | — | `#ffffff` |
| 文字 | `--color-text` | `#1d1f20` |
| アクセント | `--color-accent` | `#5980a6` |
| 罫線 | `--color-divider` | `rgba(29,31,32,.16)` |
| 薄い罫線 | — | `rgba(29,31,32,.07)` |
| accent 100…900 | `--color-accent-*` | `#eef6ff #d6ebff #b5d9fd #94bce3 #749dc4 #597ea3 #416180 #2c455d #1d2d3d` |
| neutral 100…900 | `--color-neutral-*` | `#f5f5f8 #e7e7ea #d4d4d7 #b7b7ba #98989b #7a7a7d #5d5d60 #424244 #2b2b2d` |
| 余白 | `--space-1/2/3/4/6/8` | `3.4 / 6.8 / 10.2 / 13.6 / 20.4 / 27.2 px` |
| 影 | `--shadow-md` / `--shadow-lg` | `0 3px 10px rgba(43,43,45,.16)` / `0 12px 32px rgba(43,43,45,.22)` |
| 角 | — | すべて 0（例外は ○ の印だけ） |

- 本文：`"Barlow", "Hiragino Sans", "Yu Gothic UI", Meiryo, system-ui, sans-serif`（Barlow には日本語が無いので、日本語は OS の字体で出る）。
- 見出しと数字：`"Barlow Condensed"`（600）。
- 等幅：`ui-monospace, Consolas, "BIZ UDGothic", monospace`（今のまま）。
- キーボードで選んだ時の枠：`outline: 2px solid #5980a6; outline-offset: 2px`。
- **このデザインシステムは鋼青 1 色だけ。** 緑・黄・赤（`--ok`・`--warn`・`--error`・`.tone-*`）は使わず、段の濃さと線の太さで区別する。

### スクロールバー
```css
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--color-neutral-400)}
::-webkit-scrollbar-thumb:hover{background:var(--color-accent)}
::-webkit-scrollbar-corner{background:transparent}
@supports (-moz-appearance:none){*{scrollbar-width:thin;scrollbar-color:var(--color-neutral-400) transparent}}
```
**`scrollbar-width` と `scrollbar-color` は Firefox だけに効かせること。** Chrome 121 以降は、この 2 つが指定されていると `::-webkit-scrollbar` を無視して太いバーを描く。

## 素材
- **フォント**：Barlow（400/500/700）と Barlow Condensed（400/600）。README に「外部 CDN を使わない」とあるので、Google Fonts から読み込まず、woff2 を `public/fonts/` に同梱して `@font-face` で読み込む。`sw.ts` と `pwa/cacheRules.ts` のキャッシュの対象にも加える。
- **アイコン**：Lucide（線の太さ 1.5）。使うのは `info`・`settings`・`log-out`・`panel-right`・`panel-bottom`・`maximize-2`・`x`・`chevron-down`・`undo-2`。依存を増やさないなら、SVG のパスを小さな部品（`ui/Icon.tsx`）に書き写す（パスは見本の HTML にある）。

## ファイル
- `work-screen.dc.html`：**作業画面の最終の見本**（これを正にする）
- `settings-v1-reference.dc.html`：設定画面と、ミニマル化の前の作業画面（色と部品の参照だけ）
- `industry-styles.css`：デザインシステムの変数と部品（`.btn`・`.seg`・`.blueprint`・`.table`・`.dialog` など）
- `support.js`：見本を開くための実行部品（本番には入れない）

## 直す対象（mxstudio 側）
- `src/app/styles/app.css`：変数・部品・配置のほぼすべて
- `src/app/pages/TopBar.tsx`：接続を ○ に、ⓘ と凡例のツールチップ、設定・作業終了・パネルのアイコン化
- `src/app/pages/AppPage.tsx`：シートタブを上部バーへ移す、`.sheetbar` と `.legend` を無くす、表示の切替をサイドパネルへ、ペインの見出し
- `src/app/grid/SheetGrid.tsx`：`GRID_THEME`・`drawHeader`・縦の罫線をやめる・削除行の取り消し線
- `src/app/grid/cellStyle.ts`：`TONE_STYLE`
- `src/app/grid/ColumnFilterBar.tsx`：絞り込みが無い時は帯を出さない
- `src/app/grid/RowDetail.tsx`：見出しと項目の形
- `src/app/pages/CommitPanel.tsx`・`HistoryPanel.tsx`：上の説明どおり
- `src/app/ui/Dialog.tsx`・`toast.tsx`：角を四角に、色を合わせる
- `src/app/index.html`：`theme-color` を `#ffffff` のままにする

**確かめること**：配置と文言が変わるので、`tests/app/ui-*.test.ts`（特に `ui-root`・`ui-panels`・`ui-grid-filter`・`ui-row-detail`）が落ちる可能性がある。
振る舞いの試験は直さずに通し、画面の作り（文字のボタン → `aria-label` 付きのアイコン、など）を確かめている部分だけを直す。最後に `npm run typecheck` と `npx vitest run` を通すこと。
