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
      async load(...args) { calls.loads.push(args); },
      async complete(...args) {
        calls.completions.push(args);
        return { text: 'The meeting has been moved to next Monday.', finishReason: 'stop' };
      },
      async dispose() { calls.exits++; },
      ...overrides,
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

test('PoC passes the existing Blob to load and fixes translation direction to Japanese-English', async () => {
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
  assert.equal(session.getState().result.elapsedMs, 10);
  assert.equal(session.getState().result.truncated, false);

  session.clearResult();
  assert.equal(session.getState().result, undefined);
  await session.unload();
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

test('cancelled translation exposes no stale result and can reload without re-downloading', async () => {
  const entered = deferred();
  const { session, source, calls } = fixture({
    complete(_prompt, { signal }) {
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
  assert.equal(session.getState().result, undefined);
  assert.equal(session.getState().error, undefined);
  assert.equal(session.getState().engine.modelLoaded, false);
  assert(source.getModel());
  assert.match(describeTranslation(session.getState(), '日本語').status, /中止/);

  await session.load('cpu');
  assert.equal(calls.factories, 2);
  assert.equal(session.getState().engine.phase, 'ready');
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
  await assert.rejects(session.translate('<|plamo:tag|>'), { code: 'invalid-input' });
  assert.equal(session.getState().engine.modelLoaded, true);
  assert.match(session.getState().error, /入力を修正/);
  session.clearResult();
  await session.translate('こんにちは');
  assert.equal(session.getState().error, undefined);
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
  assert.match(describeTranslation(session.getState(), '日本語').status, /空/);
  assert.equal(session.getState().logs.length, 100);
  assert(!session.getState().logs.some(line => line.includes('ユーザーの入力')));
  assert(Object.isFrozen(session.getState()));
  assert(Object.isFrozen(session.getState().result));
  assert(Object.isFrozen(session.getState().logs));
  await session.unload();
});
