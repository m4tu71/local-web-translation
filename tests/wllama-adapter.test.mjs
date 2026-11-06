import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptWllama } from '../src/inference/wllama-adapter.ts';
import { InferenceController } from '../src/inference/engine.ts';

function modelInfo(overrides = {}) {
  return {
    metadata: { 'general.architecture': 'plamo3', 'tokenizer.ggml.model': 'plamo3' },
    token_bos: 1,
    token_eos: 1,
    token_eot: 16,
    list_tokens_eog: [1, 2, 16],
    add_bos_token: true,
    add_eos_token: false,
    ...overrides,
  };
}

test('wllama bridge maps load settings, PFML stops, cancellation and disposal', async () => {
  let loaded, completed, exits = 0;
  const port = adaptWllama({
    async loadModel(...args) { loaded = args; },
    getLoadedContextInfo() { return modelInfo(); },
    async createCompletion(options) {
      completed = options;
      return { choices: [{ text: 'fixture', finish_reason: 'stop' }] };
    },
    async exit() { exits++; },
  });
  const files = [new Blob(['fixture'])];
  await port.load(files, { backend: 'cpu', contextSize: 2048, threads: 1 });
  assert.notEqual(loaded[0], files);
  assert.deepEqual(loaded[0], files);
  assert.deepEqual(loaded[1], { n_gpu_layers: 0, n_ctx: 2048, n_threads: 1, n_parallel: 1 });
  await port.load(files, { backend: 'auto', contextSize: 1024, threads: 2 });
  assert.equal(loaded[1].n_gpu_layers, undefined);
  const controller = new AbortController();
  assert.deepEqual(await port.complete('PFML prompt', { maxTokens: 128, signal: controller.signal }),
    { text: 'fixture', finishReason: 'stop' });
  assert.deepEqual(completed, {
    prompt: 'PFML prompt', temperature: 0, max_tokens: 128,
    stop: ['<|plamo:tag|>', '<|plamo:bos|>'],
    ignore_eos: false,
    echo: false,
    abortSignal: controller.signal,
    stream: false,
  });
  await port.dispose();
  assert.equal(exits, 1);
});

test('model loading rejects incompatible tokenizer and BOS/EOS policies before ready', async () => {
  const incompatible = [
    { metadata: { 'general.architecture': 'llama', 'tokenizer.ggml.model': 'plamo3' } },
    { metadata: { 'general.architecture': 'plamo3', 'tokenizer.ggml.model': 'plamo2' } },
    { metadata: {} },
    { add_bos_token: false },
    { add_eos_token: true },
    { add_bos_token: undefined },
    { add_eos_token: undefined },
    { token_bos: 2 },
    { token_eos: 2 },
    { token_eot: 2 },
    { list_tokens_eog: [1] },
    { list_tokens_eog: [16] },
  ];

  for (const override of incompatible) {
    let exits = 0;
    let generations = 0;
    const runtime = adaptWllama({
      async loadModel() {},
      getLoadedContextInfo() { return modelInfo(override); },
      async createCompletion() { generations++; },
      async exit() { exits++; },
    });
    const engine = new InferenceController(async () => runtime);

    await assert.rejects(engine.loadModel([new Blob(['fixture'])]), { code: 'load-failed' });
    assert.equal(engine.getState().phase, 'error');
    assert.equal(engine.getState().modelLoaded, false);
    assert.equal(exits, 1);
    await assert.rejects(engine.translate({ text: 'こんにちは', targetLanguage: 'en' }), { code: 'not-ready' });
    assert.equal(generations, 0);
  }
});

test('wllama bridge distinguishes token limit from unsupported/missing output', async () => {
  let choices = [{ text: 'partial', finish_reason: 'length' }];
  const port = adaptWllama({ async loadModel() {}, async exit() {},
    async createCompletion() { return { choices }; },
  });
  const options = { maxTokens: 1, signal: new AbortController().signal };
  assert.equal((await port.complete('prompt', options)).finishReason, 'length');
  choices = [];
  await assert.rejects(port.complete('prompt', options));
  choices = [{ text: '', finish_reason: 'content_filter' }];
  await assert.rejects(port.complete('prompt', options));
});
