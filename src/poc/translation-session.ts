import { InferenceError } from '../inference/types.ts';
import type {
  InferenceEngine,
  InferenceState,
  ModelLoadOptions,
  TranslationBudget,
  TranslationResult,
} from '../inference/types.ts';
import { splitTranslationText, type TranslationChunk } from '../translation/chunks.ts';
import {
  MAX_INPUT_CHARACTERS,
  validateTranslationInput,
  type TranslationDirection,
} from '../translation/input.ts';

const TRANSLATION_MAX_TOKENS = 512;

interface ModelSource {
  getModel(): Blob | undefined;
  acquireModel?(signal?: AbortSignal): Promise<{ model: Blob; release(): Promise<void> }>;
  markUsed?(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export type PocOperation = 'idle' | 'loading' | 'translating' | 'unloading';

export interface PocResult extends TranslationResult {
  readonly status: 'streaming' | 'partial' | 'complete';
  readonly partialReason?: 'cancelled' | 'error' | 'truncated' | 'empty';
  readonly canResume: boolean;
  readonly completedChunks: number;
  readonly totalChunks: number;
  readonly elapsedMs: number;
  readonly direction: TranslationDirection;
}

export interface TranslationProgress {
  readonly phase: 'planning' | 'translating';
  readonly completed: number;
  readonly total?: number;
}

export interface TranslationSessionState {
  readonly operation: PocOperation;
  readonly cancelling: boolean;
  readonly engine: InferenceState;
  readonly hasModelFile: boolean;
  readonly modelInUse: boolean;
  readonly requestedBackend?: ModelLoadOptions['backend'];
  readonly result?: PocResult;
  readonly translationProgress?: TranslationProgress;
  readonly notice?: string;
  readonly error?: string;
  readonly logs: readonly string[];
}

const EMPTY_ENGINE_STATE: InferenceState = Object.freeze({ phase: 'idle', modelLoaded: false });

function sameDirection(first: TranslationDirection, second: TranslationDirection): boolean {
  return first.sourceLanguage === second.sourceLanguage &&
    first.targetLanguage === second.targetLanguage;
}

function countCompleted(completed: readonly boolean[]): number {
  return completed.filter(Boolean).length;
}

function countCodePoints(text: string): number {
  return Array.from(text).length;
}

function isCancelled(error: unknown): boolean {
  return (error instanceof InferenceError && error.code === 'cancelled') ||
    (typeof error === 'object' && error !== null && 'code' in error && error.code === 'cancelled');
}

interface TranslationPlan {
  readonly text: string;
  readonly direction: TranslationDirection;
  readonly chunks: TranslationChunk[];
  readonly outputs: Array<string | undefined>;
  readonly completed: boolean[];
  readonly retryable: boolean[];
}

interface TranslationRun {
  readonly startedAt: number;
  readonly controller: AbortController;
  readonly finishOperation: () => void;
  readonly operationId: number;
  activeChunkIndex?: number;
}

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
  private translationPlan?: TranslationPlan;
  private translationOperationId = 0;
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
    const finishOperation = this.beginOperationCompletion();
    this.update({
      operation: 'loading',
      modelInUse: true,
      requestedBackend: backend,
      notice: undefined,
      error: undefined,
    });
    this.log(`ロード開始: 要求設定=${backend}, contextSize=2048, threads=1`);

    try {
      // A cancelled/failed engine may still own resources. Dispose before retry.
      await this.releaseEngine();
      const lease = await this.modelSource.acquireModel?.(controller.signal);
      this.releaseModelLease = lease?.release;
      this.throwIfOperationCancelled(controller);
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
      this.throwIfOperationCancelled(controller);
      await this.touchModelCache();
      this.throwIfOperationCancelled(controller);
      this.log(`ロード完了: ${this.elapsed(started)} ms`);
    } catch (error) {
      this.reportError(error);
      throw error;
    } finally {
      try {
        if (!this.engine && this.releaseModelLease) {
          await this.releaseModelLease();
          this.releaseModelLease = undefined;
        }
      } finally {
        this.operationController = undefined;
        this.update({ operation: 'idle', cancelling: false, modelInUse: Boolean(this.engine || this.releaseModelLease) });
        finishOperation();
      }
    }
  }

