import { InferenceError } from '../inference/types.ts';
import type { InferenceEngine, InferenceState, ModelLoadOptions, TranslationResult } from '../inference/types.ts';

interface ModelSource {
  getModel(): Blob | undefined;
  acquireModel?(signal?: AbortSignal): Promise<{ model: Blob; release(): Promise<void> }>;
  markUsed?(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export type PocOperation = 'idle' | 'loading' | 'translating' | 'unloading';

export interface PocResult extends TranslationResult {
  readonly elapsedMs: number;
}

export interface TranslationSessionState {
  readonly operation: PocOperation;
  readonly cancelling: boolean;
  readonly engine: InferenceState;
  readonly hasModelFile: boolean;
  readonly modelInUse: boolean;
  readonly requestedBackend?: ModelLoadOptions['backend'];
  readonly result?: PocResult;
  readonly notice?: string;
  readonly error?: string;
  readonly logs: readonly string[];
}

const EMPTY_ENGINE_STATE: InferenceState = Object.freeze({ phase: 'idle', modelLoaded: false });

function errorDetails(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;

  while (current instanceof Error && !seen.has(current) && messages.length < 5) {
    seen.add(current);
    messages.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }

  return messages.length ? messages.join(' → ') : String(error);
}

/** Connects verified model data to the inference API without DOM or wllama calls. */
export class TranslationSession {
  private state: TranslationSessionState;
  private engine?: InferenceEngine;
  private unsubscribeEngine?: () => void;
  private releaseModelLease?: () => Promise<void>;
  private operationController?: AbortController;
  private operationCompletion?: Promise<void>;
  private resolveOperationCompletion?: () => void;
  private listeners = new Set<(state: TranslationSessionState) => void>();
  private readonly modelSource: ModelSource;
  private readonly createEngine: () => InferenceEngine;
  private readonly now: () => number;

  constructor(
    modelSource: ModelSource,
    createEngine: () => InferenceEngine,
    now: () => number = () => performance.now(),
  ) {
    this.modelSource = modelSource;
    this.createEngine = createEngine;
    this.now = now;
    this.state = Object.freeze({
      operation: 'idle',
      cancelling: false,
      engine: EMPTY_ENGINE_STATE,
      hasModelFile: Boolean(modelSource.getModel()),
      modelInUse: false,
      logs: Object.freeze([]),
    });
    modelSource.subscribe(() => {
      this.update({ hasModelFile: Boolean(modelSource.getModel()), notice: undefined });
    });
  }

  getState(): TranslationSessionState {
    return this.state;
  }

  subscribe(listener: (state: TranslationSessionState) => void): () => void {
    this.listeners.add(listener);
    this.notify(listener, this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async load(backend: 'auto' | 'cpu'): Promise<void> {
    this.assertIdle();
    if (!this.modelSource.getModel()) {
      throw new Error('先にモデルを取得してください。');
    }
    if (this.state.engine.modelLoaded) {
      throw new Error('設定を変更するには、先にロードを解除してください。');
    }

    const started = this.now();
    const controller = new AbortController();
    this.operationController = controller;
    this.operationCompletion = new Promise<void>(resolve => { this.resolveOperationCompletion = resolve; });
    this.update({
      operation: 'loading',
      modelInUse: true,
      requestedBackend: backend,
      result: undefined,
      notice: undefined,
      error: undefined,
    });
    this.log(`ロード開始: 要求設定=${backend}, contextSize=2048, threads=1`);

    try {
      // A cancelled/failed engine may still own resources. Dispose before retry.
      await this.releaseEngine();
      const lease = await this.modelSource.acquireModel?.(controller.signal);
      this.releaseModelLease = lease?.release;
      controller.signal.throwIfAborted();
      const model = lease?.model ?? this.modelSource.getModel();
      if (!model) throw new Error('モデルを読み取れません。もう一度取得してください。');
      this.engine = this.createEngine();
      this.unsubscribeEngine = this.engine.subscribe(engine => {
        if (engine.phase !== this.state.engine.phase) {
          this.log(`推論状態: ${engine.phase}`);
        }
        this.update({ engine });
      });
      await this.engine.loadModel([model], { backend, contextSize: 2048, threads: 1 });
      await this.touchModelCache();
      this.log(`ロード完了: ${this.elapsed(started)} ms`);
    } catch (error) {
      this.reportError(error);
      throw error;
    } finally {
      if (!this.engine && this.releaseModelLease) {
        await this.releaseModelLease();
        this.releaseModelLease = undefined;
      }
      this.operationController = undefined;
      this.update({ operation: 'idle', cancelling: false, modelInUse: Boolean(this.engine) });
      this.resolveOperationCompletion?.();
      this.resolveOperationCompletion = undefined;
      this.operationCompletion = undefined;
    }
  }

  async translate(text: string): Promise<void> {
    this.assertIdle();
    if (!this.engine || !this.state.engine.modelLoaded) {
      throw new Error('先にモデルをロードしてください。');
    }

    const engine = this.engine;
    const started = this.now();
    this.operationController = new AbortController();
    this.update({ operation: 'translating', result: undefined, notice: undefined, error: undefined });
    this.log('翻訳開始: ja → en, maxTokens=512');

    try {
      const result = await engine.translate({
        text,
        sourceLanguage: 'ja',
        targetLanguage: 'en',
        maxTokens: 512,
      });
      const elapsedMs = this.elapsed(started);
      this.update({ result: Object.freeze({ ...result, elapsedMs }) });
      await this.touchModelCache();
      this.log(`翻訳終了: ${elapsedMs} ms, truncated=${result.truncated}`);
    } catch (error) {
      this.reportError(error);
      throw error;
    } finally {
      this.operationController = undefined;
      this.update({ operation: 'idle', cancelling: false });
    }
  }

  async abort(): Promise<void> {
    if (!['loading', 'translating'].includes(this.state.operation)) {
      return;
    }

    this.log('中止を要求しました。操作の終了とリソース解放を待ちます。');
    this.operationController?.abort();
    this.update({ cancelling: true });
    if (!this.engine) {
      await this.operationCompletion;
      return;
    }
    try {
      await this.engine.abort();
      await this.operationCompletion;
    } catch (error) {
      this.reportError(error);
      throw error;
    }
  }

  async unload(): Promise<void> {
    this.assertIdle();
    this.update({ operation: 'unloading', result: undefined, notice: undefined, error: undefined });
    this.log('ロード解除開始');

    try {
      await this.releaseEngine();
      this.update({ notice: 'ロードを解除しました。取得済みのモデルは選択した保存先に保持しています。' });
      this.log('ロード解除完了。取得済みのモデルは選択した保存先に保持しています。');
    } catch (error) {
      this.reportError(error);
      throw error;
    } finally {
      this.update({ operation: 'idle', modelInUse: Boolean(this.engine) });
    }
  }

  clearResult(): void {
    if (this.state.operation === 'idle') {
      this.update({ result: undefined, notice: undefined, error: undefined });
    }
  }

  private async releaseEngine(): Promise<void> {
    if (this.engine) {
      await this.engine.dispose();
      this.unsubscribeEngine?.();
      this.unsubscribeEngine = undefined;
      this.engine = undefined;
    }
    if (this.releaseModelLease) {
      await this.releaseModelLease();
      this.releaseModelLease = undefined;
    }
    this.update({ engine: EMPTY_ENGINE_STATE });
  }

  private async touchModelCache(): Promise<void> {
    try {
      await this.modelSource.markUsed?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存日時を更新できませんでした。';
      this.update({ notice: `処理は完了しましたが、モデルの保存日時を更新できませんでした。${message}` });
      this.log(`モデルキャッシュの最終使用日時を更新できませんでした: ${message}`);
    }
  }

  private assertIdle(): void {
    if (this.state.operation !== 'idle') {
      throw new Error('実行中の操作が終わるまで待ってください。');
    }
  }

  private elapsed(started: number): number {
    return Math.round(this.now() - started);
  }

  private reportError(error: unknown): void {
    if ((error instanceof InferenceError && error.code === 'cancelled') ||
        (typeof error === 'object' && error !== null && 'code' in error && error.code === 'cancelled')) {
      this.update({
        result: undefined,
        notice: '操作を中止しました。再実行するにはモデルをロードしてください。',
        error: undefined,
      });
      this.log('操作を中止しました。再実行するにはモデルをロードしてください。');
      return;
    }

    const message = error instanceof Error ? error.message : '処理に失敗しました。';
    const invalidInput = error instanceof InferenceError && error.code === 'invalid-input';
    const recovery = invalidInput
      ? '入力を修正して再試行してください。'
      : '検証ログを確認し、ロード解除後に再試行してください。';

    this.update({ notice: undefined, error: `${message} ${recovery}` });
    const code = error instanceof InferenceError ? `${error.code}: ` : '';
    this.log(code + errorDetails(error));
  }

  private log(message: string): void {
    const line = `${new Date().toISOString()} ${message}`;
    this.update({ logs: Object.freeze([...this.state.logs, line].slice(-100)) });
  }

  private update(patch: Partial<TranslationSessionState>): void {
    const state = Object.freeze({ ...this.state, ...patch });
    this.state = state;
    for (const listener of [...this.listeners]) {
      if (this.state !== state) {
        break;
      }
      if (this.listeners.has(listener)) {
        this.notify(listener, state);
      }
    }
  }

  private notify(listener: (state: TranslationSessionState) => void, state: TranslationSessionState): void {
    try {
      listener(state);
    } catch (error) {
      console.error('Translation PoC listener failed', error);
    }
  }
}
