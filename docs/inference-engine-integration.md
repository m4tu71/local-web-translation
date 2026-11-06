# 推論エンジンの導入・切り替え方針

状態: 自前ビルド成果物を保存・静的確認し、通常版・compat 版を dependencies へ導入済み。
lockfile 更新、npm ls、型検査・ビルド、WASM の HTTP 配信を確認。
利用者の環境で GPU / CPU（WASM）のロード・日本語1文→英語の翻訳・ロード解除が成功。

ロード・翻訳・中止・破棄・状態通知を扱う [推論 API](inference-api.md) を実装し、モックで検証済み。
[固定モデルの取得と進捗表示](model-download.md) も実装済み。推論 API へ取得した Blob を渡す
利用者が実モデルの取得・メモリからの削除を手動確認済み。
[ロード・翻訳用の PoC 画面](translation-poc.md) は実装済み。GPU / CPU 別の手動確認結果とログを記録済み。

具体的な構築コマンドは [wllama の自前ビルド手順](wllama-self-build.md) を参照。
保存した版と検証範囲は [成果物の確認結果](wllama-build-verification.md) を参照。

## 目的

PLaMo 3 対応を含む自前ビルドで PoC を進め、公式 npm 版の対応を確認できた時点で
依存の取得先を変更できるようにする。アプリ側の翻訳 UI・プロンプト・OPFS 管理を
パッケージの配布方法から独立させる。

## 依存関係

アプリが参照するパッケージ名は常に @wllama/wllama とする。
自前ビルドも同名の npm パッケージとしてまとめ、dependencies に指定する。

| 段階 | package.json の @wllama/wllama の取得先 |
| --- | --- |
| 自前ビルド | file:vendor/wllama/wllama-3.12.0-c10c211.tgz |
| 公式版へ移行後 | 対応を検証した公式 npm 版の完全固定バージョン |

上記 tarball と対応する compat 版は vendor/wllama/ に保存し、依存指定へ追加済み。
3.12.0 は調査した開発ソースの表記で、公式 npm 公開版・動作確認済み版を意味しない。
保存済み成果物の対象は wllama commit c10c21114984e37fe6ba4edbba446c28c5b7a954 と、
その submodule の llama.cpp d38bea34227bbf9069d62fdc239c98ab6e05435a。

vendor/ の通常版・compat 版 tarball と manifest は Git 管理済み。
.gitignore の *.tgz に対して当該 2 ファイルだけの例外を追加済み。
導入時に package-lock.json を更新済み。以後の開発・CI は npm ci で依存を復元する。
依存追加後の npm ci --offline による復元と、両 WASM の SHA-256 の manifest との一致を確認済み。
Docker / Emscripten は自前パッケージの作成時に必要とし、アプリの通常ビルドには要求しない。
モデル重みが含まれず、ライセンスが同梱されていることは静的確認済み。

