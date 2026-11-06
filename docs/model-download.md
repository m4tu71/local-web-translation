# 固定 revision からのモデル取得

状態: 取得処理・進捗・中止・エラー表示を実装し、模擬データで検証済み。
利用者の手動確認で、実モデルの取得とページ内のモデル削除が成功。
その後、利用者の環境でモデルロード・1文翻訳も成功。[結果](translation-poc.md)を参照。

## 手動確認の記録

2026-11-06、利用者からモデルの取得とメモリからの削除が可能であるとの報告を受領。
エージェントによるブラウザ操作は行っていない。ブラウザ・端末の詳細は未記録。
中止・再試行・異常系の実ブラウザ検証と、実際のヒープ解放量の計測は未実施。
モデルロード・翻訳・WebGPU / WASM CPU の検証結果とは区別する。

## モデル定義

src/models/plamo.ts の PLAMO_MODEL を唯一の取得定義とする。
main や latest は取得 URL に使用しない。

| 項目 | 固定値 |
| --- | --- |
| リポジトリ | pfnet/plamo-3-translate-0.8b-GGUF |
| revision | dbeb0856cb0b004b484f190bb71dd65876297013 |
| ファイル | plamo-3-translate-0.8b-Q4_K_M.gguf |
| サイズ | 573,123,200 bytes |
| SHA-256 | 923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd |

値は互換性調査時に取得した Hugging Face の固定 revision のメタデータに基づく。
[配信元の固定版](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/tree/dbeb0856cb0b004b484f190bb71dd65876297013) を参照。
アプリの MIT License とモデルの PLaMo Community License は別であり、画面からモデルのライセンスへリンクする。

## 取得と整合性検証

- 利用者が「モデルを取得」を押したときにだけ、Hugging Face の resolve URL へ直接 GET する。
  起動・状態購読では取得しない。翻訳テキストや認証情報は送らない。
- fetch は mode: cors、credentials: omit、cache: no-store、referrerPolicy: no-referrer。
  途中からの再開は実装せず、再試行は同じ固定版の先頭から取得する。
- HTTP 200 の全体応答だけを受け付ける。エラー応答や HTTP 206 の部分応答をモデルとして扱わない。
- Response.body のストリームから受信量を数え、定義済みのサイズを進捗の総量に使う。
  Content-Length がなくても進捗を表示できる。
- @noble/hashes 2.4.0 の SHA-256 を受信チャンクごとに更新する。
  ハッシュ計算のためにモデル全体を一つの ArrayBuffer へ変換しない。
- 一定量を処理したらイベントループへ制御を戻し、進捗表示と中止操作を処理できるようにする。
- 大きすぎる応答は即座に拒否し、短い応答や SHA-256 の不一致も拒否する。
  両方の検証を通った Blob だけを ready 状態で公開する。

## 保持と API

この段階は 1 文翻訳 PoC に向けた取得機能で、Blob をページのメモリに保持する。
OPFS のキャッシュ・7 日の期限管理・最大 30 日への延長・再開ダウンロードは未実装。
永続ストレージの許可は要求しない。ページを閉じる・再読み込みすることでデータは失われる。

| ModelDownloader のメソッド | 動作 |
| --- | --- |
| download() | 固定モデルを取得・検証して Blob を返す。取得中の重複要求は busy で拒否 |
| getState() / subscribe(listener) | 受信バイト数と段階を取得・購読。subscribe は現在値を即時通知 |
| getModel() | このページで検証済みの Blob を返す。取得前・失敗・中止後は undefined |
| abort() | fetch とストリームを中止し、元の取得 Promise の終了を待つ |
| clear() | 自身が保持する Blob を解放し idle に戻す。取得中は busy で拒否 |

download() の reject は呼び出し側で処理する。中止は cancelled として区別し、破損データや
途中のデータは getModel() に公開しない。保持済みなら download() は同じ Blob を返して通信しない。
clear() 後に再度取得する場合は通信が発生する。呼び出し側が Blob を別に保持していれば、その参照も解放する。

受信中のチャンクと最終 Blob を保持するため、モデルサイズ以上の空きメモリが必要。
ブラウザごとのピーク使用量・速度は未測定で、メモリ不足によるタブ終了を防げるとは保証しない。

## UI と状態

idle → downloading → verifying → ready と進む。
中止は cancelling → cancelled、失敗は error。cancelled / error から再試行できる。

- 受信中はバイト数・MB・割合・progress 要素を更新する。
- verifying と cancelling は不定進捗にし、100% 受信と検証完了を区別する。
- phase の変化は role=status、エラーは role=alert で通知する。
  ネットワークチャンクごとの数値をライブ通知し続けない。
- 中止・再試行・メモリからの削除を同じ領域に置き、処理中にできない操作は無効化する。
- 成功してもロードや翻訳を自動実行しない。[手動検証画面](translation-poc.md) の
  ロードボタンで getModel() の Blob を [推論 API](inference-api.md) の loadModel([blob]) へ渡す。
- ロードを開始した後は、ロード解除が完了するまでメモリからの削除を無効にする。

## ファイルとテスト

| ファイル | 責務 |
| --- | --- |
| src/models/plamo.ts | 固定モデルの定義と URL の構築 |
| src/models/download.ts | ストリーム取得、サイズ・SHA-256 検証、受信資源の解放 |
| src/models/model-download.ts | 状態通知、同時実行の制御、中止、ページ内の Blob 保持 |
| src/ui/model-download-view.ts | 状態から表示・ボタンの可否を決定 |
| src/ui/model-download.ts | DOM の更新とボタン操作 |
| tests/model-download.test.mjs | 小さな模擬ストリームと UI 状態のテスト |

テストはモデル本体や実ネットワークを使わず、正常取得、URL・資格情報設定、進捗、HTTP エラー、
部分応答、ストリーム非対応、サイズ不一致、破損、途中切断、中止と再入、再試行、メモリ削除を確認する。
ブラウザによる CORS 判定・画面表示や実モデル取得の成功を示すものではない。
