import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const ORIGIN = 'https://example.test';
const BASE_PATH = '/local-web-translation/';
const WORKER_URL = `${ORIGIN}${BASE_PATH}service-worker.js`;
const WORKER_TEMPLATE = await readFile(new URL('../src/offline/service-worker.js', import.meta.url), 'utf8');
const APP_CLIENT = {
  id: 'app-tab-1',
  type: 'window',
  url: `${ORIGIN}${BASE_PATH}`,
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function createBuild(version, entries) {
  const assets = Object.entries(entries).map(([path, value]) => {
    const bytes = Buffer.from(value);
    return {
      url: `${BASE_PATH}${path}`,
      sha256: sha256(bytes),
      size: bytes.byteLength,
      hashed: /(?:^|\/)[^/]+-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(path),
    };
  });
  const buildId = sha256(`${version}\n${assets.map(asset => `${asset.url}\0${asset.sha256}`).join('\n')}`);
  return { buildId, assets, entries };
}

class FakeCache {
  constructor(origin) {
    this.origin = origin;
    this.responses = new Map();
  }

  requestUrl(request) {
    const value = typeof request === 'string' ? request : request.url;
    return new URL(value, this.origin).href;
  }

  async match(request) {
    const response = this.responses.get(this.requestUrl(request));
    return response?.clone();
  }

  async put(request, response) {
    this.responses.set(this.requestUrl(request), response.clone());
  }

  async delete(request) {
    return this.responses.delete(this.requestUrl(request));
  }
}

class FakeCacheStorage {
  constructor(origin) {
    this.origin = origin;
    this.values = new Map();
  }

  async open(name) {
    if (!this.values.has(name)) this.values.set(name, new FakeCache(this.origin));
    return this.values.get(name);
  }

  async keys() {
    return [...this.values.keys()];
  }

  async delete(name) {
    return this.values.delete(name);
  }
}

function createWorker(build, options = {}) {
  const cacheStorage = options.cacheStorage ?? new FakeCacheStorage(ORIGIN);
  const listeners = new Map();
  const appClients = options.appClients ?? [APP_CLIENT];
  const networkEntries = new Map();
  for (const asset of build.assets) {
    networkEntries.set(new URL(asset.url, ORIGIN).href, Buffer.from(build.entries[asset.url.slice(BASE_PATH.length)]));
  }
  const registration = options.registration ?? {
    scope: `${ORIGIN}${BASE_PATH}`,
    active: null,
    installing: null,
    waiting: null,
    unregistered: false,
    async unregister() {
      this.unregistered = true;
      return true;
    },
  };

  const self = {
    location: { origin: ORIGIN, href: WORKER_URL },
    registration,
    clients: { async matchAll() { return appClients; } },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    skipWaitingCalls: 0,
    async skipWaiting() {
      this.skipWaitingCalls += 1;
      return undefined;
    },
  };

  const source = WORKER_TEMPLATE
    .replaceAll('__OFFLINE_BUILD_ID__', JSON.stringify(build.buildId))
    .replaceAll('__OFFLINE_BASE_PATH__', JSON.stringify(BASE_PATH))
    .replaceAll('__OFFLINE_ASSETS__', JSON.stringify(build.assets));
  const workerSource = options.sourceTransform ? options.sourceTransform(source) : source;

  const context = {
    self,
    caches: cacheStorage,
    crypto: webcrypto,
    fetch: async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN).href;
      const configured = options.fetchOverride?.(url, init);
      if (configured) return configured;
      const bytes = networkEntries.get(url);
      if (!bytes) return new Response('not found', { status: 404 });
      return new Response(bytes, { status: 200 });
    },
    URL,
    Response,
    Request,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Uint8Array,
    ArrayBuffer,
    Map,
    Promise,
    JSON,
    Number,
    String,
    Boolean,
    Error,
  };
  vm.runInNewContext(workerSource, context, { filename: `service-worker-${build.buildId.slice(0, 8)}.js` });

  return {
    self,
    registration,
    cacheStorage,
    build,
    listeners,
    setNetworkEntry(url, value) {
      networkEntries.set(new URL(url, ORIGIN).href, Buffer.from(value));
    },
    setFetchOverride(callback) {
      options.fetchOverride = callback;
    },
    async dispatchInstall() {
      return dispatchLifecycle(listeners.get('install'), {});
    },
    async dispatchActivate() {
      return dispatchLifecycle(listeners.get('activate'), {});
    },
    async dispatchMessage(data, sourceClient = APP_CLIENT) {
      let reply;
      const lifecycle = dispatchLifecycle(listeners.get('message'), {
        data,
        source: sourceClient,
        ports: [{ postMessage(message) { reply = message; } }],
      });
      await lifecycle;
      return reply;
    },
    async dispatchFetch(request) {
      let responsePromise;
      listeners.get('fetch')({
        request,
        respondWith(value) { responsePromise = Promise.resolve(value); },
      });
      return responsePromise ? responsePromise : null;
    },
  };
}

