import './styles/main.css';

const startupStatus = document.querySelector<HTMLParagraphElement>('#startup-status');

if (!startupStatus) {
  throw new Error('起動状態の表示先が見つかりません。');
}

startupStatus.textContent = '開発環境の起動を確認しました。';

// Load engine code separately from the page; do not start inference or fetch a model.
void import('./inference/wllama-runtime')
  .then(({ configureInferenceRuntime }) => configureInferenceRuntime())
  .catch((error: unknown) => {
    startupStatus.textContent = '推論エンジンの設定を読み込めませんでした。';
    console.error('Failed to configure inference runtime', error);
  });
