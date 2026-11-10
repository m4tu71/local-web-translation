import test from 'node:test';
import assert from 'node:assert/strict';
import { InferenceController } from '../src/inference/engine.ts';
import { TranslationSession } from '../src/poc/translation-session.ts';
import { describeTranslation } from '../src/ui/translation-view.ts';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture(overrides = {}, hasModel = true) {
  const blob = new Blob(['fixture; not a real GGUF']);
  const calls = { factories: 0, loads: [], completions: [], exits: 0 };
  const listeners = new Set();
  let available = hasModel;
  const source = {
    getModel() { return available ? blob : undefined; },
    subscribe(listener) {
      listeners.add(listener);
      listener();
      return () => listeners.delete(listener);
    },
    setAvailable(value) {
      available = value;
      for (const listener of listeners) listener();
    },
  };
  const createEngine = () => {
    calls.factories++;
    return new InferenceController(async () => ({
      ...overrides,
      async load(...args) {
        if (overrides.load) return overrides.load(...args);
        calls.loads.push(args);
      },
      async complete(...args) {
        calls.completions.push(args);
        if (overrides.complete) return overrides.complete(...args);
        return { text: 'The meeting has been moved to next Monday.', finishReason: 'stop' };
      },
      getInputTokenUpperBound(prompt) {
        if (overrides.getInputTokenUpperBound) return overrides.getInputTokenUpperBound(prompt);
        return new TextEncoder().encode(prompt).length + 1;
      },
      async dispose(...args) {
        calls.exits++;
        if (overrides.dispose) return overrides.dispose(...args);
      },
    }));
  };
  let clock = 0;
  const session = new TranslationSession(source, createEngine, () => { clock += 10; return clock; });
  return { session, source, blob, calls };
}

test('PoC waits for a downloaded model and never initializes inference automatically', async () => {
  const { session, source, calls } = fixture({}, false);
  const initial = describeTranslation(session.getState(), '日本語');
  assert.equal(initial.canLoad, false);
  assert.equal(initial.canTranslate, false);
  assert.equal(calls.factories, 0);
  await assert.rejects(session.load('auto'), /先にモデルを取得/);
  assert.equal(calls.factories, 0);

  source.setAvailable(true);
  assert.equal(describeTranslation(session.getState(), '日本語').canLoad, true);
});

test('passes the existing Blob to load and translates Japanese to English by default', async () => {
  const { session, blob, calls } = fixture();
  await session.load('cpu');
  assert.equal(calls.loads[0][0][0], blob);
  assert.deepEqual(calls.loads[0][1], { backend: 'cpu', contextSize: 2048, threads: 1 });
  assert.equal(session.getState().modelInUse, true);

  await session.translate('会議は来週の月曜日に変更されました。');
  const [prompt, options] = calls.completions[0];
  assert(prompt.includes('input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>'));
  assert(prompt.endsWith('output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>'));
  assert.equal(options.maxTokens, 512);
  assert.equal(session.getState().result.text, 'The meeting has been moved to next Monday.');
  assert(session.getState().result.elapsedMs >= 10);
  assert.equal(session.getState().result.truncated, false);
  assert.deepEqual(session.getState().result.direction, {
    sourceLanguage: 'ja',
    targetLanguage: 'en',
  });

  session.clearResult();
  assert.equal(session.getState().result, undefined);
  await session.unload();
});

test('translates English to Japanese explicitly without reloading the model', async () => {
  const { session, calls } = fixture();
  await session.load('auto');
  await session.translate('The meeting starts at nine.', {
    sourceLanguage: 'en',
    targetLanguage: 'ja',
  });

  const [prompt, options] = calls.completions[0];
  assert(prompt.includes('input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>'));
  assert(prompt.endsWith('output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>'));
  assert.equal(options.maxTokens, 512);
  assert.equal(calls.loads.length, 1);
  assert.equal(calls.factories, 1);
  assert.deepEqual(session.getState().result.direction, {
    sourceLanguage: 'en',
    targetLanguage: 'ja',
  });

  await session.unload();
});

