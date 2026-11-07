# local-web-translation

PLaMo 3 Translate をブラウザ内で実行する静的翻訳アプリ（開発中）。

開発方針は Vanilla TypeScript + HTML + CSS + Vite。UI フレームワークは使用しません。

- [開発環境の定義と確認結果](docs/development-environment.md)
- [推論エンジンの導入・切り替え方針](docs/inference-engine-integration.md)
- [推論 API とライフサイクル](docs/inference-api.md)
- [モデルの取得と進捗表示](docs/model-download.md)
- [OPFS によるモデルキャッシュ](docs/model-cache.md)
- [通常の翻訳画面の設計と確認項目](docs/translation-ui.md)
- [GitHub Actions と GitHub Pages](docs/github-pages.md)
- [旧翻訳検証画面の手動記録](docs/translation-poc.md)
- [wllama の自前ビルド手順](docs/wllama-self-build.md)
- [wllama 成果物の確認結果](docs/wllama-build-verification.md)

## 現在の状態

2026-11-08 時点。日英の短文（最大 500 文字）を扱う通常の翻訳画面へ移行しています。画面の構成・状態・アクセシビリティ要件は[翻訳画面の設計書](docs/translation-ui.md)を参照してください。UI の自動確認はモデル・推論エンジンをモックして行い、今回の画面を使った実ブラウザーでのレイアウト、キーボード、コピー、実モデルの一連操作はまだ手動確認していません。過去の実モデル確認は[旧検証記録](docs/translation-poc.md)に分けて記録しています。

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
| 通常の翻訳画面 | 日本語 ↔ 英語の短文翻訳 UI を実装。実ブラウザーでの新 UI の表示・操作・実モデル確認は未実施 |
| OPFS キャッシュ・期限管理 | 実装済み。模擬 OPFS のテストと、実ブラウザーでの手動確認状況は[キャッシュ文書](docs/model-cache.md)を参照 |
| アプリ全体のオフライン利用 | 未実装。モデルの OPFS 保存だけではオフライン起動を保証しない |
| GitHub Actions CI | PR / main 用 workflow を追加。2026-11-08、PR #2 の commit `897638a` で成功（[実行記録](https://github.com/m4tu71/local-web-translation/actions/runs/42414764912)）。この結果は当該 commit の検証で、後続 commit は各 workflow 実行で確認 |
| GitHub Pages 公開 | [公開済み](https://m4tu71.github.io/local-web-translation/)。利用者がモデル取得、CPU / GPU のロード・翻訳・解除、ブラウザー再起動後のモデル保持を手動確認。エージェントは公開 URL の HTML HTTP 200 のみ確認 |

これまでに UI から独立した推論 API、モデル取得、OPFS キャッシュと日英翻訳の検証画面を整備しました。利用者による過去の手動確認とその範囲は[旧検証記録](docs/translation-poc.md)と[キャッシュ文書](docs/model-cache.md)に記録しています。ブラウザー操作は自動化せず、新しい翻訳画面の実ブラウザー確認は別途手動で行います。

## ローカル開発

Node.js 22.23.4 / npm 10.9.10 を使用します。

```sh
npm ci
npm run dev
```

http://localhost:5173/local-web-translation/ を開いてください。通常の翻訳画面は日本語 ↔ 英語の 500 UTF-16 コード単位以内に対応します。初回は「モデルと保存設定」を開き、配信元と PLaMo Community License を確認してから「モデルを取得」を押します。取得後は「翻訳の準備」を実行し、翻訳元・翻訳先を選んで入力します。「入れ替え」は入力文を残したまま方向を交換します。「例文を入力」「入力を消去」「元に戻す」「結果をコピー」も使えます。入力または方向を変更すると前の結果は消えます。入力欄で Ctrl/Cmd + Enter を押すと、通常の翻訳操作と同じ条件で翻訳します。モデル取得・ロードは自動で始まりません。

既定ではモデルを OPFS に保存し、次回起動時にキャッシュを検証して再利用します。OPFS が利用できない場合は、保存先を「このページのメモリだけ」に切り替えられます。保持期間は最終使用から 7 日で、最大 30 日まで変更できます。実ブラウザーでの OPFS 確認状況は[キャッシュ文書](docs/model-cache.md)を参照してください。過去の手動翻訳確認は[旧検証記録](docs/translation-poc.md)を参照してください。

```sh
npm run typecheck
npm test
npm run build
npm run preview
```

本番ビルドのプレビューは http://localhost:4173/local-web-translation/ です。
dist/ が配信対象です。モデル重みは含めません。

GitHub Pages の公開と確認範囲は[手順書](docs/github-pages.md)を参照してください。

## ライセンス

アプリケーションのソースは [MIT](LICENSE) です。PLaMo モデルは別の PLaMo Community License に従います。
wllama と依存コードのライセンス・著作権表示は配布パッケージ内に保持します。
ブラウザ配信分の表示は [第三者ライセンス](public/THIRD_PARTY_NOTICES.txt) に含めます。

