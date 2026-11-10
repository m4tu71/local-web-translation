import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTranslationText } from '../src/translation/chunks.ts';

const utf8Length = text => new TextEncoder().encode(text).length;
const sourceFrom = chunks => chunks.map(chunk => chunk.text + chunk.separator).join('');

test('splits within a conservative token budget and preserves source separators', async () => {
  const source = '  First sentence.\n\nSecond paragraph has more words.\t最後の文。  ';
  const maxInputTokens = 28;
  const chunks = await splitTranslationText(source, maxInputTokens, async text => utf8Length(text));

  assert(chunks.length > 1);
  assert.equal(sourceFrom(chunks), source);
  for (const chunk of chunks) {
    assert(chunk.text.length > 0);
    assert(utf8Length(chunk.text) <= maxInputTokens);
  }
});

test('prefers paragraph, then sentence, then whitespace boundaries', async () => {
  const paragraphText = 'First paragraph.\n\nSecond paragraph.';
  const paragraphChunks = await splitTranslationText(
    paragraphText,
    24,
    async text => text.length,
  );
  assert.equal(paragraphChunks[0].separator, '\n\n');

  const sentenceChunks = await splitTranslationText(
    'First sentence. Second sentence.',
    20,
    async text => text.length,
  );
  assert.equal(sentenceChunks[0].text, 'First sentence.');
  assert.equal(sentenceChunks[0].separator, '');

  const wordChunks = await splitTranslationText('one two three four', 8, async text => text.length);
  assert.equal(wordChunks[0].separator, ' ');

  const japaneseSentenceChunks = await splitTranslationText(
    '最初の文。次の文？最後の文！',
    8,
    async text => text.length,
  );
  assert.equal(japaneseSentenceChunks[0].text, '最初の文。');
});

test('never divides a surrogate pair at a forced Unicode boundary', async () => {
  const source = 'A😀B😃C';
  const chunks = await splitTranslationText(source, 5, async text => utf8Length(text));

  assert.equal(sourceFrom(chunks), source);
  for (const chunk of chunks) {
    assert(!/^[\uDC00-\uDFFF]/u.test(chunk.text));
    assert(!/[\uD800-\uDBFF]$/u.test(chunk.text));
    assert(!/^[\uDC00-\uDFFF]/u.test(chunk.separator));
    assert(!/[\uD800-\uDBFF]$/u.test(chunk.separator));
  }
});

test('reports when even one Unicode code point exceeds the available budget', async () => {
  await assert.rejects(
    splitTranslationText('😀', 3, async text => utf8Length(text)),
    /single Unicode character exceeds/,
  );
});

test('preserves long leading and trailing whitespace as source chunks', async () => {
  const source = `${' '.repeat(12)}hello${'\n'.repeat(10)}`;
  const chunks = await splitTranslationText(source, 4, async text => text.length);

  assert.equal(sourceFrom(chunks), source);
  assert(chunks.some(chunk => !chunk.text.trim()));
  assert(chunks.every(chunk => chunk.text.length > 0));
});