test('captures a stable direction before asynchronous inference starts', async () => {
  const entered = deferred();
  const completion = deferred();
  const { session, calls } = fixture({
    complete(prompt) {
      entered.resolve(prompt);
      return completion.promise;
    },
  });
  await session.load('auto');
  const direction = { sourceLanguage: 'en', targetLanguage: 'ja' };
  const translating = session.translate('The meeting starts at nine.', direction);
  const prompt = await entered.promise;
  direction.sourceLanguage = 'ja';
  direction.targetLanguage = 'en';
  completion.resolve({ text: '会議は9時に始まります。', finishReason: 'stop' });
  await translating;

  assert(prompt.includes('input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>'));
  assert(prompt.endsWith('output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>'));
  assert.deepEqual(session.getState().result.direction, {
    sourceLanguage: 'en',
    targetLanguage: 'ja',
  });
  assert(Object.isFrozen(session.getState().result.direction));
  assert.equal(calls.completions.length, 1);

  await session.unload();
});

test('load and unload preserve an existing translation result', async () => {
  const { session } = fixture();
  await session.load('auto');
  await session.translate('会議は来週の月曜日に変更されました。');
  const result = session.getState().result;

  await session.unload();
  assert.equal(session.getState().result, result);
  await session.load('cpu');
  assert.equal(session.getState().result, result);
  await session.unload();
  assert.equal(session.getState().result, result);
});

test('load/translation controls and model deletion lock follow the busy state', async () => {
  const entered = deferred();
  const load = deferred();
  const { session } = fixture({
    load() { entered.resolve(); return load.promise; },
  });
  const loading = session.load('auto');
  await entered.promise;
  const view = describeTranslation(session.getState(), '日本語');
  assert.equal(view.canLoad, false);
  assert.equal(view.canTranslate, false);
  assert.equal(view.canUnload, false);
  assert.equal(view.canChangeBackend, false);
  assert.equal(view.canAbort, true);
  assert.equal(session.getState().modelInUse, true);
  await assert.rejects(session.load('cpu'), /実行中/);
  await assert.rejects(session.unload(), /実行中/);

  load.resolve();
  await loading;
  assert.equal(describeTranslation(session.getState(), ' ').canTranslate, false);
  assert.equal(describeTranslation(session.getState(), '日本語').canTranslate, true);
  await session.unload();
  assert.equal(session.getState().modelInUse, false);
});

test('cancelling while OPFS verification waits prevents inference from starting', async () => {
  const acquiring = deferred();
  const { session, source, calls } = fixture();
  source.acquireModel = signal => new Promise((_resolve, reject) => {
    acquiring.resolve(signal);
    signal.addEventListener('abort', () => reject({ code: 'cancelled' }), { once: true });
  });

  const loading = assert.rejects(session.load('auto'), { code: 'cancelled' });
  const signal = await acquiring.promise;
  assert.equal(session.getState().operation, 'loading');
  assert.equal(describeTranslation(session.getState(), '日本語').canAbort, true);
  await session.abort();
  await loading;
  assert.equal(signal.aborted, true);
  assert.equal(calls.factories, 0);
  assert.equal(session.getState().modelInUse, false);
});

test('an OPFS use lease stays held when engine disposal fails, then releases after retry', async () => {
  let releases = 0;
  let disposeAttempts = 0;
  const { session, source } = fixture({
    async dispose() {
      if (++disposeAttempts === 1) throw new Error('release failed');
    },
  });
  source.acquireModel = async () => ({ model: await source.getModel(), async release() { releases++; } });
  await session.load('auto');
  await assert.rejects(session.unload(), { code: 'dispose-failed' });
  assert.equal(releases, 0);
  assert.equal(session.getState().modelInUse, true);
  await session.unload();
  assert.equal(releases, 1);
  assert.equal(session.getState().modelInUse, false);
});

test('cache timestamp failures stay visible without turning successful inference into failure', async () => {
  const { session, source } = fixture();
  source.markUsed = async () => { throw new Error('storage unavailable'); };
  await session.load('auto');
  assert.equal(session.getState().engine.modelLoaded, true);
  assert.match(session.getState().notice, /保存日時を更新できません/);
  await session.translate('こんにちは');
  assert.equal(session.getState().result.text, 'The meeting has been moved to next Monday.');
  assert.match(session.getState().notice, /storage unavailable/);
  await session.unload();
});

