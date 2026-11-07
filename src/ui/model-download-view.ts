import type { ModelDownloadState } from '../models/model-download.ts';

const ACTIVE_PHASES = new Set([
  'checking',
  'downloading',
  'verifying',
  'cancelling',
  'clearing',
  'updating-retention',
]);

export function describeModelDownload(state: ModelDownloadState) {
  const active = ACTIVE_PHASES.has(state.phase);
  const messages = {
    idle: 'モデルはまだ保存されていません。取得するにはボタンを押してください。',
    checking: 'ブラウザー内のモデル保存状態を確認しています。',
    downloading: 'モデルを取得しています。受信には時間がかかる場合があります。',
    verifying: '取得したモデルの整合性を確認しています。',
    cancelling: '取得を中止しています。途中データを整理しています。',
    clearing: '保存モデルを削除しています。',
    'updating-retention': 'モデルの保持期間を更新しています。',
    cancelled: '取得を中止しました。再取得すると最初から始まります。',
    ready: 'モデルを取得しました。翻訳するにはロードしてください。',
    error: 'モデルを取得できませんでした。内容を確認して再試行してください。',
  };

  return {
    status: messages[state.phase],
    active,
    showProgress: ['downloading', 'verifying', 'cancelling'].includes(state.phase),
    canStart: !active && state.phase !== 'ready',
    canAbort: state.phase === 'downloading' || state.phase === 'verifying',
    canClear: !active && (state.cache.cached || state.phase === 'ready'),
    indeterminate: ['checking', 'verifying', 'cancelling'].includes(state.phase),
    error: state.phase === 'error' ? state.error?.message ?? 'モデルを準備できませんでした。' : '',
  };
}
