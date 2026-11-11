import test from 'node:test';
import assert from 'node:assert/strict';
import { describeOffline, mountOffline } from '../src/ui/offline.ts';
import { createFakeDocument, deferred, flushTasks, withFakeDom } from './helpers/fake-dom.mjs';

const NOW = 2_000_000_000_000;
const CURRENT_BUILD = 'build-current';

function assetStatus(buildId = CURRENT_BUILD, overrides = {}) {
  return {
    buildId,
    complete: true,
    resourceCount: 12,
    totalBytes: 30_000_000,
    ...overrides,
  };
}

function clientState(overrides = {}) {
  return {
    phase: 'available',
    supported: true,
    currentBuildId: CURRENT_BUILD,
    registered: true,
    cacheCleared: false,
    controller: assetStatus(),
    active: assetStatus(),
    waiting: undefined,
    ...overrides,
  };
}

function modelState(overrides = {}) {
  return {
    phase: 'ready',
    storageMode: 'opfs',
    cache: {
      available: true,
      cached: true,
      bytes: 573_123_200,
      lastUsed: NOW - 1000,
      expiresAt: NOW + 7 * 24 * 60 * 60 * 1000,
      retentionDays: 7,
    },
    ...overrides,
  };
}

function sessionState(overrides = {}) {
  return {
    operation: 'idle',
    cancelling: false,
    engine: { phase: 'ready', modelLoaded: true },
    hasModelFile: true,
    modelInUse: true,
    logs: [],
    ...overrides,
  };
}

function describe(client = clientState(), model = modelState(), session = sessionState(), options = {}) {
  return describeOffline(client, model, session, {
    online: true,
    now: NOW,
    hasMemoryModel: false,
    otherClientCount: 0,
    ...options,
  });
}

test('offline readiness requires the registered current build and an unexpired OPFS model', () => {
  assert.equal(describe().ready, true);

  const memoryModel = modelState({ storageMode: 'memory' });
  const memoryView = describe(clientState(), memoryModel, sessionState(), { hasMemoryModel: true });
  assert.equal(memoryView.ready, false);
  assert.match(memoryView.summary, /メモリだけ/);

  const unregistered = describe(clientState({ registered: false }), modelState());
  assert.equal(unregistered.ready, false);
  assert.equal(unregistered.canPrepare, true);

  const expired = describe(clientState(), modelState({
    cache: { ...modelState().cache, expiresAt: NOW },
  }));
  assert.equal(expired.ready, false);
  assert.match(expired.status, /期限が切れています/);
});

test('update availability stays separate from current offline readiness and expiry', () => {
  const updated = describe(clientState({ waiting: assetStatus('build-next') }));
  assert.equal(updated.ready, true);
  assert.equal(updated.updateAvailable, true);

  const expired = describe(clientState({ waiting: assetStatus('build-next') }), modelState({
    cache: { ...modelState().cache, expiresAt: NOW - 1 },
  }));
  assert.equal(expired.ready, false);
  assert.equal(expired.updateAvailable, true);
  assert.match(expired.status, /期限が切れています/);

  const incompleteUpdate = describe(clientState({
    waiting: assetStatus('build-next', { complete: false }),
  }));
  assert.equal(incompleteUpdate.updateAvailable, false);
  assert.equal(incompleteUpdate.waitingUpdateIncomplete, true);
  assert.equal(incompleteUpdate.canRetry, true);
});

test('browser offline indicator alone never reports offline readiness', () => {
  const state = clientState({ registered: false, controller: undefined, active: undefined });
  const view = describe(state, modelState({ cache: { ...modelState().cache, cached: false } }), sessionState(), {
    online: false,
  });
  assert.equal(view.ready, false);
  assert.doesNotMatch(view.summary, /利用中です/);
  assert.match(view.help, /オフラインと表示/);
});

