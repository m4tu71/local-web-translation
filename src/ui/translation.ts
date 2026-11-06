import type { TranslationSession } from '../poc/translation-session.ts';
import type { ModelDownloadControls } from './model-download.ts';
import { describeTranslation } from './translation-view.ts';

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) {
    throw new Error(`Translation UI element not found: ${id}`);
  }
  return result as T;
}

export function mountTranslation(session: TranslationSession, downloadUI: ModelDownloadControls): void {
  const load = element<HTMLButtonElement>('poc-load');
  const translate = element<HTMLButtonElement>('poc-translate');
  const abort = element<HTMLButtonElement>('poc-abort');
  const unload = element<HTMLButtonElement>('poc-unload');
  const backend = element<HTMLSelectElement>('poc-backend');
  const input = element<HTMLTextAreaElement>('poc-input');
  const output = element('poc-output');
  const status = element('poc-status');
  const error = element('poc-error');
  const warning = element('poc-truncated');
  const timing = element('poc-timing');
  const logs = element('poc-logs');
  let previousStatus = '';

  const render = () => {
    const state = session.getState();
    const view = describeTranslation(state, input.value);
    load.disabled = !view.canLoad;
    translate.disabled = !view.canTranslate;
    abort.disabled = !view.canAbort;
    unload.disabled = !view.canUnload;
    backend.disabled = !view.canChangeBackend;
    input.readOnly = view.busy;
    input.setAttribute('aria-busy', String(view.busy));
    if (previousStatus !== view.status) {
      status.textContent = view.status;
      previousStatus = view.status;
    }
    error.hidden = !state.error;
    error.textContent = state.error ?? '';
    output.textContent = state.result?.text ?? '翻訳結果はまだありません。';
    warning.hidden = !state.result?.truncated;
    timing.textContent = state.result ? `翻訳処理時間: ${state.result.elapsedMs} ms` : '';
    logs.textContent = state.logs.join('\n') || '操作するとログを表示します（時刻は UTC）。';
    downloadUI.setModelInUse(state.modelInUse);
  };

  session.subscribe(render);
  input.addEventListener('input', () => {
    session.clearResult();
    render();
  });
  load.addEventListener('click', () => {
    const requestedBackend = backend.value === 'cpu' ? 'cpu' : 'auto';
    void session.load(requestedBackend).catch(() => {});
  });
  translate.addEventListener('click', () => {
    void session.translate(input.value).catch(() => {});
  });
  abort.addEventListener('click', () => {
    void session.abort().catch(() => {});
  });
  unload.addEventListener('click', () => {
    void session.unload().catch(() => {});
  });
}
