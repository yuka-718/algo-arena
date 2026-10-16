# ALGO ARENA

Algoをオンライン対戦ゲームとして遊ぶための、GitHub Pages対応の静的サイトです。

## ローカルで確認

```bash
python3 -m http.server 4173
```

ブラウザで http://localhost:4173 を開いてください。

## 現在の実装

- ランク対戦 / カジュアル / 遊び方の導線
- マッチング演出と模擬対戦モーダル
- レート・週間ランキングのダッシュボードUI
- スマホ対応

## バックエンドを起動

Node.js 20以上で、リポジトリのルートから実行します。

```bash
npm start
```

APIは認証（ゲスト / ユーザー登録 / ログイン）、ロビー、対戦作成、推理結果、レート保存を提供します。データは `server/data/db.json` に保存されます。GitHub Pagesは静的ホスティングなので、実際の複数人対戦を公開する場合はこのNodeサーバーをRenderやRailwayなどにデプロイし、フロントのAPI URLを差し替えてください。

## 公開デプロイ

`Dockerfile` と `render.yaml` を含めています。RenderでこのリポジトリをBlueprintとして読み込むと、Node APIを公開できます。`/api/health` が稼働確認用エンドポイントです。フロントとAPIを同一ホストで公開する場合はNodeサーバーをそのまま配信元にしてください。
