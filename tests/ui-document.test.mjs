import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const HTML_URL = new URL('../index.html', import.meta.url);
const UI_FILES = [
  '../src/main.ts',
  '../src/ui/model-download.ts',
  '../src/ui/translation.ts',
  '../src/ui/offline.ts',
];

test('the document contains unique IDs for UI lookups and valid ARIA references', async () => {
  const html = await readFile(HTML_URL, 'utf8');
  const idValues = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const ids = new Set(idValues);
  assert.equal(ids.size, idValues.length, 'HTML IDs are unique');

  const uiSource = (await Promise.all(UI_FILES.map(path =>
    readFile(new URL(path, import.meta.url), 'utf8'),
  ))).join('\n');
  const requiredIds = new Set();
  for (const match of uiSource.matchAll(/(?:element(?:<[^>]+>)?|getElementById)\(['"]([^'"]+)['"]\)/g)) {
    requiredIds.add(match[1]);
  }
  for (const match of uiSource.matchAll(/querySelector(?:<[^>]+>)?\(['"]#([^'"]+)['"]\)/g)) {
    requiredIds.add(match[1]);
  }

  for (const id of requiredIds) assert.ok(ids.has(id), `UI lookup #${id} exists in index.html`);

  for (const match of html.matchAll(/\baria-(?:describedby|labelledby|controls)="([^"]+)"/g)) {
    for (const id of match[1].split(/\s+/)) assert.ok(ids.has(id), `ARIA reference #${id} exists`);
  }
});