  async translate(
    text: string,
    direction: TranslationDirection = { sourceLanguage: 'ja', targetLanguage: 'en' },
  ): Promise<void> {
    this.assertIdle();
    if (!this.engine || !this.state.engine.modelLoaded) {
      throw new Error('先にモデルをロードしてください。');
    }

    this.translationPlan = undefined;
    this.translationOperationId++;
    this.update({ result: undefined, translationProgress: undefined, notice: undefined, error: undefined });

    try {
      validateTranslationInput(text, direction);
    } catch (error) {
      this.reportError(error);
      throw error;
    }
    const resultDirection = Object.freeze({ ...direction });
    const engine = this.engine;
    const initialRequest = this.translationRequest(text, resultDirection);
    let initialBudget: TranslationBudget;
    let minimumBudget: number;
    try {
      initialBudget = engine.getTranslationBudget(initialRequest);
      minimumBudget = this.inputTokenUpperBound(engine, 'a', resultDirection);
    } catch (error) {
      this.reportError(error);
      throw error;
    }
    const inputTokenLimit = initialBudget.contextSize - initialBudget.maxOutputTokens;

    if (inputTokenLimit < minimumBudget) {
      const error = new InferenceError(
        'invalid-input',
        'このモデルの入力可能な範囲が小さすぎるため、翻訳を開始できません。',
      );
      this.reportError(error);
      throw error;
    }

    const run = this.beginTranslationRun();
    this.translationPlan = undefined;
    this.update({
      operation: 'translating',
      result: this.createResult({
        text: '',
        truncated: false,
        status: 'streaming',
        canResume: false,
        completedChunks: 0,
        totalChunks: 0,
        elapsedMs: 0,
        direction: resultDirection,
      }),
      translationProgress: Object.freeze({ phase: 'planning', completed: 0 }),
      notice: undefined,
      error: undefined,
    });

    try {
      this.log(`翻訳開始: ${resultDirection.sourceLanguage} → ${resultDirection.targetLanguage}, 上限は最大${MAX_INPUT_CHARACTERS}文字`);
      this.throwIfOperationCancelled(run.controller);

      const chunks = await splitTranslationText(
        text,
        inputTokenLimit,
        candidate => {
          this.throwIfOperationCancelled(run.controller);
          const upperBound = this.inputTokenUpperBound(engine, candidate, resultDirection);
          this.throwIfOperationCancelled(run.controller);
          return upperBound;
        },
      );
      this.throwIfOperationCancelled(run.controller);
      this.translationPlan = this.createTranslationPlan(
        text,
        resultDirection,
        chunks,
      );
      this.update({ translationProgress: Object.freeze({ phase: 'translating', completed: 0, total: chunks.length }) });
      await this.processTranslationPlan(run, 0);
    } catch (error) {
      this.setPartialResult(run, this.partialReason(error));
      this.reportError(error);
      throw error;
    } finally {
      this.operationController = undefined;
      this.update({ operation: 'idle', cancelling: false });
      if (this.translationOperationId === run.operationId) this.translationOperationId++;
      run.finishOperation();
    }
  }

