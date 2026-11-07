import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ModelDefinition } from '../models/plamo.ts';

export type CacheErrorCode = 'unsupported' | 'quota' | 'read' | 'write' | 'integrity' | 'busy' | 'cancelled' | 'expired';

export class ModelCacheError extends Error {
  readonly code: CacheErrorCode;

  constructor(code: CacheErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ModelCacheError';
    this.code = code;
  }
}

export interface CacheInfo {
  readonly available: boolean;
  readonly cached: boolean;
  readonly bytes: number;
  readonly lastUsed?: number;
  readonly expiresAt?: number;
  readonly retentionDays: number;
  readonly error?: Readonly<{ code: CacheErrorCode; message: string }>;
}

interface CacheMetadata {
  version: 1;
  modelKey: string;
  fileName: string;
  bytes: number;
  sha256: string;
  lastUsed: number;
}

interface CacheSettings { version: 1; retentionDays: number }
interface UseLease { model: File; release(): Promise<void> }

const CACHE_DIRECTORY = 'plamo-model-cache-v1';
const METADATA_FILE = 'metadata.json';
const SETTINGS_FILE = 'settings.json';
const LOCK_NAME = 'local-web-translation:model-cache';
const SETTINGS_LOCK_NAME = 'local-web-translation:model-cache-settings';
const DEFAULT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 30;
const YOUNGEST_TEMPORARY_FILE = /^model-[a-f0-9-]+\.partial$/;
const LAST_USE_FILE = /^last-use-[a-f0-9-]+\.json$/;

type DirectoryHandle = FileSystemDirectoryHandle;
type LockManagerLike = LockManager;

function modelKey(model: ModelDefinition): string {
  return `${model.repository}@${model.revision}/${model.fileName}:${model.sha256}`;
}

function validRetentionDays(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_RETENTION_DAYS;
}

function classifyStorageError(error: unknown, action: 'read' | 'write'): ModelCacheError {
  if (error instanceof ModelCacheError) return error;
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'QuotaExceededError') {
    return new ModelCacheError('quota', 'ブラウザーの保存容量が不足しています。空き容量を確保するか、メモリ保存を選んでください。', error);
  }
  const message = action === 'write'
    ? 'モデルをブラウザー内へ保存できませんでした。空き容量とサイトの保存設定を確認するか、メモリ保存を選んでください。'
    : 'ブラウザー内のモデルキャッシュを読み取れませんでした。再取得するか、メモリ保存を選んでください。';
  return new ModelCacheError(action, message, error);
}

/** Stores verified model files in OPFS. Model bytes are streamed to disk and never buffered as one ArrayBuffer. */
export class ModelCache {
  private readonly model: ModelDefinition;
  private readonly storage?: StorageManager;
  private readonly locks?: LockManagerLike;
  private readonly settings?: Storage;
  private readonly sessionId = crypto.randomUUID();
  private directory?: DirectoryHandle;
  private cachedFile?: File;
  private info: CacheInfo;

  constructor(
    model: ModelDefinition,
    options: { storage?: StorageManager; locks?: LockManagerLike; settings?: Storage } = {},
  ) {
    this.model = model;
    this.storage = options.storage ?? globalThis.navigator?.storage;
    this.locks = options.locks ?? globalThis.navigator?.locks;
    this.settings = options.settings ?? safeLocalStorage();
    this.info = Object.freeze({
      available: false,
      cached: false,
      bytes: 0,
      retentionDays: this.readRetentionDays(),
    });
  }

  getInfo(): CacheInfo { return this.info; }
  getCachedFile(): File | undefined { return this.cachedFile; }

  invalidate(error: ModelCacheError): void {
    this.cachedFile = undefined;
    this.publish({ available: false, cached: false, bytes: 0, retentionDays: this.info.retentionDays, error });
  }