test('cancelled translation keeps its partial result and can resume after reloading', async () => {
  const entered = deferred();
  let abortedOnce = false;
  const { session, source, calls } = fixture({
    complete(_prompt, { signal }) {
      if (abortedOnce) {
        return { text: 'resumed result', finishReason: 'stop' };
      }
      abortedOnce = true;
      entered.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  await session.load('auto');
  const translating = assert.rejects(session.translate('こんにちは'), { code: 'cancelled' });
  await entered.promise;
  await session.abort();
  await translating;
  assert.equal(session.getState().result.status, 'partial');
  assert.equal(session.getState().result.partialReason, 'cancelled');
  assert.equal(session.getState().result.canResume, true);
  assert.equal(session.getState().error, undefined);
  assert.equal(session.getState().engine.modelLoaded, false);
  assert(source.getModel());
  assert.match(describeTranslation(session.getState(), '日本語').resultStatus, /中止/);

  await session.unload();
  await session.load('cpu');
  assert.equal(calls.factories, 2);
  assert.equal(session.getState().engine.phase, 'ready');
  await session.resumeTranslation('こんにちは', { sourceLanguage: 'ja', targetLanguage: 'en' });
  assert.equal(session.getState().result.status, 'complete');
  await session.unload();
});

test('loading failure logs its cause and unlocks model deletion only after unload', async () => {
  const { session } = fixture({ async load() { throw new Error('BOS policy mismatch'); } });
  await assert.rejects(session.load('auto'), { code: 'load-failed' });
  assert.equal(session.getState().engine.modelLoaded, false);
  assert.match(session.getState().error, /ロード解除/);
  assert(session.getState().logs.some(line => line.includes('BOS policy mismatch')));
  assert.equal(session.getState().modelInUse, true);

  await session.unload();
  assert.equal(session.getState().modelInUse, false);
});

test('input validation preserves loaded model and directs the user to fix input', async () => {
  const { session } = fixture();
  await session.load('auto');
  const invalidInputs = [
    '',
    ' '.repeat(3),
    'a'.repeat(10_001),
    '<|plamo:tag|>',
  ];
  for (const text of invalidInputs) {
    await assert.rejects(session.translate(text), { code: 'invalid-input' });
    assert.equal(session.getState().engine.modelLoaded, true);
    assert.match(session.getState().error, /入力を修正/);
  }
  await assert.rejects(session.translate('同じ言語', {
    sourceLanguage: 'ja',
    targetLanguage: 'ja',
  }), { code: 'invalid-input' });
  assert.equal(session.getState().engine.modelLoaded, true);
  assert.equal(session.getState().operation, 'idle');
  await session.translate('こんにちは');
  assert.equal(session.getState().error, undefined);
  await session.unload();
});

test('abort waits for cache-touch work and does not publish a stale translation result', async () => {
  const entered = deferred();
  const cacheTouch = deferred();
  const { session, source } = fixture();
  await session.load('auto');
  source.markUsed = () => {
    entered.resolve();
    return cacheTouch.promise;
  };

  const translating = assert.rejects(session.translate('こんにちは'), { code: 'cancelled' });
  await entered.promise;
  let abortFinished = false;
  const aborting = session.abort().then(() => { abortFinished = true; });
  await Promise.resolve();
  assert.equal(abortFinished, false);
  cacheTouch.resolve();
  await Promise.all([aborting, translating]);

  assert.equal(session.getState().operation, 'idle');
  assert.equal(session.getState().engine.modelLoaded, true);
  assert.equal(session.getState().result.status, 'partial');
  assert.equal(session.getState().result.partialReason, 'cancelled');
  assert.equal(session.getState().result.text, 'The meeting has been moved to next Monday.');
  assert.equal(session.getState().result.canResume, false);
  assert.equal(session.getState().error, undefined);
  assert.match(session.getState().notice, /もう一度翻訳できます/);
  await session.unload();
});

test('failed disposal keeps the model locked and can be retried', async () => {
  let attempts = 0;
  const { session } = fixture({
    async dispose() {
      if (++attempts === 1) throw new Error('cleanup failed');
    },
  });
  await session.load('auto');
  await assert.rejects(session.unload(), { code: 'dispose-failed' });
  assert.equal(session.getState().modelInUse, true);
  assert.equal(describeTranslation(session.getState(), '日本語').canUnload, true);
  await session.unload();
  assert.equal(session.getState().modelInUse, false);
});

test('truncated and empty output remain distinguishable and logs have a fixed bound', async () => {
  const { session } = fixture({
    async complete() { return { text: '', finishReason: 'length' }; },
  });
  await session.load('auto');
  for (let index = 0; index < 30; index++) {
    await session.translate('ユーザーの入力');
  }
  assert.equal(session.getState().result.truncated, true);
  assert.equal(session.getState().result.status, 'partial');
  assert.equal(session.getState().result.partialReason, 'truncated');
  assert.equal(session.getState().result.text, '');
  assert.equal(session.getState().logs.length, 100);
  assert(!session.getState().logs.some(line => line.includes('ユーザーの入力')));
  assert(Object.isFrozen(session.getState()));
  assert(Object.isFrozen(session.getState().result));
  assert(Object.isFrozen(session.getState().logs));
  await session.unload();
});

test('streams cumulative text into the current result and completes without a live result announcement', async () => {
  const { session } = fixture({
    async complete(_prompt, { onText }) {
      onText('Hel');
      onText('Hello');
      return { text: 'Hello', finishReason: 'stop' };
    },
  });
  const observed = [];
  session.subscribe(state => {
    if (state.result?.status === 'streaming') observed.push(state.result.text);
  });
  await session.load('auto');
  await session.translate('こんにちは');

  assert(observed.includes('Hel'));
  assert(observed.includes('Hello'));
  assert.equal(session.getState().result.status, 'complete');
  assert.equal(session.getState().result.text, 'Hello');
  await session.unload();
});

test('an aborted generation keeps received text and rejects a callback delivered after cancellation', async () => {
  const entered = deferred();
  const { session } = fixture({
    complete(_prompt, { signal, onText }) {
      onText('途中まで');
      entered.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => {
            onText('遅れて届いた古い文章');
            reject(signal.reason);
          }, 0);
        }, { once: true });
      });
    },
  });
  await session.load('auto');
  const translating = assert.rejects(session.translate('これは長い文章'), { code: 'cancelled' });
  await entered.promise;
  await session.abort();
  await translating;

  assert.equal(session.getState().result.status, 'partial');
  assert.equal(session.getState().result.partialReason, 'cancelled');
  assert.equal(session.getState().result.text, '途中まで');
  assert.equal(session.getState().result.canResume, true);
  await session.unload();
});

