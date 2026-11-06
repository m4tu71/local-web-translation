# local-web-translation

PLaMo 3 Translate をブラウザ内で実行する静的翻訳アプリ（開発中）。

開発方針は Vanilla TypeScript + HTML + CSS + Vite。UI フレームワークは使用しません。

- [開発環境の定義と確認結果](docs/development-environment.md)
- [推論エンジンの導入・切り替え方針](docs/inference-engine-integration.md)
- [推論 API とライフサイクル](docs/inference-api.md)
- [モデルの取得と進捗表示](docs/model-download.md)
- [wllama の自前ビルド手順](docs/wllama-self-build.md)
- [wllama 成果物の確認結果](docs/wllama-build-verification.md)

## 現在の状態

2026-11-06 時点。推論 API と固定モデルの取得・進捗表示を実装し、模擬データで検証しています。

| 項目 | 状態 |
| --- | --- |
| TypeScript / Vite | 構築済み。依存復元・型検査・ビルド・HTTP 配信を確認 |
| wllama 3.12.0 相当 | 通常版・compat 版を vendor/wllama/ に保存。ハッシュと版整合を確認 |
| アプリへの wllama 導入 | 通常版・compat 版をローカル tarball から導入済み。lockfile 更新済み |
| 依存の復元 | npm ci --offline で成功。両 WASM のハッシュも manifest と一致 |
| WASM / Worker の組み込み | 依存からの読み込み設定と dev / preview での HTTP 配信を確認。ブラウザ内の初期化は未検証 |
| 推論 API | ロード・翻訳・中止・破棄・状態通知を実装。モックで検証 |
| PFML3・BOS・停止条件 | raw prompt と生成設定を実装。ロード時のトークン設定検査を追加。実モデルでの停止は未検証 |
| モデル取得 | 固定版の取得・検証・進捗・中止・再試行を実装。利用者が実モデルの取得・メモリからの削除を手動確認済み |
| 実モデル推論 | ロード・翻訳用の画面は未実装。実モデルのロード・翻訳は未検証 |
| OPFS・期限管理・オフライン利用 | 未実装 |
| GitHub Actions / Pages 公開 | 未設定・未検証 |

準備ブランチでは開発環境・成果物・文書を整備しました。
依存導入・復元確認とアセットの読み込み設定を終え、feat/inference-poc ブランチで
UI から独立した推論 API とモデル取得画面を実装しました。次に手動 1 文翻訳の PoC を進めます。
ブラウザ操作は自動化せず、実際のロード・翻訳は手動検証の結果が得られるまで未検証として扱います。

## ローカル開発

Node.js 22.23.4 / npm 10.9.10 を使用します。

```sh
npm ci
npm run dev
```

http://localhost:5173/local-web-translation/ を開いてください。
「モデルを取得」で約573 MBのダウンロードが始まります。取得前に配信元のモデルライセンスを確認してください。
取得データはページのメモリに保持し、再読み込みで失われます。ロード・翻訳用の画面は未実装です。

```sh
npm run typecheck
npm test
npm run build
npm run preview
```

本番ビルドのプレビューは http://localhost:4173/local-web-translation/ です。
dist/ が配信対象です。モデル重みは含めません。

## ライセンス

アプリケーションのソースは [MIT](LICENSE) です。PLaMo モデルは別の PLaMo Community License に従います。
wllama と依存コードのライセンス・著作権表示は配布パッケージ内に保持します。
ブラウザ配信分の表示は [第三者ライセンス](public/THIRD_PARTY_NOTICES.txt) に含めます。

