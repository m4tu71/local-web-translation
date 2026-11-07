import { ModelDownloader, type DownloadPhase, type ModelStorageMode } from '../models/model-download.ts';
import { describeModelDownload } from './model-download-view.ts';

export type ModelDownloadPort = Pick<
  ModelDownloader,
  | 'model'
  | 'getState'
  | 'getModel'
  | 'acquireModel'
  | 'markUsed'
  | 'subscribe'
  | 'initialize'
  | 'download'
  | 'abort'
  | 'clear'
  | 'setStorageMode'
  | 'setRetentionDays'
  | 'setModelInUse'
  | 'hasMemoryModel'
>;

export interface ModelDownloadControls {
  downloader: ModelDownloadPort;
  setModelInUse(inUse: boolean): void;
}

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Model download UI element not found: ${id}`);
  return result as T;
}

function setTextIfChanged(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

function formatMegabytes(bytes: number): string {
  return `${new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(bytes / 1_000_000)} MB`;
}

function cacheDescription(
  state: ReturnType<ModelDownloader['getState']>,
  hasMemoryModel: boolean,
): string {
  if (state.phase === 'checking') return 'モデルの保存状態を確認しています。';
  if (state.storageMode === 'memory') {
    return hasMemoryModel
      ? 'モデルをこのページのメモリに保持しています。ページを閉じると失われます。'
      : '選択中のモデルはこのページのメモリだけに保持されます。ページを閉じると失われます。';
  }
  if (!state.cache.available) {
    return `${state.cache.error?.message ?? 'ブラウザー保存を利用できません。'} 「このページのメモリだけに保存」を選ぶと、このページで取得できます。`;
  }
  if (!state.cache.cached) return 'ブラウザーに保存されたモデルはありません。';

  const amount = formatMegabytes(state.cache.bytes);
  const lastUsed = state.cache.lastUsed ? ` 最終使用: ${formatDate(state.cache.lastUsed)}。` : '';
  const expiry = state.cache.expiresAt ? ` 保持期限: ${formatDate(state.cache.expiresAt)}。` : '';
  return `ブラウザーにモデルを保存済みです（${amount}）。${lastUsed}${expiry} 最終使用から${state.cache.retentionDays}日で期限切れになります。`;
}

export function mountModelDownload(downloader: ModelDownloadPort = new ModelDownloader()): ModelDownloadControls {
  const start = element<HTMLButtonElement>('model-download');
  const cancel = element<HTMLButtonElement>('model-cancel');
  const clear = element<HTMLButtonElement>('model-clear');
  const clearConfirmation = element<HTMLDivElement>('model-clear-confirmation');
  const clearConfirmationText = element('model-clear-confirmation-text');
  const confirmClear = element<HTMLButtonElement>('model-clear-confirm');
  const cancelClear = element<HTMLButtonElement>('model-clear-cancel');
  const progress = element<HTMLProgressElement>('model-progress');
  const progressRegion = element('model-progress-region');
  const amount = element('model-progress-text');
  const status = element('model-status');
  const modelStatus = element('model-status');
  const error = element('model-error');
  const cacheStatus = element('model-cache-status');
  const storageNote = element('model-storage-note');
  const storageMode = element<HTMLSelectElement>('model-storage-mode');
  const retention = element<HTMLInputElement>('model-retention');
  const modelLogs = element('model-logs');
  let previousPhase: DownloadPhase | undefined;
  let previousCacheDescription = '';
  let modelInUse = false;
  let clearConfirmationOpen = false;
  let controlError = '';

  element('model-name').textContent = downloader.model.name;
  element<HTMLAnchorElement>('model-source').href =
    `https://huggingface.co/${downloader.model.repository}/tree/${downloader.model.revision}`;

  const closeClearConfirmation = (returnFocus: boolean) => {
    const wasOpen = clearConfirmationOpen;
    clearConfirmationOpen = false;
    clearConfirmation.hidden = true;
    clear.setAttribute('aria-expanded', 'false');
    confirmClear.disabled = true;
    if (wasOpen) {
      if (returnFocus) clear.focus();
      else modelStatus.focus();
    }
  };

  const render = () => {
    const state = downloader.getState();
    const view = describeModelDownload(state);
    const isOpfs = state.storageMode === 'opfs';
    const canDownloadToSelection = !isOpfs || state.cache.available;
    const hasMemoryModel = downloader.hasMemoryModel();
    if (view.active || modelInUse) closeClearConfirmation(false);

    storageNote.textContent = isOpfs
      ? 'モデルはこのサイト専用のブラウザー領域に保存します。サイトデータの消去や空き容量の確保で削除される場合があります。'
      : 'モデルはこのページのメモリだけに保持します。再読み込みやページを閉じると失われます。';
    start.disabled = !view.canStart || !canDownloadToSelection;
    if (state.phase === 'ready') start.textContent = '取得済み';
    else if (state.phase === 'checking') start.textContent = '保存状態を確認中…';
    else if (state.phase === 'downloading') start.textContent = 'モデルを取得中…';
    else if (state.phase === 'verifying') start.textContent = 'モデルを確認中…';
    else if (state.phase === 'cancelling') start.textContent = '取得を中止中…';
    else if (state.phase === 'clearing') start.textContent = '削除中…';
    else if (state.phase === 'updating-retention') start.textContent = '保持期間を更新中…';
    else start.textContent = state.phase === 'error' ? 'モデルを再取得（約 573 MB）' : 'モデルを取得（約 573 MB）';
    cancel.hidden = !view.canAbort;
    cancel.disabled = !view.canAbort;
    clear.disabled = !view.canClear || modelInUse || (!state.cache.cached && !hasMemoryModel);
    clear.setAttribute('aria-expanded', String(clearConfirmationOpen));
    confirmClear.disabled = !clearConfirmationOpen || view.active || modelInUse;
    clearConfirmation.hidden = !clearConfirmationOpen;
    storageMode.disabled = view.active || modelInUse;
    if (storageMode.value !== state.storageMode) storageMode.value = state.storageMode;
    retention.disabled = view.active || modelInUse || !state.cache.available;
    if (document.activeElement !== retention) retention.value = String(state.cache.retentionDays);

    progressRegion.hidden = !view.showProgress;
    progress.max = state.totalBytes;
    if (view.indeterminate) progress.removeAttribute('value');
    else progress.value = state.loadedBytes;
    progressRegion.setAttribute('aria-busy', String(view.active));
    const percentage = state.totalBytes > 0 ? 100 * state.loadedBytes / state.totalBytes : 0;
    amount.textContent = `${formatMegabytes(state.loadedBytes)} / ` +
      `${formatMegabytes(state.totalBytes)}（${new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 }).format(percentage)}%）`;

    if (previousPhase !== state.phase) {
      status.textContent = view.status;
      previousPhase = state.phase;
    }
    const description = cacheDescription(state, hasMemoryModel);
    if (previousCacheDescription !== description) {
      cacheStatus.textContent = description;
      previousCacheDescription = description;
    }
    const displayedError = controlError || view.error;
    error.hidden = !displayedError;
    setTextIfChanged(error, displayedError);
    modelLogs.textContent = displayedError || status.textContent || 'モデル操作のログはありません。';
  };

  downloader.subscribe(render);
  void downloader.initialize().then(render).catch(cause => {
    controlError = cause instanceof Error ? cause.message : 'モデルの保存状態を確認できませんでした。';
    render();
  });

  start.addEventListener('click', () => {
    controlError = '';
    const operation = downloader.download();
    modelStatus.focus();
    void operation.catch(() => render());
  });
  cancel.addEventListener('click', () => {
    const operation = downloader.abort();
    modelStatus.focus();
    void operation.catch(cause => {
      controlError = cause instanceof Error ? cause.message : '取得を中止できませんでした。';
      render();
    });
  });
  clear.addEventListener('click', () => {
    if (modelInUse || clear.disabled) return;
    const state = downloader.getState();
    const deletionTargets = [
      state.cache.cached ? 'ブラウザー内の保存モデル' : '',
      downloader.hasMemoryModel() ? 'このページのメモリモデル' : '',
    ].filter(Boolean);
    const targetDescription = deletionTargets.join('と') || 'モデル';
    clearConfirmationText.textContent = `${targetDescription}を削除します。次に翻訳するには約 573 MB の再取得が必要です。`;
    clearConfirmationOpen = true;
    render();
    cancelClear.focus();
  });
  confirmClear.addEventListener('click', () => {
    if (!clearConfirmationOpen || modelInUse) return;
    clearConfirmationOpen = false;
    controlError = '';
    render();
    const operation = downloader.clear();
    modelStatus.focus();
    void operation.then(() => {
      status.textContent = '保存モデルを削除しました。次回はモデルを再取得できます。';
      previousPhase = downloader.getState().phase;
      render();
      (start.disabled ? storageMode : start).focus();
    }).catch(cause => {
      controlError = cause instanceof Error ? cause.message : '保存モデルを削除できませんでした。';
      render();
      error.focus();
    });
  });
  cancelClear.addEventListener('click', () => closeClearConfirmation(true));
  storageMode.addEventListener('change', () => {
    closeClearConfirmation(false);
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
    const operation = downloader.setRetentionDays(days);
    void operation.then(() => {
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