test('translation and model operations disable update and app-cache deletion controls', () => {
  const translating = describe(clientState({ waiting: assetStatus('build-next') }), modelState(), sessionState({
    operation: 'translating',
  }));
  assert.equal(translating.busy, true);
  assert.equal(translating.canClear, false);
  assert.match(translating.busyReason, /翻訳中/);

  const downloading = describe(clientState(), modelState({ phase: 'downloading' }), sessionState());
  assert.equal(downloading.busy, true);
  assert.equal(downloading.canClear, false);
  assert.match(downloading.busyReason, /モデルの取得中/);
});

const OFFLINE_UI_IDS = [
  'offline-summary', 'offline-status', 'offline-help', 'offline-prepare', 'offline-retry', 'offline-open-model',
  'offline-disabled-reason', 'offline-error', 'offline-reload-confirmation', 'offline-reload-confirm',
  'offline-reload-cancel', 'offline-update', 'offline-update-disabled-reason', 'offline-update-confirmation',
  'offline-update-confirm', 'offline-update-cancel', 'offline-clear', 'offline-clear-disabled-reason',
  'offline-clear-confirmation', 'offline-clear-confirm', 'offline-clear-cancel', 'model-settings', 'model-download',
  'model-status', 'workspace', 'preparation-banner', 'translation-input',
];

class FakeOfflineClient {
  listeners = new Set();
  initializeCalls = 0;
  prepareCalls = 0;
  activateCalls = 0;
  clearCalls = 0;
  repairCalls = 0;
  otherClientCount = 0;
  prepareTask;
  activateTask;
  clearTask;

  constructor(state = clientState({ registered: false, controller: undefined, active: undefined })) {
    this.state = state;
  }

  getState() { return this.state; }
  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
  publish(state) {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
  initialize() { this.initializeCalls++; return Promise.resolve(); }
  refresh() { return Promise.resolve(); }
  countOtherClients() { return Promise.resolve(this.otherClientCount); }
  async prepare() {
    this.prepareCalls++;
    if (this.prepareTask) await this.prepareTask.promise;
    this.publish({
      ...this.state,
      phase: 'available',
      registered: true,
      active: assetStatus(),
      controller: undefined,
    });
  }
  async activateUpdate() {
    this.activateCalls++;
    if (this.activateTask) await this.activateTask.promise;
    this.publish({
      ...this.state,
      active: assetStatus('build-next'),
      waiting: undefined,
    });
  }
  async clearAppCache() {
    this.clearCalls++;
    if (this.clearTask) await this.clearTask.promise;
    this.publish({ ...this.state, registered: false, cacheCleared: true });
  }
  async repairWaitingUpdate() {
    this.repairCalls++;
    this.publish({ ...this.state, waiting: assetStatus('build-next') });
  }
  dispose() {}
}

function createModelPort(initialState = modelState()) {
  const listeners = new Set();
  return {
    state: initialState,
    hasMemory: false,
    getState() { return this.state; },
    hasMemoryModel() { return this.hasMemory; },
    subscribe(listener) {
      listeners.add(listener);
      listener(this.state);
      return () => listeners.delete(listener);
    },
    publish(state) {
      this.state = state;
      for (const listener of listeners) listener(state);
    },
  };
}

function createSessionPort(initialState = sessionState()) {
  const listeners = new Set();
  return {
    state: initialState,
    getState() { return this.state; },
    subscribe(listener) {
      listeners.add(listener);
      listener(this.state);
      return () => listeners.delete(listener);
    },
    publish(state) {
      this.state = state;
      for (const listener of listeners) listener(state);
    },
  };
}

async function withWindow(document, callback) {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const listeners = new Map();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener(type, listener) {
        const current = listeners.get(type) ?? [];
        current.push(listener);
        listeners.set(type, current);
      },
      removeEventListener(type, listener) {
        listeners.set(type, (listeners.get(type) ?? []).filter(existing => existing !== listener));
      },
    },
  });
  try {
    await withFakeDom(document, callback);
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
    else delete globalThis.window;
  }
}

