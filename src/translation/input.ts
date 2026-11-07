import { InferenceError } from '../inference/types.ts';

export type Language = 'ja' | 'en';

export interface TranslationDirection {
  readonly sourceLanguage: Language;
  readonly targetLanguage: Language;
}

export const MAX_INPUT_CHARACTERS = 500;

const SUPPORTED_LANGUAGES: readonly Language[] = Object.freeze(['ja', 'en']);

/** Validates translation input before any model generation is started. */
export function validateTranslationInput(
  text: string,
  direction: TranslationDirection,
): void {
  if (typeof text !== 'string') {
    throw new InferenceError('invalid-input', '翻訳するテキストを入力してください。');
  }

  if (!text.trim()) {
    throw new InferenceError('invalid-input', '翻訳するテキストを入力してください。');
  }

  // String.length counts UTF-16 code units, which matches the textarea maxlength limit.
  if (text.length > MAX_INPUT_CHARACTERS) {
    throw new InferenceError(
      'invalid-input',
      `入力は${MAX_INPUT_CHARACTERS}文字以内で入力してください。`,
    );
  }

  if (text.includes('<|plamo:')) {
    throw new InferenceError(
      'invalid-input',
      '入力にモデル用の特殊な文字列が含まれています。該当箇所を削除してください。',
    );
  }

  if (typeof direction !== 'object' || direction === null) {
    throw new InferenceError('invalid-input', '翻訳元・翻訳先は日本語と英語のみ対応しています。');
  }

  if (!isSupportedLanguage(direction.sourceLanguage) ||
      !isSupportedLanguage(direction.targetLanguage)) {
    throw new InferenceError('invalid-input', '翻訳元・翻訳先は日本語と英語のみ対応しています。');
  }

  if (direction.sourceLanguage === direction.targetLanguage) {
    throw new InferenceError('invalid-input', '翻訳元と翻訳先に異なる言語を選択してください。');
  }
}

function isSupportedLanguage(language: unknown): language is Language {
  return SUPPORTED_LANGUAGES.includes(language as Language);
}
