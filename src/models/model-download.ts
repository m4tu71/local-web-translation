import { downloadModel, ModelDownloadError, type DownloadErrorCode } from './download.ts';
import { PLAMO_MODEL, type ModelDefinition } from './plamo.ts';

export type DownloadPhase =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'cancelling'
  | 'cancelled'
  | 'ready'
  | 'error';

export interface ModelDownloadState {
  readonly phase: DownloadPhase;
  readonly loadedBytes: number;
  readonly totalBytes: number;
  readonly error?: Readonly<{ code: DownloadErrorCode; message: string }>;
}

interface ActiveDownload {
  controller: AbortController;
  task: Promise<Blob>;
}

export class ModelDownloader {
  readonly model: ModelDefinition;
  private state: ModelDownloadState;
  private listeners = new Set<(state: ModelDownloadState) => void>();
  private active?: ActiveDownload;
  private blob?: Blob;
  private readonly fetcher?: typeof fetch;

  constructor(model: ModelDefinition = PLAMO_MODEL, fetcher?: typeof fetch) {
    this.model = Object.freeze({ ...model });
    this.fetcher = fetcher;
    this.state = Object.freeze({ phase: 'idle', loadedBytes: 0, totalBytes: model.bytes });
  }

  getState(): ModelDownloadState {
    return this.state;
  }

  getModel(): Blob | undefined {
    return this.blob;
  }

  subscribe(listener: (state: ModelDownloadState) => void): () => void {
    this.listeners.add(listener);
    this.notify(listener, this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  download(): Promise<Blob> {
    if (this.active) {
      return Promise.reject(new ModelDownloadError('busy', 'モデルを取得中です。'));
    }
    if (this.blob) {
      return Promise.resolve(this.blob);
    }

    const controller = new AbortController();
    // Start on the next microtask so abort/clear cannot run before reservation.
    const task = Promise.resolve().then(async () => {
      try {
        const blob = await downloadModel(this.model, {
          signal: controller.signal,
          fetcher: this.fetcher,
          onProgress: progress => {
            if (!controller.signal.aborted) {
              this.publish(progress.phase, progress.loadedBytes);
            }
          },
        });
        controller.signal.throwIfAborted();
        this.active = undefined;
        this.blob = blob;
        this.publish('ready', this.model.bytes);
        return blob;
      } catch (cause) {
        const error = this.downloadError(cause, controller.signal.aborted);
        this.active = undefined;
        this.blob = undefined;
        const phase = error.code === 'cancelled' ? 'cancelled' : 'error';
        this.publish(phase, this.state.loadedBytes, error);
        throw error;
      }
    });

    this.active = { controller, task };
    this.publish('downloading', 0);
    return task;
  }

  async abort(): Promise<void> {
    const active = this.active;
    if (!active) {
      return;
    }

    if (!active.controller.signal.aborted) {
      active.controller.abort();
      this.publish('cancelling', this.state.loadedBytes);
    }
    try {
      await active.task;
    } catch (error) {
      if (!(error instanceof ModelDownloadError) || error.code !== 'cancelled') {
        throw error;
      }
    }
  }

  clear(): void {
    if (this.active) {
      throw new ModelDownloadError('busy', '取得を中止してからモデルを削除してください。');
    }

    this.blob = undefined;
    this.publish('idle', 0);
  }

  private downloadError(cause: unknown, cancelled: boolean): ModelDownloadError {
    if (cancelled) {
      return new ModelDownloadError('cancelled', '取得を中止しました。再開する場合は最初から取得します。', cause);
    }
    if (cause instanceof ModelDownloadError) {
      return cause;
    }
    return new ModelDownloadError(
      'network',
      'モデルを取得できませんでした。接続・ブラウザの設定・空きメモリを確認し、再試行してください。',
      cause,
    );
  }

  private publish(phase: DownloadPhase, loadedBytes: number, error?: ModelDownloadError): void {
    const state: ModelDownloadState = Object.freeze({
      phase,
      loadedBytes,
      totalBytes: this.model.bytes,
      ...(error ? { error: Object.freeze({ code: error.code, message: error.message }) } : {}),
    });
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

  private notify(listener: (state: ModelDownloadState) => void, state: ModelDownloadState): void {
    try {
      listener(state);
    } catch (error) {
      console.error('Model download listener failed', error);
    }
  }
}
