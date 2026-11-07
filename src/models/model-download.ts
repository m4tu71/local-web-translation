import { downloadModel, ModelDownloadError, openModelResponse } from './download.ts';
import { PLAMO_MODEL, type ModelDefinition } from './plamo.ts';
import { ModelCache, ModelCacheError, type CacheInfo } from '../storage/model-cache.ts';

export type DownloadPhase =
  | 'idle' | 'checking' | 'downloading' | 'verifying' | 'cancelling' | 'clearing' | 'updating-retention'
  | 'cancelled' | 'ready' | 'error';
export type ModelStorageMode = 'opfs' | 'memory';

export interface ModelDownloadState {
  readonly phase: DownloadPhase;
  readonly loadedBytes: number;
  readonly totalBytes: number;
  readonly storageMode: ModelStorageMode;
  readonly cache: CacheInfo;
  readonly error?: Readonly<{ code: string; message: string }>;
}

interface ActiveDownload { controller: AbortController; task: Promise<Blob> }
interface ModelLease { model: Blob; release(): Promise<void> }

/** Coordinates a verified model source, its optional OPFS copy, and download UI state. */
export class ModelDownloader {
  readonly model: ModelDefinition;
  private state: ModelDownloadState;
  private listeners = new Set<(state: ModelDownloadState) => void>();
  private active?: ActiveDownload;
  private blob?: Blob;
  private selectedMode: ModelStorageMode = 'opfs';
  private modelInUse = false;
  private maintenance?: Promise<void>;
  private readonly fetcher?: typeof fetch;
  private readonly cache: ModelCache;

  constructor(model: ModelDefinition = PLAMO_MODEL, fetcher?: typeof fetch, cache = new ModelCache(model)) {
    this.model = Object.freeze({ ...model });
    this.fetcher = fetcher;
    this.cache = cache;
    this.state = Object.freeze({
      phase: 'checking', loadedBytes: 0, totalBytes: model.bytes,
      storageMode: 'opfs', cache: cache.getInfo(),
    });
  }

  getState(): ModelDownloadState { return this.state; }
  getModel(): Blob | undefined {
    return this.selectedMode === 'memory' ? this.blob : this.cache.getCachedFile();
  }

  async initialize(): Promise<void> {
    const cache = await this.cache.initialize();
    const file = this.cache.getCachedFile();
    if (file) {
      this.selectedMode = 'opfs';
      this.publish('ready', this.model.bytes, undefined, cache);
    } else {
      this.publish('idle', 0, undefined, cache);
    }
  }

  subscribe(listener: (state: ModelDownloadState) => void): () => void {
    this.listeners.add(listener);
    this.notify(listener, this.state);
    return () => { this.listeners.delete(listener); };
  }

  setStorageMode(mode: ModelStorageMode): void {
    if (this.state.phase === 'checking' || this.maintenance) throw new ModelDownloadError('busy', '確認処理が終わってから保存先を変更してください。');
    if (this.modelInUse) throw new ModelDownloadError('busy', 'モデルのロードを解除してから保存先を変更してください。');
    if (this.active) throw new ModelDownloadError('busy', '取得中は保存先を変更できません。');
    if (mode === 'opfs' && !this.state.cache.available) {
      throw new ModelCacheError('unsupported', this.state.cache.error?.message ?? 'OPFS キャッシュを利用できません。');
    }
    this.selectedMode = mode;
    this.blob = undefined;
    const phase = mode === 'memory'
      ? (this.blob ? 'ready' : 'idle')
      : (this.cache.getCachedFile() ? 'ready' : 'idle');
    this.publish(phase, phase === 'ready' ? this.model.bytes : 0, undefined, this.state.cache);
  }

  async download(): Promise<Blob> {
    if (this.state.phase === 'checking') throw new ModelDownloadError('busy', 'キャッシュの確認が終わるまで待ってください。');
    if (this.active) throw new ModelDownloadError('busy', 'モデルを取得中です。');
    if (this.maintenance) throw new ModelDownloadError('busy', '保存処理が終わってから取得してください。');
    if (this.selectedMode === 'opfs' && this.cache.getCachedFile()) return this.cache.getCachedFile()!;
    if (this.selectedMode === 'memory' && this.blob) return this.blob;

    const controller = new AbortController();
    const task = Promise.resolve().then(async () => {
      try {
        const blob = this.selectedMode === 'opfs'
          ? await this.downloadToOpfs(controller.signal)
          : await this.downloadToMemory(controller.signal);
        controller.signal.throwIfAborted();
        this.active = undefined;
        if (this.selectedMode === 'memory') this.blob = blob;
        this.publish('ready', this.model.bytes, undefined, this.cache.getInfo());
        return blob;
      } catch (cause) {
        const error = this.downloadError(cause, controller.signal.aborted);
        this.active = undefined;
        this.publish(error.code === 'cancelled' ? 'cancelled' : 'error', this.state.loadedBytes, error, this.cache.getInfo());
        throw error;
      }
    });
    this.active = { controller, task };
    this.publish('downloading', 0, undefined, this.cache.getInfo());
    return task;
  }

