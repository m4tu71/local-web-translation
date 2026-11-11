/* Build-time values are injected by vite.config.ts. */
const BUILD_ID = __OFFLINE_BUILD_ID__;
const BASE_PATH = __OFFLINE_BASE_PATH__;
const ASSETS = __OFFLINE_ASSETS__;
const PROTOCOL_VERSION = 1;
const PREPARE_TIMEOUT_MS = 165_000;
const ASSET_FETCH_TIMEOUT_MS = 90_000;

const SCOPE_URL = new URL(BASE_PATH, self.location.origin);
const INDEX_URL = new URL('index.html', SCOPE_URL).href;
const CACHE_PREFIX = `local-web-translation:${SCOPE_URL.origin}${SCOPE_URL.pathname}:`;
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const STAGING_PREFIX = `${CACHE_NAME}:staging:`;
const MANIFEST_CACHE_URL = new URL('__offline__/manifest.json', SCOPE_URL).href;
const COMPLETE_CACHE_URL = new URL('__offline__/complete.json', SCOPE_URL).href;
const APP_LOCK_CACHE_NAME = `${CACHE_PREFIX}operation-lock`;
const APP_LOCK_CACHE_URL = new URL('__offline__/operation-lock.json', SCOPE_URL).href;
const REQUIRED_BYTES = ASSETS.reduce((total, asset) => total + asset.size, 0);
const INDEX_PATH = new URL('index.html', SCOPE_URL).pathname;
const ASSET_BY_URL = new Map(ASSETS.map(asset => [new URL(asset.url, SCOPE_URL).pathname, asset]));

let preparationPromise;

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function isAppWindowUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === SCOPE_URL.origin && url.pathname.startsWith(SCOPE_URL.pathname);
  } catch {
    return false;
  }
}

function getSourceWindow(event) {
  const source = event.source;
  if (!source || source.type !== 'window' || typeof source.id !== 'string' || !isAppWindowUrl(source.url)) return null;
  return source;
}

async function getAppWindowClients() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients.filter(client => isAppWindowUrl(client.url));
}

function sendReply(event, reply) {
  const port = event.ports && event.ports[0];
  if (port) port.postMessage(reply);
}

function replyContext(message) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: message.requestId,
    requestType: message.type,
    targetBuildId: message.targetBuildId,
    pageBuildId: message.pageBuildId,
    buildId: BUILD_ID,
  };
}

function replyStatus(event, message, status) {
  sendReply(event, { type: 'STATUS', ...replyContext(message), ...status });
}

function replyResult(event, message, ok, extra = {}) {
  sendReply(event, { type: 'RESULT', ...replyContext(message), ok, ...extra });
}

function hasValidRequestEnvelope(message) {
  return message.protocolVersion === PROTOCOL_VERSION &&
    typeof message.requestId === 'string' && message.requestId.length > 0 &&
    typeof message.pageBuildId === 'string' && message.pageBuildId.length > 0 &&
    (message.targetBuildId === null || typeof message.targetBuildId === 'string');
}

function getManifestRecord() {
  return {
    buildId: BUILD_ID,
    assets: ASSETS,
  };
}

function getAssetCacheUrl(asset) {
  return new URL(asset.url, SCOPE_URL).href;
}

function isMatchingManifest(record) {
  if (!record || record.buildId !== BUILD_ID || !Array.isArray(record.assets)) return false;
  if (record.assets.length !== ASSETS.length) return false;

  return ASSETS.every((asset, index) => {
    const cachedAsset = record.assets[index];
    return cachedAsset && cachedAsset.url === asset.url && cachedAsset.sha256 === asset.sha256 &&
      cachedAsset.size === asset.size && cachedAsset.hashed === asset.hashed;
  });
}