async function dispatchLifecycle(listener, eventData) {
  let pending;
  listener({
    ...eventData,
    waitUntil(value) { pending = Promise.resolve(value); },
  });
  await pending;
}

function request(type, pageBuildId, requestId = `req-${type}`, targetBuildId = pageBuildId) {
  return {
    type,
    protocolVersion: 1,
    requestId,
    pageBuildId,
    targetBuildId: type === 'GET_STATUS' ? null : targetBuildId,
  };
}

function fixtureBuild(version, label) {
  return createBuild(version, {
    'index.html': `<html><body>index ${label}</body></html>`,
    [`assets/app-${label}HASH1.js`]: `application ${label}`,
    [`assets/style-${label}HASH2.css`]: `body { content: '${label}'; }`,
    [`assets/wllama-${label}HASH3.wasm`]: `wasm ${label}`,
    'THIRD_PARTY_NOTICES.txt': `notices ${label}`,
  });
}

async function installAndActivate(worker) {
  await worker.dispatchInstall();
  worker.registration.active = { scriptURL: WORKER_URL, state: 'activated' };
  worker.registration.waiting = null;
  await worker.dispatchActivate();
}

test('install verifies and caches the complete same-origin manifest', async () => {
  const build = fixtureBuild('one', 'OLD');
  const worker = createWorker(build);
  await worker.dispatchInstall();

  const status = await worker.dispatchMessage(request('GET_STATUS', 'page-one'));
  assert.equal(status.type, 'STATUS');
  assert.equal(status.protocolVersion, 1);
  assert.equal(status.requestId, 'req-GET_STATUS');
  assert.equal(status.requestType, 'GET_STATUS');
  assert.equal(status.targetBuildId, null);
  assert.equal(status.pageBuildId, 'page-one');
  assert.equal(status.buildId, build.buildId);
  assert.equal(status.complete, true);
  assert.equal(status.resourceCount, build.assets.length);
  assert.equal(status.totalBytes, build.assets.reduce((total, asset) => total + asset.size, 0));
  assert.deepEqual([...status.missing], []);
});

test('failed install removes only its staging cache and leaves prior app and foreign caches intact', async () => {
  const cacheStorage = new FakeCacheStorage(ORIGIN);
  const oldBuild = fixtureBuild('one', 'OLD');
  const oldWorker = createWorker(oldBuild, { cacheStorage });
  await installAndActivate(oldWorker);

  const foreignCache = await cacheStorage.open('unrelated-app-cache');
  await foreignCache.put(`${ORIGIN}/unrelated.txt`, new Response('keep me'));
  const oldNames = await cacheStorage.keys();
  const nextBuild = fixtureBuild('two', 'NEW');
  const badUrl = new URL(nextBuild.assets[1].url, ORIGIN).href;
  const nextWorker = createWorker(nextBuild, {
    cacheStorage,
    fetchOverride(url) {
      if (url === badUrl) return new Response('wrong bytes', { status: 200 });
      return undefined;
    },
  });

  await assert.rejects(nextWorker.dispatchInstall());
  const namesAfterFailure = await cacheStorage.keys();
  assert.deepEqual(namesAfterFailure.sort(), oldNames.sort());
  assert.equal((await foreignCache.match(`${ORIGIN}/unrelated.txt`)).status, 200);
  const oldStatus = await oldWorker.dispatchMessage(request('GET_STATUS', oldBuild.buildId));
  assert.equal(oldStatus.complete, true);
});

