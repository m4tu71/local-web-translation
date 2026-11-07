import './styles/main.css';
import { mountModelDownload } from './ui/model-download.ts';
import { mountTranslation } from './ui/translation.ts';
import { TranslationSession } from './poc/translation-session.ts';

const startupError = document.querySelector<HTMLParagraphElement>('#startup-error');

if (!startupError) {
  throw new Error('起動エラーの表示先が見つかりません。');
}

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
    startupError.textContent = '翻訳エンジンを読み込めませんでした。ページを再読み込みしてください。';
    startupError.hidden = false;
    console.error('Failed to configure inference runtime', error);
  });
