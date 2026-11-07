import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ModelCache, ModelCacheError } from '../src/storage/model-cache.ts';
import { ModelDownloader } from '../src/models/model-download.ts';

const bytes = new TextEncoder().encode('small verified GGUF fixture');
const model = {
  name: 'fixture', repository: 'example/model', revision: 'fixed-revision',
  fileName: 'fixture.gguf', bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};

class FakeFileHandle {
  constructor(name) { this.name = name; this.contents = new Blob([]); }
  async getFile() { return this.contents; }
  async createWritable() {
    const parts = [];
    let closed = false;
    return {
      async write(chunk) { parts.push(typeof chunk === 'string' ? chunk : Uint8Array.from(chunk)); },
      async close() { this.contents = new Blob(parts); closed = true; },
      async abort() { parts.length = 0; closed = true; },
      get closed() { return closed; },
    };
  }
}

class FakeDirectoryHandle {
  constructor() { this.children = new Map(); this.onFileClose = undefined; }
  async getDirectoryHandle(name, options = {}) {
    if (!this.children.has(name)) {
      if (!options.create) throw new DOMException('missing', 'NotFoundError');
      this.children.set(name, new FakeDirectoryHandle());
    }
    return this.children.get(name);
  }
  async getFileHandle(name, options = {}) {
    if (!this.children.has(name)) {
      if (!options.create) throw new DOMException('missing', 'NotFoundError');
      this.children.set(name, new FakeFileHandle(name));
    }
    const child = this.children.get(name);
    if (!(child instanceof FakeFileHandle)) throw new DOMException('is directory', 'TypeMismatchError');
    const handle = child;
    const directory = this;
    return {
      async getFile() { return handle.getFile(); },
      async createWritable() {
        const parts = [];
        return {
          async write(chunk) { parts.push(typeof chunk === 'string' ? chunk : Uint8Array.from(chunk)); },
          async close() { handle.contents = new Blob(parts); directory.onFileClose?.(name); },
          async abort() { parts.length = 0; },
        };
      },
    };
  }
  async removeEntry(name) {
    if (!this.children.delete(name)) throw new DOMException('missing', 'NotFoundError');
  }
  async *entries() { yield* this.children.entries(); }
}

