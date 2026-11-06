import type { ModelDownloadState } from '../models/model-download.ts';

export function describeModelDownload(state: ModelDownloadState) {
  const active = ['downloading', 'verifying', 'cancelling'].includes(state.phase);
  const messages = {
    idle: '取得前です。「モデルを取得」を押してください。',
    downloading: 'Hugging Face からモデルを取得しています。',
    verifying: '受信が終わりました。モデルの整合性を確認しています。',
    cancelling: '取得を中止しています。',
    cancelled: '取得を中止しました。再試行すると最初から取得します。',
    ready: 'モデルの取得と整合性確認が完了しました。翻訳の実行は次の段階です。',
    error: 'モデルを取得できませんでした。エラーの内容を確認してください。',
  };

  return {
    status: messages[state.phase],
    active,
    canStart: !active && state.phase !== 'ready',
    canAbort: state.phase === 'downloading' || state.phase === 'verifying',
    canClear: state.phase === 'ready',
    indeterminate: state.phase === 'verifying' || state.phase === 'cancelling',
    error: state.phase === 'error' ? state.error?.message ?? '' : '',
  };
}