test('ignores a completed chunk callback after the next chunk has started', async () => {
  const secondChunkEntered = deferred();
  const secondChunk = deferred();
  let state = { phase: 'idle', modelLoaded: false };
  let oldProgressCallback;
  let callCount = 0;
  const listeners = new Set();
  const engine = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    async loadModel() {
      state = { phase: 'ready', modelLoaded: true };
      for (const listener of listeners) listener(state);
    },
    getTranslationBudget(request) {
      const inputTokenUpperBound = request.text.length + 50;
      return {
        inputTokenUpperBound,
        contextSize: 2_048,
        maxOutputTokens: request.maxTokens,
        method: 'utf8-upper-bound',
        fits: inputTokenUpperBound + request.maxTokens <= 2_048,
      };
    },
    async translate(_request, { onText }) {
      callCount++;
      if (callCount === 1) {
        oldProgressCallback = onText;
        onText('最初の出力');
        return { text: '最初の出力', truncated: false };
      }
      if (callCount === 2) {
        onText('現在の出力');
        secondChunkEntered.resolve();
        return secondChunk.promise;
      }
      return { text: `出力${callCount}`, truncated: false };
    },
    async abort() {},
    async dispose() {
      state = { phase: 'disposed', modelLoaded: false };
    },
  };
  const model = new Blob(['fixture']);
  const modelSource = {
    getModel: () => model,
    subscribe() { return () => {}; },
  };
  const session = new TranslationSession(modelSource, () => engine);
  await session.load('auto');
  const sourceText = 'a'.repeat(3_000);
  const translating = session.translate(sourceText);
  await secondChunkEntered.promise;
  const currentText = session.getState().result.text;

  oldProgressCallback('古い区切りの遅延出力');
  assert.equal(session.getState().result.text, currentText);

  secondChunk.resolve({ text: '現在の出力', truncated: false });
  await translating;
  assert.equal(session.getState().result.status, 'complete');
  assert.equal(session.getState().result.text.includes('古い区切り'), false);
  await session.unload();
});

