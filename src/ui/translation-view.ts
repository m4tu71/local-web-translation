import type { TranslationSessionState } from '../poc/translation-session.ts';

export function describeTranslation(state: TranslationSessionState, text: string) {
  const busy = state.operation !== 'idle';
  const stopping = state.engine.phase === 'stopping';
  let status = '取得済みのモデルをロードしてください。';

  if (!state.hasModelFile && !state.engine.modelLoaded) {
    status = '先に「翻訳モデルの取得」でモデルを取得してください。';
  }
  if (state.engine.modelLoaded) {
    status = 'モデルをロードしました。日本語1文を英語へ翻訳できます。';
  }
  if (state.result) {
    status = state.result.text.trim()
      ? '翻訳処理が終了しました。英語の出力を確認してください。'
      : '出力が空でした。検証ログを確認してください。';
  }
  if (state.notice) {
    status = state.notice;
  }
  if (state.operation === 'loading') {
    status = 'モデルをロードしています。初回は時間がかかることがあります。';
  }
  if (state.operation === 'translating') {
    status = '日本語から英語へ翻訳しています。';
  }
  if (state.operation === 'unloading') {
    status = 'モデルのロードを解除しています。';
  }
  if (stopping) {
    status = '中止しています。処理の終了とリソース解放を待ちます。';
  }
  if (state.cancelling) {
    status = '中止しています。モデルの確認とリソース解放を待ちます。';
  }
  if (state.error) {
    status = '処理に失敗しました。エラーと検証ログを確認してください。';
  }

  return {
    status,
    busy,
    canLoad: !busy && state.hasModelFile && !state.engine.modelLoaded,
    canTranslate: !busy && state.engine.phase === 'ready' && Boolean(text.trim()),
    canAbort: !stopping && !state.cancelling && ['loading', 'translating'].includes(state.operation),
    canUnload: !busy && state.modelInUse,
    canChangeBackend: !busy && !state.modelInUse,
  };
}
