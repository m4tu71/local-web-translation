# local-web-translation

PLaMo 3 Translate をブラウザ内で実行する静的翻訳アプリ（開発中）。

開発方針は Vanilla TypeScript + HTML + CSS + Vite。UI フレームワークは使用しません。

- [開発環境の定義と確認結果](docs/development-environment.md)
- [推論エンジンの導入・切り替え方針](docs/inference-engine-integration.md)
- [wllama の自前ビルド手順](docs/wllama-self-build.md)
- [wllama 成果物の確認結果](docs/wllama-build-verification.md)

## 現在の状態

2026-11-06 時点。開発環境の準備と wllama の自前ビルド成果物の保存・静的確認まで完了しています。

| 項目 | 状態 |
| --- | --- |
| TypeScript / Vite | 構築済み。依存復元・型検査・ビルド・HTTP 配信を確認 |
| wllama 3.12.0 相当 | 通常版・compat 版を vendor/wllama/ に保存。ハッシュと版整合を確認 |
| アプリへの wllama 導入 | 未実施。package.json の実行時依存はまだなし |
| モデル取得・ロード・翻訳 | 未実装・未検証 |
| OPFS・期限管理・オフライン利用 | 未実装 |
| GitHub Actions / Pages 公開 | 未設定・未検証 |

この準備ブランチは開発環境・成果物・文書の整備までを対象とします。
次のブランチで依存導入、WASM の組み込み、推論アダプター、1 文翻訳の PoC を進めます。
ブラウザ操作は自動化せず、実際のロード・翻訳は手動検証の結果が得られるまで未検証として扱います。

## ローカル開発

Node.js 22.23.4 / npm 10.9.10 を使用します。

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

## ライセンス

アプリケーションのソースは [MIT](LICENSE) です。PLaMo モデルは別の PLaMo Community License に従います。
wllama と依存コードのライセンス・著作権表示は配布パッケージ内に保持します。