  async initialize(): Promise<CacheInfo> {
    if (!this.storage?.getDirectory || !this.locks?.request) {
      const error = new ModelCacheError('unsupported', 'このブラウザーでは安全な OPFS キャッシュを利用できません。メモリ保存を選んでください。');
      this.publish({ available: false, cached: false, bytes: 0, retentionDays: this.readRetentionDays(), error });
      return this.info;
    }

    try {
      const root = await this.storage.getDirectory();
      this.directory = await root.getDirectoryHandle(CACHE_DIRECTORY, { create: true });
      await this.withLock('exclusive', async () => {
        await this.cleanOrphanedFiles();
        const settings = await this.readSettings();
        const metadata = await this.readMetadata();
        if (!metadata) {
          this.cachedFile = undefined;
          this.publish({ available: true, cached: false, bytes: 0, retentionDays: settings.retentionDays });
          return;
        }
        if (!this.isMatchingMetadata(metadata)) {
          this.cachedFile = undefined;
          if (this.isSafeModelFileName(metadata.fileName)) await this.removeFile(metadata.fileName);
          await this.removeMetadata();
          this.publish({ available: true, cached: false, bytes: 0, retentionDays: settings.retentionDays });
          return;
        }

        const lastUsed = await this.latestLastUse(metadata.lastUsed);
        if (lastUsed !== metadata.lastUsed) {
          await this.writeMetadata({ ...metadata, lastUsed });
        }
        await this.removeLastUseMarkers();
        const expiresAt = lastUsed + settings.retentionDays * 24 * 60 * 60 * 1000;
        if (expiresAt <= Date.now()) {
          this.cachedFile = undefined;
          await this.removeFile(metadata.fileName);
          await this.removeMetadata();
          await this.removeLastUseMarkers();
          this.publish({ available: true, cached: false, bytes: 0, retentionDays: settings.retentionDays });
          return;
        }

        let file: File | undefined;
        try {
          const candidate = await this.directory!.getFileHandle(metadata.fileName).then(handle => handle.getFile());
          const digest = await digestBlob(candidate);
          if (candidate.size === this.model.bytes && digest === this.model.sha256) file = candidate;
        } catch {
          file = undefined;
        }
        if (!file) {
          this.cachedFile = undefined;
          await this.removeFile(metadata.fileName);
          await this.removeMetadata();
          await this.removeLastUseMarkers();
          this.publish({ available: true, cached: false, bytes: 0, retentionDays: settings.retentionDays });
          return;
        }
        const verifiedFile = file;
        this.cachedFile = verifiedFile;
        this.publish({ available: true, cached: true, bytes: verifiedFile.size, lastUsed, expiresAt, retentionDays: settings.retentionDays });
      });
    } catch (error) {
      const cacheError = classifyStorageError(error, 'read');
      this.publish({ available: false, cached: false, bytes: 0, retentionDays: this.readRetentionDays(), error: cacheError });
    }
    return this.info;
  }

