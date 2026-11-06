import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptWllama } from '../src/inference/wllama-adapter.ts';

test('wllama bridge maps load settings, PFML stops, cancellation and disposal', async () => {
  let loaded, completed, exits = 0;
  const port = adaptWllama({
    async loadModel(...args) { loaded = args; },
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
    stop: ['<|plamo:tag|>', '<|plamo:bos|>'], abortSignal: controller.signal, stream: false,
  });
  await port.dispose();
  assert.equal(exits, 1);
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