2026-11-06 の調査では、npm 公開版 3.8.1 に紐づく llama.cpp は対象 GGUF の
tokenizer.ggml.model = plamo3 を認識しないため、自前ビルドを PoC 候補とした。
保存した版は識別子と既知の前処理修正を含む。利用者の環境でロード・1文翻訳に成功した。
広い互換性やエンジンの最終採用は、GPU / CPU 別・ブラウザ別の追加検証に基づいて判断する。
根拠: [旧版の判定処理](https://github.com/ggml-org/llama.cpp/blob/46ca246de9bb1c35269722a6240d37d9dfd79cad/src/llama-vocab.cpp#L2130-L2182)、
[保存版の判定処理](https://github.com/ggml-org/llama.cpp/blob/d38bea34227bbf9069d62fdc239c98ab6e05435a/src/llama-vocab.cpp#L2403)、
[前処理修正](https://github.com/ggml-org/llama.cpp/pull/30045)。

## アプリとの境界

```text
UI → InferenceEngine / InferenceController → wllama アダプター → @wllama/wllama
                       ↑
              取得済み Blob / File、PFML3
```

- src/inference/ 内に InferenceEngine 型、InferenceController、wllama アダプターを実装済み。
- UI はロード・翻訳・中止・破棄・状態通知をアプリ独自の型で扱う。
  wllama の型・オプション・レスポンスを UI やストレージ層へ公開しない。
- エンジン固有の import、API 呼び出し、エラー変換、バックエンド設定はアダプターへ集約する。
- PFML3 の組み立てと入力検証はパッケージの取得先に依存しない処理として分離する。
- OPFS の期限管理とモデルの revision / 整合性管理もアプリ側に置く。
  エンジン交換や npm 版への切り替えだけでモデルを再ダウンロードしない。
  モデル自体の変更やキャッシュ破損を検出した場合は別途再取得する。

## JS・Worker・WASM の整合

読み込み設定は src/inference/wllama-runtime.ts に実装済み。
src/main.ts はアプリ独自 API の状態通知を購読する。実際の loadModel 呼び出し時に
wllama モジュールを遅延 import し、インスタンスへアセットの取得元を設定する。
ページ起動や状態通知の購読だけでは WASM の取得・Worker 起動・モデル取得・推論は開始しない。

| アセット | 解決方法 |
| --- | --- |
| 通常版 WASM | @wllama/wllama/esm/wasm/wllama.wasm?url |
| 通常版 Worker | @wllama/wllama の JavaScript 内蔵コードを使用 |
| compat WASM | @wllama/wllama-compat/wasm/wllama.wasm?url |
| compat Worker | @wllama/wllama-compat/wasm/wllama.js?raw を worker.code として渡す |

setCompat にローカルの WASM URL と Worker コードを明示し、CDN のデフォルトを置き換える。
mode は firefox_safari とし、Firefox でも JSPI / Memory64 が不足する場合に compat を選択できるようにする。
compat の強制利用や GPU / CPU の指定ではない。各ブラウザでの実行可否・性能は未検証。
skipVersionCheck は false のまま維持する。ブラウザ実行時の版チェック自体はまだ実施していない。

Vite が両 WASM を内容ハッシュ付きの assets/ へ出力し、base を反映した URL を生成する。
dev / preview の /local-web-translation/ 配下で、両 WASM の HTTP 200、application/wasm、
SHA-256 の manifest との一致を確認。開発用の compat ?raw は元の JS ファイルと一致し、
本番 JS にも Worker コードが含まれる。wllama / llama.cpp のライセンス表示も dist/ に同梱する。

- ビルド時はインストール済み @wllama/wllama の公開パスから必要なアセットを解決する。
  vendor/ のソースツリーや .ai/ を直接参照しない。
- WASM の配置処理は一か所に集約し、dev / build / preview の各経路で同じ依存元を使う。
  現在は Vite の import で解決し、手動コピー処理は設けない。
- Vite によるアセット出力・URL 生成を優先する。コピーが必要な場合は自動化し、
  ビルド出力に古い WASM が残らないようにする。手動コピーを運用手順にしない。
- 出力名は内容ハッシュまたはビルド識別子で区別し、移行後に旧 WASM を再利用しない。
  GitHub Pages の base を反映した URL をアダプターへ渡す。
- wllama の JS / Worker / WASM を同じビルドから揃え、版整合チェックは無効化しない。
- compat を導入する場合も通常版との組み合わせを固定し、一緒に切り替える。
  CDN から別版の WASM を補う構成は使用しない。

## 出自と確認結果

自前パッケージには固定コミット、submodule、ツールチェーン、ビルド手順、
成果物の SHA-256 を記録した manifest を添える。
アプリのビルド記録にも実際の依存バージョンと WASM ハッシュを残し、
「同じ 3.12.0 表記だが中身が異なる」ケースを識別できるようにする。

## 公式 npm 版への移行手順

1. 公開版のソース・組み込み llama.cpp・配布物が PLaMo 3 に対応しているか確認する。
2. dependencies の取得先を公式版の固定バージョンへ変更し、lockfile を更新する。
3. アセット解決・パッケージ API に差があればアダプターとビルド処理だけを調整する。
   取得先の変更だけで必ず移行できるとは保証しない。
4. 型検査・本番ビルド・サブパスでのアセット配信・JS/WASM の版整合を確認する。
5. 手動 PoC で同じモデル revision・PFML3 入力による翻訳、停止条件、GPU / CPU を検証する。
   ブラウザ操作の自動化は行わない。実行結果が得られるまでは未検証として扱う。
6. 問題がなければ旧 tarball と専用ビルド手順を整理する。移行前の Git コミットから
   package.json・lockfile・tarball を一緒に戻せる状態で切り替える。

公式版への移行は開発時に行う。アプリ起動時に latest を自動取得してエンジンを更新しない。