  async acquireModel(signal?: AbortSignal): Promise<ModelLease> {
    if (this.selectedMode === 'memory') {
      if (!this.blob) throw new ModelDownloadError('not-ready', '先にモデルをメモリへ取得してください。');
      return { model: this.blob, release: async () => {} };
    }
    try {
      return await this.cache.acquireModel(signal);
    } catch (error) {
      if (error instanceof ModelCacheError && ['expired', 'integrity'].includes(error.code) && !this.cache.getInfo().cached) {
        const cache = this.cache.getInfo();
        this.publish('idle', 0, undefined, cache);
      } else if (error instanceof ModelCacheError && !['cancelled', 'busy'].includes(error.code) && this.cache.getInfo().cached) {
        this.cache.invalidate(error);
        this.publish('error', 0, error, this.cache.getInfo());
      }
      throw error;
    }
  }

  async markUsed(): Promise<void> {
    if (this.selectedMode === 'opfs' && this.cache.getInfo().cached) {
      await this.cache.touch();
      this.publish(this.state.phase, this.state.loadedBytes, undefined, this.cache.getInfo());
    }
  }

  setModelInUse(inUse: boolean): void { this.modelInUse = inUse; }

  hasMemoryModel(): boolean { return Boolean(this.blob); }

  async abort(): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (!active.controller.signal.aborted) {
      active.controller.abort();
      this.publish('cancelling', this.state.loadedBytes, undefined, this.cache.getInfo());
    }
    try { await active.task; }
    catch (error) {
      if (!(error instanceof ModelDownloadError) || error.code !== 'cancelled') throw error;
    }
  }

  async clear(): Promise<void> {
    if (this.state.phase === 'checking') throw new ModelDownloadError('busy', 'キャッシュの確認が終わるまで待ってください。');
    if (this.active) throw new ModelDownloadError('busy', '取得を中止してからモデルを削除してください。');
    if (this.modelInUse) throw new ModelDownloadError('busy', 'モデルのロードを解除してから削除してください。');
    if (this.maintenance) throw new ModelDownloadError('busy', '保存処理が終わるまで待ってください。');
    const task = (async () => {
      this.publish('clearing', 0, undefined, this.cache.getInfo());
      try {
        if (this.cache.getInfo().available && this.cache.getInfo().cached) await this.cache.clear();
        this.blob = undefined;
        this.publish('idle', 0, undefined, this.cache.getInfo());
      } catch (error) {
        const message = error instanceof Error ? error.message : 'モデルを削除できませんでした。';
        this.publish('error', 0, new ModelCacheError('write', message, error), this.cache.getInfo());
        throw error;
      }
    })();
    this.maintenance = task;
    try { await task; }
    finally { this.maintenance = undefined; }
  }

  async setRetentionDays(days: number): Promise<void> {
    if (this.state.phase === 'checking') throw new ModelDownloadError('busy', 'キャッシュの確認が終わるまで待ってください。');
    if (this.active || this.maintenance) throw new ModelDownloadError('busy', '別のモデル処理が終わってから保持期間を変更してください。');
    const previousPhase = this.state.phase;
    const task = (async () => {
      this.publish('updating-retention', this.state.loadedBytes, undefined, this.cache.getInfo());
      try {
        const cache = await this.cache.setRetentionDays(days);
        this.publish(previousPhase, this.state.loadedBytes, undefined, cache);
      } catch (error) {
        this.publish(previousPhase, this.state.loadedBytes, undefined, this.cache.getInfo());
        throw error;
      }
    })();
    this.maintenance = task;
    try { await task; }
    finally { this.maintenance = undefined; }
  }

  private async downloadToOpfs(signal: AbortSignal): Promise<Blob> {
    const response = await openModelResponse(this.model, signal, this.fetcher);
    if (!response.body) throw new ModelDownloadError('unsupported', '受信ストリームを利用できません。');
    signal.throwIfAborted();
    const file = await this.cache.saveFromStream(response.body, signal, {
      onProgress: loadedBytes => {
        if (!signal.aborted) this.publish('downloading', loadedBytes, undefined, this.cache.getInfo());
      },
      onVerifying: () => {
        if (!signal.aborted) this.publish('verifying', this.model.bytes, undefined, this.cache.getInfo());
      },
    });
    signal.throwIfAborted();
    return file;
  }

  private async downloadToMemory(signal: AbortSignal): Promise<Blob> {
    return downloadModel(this.model, {
      signal,
      fetcher: this.fetcher,
      onProgress: progress => {
        if (!signal.aborted) this.publish(progress.phase, progress.loadedBytes, undefined, this.cache.getInfo());
      },
    });
  }

  private downloadError(cause: unknown, cancelled: boolean): Error & { code?: string } {
    if (cancelled) return new ModelDownloadError('cancelled', '取得を中止しました。再試行すると最初から取得します。', cause);
    if (cause instanceof ModelDownloadError || cause instanceof ModelCacheError) return cause;
    return new ModelDownloadError(
      'network',
      'モデルを取得できませんでした。接続・ブラウザーの設定を確認し、再試行してください。',
      cause,
    );
  }

  private publish(phase: DownloadPhase, loadedBytes: number, error?: Error & { code?: string }, cache = this.cache.getInfo()): void {
    const state: ModelDownloadState = Object.freeze({
      phase, loadedBytes, totalBytes: this.model.bytes,
      storageMode: this.selectedMode,
      cache,
      ...(error ? { error: Object.freeze({ code: error.code ?? 'unknown', message: error.message }) } : {}),
    });
    this.state = state;
    for (const listener of [...this.listeners]) {
      if (this.state !== state) break;
      if (this.listeners.has(listener)) this.notify(listener, state);
    }
  }

  private notify(listener: (state: ModelDownloadState) => void, state: ModelDownloadState): void {
    try { listener(state); }
    catch (error) { console.error('Model download listener failed', error); }
  }
}
