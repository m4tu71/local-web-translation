# local-web-translation

PLaMo 3 Translate をブラウザ内で実行する静的翻訳アプリ（開発中）。

開発方針は Vanilla TypeScript + HTML + CSS + Vite。UI フレームワークは使用しません。

- [開発環境の定義と確認結果](docs/development-environment.md)
- [推論エンジンの導入・切り替え方針](docs/inference-engine-integration.md)
- [推論 API とライフサイクル](docs/inference-api.md)
- [モデルの取得と進捗表示](docs/model-download.md)
- [OPFS によるモデルキャッシュ](docs/model-cache.md)
- [GitHub Actions と GitHub Pages](docs/github-pages.md)
- [日本語→英語の手動検証画面](docs/translation-poc.md)
- [wllama の自前ビルド手順](docs/wllama-self-build.md)
- [wllama 成果物の確認結果](docs/wllama-build-verification.md)

## 現在の状態

2026-11-08 時点。推論 API・モデル取得・検証画面と OPFS キャッシュを実装し、利用者から OPFS への保存・復元・推論が動作したとの手動確認報告を受領しています。環境の詳細と期限・異常系の確認状況は[キャッシュ文書](docs/model-cache.md)に記録しています。

| 項目 | 状態 |
| --- | --- |
| TypeScript / Vite | 構築済み。依存復元・型検査・ビルド・HTTP 配信を確認 |
| wllama 3.12.0 相当 | 通常版・compat 版を vendor/wllama/ に保存。ハッシュと版整合を確認 |
| アプリへの wllama 導入 | 通常版・compat 版をローカル tarball から導入済み。lockfile 更新済み |
| 依存の復元 | npm ci --offline で成功。両 WASM のハッシュも manifest と一致 |
| WASM / Worker の組み込み | HTTP 配信と、利用者の環境での GPU / CPU（WASM）の動作を確認 |
| 推論 API | ロード・翻訳・中止・破棄・状態通知を実装。モックで検証 |
| PFML3・BOS・停止条件 | raw prompt と生成設定を実装。ロード時のトークン設定検査を追加。実モデルでの停止は未検証 |
| モデル取得・キャッシュ | 固定版の取得・検証・進捗・中止、OPFS キャッシュ・保持期限・メモリ保存を実装。利用者が保存・復元・推論の動作を手動確認 |
| 翻訳検証画面 | 利用者が GPU / CPU の両経路で1文翻訳・上限未到達・ロード解除を確認。ログを保存済み |
| OPFS キャッシュ・期限管理 | 実装済み。模擬 OPFS のテストと、実ブラウザーでの手動確認状況は[キャッシュ文書](docs/model-cache.md)を参照 |
| アプリ全体のオフライン利用 | 未実装。モデルの OPFS 保存だけではオフライン起動を保証しない |
| GitHub Actions CI | PR / main 用 workflow を追加。GitHub 上での初回実行は未確認 |
| GitHub Pages 公開 | main 用 workflow を追加。Settings の Source 設定と実公開は未確認 |

準備ブランチでは開発環境・成果物・文書を整備しました。
依存導入・復元確認とアセットの読み込み設定を終え、feat/inference-poc ブランチで
UI から独立した推論 API、モデル取得、日英翻訳の検証画面を実装し、最初の1文翻訳を確認しました。
GPU / CPU 別の手動確認と時間・ログの記録まで完了しました。ブラウザ・端末の詳細は未記録です。
ブラウザ操作は自動化しません。

## ローカル開発

Node.js 22.23.4 / npm 10.9.10 を使用します。

```sh
npm ci
npm run dev
```

http://localhost:5173/local-web-translation/ を開いてください。
「モデルを取得」で約573 MBのダウンロードが始まります。取得前に配信元のモデルライセンスを確認してください。
既定ではモデルを OPFS に保存し、次回起動時にキャッシュを検証して再利用します。OPFS が利用できない場合は、保存先を「このページのメモリだけ」に切り替えられます。取得後に「モデルをロード」→「英語へ翻訳」の順で操作できます。保持期間は最終使用から7日で、最大30日まで変更できます。実ブラウザーでの OPFS 確認状況は[キャッシュ文書](docs/model-cache.md)を参照してください。過去の手動翻訳確認は[翻訳検証結果](docs/translation-poc.md)を参照してください。

```sh
npm run typecheck
npm test
npm run build
npm run preview
```

本番ビルドのプレビューは http://localhost:4173/local-web-translation/ です。
dist/ が配信対象です。モデル重みは含めません。

GitHub Pages の有効化と公開後の手動確認は[手順書](docs/github-pages.md)を参照してください。

## ライセンス

アプリケーションのソースは [MIT](LICENSE) です。PLaMo モデルは別の PLaMo Community License に従います。
wllama と依存コードのライセンス・著作権表示は配布パッケージ内に保持します。
ブラウザ配信分の表示は [第三者ライセンス](public/THIRD_PARTY_NOTICES.txt) に含めます。

