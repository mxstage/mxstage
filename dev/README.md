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
