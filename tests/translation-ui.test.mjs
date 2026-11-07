import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTranslation } from '../src/ui/translation.ts';
import {
  AsyncFeedbackGuard,
  DEFAULT_DIRECTION,
  InputUndoHistory,
  changeSourceLanguage,
  changeTargetLanguage,
  swapDirection,
} from '../src/ui/translation-workspace.ts';
import { createFakeDocument, deferred, flushTasks, withFakeDom } from './helpers/fake-dom.mjs';

const TRANSLATION_IDS = [
  'translation-form', 'source-language', 'target-language', 'swap-languages', 'translation-input',
  'input-count', 'input-message', 'example-hint', 'insert-example', 'clear-input', 'undo-clear', 'translate-button',
  'translate-hint', 'translation-output', 'copy-result', 'copy-status', 'result-warning', 'result-timing',
  'translation-status', 'translation-error', 'translation-error-text', 'show-logs', 'preparation-status',
  'preparation-hint', 'preparation-action', 'preparation-abort', 'runtime-backend', 'model-settings',
  'model-download', 'model-load', 'model-unload', 'diagnostics', 'translation-logs', 'model-logs',
];

function modelState(overrides = {}) {
  return {
    phase: 'ready',
    loadedBytes: 573_123_200,
    totalBytes: 573_123_200,
    storageMode: 'opfs',
    cache: {
      available: true,
      cached: true,
      bytes: 573_123_200,
      retentionDays: 7,
    },
    ...overrides,
  };
}

function sessionState(overrides = {}) {
  return {
    operation: 'idle',
    cancelling: false,
    engine: { phase: 'ready', modelLoaded: true },
    hasModelFile: true,
    modelInUse: true,
    requestedBackend: 'auto',
    result: undefined,
    notice: undefined,
    error: undefined,
    logs: [],
    ...overrides,
  };
}

function createSession(initialState = sessionState()) {
  let state = initialState;
  const listeners = new Set();
  const calls = { loads: [], translations: [], unloads: 0, aborts: 0, clears: 0 };
  const notify = () => {
    for (const listener of [...listeners]) listener(state);
  };
  const update = patch => {
    state = { ...state, ...patch };
    notify();
  };
  return {
    calls,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    clearResult() {
      if (state.operation !== 'idle') return;
      calls.clears++;
      update({ result: undefined, notice: undefined, error: undefined });
    },
    load(backend) {
      calls.loads.push(backend);
      update({
        operation: 'idle',
        modelInUse: true,
        requestedBackend: backend,
        engine: { phase: 'ready', modelLoaded: true },
        error: undefined,
      });
      return Promise.resolve();
    },
    unload() {
      calls.unloads++;
      update({
        operation: 'idle',
        modelInUse: false,
        engine: { phase: 'idle', modelLoaded: false },
        notice: 'ロードを解除しました。',
      });
      return Promise.resolve();
    },
    abort() {
      calls.aborts++;
      update({
        operation: 'idle',
        cancelling: false,
        modelInUse: false,
        engine: { phase: 'idle', modelLoaded: false },
        notice: '操作を中止しました。',
      });
      return Promise.resolve();
    },
    translate(text, direction) {
      calls.translations.push({ text, direction: { ...direction } });
      update({ operation: 'translating', result: undefined, notice: undefined, error: undefined });
      update({
        operation: 'idle',
        result: {
          text: '翻訳結果',
          truncated: false,
          elapsedMs: 18,
          direction: Object.freeze({ ...direction }),
        },
      });
      return Promise.resolve();
    },
    setState: update,
  };
}

function createDownloadUI(initialState = modelState()) {
  let state = initialState;
  const listeners = new Set();
  const downloader = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    abort() { return Promise.resolve(); },
  };
  return {
    downloader,
    setModelInUse() {},
    setState(nextState) {
      state = nextState;
      for (const listener of [...listeners]) listener(state);
    },
  };
}

test('language selectors always preserve opposite directions and swap only the languages', () => {
  assert.deepEqual(DEFAULT_DIRECTION, { sourceLanguage: 'ja', targetLanguage: 'en' });
  assert.deepEqual(changeSourceLanguage(DEFAULT_DIRECTION, 'en'), { sourceLanguage: 'en', targetLanguage: 'ja' });
  assert.deepEqual(changeTargetLanguage(DEFAULT_DIRECTION, 'ja'), { sourceLanguage: 'en', targetLanguage: 'ja' });
  assert.deepEqual(swapDirection(DEFAULT_DIRECTION), { sourceLanguage: 'en', targetLanguage: 'ja' });
});

