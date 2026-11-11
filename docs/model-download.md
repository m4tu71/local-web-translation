# 固定 revision からのモデル取得

状態: 固定版の取得処理・進捗・中止・エラー表示と OPFS キャッシュを実装。模擬データによる自動検証を実施。
2026-11-08、利用者から OPFS への保存・復元・推論が動作したとの報告を受領。詳細は[キャッシュ文書](model-cache.md)を参照。
利用者の旧画面での手動確認では、実モデルの取得とページ内削除に加え、ロード・日本語1文翻訳も成功。[旧画面の記録](translation-poc.md)を参照。
通常翻訳画面では、利用者が「モデルと保存設定」から取得し、その後「モデルをロード」を明示的に実行します。「オフライン利用と設定」からのアプリ資産保存はモデル取得と別操作で、モデルは従来どおり OPFS で管理します。アプリとモデルの双方が準備済みならオフラインで起動できる設計ですが、実ブラウザーでのオフライン起動・推論は未確認です。画面の要件は[翻訳画面設計書](translation-ui.md)、Service Worker と OPFS の境界は[オフライン利用設計](offline-and-preferences.md)に記載しています。

## 手動確認の記録

2026-11-08、利用者から[公開先](https://m4tu71.github.io/local-web-translation/)でモデルを取得できたとの報告を受領した。同じ公開先でのロード・翻訳・ロード解除と、ブラウザー再起動後のモデル保持確認はそれぞれ[翻訳検証](translation-poc.md#公開先での手動確認)と[キャッシュ](model-cache.md#手動確認の記録)に記録する。取得時間やネットワーク記録は受領していない。

2026-11-06、利用者からモデルの取得とメモリからの削除が可能であるとの報告を受領。
エージェントによるブラウザ操作は行っていない。ブラウザ・端末の詳細は未記録。
中止・再試行・異常系の実ブラウザ検証と、実際のヒープ解放量の計測は未実施。
11月6日のメモリ削除確認は、後日の OPFS 保存確認やモデルロード・翻訳・CPU / GPU の検証結果とは区別する。

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
  OPFS は両方の検証後にメタデータを確定し、メモリ保存は検証済み Blob だけを ready 状態で公開する。

## 保持と API

既定では検証済みデータを OPFS に保存する。保存と復元、保持期限、削除、メモリ保存への切り替えは[OPFS キャッシュ文書](model-cache.md)を参照。永続ストレージの許可は要求しない。OPFS を選んだ場合、再読み込み後も有効なキャッシュを再利用できる。メモリ保存を選んだ場合はページの終了・再読み込みで失われる。どちらの保存方法でも再開ダウンロードは行わず、再試行は固定版の先頭から取得する。

| ModelDownloader のメソッド | 動作 |
| --- | --- |
| initialize() | 起動時にキャッシュを調べ、期限・サイズ・SHA-256 を確認する。ネットワーク取得はしない |
| download() | 固定モデルを選択先へ取得・検証して Blob を返す。取得中の重複要求は busy で拒否 |
| getState() / subscribe(listener) | 取得・確認・保存の状態と進捗を取得・購読。subscribe は現在値を即時通知 |
| getModel() | 選択した保存先の検証済み Blob / File を返す。利用前は acquireModel() で再検証する |
| acquireModel(signal?) | 有効期限とファイルを確認し、モデル使用中の共有ロックを持つリースを返す。使用後は release() する |
| markUsed() | OPFS の最終使用時刻を更新する |
| setRetentionDays(days) | 1〜30日の保持日数を設定する |
| setStorageMode(mode) | OPFS またはこのページのメモリ保存を選ぶ |
| abort() | 取得中の fetch とストリームを中止し、元の取得 Promise の終了を待つ |
| clear() | OPFS キャッシュとページ内のモデルを削除し idle に戻す。取得・削除中やロード中は busy で拒否 |

download() の reject は呼び出し側で処理する。中止は cancelled として区別し、破損データや
途中のデータは getModel() に公開しない。保持済みなら download() は同じ Blob を返して通信しない。
OPFS キャッシュを再利用するときも、ロード直前に有効期限とモデルのサイズ・SHA-256 を再確認する。キャッシュが破損または期限切れなら削除して再取得を促す。clear() は、選択中の保存先にかかわらず OPFS キャッシュとページ内メモリの両方を削除する。

メモリ保存を選んだ場合は、受信チャンクと最終 Blob を保持するためモデルサイズ以上の空きメモリが必要。
ブラウザごとのピーク使用量・速度は未測定で、メモリ不足によるタブ終了を防げるとは保証しない。

## UI と状態

checking の後、idle または既存キャッシュの ready へ進む。取得は downloading → verifying → ready、
保持期間変更は updating-retention、削除は clearing を経由する。中止は cancelling → cancelled、
失敗は error。cancelled / error から再試行できる。

- 受信中はバイト数・MB・割合・progress 要素を更新する。
- verifying と cancelling は不定進捗にし、100% 受信と検証完了を区別する。
- phase の変化は role=status、エラーは role=alert で通知する。
  ネットワークチャンクごとの数値をライブ通知し続けない。
- 中止・再試行・モデル削除を同じ領域に置き、処理中にできない操作は無効化する。
- 成功してもロードや翻訳を自動実行しない。通常画面の「モデルをロード」を押すと、
  getModel() の Blob を [推論 API](inference-api.md) の loadModel([blob]) へ渡す。
  ロード完了後も、入力と翻訳方向を指定して「翻訳する」を押すまで推論を開始しない。
- ロードを開始した後は、ロード解除が完了するまでモデル削除を無効にする。

## ファイルとテスト

| ファイル | 責務 |
| --- | --- |
| src/models/plamo.ts | 固定モデルの定義と URL の構築 |
| src/models/download.ts | ストリーム取得、サイズ・SHA-256 検証、受信資源の解放 |
| src/models/model-download.ts | 状態通知、同時実行の制御、中止、OPFS / メモリ保存の接続 |
| src/ui/model-download-view.ts | 状態から表示・ボタンの可否を決定 |
| src/ui/model-download.ts | DOM の更新とボタン操作 |
| tests/model-download.test.mjs | 小さな模擬ストリームと UI 状態のテスト |
| tests/model-cache.test.mjs | 模擬 OPFS を用いた保存・復元・期限・破損・中止のテスト |

テストはモデル本体や実ネットワークを使わず、正常取得、URL・資格情報設定、進捗、HTTP エラー、
部分応答、ストリーム非対応、サイズ不一致、破損、途中切断、中止と再入、再試行、メモリ削除を確認する。
ブラウザによる CORS 判定・画面表示や実モデル取得の成功を示すものではない。