test('PREPARE_APP_CACHE repairs an incomplete active cache and does not claim success after a failed repair', async () => {
  const build = fixtureBuild('one', 'OLD');
  const worker = createWorker(build);
  await installAndActivate(worker);
  const cacheName = (await worker.cacheStorage.keys())[0];
  const cache = await worker.cacheStorage.open(cacheName);
  const missingAsset = build.assets.find(asset => asset.hashed);
  await cache.delete(new URL(missingAsset.url, ORIGIN).href);

  const incomplete = await worker.dispatchMessage(request('GET_STATUS', build.buildId));
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.missing.includes(missingAsset.url));

  const repaired = await worker.dispatchMessage(request('PREPARE_APP_CACHE', build.buildId, 'repair-ok'));
  assert.equal(repaired.type, 'RESULT');
  assert.equal(repaired.requestType, 'PREPARE_APP_CACHE');
  assert.equal(repaired.requestId, 'repair-ok');
  assert.equal(repaired.targetBuildId, build.buildId);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.complete, true);

  const nextMissingAsset = build.assets.find(asset => asset.url !== missingAsset.url);
  await cache.delete(new URL(nextMissingAsset.url, ORIGIN).href);
  worker.setFetchOverride(url => url === new URL(nextMissingAsset.url, ORIGIN).href
    ? new Response('unavailable', { status: 503 })
    : undefined);
  const failedRepair = await worker.dispatchMessage(request('PREPARE_APP_CACHE', build.buildId, 'repair-failed'));
  assert.equal(failedRepair.ok, false);
  assert.equal(failedRepair.complete, false);
  assert.equal(failedRepair.reason, 'precache-failed');
});

test('navigation uses this build only and gives a repair response for an incomplete cache', async () => {
  const build = fixtureBuild('one', 'OLD');
  const worker = createWorker(build);
  await installAndActivate(worker);
  const currentIndex = await worker.dispatchFetch({
    url: `${ORIGIN}${BASE_PATH}`,
    method: 'GET',
    mode: 'navigate',
  });
  assert.equal(await currentIndex.text(), '<html><body>index OLD</body></html>');

  const cache = await worker.cacheStorage.open((await worker.cacheStorage.keys())[0]);
  await cache.delete(new URL(build.assets.find(asset => asset.hashed).url, ORIGIN).href);
  const recovery = await worker.dispatchFetch({
    url: `${ORIGIN}${BASE_PATH}index.html`,
    method: 'GET',
    mode: 'navigate',
  });
  assert.equal(recovery.status, 503);
  const html = await recovery.text();
  assert.match(html, /アプリの保存データに不足があります/);
  assert.match(html, /保存モデルや翻訳設定は削除しません/);
  assert.match(html, /アプリの登録を解除して再読み込み/);
});

test('new active build serves old hashed assets but never an old index from a retained cache', async () => {
  const cacheStorage = new FakeCacheStorage(ORIGIN);
  const foreign = await cacheStorage.open('some-other-application');
  await foreign.put(`${ORIGIN}/keep.txt`, new Response('untouched'));
  const oldBuild = fixtureBuild('one', 'OLD');
  const oldWorker = createWorker(oldBuild, { cacheStorage });
  await installAndActivate(oldWorker);

  const newBuild = fixtureBuild('two', 'NEW');
  const newWorker = createWorker(newBuild, { cacheStorage, appClients: [APP_CLIENT] });
  await newWorker.dispatchInstall();
  newWorker.registration.waiting = { scriptURL: WORKER_URL, state: 'installed' };
  await newWorker.dispatchActivate();

  const oldScript = oldBuild.assets.find(asset => asset.url.endsWith('.js'));
  const fallback = await newWorker.dispatchFetch({
    url: new URL(oldScript.url, ORIGIN).href,
    method: 'GET',
    mode: 'cors',
  });
  assert.equal(await fallback.text(), oldBuild.entries[oldScript.url.slice(BASE_PATH.length)]);

  const navigation = await newWorker.dispatchFetch({
    url: `${ORIGIN}${BASE_PATH}`,
    method: 'GET',
    mode: 'navigate',
  });
  assert.equal(await navigation.text(), '<html><body>index NEW</body></html>');
  assert.equal((await foreign.match(`${ORIGIN}/keep.txt`)).status, 200);
  assert.ok((await cacheStorage.keys()).includes(`local-web-translation:${ORIGIN}${BASE_PATH}:${oldBuild.buildId}`));
});