  async resumeTranslation(
    text: string,
    direction: TranslationDirection,
  ): Promise<void> {
    this.assertIdle();
    const plan = this.translationPlan;
    if (!plan || this.state.result?.status !== 'partial' || !this.state.result.canResume) {
      const error = new Error('再開できる未完了の翻訳がありません。入力文を確認して翻訳してください。');
      this.reportError(error);
      throw error;
    }
    if (plan.text !== text || !sameDirection(plan.direction, direction)) {
      const error = new Error('入力文または翻訳方向が変わったため、未完了の翻訳を再開できません。');
      this.reportError(error);
      throw error;
    }
    if (!this.engine || !this.state.engine.modelLoaded) {
      const error = new Error('未完了の翻訳を再開する前に、モデルをロードしてください。');
      this.reportError(error);
      throw error;
    }

    validateTranslationInput(text, direction);
    const engine = this.engine;
    const retryTruncatedChunk = this.state.result?.partialReason === 'truncated';
    const run = this.beginTranslationRun();
    this.update({
      operation: 'translating',
      result: this.state.result
        ? this.createResult({
          ...this.state.result,
          status: 'streaming',
          partialReason: undefined,
          canResume: false,
        })
        : undefined,
      notice: undefined,
      error: undefined,
    });

    try {
      let startIndex = plan.completed.findIndex(completed => !completed);
      if (startIndex < 0) {
        throw new Error('再開する翻訳箇所がありません。');
      }

      const replan = await this.replanPendingChunks(plan, startIndex, engine, run);
      startIndex = replan.startIndex;
      if (replan.replanned) {
        this.update({
          translationProgress: Object.freeze({
            phase: 'translating',
            completed: countCompleted(plan.completed),
            total: plan.chunks.length,
          }),
        });
      }

      if (retryTruncatedChunk && !replan.replanned) {
        const splitIndex = await this.splitTruncatedChunk(plan, startIndex, engine, run);
        if (splitIndex === undefined) {
          this.setPartialResult(run, 'truncated', true);
          this.update({ notice: 'この部分をさらに分けられません。文章を手動で短くしてください。' });
          return;
        }
        startIndex = splitIndex;
        this.update({
          translationProgress: Object.freeze({
            phase: 'translating',
            completed: countCompleted(plan.completed),
            total: plan.chunks.length,
          }),
        });
      }

      this.throwIfOperationCancelled(run.controller);
      await this.processTranslationPlan(run, startIndex);
    } catch (error) {
      this.setPartialResult(run, this.partialReason(error));
      this.reportError(error);
      throw error;
    } finally {
      this.operationController = undefined;
      this.update({ operation: 'idle', cancelling: false });
      if (this.translationOperationId === run.operationId) this.translationOperationId++;
      run.finishOperation();
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
    this.update({ operation: 'unloading', notice: undefined, error: undefined });
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
      this.translationOperationId++;
      this.translationPlan = undefined;
      this.update({
        result: undefined,
        translationProgress: undefined,
        notice: undefined,
        error: undefined,
      });
    }
  }

  private translationRequest(text: string, direction: TranslationDirection) {
    return {
      text,
      sourceLanguage: direction.sourceLanguage,
      targetLanguage: direction.targetLanguage,
      maxTokens: TRANSLATION_MAX_TOKENS,
    } as const;
  }

  private inputTokenUpperBound(
    engine: InferenceEngine,
    text: string,
    direction: TranslationDirection,
  ): number {
    // The PFML prompt builder rejects blank input. Adding a marker only while
    // measuring keeps long whitespace runs conservatively budgeted.
    const measurableText = text.trim() ? text : `${text}a`;
    return engine.getTranslationBudget(
      this.translationRequest(measurableText, direction),
    ).inputTokenUpperBound;
  }

  private createTranslationPlan(
    text: string,
    direction: TranslationDirection,
    chunks: readonly TranslationChunk[],
  ): TranslationPlan {
    return {
      text,
      direction,
      chunks: [...chunks],
      outputs: chunks.map(() => undefined),
      completed: chunks.map(() => false),
      retryable: chunks.map(() => true),
    };
  }

  private beginTranslationRun(): TranslationRun {
    const controller = new AbortController();
    const finishOperation = this.beginOperationCompletion();
    this.operationController = controller;
    return {
      startedAt: this.now(),
      controller,
      finishOperation,
      operationId: ++this.translationOperationId,
    };
  }

