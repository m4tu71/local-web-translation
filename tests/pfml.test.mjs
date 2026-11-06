import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTranslationPrompt,
  DEFAULT_TRANSLATION_MAX_TOKENS,
  TRANSLATION_STOP_SEQUENCES,
} from '../src/inference/pfml.ts';

test('English-to-Japanese raw prompt matches the official PFML3 structure', () => {
  const prompt = buildTranslationPrompt({
    text: 'The meeting has been moved to next Monday.',
    sourceLanguage: 'en',
    targetLanguage: 'ja',
  });

  assert.equal(prompt,
    '<|plamo:tag|>dataset<|plamo:msg|>translation' +
    '<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en' +
    '<|plamo:msg|>The meeting has been moved to next Monday.' +
    '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>');
  assert(!prompt.includes('<|plamo:bos|>'));
  assert(!prompt.includes('<|plamo:eos|>'));
});

test('prompt preserves source whitespace and does not add chat framing or a translated body', () => {
  const source = '  一行目\n二行目\t';
  const prompt = buildTranslationPrompt({ text: source, targetLanguage: 'en' });

  assert(prompt.includes(`<|plamo:msg|>${source}<|plamo:tag|>output`));
  assert(prompt.endsWith('output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>'));
  assert(!prompt.includes('input<|plamo:key|>lang'));
  assert(!prompt.includes('assistant'));
});

test('protocol tokens cannot be injected through source text or language fields', () => {
  for (const token of ['<|plamo:bos|>', '<|plamo:tag|>', '<|plamo:eos|>', '<|plamo:msg|>']) {
    assert.throws(() => buildTranslationPrompt({ text: `source ${token}`, targetLanguage: 'en' }),
      { code: 'invalid-input' });
  }
  assert.throws(() => buildTranslationPrompt({ text: 'source', targetLanguage: 'en<|plamo:tag|>' }),
    { code: 'invalid-input' });
  assert.throws(() => buildTranslationPrompt({ text: 'source', targetLanguage: 'en', sourceLanguage: '' }),
    { code: 'invalid-input' });
});

test('translation stop policy is immutable and uses both documented terminators', () => {
  assert.deepEqual(TRANSLATION_STOP_SEQUENCES, ['<|plamo:tag|>', '<|plamo:bos|>']);
  assert(Object.isFrozen(TRANSLATION_STOP_SEQUENCES));
  assert.equal(DEFAULT_TRANSLATION_MAX_TOKENS, 512);
});
