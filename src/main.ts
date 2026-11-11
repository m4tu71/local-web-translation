import './styles/main.css';
import { mountModelDownload } from './ui/model-download.ts';
import { mountTranslation } from './ui/translation.ts';
import { TranslationSession } from './poc/translation-session.ts';
import { OfflineClient } from './offline/client.ts';
import { mountOffline } from './ui/offline.ts';

const startupError = document.querySelector<HTMLParagraphElement>('#startup-error');

if (!startupError) {
  throw new Error('起動エラーの表示先が見つかりません。');
}

// No request starts until the user presses the download button.
const downloadUI = mountModelDownload();
export const modelDownloader = downloadUI.downloader;
const offlineClient = new OfflineClient();

// Subscribe through the application API; wllama stays lazy until model loading.
void import('./inference/index')
  .then(({ createInferenceEngine }) => {
    const session = new TranslationSession(modelDownloader, createInferenceEngine);
    mountTranslation(session, downloadUI);
    try {
      mountOffline(offlineClient, downloadUI.downloader, session);
    } catch (error) {
      const offlineStatus = document.querySelector<HTMLElement>('#offline-status');
      if (offlineStatus) offlineStatus.textContent = 'オフライン設定を表示できません。翻訳画面は引き続き利用できます。';
      console.error('Failed to configure offline controls', error);
    }
  })
  .catch((error: unknown) => {
    startupError.textContent = '翻訳エンジンを読み込めませんでした。ページを再読み込みしてください。';
    startupError.hidden = false;
    console.error('Failed to configure inference runtime', error);
  });