class FakeLockManager {
  constructor() { this.queues = new Map(); this.held = new Map(); }
  request(name, options, callback) {
    return new Promise((resolve, reject) => {
      const request = { options, callback, resolve, reject, signal: options.signal, abort: undefined };
      const queue = this.queues.get(name) ?? [];
      queue.push(request);
      this.queues.set(name, queue);
      if (request.signal?.aborted) {
        queue.splice(queue.indexOf(request), 1);
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      request.abort = () => {
        const index = queue.indexOf(request);
        if (index >= 0) {
          queue.splice(index, 1);
          reject(new DOMException('aborted', 'AbortError'));
          this.dispatch(name);
        }
      };
      request.signal?.addEventListener('abort', request.abort, { once: true });
      this.dispatch(name);
    });
  }
  dispatch(name) {
    const queue = this.queues.get(name) ?? [];
    const held = this.held.get(name) ?? [];
    if (!queue.length) return;
    if (held.some(lock => lock.mode === 'exclusive')) return;
    if (queue[0].options.mode === 'exclusive' && held.length) return;
    const group = queue[0].options.mode === 'shared' ? queue.filter(item => item.options.mode === 'shared') : [queue[0]];
    for (const request of group) {
      queue.splice(queue.indexOf(request), 1);
      request.signal?.removeEventListener('abort', request.abort);
      const lock = { mode: request.options.mode };
      held.push(lock);
      this.held.set(name, held);
      Promise.resolve().then(() => request.callback(lock)).then(request.resolve, request.reject).finally(() => {
        held.splice(held.indexOf(lock), 1);
        if (!held.length) this.held.delete(name);
        this.dispatch(name);
      });
    }
  }
}

function makeFixture() {
  const root = new FakeDirectoryHandle();
  const locks = new FakeLockManager();
  const settings = { getItem() { return null; } };
  const storage = { async getDirectory() { return root; } };
  const cache = new ModelCache(model, { storage, locks, settings });
  return { root, locks, cache };
}

function fixtureStream(value = bytes) {
  return new ReadableStream({
    start(controller) { controller.enqueue(value); controller.close(); },
  });
}

async function save(cache, value = bytes, signal = new AbortController().signal) {
  return cache.saveFromStream(fixtureStream(value), signal, { onProgress() {}, onVerifying() {} });
}

function cacheDirectory(root) { return root.children.get('plamo-model-cache-v1'); }

test('OPFS save streams bytes, commits metadata after validation, and restores without a network request', async () => {
  const { root, cache } = makeFixture();
  await cache.initialize();
  const savedFile = await save(cache);
  assert.equal(savedFile.size, bytes.length);
  assert.deepEqual(new Uint8Array(await savedFile.arrayBuffer()), bytes);
  assert.equal(cache.getInfo().cached, true);
  assert.equal(root.children.size, 1, 'cache data stays in the application-owned OPFS directory');
  const files = cacheDirectory(root).children;
  assert.equal([...files.keys()].filter(name => name.startsWith('model-')).length, 1);

  const restored = new ModelCache(model, {
    storage: { async getDirectory() { return root; } },
    locks: cache.locks,
    settings: { getItem() { return null; } },
  });
  const info = await restored.initialize();
  assert.equal(info.cached, true);
  assert.equal(restored.getCachedFile().size, bytes.length);
  assert.deepEqual(new Uint8Array(await restored.getCachedFile().arrayBuffer()), bytes);
});

test('corrupt or interrupted streams never publish a reusable model and temporary files are removed', async () => {
  const { root, cache } = makeFixture();
  await cache.initialize();
  const bad = bytes.slice();
  bad[0] ^= 0xff;
  await assert.rejects(save(cache, bad), { code: 'integrity' });
  assert.equal(cache.getInfo().cached, false);
  assert.equal([...cacheDirectory(root).children.keys()].some(name => name.startsWith('model-')), false);

  const interrupted = new ReadableStream({
    start(controller) { controller.enqueue(bytes.slice(0, 4)); controller.error(new Error('connection ended')); },
  });
  await assert.rejects(cache.saveFromStream(interrupted, new AbortController().signal, {
    onProgress() {}, onVerifying() {},
  }));
  assert.equal(cache.getInfo().cached, false);

  const restarted = new ModelCache(model, {
    storage: { async getDirectory() { return root; } },
    locks: cache.locks,
    settings: { getItem() { return null; } },
  });
  assert.equal((await restarted.initialize()).cached, false);
});

test('startup removes expired and checksum-mismatched cache entries', async () => {
  const { root, cache, locks } = makeFixture();
  await cache.initialize();
  await save(cache);
  const directory = cacheDirectory(root);
  const metadataHandle = directory.children.get('metadata.json');
  const metadata = JSON.parse(await (await metadataHandle.getFile()).text());
  metadata.lastUsed = Date.now() - 8 * 86400000;
  metadataHandle.contents = new Blob([JSON.stringify(metadata)]);

  const expired = new ModelCache(model, {
    storage: { async getDirectory() { return root; } }, locks,
    settings: { getItem() { return null; } },
  });
  assert.equal((await expired.initialize()).cached, false);
  assert.equal(directory.children.has('metadata.json'), false);

  await save(expired);
  const modelName = [...directory.children.keys()].find(name => name.startsWith('model-'));
  directory.children.get(modelName).contents = new Blob(['corrupt']);
  const corrupt = new ModelCache(model, {
    storage: { async getDirectory() { return root; } }, locks,
    settings: { getItem() { return null; } },
  });
  assert.equal((await corrupt.initialize()).cached, false);
  assert.equal(directory.children.has(modelName), false);
});

test('a verified use refreshes retention; startup folds activity into metadata without touching the clock', async () => {
  const { root, cache, locks } = makeFixture();
  await cache.initialize();
  await save(cache);
  const directory = cacheDirectory(root);
  const metadataHandle = directory.children.get('metadata.json');
  const original = JSON.parse(await (await metadataHandle.getFile()).text()).lastUsed;
  const originalNow = Date.now;
  const touchedAt = original + 1000;
  Date.now = () => touchedAt;
  try { await cache.touch(); }
  finally { Date.now = originalNow; }
  const markerName = [...directory.children.keys()].find(name => name.startsWith('last-use-'));
  assert(markerName);
  assert.equal(JSON.parse(await (await metadataHandle.getFile()).text()).lastUsed, original);

  const restored = new ModelCache(model, {
    storage: { async getDirectory() { return root; } }, locks,
    settings: { getItem() { return null; } },
  });
  const info = await restored.initialize();
  assert.equal(info.lastUsed, touchedAt);
  assert.equal(JSON.parse(await (await metadataHandle.getFile()).text()).lastUsed, touchedAt);
  assert.equal([...directory.children.keys()].some(name => name.startsWith('last-use-')), false);
});

test('startup removes uncommitted files left by a terminated write', async () => {
  const { root, cache, locks } = makeFixture();
  await cache.initialize();
  const directory = cacheDirectory(root);
  const orphan = await directory.getFileHandle('model-interrupted.partial', { create: true });
  const writer = await orphan.createWritable();
  await writer.write(bytes.slice(0, 5));
  await writer.close();
  assert(directory.children.has('model-interrupted.partial'));

  const restarted = new ModelCache(model, {
    storage: { async getDirectory() { return root; } }, locks,
    settings: { getItem() { return null; } },
  });
  await restarted.initialize();
  assert.equal(directory.children.has('model-interrupted.partial'), false);
});

test('retention accepts 1 through 30 days and rejects values outside the range', async () => {
  const { root, locks, cache } = makeFixture();
  await cache.initialize();
  assert.equal((await cache.setRetentionDays(30)).retentionDays, 30);
  await assert.rejects(cache.setRetentionDays(0), RangeError);
  await assert.rejects(cache.setRetentionDays(31), RangeError);
  await assert.rejects(cache.setRetentionDays(1.5), RangeError);
  const restored = new ModelCache(model, {
    storage: { async getDirectory() { return root; } }, locks,
    settings: { getItem() { return null; } },
  });
  assert.equal((await restored.initialize()).retentionDays, 30);
});

test('a shared model-use lease blocks deletion until release', async () => {
  const { cache } = makeFixture();
  await cache.initialize();
  await save(cache);
  const lease = await cache.acquireModel();
  let cleared = false;
  const deleting = cache.clear().then(() => { cleared = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cleared, false);
  await lease.release();
  await deleting;
  assert.equal(cache.getInfo().cached, false);
});

test('aborting while waiting for a use lock settles instead of hanging', async () => {
  const { cache, locks } = makeFixture();
  await cache.initialize();
  await save(cache);
  let unlock;
  const held = locks.request('local-web-translation:model-cache', { mode: 'exclusive' }, () => new Promise(resolve => { unlock = resolve; }));
  await new Promise(resolve => setTimeout(resolve, 0));
  const controller = new AbortController();
  const acquiring = cache.acquireModel(controller.signal);
  controller.abort();
  await assert.rejects(acquiring, { code: 'cancelled' });
  unlock();
  await held;
});

test('aborting after metadata is written removes the late cache commit', async () => {
  const { root, cache } = makeFixture();
  await cache.initialize();
  const verifying = new AbortController();
  await assert.rejects(cache.saveFromStream(fixtureStream(), verifying.signal, {
    onProgress() {},
    onVerifying() { verifying.abort(); },
  }), { code: 'cancelled' });
  assert.equal([...cacheDirectory(root).children.keys()].some(name => name.startsWith('model-')), false);

  const controller = new AbortController();
  cacheDirectory(root).onFileClose = name => {
    if (name === 'metadata.json') controller.abort();
  };
  await assert.rejects(save(cache, bytes, controller.signal), { code: 'cancelled' });
  const directory = cacheDirectory(root);
  assert.equal(directory.children.has('metadata.json'), false);
  assert.equal([...directory.children.keys()].some(name => name.startsWith('model-')), false);
  assert.equal(cache.getInfo().cached, false);
});

test('OPFS initialization never requests persistent storage', async () => {
  let persistentRequests = 0;
  const cache = new ModelCache(model, {
    storage: { async getDirectory() { return new FakeDirectoryHandle(); }, async persist() { persistentRequests++; return true; } },
    locks: new FakeLockManager(),
    settings: { getItem() { return null; } },
  });
  assert.equal((await cache.initialize()).available, true);
  assert.equal(persistentRequests, 0);
});

test('quota failures are exposed with recovery guidance', async () => {
  const { root, cache } = makeFixture();
  await cache.initialize();
  const directory = cacheDirectory(root);
  directory.getFileHandle = async () => { throw new DOMException('full', 'QuotaExceededError'); };
  await assert.rejects(save(cache), error => {
    assert(error instanceof ModelCacheError);
    assert.equal(error.code, 'quota');
    assert.match(error.message, /メモリ保存を選んで/);
    return true;
  });
});

test('ModelDownloader restores the verified OPFS file without another fetch', async () => {
  const { root, locks, cache } = makeFixture();
  let fetches = 0;
  const fetcher = async () => {
    fetches++;
    return new Response(fixtureStream());
  };
  const first = new ModelDownloader(model, fetcher, cache);
  await first.initialize();
  const downloaded = await first.download();
  assert.equal(downloaded.size, bytes.length);
  assert.equal(fetches, 1);

  const restoredCache = new ModelCache(model, {
    storage: { async getDirectory() { return root; } }, locks,
    settings: { getItem() { return null; } },
  });
  const restored = new ModelDownloader(model, async () => { throw new Error('network should not be called'); }, restoredCache);
  await restored.initialize();
  assert.equal(restored.getState().phase, 'ready');
  assert.equal(restored.getModel().size, bytes.length);
  const lease = await restored.acquireModel();
  assert.equal(lease.model.size, bytes.length);
  assert.equal(fetches, 1);
  await lease.release();
});

test('a stale downloader invalidates its old File after another tab clears the cache', async () => {
  const { root, locks, cache } = makeFixture();
  const downloader = new ModelDownloader(model, async () => new Response(fixtureStream()), cache);
  await downloader.initialize();
  await downloader.download();
  assert(downloader.getModel());

  const otherTab = new ModelCache(model, {
    storage: { async getDirectory() { return root; } }, locks,
    settings: { getItem() { return null; } },
  });
  await otherTab.initialize();
  await otherTab.clear();
  await assert.rejects(downloader.acquireModel(), { code: 'integrity' });
  assert.equal(downloader.getModel(), undefined);
  assert.equal(downloader.getState().phase, 'idle');
});
