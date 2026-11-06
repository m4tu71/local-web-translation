import './styles/main.css';

const startupStatus = document.querySelector<HTMLParagraphElement>('#startup-status');

if (!startupStatus) {
  throw new Error('起動状態の表示先が見つかりません。');
}

startupStatus.textContent = '開発環境の起動を確認しました。';

// Subscribe through the application API; wllama stays lazy until model loading.
void import('./inference/index')
  .then(({ inferenceEngine }) => {
    inferenceEngine.subscribe(state => {
      if (state.phase === 'error') {
        startupStatus.textContent = state.error?.message ?? '推論エンジンでエラーが発生しました。';
      }
    });
  })
  .catch((error: unknown) => {
    startupStatus.textContent = '推論エンジンの設定を読み込めませんでした。';
    console.error('Failed to configure inference runtime', error);
  });
