import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ModelDownloader } from '../src/models/model-download.ts';
import { PLAMO_MODEL, modelDownloadUrl } from '../src/models/plamo.ts';
import { describeModelDownload } from '../src/ui/model-download-view.ts';

const fixtureBytes = new TextEncoder().encode('GGUF small test fixture; not a real model');
const fixtureModel = {
  name: 'Fixture',
  repository: 'pfnet/plamo-3-translate-0.8b-GGUF',
  revision: 'dbeb0856cb0b004b484f190bb71dd65876297013',
  fileName: 'fixture.gguf',
  bytes: fixtureBytes.length,
  sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
};

function fixtureResponse(bytes = fixtureBytes) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 8));
      controller.enqueue(bytes.slice(8));
      controller.close();
    },
  }));
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function memoryDownloader(model = fixtureModel, fetcher) {
  const downloader = new ModelDownloader(model, fetcher);
  await downloader.initialize();
  downloader.setStorageMode('memory');
  return downloader;
}

test('production URL pins the exact revision, file, size and hash', () => {
  assert.equal(modelDownloadUrl(PLAMO_MODEL),
    'https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/' +
    'dbeb0856cb0b004b484f190bb71dd65876297013/plamo-3-translate-0.8b-Q4_K_M.gguf');
  assert.equal(PLAMO_MODEL.bytes, 573123200);
  assert.equal(PLAMO_MODEL.sha256, '923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd');
  assert(Object.isFrozen(PLAMO_MODEL));
});

test('creation and subscription never start a network request', () => {
  let calls = 0;
  const downloader = new ModelDownloader(fixtureModel, async () => { calls++; });
  const states = [];
  downloader.subscribe(state => states.push(state));

  assert.equal(calls, 0);
  assert.equal(downloader.getModel(), undefined);
  assert.equal(states[0].phase, 'checking');
  assert(Object.isFrozen(states[0]));
});

test('streaming receive reports byte counts and returns only the verified Blob', async () => {
  let requestedUrl, options;
  const downloader = await memoryDownloader(fixtureModel, async (url, init) => {
    requestedUrl = url;
    options = init;
    return fixtureResponse();
  });
  const states = [];
  downloader.subscribe(state => states.push(state));
  const blob = await downloader.download();

  assert.equal(requestedUrl, modelDownloadUrl(fixtureModel));
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.mode, 'cors');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert(options.signal instanceof AbortSignal);
  assert.equal(blob.size, fixtureModel.bytes);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), fixtureBytes);
  assert.equal(downloader.getModel(), blob);
  assert.deepEqual(states.map(state => state.phase),
    ['idle', 'downloading', 'downloading', 'downloading', 'verifying', 'ready']);
  assert.deepEqual(states.filter(state => state.phase === 'downloading').map(state => state.loadedBytes),
    [0, 8, fixtureModel.bytes]);
});

test('HTTP and partial responses cannot become ready', async () => {
  for (const status of [404, 403, 500, 206]) {
    const downloader = await memoryDownloader(fixtureModel, async () => new Response('error', { status }));
    await assert.rejects(downloader.download(), { code: 'http' });
    assert.equal(downloader.getState().phase, 'error');
    assert.match(downloader.getState().error.message, new RegExp(String(status)));
    assert.equal(downloader.getModel(), undefined);
  }
});

test('missing stream support is reported explicitly', async () => {
  const downloader = await memoryDownloader(fixtureModel, async () => new Response(null));
  await assert.rejects(downloader.download(), { code: 'unsupported' });
  assert.equal(downloader.getState().phase, 'error');
});

test('short and oversized bodies fail integrity checks and release the stream', async () => {
  const shorter = fixtureBytes.slice(1);
  const longer = new Uint8Array([...fixtureBytes, 0]);

  for (const bytes of [shorter, longer]) {
    const downloader = await memoryDownloader(fixtureModel, async () => fixtureResponse(bytes));
    await assert.rejects(downloader.download(), { code: 'integrity' });
    assert.equal(downloader.getModel(), undefined);
    assert(downloader.getState().loadedBytes <= fixtureModel.bytes);
  }
});

test('same-sized corrupt data fails the SHA-256 check', async () => {
  const corrupted = fixtureBytes.slice();
  corrupted[corrupted.length - 1] ^= 1;
  const downloader = await memoryDownloader(fixtureModel, async () => fixtureResponse(corrupted));

  await assert.rejects(downloader.download(), { code: 'integrity' });
  assert.match(downloader.getState().error.message, /SHA-256/);
  assert.equal(downloader.getModel(), undefined);
});

test('network and stream failures can be retried with a fresh full request', async () => {
  let attempts = 0;
  const downloader = await memoryDownloader(fixtureModel, async () => {
    attempts++;
    if (attempts === 1) {
      throw new TypeError('network failure');
    }
    if (attempts === 2) {
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error('connection closed')); },
      }));
    }
    return fixtureResponse();
  });

  await assert.rejects(downloader.download(), { code: 'network' });
  await assert.rejects(downloader.download(), { code: 'network' });
  await downloader.download();
  assert.equal(attempts, 3);
  assert.equal(downloader.getState().phase, 'ready');
});

