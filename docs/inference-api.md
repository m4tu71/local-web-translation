# UI から独立した推論 API

状態: API と wllama アダプターを実装。API のライフサイクルをモックで検証。
利用者から旧画面での GPU（auto 要求設定）/ CPU（WASM）のロード・日本語1文翻訳・ロード解除の報告を受領しています。これは通常画面の実ブラウザー確認ではありません。通常画面の操作・状態要件は[翻訳画面設計書](translation-ui.md)を参照してください。

## 使用する API

UI は src/inference/index.ts の createInferenceEngine またはページ共通の inferenceEngine を使う。
返り値の InferenceEngine と状態・エラー・翻訳要求の型に、wllama の型は含めない。
作成直後は idle。エンジン作成・状態購読だけでは wllama の初期化やモデル取得を行わない。

| メソッド | 動作 |
| --- | --- |
| getState() | 現在の変更不可な状態を取得 |
| subscribe(listener) | 現在の状態を即座に通知し、以後の変化を購読。解除関数を返す |
| loadModel(files, options) | 取得済み GGUF の Blob / File 配列からロード |
| translate(request) | ja / en の翻訳要求を PFML3 で処理し、text と truncated を返す |
| abort() | 実行中の操作を中止し、モデルの解放完了まで待つ |
| dispose() | 実行中の操作の終了・リソース解放を待ち、エンジンを使用終了にする |

入力ファイルのダウンロード、revision / ハッシュ検証、OPFS 保存と保持期限は呼び出し元の責務。
この API はネットワークへ翻訳テキストを送らず、モデルも自動取得しない。
固定モデルの取得と画面表示は別の [ModelDownloader](model-download.md) が担当する。
取得後の Blob を loadModel([blob]) へ渡す UI は [TranslationSession](../src/poc/translation-session.ts) 経由で API を呼びます。過去の実モデル確認は[旧画面の検証記録](translation-poc.md)に限定して記録しています。

通常画面から使う `TranslationSession.translate(text, direction)` は日本語 ↔ 英語の方向を受け取り、省略時は日本語 → 英語です。画面と TranslationSession は入力を最大 500 UTF-16 コード単位に制限し、空入力、同じ翻訳元・翻訳先、未対応言語、予約文字列を生成開始前に拒否します。方向は翻訳開始時に固定され、完了結果に `direction` として保持されます。低水準の `InferenceEngine.translate(request)` の要求型は画面上の 500 文字制限を表すものではありません。

入力文・翻訳方向が変わると画面は前の結果を無効にします。ロード解除では、入力文とそのまま有効な翻訳結果を保持します。モデル取得、ロード、翻訳はそれぞれ明示的な操作で開始し、自動取得・自動推論は行いません。

```typescript
import { createInferenceEngine, InferenceError } from './inference/index';

async function translateExample(modelFiles: readonly Blob[]): Promise<void> {
  const engine = createInferenceEngine();
  const unsubscribe = engine.subscribe(state => {
    console.log(state.phase, state.error?.message);
  });

  try {
    await engine.loadModel(modelFiles, {
      backend: 'auto',
      contextSize: 2048,
      threads: 1,
    });

    const result = await engine.translate({
      text: '会議は来週の月曜日に変更されました。',
      sourceLanguage: 'ja',
      targetLanguage: 'en',
      maxTokens: 512,
    });

    console.log(result.text, result.truncated);
  } catch (error) {
    if (error instanceof InferenceError) {
      console.error(error.code, error.message);
    } else {
      throw error;
    }
  } finally {
    unsubscribe();
    await engine.dispose();
  }
}
```

この例は呼び出し方を示すもので、翻訳成功を確認した実行例ではない。
ファイル配列は結合・分割を呼び出し元で済ませ、ロード中に差し替えない。

## ロードと翻訳の設定

- backend は auto または cpu。auto は wllama の GPU 自動選択を利用する指定で、GPU 実行の保証ではない。
  cpu は n_gpu_layers: 0。初期値は contextSize: 2048、threads: 1、同時要求数: 1。
- 翻訳先は ja / en。sourceLanguage は省略でき、指定する場合も ja / en。
- temperature は 0、maxTokens の初期値は 512。正の整数を指定する。
- PFML3 の dataset は translation。BOS は GGUF の設定に基づき llama.cpp が追加するため、
  プロンプト文字列には重複して付けない。入力の予約文字列 <|plamo: は拒否する。
- 停止文字列は <|plamo:tag|> と <|plamo:bos|>。トークン上限による終了は truncated: true として区別する。
- 停止文字列と初期トークン上限は pfml.ts に集約する。生成時は ignore_eos: false、echo: false を明示し、
  EOS を有効にしたまま、入力プロンプトを翻訳結果に含めない。
- ここでは生成途中のテキストを通知しない。状態通知はロード・翻訳などの段階を表し、
  ダウンロードの進捗率・推論の進捗率ではない。

## BOS と停止条件の確認

loadModel が戻った後、wllama の getLoadedContextInfo() で以下を検査する。
これは読み込んだモデルに対する実行時の検査で、ファイル名だけで判断しない。