test('input undo is available only while the field remains empty', () => {
  const history = new InputUndoHistory();
  assert.equal(history.clear('Hello'), true);
  assert.equal(history.canUndo(''), true);
  assert.equal(history.undo('new input'), undefined);

  history.clear('Hello');
  assert.equal(history.undo(''), 'Hello');
  assert.equal(history.canUndo(''), false);

  history.clear('Hello');
  history.recordEdit('New text');
  assert.equal(history.undo(''), undefined);
});

test('clipboard feedback guard invalidates a pending result after workspace changes', () => {
  const guard = new AsyncFeedbackGuard();
  const oldRequest = guard.begin();
  assert.equal(guard.isCurrent(oldRequest), true);
  guard.invalidate();
  assert.equal(guard.isCurrent(oldRequest), false);
});

test('mounting does not load or translate; the visible preparation action starts a requested load', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const session = createSession(sessionState({ engine: { phase: 'idle', modelLoaded: false }, modelInUse: false }));
  const downloadUI = createDownloadUI();

  await withFakeDom(document, async () => {
    mountTranslation(session, downloadUI);
    assert.deepEqual(session.calls.loads, []);
    assert.deepEqual(session.calls.translations, []);
    assert.equal(document.getElementById('preparation-action').textContent, '翻訳の準備');

    document.getElementById('preparation-action').dispatch('click');
    assert.deepEqual(session.calls.loads, ['auto']);
    assert.equal(document.activeElement, document.getElementById('preparation-status'));
  });
});

test('cancelling a load moves focus before the cancel action disappears', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const session = createSession(sessionState({
    operation: 'loading',
    engine: { phase: 'loading', modelLoaded: false },
  }));
  const downloadUI = createDownloadUI();

  await withFakeDom(document, async () => {
    mountTranslation(session, downloadUI);
    const abort = document.getElementById('preparation-abort');
    assert.equal(abort.hidden, false);
    abort.dispatch('click');
    assert.equal(abort.hidden, true);
    assert.equal(document.activeElement, document.getElementById('preparation-status'));
  });
});

test('English-to-Japanese selection reaches the session and direction changes clear prior output', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const initialResult = {
    text: 'Old output',
    truncated: false,
    elapsedMs: 4,
    direction: { sourceLanguage: 'ja', targetLanguage: 'en' },
  };
  const session = createSession(sessionState({ result: initialResult }));
  const downloadUI = createDownloadUI();

  await withFakeDom(document, async () => {
    mountTranslation(session, downloadUI);
    const input = document.getElementById('translation-input');
    const source = document.getElementById('source-language');
    const target = document.getElementById('target-language');
    input.value = 'Good morning';
    input.dispatch('input');
    assert.equal(document.getElementById('translation-output').textContent, '翻訳結果はここに表示されます。');

    source.value = 'en';
    source.dispatch('change');
    assert.equal(target.value, 'ja');
    assert.equal(input.value, 'Good morning');

    document.getElementById('translation-form').dispatch('submit');
    assert.deepEqual(session.calls.translations, [{
      text: 'Good morning',
      direction: { sourceLanguage: 'en', targetLanguage: 'ja' },
    }]);
    assert.equal(document.getElementById('translation-output').textContent, '翻訳結果');
    assert.equal(document.getElementById('copy-result').disabled, false);

    document.getElementById('swap-languages').dispatch('click');
    assert.equal(source.value, 'ja');
    assert.equal(target.value, 'en');
    assert.equal(input.value, 'Good morning');
    assert.equal(document.getElementById('translation-output').textContent, '翻訳結果はここに表示されます。');
    assert.equal(document.getElementById('copy-result').disabled, true);
  });
});

test('IME Enter does not translate; Ctrl/Cmd+Enter uses the same translation path', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const session = createSession();
  const downloadUI = createDownloadUI();

  await withFakeDom(document, async () => {
    mountTranslation(session, downloadUI);
    const input = document.getElementById('translation-input');
    input.value = 'こんにちは';
    input.dispatch('input');

    const imeEvent = input.dispatch('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
    assert.equal(imeEvent.defaultPrevented, false);
    input.dispatch('keydown', { key: 'Enter', ctrlKey: true, keyCode: 229 });
    assert.equal(session.calls.translations.length, 0);

    const shortcutEvent = input.dispatch('keydown', { key: 'Enter', metaKey: true, isComposing: false });
    assert.equal(shortcutEvent.defaultPrevented, true);
    assert.equal(session.calls.translations.length, 1);
  });
});