test('initial preparation asks before reloading and only reloads after confirmation', async t => {
  const document = createFakeDocument(OFFLINE_UI_IDS);
  const client = new FakeOfflineClient();
  const model = createModelPort();
  const session = createSessionPort();
  let reloads = 0;
  await withWindow(document, async () => {
    const dispose = mountOffline(client, model, session, { now: () => NOW, reload: () => { reloads++; } });
    t.after(dispose);
    await flushTasks();
    assert.equal(client.initializeCalls, 1);
    assert.equal(client.prepareCalls, 0);
    assert.equal(document.getElementById('offline-prepare').hidden, false);

    document.getElementById('offline-prepare').dispatch('click');
    await flushTasks();
    assert.equal(client.prepareCalls, 1);
    assert.equal(document.getElementById('offline-reload-confirmation').hidden, false);
    assert.equal(reloads, 0);

    document.getElementById('offline-reload-confirm').dispatch('click');
    assert.equal(reloads, 1);
  });
});

test('update locks the translation and model areas, then rechecks busy state before reload', async t => {
  const document = createFakeDocument(OFFLINE_UI_IDS);
  const client = new FakeOfflineClient(clientState({ waiting: assetStatus('build-next') }));
  const model = createModelPort();
  const session = createSessionPort();
  const activation = deferred();
  client.activateTask = activation;
  let reloads = 0;
  await withWindow(document, async () => {
    const dispose = mountOffline(client, model, session, { now: () => NOW, reload: () => { reloads++; } });
    t.after(dispose);
    await flushTasks();
    document.getElementById('offline-update').dispatch('click');
    assert.equal(document.getElementById('offline-update-confirmation').hidden, false);
    document.getElementById('offline-update-confirm').dispatch('click');
    await flushTasks();
    assert.equal(client.activateCalls, 1);
    assert.equal(document.getElementById('workspace').inert, true);
    assert.equal(document.getElementById('model-settings').inert, true);
    assert.equal(reloads, 0);

    session.publish(sessionState({ operation: 'translating' }));
    activation.resolve();
    await flushTasks();
    assert.equal(reloads, 0);
    assert.equal(document.getElementById('workspace').inert, false);
    assert.equal(document.getElementById('offline-reload-confirmation').hidden, false);
    assert.equal(document.getElementById('offline-reload-confirm').disabled, true);

    session.publish(sessionState());
    document.getElementById('offline-reload-confirm').dispatch('click');
    assert.equal(reloads, 1);
  });
});

test('app-cache deletion requires confirmation, blocks new work, and leaves model state alone', async t => {
  const document = createFakeDocument(OFFLINE_UI_IDS);
  const client = new FakeOfflineClient();
  client.publish(clientState());
  const model = createModelPort();
  const session = createSessionPort();
  const deletion = deferred();
  client.clearTask = deletion;
  const initialModelState = model.getState();
  await withWindow(document, async () => {
    const dispose = mountOffline(client, model, session, { now: () => NOW, reload: () => {} });
    t.after(dispose);
    await flushTasks();
    document.getElementById('offline-clear').dispatch('click');
    assert.equal(document.getElementById('offline-clear-confirmation').hidden, false);

    session.publish(sessionState({ operation: 'translating' }));
    assert.equal(document.getElementById('offline-clear-confirm').disabled, true);
    document.getElementById('offline-clear-confirm').dispatch('click');
    assert.equal(client.clearCalls, 0);

    session.publish(sessionState());
    document.getElementById('offline-clear-confirm').dispatch('click');
    await flushTasks();
    assert.equal(client.clearCalls, 1);
    assert.equal(document.getElementById('workspace').inert, true);
    assert.equal(document.getElementById('model-settings').inert, true);
    deletion.resolve();
    await flushTasks();
    assert.equal(document.getElementById('workspace').inert, false);
    assert.equal(model.getState(), initialModelState);
  });
});
