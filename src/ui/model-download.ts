import { ModelDownloader, type DownloadPhase } from '../models/model-download.ts';
import { describeModelDownload } from './model-download-view.ts';

export interface ModelDownloadControls {
  downloader: ModelDownloader;
  setModelInUse(inUse: boolean): void;
}

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) {
    throw new Error(`Model download UI element not found: ${id}`);
  }
  return result as T;
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
  const number = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
  let previousPhase: DownloadPhase | undefined;
  let modelInUse = false;

  element('model-name').textContent = downloader.model.name;
  element<HTMLAnchorElement>('model-source').href =
    `https://huggingface.co/${downloader.model.repository}/tree/${downloader.model.revision}`;

  const render = () => {
    const state = downloader.getState();
    const view = describeModelDownload(state);
    start.disabled = !view.canStart;
    start.textContent = state.phase === 'ready' ? '取得済み' : 'モデルを取得';
    cancel.disabled = !view.canAbort;
    clear.disabled = !view.canClear || modelInUse;
    progress.max = state.totalBytes;

    if (view.indeterminate) {
      progress.removeAttribute('value');
    } else {
      progress.value = state.loadedBytes;
    }

    progressRegion.setAttribute('aria-busy', String(view.active));
    const percentage = 100 * state.loadedBytes / state.totalBytes;
    amount.textContent = `${number.format(state.loadedBytes / 1_000_000)} / ` +
      `${number.format(state.totalBytes / 1_000_000)} MB（${number.format(percentage)}%）`;

    // Announce phase changes, not every network chunk, to assistive technology.
    if (previousPhase !== state.phase) {
      status.textContent = view.status;
      previousPhase = state.phase;
    }

    error.hidden = !view.error;
    error.textContent = view.error;
  };

  downloader.subscribe(render);

  start.addEventListener('click', () => {
    // Errors are handled by the state subscription; do not leave a rejected promise.
    void downloader.download().catch(() => {});
  });
  cancel.addEventListener('click', () => {
    void downloader.abort().catch(() => {});
  });
  clear.addEventListener('click', () => {
    if (modelInUse) {
      return;
    }
    downloader.clear();
    status.textContent = 'モデルをメモリから削除しました。';
  });

  return {
    downloader,
    setModelInUse(inUse) {
      if (modelInUse !== inUse) {
        modelInUse = inUse;
        render();
      }
    },
  };
}
