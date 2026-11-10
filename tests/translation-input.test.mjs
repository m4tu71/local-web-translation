import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_INPUT_CHARACTERS,
  validateTranslationInput,
} from '../src/translation/input.ts';

const JA_TO_EN = Object.freeze({ sourceLanguage: 'ja', targetLanguage: 'en' });

test('accepts exactly 10,000 UTF-16 code units', () => {
  validateTranslationInput('a'.repeat(MAX_INPUT_CHARACTERS), JA_TO_EN);
  assert.throws(
    () => validateTranslationInput('a'.repeat(MAX_INPUT_CHARACTERS + 1), JA_TO_EN),
    { code: 'invalid-input', message: /10000文字以内/ },
  );
});

test('counts astral characters as two UTF-16 code units', () => {
  validateTranslationInput('😀'.repeat(MAX_INPUT_CHARACTERS / 2), JA_TO_EN);
  assert.throws(
    () => validateTranslationInput('😀'.repeat(MAX_INPUT_CHARACTERS / 2) + 'a', JA_TO_EN),
    { code: 'invalid-input', message: /10000文字以内/ },
  );
});

test('rejects blank source text and reserved PFML markers', () => {
  assert.throws(() => validateTranslationInput(' \n\t ', JA_TO_EN), {
    code: 'invalid-input',
    message: /テキストを入力/,
  });
  assert.throws(() => validateTranslationInput('source <|plamo:tag|>', JA_TO_EN), {
    code: 'invalid-input',
    message: /モデル用の特殊な文字列/,
  });
});

test('accepts either supported direction and rejects unsupported or identical languages', () => {
  validateTranslationInput('Hello', { sourceLanguage: 'en', targetLanguage: 'ja' });
  assert.throws(
    () => validateTranslationInput('Hello', { sourceLanguage: 'ja', targetLanguage: 'ja' }),
    { code: 'invalid-input', message: /異なる言語/ },
  );
  assert.throws(
    () => validateTranslationInput('Hello', { sourceLanguage: 'fr', targetLanguage: 'ja' }),
    { code: 'invalid-input', message: /日本語と英語/ },
  );
});