  private async processTranslationPlan(run: TranslationRun, startIndex: number): Promise<void> {
    const plan = this.translationPlan;
    const engine = this.engine;
    if (!plan || !engine) throw new Error('翻訳を再開できる状態ではありません。');

    for (let index = startIndex; index < plan.chunks.length; index++) {
      this.throwIfOperationCancelled(run.controller);
      if (plan.completed[index]) continue;

      const chunk = plan.chunks[index];
      run.activeChunkIndex = index;
      plan.outputs[index] = '';
      if (!chunk.text.trim()) {
        // Preserve leading, trailing, or repeated whitespace without asking
        // the model to translate a blank prompt.
        plan.outputs[index] = chunk.text;
        plan.completed[index] = true;
        this.publishChunkProgress(run, plan);
        continue;
      }

      this.publishChunkProgress(run, plan);
      const request = this.translationRequest(chunk.text, plan.direction);
      let currentText = '';
      try {
        const result = await engine.translate(request, {
          onText: cumulativeText => {
            if (!this.isCurrentTranslationRun(run, index) || plan.completed[index]) return;
            currentText = cumulativeText;
            plan.outputs[index] = currentText;
            this.publishChunkProgress(run, plan);
          },
        });
        this.throwIfOperationCancelled(run.controller);

        const generatedText = result.text || currentText;
        plan.outputs[index] = generatedText;
        if (result.truncated) {
          this.setPartialResult(run, 'truncated', true);
          this.log(`翻訳出力上限: ${countCompleted(plan.completed)} / ${plan.chunks.length} 区切りを完了`);
          return;
        }
        if (!generatedText.trim()) {
          this.setPartialResult(run, 'empty', false);
          this.log(`空の翻訳結果: ${countCompleted(plan.completed)} / ${plan.chunks.length} 区切りを完了`);
          return;
        }

        plan.completed[index] = true;
        this.publishChunkProgress(run, plan);
      } catch (error) {
        // Keep the last cumulative stream text for recovery, while the chunk
        // itself remains incomplete and will be replaced when retried.
        if (currentText) plan.outputs[index] = currentText;
        throw error;
      }
    }

    const elapsedMs = this.elapsed(run.startedAt);
    await this.touchModelCache();
    this.throwIfOperationCancelled(run.controller);
    const text = this.composePlanText(plan);
    const completeResult = this.createResult({
      text,
      truncated: false,
      status: 'complete',
      canResume: false,
      completedChunks: countCompleted(plan.completed),
      totalChunks: plan.chunks.length,
      elapsedMs,
      direction: plan.direction,
    });
    this.update({ result: completeResult, error: undefined });
    this.log(`翻訳終了: ${elapsedMs} ms, ${plan.chunks.length} 区切り`);
  }

  private publishChunkProgress(
    run: TranslationRun,
    plan: TranslationPlan,
  ): void {
    if (!this.isCurrentTranslationRun(run)) return;
    const completedChunks = countCompleted(plan.completed);
    this.update({
      result: this.createResult({
        text: this.composePlanText(plan),
        truncated: false,
        status: 'streaming',
        canResume: false,
        completedChunks,
        totalChunks: plan.chunks.length,
        elapsedMs: this.elapsed(run.startedAt),
        direction: plan.direction,
      }),
      translationProgress: Object.freeze({
        phase: 'translating',
        completed: completedChunks,
        total: plan.chunks.length,
      }),
    });
  }