test('disabled translation explains reserved input and keeps a ready model loaded', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const session = createSession();
  const downloadUI = createDownloadUI();

  await withFakeDom(document, async () => {
    mountTranslation(session, downloadUI);
    const input = document.getElementById('translation-input');
    input.value = '<|plamo:tag|>';
    input.dispatch('input');

    assert.equal(document.getElementById('translate-button').disabled, true);
    assert.match(document.getElementById('translate-hint').textContent, /特殊な文字列/);
    assert.equal(session.getState().engine.modelLoaded, true);
    assert.equal(document.getElementById('preparation-action').hidden, true);
  });
});

test('CPU selection survives unrelated renders and is used when the user prepares the model', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const session = createSession(sessionState({ engine: { phase: 'idle', modelLoaded: false }, modelInUse: false }));
  const downloadUI = createDownloadUI();

  await withFakeDom(document, async () => {
    mountTranslation(session, downloadUI);
    const backend = document.getElementById('runtime-backend');
    backend.value = 'cpu';
    const input = document.getElementById('translation-input');
    input.value = 'Hello';
    input.dispatch('input');
    assert.equal(backend.value, 'cpu');

    document.getElementById('model-load').dispatch('click');
    assert.deepEqual(session.calls.loads, ['cpu']);
  });
});

test('copied output shows clipboard errors and ignores completion from a stale result', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const session = createSession(sessionState({
    result: { text: 'Current result', truncated: false, elapsedMs: 2, direction: DEFAULT_DIRECTION },
  }));
  const downloadUI = createDownloadUI();
  const clipboardRequest = deferred();
  const clipboard = { writeText: () => clipboardRequest.promise };

  await withFakeDom(document, async () => {
    mountTranslation(session, downloadUI);
    document.getElementById('copy-result').dispatch('click');
    assert.equal(document.getElementById('copy-status').textContent, 'コピーしています…');

    const input = document.getElementById('translation-input');
    input.value = 'Changed input';
    input.dispatch('input');
    clipboardRequest.reject(new Error('clipboard unavailable'));
    await flushTasks();
    assert.equal(document.getElementById('copy-status').textContent, '');
    assert.equal(document.getElementById('copy-result').disabled, true);

    session.setState({
      result: { text: 'Second result', truncated: false, elapsedMs: 2, direction: DEFAULT_DIRECTION },
    });
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('permission denied'); } },
    });
    document.getElementById('copy-result').dispatch('click');
    await flushTasks();
    assert.match(document.getElementById('copy-status').textContent, /結果を選択してコピー/);
    assert.equal(document.getElementById('translation-output').textContent, 'Second result');
  }, { clipboard });
});

test('clearing input offers an undo until new text is entered', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const session = createSession();
  const downloadUI = createDownloadUI();

  await withFakeDom(document, async () => {
    mountTranslation(session, downloadUI);
    const input = document.getElementById('translation-input');
    const undo = document.getElementById('undo-clear');
    input.value = 'Keep this text';
    input.dispatch('input');
    document.getElementById('clear-input').dispatch('click');
    assert.equal(input.value, '');
    assert.equal(undo.hidden, false);

    undo.dispatch('click');
    assert.equal(input.value, 'Keep this text');
    assert.equal(undo.hidden, true);

    document.getElementById('clear-input').dispatch('click');
    input.value = 'A new draft';
    input.dispatch('input');
    assert.equal(undo.hidden, true);
  });
});

test('an unloaded model keeps the completed output visible and offers preparation', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const session = createSession(sessionState({
    engine: { phase: 'idle', modelLoaded: false },
    modelInUse: false,
    result: { text: 'Saved result', truncated: false, elapsedMs: 15, direction: DEFAULT_DIRECTION },
    notice: 'ロードを解除しました。',
  }));
  const downloadUI = createDownloadUI();

  await withFakeDom(document, async () => {
    mountTranslation(session, downloadUI);
    assert.equal(document.getElementById('translation-output').textContent, 'Saved result');
    assert.match(document.getElementById('preparation-status').textContent, /保存済み/);
    assert.equal(document.getElementById('preparation-action').textContent, '翻訳の準備');
    assert.match(document.getElementById('translation-status').textContent, /完了/);
  });
});
