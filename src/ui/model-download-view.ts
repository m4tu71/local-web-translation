import type { ModelDownloadState } from '../models/model-download.ts';

export function describeModelDownload(state: ModelDownloadState) {
  const active = ['checking', 'downloading', 'verifying', 'cancelling', 'clearing', 'updating-retention'].includes(state.phase);
  const messages = {
    idle: '取得前です。「モデルを取得」を押してください。',
    checking: 'ブラウザー内のモデルキャッシュを確認しています。',
    downloading: 'Hugging Face からモデルを取得しています。',
    verifying: '受信が終わりました。モデルの整合性を確認しています。',
    cancelling: '取得を中止しています。',
    clearing: '保存データを削除しています。',
    'updating-retention': '保持期間を更新しています。',
    cancelled: '取得を中止しました。再試行すると最初から取得します。',
    ready: 'モデルを使用できます。下の画面でロードしてください。',
    error: 'モデルを取得できませんでした。エラーの内容を確認してください。',
  };

  return {
    status: messages[state.phase],
    active,
    canStart: !active && state.phase !== 'ready',
    canAbort: state.phase === 'downloading' || state.phase === 'verifying',
    canClear: !active && (state.cache.cached || state.phase === 'ready'),
    indeterminate: state.phase === 'verifying' || state.phase === 'cancelling',
    error: state.phase === 'error' ? state.error?.message ?? '' : '',
  };
}