test('fetch leaves foreign origins, non-app paths, and non-GET requests to the browser', async () => {
  const build = fixtureBuild('one', 'OLD');
  const worker = createWorker(build);
  await installAndActivate(worker);

  assert.equal(await worker.dispatchFetch({ url: 'https://other.test/local-web-translation/assets/app-OLDHASH1.js', method: 'GET', mode: 'cors' }), null);
  assert.equal(await worker.dispatchFetch({ url: `${ORIGIN}/unrelated/assets/app-OLDHASH1.js`, method: 'GET', mode: 'cors' }), null);
  assert.equal(await worker.dispatchFetch({ url: new URL(build.assets[1].url, ORIGIN).href, method: 'POST', mode: 'cors' }), null);
});

test('ACTIVATE_UPDATE requires a single app window and an explicit build-matched request', async () => {
  const build = fixtureBuild('two', 'NEW');
  const worker = createWorker(build, { appClients: [APP_CLIENT, { ...APP_CLIENT, id: 'app-tab-2' }] });
  await worker.dispatchInstall();
  worker.registration.waiting = { scriptURL: WORKER_URL, state: 'installed' };

  const multiClient = await worker.dispatchMessage(request('ACTIVATE_UPDATE', build.buildId));
  assert.equal(multiClient.ok, false);
  assert.equal(multiClient.reason, 'multiple-clients');
  assert.equal(worker.self.skipWaitingCalls, 0);

  worker.self.clients.matchAll = async () => [APP_CLIENT];
  const mismatch = await worker.dispatchMessage({ ...request('ACTIVATE_UPDATE', build.buildId), targetBuildId: 'wrong-build' });
  assert.equal(mismatch.reason, 'build-mismatch');
  assert.equal(worker.self.skipWaitingCalls, 0);

  const cache = await worker.cacheStorage.open((await worker.cacheStorage.keys())[0]);
  const missingAsset = build.assets.find(asset => asset.hashed);
  await cache.delete(new URL(missingAsset.url, ORIGIN).href);
  const incomplete = await worker.dispatchMessage(request('ACTIVATE_UPDATE', 'old-page-build', 'activate-incomplete', build.buildId));
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.reason, 'incomplete-cache');
  assert.equal(worker.self.skipWaitingCalls, 0);

  const repaired = await worker.dispatchMessage(request('PREPARE_APP_CACHE', 'old-page-build', 'repair-waiting', build.buildId));
  assert.equal(repaired.ok, true);
  assert.equal(repaired.complete, true);

  const activated = await worker.dispatchMessage(request('ACTIVATE_UPDATE', 'old-page-build', 'activate-one', build.buildId));
  assert.equal(activated.ok, true);
  assert.equal(activated.requestId, 'activate-one');
  assert.equal(activated.pageBuildId, 'old-page-build');
  assert.equal(worker.self.skipWaitingCalls, 1);
});

test('CLEAR_APP_CACHE refuses a pending browser update and preserves app and foreign caches', async () => {
  const build = fixtureBuild('one', 'OLD');
  const worker = createWorker(build);
  await installAndActivate(worker);
  const cacheBefore = await worker.cacheStorage.keys();
  const foreign = await worker.cacheStorage.open('unrelated-app-cache');
  await foreign.put(`${ORIGIN}/unrelated.txt`, new Response('keep me'));
  worker.registration.installing = { scriptURL: WORKER_URL, state: 'installing' };

  const reply = await worker.dispatchMessage(request('CLEAR_APP_CACHE', build.buildId));
  assert.equal(reply.ok, false);
  assert.equal(reply.reason, 'app-cache-busy');
  assert.equal(worker.registration.unregistered, false);
  assert.deepEqual((await worker.cacheStorage.keys()).filter(name => name !== 'unrelated-app-cache').sort(), cacheBefore.sort());
  assert.equal((await foreign.match(`${ORIGIN}/unrelated.txt`)).status, 200);
});

