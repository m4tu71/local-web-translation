import test from 'node:test';
import assert from 'node:assert/strict';
import { InferenceController } from '../src/inference/engine.ts';
import { TranslationSession } from '../src/poc/translation-session.ts';
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
  'resume-translation', 'resume-hint', 'runtime-summary', 'requested-backend-detail',
  'runtime-backend-detail', 'runtime-webgpu-api', 'runtime-context-row', 'runtime-context-detail',
  'runtime-gpu-layers-row', 'runtime-gpu-layers-detail',
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
  const calls = { loads: [], translations: [], unloads: 0, aborts: 0, clears: 0, resumes: 0 };
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
    resumeTranslation() {
      calls.resumes++;
      update({
        operation: 'translating',
        translationProgress: { phase: 'translating', completed: 0, total: 2 },
        result: { ...state.result, status: 'streaming', text: 'Retried output' },
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

async function waitFor(condition, description, attempts = 1500) {
  for (let index = 0; index < attempts; index++) {
    if (condition()) return;
    await flushTasks();
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

test('language selectors always preserve opposite directions and swap only the languages', () => {
  assert.deepEqual(DEFAULT_DIRECTION, { sourceLanguage: 'ja', targetLanguage: 'en' });
  assert.deepEqual(changeSourceLanguage(DEFAULT_DIRECTION, 'en'), { sourceLanguage: 'en', targetLanguage: 'ja' });
  assert.deepEqual(changeTargetLanguage(DEFAULT_DIRECTION, 'ja'), { sourceLanguage: 'en', targetLanguage: 'ja' });
  assert.deepEqual(swapDirection(DEFAULT_DIRECTION), { sourceLanguage: 'en', targetLanguage: 'ja' });
});

test('streaming output appends without replacing the result node and keeps copying disabled', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const session = createSession(sessionState({
    operation: 'translating',
    translationProgress: { phase: 'translating', completed: 0, total: 1 },
    result: {
      text: 'Hello', status: 'streaming', partialReason: undefined, canResume: false,
      truncated: false, elapsedMs: 1, direction: DEFAULT_DIRECTION,
    },
  }));

  await withFakeDom(document, async () => {
    mountTranslation(session, createDownloadUI());
    const output = document.getElementById('translation-output');
    const replacements = output.replaceChildrenCount;
    assert.equal(output.textContent, 'Hello');
    assert.equal(document.getElementById('copy-result').disabled, true);

    session.setState({ result: { ...session.getState().result, text: 'Hello world' } });

    assert.equal(output.textContent, 'Hello world');
    assert.equal(output.replaceChildrenCount, replacements);
    assert.equal(document.getElementById('translation-status').textContent, '翻訳中 1 / 1');
    assert.equal(document.getElementById('copy-result').disabled, true);
  });
});

test('partial results can be copied and resumed after releasing and preparing the model', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const session = createSession(sessionState({
    engine: { phase: 'idle', modelLoaded: false },
    modelInUse: true,
    result: {
      text: 'Partial text', status: 'partial', partialReason: 'cancelled', canResume: true,
      truncated: false, completedChunks: 1, totalChunks: 2, elapsedMs: 22, direction: DEFAULT_DIRECTION,
    },
  }));
  const downloadUI = createDownloadUI();

  await withFakeDom(document, async () => {
    mountTranslation(session, downloadUI);
    const copy = document.getElementById('copy-result');
    const resume = document.getElementById('resume-translation');
    assert.equal(copy.disabled, false);
    assert.equal(copy.textContent, '部分結果をコピー');
    assert.equal(resume.hidden, false);
    assert.equal(resume.disabled, true);
    assert.equal(document.getElementById('preparation-action').textContent, 'リソースを解放');

    document.getElementById('preparation-action').dispatch('click');
    assert.equal(document.getElementById('preparation-action').textContent, 'モデルをロード');
    document.getElementById('preparation-action').dispatch('click');
    assert.equal(resume.disabled, false);

    resume.dispatch('click');
    assert.equal(session.calls.resumes, 1);
    assert.equal(document.activeElement, document.getElementById('translation-status'));
    assert.equal(resume.hidden, true);
    assert.equal(copy.disabled, true);
  });
});

test('runtime environment is only claimed when engine state identifies it', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const session = createSession(sessionState({
    engine: {
      phase: 'ready', modelLoaded: true,
      runtimeInfo: {
        backend: 'unknown', contextSize: 2048, requestedContextSize: 2048,
        source: 'logger-unavailable', webGpuApiAvailable: true,
      },
    },
  }));

  await withFakeDom(document, async () => {
    mountTranslation(session, createDownloadUI());
    assert.equal(document.getElementById('runtime-summary').textContent, '実際の実行環境: 確認できません');
    assert.equal(document.getElementById('runtime-backend-detail').textContent, '確認できません');
    assert.equal(document.getElementById('runtime-webgpu-api').textContent, 'あり');
    assert.equal(document.getElementById('runtime-context-detail').textContent, '2048 トークン（要求値）');
    assert.equal(document.getElementById('runtime-gpu-layers-row').hidden, true);
  });
});

test('runtime details show confirmed CPU information and explicit engine context data', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const session = createSession(sessionState({
    engine: {
      phase: 'ready', modelLoaded: true,
      runtimeInfo: {
        backend: 'cpu', contextSize: 2048, requestedContextSize: 2048,
        actualContextSize: 2048, gpuLayers: 0, source: 'cpu-mode',
      },
    },
    requestedBackend: 'cpu',
  }));
  document.getElementById('runtime-backend').value = 'cpu';

  await withFakeDom(document, async () => {
    mountTranslation(session, createDownloadUI());
    assert.equal(document.getElementById('runtime-summary').textContent, '実際の実行環境: CPU（WASM）');
    assert.equal(document.getElementById('requested-backend-detail').textContent, 'CPU（WASM）');
    assert.equal(document.getElementById('runtime-backend-detail').textContent, 'CPU（WASM）');
    assert.equal(document.getElementById('runtime-context-detail').textContent, '2048 トークン（エンジン報告値）');
    assert.equal(document.getElementById('runtime-gpu-layers-row').hidden, false);
    assert.equal(document.getElementById('runtime-gpu-layers-detail').textContent, '0 層');
  });
});

test('long input accepts up to 10,000 UTF-16 code units and rejects more', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const session = createSession();

  await withFakeDom(document, async () => {
    mountTranslation(session, createDownloadUI());
    const input = document.getElementById('translation-input');
    const translate = document.getElementById('translate-button');

    input.value = 'a'.repeat(10_000);
    input.dispatch('input');
    assert.equal(document.getElementById('input-count').textContent, '10000 / 10000');
    assert.equal(translate.disabled, false);

    input.value += 'a';
    input.dispatch('input');
    assert.equal(document.getElementById('input-count').textContent, '10001 / 10000');
    assert.equal(translate.disabled, true);
  });
});

