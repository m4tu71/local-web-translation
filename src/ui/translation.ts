import type { TranslationSession } from '../poc/translation-session.ts';
import { MAX_INPUT_CHARACTERS, type Language, type TranslationDirection } from '../translation/input.ts';
import type { ModelDownloadControls } from './model-download.ts';
import {
  AsyncFeedbackGuard,
  DEFAULT_DIRECTION,
  InputUndoHistory,
  changeSourceLanguage,
  changeTargetLanguage,
  swapDirection,
} from './translation-workspace.ts';
import { describeTranslation } from './translation-view.ts';

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Translation UI element not found: ${id}`);
  return result as T;
}

function requestedBackend(value: string): 'auto' | 'cpu' {
  return value === 'cpu' ? 'cpu' : 'auto';
}

function setTextIfChanged(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

export function mountTranslation(session: TranslationSession, downloadUI: ModelDownloadControls): void {
  const form = element<HTMLFormElement>('translation-form');
  const sourceLanguage = element<HTMLSelectElement>('source-language');
  const targetLanguage = element<HTMLSelectElement>('target-language');
  const swap = element<HTMLButtonElement>('swap-languages');
  const input = element<HTMLTextAreaElement>('translation-input');
  const inputCount = element('input-count');
  const inputMessage = element('input-message');
  const exampleHint = element('example-hint');
  const insertExample = element<HTMLButtonElement>('insert-example');
  const clearInput = element<HTMLButtonElement>('clear-input');
  const undoClear = element<HTMLButtonElement>('undo-clear');
  const translate = element<HTMLButtonElement>('translate-button');
  const translateHint = element('translate-hint');
  const output = element('translation-output');
  const copy = element<HTMLButtonElement>('copy-result');
  const copyStatus = element('copy-status');
  const resultWarning = element('result-warning');
  const resultTiming = element('result-timing');
  const translationStatus = element('translation-status');
  const errorPanel = element<HTMLDivElement>('translation-error');
  const errorText = element('translation-error-text');
  const openLogs = element<HTMLButtonElement>('show-logs');
  const preparationStatus = element('preparation-status');
  const preparationHint = element('preparation-hint');
  const preparationAction = element<HTMLButtonElement>('preparation-action');
  const preparationAbort = element<HTMLButtonElement>('preparation-abort');
  const modelStatus = element('model-status');
  const runtimeBackend = element<HTMLSelectElement>('runtime-backend');
  const modelSettings = element<HTMLDetailsElement>('model-settings');
  const modelDownload = element<HTMLButtonElement>('model-download');
  const modelLoad = element<HTMLButtonElement>('model-load');
  const modelUnload = element<HTMLButtonElement>('model-unload');
  const diagnostics = element<HTMLDetailsElement>('diagnostics');
  const translationLogs = element('translation-logs');
  const modelLogs = element('model-logs');
  let direction: TranslationDirection = DEFAULT_DIRECTION;
  let previousPreparationStatus = '';
  let previousOperation = '';
  let previousInputError = '';
  const undoHistory = new InputUndoHistory();
  const copyFeedback = new AsyncFeedbackGuard();

  const clearCopyFeedback = () => {
    copyFeedback.invalidate();
    copyStatus.textContent = '';
  };

  const syncDirectionControls = () => {
    sourceLanguage.value = direction.sourceLanguage;
    targetLanguage.value = direction.targetLanguage;
    input.lang = direction.sourceLanguage;
  };

  const refreshInput = (recordEdit: boolean) => {
    if (recordEdit) undoHistory.recordEdit(input.value);
    inputCount.textContent = `${input.value.length} / ${MAX_INPUT_CHARACTERS}`;
    input.setAttribute('aria-invalid', String(input.value.length > MAX_INPUT_CHARACTERS));
    if (input.value.length > MAX_INPUT_CHARACTERS) {
      setTextIfChanged(inputMessage, `入力は${MAX_INPUT_CHARACTERS}文字までです。短くしてください。`);
    } else if (recordEdit && input.value && !previousInputError) {
      setTextIfChanged(inputMessage, '');
    }
    session.clearResult();
    clearCopyFeedback();
    render();
  };

  const changeDirection = (nextDirection: TranslationDirection) => {
    if (nextDirection.sourceLanguage === direction.sourceLanguage &&
        nextDirection.targetLanguage === direction.targetLanguage) return;
    direction = nextDirection;
    syncDirectionControls();
    session.clearResult();
    clearCopyFeedback();
    translationStatus.textContent = '';
    render();
  };

  const loadModel = (focusTarget: HTMLElement) => {
    const view = describeTranslation(
      session.getState(),
      input.value,
      direction,
      downloadUI.downloader.getState(),
    );
    if (!view.canLoad) return;
    const operation = session.load(requestedBackend(runtimeBackend.value));
    focusTarget.focus();
    void operation.catch(() => {});
  };

  const unloadModel = (focusTarget: HTMLElement) => {
    const view = describeTranslation(
      session.getState(),
      input.value,
      direction,
      downloadUI.downloader.getState(),
    );
    if (!view.canUnload) return;
    const operation = session.unload();
    focusTarget.focus();
    void operation.catch(() => {});
  };

  const openModelSettings = (focusTarget: HTMLElement) => {
    modelSettings.open = true;
    requestAnimationFrame(() => focusTarget.focus());
  };

  const runTranslation = () => {
    const view = describeTranslation(
      session.getState(),
      input.value,
      direction,
      downloadUI.downloader.getState(),
    );
    if (!view.canTranslate) return;
    clearCopyFeedback();
    translationStatus.textContent = '';
    void session.translate(input.value, direction).catch(() => {});
  };

  const render = () => {
    const state = session.getState();
    const modelState = downloadUI.downloader.getState();
    const view = describeTranslation(state, input.value, direction, modelState);
    const isTranslating = state.operation === 'translating';

    if (previousOperation !== 'translating' && isTranslating) clearCopyFeedback();
    previousOperation = state.operation;

    if (previousPreparationStatus !== view.status) {
      preparationStatus.textContent = view.status;
      previousPreparationStatus = view.status;
    }
    preparationHint.textContent = view.preparationHint;
    preparationAction.hidden = !view.showPreparationAction;
    preparationAction.disabled = !view.showPreparationAction;
    preparationAction.textContent = view.preparationActionLabel;
    preparationAbort.hidden = !view.showPreparationAbort;
    preparationAbort.textContent = view.preparationAbortLabel;
    preparationAbort.disabled = !view.showPreparationAbort;

    input.readOnly = !view.canEditInput;
    input.setAttribute('aria-busy', String(view.sessionBusy));
    input.setAttribute('aria-invalid', String(view.inputInvalid));
    if (view.inputError) setTextIfChanged(inputMessage, view.inputError);
    else if (previousInputError) setTextIfChanged(inputMessage, '');
    previousInputError = view.inputError;
    sourceLanguage.disabled = !view.canChangeLanguages;
    targetLanguage.disabled = !view.canChangeLanguages;
    swap.disabled = !view.canChangeLanguages;
    insertExample.disabled = !view.canEditInput || input.value.length > 0;
    exampleHint.textContent = input.value
      ? '例文を入れるには、入力欄を消去してください。'
      : view.sessionBusy ? '処理中は例文を入力できません。' : '入力欄が空のときに例文を使えます。入力文は上書きしません。';
    clearInput.disabled = !view.canClearInput;
    undoClear.hidden = !undoHistory.canUndo(input.value);
    undoClear.disabled = !undoHistory.canUndo(input.value) || !view.canEditInput;
    translate.disabled = !view.canTranslate;
    translateHint.textContent = view.canTranslate
      ? 'Ctrl/Cmd + Enter でも翻訳できます。'
      : view.translateDisabledReason;

    const resultText = state.result?.text;
    output.textContent = resultText?.trim() ? resultText : view.resultPlaceholder;
    output.setAttribute('aria-busy', String(isTranslating));
    output.lang = state.result?.direction.targetLanguage ?? direction.targetLanguage;
    setTextIfChanged(translationStatus, view.resultStatus || (!state.result ? state.notice ?? '' : ''));
    copy.disabled = !view.canCopyResult;
    resultWarning.hidden = !view.showTruncatedWarning;
    setTextIfChanged(resultWarning, view.showTruncatedWarning
      ? '出力上限に達したため、途中で切れている可能性があります。文章を分けて再度翻訳してください。'
      : '');
    resultTiming.hidden = !view.showTiming;
    resultTiming.textContent = state.result ? `翻訳時間: ${state.result.elapsedMs} ms` : '';
    errorPanel.hidden = !view.showError;
    setTextIfChanged(errorText, view.errorText);

    runtimeBackend.disabled = !view.canChangeBackend;
    modelLoad.disabled = !view.canLoad;
    modelUnload.disabled = !view.canUnload;
    translationLogs.textContent = state.logs.join('\n') || '翻訳操作を行うとログを表示します。';
    modelLogs.textContent = modelState.error?.message ??
      (modelState.cache.cached ? '保存モデルの確認に成功しました。' : 'モデルの取得・保存状態を確認します。');
    downloadUI.setModelInUse(state.modelInUse);
  };

  sourceLanguage.value = direction.sourceLanguage;
  targetLanguage.value = direction.targetLanguage;
  input.lang = direction.sourceLanguage;
  session.subscribe(render);
  downloadUI.downloader.subscribe(render);

  form.addEventListener('submit', event => {
    event.preventDefault();
    runTranslation();
  });
  input.addEventListener('input', () => refreshInput(true));
  input.addEventListener('keydown', event => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== 'Enter' || !(keyboardEvent.ctrlKey || keyboardEvent.metaKey) ||
        keyboardEvent.altKey || keyboardEvent.shiftKey || keyboardEvent.isComposing || keyboardEvent.keyCode === 229) return;
    keyboardEvent.preventDefault();
    runTranslation();
  });
  sourceLanguage.addEventListener('change', () => {
    const source = sourceLanguage.value as Language;
    changeDirection(changeSourceLanguage(direction, source));
  });
  targetLanguage.addEventListener('change', () => {
    const target = targetLanguage.value as Language;
    changeDirection(changeTargetLanguage(direction, target));
  });
  swap.addEventListener('click', () => changeDirection(swapDirection(direction)));
  insertExample.addEventListener('click', () => {
    if (input.value || !describeTranslation(session.getState(), input.value, direction, downloadUI.downloader.getState()).canEditInput) return;
    input.value = direction.sourceLanguage === 'ja'
      ? 'この文章を英語に翻訳してください。'
      : 'Please translate this sentence into Japanese.';
    inputMessage.textContent = '';
    undoHistory.recordEdit(input.value);
    refreshInput(false);
    input.focus();
  });
  clearInput.addEventListener('click', () => {
    if (!undoHistory.clear(input.value)) return;
    input.value = '';
    inputMessage.textContent = '入力を消去しました。元に戻せます。';
    refreshInput(false);
    input.focus();
  });
  undoClear.addEventListener('click', () => {
    const restored = undoHistory.undo(input.value);
    if (restored === undefined) return;
    input.value = restored;
    inputMessage.textContent = '入力を元に戻しました。';
    refreshInput(false);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  preparationAction.addEventListener('click', () => {
    const view = describeTranslation(
      session.getState(),
      input.value,
      direction,
      downloadUI.downloader.getState(),
    );
    if (view.preparationAction === 'load') {
      loadModel(preparationStatus);
    } else if (view.preparationAction === 'unload') {
      unloadModel(preparationStatus);
    } else if (view.preparationAction === 'download') {
      openModelSettings(downloadUI.downloader.getState().cache.available
        ? modelDownload
        : element<HTMLSelectElement>('model-storage-mode'));
    }
  });
  preparationAbort.addEventListener('click', () => {
    const state = session.getState();
    const modelState = downloadUI.downloader.getState();
    if (['loading', 'translating'].includes(state.operation)) {
      const operation = session.abort();
      preparationStatus.focus();
      void operation.catch(() => {});
    } else if (modelState.phase === 'downloading' || modelState.phase === 'verifying') {
      const operation = downloadUI.downloader.abort();
      preparationStatus.focus();
      void operation.catch(() => {});
    }
  });
  modelLoad.addEventListener('click', () => loadModel(modelStatus));
  modelUnload.addEventListener('click', () => unloadModel(modelStatus));
  copy.addEventListener('click', () => {
    const text = session.getState().result?.text;
    const view = describeTranslation(session.getState(), input.value, direction, downloadUI.downloader.getState());
    if (!text?.trim() || !view.canCopyResult) return;
    const revision = copyFeedback.begin();
    copyStatus.textContent = 'コピーしています…';
    void (async () => {
      try {
        const clipboard = globalThis.navigator?.clipboard;
        if (!clipboard?.writeText) throw new Error('このブラウザーではクリップボードを利用できません。');
        await clipboard.writeText(text);
        if (copyFeedback.isCurrent(revision)) copyStatus.textContent = 'コピーしました。';
      } catch {
        if (copyFeedback.isCurrent(revision)) {
          copyStatus.textContent = 'コピーできませんでした。翻訳結果を選択してコピーしてください。';
        }
      }
    })();
  });
  openLogs.addEventListener('click', () => {
    diagnostics.open = true;
    requestAnimationFrame(() => translationLogs.focus());
  });
}
