import { InferenceError, type TranslationRequest } from './types.ts';

export function buildTranslationPrompt(request: TranslationRequest): string {
  const isEmpty = typeof request.text !== 'string' || !request.text.trim();
  if (isEmpty) {
    throw new InferenceError('invalid-input', '翻訳するテキストを入力してください。');
  }

  if (request.text.includes('<|plamo:')) {
    throw new InferenceError('invalid-input', '入力に予約済み PFML トークンを含めることはできません。');
  }

  const supportedLanguages = ['ja', 'en'];
  const validTarget = supportedLanguages.includes(request.targetLanguage);
  const validSource = request.sourceLanguage === undefined ||
    supportedLanguages.includes(request.sourceLanguage);

  if (!validTarget || !validSource) {
    throw new InferenceError('invalid-input', 'この PoC の対応言語は ja と en です。');
  }

  let sourceLanguageAttribute = '';
  if (request.sourceLanguage !== undefined) {
    sourceLanguageAttribute = `<|plamo:key|>lang<|plamo:val|>${request.sourceLanguage}`;
  }

  // llama.cpp adds BOS according to the GGUF metadata. Do not duplicate it here.
  return [
    '<|plamo:tag|>dataset<|plamo:msg|>translation',
    `<|plamo:tag|>input${sourceLanguageAttribute}<|plamo:msg|>${request.text}`,
    `<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>${request.targetLanguage}<|plamo:msg|>`,
  ].join('');
}
