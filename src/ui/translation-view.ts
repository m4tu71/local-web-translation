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
  const progress = state.translationProgress;
  const result = state.result;
  const hasPartialResult = result?.status === 'partial';
  const canResume = Boolean(hasPartialResult && result.canResume);
  const runtimeInfo = state.engine.runtimeInfo;
  const validDirection = direction.sourceLanguage !== direction.targetLanguage;
  let validationError = '';
  if (hasText && inputWithinLimit && validDirection) {
    try {
      validateTranslationInput(text, direction);
    } catch (cause) {
      validationError = cause instanceof Error ? cause.message : '入力を確認してください。';
    }
  }
  const inputNeedsCorrection = !inputWithinLimit || Boolean(validationError);
  const canTranslate = !busy && loadedAndReady && hasText && inputWithinLimit && validDirection && !validationError;

  let preparationHeading: string;
  if (state.cancelling || state.engine.phase === 'stopping') {
    preparationHeading = '処理を中止しています';
  } else if (state.operation === 'loading') {
    preparationHeading = 'モデルをロードしています';
  } else if (state.operation === 'translating') {
    preparationHeading = '翻訳中です';
  } else if (state.operation === 'unloading') {
    preparationHeading = 'モデルのロードを解除しています';
  } else if (modelPhase === 'checking') {
    preparationHeading = 'モデルの状態を確認しています';
  } else if (downloadView.active) {
    switch (modelPhase) {
      case 'verifying':
        preparationHeading = 'モデルを検証しています';
        break;
      case 'cancelling':
        preparationHeading = 'モデルの取得を中止しています';
        break;
      case 'clearing':
        preparationHeading = '保存モデルを削除しています';
        break;
      case 'updating-retention':
        preparationHeading = '保持期間を更新しています';
        break;
      default:
        preparationHeading = 'モデルを取得しています';
    }
  } else if (requiresUnload) {
    preparationHeading = 'モデルのロード解除が必要です';
  } else if (state.error && !loadedAndReady) {
    preparationHeading = state.hasModelFile ? 'モデルの再ロードが必要です' : 'モデルを取得してください';
  } else if (loadedAndReady && inputNeedsCorrection) {
    preparationHeading = '入力を確認してください';
  } else if (loadedAndReady && !validDirection) {
    preparationHeading = '翻訳方向を確認してください';
  } else if (loadedAndReady && !hasText) {
    preparationHeading = '文章の入力待ち';
  } else if (canTranslate) {
    preparationHeading = '翻訳できます';
  } else if (modelPhase === 'error') {
    preparationHeading = 'モデルを取得できませんでした';
  } else if (!state.hasModelFile) {
    preparationHeading = 'モデルの取得が必要です';
  } else if (!state.engine.modelLoaded) {
    preparationHeading = 'モデルのロードが必要です';
  } else {
    preparationHeading = '翻訳の状態を確認してください';
  }

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
    if (progress?.phase === 'planning') {
      status = '文章を分けて準備しています。';
    } else if (progress?.phase === 'translating' && progress.total !== undefined) {
      status = `翻訳中 ${Math.min(progress.completed + 1, progress.total)} / ${progress.total}`;
    } else {
      status = `${LANGUAGE_NAMES[direction.sourceLanguage]}から${LANGUAGE_NAMES[direction.targetLanguage]}へ翻訳しています。`;
    }
  } else if (state.operation === 'unloading') {
    status = 'モデルのロードを解除しています。入力と翻訳結果は保持します。';
  } else if (state.error && !loadedAndReady) {
    status = '処理を完了できませんでした。下の案内から回復できます。';
  } else if (loadedAndReady && inputNeedsCorrection) {
    status = !inputWithinLimit
      ? `入力は${MAX_INPUT_CHARACTERS}文字までです。文章を短くしてください。`
      : validationError;
  } else if (loadedAndReady && !validDirection) {
    status = '日本語と英語の異なる方向を選択してください。';
  } else if (loadedAndReady && !hasText) {
    status = state.notice ?? 'モデルはロード済みです。文章を入力してください。';
  } else if (loadedAndReady && canTranslate) {
    status = 'モデルはロード済みです。';
  } else if (modelPhase === 'error') {
    status = downloadView.status;
  } else if (!state.hasModelFile) {
    status = cacheAvailable
      ? '翻訳を始めるには、モデルを取得してロードしてください。'
      : 'モデルを取得する前に、保存方法を選んでください。';
  } else if (state.hasModelFile && !state.engine.modelLoaded) {
    status = '保存済みモデルをロードすると、翻訳できます。';
  } else {
    status = '翻訳を始められるか確認しています。';
  }

  let preparationHint = '';
  if (modelPhase === 'checking') {
    preparationHint = 'モデルは自動で取得・ロードされません。';
  } else if (modelPhase === 'downloading' || modelPhase === 'verifying' || modelPhase === 'cancelling') {
    preparationHint = 'モデルの処理が終わるまで翻訳と設定変更はできません。';
  } else if (downloadView.active) {
    preparationHint = 'モデルの処理が終わると、ロードできます。';
  } else if (state.operation !== 'idle') {
    preparationHint = '処理中は文章や言語の変更、モデル設定を行えません。';
  } else if (requiresUnload) {
    preparationHint = hasPartialResult
      ? 'リソースを解放してから保存済みモデルをロードしてください。部分結果は保持します。'
      : 'リソースを解放してからモデルをロードし直してください。';
  } else if (modelPhase === 'error') {
    preparationHint = downloadView.error || 'モデルの取得に失敗しました。設定を開いて再試行してください。';
  } else if (state.engine.modelLoaded) {
    preparationHint = inputNeedsCorrection || !validDirection
      ? '入力欄の案内に従って文章を修正してください。'
      : !hasText
        ? 'モデルはロード済みです。翻訳する文章を入力してください。'
        : '';
  } else if (state.error && state.hasModelFile) {
    preparationHint = 'モデルをロードできませんでした。設定を確認して再ロードしてください。';
  } else if (!state.hasModelFile) {
    preparationHint = cacheAvailable
      ? 'モデルの取得には約 573 MB が必要です。'
      : 'ブラウザー保存が使えない場合は、設定からメモリ保存を選べます。';
  } else {
    preparationHint = '保存済みモデルをロードすると翻訳を始められます。';
  }

  let translateDisabledReason = '';
  if (canTranslate) {
    translateDisabledReason = '';
  } else if (sessionBusy) {
    translateDisabledReason = '現在の処理が終わるまでお待ちください。';
  } else if (downloadView.active) {
    translateDisabledReason = 'モデルの処理が終わってから翻訳できます。';
  } else if (!loadedAndReady && !state.hasModelFile) {
    translateDisabledReason = '先にモデルを取得してください。';
  } else if (!loadedAndReady && !state.engine.modelLoaded) {
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
  if (!busy && requiresUnload) {
    preparationAction = 'unload';
    preparationActionLabel = state.error ? 'ロード解除を再試行' : 'リソースを解放';
  } else if (!busy && state.hasModelFile && !state.engine.modelLoaded && !state.modelInUse) {
    preparationAction = 'load';
    preparationActionLabel = state.error ? 'モデルを再ロード' : 'モデルをロード';
  } else if (!busy && !state.engine.modelLoaded && !state.hasModelFile) {
    preparationAction = 'download';
    preparationActionLabel = modelPhase === 'error'
      ? 'モデルを再取得'
      : cacheAvailable ? 'モデルを取得' : '保存方法を選ぶ';
  }

  const canAbortSession = ['loading', 'translating'].includes(state.operation) && !state.cancelling && state.engine.phase !== 'stopping';
  const canAbortDownload = downloadView.canAbort;
  const partialReason = hasPartialResult ? result.partialReason : undefined;
  const partialProgress = hasPartialResult
    ? typeof result.completedChunks === 'number' && typeof result.totalChunks === 'number'
      ? `完了 ${result.completedChunks} / ${result.totalChunks} 区切り。`
      : ''
    : '';
  const resultStatus = state.operation === 'translating'
    ? progress?.phase === 'planning'
      ? '文章を分けて準備しています。'
      : progress?.phase === 'translating' && progress.total !== undefined
        ? `翻訳中 ${Math.min(progress.completed + 1, progress.total)} / ${progress.total}`
        : '翻訳中です。分割数を確認しています。'
    : hasPartialResult
      ? partialReason === 'cancelled'
        ? `翻訳を中止しました。表示中の文章は途中までです。${partialProgress}`
        : partialReason === 'truncated'
          ? canResume
            ? `出力上限に達しました。さらに短く区切って再開できます。${partialProgress}`
            : `出力上限に達しました。入力を短くしてください。${partialProgress}`
          : partialReason === 'empty'
            ? canResume
              ? `出力が空でした。再開するか、入力を編集して最初から翻訳してください。${partialProgress}`
              : `出力が空でした。入力を編集して最初から翻訳してください。${partialProgress}`
            : `翻訳を完了できませんでした。表示中の文章は途中までです。${partialProgress}`
      : result
        ? result.text.trim()
          ? '翻訳が完了しました。'
          : '翻訳は完了しましたが、出力が空でした。入力を確認してください。'
        : state.notice ?? '';

  const runtimeBackendName = !state.engine.modelLoaded
    ? 'ロード後に確認できます'
    : runtimeInfo?.backend === 'gpu'
      ? 'GPU'
      : runtimeInfo?.backend === 'cpu'
        ? 'CPU（WASM）'
        : '確認できません';
  const runtimeSummary = state.engine.modelLoaded
    ? `実際の実行環境: ${runtimeBackendName}`
    : '実際の実行環境: ロード後に確認できます';
  const runtimeWebGpuApi = !state.engine.modelLoaded
    ? 'ロード後に確認できます'
    : runtimeInfo?.webGpuApiAvailable === true
      ? 'あり'
      : runtimeInfo?.webGpuApiAvailable === false
        ? 'なし'
        : '確認できません';
  const reportedContextSize = runtimeInfo?.actualContextSize ??
    (runtimeInfo?.contextSizeSource === 'runtime' ? runtimeInfo.contextSize : undefined);
  const runtimeContext = runtimeInfo
    ? reportedContextSize !== undefined
      ? `${reportedContextSize} トークン（エンジン報告値）`
      : `${runtimeInfo.contextSize} トークン（要求値）`
    : '';
  const truncatedWarningText = hasPartialResult && partialReason === 'truncated'
    ? canResume
      ? '出力上限に達したため途中までです。未完了の部分をさらに細かく分けて再開できます。'
      : '出力上限に達したため途中までです。これ以上小さく分けられないため、入力を短くしてください。'
    : '出力上限に達したため、途中で切れている可能性があります。文章を分けて再度翻訳してください。';

  return {
    preparationHeading,
    status,
    preparationHint,
    compactReadyState: canTranslate && loadedAndReady,
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
    canCopyResult: !sessionBusy && result?.status !== 'streaming' && Boolean(result?.text.trim()),
    copyResultLabel: hasPartialResult ? '部分結果をコピー' : '結果をコピー',
    resultPlaceholder: result?.status === 'streaming' && !result.text.trim()
      ? '翻訳中です。最初の出力を待っています。'
      : hasPartialResult
        ? result.text.trim()
          ? '部分結果はここに表示されます。'
          : partialReason === 'empty'
            ? '翻訳結果は空でした。'
            : '途中の出力はまだありません。'
        : result
          ? '翻訳結果が空でした。入力を確認して再度翻訳してください。'
          : '翻訳結果はここに表示されます。',
    resultStatus,
    showResume: canResume,
    canResume: canResume && loadedAndReady && !busy,
    resumeHint: canResume && !loadedAndReady
      ? !state.hasModelFile
        ? '再開にはモデルの取得とロードが必要です。上の準備操作を行ってください。'
        : '再開にはモデルのロードが必要です。上の準備操作を行ってください。'
      : '',
    showTruncatedWarning: Boolean(result?.truncated),
    truncatedWarningText,
    showTiming: Boolean(result && result.status === 'complete'),
    showError: Boolean(state.error),
    errorText: state.error ?? '',
    showOpenLogs: Boolean(state.error || !state.result?.text.trim()),
    runtimeSummary,
    runtimeBackendName,
    runtimeWebGpuApi,
    showRuntimeContext: Boolean(runtimeInfo),
    runtimeContext,
    showRuntimeGpuLayers: typeof runtimeInfo?.gpuLayers === 'number',
    runtimeGpuLayers: typeof runtimeInfo?.gpuLayers === 'number'
      ? `${runtimeInfo.gpuLayers} 層`
      : '',
  };
}
