import './styles/main.css';
import { mountModelDownload } from './ui/model-download.ts';
import { mountTranslation } from './ui/translation.ts';
import { TranslationSession } from './poc/translation-session.ts';

const startupStatus = document.querySelector<HTMLParagraphElement>('#startup-status');

if (!startupStatus) {
  throw new Error('起動状態の表示先が見つかりません。');
}

startupStatus.textContent = '開発環境の起動を確認しました。';

// No request starts until the user presses the download button.
const downloadUI = mountModelDownload();
export const modelDownloader = downloadUI.downloader;

// Subscribe through the application API; wllama stays lazy until model loading.
void import('./inference/index')
  .then(({ createInferenceEngine }) => {
    const session = new TranslationSession(modelDownloader, createInferenceEngine);
    mountTranslation(session, downloadUI);
  })
  .catch((error: unknown) => {
    startupStatus.textContent = '推論エンジンの設定を読み込めませんでした。';
    console.error('Failed to configure inference runtime', error);
  });
