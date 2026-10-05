# デモのデータを作って公開する

Maximo を持たない人が MX Stage を試すための、架空のデータ（ごみ焼却施設 3 か所、日本語・英語）と Excel のサンプルを、
Cloudflare Pages に静的なファイルとして置く手順です。サーバの計算も利用者の管理も無く、費用はかかりません（静的なファイルへの要求は無料で、回数の上限も無い）。
データの中身は `dev/README.md`。

- 置き場所: Cloudflare Pages のプロジェクト `mxstage-demo`（`https://mxstage-demo.pages.dev`）
- 中身: `v<版>/manifest.json`、`v<版>/<言語>/osdefs.json.gz`・`os/*.ndjson.gz`・`excel/*.xlsx`、`index.html`（Excel のダウンロード）、`_headers`、`robots.txt`
- 正解（Excel の場面の答え・データ品質の問題の一覧）は `dist/demo-data-truth/` に書き出し、**公開しません**

## 作る

```bash
npm run demo:build
```

- 日英で約 10 秒。`dist/demo-data/` に書き出し、最後に `manifest.json` の SHA-256 を出します（製品に埋め込む値）。
- 英語の辞書に無い日本語があると止まります（`dev/datasets/plants/en.ts` に足す）。
- 書き出したファイルを読み戻して、同じ件数の偽の Maximo になることを確かめます。

## 確かめる（公開の前）

```bash
npx vitest run --project dev
```

- Excel は作業画面の読み取り（`src/app/imports/xlsx.ts`）で読めることを試験で確かめます。Excel そのもので開けるかは、Windows なら PowerShell から確かめられます:

```powershell
$xl = New-Object -ComObject Excel.Application; $xl.DisplayAlerts = $false
Get-ChildItem dist\demo-data\v2 -Recurse -Filter *.xlsx | ForEach-Object { $wb = $xl.Workbooks.Open($_.FullName, 0, $true); "$($_.Name) $($wb.Worksheets.Count)"; $wb.Close($false) }
$xl.Quit()
```

## 公開する

公開は利用者の了解を得てから行います。

1. Cloudflare にログインする（初めの 1 回だけ。ブラウザが開く）

   ```bash
   npx wrangler login
   ```

2. Pages のプロジェクトを作る（初めの 1 回だけ）

   ```bash
   npx wrangler pages project create mxstage-demo --production-branch main
   ```

3. 置く

   ```bash
   npx wrangler pages deploy dist/demo-data --project-name mxstage-demo --branch main --commit-dirty=true
   ```

4. 確かめる: `https://mxstage-demo.pages.dev/v2/manifest.json` を落とし、`demo:build` が出した SHA-256 と同じか。Excel を 1 つ落として開けるか。

## 版を上げるとき

- データの中身を変えたら `dev/datasets/plants/generate.ts` の `DATASET_VERSION` を上げる。新しい版は `v<版>/` に置き、古い版のフォルダも残す（古い製品が落とせるように）。
  `wrangler pages deploy` は配置ごとに中身を丸ごと置き換えるので、古い版を残すときは前の版の `dist/demo-data/v<古い版>/` も一緒に置く。
- 製品に埋め込んだ版と SHA-256 を、新しい manifest のものに直してから製品を出す。
