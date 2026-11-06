import test from 'node:test';
import assert from 'node:assert/strict';
import { InferenceController } from '../src/inference/engine.ts';
import { buildTranslationPrompt } from '../src/inference/pfml.ts';
import { createInferenceEngine } from '../src/inference/index.ts';

const model = () => [new Blob(['test fixture; not a real GGUF'])];
const request = { text: '会議は来週の月曜日に変更されました。', targetLanguage: 'en' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fake(overrides = {}) {
  const calls = { load: [], complete: [], dispose: 0 };
  const runtime = {
    async load(...args) { calls.load.push(args); },
    async complete(...args) { calls.complete.push(args); return { text: 'Fixture output', finishReason: 'stop' }; },
    async dispose() { calls.dispose++; },
    ...overrides,
  };
  return { runtime, calls };
}

test('creating an engine and subscribing do not create a runtime or access a model', () => {
  let factories = 0;
  const engine = new InferenceController(async () => { factories++; return fake().runtime; });
  const snapshots = [];
  const unsubscribe = engine.subscribe(state => snapshots.push(state));
  assert.deepEqual(snapshots, [{ phase: 'idle', modelLoaded: false }]);
  assert(Object.isFrozen(engine.getState()));
  assert.equal(factories, 0);
  unsubscribe();
});

test('public factory can create and dispose independent idle engines without browser globals', async () => {
  const first = createInferenceEngine();
  const second = createInferenceEngine();

  assert.notEqual(first, second);
  await first.dispose();
  assert.equal(first.getState().phase, 'disposed');
  assert.equal(second.getState().phase, 'idle');
  await second.dispose();
});

test('load, translate, truncate and dispose notify stable application states', async () => {
  const { runtime, calls } = fake({ async complete() { return { text: 'partial', finishReason: 'length' }; } });
  const engine = new InferenceController(async () => runtime);
  const phases = [];
  engine.subscribe(state => phases.push(state.phase));
  await engine.loadModel(model(), { backend: 'cpu', contextSize: 1024, threads: 2 });
  assert.deepEqual(calls.load[0][1], { backend: 'cpu', contextSize: 1024, threads: 2 });
  assert.deepEqual(await engine.translate(request), { text: 'partial', truncated: true });
  assert.equal(engine.getState().modelLoaded, true);
  await engine.dispose();
  assert.equal(calls.dispose, 1);
  assert.deepEqual(phases, ['idle', 'loading', 'ready', 'translating', 'ready', 'disposing', 'disposed']);
  assert.equal(engine.getState().modelLoaded, false);
  await assert.rejects(engine.loadModel(model()), { code: 'disposed' });
});

test('PFML3 matches the official single-sentence prompt and omits BOS', () => {
  assert.equal(buildTranslationPrompt(request),
    '<|plamo:tag|>dataset<|plamo:msg|>translation' +
    '<|plamo:tag|>input<|plamo:msg|>会議は来週の月曜日に変更されました。' +
    '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>');
  assert(buildTranslationPrompt({ ...request, sourceLanguage: 'ja' })
    .includes('input<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>'));
});

test('invalid input is rejected before runtime creation or generation', async () => {
  const { runtime, calls } = fake();
  const engine = new InferenceController(async () => runtime);
  await assert.rejects(engine.translate(request), { code: 'not-ready' });
  for (const files of [[], [new Blob([])], ['not a Blob']]) {
    await assert.rejects(engine.loadModel(files), { code: 'invalid-input' });
  }
  await assert.rejects(engine.loadModel(model(), { threads: 0 }), { code: 'invalid-input' });
  assert.equal(calls.load.length, 0);
  await engine.loadModel(model());
  for (const invalid of [
    { ...request, text: ' ' }, { ...request, text: '<|plamo:tag|>output' },
    { ...request, targetLanguage: 'bad' }, { ...request, maxTokens: 0 },
  ]) await assert.rejects(engine.translate(invalid), { code: 'invalid-input' });
  assert.equal(calls.complete.length, 0);
  assert.equal(engine.getState().phase, 'ready');
  await engine.dispose();
});

test('concurrent operations and replacing an already loaded model are rejected', async () => {
  const gate = deferred();
  const engine = new InferenceController(async () => fake({ load: () => gate.promise }).runtime);
  const loading = engine.loadModel(model());
  await assert.rejects(engine.loadModel(model()), { code: 'busy' });
  await assert.rejects(engine.translate(request), { code: 'busy' });
  gate.resolve();
  await loading;
  await assert.rejects(engine.loadModel(model()), { code: 'not-ready' });
  await engine.dispose();
});

test('load failure releases partial resources and a new load can retry', async () => {
  const failed = fake({ async load() { throw new Error('load failure'); } });
  const healthy = fake();
  let attempts = 0;
  const engine = new InferenceController(async () => attempts++ === 0 ? failed.runtime : healthy.runtime);
  await assert.rejects(engine.loadModel(model()), { code: 'load-failed' });
  assert.equal(failed.calls.dispose, 1);
  assert.equal(engine.getState().error.code, 'load-failed');
  assert(Object.isFrozen(engine.getState().error));
  await engine.loadModel(model());
  assert.equal(engine.getState().phase, 'ready');
  await engine.dispose();
});

test('abort during factory initialization cleans up the eventual runtime', async () => {
  const factory = deferred();
  const { runtime, calls } = fake();
  const engine = new InferenceController(() => factory.promise);
  const loading = assert.rejects(engine.loadModel(model()), { code: 'cancelled' });
  const aborting = engine.abort();
  assert.equal(engine.getState().phase, 'stopping');
  factory.resolve(runtime);
  await Promise.all([loading, aborting]);
  assert.equal(calls.load.length, 0);
  assert.equal(calls.dispose, 1);
  assert.deepEqual(engine.getState(), { phase: 'idle', modelLoaded: false });
});

test('abort during model loading waits for native load then cleanup, never publishes ready', async () => {
  const entered = deferred(), load = deferred(), cleanup = deferred();
  const engine = new InferenceController(async () => fake({
    load() { entered.resolve(); return load.promise; },
    dispose() { return cleanup.promise; },
  }).runtime);
  const phases = [];
  engine.subscribe(state => phases.push(state.phase));
  const loading = assert.rejects(engine.loadModel(model()), { code: 'cancelled' });
  await entered.promise;
  let finished = false;
  const aborting = engine.abort().then(() => { finished = true; });
  load.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(engine.getState().phase, 'stopping');
  cleanup.resolve();
  await Promise.all([loading, aborting]);
  assert.deepEqual(phases, ['idle', 'loading', 'stopping', 'idle']);
});

test('aborted generation passes a signal and discards even a late successful response', async () => {
  const entered = deferred(), completion = deferred();
  let signal;
  const { runtime, calls } = fake({ complete(_prompt, options) {
    signal = options.signal;
    entered.resolve();
    return completion.promise;
  } });
  const engine = new InferenceController(async () => runtime);
  await engine.loadModel(model());
  const translating = assert.rejects(engine.translate(request), { code: 'cancelled' });
  await entered.promise;
  const aborting = engine.abort();
  assert.equal(signal.aborted, true);
  completion.resolve({ text: 'late result', finishReason: 'stop' });
  await Promise.all([translating, aborting]);
  assert.equal(calls.dispose, 1);
  await assert.rejects(engine.translate(request), { code: 'not-ready' });
});

test('native cancellation rejection does not become an error state', async () => {
  const { runtime } = fake({ complete(_prompt, { signal }) {
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const engine = new InferenceController(async () => runtime);
  await engine.loadModel(model());
  const translation = assert.rejects(engine.translate(request), { code: 'cancelled' });
  await engine.abort();
  await translation;
  assert.equal(engine.getState().phase, 'idle');
});

test('dispose during loading is idempotent, waits for cleanup and is terminal', async () => {
  const entered = deferred(), load = deferred();
  const { runtime, calls } = fake({ load() { entered.resolve(); return load.promise; } });
  const engine = new InferenceController(async () => runtime);
  const loading = assert.rejects(engine.loadModel(model()), { code: 'cancelled' });
  await entered.promise;
  const disposal = engine.dispose();
  assert.equal(engine.dispose(), disposal);
  await assert.rejects(engine.loadModel(model()), { code: 'disposed' });
  load.resolve();
  await Promise.all([loading, disposal]);
  assert.equal(calls.dispose, 1);
  assert.equal(engine.getState().phase, 'disposed');
  assert.equal(engine.dispose(), disposal);
});

test('translation failure unloads the model and exposes an application error', async () => {
  const { runtime, calls } = fake({ async complete() { throw new Error('native error'); } });
  const engine = new InferenceController(async () => runtime);
  await engine.loadModel(model());
  await assert.rejects(engine.translate(request), { code: 'translation-failed' });
  assert.equal(calls.dispose, 1);
  assert.deepEqual(engine.getState(), {
    phase: 'error', modelLoaded: false,
    error: { code: 'translation-failed', message: '翻訳に失敗しました。' },
  });
});

test('cleanup failure is reported and dispose can retry cleanup without admitting new work', async () => {
  let attempts = 0;
  const engine = new InferenceController(async () => fake({
    async dispose() { if (++attempts === 1) throw new Error('cleanup failed'); },
  }).runtime);
  await engine.loadModel(model());
  await assert.rejects(engine.dispose(), { code: 'dispose-failed' });
  await assert.rejects(engine.loadModel(model()), { code: 'disposed' });
  await engine.dispose();
  assert.equal(attempts, 2);
  assert.equal(engine.getState().phase, 'disposed');
});

test('abort reports cleanup failure and retains the runtime for disposal retry', async () => {
  const gate = deferred();
  let cleanups = 0;
  const engine = new InferenceController(async () => fake({
    complete: () => gate.promise,
    async dispose() { if (++cleanups === 1) throw new Error('cleanup failed'); },
  }).runtime);
  await engine.loadModel(model());
  const translating = assert.rejects(engine.translate(request), { code: 'dispose-failed' });
  const aborting = assert.rejects(engine.abort(), { code: 'dispose-failed' });
  gate.resolve({ text: 'discarded', finishReason: 'stop' });
  await Promise.all([translating, aborting]);
  assert.equal(engine.getState().phase, 'error');
  assert.equal(engine.getState().modelLoaded, false);
  await engine.dispose();
  assert.equal(cleanups, 2);
});

test('abort does not mistake a model reloaded by an idle listener for failed cleanup', async () => {
  const gate = deferred();
  let attempts = 0, reload;
  const engine = new InferenceController(async () => attempts++ === 0
    ? fake({ complete: () => gate.promise }).runtime : fake().runtime);
  await engine.loadModel(model());
  engine.subscribe(state => {
    if (state.phase === 'idle') reload = engine.loadModel(model());
  });
  const translating = assert.rejects(engine.translate(request), { code: 'cancelled' });
  const aborting = engine.abort();
  gate.resolve({ text: 'discarded', finishReason: 'stop' });
  await Promise.all([translating, aborting]);
  await reload;
  assert.equal(engine.getState().phase, 'ready');
  await engine.dispose();
});

test('runtime initialization failure is normalized; idle abort and disposal are safe', async () => {
  const engine = new InferenceController(async () => { throw new Error('unsupported environment'); });
  await engine.abort();
  await assert.rejects(engine.loadModel(model()), { code: 'load-failed' });
  assert.equal(engine.getState().modelLoaded, false);
  await engine.dispose();
  await engine.abort();
  assert.equal(engine.getState().phase, 'disposed');
});

test('listeners can abort or dispose during notifications without deadlocks or stale states', async () => {
  const engine = new InferenceController(async () => fake().runtime);
  const observed = [];
  let disposal;
  engine.subscribe(state => {
    if (state.phase === 'loading') disposal = engine.dispose();
  });
  engine.subscribe(state => observed.push(state.phase));
  await assert.rejects(engine.loadModel(model()), { code: 'cancelled' });
  await disposal;
  assert.deepEqual(observed, ['idle', 'disposing', 'disposed']);
});

test('listener exceptions do not corrupt lifecycle and unsubscribe stops notifications', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const engine = new InferenceController(async () => fake().runtime);
  engine.subscribe(() => { throw new Error('UI listener error'); });
  const phases = [];
  const unsubscribe = engine.subscribe(state => phases.push(state.phase));
  await engine.loadModel(model());
  unsubscribe();
  await engine.dispose();
  assert.deepEqual(phases, ['idle', 'loading', 'ready']);
  assert(logged.mock.calls.length > 0);
});
