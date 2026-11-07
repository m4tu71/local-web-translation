import type { TranslationSessionState } from '../poc/translation-session.ts';
import type { ModelDownloadState } from '../models/model-download.ts';
import { MAX_INPUT_CHARACTERS, type TranslationDirection, validateTranslationInput } from '../translation/input.ts';
import { describeModelDownload } from './model-download-view.ts';

const LANGUAGE_NAMES = {
  ja: '日本語',
  en: '英語',
} as const;

export function describeTranslation(
  state: TranslationSessionState,
  text: string,
  direction: TranslationDirection = { sourceLanguage: 'ja', targetLanguage: 'en' },
  modelState?: ModelDownloadState,
) {
  const downloadView = modelState
    ? describeModelDownload(modelState)
    : { active: false, canAbort: false, status: '', error: '', cache: { available: true } };
  const modelPhase = modelState?.phase;
  const cacheAvailable = modelState?.cache.available ?? true;
  const sessionBusy = state.operation !== 'idle';
  const busy = sessionBusy || downloadView.active;
  const hasText = Boolean(text.trim());
  const inputWithinLimit = text.length <= MAX_INPUT_CHARACTERS;
  const loadedAndReady = state.engine.modelLoaded && state.engine.phase === 'ready';
  const requiresUnload = state.modelInUse && !loadedAndReady;
  const validDirection = direction.sourceLanguage !== direction.targetLanguage;
  let validationError = '';
  if (hasText && inputWithinLimit && validDirection) {
    try {
      validateTranslationInput(text, direction);
    } catch (cause) {
      validationError = cause instanceof Error ? cause.message : '入力を確認してください。';
    }
  }
  const canTranslate = !busy && loadedAndReady && hasText && inputWithinLimit && validDirection && !validationError;

  let status: string;
  if (modelPhase === 'checking') {
    status = 'モデルの保存状態を確認しています。';
  } else if (downloadView.active) {
    status = downloadView.status;
  } else if (state.cancelling || state.engine.phase === 'stopping') {
    status = '処理を中止しています。停止とリソース解放を待っています。';
  } else if (state.operation === 'loading') {
    status = 'モデルをロードしています。初回は時間がかかる場合があります。';
  } else if (state.operation === 'translating') {
    status = `${LANGUAGE_NAMES[direction.sourceLanguage]}から${LANGUAGE_NAMES[direction.targetLanguage]}へ翻訳しています。`;
  } else if (state.operation === 'unloading') {
    status = 'モデルのロードを解除しています。入力と翻訳結果は保持します。';
  } else if (state.error && !loadedAndReady) {
    status = '処理を完了できませんでした。下の案内から回復できます。';
  } else if (state.engine.modelLoaded) {
    status = state.notice ?? '翻訳の準備ができました。文章を入力してください。';
  } else if (state.hasModelFile) {
    status = 'モデルを保存済みです。翻訳する前にロードしてください。';
  } else if (modelPhase === 'error') {
    status = downloadView.status;
  } else {
    status = '翻訳を始めるには、モデルを取得してロードしてください。';
  }

  let preparationHint = '';
  if (modelPhase === 'checking') {
    preparationHint = '取得やロードは自動で始まりません。';
  } else if (modelPhase === 'downloading' || modelPhase === 'verifying' || modelPhase === 'cancelling') {
    preparationHint = 'モデルの処理が終わるまで翻訳と設定変更はできません。';
  } else if (downloadView.active) {
    preparationHint = 'モデルの処理が終わると、翻訳の準備ができます。';
  } else if (state.operation !== 'idle') {
    preparationHint = '処理中は文章や言語の変更、モデル設定を行えません。';
  } else if (state.error && requiresUnload) {
    preparationHint = 'ロード解除を再試行してから、モデルをロードし直してください。';
  } else if (state.error && state.hasModelFile && !state.engine.modelLoaded) {
    preparationHint = 'モデルのロードに失敗しました。設定を確認して再試行してください。';
  } else if (modelPhase === 'error') {
    preparationHint = downloadView.error || 'モデルの取得に失敗しました。設定を開いて再試行してください。';
  } else if (!state.hasModelFile) {
    preparationHint = cacheAvailable
      ? 'モデルの取得には約 573 MB が必要です。'
      : 'ブラウザー保存が使えない場合は、設定からメモリ保存を選べます。';
  } else if (!state.engine.modelLoaded) {
    preparationHint = '保存済みのモデルをロードすると翻訳できます。';
  } else {
    preparationHint = '入力文は端末内で処理され、このページには保存されません。';
  }

  let translateDisabledReason = '';
  if (sessionBusy) {
    translateDisabledReason = '現在の処理が終わるまでお待ちください。';
  } else if (downloadView.active) {
    translateDisabledReason = 'モデルの処理が終わってから翻訳できます。';
  } else if (!state.hasModelFile) {
    translateDisabledReason = '先にモデルを取得してください。';
  } else if (!state.engine.modelLoaded) {
    translateDisabledReason = '先に保存済みのモデルをロードしてください。';
  } else if (!loadedAndReady) {
    translateDisabledReason = 'モデルを利用できません。ロード解除してから再度ロードしてください。';
  } else if (!hasText) {
    translateDisabledReason = '翻訳する文章を入力してください。';
  } else if (!inputWithinLimit) {
    translateDisabledReason = `入力は${MAX_INPUT_CHARACTERS}文字までです。`;
  } else if (!validDirection) {
    translateDisabledReason = '翻訳元と翻訳先に異なる言語を選んでください。';
  } else if (validationError) {
    translateDisabledReason = validationError;
  }

  let preparationAction: 'download' | 'load' | 'unload' | undefined;
  let preparationActionLabel = '';
  if (!busy && state.error && requiresUnload) {
    preparationAction = 'unload';
    preparationActionLabel = 'ロード解除を再試行';
  } else if (!busy && state.hasModelFile && !state.engine.modelLoaded && !state.modelInUse) {
    preparationAction = 'load';
    preparationActionLabel = state.error ? 'モデルを再ロード' : '翻訳の準備';
  } else if (!busy && !state.hasModelFile) {
    preparationAction = 'download';
    preparationActionLabel = modelPhase === 'error'
      ? 'モデルを再取得'
      : cacheAvailable ? 'モデルを取得' : '保存方法を選ぶ';
  }

  const canAbortSession = ['loading', 'translating'].includes(state.operation) && !state.cancelling && state.engine.phase !== 'stopping';
  const canAbortDownload = downloadView.canAbort;

  return {
    status,
    preparationHint,
    preparationAction,
    preparationActionLabel,
    showPreparationAction: Boolean(preparationAction),
    showPreparationAbort: canAbortSession || canAbortDownload,
    preparationAbortLabel: canAbortDownload ? '取得を中止' : '処理を中止',
    busy,
    sessionBusy,
    canTranslate,
    translateDisabledReason,
    canLoad: !busy && state.hasModelFile && !state.engine.modelLoaded && !state.modelInUse,
    canUnload: !busy && state.modelInUse,
    canAbortSession,
    canAbortDownload,
    canAbort: canAbortSession || canAbortDownload,
    canChangeBackend: !busy && !state.modelInUse,
    canChangeLanguages: !sessionBusy && !downloadView.active,
    canEditInput: !sessionBusy,
    inputInvalid: inputWithinLimit === false || Boolean(validationError),
    inputError: validationError,
    canClearInput: !sessionBusy && Boolean(text),
    canCopyResult: !sessionBusy && Boolean(state.result?.text.trim()),
    resultPlaceholder: state.result
      ? '翻訳結果が空でした。入力を確認して再度翻訳してください。'
      : '翻訳結果はここに表示されます。',
    resultStatus: state.result
      ? state.result.text.trim()
        ? '翻訳が完了しました。'
        : '翻訳は完了しましたが、出力が空でした。入力を確認してください。'
      : state.notice ?? '',
    showTruncatedWarning: Boolean(state.result?.truncated),
    showTiming: Boolean(state.result),
    showError: Boolean(state.error),
    errorText: state.error ?? '',
    showOpenLogs: Boolean(state.error || !state.result?.text.trim()),
    runtimeBackend: state.requestedBackend ?? 'auto',
  };
}
