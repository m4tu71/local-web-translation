# UI から独立した推論 API

状態: API と wllama アダプターを実装。モックによるライフサイクル検証済み。
実モデルのロード・翻訳・GPU / CPU 動作は未検証。

## 使用する API

UI は src/inference/index.ts の createInferenceEngine またはページ共通の inferenceEngine を使う。
返り値の InferenceEngine と状態・エラー・翻訳要求の型に、wllama の型は含めない。
作成直後は idle。エンジン作成・状態購読だけでは wllama の初期化やモデル取得を行わない。

| メソッド | 動作 |
| --- | --- |
| getState() | 現在の変更不可な状態を取得 |
| subscribe(listener) | 現在の状態を即座に通知し、以後の変化を購読。解除関数を返す |
| loadModel(files, options) | 取得済み GGUF の Blob / File 配列からロード |
| translate(request) | 日本語または英語の入力を PFML3 で翻訳。text と truncated を返す |
| abort() | 実行中の操作を中止し、モデルの解放完了まで待つ |
| dispose() | 実行中の操作の終了・リソース解放を待ち、エンジンを使用終了にする |

入力ファイルのダウンロード、revision / ハッシュ検証、OPFS 保存と保持期限は呼び出し元の責務。
この API はネットワークへ翻訳テキストを送らず、モデルも自動取得しない。
固定モデルの取得と画面表示は別の [ModelDownloader](model-download.md) が担当する。
取得後の Blob を loadModel([blob]) へ渡す UI の接続は次の工程。

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
- ここでは生成途中のテキストを通知しない。状態通知はロード・翻訳などの段階を表し、
  ダウンロードの進捗率・推論の進捗率ではない。

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
