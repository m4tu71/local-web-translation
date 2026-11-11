import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  addBuildIdMeta,
  createOfflineWorkerPlugin,
} from '../vite.config.ts';

const BASE_PATH = '/local-web-translation/';
const WORKER_TEMPLATE = await readFile(new URL('../src/offline/service-worker.js', import.meta.url), 'utf8');
const PUBLIC_NOTICES = await readFile(new URL('../public/THIRD_PARTY_NOTICES.txt', import.meta.url));

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function createBundle(indexSource = '<!doctype html><html><head></head><body>app</body></html>') {
  return {
    'index.html': { type: 'asset', source: indexSource },
    'assets/index-abc12345.js': { type: 'chunk', code: 'console.log("offline");' },
    'assets/index-abc12345.css': { type: 'asset', source: 'body { color: black; }' },
    'assets/wllama-abc12345.wasm': { type: 'asset', source: Uint8Array.from([1, 2, 3, 4]) },
    'THIRD_PARTY_NOTICES.txt': { type: 'asset', source: PUBLIC_NOTICES },
    'assets/ignored.js.map': { type: 'asset', source: '{"sources":[]}' },
    'model.gguf': { type: 'asset', source: Uint8Array.from([9, 8, 7]) },
  };
}

async function writeBuildOutput(t, bundle) {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'offline-build-test-'));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  for (const [fileName, output] of Object.entries(bundle)) {
    const filePath = join(outputDirectory, ...fileName.split('/'));
    await mkdir(dirname(filePath), { recursive: true });
    const contents = output.type === 'chunk' ? output.code : output.source;
    await writeFile(filePath, contents);
  }
  return outputDirectory;
}

async function generate(plugin, outputDirectory) {
  assert.equal(typeof plugin.writeBundle, 'function');
  await plugin.writeBundle.call({}, { dir: outputDirectory }, {});
  return {
    index: await readFile(join(outputDirectory, 'index.html'), 'utf8'),
    worker: await readFile(join(outputDirectory, 'service-worker.js'), 'utf8'),
  };
}

function workerAssets(source) {
  const match = source.match(/^const ASSETS = (.+);$/m);
  assert.ok(match, 'generated worker has an inline asset manifest');
  return JSON.parse(match[1]);
}

test('build plugin injects an id derived before index mutation and precaches final asset hashes', async t => {
  const bundle = createBundle();
  const outputDirectory = await writeBuildOutput(t, bundle);
  const { index, worker } = await generate(createOfflineWorkerPlugin(), outputDirectory);

  const id = index.match(/<meta name="offline-build" content="([a-f0-9]{64})">/)?.[1];
  assert.ok(id);
  assert.equal((index.match(/name="offline-build"/g) ?? []).length, 1);
  assert.match(worker, new RegExp(`^const BUILD_ID = "${id}";$`, 'm'));
  assert.match(worker, /^const BASE_PATH = "\/local-web-translation\/";$/m);
  assert.doesNotMatch(worker, /__OFFLINE_(?:BUILD_ID|BASE_PATH|ASSETS)__/);

  const assets = workerAssets(worker);
  assert.ok(assets.some(asset => asset.url === `${BASE_PATH}index.html`));
  assert.ok(assets.some(asset => asset.url.endsWith('.js')));
  assert.ok(assets.some(asset => asset.url.endsWith('.css')));
  assert.ok(assets.some(asset => asset.url.endsWith('.wasm')));
  assert.ok(assets.some(asset => asset.url === `${BASE_PATH}THIRD_PARTY_NOTICES.txt`));
  assert.ok(assets.every(asset => asset.url.startsWith(BASE_PATH)));
  assert.ok(assets.every(asset => !/\.(?:gguf|safetensors|pt|pth|bin|onnx|tgz|map)$/i.test(asset.url)));

  const manifestIndex = assets.find(asset => asset.url === `${BASE_PATH}index.html`);
  assert.equal(manifestIndex.sha256, sha256(Buffer.from(index)));
  assert.equal(manifestIndex.size, Buffer.byteLength(index));
  const manifestJs = assets.find(asset => asset.url.endsWith('.js'));
  assert.equal(manifestJs.sha256, sha256(Buffer.from(bundle['assets/index-abc12345.js'].code)));
  const manifestWasm = assets.find(asset => asset.url.endsWith('.wasm'));
  assert.equal(manifestWasm.sha256, sha256(Buffer.from(bundle['assets/wllama-abc12345.wasm'].source)));
  const manifestNotices = assets.find(asset => asset.url.endsWith('/THIRD_PARTY_NOTICES.txt'));
  assert.equal(manifestNotices.sha256, sha256(PUBLIC_NOTICES));
  assert.equal(manifestNotices.size, PUBLIC_NOTICES.byteLength);
});

test('build id changes when the worker template changes, and meta injection replaces existing metadata', async t => {
  const firstBundle = createBundle();
  const firstOutputDirectory = await writeBuildOutput(t, firstBundle);
  const firstOutput = await generate(createOfflineWorkerPlugin(), firstOutputDirectory);
  const firstWorker = firstOutput.worker;
  const firstId = firstOutput.index.match(/offline-build" content="([a-f0-9]{64})/)?.[1];

  const secondBundle = createBundle();
  const secondOutputDirectory = await writeBuildOutput(t, secondBundle);
  const secondOutput = await generate(
    createOfflineWorkerPlugin(BASE_PATH, `${WORKER_TEMPLATE}\n// template revision`),
    secondOutputDirectory,
  );
  const secondWorker = secondOutput.worker;
  const secondId = secondOutput.index.match(/offline-build" content="([a-f0-9]{64})/)?.[1];
  assert.notEqual(firstId, secondId);
  assert.match(secondWorker, new RegExp(`^const BUILD_ID = "${secondId}";$`, 'm'));

  const replaced = addBuildIdMeta('<head><meta content="old" name="offline-build"></head>', 'new-build');
  assert.equal((replaced.match(/name="offline-build"/g) ?? []).length, 1);
  assert.match(replaced, /<meta name="offline-build" content="new-build">/);
});

test('offline worker is a production build plugin and rejects an unsafe base path', () => {
  assert.equal(createOfflineWorkerPlugin().apply, 'build');
  assert.throws(() => createOfflineWorkerPlugin('local-web-translation'), /absolute base path/);
  assert.throws(() => createOfflineWorkerPlugin('/local-web-translation'), /ending in slash/);
});