test('resumes after the failed chunk without regenerating completed chunks', async () => {
  let attempts = 0;
  let contextSize = 2_048;
  const { session, calls } = fixture({
    getRuntimeInfo() {
      return {
        backend: 'unknown',
        contextSize,
        requestedContextSize: 2_048,
        actualContextSize: contextSize,
        source: 'test runtime',
      };
    },
    async complete(prompt, { onText }) {
      attempts++;
      if (attempts === 2) throw new Error('temporary inference failure');
      const result = `section-${attempts}`;
      onText(result);
      return { text: result, finishReason: 'stop' };
    },
  });
  const sourceText = `${'A'.repeat(1_000)}${'B'.repeat(1_000)}${'C'.repeat(1_000)}`;
  await session.load('auto');
  await assert.rejects(session.translate(sourceText), { code: 'translation-failed' });

  assert.equal(session.getState().result.status, 'partial');
  assert.equal(session.getState().result.partialReason, 'error');
  assert.equal(session.getState().result.completedChunks, 1);
  assert.equal(session.getState().result.canResume, true);
  const previousTotalChunks = session.getState().result.totalChunks;
  const firstPrompt = calls.completions[0][0];
  await session.unload();
  contextSize = 1_024;
  await session.load('auto');

  await session.resumeTranslation(sourceText, { sourceLanguage: 'ja', targetLanguage: 'en' });

  assert.equal(session.getState().result.status, 'complete');
  assert.equal(session.getState().result.completedChunks, session.getState().result.totalChunks);
  assert(session.getState().result.totalChunks > previousTotalChunks);
  assert.equal(calls.completions.filter(([prompt]) => prompt === firstPrompt).length, 1);
  assert.equal(attempts, calls.completions.length);
  await session.unload();
});

test('keeps a sentence newline as a separator outside the generated source chunks', async () => {
  const { session, calls } = fixture({
    async complete() { return { text: 'translation', finishReason: 'stop' }; },
  });
  await session.load('auto');
  await session.translate(`最初。\n${'長'.repeat(1_000)}`);

  assert(calls.completions.length > 1);
  assert.match(session.getState().result.text, /^translation\ntranslation/);
  await session.unload();
});

test('short truncated source chunks can be split safely before resuming', async t => {
  for (const sourceText of ['ab', '日本', 'a😀']) {
    await t.test(JSON.stringify(sourceText), async () => {
      let attempts = 0;
      const { session, calls } = fixture({
        async complete(prompt, { onText }) {
          attempts++;
          if (attempts === 1) {
            onText('incomplete');
            return { text: 'incomplete', finishReason: 'length' };
          }
          const output = `piece-${attempts}`;
          onText(output);
          return { text: output, finishReason: 'stop' };
        },
      });
      await session.load('auto');
      await session.translate(sourceText);
      assert.equal(session.getState().result.partialReason, 'truncated');
      assert.equal(session.getState().result.canResume, true);
      const originalCallCount = calls.completions.length;

      await session.resumeTranslation(sourceText, { sourceLanguage: 'ja', targetLanguage: 'en' });

      assert.equal(session.getState().result.status, 'complete');
      assert.equal(calls.completions.length, originalCallCount + 2);
      assert.equal(session.getState().result.completedChunks, 2);
      await session.unload();
    });
  }
});

test('repeated truncated output keeps shrinking the failed source chunk', async () => {
  let attempts = 0;
  const { session } = fixture({
    async complete(_prompt, { onText }) {
      attempts++;
      if (attempts <= 2) {
        onText('incomplete');
        return { text: 'incomplete', finishReason: 'length' };
      }
      const output = `piece-${attempts}`;
      onText(output);
      return { text: output, finishReason: 'stop' };
    },
  });
  await session.load('auto');
  await session.translate('abcd');
  await session.resumeTranslation('abcd', { sourceLanguage: 'ja', targetLanguage: 'en' });
  assert.equal(session.getState().result.partialReason, 'truncated');
  assert.equal(session.getState().result.canResume, true);
  await session.resumeTranslation('abcd', { sourceLanguage: 'ja', targetLanguage: 'en' });

  assert.equal(session.getState().result.status, 'complete');
  assert.equal(session.getState().result.completedChunks, session.getState().result.totalChunks);
  await session.unload();
});

test('an empty successful chunk remains explicitly incomplete and resumable', async () => {
  const { session } = fixture({
    async complete() { return { text: '', finishReason: 'stop' }; },
  });
  await session.load('auto');
  await session.translate('こんにちは');

  assert.equal(session.getState().result.status, 'partial');
  assert.equal(session.getState().result.partialReason, 'empty');
  assert.equal(session.getState().result.canResume, true);
  assert.equal(session.getState().result.text, '');
  await session.unload();
});