async function readJson(cache, url) {
  const response = await cache.match(url);
  if (!response) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function inspectCache(cache, expectedBuildId = BUILD_ID, expectedAssets = ASSETS) {
  const manifestUrl = new URL('__offline__/manifest.json', SCOPE_URL).href;
  const completeUrl = new URL('__offline__/complete.json', SCOPE_URL).href;
  const missing = [];
  let presentCount = 0;

  for (const asset of expectedAssets) {
    if (await cache.match(getAssetCacheUrl(asset))) {
      presentCount += 1;
    } else {
      missing.push(asset.url);
    }
  }

  const manifest = await readJson(cache, manifestUrl);
  const marker = await readJson(cache, completeUrl);
  const manifestMatches = expectedBuildId === BUILD_ID
    ? isMatchingManifest(manifest)
    : isValidStoredManifest(manifest, expectedBuildId, expectedAssets);
  const markerMatches = marker && marker.buildId === expectedBuildId && marker.verified === true &&
    marker.resourceCount === expectedAssets.length;

  return {
    complete: Boolean(manifestMatches && markerMatches && missing.length === 0),
    resourceCount: presentCount,
    totalBytes: expectedAssets.reduce((total, asset) => total + asset.size, 0),
    missing,
  };
}

function isValidStoredManifest(record, buildId, assets) {
  if (!record || record.buildId !== buildId || !Array.isArray(record.assets) || record.assets.length !== assets.length) {
    return false;
  }
  return assets.every((asset, index) => {
    const stored = record.assets[index];
    return stored && stored.url === asset.url && stored.sha256 === asset.sha256 &&
      stored.size === asset.size && stored.hashed === asset.hashed;
  });
}

function isSafeStoredManifest(record, cacheName) {
  if (!record || typeof record.buildId !== 'string' || !/^[a-f0-9]{64}$/.test(record.buildId) ||
      cacheName !== `${CACHE_PREFIX}${record.buildId}` || !Array.isArray(record.assets) || !record.assets.length) {
    return false;
  }

  const seenUrls = new Set();
  for (const asset of record.assets) {
    if (!asset || typeof asset.url !== 'string' || typeof asset.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 0 ||
        typeof asset.hashed !== 'boolean') {
      return false;
    }

    let url;
    try {
      url = new URL(asset.url, SCOPE_URL);
    } catch {
      return false;
    }
    if (!asset.url.startsWith(SCOPE_URL.pathname) || asset.url.startsWith('//') ||
        url.origin !== SCOPE_URL.origin || url.pathname !== asset.url || !url.pathname.startsWith(SCOPE_URL.pathname) ||
        url.search || url.hash ||
        seenUrls.has(url.href) || /\.(?:gguf|safetensors|pt|pth|bin|onnx|tgz)$/i.test(url.pathname) ||
        !isAllowedStoredAssetPath(url.pathname) ||
        (asset.hashed && !isHashNamedAssetPath(url.pathname))) {
      return false;
    }
    seenUrls.add(url.href);
  }

  return seenUrls.has(INDEX_URL) && seenUrls.has(new URL('THIRD_PARTY_NOTICES.txt', SCOPE_URL).href);
}

function isAllowedStoredAssetPath(path) {
  if (path === INDEX_PATH || path === new URL('THIRD_PARTY_NOTICES.txt', SCOPE_URL).pathname) return true;
  return /\.(?:js|css|wasm|svg|png|jpe?g|webp|ico|woff2?)$/i.test(path);
}

async function getCurrentCacheStatus() {
  const cacheNames = await caches.keys();
  if (!cacheNames.includes(CACHE_NAME)) {
    return {
      buildId: BUILD_ID,
      complete: false,
      resourceCount: 0,
      totalBytes: REQUIRED_BYTES,
      missing: ASSETS.map(asset => asset.url),
    };
  }

  const cache = await caches.open(CACHE_NAME);
  return {
    buildId: BUILD_ID,
    ...await inspectCache(cache),
  };
}

async function createStagingCache(deadline, abortSignal) {
  if (await isAppCacheClearActive()) throw new Error('App cache is being cleared');
  const randomId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const cacheName = `${STAGING_PREFIX}${randomId}`;
  const cache = await caches.open(cacheName);

  try {
    for (const asset of ASSETS) {
      if (await isAppCacheClearActive()) throw new Error('App cache is being cleared');
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || abortSignal.aborted) throw new Error('App cache preparation timed out');
      const fetchController = new AbortController();
      const abortFetch = () => fetchController.abort();
      abortSignal.addEventListener('abort', abortFetch, { once: true });
      const fetchTimeoutMs = Math.min(ASSET_FETCH_TIMEOUT_MS, remainingMs);
      const timeoutId = setTimeout(abortFetch, fetchTimeoutMs);

      try {
        const response = await fetch(asset.url, {
          cache: 'reload',
          credentials: 'same-origin',
          redirect: 'error',
          signal: fetchController.signal,
        });
        if (!response.ok || response.status !== 200 || response.type === 'opaque' || response.redirected) {
          throw new Error(`Asset fetch failed: ${asset.url}`);
        }

        const bytes = await response.clone().arrayBuffer();
        if (bytes.byteLength !== asset.size) throw new Error(`Asset size mismatch: ${asset.url}`);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const actualHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (actualHash !== asset.sha256) throw new Error(`Asset hash mismatch: ${asset.url}`);
        if (abortSignal.aborted || fetchController.signal.aborted || Date.now() >= deadline) {
          throw new Error('App cache preparation timed out');
        }
        if (await isAppCacheClearActive()) throw new Error('App cache is being cleared');

        await cache.put(getAssetCacheUrl(asset), response);
        if (abortSignal.aborted || fetchController.signal.aborted || Date.now() >= deadline) {
          throw new Error('App cache preparation timed out');
        }
      } catch (error) {
        if (abortSignal.aborted || fetchController.signal.aborted) {
          throw new Error('App cache preparation timed out');
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
        abortSignal.removeEventListener('abort', abortFetch);
      }
    }

    if (abortSignal.aborted || Date.now() >= deadline) throw new Error('App cache preparation timed out');
    if (await isAppCacheClearActive()) throw new Error('App cache is being cleared');
    const manifest = getManifestRecord();
    await cache.put(MANIFEST_CACHE_URL, jsonResponse(manifest));
    if (abortSignal.aborted || Date.now() >= deadline) throw new Error('App cache preparation timed out');
    await cache.put(COMPLETE_CACHE_URL, jsonResponse({
      buildId: BUILD_ID,
      verified: true,
      resourceCount: ASSETS.length,
      totalBytes: REQUIRED_BYTES,
    }));
    return cacheName;
  } catch (error) {
    await caches.delete(cacheName);
    throw error;
  }
}

async function publishStagingCache(stagingCacheName, deadline, abortSignal) {
  if (abortSignal.aborted || Date.now() >= deadline) throw new Error('App cache preparation timed out');
  if (await isAppCacheClearActive()) throw new Error('App cache is being cleared');
  const existingNames = await caches.keys();
  const finalCacheExists = existingNames.includes(CACHE_NAME);
  const finalCache = await caches.open(CACHE_NAME);

  if (finalCacheExists && (await inspectCache(finalCache)).complete) {
    return getCurrentCacheStatus();
  }

  await finalCache.delete(COMPLETE_CACHE_URL);
  const stagingCache = await caches.open(stagingCacheName);

  try {
    for (const asset of ASSETS) {
      if (abortSignal.aborted || Date.now() >= deadline) throw new Error('App cache preparation timed out');
      if (await isAppCacheClearActive()) throw new Error('App cache is being cleared');
      const response = await stagingCache.match(getAssetCacheUrl(asset));
      if (!response) throw new Error(`Verified staging asset disappeared: ${asset.url}`);
      await finalCache.put(getAssetCacheUrl(asset), response);
      if (abortSignal.aborted || Date.now() >= deadline) throw new Error('App cache preparation timed out');
    }

    if (abortSignal.aborted || Date.now() >= deadline) throw new Error('App cache preparation timed out');
    if (await isAppCacheClearActive()) throw new Error('App cache is being cleared');
    const manifest = await stagingCache.match(MANIFEST_CACHE_URL);
    if (!manifest) throw new Error('Verified staging manifest disappeared');
    await finalCache.put(MANIFEST_CACHE_URL, manifest);

    const finalAssetsPresent = await inspectCache(finalCache);
    if (finalAssetsPresent.resourceCount !== ASSETS.length || finalAssetsPresent.missing.length) {
      throw new Error('Published asset cache is incomplete');
    }

    if (abortSignal.aborted || Date.now() >= deadline) throw new Error('App cache preparation timed out');
    if (await isAppCacheClearActive()) throw new Error('App cache is being cleared');
    const complete = await stagingCache.match(COMPLETE_CACHE_URL);
    if (!complete) throw new Error('Verified staging marker disappeared');
    await finalCache.put(COMPLETE_CACHE_URL, complete);
    return getCurrentCacheStatus();
  } catch (error) {
    await finalCache.delete(COMPLETE_CACHE_URL);
    throw error;
  }
}

async function populateCurrentBuildCache(deadline, abortSignal) {
  if (await isAppCacheClearActive()) throw new Error('App cache is being cleared');
  if (abortSignal.aborted || Date.now() >= deadline) throw new Error('App cache preparation timed out');
  const currentStatus = await getCurrentCacheStatus();
  if (currentStatus.complete) return currentStatus;

  let stagingCacheName;
  try {
    stagingCacheName = await createStagingCache(deadline, abortSignal);
    if (abortSignal.aborted || Date.now() >= deadline) throw new Error('App cache preparation timed out');
    return await publishStagingCache(stagingCacheName, deadline, abortSignal);
  } finally {
    if (stagingCacheName) await caches.delete(stagingCacheName);
  }
}

function prepareCurrentBuildCache() {
  if (!preparationPromise) {
    const controller = new AbortController();
    const deadline = Date.now() + PREPARE_TIMEOUT_MS;
    const timeoutId = setTimeout(() => controller.abort(), PREPARE_TIMEOUT_MS);
    preparationPromise = populateCurrentBuildCache(deadline, controller.signal).finally(() => {
      clearTimeout(timeoutId);
      preparationPromise = undefined;
    });
  }
  return preparationPromise;
}

async function getCachedCurrentIndex() {
  const status = await getCurrentCacheStatus();
  if (!status.complete) return null;

  const cache = await caches.open(CACHE_NAME);
  const indexResponse = await cache.match(INDEX_URL);
  return indexResponse && indexResponse.ok ? indexResponse : null;
}

async function isCompleteOldCache(cacheName) {
  const cache = await caches.open(cacheName);
  const manifest = await readJson(cache, MANIFEST_CACHE_URL);
  const marker = await readJson(cache, COMPLETE_CACHE_URL);
  if (!manifest || !marker || marker.buildId !== manifest.buildId || marker.verified !== true ||
      !Array.isArray(manifest.assets) || marker.resourceCount !== manifest.assets.length ||
      !isSafeStoredManifest(manifest, cacheName)) {
    return null;
  }

  const oldStatus = await inspectCache(cache, manifest.buildId, manifest.assets);
  return oldStatus.complete ? manifest : null;
}

async function findOldHashedAsset(urlPath) {
  const absoluteUrl = new URL(urlPath, SCOPE_URL).href;
  const cacheNames = await caches.keys();

  for (const cacheName of cacheNames) {
    if (!cacheName.startsWith(CACHE_PREFIX) || cacheName === CACHE_NAME || cacheName.startsWith(STAGING_PREFIX)) continue;
    const oldBuildId = cacheName.slice(CACHE_PREFIX.length);
    if (!/^[a-f0-9]{64}$/.test(oldBuildId)) continue;
    const manifest = await isCompleteOldCache(cacheName);
    if (!manifest) continue;

    const oldAsset = manifest.assets.find(asset =>
      new URL(asset.url, SCOPE_URL).href === absoluteUrl && asset.hashed === true);
    if (!oldAsset) continue;

    const cache = await caches.open(cacheName);
    const response = await cache.match(new URL(oldAsset.url, SCOPE_URL).href);
    if (response) return response;
  }

  return null;
}

function isHashNamedAssetPath(urlPath) {
  return /(?:^|\/)[^/]+-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(urlPath);
}

function recoveryResponse() {
  const scope = JSON.stringify(SCOPE_URL.href);
  const html = `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>オフライン用データが不足しています</title>
<body>
  <main>
    <h1>オフライン用データが不足しています</h1>
    <p>アプリの保存データに不足があります。通信できる状態で、このアプリの登録を解除してから再読み込みしてください。</p>
    <p>この操作では、保存モデルや翻訳設定は削除しません。ページ内の入力と結果は再読み込みで失われます。</p>
    <button id="repair">アプリの登録を解除して再読み込み</button>
    <p id="repair-status" role="status" aria-live="polite"></p>
  </main>
  <script>
    const scope = ${scope};
    document.getElementById('repair').addEventListener('click', async () => {
      const status = document.getElementById('repair-status');
      const button = document.getElementById('repair');
      button.disabled = true;
      status.textContent = '登録を解除しています…';
      try {
        if ('serviceWorker' in navigator) {
          const registration = await navigator.serviceWorker.getRegistration(scope);
          if (registration && registration.scope === scope) await registration.unregister();
        }
      } catch {
        status.textContent = '登録を解除できませんでした。通信状態を確認して、ブラウザーから再読み込みしてください。';
        button.disabled = false;
        return;
      }
      status.textContent = '通信できる状態で再読み込みしています…';
      location.reload();
    });
  </script>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function handleNavigation() {
  const index = await getCachedCurrentIndex();
  return index || recoveryResponse();
}

async function isAppCacheClearActive() {
  const names = await caches.keys();
  if (!names.includes(APP_LOCK_CACHE_NAME)) return false;
  const cache = await caches.open(APP_LOCK_CACHE_NAME);
  const lock = await readJson(cache, APP_LOCK_CACHE_URL);
  if (lock && Number.isFinite(lock.expiresAt) && lock.expiresAt > Date.now()) return true;
  await caches.delete(APP_LOCK_CACHE_NAME);
  return false;
}

async function createAppCacheClearLock() {
  const cache = await caches.open(APP_LOCK_CACHE_NAME);
  await cache.put(APP_LOCK_CACHE_URL, jsonResponse({ expiresAt: Date.now() + 60_000 }));
}

async function clearOwnAppCaches() {
  await createAppCacheClearLock();
  try {
    if (await isAppCacheClearActive() === false) throw new Error('App cache clear lock expired');
    if (preparationPromise) throw new Error('App cache preparation is running');
    if (!isOwnActiveWorker() || self.registration.installing || self.registration.waiting) {
      throw new Error('Service worker update is running');
    }

    await self.registration.unregister();
    const cacheNames = await caches.keys();
    const appCacheNames = cacheNames.filter(cacheName =>
      cacheName.startsWith(CACHE_PREFIX) && cacheName !== APP_LOCK_CACHE_NAME);
    await Promise.all(appCacheNames.map(cacheName => caches.delete(cacheName)));
  } finally {
    await caches.delete(APP_LOCK_CACHE_NAME);
  }
}

function isOwnActiveWorker() {
  const active = self.registration.active;
  return Boolean(active && active.scriptURL === self.location.href && active.state === 'activated');
}

async function handleAssetRequest(event, url) {
  const currentAsset = ASSET_BY_URL.get(url.pathname);
  if (currentAsset) {
    const cacheNames = await caches.keys();
    if (cacheNames.includes(CACHE_NAME)) {
      const currentCache = await caches.open(CACHE_NAME);
      const currentResponse = await currentCache.match(currentAsset.url);
      if (currentResponse) return currentResponse;
    }
  }

  if (isHashNamedAssetPath(url.pathname)) {
    const oldResponse = await findOldHashedAsset(url.pathname);
    if (oldResponse) return oldResponse;
  }

  return fetch(event.request);
}

async function handleMessage(event) {
  const message = event.data;
  if (!message || typeof message.type !== 'string') return;

  const knownRequest = ['GET_STATUS', 'PREPARE_APP_CACHE', 'ACTIVATE_UPDATE', 'CLEAR_APP_CACHE'].includes(message.type);
  if (!knownRequest || !hasValidRequestEnvelope(message)) {
    replyResult(event, message, false, { reason: 'invalid-request' });
    return;
  }
  if (message.type === 'GET_STATUS' && message.targetBuildId !== null) {
    replyResult(event, message, false, { reason: 'invalid-request' });
    return;
  }

  const source = getSourceWindow(event);
  if (!source) {
    replyResult(event, message, false, { reason: 'invalid-client' });
    return;
  }

  if (message.type === 'GET_STATUS') {
    replyStatus(event, message, await getCurrentCacheStatus());
    return;
  }

  if (message.type === 'PREPARE_APP_CACHE') {
    if (message.targetBuildId !== BUILD_ID) {
      replyResult(event, message, false, { ...await getCurrentCacheStatus(), reason: 'build-mismatch' });
      return;
    }

    try {
      const status = await prepareCurrentBuildCache();
      replyResult(event, message, status.complete, status);
    } catch {
      replyResult(event, message, false, { ...await getCurrentCacheStatus(), reason: 'precache-failed' });
    }
    return;
  }

  if (message.type === 'ACTIVATE_UPDATE') {
    if (message.targetBuildId !== BUILD_ID) {
      replyResult(event, message, false, { reason: 'build-mismatch' });
      return;
    }
    const appClients = await getAppWindowClients();
    const waitingWorker = self.registration.waiting;
    if (!waitingWorker || waitingWorker.scriptURL !== self.location.href || waitingWorker.state !== 'installed') {
      replyResult(event, message, false, { reason: 'not-waiting' });
      return;
    }
    if (appClients.length !== 1 || appClients[0].id !== source.id) {
      replyResult(event, message, false, { reason: 'multiple-clients' });
      return;
    }

    const status = await getCurrentCacheStatus();
    if (!status.complete) {
      replyResult(event, message, false, { ...status, reason: 'incomplete-cache' });
      return;
    }

    const activation = self.skipWaiting();
    replyResult(event, message, true, status);
    await activation;
    return;
  }

  if (message.type === 'CLEAR_APP_CACHE') {
    if (message.targetBuildId !== BUILD_ID) {
      replyResult(event, message, false, { reason: 'build-mismatch' });
      return;
    }
    const appClients = await getAppWindowClients();
    if (appClients.length !== 1 || appClients[0].id !== source.id) {
      replyResult(event, message, false, { reason: 'multiple-clients' });
      return;
    }

    try {
      await clearOwnAppCaches();
      replyResult(event, message, true);
    } catch (error) {
      const reason = error instanceof Error && /running|active/i.test(error.message) ? 'app-cache-busy' : 'cache-error';
      replyResult(event, message, false, { reason });
    }
  }
}

self.addEventListener('install', event => {
  event.waitUntil(prepareCurrentBuildCache());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const appClients = await getAppWindowClients();
      if (appClients.length > 0) return;

      const cacheNames = await caches.keys();
      const oldCacheNames = cacheNames.filter(cacheName => cacheName.startsWith(CACHE_PREFIX) && cacheName !== CACHE_NAME);
      await Promise.all(oldCacheNames.map(cacheName => caches.delete(cacheName)));
    } catch {
      // Cache cleanup is best-effort. A cleanup failure must not block this worker from activating.
    }
  })());
});

self.addEventListener('message', event => {
  event.waitUntil(handleMessage(event));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== SCOPE_URL.origin || !url.pathname.startsWith(SCOPE_URL.pathname)) return;

  if (event.request.mode === 'navigate' &&
      (url.pathname === SCOPE_URL.pathname || url.pathname === INDEX_PATH)) {
    event.respondWith(handleNavigation());
    return;
  }

  if (ASSET_BY_URL.has(url.pathname) || isHashNamedAssetPath(url.pathname)) {
    event.respondWith(handleAssetRequest(event, url));
  }
});
