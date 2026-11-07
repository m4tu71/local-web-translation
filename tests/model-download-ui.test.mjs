import test from 'node:test';
import assert from 'node:assert/strict';
import { mountModelDownload } from '../src/ui/model-download.ts';
import { createFakeDocument, flushTasks, withFakeDom } from './helpers/fake-dom.mjs';

const MODEL_IDS = [
  'model-download', 'model-cancel', 'model-clear', 'model-clear-confirmation', 'model-clear-confirm',
  'model-clear-cancel', 'model-progress', 'model-progress-region', 'model-progress-text', 'model-status',
  'model-error', 'model-cache-status', 'model-storage-note', 'model-storage-mode', 'model-retention',
  'model-logs', 'model-name', 'model-source',
];

function createDownloader({ failClear = false } = {}) {
  const listeners = new Set();
  const model = {
    name: 'PLaMo 3 Translate 0.8B · Q4_K_M',
    repository: 'pfnet/plamo-3-translate-0.8b-GGUF',
    revision: 'revision',
    bytes: 573_123_200,
  };
  let state = {
    phase: 'ready',
    loadedBytes: model.bytes,
    totalBytes: model.bytes,
    storageMode: 'opfs',
    cache: { available: true, cached: true, bytes: model.bytes, retentionDays: 7 },
  };
  const publish = patch => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener(state);
  };
  return {
    model,
    getState: () => state,
    getModel: () => undefined,
    acquireModel: async () => { throw new Error('not used'); },
    markUsed: async () => {},
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    initialize: async () => state.cache,
    download: async () => {},
    abort: async () => {},
    clear: () => {
      if (failClear) return Promise.reject(new Error('保存データを削除できませんでした。'));
      publish({ phase: 'clearing' });
      return Promise.resolve().then(() => publish({
        phase: 'idle',
        loadedBytes: 0,
        cache: { available: true, cached: false, bytes: 0, retentionDays: state.cache.retentionDays },
      }));
    },
    setStorageMode: mode => publish({ storageMode: mode, phase: 'idle' }),
    setRetentionDays: async days => publish({ cache: { ...state.cache, retentionDays: days } }),
    setModelInUse() {},
    hasMemoryModel: () => false,
  };
}

test('inline model deletion focuses the safe return action, then the next valid action', async () => {
  const document = createFakeDocument(MODEL_IDS);
  const downloader = createDownloader();

  await withFakeDom(document, async () => {
    mountModelDownload(downloader);
    document.getElementById('model-clear').dispatch('click');
    assert.equal(document.getElementById('model-clear-confirmation').hidden, false);
    assert.match(document.getElementById('model-clear-confirmation-text').textContent, /ブラウザー内の保存モデル/);
    assert.equal(document.activeElement, document.getElementById('model-clear-cancel'));
    assert.equal(document.getElementById('model-clear').getAttribute('aria-expanded'), 'true');

    document.getElementById('model-clear-confirm').dispatch('click');
    await flushTasks();
    assert.equal(document.getElementById('model-clear-confirmation').hidden, true);
    assert.equal(document.getElementById('model-clear').getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, document.getElementById('model-download'));
  });
});

test('failed model deletion leaves the error visible and moves focus to it', async () => {
  const document = createFakeDocument(MODEL_IDS);
  const downloader = createDownloader({ failClear: true });

  await withFakeDom(document, async () => {
    mountModelDownload(downloader);
    document.getElementById('model-clear').dispatch('click');
    document.getElementById('model-clear-confirm').dispatch('click');
    await flushTasks();
    assert.equal(document.getElementById('model-error').hidden, false);
    assert.match(document.getElementById('model-error').textContent, /削除できませんでした/);
    assert.equal(document.activeElement, document.getElementById('model-error'));
  });
});
