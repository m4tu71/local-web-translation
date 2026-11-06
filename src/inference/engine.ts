import { buildTranslationPrompt } from './pfml.ts';
import type { RuntimeFactory, RuntimePort } from './runtime-port.ts';
import {
  InferenceError,
  type InferenceEngine,
  type InferencePhase,
  type InferenceState,
  type ModelLoadOptions,
  type TranslationRequest,
  type TranslationResult,
} from './types.ts';

interface Operation {
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
  cleanupError?: InferenceError;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InferenceError('invalid-input', `${label} は正の整数を指定してください。`);
  }
}

function createOperation(): Operation {
  let finish!: () => void;
  const done = new Promise<void>(resolve => {
    finish = resolve;
  });

  return { controller: new AbortController(), done, finish };
}

/** Serializes runtime operations; no DOM, storage, model download or wllama API. */
export class InferenceController implements InferenceEngine {
  private state: InferenceState = Object.freeze({ phase: 'idle', modelLoaded: false });
  private listeners = new Set<(state: InferenceState) => void>();
  private runtime?: RuntimePort;
  private active?: Operation;
  private closing = false;
  private disposal?: Promise<void>;
  private loaded = false;

  private readonly createRuntime: RuntimeFactory;

  constructor(createRuntime: RuntimeFactory) {
    this.createRuntime = createRuntime;
  }

  getState(): InferenceState {
    return this.state;
  }

  subscribe(listener: (state: InferenceState) => void): () => void {
    this.listeners.add(listener);
    this.notify(listener, this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async loadModel(files: readonly Blob[], options: ModelLoadOptions = {}): Promise<void> {
    this.assertAvailable();
    if (this.runtime) {
      throw new InferenceError(
        'not-ready',
        '既存のモデルまたはリソースを破棄してから、新しいエンジンを作成してください。',
      );
    }

    if (!files.length || files.some(file => !(file instanceof Blob) || file.size === 0)) {
      throw new InferenceError('invalid-input', '空でない GGUF の Blob / File を指定してください。');
    }
    const settings = {
      backend: options.backend ?? 'auto',
      contextSize: options.contextSize ?? 2048,
      threads: options.threads ?? 1,
    };
    if (!['auto', 'cpu'].includes(settings.backend)) {
      throw new InferenceError('invalid-input', 'backend は auto または cpu を指定してください。');
    }
    positiveInteger(settings.contextSize, 'contextSize');
    positiveInteger(settings.threads, 'threads');
    const modelFiles = [...files];
    return this.run('loading', async signal => {
      this.runtime = await this.createRuntime();
      signal.throwIfAborted();
      await this.runtime.load(modelFiles, settings);
      signal.throwIfAborted();
      this.loaded = true;
    });
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    this.assertAvailable();
    if (!this.runtime || !this.loaded) {
      throw new InferenceError('not-ready', '先にモデルをロードしてください。');
    }

    const prompt = buildTranslationPrompt(request);
    const maxTokens = request.maxTokens ?? 512;
    positiveInteger(maxTokens, 'maxTokens');
    const runtime = this.runtime;
    return this.run('translating', async signal => {
      const result = await runtime.complete(prompt, { maxTokens, signal });
      return Object.freeze({
        text: result.text,
        truncated: result.finishReason === 'length',
      });
    });
  }

  async abort(): Promise<void> {
    const operation = this.active;
    if (!operation) {
      return;
    }

    if (!operation.controller.signal.aborted) {
      operation.controller.abort();
      if (!this.closing) {
        this.publish('stopping');
      }
    }
    await operation.done;
    if (operation.cleanupError) {
      throw operation.cleanupError;
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) {
      return this.disposal;
    }

    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    // Reserve before notification: listeners may re-enter dispose().
    this.disposal = new Promise<void>((resolveDisposal, rejectDisposal) => {
      resolve = resolveDisposal;
      reject = rejectDisposal;
    });
    const promise = this.disposal;
    this.closing = true;
    this.active?.controller.abort();
    this.publish('disposing');
    void this.finishDisposal().then(resolve, error => {
      this.disposal = undefined; // Allow cleanup retry, but never accept new work.
      this.publish('error', error);
      reject(error);
    });
    return promise;
  }

  private async finishDisposal(): Promise<void> {
    await this.active?.done;
    try {
      await this.releaseRuntime();
      this.publish('disposed');
      this.listeners.clear();
    } catch (cause) {
      throw new InferenceError('dispose-failed', '推論リソースを解放できませんでした。', cause);
    }
  }

  private assertAvailable(): void {
    if (this.closing) {
      throw new InferenceError('disposed', '破棄を開始したエンジンは使用できません。');
    }

    if (this.active) {
      throw new InferenceError('busy', '別の推論操作が実行中です。');
    }
  }

  private run<T>(
    phase: 'loading' | 'translating',
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operation = createOperation();
    this.active = operation;
    this.publish(phase);
    return (async () => {
      let nextPhase: InferencePhase = 'ready';
      let notifyError: InferenceError | undefined;
      try {
        operation.controller.signal.throwIfAborted();
        const result = await work(operation.controller.signal);
        operation.controller.signal.throwIfAborted();
        return result;
      } catch (cause) {
        const cancelled = operation.controller.signal.aborted;
        let error = this.operationError(phase, cause, cancelled);

        try {
          await this.releaseRuntime();
          nextPhase = cancelled ? 'idle' : 'error';
          if (!cancelled) {
            notifyError = error;
          }
        } catch (cleanupCause) {
          error = new InferenceError(
            'dispose-failed',
            '操作失敗後のリソース解放に失敗しました。',
            new AggregateError([error, cleanupCause]),
          );
          nextPhase = 'error';
          notifyError = error;
          operation.cleanupError = error;
        }
        throw error;
      } finally {
        this.active = undefined;
        if (!this.closing) {
          this.publish(nextPhase, notifyError);
        }
        operation.finish();
      }
    })();
  }

  private operationError(
    phase: 'loading' | 'translating',
    cause: unknown,
    cancelled: boolean,
  ): InferenceError {
    if (cancelled) {
      return new InferenceError('cancelled', '操作を中止しました。モデルを再ロードしてください。', cause);
    }

    if (phase === 'loading') {
      return new InferenceError('load-failed', 'モデルをロードできませんでした。', cause);
    }

    return new InferenceError('translation-failed', '翻訳に失敗しました。', cause);
  }

  private async releaseRuntime(): Promise<void> {
    this.loaded = false;
    if (this.runtime) {
      await this.runtime.dispose();
      this.runtime = undefined;
    }
  }

  private publish(phase: InferencePhase, error?: InferenceError): void {
    const state: InferenceState = Object.freeze({
      phase, modelLoaded: this.loaded,
      ...(error ? { error: Object.freeze({ code: error.code, message: error.message }) } : {}),
    });
    this.state = state;
    for (const listener of [...this.listeners]) {
      // A listener may change the state. Do not deliver the previous snapshot.
      if (this.state !== state) {
        break;
      }

      if (this.listeners.has(listener)) {
        this.notify(listener, state);
      }
    }
  }

  private notify(listener: (state: InferenceState) => void, state: InferenceState): void {
    try {
      listener(state);
    } catch (error) {
      console.error('Inference state listener failed', error);
    }
  }
}
