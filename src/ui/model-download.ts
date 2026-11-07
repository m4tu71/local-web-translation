import { ModelDownloader, type DownloadPhase, type ModelStorageMode } from '../models/model-download.ts';
import { describeModelDownload } from './model-download-view.ts';

export interface ModelDownloadControls {
  downloader: ModelDownloader;
  setModelInUse(inUse: boolean): void;
}

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Model download UI element not found: ${id}`);
  return result as T;
}

function cacheDescription(state: ReturnType<ModelDownloader['getState']>): string {
  if (!state.cache.available) {
    return `${state.cache.error?.message ?? 'ブラウザー保存を利用できません。'} メモリ保存を選ぶと、このページで取得できます。`;
  }
  if (!state.cache.cached) return 'ブラウザーに保存されたモデルはありません。';
  const expiry = state.cache.expiresAt
    ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(state.cache.expiresAt)
    : '不明';
  return `ブラウザーにモデルを保存済みです。保持期限: ${expiry}（最終使用から${state.cache.retentionDays}日）`;
}

export function mountModelDownload(): ModelDownloadControls {
  const downloader = new ModelDownloader();
  const start = element<HTMLButtonElement>('model-download');
  const cancel = element<HTMLButtonElement>('model-cancel');
  const clear = element<HTMLButtonElement>('model-clear');
  const progress = element<HTMLProgressElement>('model-progress');
  const progressRegion = element('model-progress-region');
  const amount = element('model-progress-text');
  const status = element('model-status');
  const error = element('model-error');
  const cacheStatus = element('model-cache-status');
  const storageNote = element('model-storage-note');
  const storageMode = element<HTMLSelectElement>('model-storage-mode');
  const retention = element<HTMLInputElement>('model-retention');
  const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
  let previousPhase: DownloadPhase | undefined;
  let previousCacheDescription = '';
  let modelInUse = false;
  let controlError = '';

  element('model-name').textContent = downloader.model.name;
  element<HTMLAnchorElement>('model-source').href =
    `https://huggingface.co/${downloader.model.repository}/tree/${downloader.model.revision}`;

  const render = () => {
    const state = downloader.getState();
    const view = describeModelDownload(state);
    const isOpfs = state.storageMode === 'opfs';
    const canDownloadToSelection = !isOpfs || state.cache.available;
    storageNote.textContent = isOpfs
      ? 'モデルはこのサイト専用のブラウザー領域に保存します。空き容量の確保やサイトデータの消去で削除される場合があります。'
      : 'モデルはこのページのメモリだけに保持します。再読み込みやページを閉じると失われます。';
    start.disabled = !view.canStart || !canDownloadToSelection;
    start.textContent = state.phase === 'ready'
      ? isOpfs && state.cache.cached ? '保存済みモデルを使用できます' : 'メモリ内のモデルを使用できます'
      : isOpfs ? 'モデルを取得してブラウザーに保存' : 'モデルをメモリへ取得';
    cancel.disabled = !view.canAbort;
    clear.disabled = !view.canClear || modelInUse || (!state.cache.cached && !downloader.getModel());
    clear.textContent = state.cache.cached && downloader.hasMemoryModel()
      ? 'ブラウザー保存データとメモリから削除'
      : state.cache.cached ? 'ブラウザーの保存データを削除' : 'メモリから削除';
    storageMode.disabled = view.active || modelInUse;
    if (storageMode.value !== state.storageMode) storageMode.value = state.storageMode;
    retention.disabled = view.active || modelInUse || !state.cache.available;
    if (document.activeElement !== retention) retention.value = String(state.cache.retentionDays);
    progress.max = state.totalBytes;

    if (view.indeterminate) progress.removeAttribute('value');
    else progress.value = state.loadedBytes;
    progressRegion.setAttribute('aria-busy', String(view.active));
    const percentage = 100 * state.loadedBytes / state.totalBytes;
    amount.textContent = `${number.format(state.loadedBytes / 1_000_000)} / ` +
      `${number.format(state.totalBytes / 1_000_000)} MB（${number.format(percentage)}%）`;

    if (previousPhase !== state.phase) {
      status.textContent = view.status;
      previousPhase = state.phase;
    }
    const description = cacheDescription(state);
    if (previousCacheDescription !== description) {
      cacheStatus.textContent = description;
      previousCacheDescription = description;
    }
    const displayedError = controlError || view.error;
    error.hidden = !displayedError;
    error.textContent = displayedError;
  };

  downloader.subscribe(render);
  void downloader.initialize().then(render);

  start.addEventListener('click', () => {
    void downloader.download().catch(() => {});
  });
  cancel.addEventListener('click', () => {
    void downloader.abort().catch(() => {});
  });
  clear.addEventListener('click', () => {
    if (modelInUse) return;
    void downloader.clear().then(() => {
      controlError = '';
      status.textContent = '保存データを削除しました。次回はモデルを再取得できます。';
      previousPhase = downloader.getState().phase;
      render();
    }).catch(cause => {
      controlError = cause instanceof Error ? cause.message : '保存データを削除できませんでした。';
      error.hidden = false;
      error.textContent = controlError;
    });
  });
  storageMode.addEventListener('change', () => {
    try {
      downloader.setStorageMode(storageMode.value as ModelStorageMode);
      controlError = '';
    } catch (cause) {
      storageMode.value = downloader.getState().storageMode;
      controlError = cause instanceof Error ? cause.message : '保存先を変更できませんでした。';
    }
    render();
  });
  retention.addEventListener('change', () => {
    const days = Number(retention.value);
    void downloader.setRetentionDays(days).then(() => {
      controlError = '';
      render();
    }).catch(cause => {
      controlError = cause instanceof Error ? cause.message : '保持期間を更新できませんでした。';
      retention.value = String(downloader.getState().cache.retentionDays);
      render();
    });
  });

  return {
    downloader,
    setModelInUse(inUse) {
      if (modelInUse !== inUse) {
        modelInUse = inUse;
        downloader.setModelInUse(inUse);
        render();
      }
    },
  };
}