test('real session and controller stream, cancel, reload, then resume only unfinished chunks', async () => {
  const document = createFakeDocument(TRANSLATION_IDS);
  const model = new Blob(['model fixture; not a real GGUF']);
  const calls = { completions: [], runtimes: [], abortObserved: deferred() };
  let runtimeCall = 0;
  const modelSource = {
    getModel: () => model,
    subscribe: () => () => {},
  };
  const createRuntime = async () => {
    const runtime = {
      async load() {},
      getInputTokenUpperBound(prompt) {
        return new TextEncoder().encode(prompt).byteLength + 1;
      },
      getRuntimeInfo() {
        return {
          backend: 'cpu', contextSize: 2048, requestedContextSize: 2048,
          gpuLayers: 0, source: 'integration-test',
        };
      },
      async complete(prompt, options) {
        const call = { prompt, runtime, options };
        calls.completions.push(call);
        const callIndex = runtimeCall++;
        if (callIndex === 0) {
          options.onText('First translated.');
          return { text: 'First translated.', finishReason: 'stop' };
        }
        if (callIndex === 1) {
          options.onText('Interrupted portion');
          return new Promise((_resolve, reject) => {
            const cancel = () => {
              calls.abortObserved.resolve();
              reject(new Error('runtime aborted'));
            };
            if (options.signal.aborted) cancel();
            else options.signal.addEventListener('abort', cancel, { once: true });
          });
        }
        options.onText('Resumed translation.');
        return { text: 'Resumed translation.', finishReason: 'stop' };
      },
      async dispose() {},
    };
    calls.runtimes.push(runtime);
    return runtime;
  };
  const session = new TranslationSession(
    modelSource,
    () => new InferenceController(createRuntime),
  );

  await withFakeDom(document, async () => {
    mountTranslation(session, createDownloadUI());
    document.getElementById('preparation-action').dispatch('click');
    await waitFor(() => session.getState().operation === 'idle' && session.getState().engine.modelLoaded, 'initial model load');

    const input = document.getElementById('translation-input');
    input.value = Array.from(
      { length: 220 },
      (_item, index) => `Sentence ${index} describes a different event.`,
    ).join(' ');
    input.dispatch('input');
    document.getElementById('translation-form').dispatch('submit');
    await waitFor(() => calls.completions.length >= 2, 'second translation chunk');

    assert.equal(session.getState().translationProgress?.total && session.getState().translationProgress.total >= 2, true);
    assert.equal(document.getElementById('copy-result').disabled, true);
    assert.match(document.getElementById('translation-output').textContent, /Interrupted portion/);

    document.getElementById('preparation-abort').dispatch('click');
    await calls.abortObserved.promise;
    await waitFor(() => session.getState().operation === 'idle' && session.getState().result?.status === 'partial', 'partial result after cancellation');

    const partial = session.getState().result;
    assert.equal(partial?.partialReason, 'cancelled');
    assert.equal(partial?.canResume, true);
    assert.ok(partial.completedChunks >= 1);
    assert.ok(partial.totalChunks >= 2);
    assert.match(document.getElementById('translation-status').textContent, /中止しました/);
    assert.equal(document.getElementById('copy-result').textContent, '部分結果をコピー');
    assert.equal(document.getElementById('preparation-action').textContent, 'リソースを解放');

    document.getElementById('preparation-action').dispatch('click');
    await waitFor(() => session.getState().operation === 'idle' && !session.getState().modelInUse, 'cancelled runtime release');
    document.getElementById('preparation-action').dispatch('click');
    await waitFor(() => session.getState().operation === 'idle' && session.getState().engine.modelLoaded, 'model reload');
    assert.equal(document.getElementById('resume-translation').disabled, false);

    document.getElementById('resume-translation').dispatch('click');
    await waitFor(() => session.getState().operation === 'idle' && session.getState().result?.status === 'complete', 'resumed translation completion');

    const result = session.getState().result;
    const firstPrompt = calls.completions[0].prompt;
    const interruptedPrompt = calls.completions[1].prompt;
    assert.notEqual(firstPrompt, interruptedPrompt);
    assert.equal(calls.completions.filter(call => call.prompt === firstPrompt).length, 1);
    assert.equal(calls.completions.filter(call => call.prompt === interruptedPrompt).length, 2);
    assert.equal(result.completedChunks, result.totalChunks);
    assert.match(result.text, /First translated\./);
    assert.match(result.text, /Resumed translation\./);
    assert.equal(document.getElementById('copy-result').disabled, false);
    assert.match(document.getElementById('translation-output').textContent, /Resumed translation\./);
    assert.equal(calls.runtimes.length, 2);

    await session.unload();
  });
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
    assert.equal(document.getElementById('preparation-action').textContent, 'モデルをロード');

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
    backend.dispatch('change');
    assert.equal(document.getElementById('requested-backend-detail').textContent, 'CPU（WASM）');
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
    assert.equal(document.getElementById('preparation-action').textContent, 'モデルをロード');
    assert.match(document.getElementById('translation-status').textContent, /完了/);
  });
});