test('abort before the request starts does not make a network request', async () => {
  let calls = 0;
  const downloader = await memoryDownloader(fixtureModel, async () => {
    calls++;
    return fixtureResponse();
  });
  const downloading = assert.rejects(downloader.download(), { code: 'cancelled' });
  await downloader.abort();
  await downloading;
  assert.equal(calls, 0);
  assert.equal(downloader.getState().phase, 'cancelled');
  assert.equal(downloader.getModel(), undefined);
});

test('repeated abort from a cancelling subscriber waits for the same operation', async () => {
  const downloader = await memoryDownloader(fixtureModel, async () => fixtureResponse());
  let repeatedAbort;
  downloader.subscribe(state => {
    if (state.phase === 'cancelling') repeatedAbort = downloader.abort();
  });

  const downloading = assert.rejects(downloader.download(), { code: 'cancelled' });
  await downloader.abort();
  await Promise.all([downloading, repeatedAbort]);
  assert.equal(downloader.getState().phase, 'cancelled');
});

test('abort cancels a pending body read and discards partial data', async () => {
  const received = deferred();
  let cancelled = false;
  const downloader = await memoryDownloader(fixtureModel, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(fixtureBytes.slice(0, 8)); },
    cancel() { cancelled = true; },
  })));
  downloader.subscribe(state => {
    if (state.loadedBytes === 8) received.resolve();
  });
  const downloading = assert.rejects(downloader.download(), { code: 'cancelled' });
  await received.promise;
  await assert.rejects(downloader.download(), { code: 'busy' });
  await assert.rejects(downloader.clear(), { code: 'busy' });
  await downloader.abort();
  await downloading;

  assert.equal(cancelled, true);
  assert.equal(downloader.getState().phase, 'cancelled');
  assert.equal(downloader.getModel(), undefined);
});

test('abort at verification cannot publish a ready model', async () => {
  const downloader = await memoryDownloader(fixtureModel, async () => fixtureResponse());
  let aborting;
  downloader.subscribe(state => {
    if (state.phase === 'verifying') aborting = downloader.abort();
  });
  await assert.rejects(downloader.download(), { code: 'cancelled' });
  await aborting;
  assert.equal(downloader.getModel(), undefined);
  assert.equal(downloader.getState().phase, 'cancelled');
});

test('buffered large chunks yield to timer-driven cancellation before completion', async () => {
  // Synthetic bytes only: exercise the responsiveness path without a model GET.
  const bytes = new Uint8Array(4 * 1024 * 1024);
  const largeFixture = {
    ...fixtureModel,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const downloader = await memoryDownloader(largeFixture, async () => fixtureResponse(bytes));
  let aborting;
  downloader.subscribe(state => {
    if (state.phase === 'downloading' && state.loadedBytes === bytes.length) {
      setTimeout(() => { aborting = downloader.abort(); }, 0);
    }
  });

  await assert.rejects(downloader.download(), { code: 'cancelled' });
  await aborting;
  assert.equal(downloader.getModel(), undefined);
  assert.equal(downloader.getState().phase, 'cancelled');
});

test('ready data is reused in this page only; clear permits a fresh download', async () => {
  let calls = 0;
  const downloader = await memoryDownloader(fixtureModel, async () => {
    calls++;
    return fixtureResponse();
  });

  const first = await downloader.download();
  assert.equal(await downloader.download(), first);
  assert.equal(calls, 1);
  await downloader.clear();
  assert.equal(downloader.getModel(), undefined);
  assert.equal(downloader.getState().phase, 'idle');
  await downloader.download();
  assert.equal(calls, 2);
});

test('a ready subscriber can immediately clear data without stale notifications', async () => {
  const downloader = await memoryDownloader(fixtureModel, async () => fixtureResponse());
  const phases = [];
  downloader.subscribe(state => {
    if (state.phase === 'ready') downloader.clear();
  });
  downloader.subscribe(state => phases.push(state.phase));

  await downloader.download();
  assert.equal(downloader.getModel(), undefined);
  assert.equal(phases.at(-1), 'idle');
  assert(!phases.includes('ready'));
});

test('UI actions, error display and verification progress follow the state', () => {
  for (const phase of ['idle', 'downloading', 'verifying', 'cancelling', 'cancelled', 'ready', 'error']) {
    const view = describeModelDownload({
      phase, loadedBytes: 8, totalBytes: fixtureModel.bytes,
      storageMode: 'memory',
      cache: { available: false, cached: false, bytes: 0, retentionDays: 7 },
      error: { code: 'network', message: '接続を確認して再試行してください。' },
    });
    assert(view.status.length > 0);
    assert.equal(view.canClear, phase === 'ready');
    assert.equal(view.canStart, ['idle', 'cancelled', 'error'].includes(phase));
    assert.equal(view.canAbort, ['downloading', 'verifying'].includes(phase));
    assert.equal(view.indeterminate, ['verifying', 'cancelling'].includes(phase));
    assert.equal(Boolean(view.error), phase === 'error');
  }
});