  private setPartialResult(
    run: TranslationRun,
    partialReason: 'cancelled' | 'error' | 'truncated' | 'empty',
    truncated = false,
  ): void {
    const plan = this.translationPlan;
    if (!this.isCurrentTranslationOperation(run)) return;
    if (!plan) {
      const previous = this.state.result;
      this.update({
        result: previous ? this.createResult({
          ...previous,
          text: '',
          truncated,
          status: 'partial',
          partialReason,
          canResume: false,
        }) : undefined,
        translationProgress: undefined,
      });
      return;
    }
    const completedChunks = countCompleted(plan.completed);
    const hasPendingChunk = plan.completed.some(completed => !completed);
    const firstPending = plan.completed.findIndex(completed => !completed);
    const canRetryTruncated = partialReason !== 'truncated' ||
      (firstPending >= 0 && plan.retryable[firstPending] &&
        countCodePoints(plan.chunks[firstPending].text) > 1);
    const canResume = hasPendingChunk && canRetryTruncated;
    this.update({
      result: this.createResult({
        text: this.composePlanText(plan),
        truncated,
        status: 'partial',
        partialReason,
        canResume,
        completedChunks,
        totalChunks: plan.chunks.length,
        elapsedMs: this.elapsed(run.startedAt),
        direction: plan.direction,
      }),
      translationProgress: Object.freeze({
        phase: 'translating',
        completed: completedChunks,
        total: plan.chunks.length,
      }),
    });
  }

  private async splitTruncatedChunk(
    plan: TranslationPlan,
    index: number,
    engine: InferenceEngine,
    run: TranslationRun,
  ): Promise<number | undefined> {
    const currentChunk = plan.chunks[index];
    this.throwIfOperationCancelled(run.controller);
    const currentInputUpperBound = this.inputTokenUpperBound(engine, currentChunk.text, plan.direction);
    this.throwIfOperationCancelled(run.controller);
    const codePoints = Array.from(currentChunk.text);
    if (codePoints.length < 2) {
      plan.retryable[index] = false;
      return undefined;
    }

    const midpoint = Math.floor(codePoints.length / 2);
    const firstHalf = codePoints.slice(0, midpoint).join('');
    const secondHalf = codePoints.slice(midpoint).join('');
    const firstHalfUpperBound = this.inputTokenUpperBound(engine, firstHalf, plan.direction);
    this.throwIfOperationCancelled(run.controller);
    const secondHalfUpperBound = this.inputTokenUpperBound(engine, secondHalf, plan.direction);
    this.throwIfOperationCancelled(run.controller);
    const smallerLimit = Math.max(firstHalfUpperBound, secondHalfUpperBound);
    if (smallerLimit >= currentInputUpperBound) {
      plan.retryable[index] = false;
      return undefined;
    }
    const smallerChunks = await splitTranslationText(
      currentChunk.text,
      smallerLimit,
      candidate => {
        this.throwIfOperationCancelled(run.controller);
        const upperBound = this.inputTokenUpperBound(engine, candidate, plan.direction);
        this.throwIfOperationCancelled(run.controller);
        return upperBound;
      },
    );
    if (smallerChunks.length < 2) {
      plan.retryable[index] = false;
      return undefined;
    }

    const replacement = smallerChunks.map((chunk, chunkIndex) => Object.freeze({
      text: chunk.text,
      separator: chunkIndex === smallerChunks.length - 1
        ? chunk.separator + currentChunk.separator
        : chunk.separator,
    }));
    plan.chunks.splice(index, 1, ...replacement);
    plan.outputs.splice(index, 1, ...replacement.map(() => undefined));
    plan.completed.splice(index, 1, ...replacement.map(() => false));
    plan.retryable.splice(index, 1, ...replacement.map(() => true));
    return index;
  }