  async saveFromStream(
    source: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    callbacks: { onProgress(bytes: number): void; onVerifying(): void },
  ): Promise<File> {
    this.requireAvailable();
    return this.withLock('exclusive', async () => {
      signal.throwIfAborted();
      const id = crypto.randomUUID();
      const fileName = `model-${id}.partial`;
      let writer: FileSystemWritableFileStream | undefined;
      let fileClosed = false;
      let loadedBytes = 0;
      let bytesSinceYield = 0;
      const hash = sha256.create();
      const reader = source.getReader();
      const cancelRead = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', cancelRead, { once: true });
      try {
        const handle = await this.directory!.getFileHandle(fileName, { create: true });
        writer = await handle.createWritable({ keepExistingData: false });
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          loadedBytes += value.byteLength;
          if (loadedBytes > this.model.bytes) {
            throw new ModelCacheError('integrity', 'モデルのサイズが定義より大きいため、受信データを破棄しました。');
          }
          for (let offset = 0; offset < value.byteLength; offset += 1024 * 1024) {
            signal.throwIfAborted();
            const chunk = value.subarray(offset, Math.min(offset + 1024 * 1024, value.byteLength));
            hash.update(chunk);
            await writer.write(Uint8Array.from(chunk));
            bytesSinceYield += chunk.byteLength;
            if (bytesSinceYield >= 4 * 1024 * 1024) {
              await new Promise<void>(resolve => setTimeout(resolve, 0));
              bytesSinceYield = 0;
            }
          }
          callbacks.onProgress(loadedBytes);
        }
        callbacks.onVerifying();
        signal.throwIfAborted();
        if (loadedBytes !== this.model.bytes || bytesToHex(hash.digest()) !== this.model.sha256) {
          throw new ModelCacheError('integrity', 'モデルのサイズまたは SHA-256 が一致しません。受信データを破棄しました。');
        }
        await writer.close();
        fileClosed = true;
        signal.throwIfAborted();

        const settings = await this.readSettings();
        const now = Date.now();
        const metadata: CacheMetadata = {
          version: 1,
          modelKey: modelKey(this.model),
          fileName,
          bytes: loadedBytes,
          sha256: this.model.sha256,
          lastUsed: now,
        };
        await this.writeMetadata(metadata);
        signal.throwIfAborted();
        await this.removeOtherModelFiles(fileName);
        signal.throwIfAborted();
        await this.removeLastUseMarkers();
        signal.throwIfAborted();
        const file = await this.directory!.getFileHandle(fileName).then(handle => handle.getFile());
        signal.throwIfAborted();
        this.cachedFile = file;
        this.publish({
          available: true, cached: true, bytes: loadedBytes, lastUsed: now,
          expiresAt: now + settings.retentionDays * 24 * 60 * 60 * 1000,
          retentionDays: settings.retentionDays,
        });
        return file;
      } catch (error) {
        if (!fileClosed) await writer?.abort().catch(() => {});
        await reader.cancel().catch(() => {});
        await this.removeFile(fileName).catch(() => {});
        const committedMetadata = await this.readMetadata().catch(() => undefined);
        if (committedMetadata?.fileName === fileName) await this.removeMetadata().catch(() => {});
        this.cachedFile = undefined;
        if (signal.aborted) throw new ModelCacheError('cancelled', 'OPFS 保存を中止しました。途中のデータを破棄しました。', error);
        throw classifyStorageError(error, error instanceof ModelCacheError ? 'read' : 'write');
      } finally {
        signal.removeEventListener('abort', cancelRead);
        reader.releaseLock();
        hash.destroy();
      }
    }, signal);
  }

  async acquireModel(signal?: AbortSignal): Promise<UseLease> {
    this.requireAvailable();
    let unlock!: () => void;
    let acquired!: () => void;
    let lockError: unknown;
    const acquiredPromise = new Promise<void>(resolve => { acquired = resolve; });
    const holdPromise = new Promise<void>(resolve => { unlock = resolve; });
    const lockTask = this.locks!.request(LOCK_NAME, { mode: 'shared', ...(signal ? { signal } : {}) }, async () => {
      acquired();
      await holdPromise;
    }).catch(error => {
      lockError = error;
      acquired();
    });
    await acquiredPromise;
    if (lockError) {
      await lockTask;
      throw signal?.aborted
        ? new ModelCacheError('cancelled', 'モデルの確認を中止しました。')
        : classifyStorageError(lockError, 'read');
    }

    let attemptedFileName: string | undefined;
    try {
      signal?.throwIfAborted();
      const metadata = await this.readMetadata();
      if (metadata && this.isSafeModelFileName(metadata.fileName)) attemptedFileName = metadata.fileName;
      if (!metadata || !this.isMatchingMetadata(metadata)) {
        throw new ModelCacheError('integrity', '有効なモデルキャッシュがありません。もう一度取得してください。');
      }
      const settings = await this.readSettings();
      const lastUsed = await this.latestLastUse(metadata.lastUsed);
      if (lastUsed + settings.retentionDays * 24 * 60 * 60 * 1000 <= Date.now()) {
        throw new ModelCacheError('expired', 'モデルキャッシュの保持期限が切れました。もう一度取得してください。');
      }
      let file: File;
      try {
        file = await this.directory!.getFileHandle(metadata.fileName).then(handle => handle.getFile());
        signal?.throwIfAborted();
        if (file.size !== this.model.bytes || await digestBlob(file, signal) !== this.model.sha256) {
          throw new ModelCacheError('integrity', 'モデルキャッシュの整合性を確認できません。保存データを削除して再取得します。');
        }
      } catch (cause) {
        if (signal?.aborted) throw cause;
        if (cause instanceof ModelCacheError) throw cause;
        throw new ModelCacheError('integrity', 'モデルキャッシュを読み取れません。保存データを削除して再取得します。', cause);
      }
      if (signal?.aborted) {
        throw new ModelCacheError('cancelled', 'モデルの確認を中止しました。');
      }
      return {
        model: file,
        release: async () => {
          unlock();
          await lockTask;
        },
      };
    } catch (error) {
      unlock();
      await lockTask;
      if (signal?.aborted) throw new ModelCacheError('cancelled', 'モデルの確認を中止しました。');
      if (error instanceof ModelCacheError && error.code === 'expired') {
        await this.removeExpiredCache();
        throw error;
      }
      if (error instanceof ModelCacheError && error.code === 'integrity') {
        await this.removeInvalidCache(attemptedFileName);
        throw error;
      }
      throw classifyStorageError(error, 'read');
    }
  }

  async touch(): Promise<void> {
    this.requireAvailable();
    const timestamp = Date.now();
    const marker = `last-use-${this.sessionId}.json`;
    try {
      const handle = await this.directory!.getFileHandle(marker, { create: true });
      const writer = await handle.createWritable();
      await writer.write(JSON.stringify({ timestamp }));
      await writer.close();
      this.publish({ ...this.info, lastUsed: timestamp, expiresAt: timestamp + this.info.retentionDays * 86400000 });
    } catch (error) {
      throw classifyStorageError(error, 'write');
    }
  }

  async setRetentionDays(days: number): Promise<CacheInfo> {
    if (!validRetentionDays(days)) throw new RangeError('保持期間は1〜30日の整数で指定してください。');
    this.requireAvailable();
    await this.withLock('exclusive', async () => {
      await this.writeSettings({ version: 1, retentionDays: days });
      if (this.info.cached && this.info.lastUsed !== undefined) {
        this.publish({ ...this.info, retentionDays: days, expiresAt: this.info.lastUsed + days * 86400000 });
      } else {
        this.publish({ ...this.info, retentionDays: days });
      }
    }, undefined, SETTINGS_LOCK_NAME);
    return this.info;
  }

  async clear(): Promise<void> {
    this.requireAvailable();
    await this.withLock('exclusive', async () => {
      const metadata = await this.readMetadata();
      if (metadata && this.isSafeModelFileName(metadata.fileName)) await this.removeFile(metadata.fileName);
      this.cachedFile = undefined;
      await this.removeMetadata();
      await this.removeLastUseMarkers();
      await this.removeTemporaryFiles();
      this.publish({ available: true, cached: false, bytes: 0, retentionDays: (await this.readSettings()).retentionDays });
    });
  }

  private async removeExpiredCache(): Promise<void> {
    await this.withLock('exclusive', async () => {
      const metadata = await this.readMetadata();
      if (!metadata || !this.isMatchingMetadata(metadata)) return;
      const settings = await this.readSettings();
      const lastUsed = await this.latestLastUse(metadata.lastUsed);
      if (lastUsed + settings.retentionDays * 86400000 > Date.now()) {
        if (lastUsed !== metadata.lastUsed) await this.writeMetadata({ ...metadata, lastUsed });
        await this.removeLastUseMarkers();
        this.publish({
          ...this.info, cached: true, bytes: metadata.bytes, lastUsed,
          expiresAt: lastUsed + settings.retentionDays * 86400000,
        });
        return;
      }
      await this.removeFile(metadata.fileName);
      await this.removeMetadata();
      await this.removeLastUseMarkers();
      this.cachedFile = undefined;
      this.publish({ available: true, cached: false, bytes: 0, retentionDays: settings.retentionDays });
    });
  }

  private async removeInvalidCache(originalFileName?: string): Promise<void> {
    await this.withLock('exclusive', async () => {
      const metadata = await this.readMetadata();
      if (originalFileName && metadata?.fileName !== originalFileName) return;
      if (!originalFileName && metadata) return;
      const fileName = metadata?.fileName ?? originalFileName;
      if (fileName && this.isSafeModelFileName(fileName)) await this.removeFile(fileName);
      await this.removeMetadata();
      await this.removeTemporaryFiles();
      await this.removeLastUseMarkers();
      this.cachedFile = undefined;
      this.publish({ available: true, cached: false, bytes: 0, retentionDays: (await this.readSettings()).retentionDays });
    });
  }

  private requireAvailable(): void {
    if (!this.directory || !this.locks?.request) {
      throw this.info.error ?? new ModelCacheError('unsupported', 'このブラウザーでは OPFS キャッシュを利用できません。メモリ保存を選んでください。');
    }
  }

  private async withLock<T>(
    mode: 'shared' | 'exclusive',
    task: () => Promise<T>,
    signal?: AbortSignal,
    name = LOCK_NAME,
  ): Promise<T> {
    if (!this.locks?.request) throw new ModelCacheError('unsupported', '複数タブからの安全な保存操作に対応していません。');
    try {
      return await this.locks.request(name, { mode, ...(signal ? { signal } : {}) }, task);
    } catch (error) {
      if (signal?.aborted) throw new ModelCacheError('cancelled', 'OPFS 保存を中止しました。途中のデータを破棄しました。', error);
      throw classifyStorageError(error, mode === 'exclusive' ? 'write' : 'read');
    }
  }

  private async readMetadata(): Promise<CacheMetadata | undefined> {
    let file: File;
    try {
      file = await this.directory!.getFileHandle(METADATA_FILE).then(handle => handle.getFile());
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
      throw classifyStorageError(error, 'read');
    }
    let contents: string;
    try { contents = await file.text(); }
    catch (error) { throw classifyStorageError(error, 'read'); }
    try {
      const value: unknown = JSON.parse(contents);
      return value && typeof value === 'object' ? value as CacheMetadata : undefined;
    } catch { return undefined; }
  }

  private async writeMetadata(metadata: CacheMetadata): Promise<void> {
    await this.writeJson(METADATA_FILE, metadata);
  }

  private async removeMetadata(): Promise<void> { await this.removeFile(METADATA_FILE); }

  private async readSettings(): Promise<CacheSettings> {
    let file: File;
    try {
      file = await this.directory!.getFileHandle(SETTINGS_FILE).then(handle => handle.getFile());
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return { version: 1, retentionDays: this.readRetentionDays() };
      }
      throw classifyStorageError(error, 'read');
    }
    let contents: string;
    try { contents = await file.text(); }
    catch (error) { throw classifyStorageError(error, 'read'); }
    try {
      const value = JSON.parse(contents) as Partial<CacheSettings>;
      if (value.version === 1 && typeof value.retentionDays === 'number' && validRetentionDays(value.retentionDays)) return value as CacheSettings;
    } catch { /* Malformed settings use the documented default. */ }
    return { version: 1, retentionDays: this.readRetentionDays() };
  }

  private async writeSettings(settings: CacheSettings): Promise<void> { await this.writeJson(SETTINGS_FILE, settings); }

  private async writeJson(name: string, value: unknown): Promise<void> {
    const handle = await this.directory!.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    try {
      await writer.write(JSON.stringify(value));
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
  }

  private async latestLastUse(initial: number): Promise<number> {
    let latest = initial;
    for await (const [name] of this.directory!.entries()) {
      if (!LAST_USE_FILE.test(name)) continue;
      let timestamp = 0;
      try {
        const marker = await this.directory!.getFileHandle(name).then(handle => handle.getFile());
        const value = JSON.parse(await marker.text()) as { timestamp?: unknown };
        timestamp = typeof value.timestamp === 'number' ? value.timestamp : 0;
      } catch { /* Invalid activity markers never extend retention. */ }
      if (Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
    }
    return latest;
  }

  private async cleanOrphanedFiles(): Promise<void> {
    const metadata = await this.readMetadata();
    const keep = metadata && this.isSafeModelFileName(metadata.fileName) ? metadata.fileName : undefined;
    if (!metadata) await this.removeMetadata();
    await this.removeTemporaryFiles(keep);
    await this.removeOtherModelFiles(keep);
    if (!metadata) await this.removeLastUseMarkers();
  }

  private async removeTemporaryFiles(keep?: string): Promise<void> {
    for await (const [name] of this.directory!.entries()) {
      if (YOUNGEST_TEMPORARY_FILE.test(name) && name !== keep) await this.removeFile(name);
    }
  }

  private async removeOtherModelFiles(keep?: string): Promise<void> {
    for await (const [name] of this.directory!.entries()) {
      if (name.startsWith('model-') && name.endsWith('.partial') && name !== keep) await this.removeFile(name);
    }
  }

  private async removeLastUseMarkers(): Promise<void> {
    for await (const [name] of this.directory!.entries()) {
      if (LAST_USE_FILE.test(name)) await this.removeFile(name);
    }
  }

  private async removeFile(name: string): Promise<void> {
    try { await this.directory!.removeEntry(name); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
  }

  private isMatchingMetadata(value: CacheMetadata): boolean {
    return value.version === 1 && value.modelKey === modelKey(this.model) && this.isSafeModelFileName(value.fileName) &&
      value.bytes === this.model.bytes && value.sha256 === this.model.sha256 && Number.isFinite(value.lastUsed);
  }

  private isSafeModelFileName(name: unknown): name is string {
    return typeof name === 'string' && YOUNGEST_TEMPORARY_FILE.test(name);
  }

  private readRetentionDays(): number {
    try {
      const value = Number(this.settings?.getItem('plamo-model-retention-days'));
      return validRetentionDays(value) ? value : DEFAULT_RETENTION_DAYS;
    } catch { return DEFAULT_RETENTION_DAYS; }
  }

  private publish(info: CacheInfo): void {
    this.info = Object.freeze({ ...info, ...(info.error ? { error: Object.freeze({ code: info.error.code, message: info.error.message }) } : {}) });
  }
}

function safeLocalStorage(): Storage | undefined {
  try { return globalThis.localStorage; }
  catch { return undefined; }
}

async function digestBlob(blob: Blob, signal?: AbortSignal): Promise<string> {
  if (!blob.stream) throw new ModelCacheError('unsupported', 'このブラウザーではモデルキャッシュの整合性を確認できません。');
  const reader = blob.stream().getReader();
  const hash = sha256.create();
  let bytesSinceYield = 0;
  const cancelRead = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancelRead, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) return bytesToHex(hash.digest());
      hash.update(value);
      bytesSinceYield += value.byteLength;
      if (bytesSinceYield >= 4 * 1024 * 1024) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        bytesSinceYield = 0;
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelRead);
    hash.destroy();
    reader.releaseLock();
  }
}
