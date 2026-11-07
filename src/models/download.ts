import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { modelDownloadUrl, type ModelDefinition } from './plamo.ts';

export type DownloadErrorCode = 'http' | 'network' | 'integrity' | 'unsupported' | 'cancelled' | 'busy' | 'not-ready';

export class ModelDownloadError extends Error {
  readonly code: DownloadErrorCode;

  constructor(code: DownloadErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ModelDownloadError';
    this.code = code;
  }
}

export interface DownloadProgress {
  readonly phase: 'downloading' | 'verifying';
  readonly loadedBytes: number;
}

interface DownloadOptions {
  signal: AbortSignal;
  onProgress: (progress: DownloadProgress) => void;
  fetcher?: typeof fetch;
}

export async function openModelResponse(
  model: ModelDefinition,
  signal: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Response> {
  signal.throwIfAborted();
  if (typeof fetcher !== 'function') {
    throw new ModelDownloadError('unsupported', 'このブラウザではモデルを取得できません。対応する新しいブラウザで開いてください。');
  }
  const response = await fetcher(modelDownloadUrl(model), {
    signal,
    mode: 'cors',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    throw new ModelDownloadError(
      'http',
      `モデルを取得できませんでした（HTTP ${response.status}）。配信元の公開状態と接続を確認して、再試行してください。`,
    );
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new ModelDownloadError('unsupported', 'このブラウザでは受信の進捗を読み取れません。対応する新しいブラウザで開いてください。');
  }
  return response;
}

/** Fetches one complete, pinned file; partial or unverified data is never returned. */
export async function downloadModel(
  model: ModelDefinition,
  options: DownloadOptions,
): Promise<Blob> {
  const { signal, onProgress } = options;
  const fetcher = options.fetcher ?? globalThis.fetch;
  signal.throwIfAborted();

  if (typeof fetcher !== 'function' || typeof Blob === 'undefined') {
    throw new ModelDownloadError('unsupported', 'このブラウザではモデルを取得できません。対応する新しいブラウザで開いてください。');
  }

  const response = await openModelResponse(model, signal, fetcher);

  const body = response.body;
  if (!body) throw new ModelDownloadError('unsupported', '受信ストリームを利用できません。');
  const reader = body.getReader();
  const hash = sha256.create();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loadedBytes = 0;
  let bytesSinceYield = 0;
  let completed = false;

  const cancelReader = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancelReader, { once: true });

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();

      if (done) {
        break;
      }

      loadedBytes += value.byteLength;
      if (loadedBytes > model.bytes) {
        throw new ModelDownloadError('integrity', 'モデルのサイズが定義と一致しません。データを破棄しました。再取得してください。');
      }

      // Copy this chunk only; hashing never allocates a full-model ArrayBuffer.
      const chunk = new Uint8Array(value);
      hash.update(chunk);
      chunks.push(chunk);
      onProgress({ phase: 'downloading', loadedBytes });

      // Let the page paint and process cancel clicks even on a fast connection.
      bytesSinceYield += chunk.byteLength;
      if (bytesSinceYield >= 4 * 1024 * 1024) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        bytesSinceYield = 0;
      }
    }

    if (loadedBytes !== model.bytes) {
      throw new ModelDownloadError('integrity', 'モデルの受信が途中で終了しました。再取得してください。');
    }

    onProgress({ phase: 'verifying', loadedBytes });
    signal.throwIfAborted();
    if (bytesToHex(hash.digest()) !== model.sha256) {
      throw new ModelDownloadError('integrity', 'モデルの SHA-256 が定義と一致しません。データを破棄しました。再取得してください。');
    }

    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    signal.throwIfAborted();
    completed = true;
    return blob;
  } finally {
    signal.removeEventListener('abort', cancelReader);
    hash.destroy();

    if (!completed) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