  private async replanPendingChunks(
    plan: TranslationPlan,
    startIndex: number,
    engine: InferenceEngine,
    run: TranslationRun,
  ): Promise<{ startIndex: number; replanned: boolean }> {
    let needsReplanning = false;
    for (let index = startIndex; index < plan.chunks.length; index++) {
      this.throwIfOperationCancelled(run.controller);
      const chunk = plan.chunks[index];
      if (!chunk.text.trim()) continue;
      const budget = engine.getTranslationBudget(this.translationRequest(chunk.text, plan.direction));
      if (!budget.fits) needsReplanning = true;
    }

    if (!needsReplanning) return { startIndex, replanned: false };

    const pendingChunks = plan.chunks.slice(startIndex);
    const pendingSource = pendingChunks.map(chunk => chunk.text + chunk.separator).join('');
    const currentBudget = engine.getTranslationBudget(
      this.translationRequest(pendingSource, plan.direction),
    );
    const inputTokenLimit = currentBudget.contextSize - currentBudget.maxOutputTokens;
    const replacement = await splitTranslationText(
      pendingSource,
      inputTokenLimit,
      candidate => {
        this.throwIfOperationCancelled(run.controller);
        const inputTokenUpperBound = this.inputTokenUpperBound(engine, candidate, plan.direction);
        this.throwIfOperationCancelled(run.controller);
        return inputTokenUpperBound;
      },
    );

    plan.chunks.splice(startIndex, pendingChunks.length, ...replacement);
    plan.outputs.splice(startIndex, pendingChunks.length, ...replacement.map(() => undefined));
    plan.completed.splice(startIndex, pendingChunks.length, ...replacement.map(() => false));
    plan.retryable.splice(startIndex, pendingChunks.length, ...replacement.map(() => true));
    return { startIndex, replanned: true };
  }

  private composePlanText(plan: TranslationPlan): string {
    let result = '';
    for (let index = 0; index < plan.chunks.length; index++) {
      const output = plan.outputs[index];
      if (output === undefined) break;
      result += output;
      if (plan.completed[index]) {
        const separator = plan.chunks[index].separator;
        const nextChunkHasWords = Boolean(plan.chunks[index + 1]?.text.trim());
        const currentChunkHasWords = Boolean(plan.chunks[index].text.trim());
        result += separator ||
          (plan.direction.targetLanguage === 'en' && currentChunkHasWords && nextChunkHasWords
            ? ' '
            : '');
      }
    }
    return result;
  }

  private createResult(result: PocResult): PocResult {
    return Object.freeze({
      ...result,
      direction: Object.freeze({ ...result.direction }),
    });
  }

  private partialReason(error: unknown): 'cancelled' | 'error' {
    return isCancelled(error) ? 'cancelled' : 'error';
  }

  private isCurrentTranslationRun(run: TranslationRun, chunkIndex?: number): boolean {
    return run.operationId === this.translationOperationId &&
      !run.controller.signal.aborted &&
      (chunkIndex === undefined || run.activeChunkIndex === chunkIndex);
  }

  private isCurrentTranslationOperation(run: TranslationRun): boolean {
    return run.operationId === this.translationOperationId;
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

  private beginOperationCompletion(): () => void {
    let resolve!: () => void;
    const completion = new Promise<void>(resolveCompletion => {
      resolve = resolveCompletion;
    });
    this.operationCompletion = completion;

    return () => {
      resolve();
      if (this.operationCompletion === completion) {
        this.operationCompletion = undefined;
      }
    };
  }

  private throwIfOperationCancelled(controller: AbortController): void {
    if (controller.signal.aborted) {
      throw new InferenceError('cancelled', '操作を中止しました。', controller.signal.reason);
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
      const modelReady = this.state.engine.modelLoaded;
      const wasLoading = this.state.operation === 'loading';
      this.update({
        notice: modelReady
          ? wasLoading
            ? 'ロード処理を中止しましたが、モデルの準備は完了しています。翻訳を始められます。'
            : '翻訳を中止しました。モデルの準備はできているため、もう一度翻訳できます。'
          : '操作を中止しました。続けるにはモデルをロードしてください。',
        error: undefined,
      });
      this.log(modelReady
        ? wasLoading
          ? 'ロード処理を中止しました。モデルはロード済みです。'
          : '翻訳を中止しました。モデルはロード済みです。'
        : '操作を中止しました。モデルを再ロードしてください。');
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