| 項目 | 固定版モデルでの期待値 |
| --- | --- |
| general.architecture / tokenizer.ggml.model | 両方 plamo3 |
| add_bos_token | true |
| add_eos_token | false |
| BOS / EOS / EOT ID | 1 / 1 / 16 |
| 生成終端の一覧 | EOS と EOT の ID を含む |

不一致なら ready へ進まず、load-failed としてリソースを解放する。
対象は [固定 revision のモデル](model-download.md)。モデル更新時はファイル定義だけでなく
トークンの契約も公式メタデータ・テンプレートと照合する。

PFML3 は raw completion に渡し、チャットテンプレートや assistant プレフィックスを重ねない。
固定版 llama.cpp の raw completion 経路は add_special=true / parse_special=true でトークン化する。
そのため、アプリ側は BOS 文字列を付けず、GGUF の add_bos_token=true による追加に任せる。
入力末尾は output の <|plamo:msg|> とし、入力側へ EOS や停止用トークンを追加しない。
モデルが生成する <|plamo:tag|> / <|plamo:bos|> を停止条件にする。

### 確認の根拠と限界

- [公式 PFML3 説明（固定 revision）](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/blob/dbeb0856cb0b004b484f190bb71dd65876297013/README.md#pfml3-prompt-format)
- [公式 chat_template.jinja](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/blob/dbeb0856cb0b004b484f190bb71dd65876297013/chat_template.jinja)
- [wllama の raw completion 呼び出し](https://github.com/ngxson/wllama/blob/c10c21114984e37fe6ba4edbba446c28c5b7a954/cpp/wllama-context.h)
- [llama.cpp の tokenize_cli_input](https://github.com/ggml-org/llama.cpp/blob/d38bea34227bbf9069d62fdc239c98ab6e05435a/tools/server/server-context.cpp#L2638)

日本語→英語・英語→日本語のプロンプト、原文の空白保持、予約トークン拒否、BOS 非重複、
生成パラメータ、メタデータ不一致時の失敗と解放をモックで確認する。
利用者の環境で旧画面の両経路のロードから日本語→英語1文翻訳まで成功し、ログで truncated=false を確認。
英語→日本語はプロンプトのモック確認であり、実モデルによる翻訳確認ではない。
ロード時の検査の個別ログや生成の停止理由は未記録であり、各停止条件の独立した検証は未実施。

## 状態と同時実行

通常は idle → loading → ready → translating → ready と遷移する。
loading / translating / stopping 中の新しいロード・翻訳は busy で拒否し、内部キューには積まない。
ロード済みモデルの差し替えは dispose 後に新しいエンジンを作って行う。
状態購読関数の例外は処理を失敗させず、購読中の再入でも古い状態を後から通知しない。

失敗は error 状態と InferenceError で通知する。主な code は invalid-input、busy、not-ready、
disposed、load-failed、translation-failed、dispose-failed、cancelled。
入力検証や busy の拒否は、進行中の正常な状態を error に置き換えない。
ロード・翻訳自体の失敗時はリソースを解放する。解放できた場合は同じエンジンでロードを再試行できる。

## 中止と破棄

- abort は loading / translating の操作に中止を要求し、stopping に遷移する。
  元の loadModel / translate の Promise は cancelled で reject されるため、呼び出し側で必ず処理する。
- 翻訳は wllama の abortSignal を利用する。ロードには中止シグナルがないため、
  ロード処理が戻るのを待ってから exit する。即時の中断やタイムアウトは保証しない。
- 中止後に遅れて返った成功結果は破棄する。リソース解放後に idle へ戻り、再ロードが必要。
  モデルのキャッシュファイル自体は削除しない。
- dispose は disposing → disposed。処理中なら中止を要求して終了を待つ。
  処理中の dispose 再呼び出しは同じ Promise を返す。disposed 後はロード・翻訳を受け付けない。
- 解放失敗は dispose-failed として通知する。新しい処理を開始せず dispose を再試行する。
  リソース解放が成功したという通知を先に出さない。

## 実装と検証範囲

| ファイル | 責務 |
| --- | --- |
| types.ts / index.ts | UI が使う型・エラー・生成関数・ページ共通インスタンス |
| engine.ts | 状態遷移・同時実行の制御・中止・破棄・通知 |
| pfml.ts | PFML3 と入力検証 |
| runtime-port.ts | 内部実行境界。UI には公開しない |
| wllama-runtime.ts | インストール済みの WASM / Worker 設定、WASM 前提機能検査、インスタンス生成 |
| wllama-adapter.ts | wllama のロード・completion・exit とアプリ側の型の変換 |

通常版と compat 版のアセット設定・版チェックは維持する。
UI 起動時はアプリ独自の状態通知を購読し、wllama の生成は loadModel が呼ばれるまで遅延する。

npm test は Node.js 標準テストランナーと型の除去機能を使い、ブラウザ・モデル・外部推論 API を必要としない。
テストは偽の RuntimePort / wllama クライアントを使用し、同時実行の拒否、途中の中止・破棄、
失敗後の解放・再試行、通知の再入、PFML3 の参照例、BOS・停止条件の受け渡しを確認する。
成功しても WASM の初期化や実モデル推論の成功を意味しない。