test('CLEAR_APP_CACHE refuses while this worker is repairing its cache', async () => {
  const build = fixtureBuild('one', 'OLD');
  const blockedAsset = build.assets[0];
  let signalFetchStarted;
  let releaseFetch;
  const fetchStarted = new Promise(resolve => { signalFetchStarted = resolve; });
  const worker = createWorker(build);
  await installAndActivate(worker);
  const cacheName = (await worker.cacheStorage.keys())[0];
  await (await worker.cacheStorage.open(cacheName)).delete(new URL(blockedAsset.url, ORIGIN).href);
  worker.setFetchOverride(url => {
      if (url !== new URL(blockedAsset.url, ORIGIN).href) return undefined;
      return new Promise(resolve => {
        releaseFetch = () => resolve(new Response(build.entries[blockedAsset.url.slice(BASE_PATH.length)], { status: 200 }));
        signalFetchStarted();
      });
  });

  const preparePromise = worker.dispatchMessage(request('PREPARE_APP_CACHE', build.buildId, 'repair-in-flight'));
  await fetchStarted;
  const clearReply = await worker.dispatchMessage(request('CLEAR_APP_CACHE', build.buildId, 'clear-during-repair'));
  assert.equal(clearReply.ok, false);
  assert.equal(clearReply.reason, 'app-cache-busy');
  assert.equal(worker.registration.unregistered, false);
  assert.ok((await worker.cacheStorage.keys()).includes(cacheName));

  releaseFetch();
  const prepareReply = await preparePromise;
  assert.equal(prepareReply.ok, true);
  assert.equal(prepareReply.complete, true);
});

test('CLEAR_APP_CACHE removes only this app cache and unregisters its own service worker', async () => {
  const build = fixtureBuild('one', 'OLD');
  const worker = createWorker(build);
  await installAndActivate(worker);
  const foreign = await worker.cacheStorage.open('unrelated-app-cache');
  await foreign.put(`${ORIGIN}/unrelated.txt`, new Response('keep me'));

  const reply = await worker.dispatchMessage(request('CLEAR_APP_CACHE', build.buildId));
  assert.equal(reply.ok, true);
  assert.equal(worker.registration.unregistered, true);
  assert.deepEqual(await worker.cacheStorage.keys(), ['unrelated-app-cache']);
  assert.equal((await foreign.match(`${ORIGIN}/unrelated.txt`)).status, 200);
});

test('activation cleanup failure does not fail activation or delete caches', async () => {
  const build = fixtureBuild('one', 'OLD');
  const worker = createWorker(build, { appClients: [] });
  await worker.dispatchInstall();
  worker.registration.active = { scriptURL: WORKER_URL, state: 'activated' };
  const oldCache = await worker.cacheStorage.open(`local-web-translation:${ORIGIN}${BASE_PATH}${'a'.repeat(64)}`);
  await oldCache.put(`${ORIGIN}${BASE_PATH}older.txt`, new Response('old cache'));
  const originalKeys = worker.cacheStorage.keys.bind(worker.cacheStorage);
  worker.cacheStorage.keys = async () => { throw new Error('CacheStorage unavailable'); };

  await assert.doesNotReject(worker.dispatchActivate());
  worker.cacheStorage.keys = originalKeys;
  assert.ok((await worker.cacheStorage.keys()).includes(`local-web-translation:${ORIGIN}${BASE_PATH}${'a'.repeat(64)}`));
});

test('timed out preparation aborts the request, removes staging, and releases the single-flight lock', async () => {
  const build = fixtureBuild('one', 'OLD');
  let aborted = false;
  const worker = createWorker(build, {
    sourceTransform(source) {
      return source
        .replace('const PREPARE_TIMEOUT_MS = 165_000;', 'const PREPARE_TIMEOUT_MS = 20;')
        .replace('const ASSET_FETCH_TIMEOUT_MS = 90_000;', 'const ASSET_FETCH_TIMEOUT_MS = 15;');
    },
    fetchOverride(url, init) {
      if (url !== new URL(build.assets[0].url, ORIGIN).href) return undefined;
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    },
  });

  const installPromise = worker.dispatchInstall();
  await assert.rejects(installPromise);
  assert.equal(aborted, true);
  assert.deepEqual(await worker.cacheStorage.keys(), []);

  worker.setFetchOverride(undefined);
  await worker.dispatchInstall();
  const status = await worker.dispatchMessage(request('GET_STATUS', build.buildId));
  assert.equal(status.complete, true);
});
