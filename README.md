# local-web-translation

PLaMo 3 Translate をブラウザ内で実行する静的翻訳アプリ（開発準備中）。

開発方針は Vanilla TypeScript + HTML + CSS + Vite。UI フレームワークは使用しません。

- [開発環境の定義と確認結果](docs/development-environment.md)
- [推論エンジンの導入・切り替え方針](docs/inference-engine-integration.md)
- [wllama の自前ビルド手順](docs/wllama-self-build.md)（未実行）

## ローカル開発

Node.js 22.23.4 / npm 10.9.9 を使用します。

```sh
npm ci
npm run dev
```

http://localhost:5173/local-web-translation/ を開いてください。
最小限の起動確認ページのみ実装しています。モデルの読み込み・翻訳機能は未実装です。

```sh
npm run typecheck
npm run build
npm run preview
```

本番ビルドのプレビューは http://localhost:4173/local-web-translation/ です。
dist/ が配信対象です。モデル重みは含めません。

