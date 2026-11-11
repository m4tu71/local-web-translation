import assert from 'node:assert/strict';
import test from 'node:test';
import { OfflineClient } from '../src/offline/client.ts';

const ORIGIN = 'https://example.test';
const BASE_PATH = '/local-web-translation/';
const PAGE_BUILD_ID = 'page-build-a';
const SCOPE_URL = `${ORIGIN}${BASE_PATH}`;
const WORKER_URL = `${SCOPE_URL}service-worker.js`;

function createAssetStatus(buildId, complete) {
  return {
    buildId,
    complete,
    resourceCount: complete ? 4 : 2,
    totalBytes: complete ? 2048 : 1024,
    missing: complete ? [] : [`${BASE_PATH}missing.js`],
  };
}

class MockEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ type, target: this });
    }
  }
}

class MockServiceWorker extends MockEventTarget {
  constructor({
    buildId = PAGE_BUILD_ID,
    complete = true,
    scriptURL = WORKER_URL,
    state = 'activated',
    onRequest,
    mutateReply,
    dropRequests = [],
  } = {}) {
    super();
    this.buildId = buildId;
    this.status = createAssetStatus(buildId, complete);
    this.scriptURL = scriptURL;
    this.state = state;
    this.onRequest = onRequest;
    this.mutateReply = mutateReply;
    this.dropRequests = new Set(dropRequests);
    this.requests = [];
    this.transferredPorts = [];
    this.ports = new Set();
  }

  postMessage(message, transfer = []) {
    this.requests.push({ ...message });
    const port = transfer[0];
    this.transferredPorts.push(port);
    if (!port || typeof port.postMessage !== 'function') {
      throw new Error('The client did not transfer a MessagePort.');
    }
    this.ports.add(port);

    if (this.dropRequests.has(message.type)) {
      port.close();
      return;
    }

    Promise.resolve()
      .then(() => this.createReply(message))
      .then(async reply => {
        if (reply === undefined) return;
        const response = this.mutateReply ? this.mutateReply(message, reply) : reply;
        port.postMessage(response);
      })
      .catch(() => {})
      .finally(() => port.close());
  }

  async createReply(message) {
    const envelope = {
      protocolVersion: message.protocolVersion,
      requestId: message.requestId,
      requestType: message.type,
      pageBuildId: message.pageBuildId,
      targetBuildId: message.targetBuildId,
      buildId: this.buildId,
    };

    if (message.type === 'GET_STATUS') {
      return { type: 'STATUS', ...envelope, ...this.status };
    }

    if (message.type === 'PREPARE_APP_CACHE') {
      if (message.targetBuildId !== this.buildId) {
        return { type: 'RESULT', ...envelope, ok: false, reason: 'build-mismatch' };
      }
      this.status = createAssetStatus(this.buildId, true);
      return { type: 'RESULT', ...envelope, ...this.status, ok: true };
    }

    if (message.type === 'ACTIVATE_UPDATE') {
      if (message.targetBuildId !== this.buildId) {
        return { type: 'RESULT', ...envelope, ok: false, reason: 'build-mismatch' };
      }
      const result = { type: 'RESULT', ...envelope, ok: true };
      return this.onRequest ? this.onRequest(message, result, this) : result;
    }

    if (message.type === 'CLEAR_APP_CACHE') {
      if (message.targetBuildId !== this.buildId) {
        return { type: 'RESULT', ...envelope, ok: false, reason: 'build-mismatch' };
      }
      const result = { type: 'RESULT', ...envelope, ok: true };
      return this.onRequest ? this.onRequest(message, result, this) : result;
    }

    return { type: 'RESULT', ...envelope, ok: false, reason: 'invalid-request' };
  }

  closePorts() {
    for (const port of this.ports) port.close();
    this.ports.clear();
  }
}

class MockServiceWorkerRegistration extends MockEventTarget {
  constructor({ scope, active = null, waiting = null, installing = null, onUpdate } = {}) {
    super();
    this.scope = scope;
    this.active = active;
    this.waiting = waiting;
    this.installing = installing;
    this.onUpdate = onUpdate;
    this.calls = { update: 0, unregister: 0 };
    this.container = undefined;
  }

  update() {
    this.calls.update++;
    return this.onUpdate ? this.onUpdate() : Promise.resolve(this);
  }

  unregister() {
    this.calls.unregister++;
    this.container?.removeRegistration(this);
    return Promise.resolve(true);
  }
}

class MockServiceWorkerContainer extends MockEventTarget {
  constructor({ registrations = [], controller = null, onRegister } = {}) {
    super();
    this.registrations = [];
    this.controller = controller;
    this.onRegister = onRegister;
    this.calls = { getRegistration: [], register: [] };
    this.workers = new Set();
    for (const registration of registrations) this.addRegistration(registration);
  }

  addRegistration(registration) {
    registration.container = this;
    this.registrations.push(registration);
    for (const worker of [registration.active, registration.waiting, registration.installing]) {
      if (worker) this.workers.add(worker);
    }
    return registration;
  }

  removeRegistration(registration) {
    this.registrations = this.registrations.filter(item => item !== registration);
  }

  getRegistration(clientUrl) {
    this.calls.getRegistration.push(clientUrl);
    const client = new URL(clientUrl);
    const candidates = this.registrations.filter(registration => {
      const scope = new URL(registration.scope);
      return scope.origin === client.origin && client.pathname.startsWith(scope.pathname);
    });
    candidates.sort((left, right) => right.scope.length - left.scope.length);
    return Promise.resolve(candidates[0]);
  }

  register(scriptURL, options) {
    const call = { scriptURL, scope: options.scope };
    this.calls.register.push(call);
    if (!this.onRegister) return Promise.reject(new Error('No registration factory was configured.'));
    const registration = this.onRegister(call);
    this.addRegistration(registration);
    return Promise.resolve(registration);
  }

  closePorts() {
    for (const worker of this.workers) worker.closePorts();
    for (const registration of this.registrations) {
      for (const worker of [registration.active, registration.waiting, registration.installing]) {
        worker?.closePorts();
      }
    }
  }
}

class MockBroadcastChannel {
  static instances = [];

  constructor(name) {
    this.name = name;
    this.onmessage = null;
    this.closed = false;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(message) {
    if (message.type === 'CLIENT_PROBE') {
      this.onmessage?.({ data: {
        type: 'CLIENT_PROBE_RESPONSE',
        requestId: message.requestId,
        clientId: 'another-app-tab',
      } });
    }
  }

  close() {
    this.closed = true;
  }
}

function createRegistration({
  scope = SCOPE_URL,
  active,
  waiting,
  installing,
  onUpdate,
} = {}) {
  return new MockServiceWorkerRegistration({ scope, active, waiting, installing, onUpdate });
}

function createEnvironment(serviceWorker, {
  basePath = BASE_PATH,
  pageBuildId = PAGE_BUILD_ID,
  BroadcastChannel,
} = {}) {
  let reloadCount = 0;
  const location = {
    href: `${ORIGIN}${basePath}`,
    protocol: 'https:',
    reload() { reloadCount++; },
  };
  const environment = {
    serviceWorker,
    document: {
      querySelector(selector) {
        assert.equal(selector, 'meta[name="offline-build"]');
        return { content: pageBuildId };
      },
    },
    location,
    secureContext: true,
    development: false,
    baseUrl: basePath,
    BroadcastChannel,
  };
  return { environment, getReloadCount: () => reloadCount };
}

function createClient(serviceWorker, environmentOptions = {}, clientOptions = {}) {
  const { environment, getReloadCount } = createEnvironment(serviceWorker, environmentOptions);
  const client = new OfflineClient(environment, {
    timeoutMs: 500,
    prepareTimeoutMs: 1000,
    peerResponseMs: 5,
    ...clientOptions,
  });
  return {
    client,
    getReloadCount,
    dispose() {
      client.dispose();
      serviceWorker.closePorts();
    },
  };
}

async function withClient(serviceWorker, environmentOptions, clientOptions, run) {
  const harness = createClient(serviceWorker, environmentOptions, clientOptions);
  try {
    await run(harness.client, harness);
  } finally {
    harness.dispose();
  }
}

test('startup only looks up this scope and never registers or reloads', async () => {
  const serviceWorker = new MockServiceWorkerContainer();

  await withClient(serviceWorker, {}, {}, async (client, harness) => {
    await client.initialize();

    assert.deepEqual(serviceWorker.calls.getRegistration, [SCOPE_URL]);
    assert.deepEqual(serviceWorker.calls.register, []);
    assert.equal(harness.getReloadCount(), 0);
    assert.equal(client.getState().phase, 'unprepared');
  });
});

test('explicit preparation registers only the application scope and can finish without a controller or reload', async () => {
  const serviceWorker = new MockServiceWorkerContainer({
    onRegister({ scope }) {
      const active = new MockServiceWorker({ complete: false });
      return createRegistration({ scope, active });
    },
  });

  await withClient(serviceWorker, {}, {}, async (client, harness) => {
    await client.prepare();

    assert.deepEqual(serviceWorker.calls.register, [{ scriptURL: WORKER_URL, scope: SCOPE_URL }]);
    const prepareRequest = serviceWorker.calls.register.length &&
      serviceWorker.registrations[0].active.requests.find(request => request.type === 'PREPARE_APP_CACHE');
    assert.ok(prepareRequest);
    assert.equal(prepareRequest.targetBuildId, PAGE_BUILD_ID);
    assert.equal(prepareRequest.pageBuildId, PAGE_BUILD_ID);
    assert.equal(client.getState().controller, undefined);
    assert.equal(client.getState().active?.complete, true);
    assert.equal(harness.getReloadCount(), 0);
  });
});

test('preparation repairs an incomplete existing current-build cache', async () => {
  const active = new MockServiceWorker({ complete: false });
  const registration = createRegistration({ active });
  const serviceWorker = new MockServiceWorkerContainer({ registrations: [registration] });

  await withClient(serviceWorker, {}, {}, async client => {
    await client.refresh();
    await client.prepare();

    assert.deepEqual(serviceWorker.calls.register, []);
    assert.equal(registration.calls.update, 1);
    assert.equal(active.requests.filter(request => request.type === 'PREPARE_APP_CACHE').length, 1);
    assert.equal(client.getState().active?.complete, true);
  });
});

test('waiting build repair targets the worker build while identifying the current page build', async () => {
  const active = new MockServiceWorker({ buildId: 'page-build-old', complete: true });
  const waiting = new MockServiceWorker({
    buildId: 'page-build-new',
    complete: false,
    state: 'installed',
  });
  const registration = createRegistration({ active, waiting });
  const serviceWorker = new MockServiceWorkerContainer({ registrations: [registration] });

  await withClient(serviceWorker, { pageBuildId: 'page-build-old' }, {}, async client => {
    await client.refresh();
    await client.repairWaitingUpdate();

    const prepareRequest = waiting.requests.find(request => request.type === 'PREPARE_APP_CACHE');
    assert.ok(prepareRequest);
    assert.equal(prepareRequest.pageBuildId, 'page-build-old');
    assert.equal(prepareRequest.targetBuildId, 'page-build-new');
    assert.equal(prepareRequest.protocolVersion, 1);
    assert.equal(active.requests.some(request => request.type === 'PREPARE_APP_CACHE'), false);
    assert.equal(client.getState().active?.buildId, 'page-build-old');
    assert.equal(client.getState().waiting?.complete, true);
  });
});

test('waiting update activation waits for the target active worker, not controllerchange or reload', async () => {
  const oldActive = new MockServiceWorker({ buildId: 'page-build-old', complete: true });
  const nextWorker = new MockServiceWorker({ buildId: 'page-build-new', complete: true, state: 'installed' });
  const registration = createRegistration({ active: oldActive, waiting: nextWorker });
  nextWorker.onRequest = (message, reply) => {
    if (message.type !== 'ACTIVATE_UPDATE') return reply;
    registration.active = nextWorker;
    registration.waiting = null;
    nextWorker.state = 'activated';
    return reply;
  };
  const serviceWorker = new MockServiceWorkerContainer({ registrations: [registration] });
  const harness = createClient(serviceWorker, { pageBuildId: 'page-build-old' }, { timeoutMs: 1000 });

  try {
    await harness.client.refresh();
    await harness.client.activateUpdate();

    const activationRequest = nextWorker.requests.find(request => request.type === 'ACTIVATE_UPDATE');
    assert.ok(activationRequest);
    assert.equal(activationRequest.protocolVersion, 1);
    assert.equal(activationRequest.targetBuildId, 'page-build-new');
    assert.equal(activationRequest.pageBuildId, 'page-build-old');
    assert.equal(harness.client.getState().active?.buildId, 'page-build-new');
    assert.equal(harness.client.getState().controller, undefined);
    assert.equal(harness.getReloadCount(), 0);
  } finally {
    harness.dispose();
  }
});

test('a multiple-client response refuses to activate a waiting update', async () => {
  const active = new MockServiceWorker({ buildId: 'page-build-old', complete: true });
  const waiting = new MockServiceWorker({
    buildId: 'page-build-new',
    complete: true,
    state: 'installed',
    onRequest: (_message, reply) => ({ ...reply, ok: false, reason: 'multiple-clients' }),
  });
  const registration = createRegistration({ active, waiting });
  const serviceWorker = new MockServiceWorkerContainer({ registrations: [registration] });

  await withClient(serviceWorker, { pageBuildId: 'page-build-old' }, {}, async client => {
    await client.refresh();

    await assert.rejects(client.activateUpdate(), { code: 'multiple-clients' });
    assert.equal(registration.active, active);
    assert.equal(registration.waiting, waiting);
    assert.equal(waiting.requests.filter(request => request.type === 'ACTIVATE_UPDATE').length, 1);
  });
});

test('cache removal waits when another app tab responds and sends no clear request', async () => {
  MockBroadcastChannel.instances = [];
  const active = new MockServiceWorker({ complete: true });
  const registration = createRegistration({ active });
  const serviceWorker = new MockServiceWorkerContainer({ registrations: [registration] });

  await withClient(serviceWorker, { BroadcastChannel: MockBroadcastChannel }, { peerResponseMs: 1 }, async client => {
    await client.refresh();

    await assert.rejects(client.clearAppCache(), { code: 'multiple-clients' });
    assert.equal(active.requests.some(request => request.type === 'CLEAR_APP_CACHE'), false);
    assert.equal(registration.calls.unregister, 0);
    assert.ok(MockBroadcastChannel.instances.some(channel => channel.closed));
  });
});

test('clearing app cache does not access model storage or translation settings and preparation can run again', async () => {
  let opfsAccesses = 0;
  let settingsAccesses = 0;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory() { opfsAccesses++; } } },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      settingsAccesses++;
      return { getItem() {}, setItem() {} };
    },
  });

  const active = new MockServiceWorker({ complete: true });
  const registration = createRegistration({ active });
  active.onRequest = async (message, reply) => {
    if (message.type === 'CLEAR_APP_CACHE') await registration.unregister();
    return reply;
  };
  const serviceWorker = new MockServiceWorkerContainer({
    registrations: [registration],
    onRegister({ scope }) {
      return createRegistration({ scope, active: new MockServiceWorker({ complete: true }) });
    },
  });
  const harness = createClient(serviceWorker);

  try {
    await harness.client.refresh();
    await harness.client.clearAppCache();
    assert.equal(harness.client.getState().cacheCleared, true);
    assert.equal(opfsAccesses, 0);
    assert.equal(settingsAccesses, 0);

    await harness.client.prepare();
    assert.equal(serviceWorker.calls.register.length, 1);
    assert.equal(harness.client.getState().cacheCleared, false);
    assert.equal(opfsAccesses, 0);
    assert.equal(settingsAccesses, 0);
  } finally {
    harness.dispose();
    restoreGlobal('navigator', previousNavigator);
    restoreGlobal('localStorage', previousLocalStorage);
  }
});

test('a foreign ancestor registration is left alone while preparation registers the app child scope', async () => {
  const foreignWorker = new MockServiceWorker({ scriptURL: `${ORIGIN}/other-app-worker.js` });
  const foreignRegistration = createRegistration({ scope: `${ORIGIN}/`, active: foreignWorker });
  const serviceWorker = new MockServiceWorkerContainer({
    registrations: [foreignRegistration],
    onRegister({ scope }) {
      return createRegistration({ scope, active: new MockServiceWorker({ complete: true }) });
    },
  });

  await withClient(serviceWorker, {}, {}, async client => {
    await client.prepare();

    assert.deepEqual(serviceWorker.calls.register, [{ scriptURL: WORKER_URL, scope: SCOPE_URL }]);
    assert.equal(foreignRegistration.calls.update, 0);
    assert.equal(foreignRegistration.calls.unregister, 0);
    assert.deepEqual(foreignWorker.requests, []);
  });
});

test('a foreign exact-scope registration blocks registration without updating or unregistering it', async () => {
  const foreignWorker = new MockServiceWorker({ scriptURL: `${ORIGIN}/other-app-worker.js` });
  const foreignRegistration = createRegistration({ scope: SCOPE_URL, active: foreignWorker });
  const serviceWorker = new MockServiceWorkerContainer({ registrations: [foreignRegistration] });

  await withClient(serviceWorker, {}, {}, async client => {
    await assert.rejects(client.prepare(), { code: 'scope-conflict' });

    assert.deepEqual(serviceWorker.calls.register, []);
    assert.equal(foreignRegistration.calls.update, 0);
    assert.equal(foreignRegistration.calls.unregister, 0);
    assert.deepEqual(foreignWorker.requests, []);
    assert.equal(client.getState().registered, false);
    assert.equal(client.getState().phase, 'error');
  });
});

test('status requests use the echoed protocol envelope and a real transferred MessagePort', async () => {
  const active = new MockServiceWorker({ complete: true });
  const registration = createRegistration({ active });
  const serviceWorker = new MockServiceWorkerContainer({ registrations: [registration], controller: active });

  await withClient(serviceWorker, {}, {}, async client => {
    await client.refresh();

    const request = active.requests[0];
    assert.equal(request.type, 'GET_STATUS');
    assert.equal(request.protocolVersion, 1);
    assert.equal(request.requestId.length > 0, true);
    assert.equal(request.pageBuildId, PAGE_BUILD_ID);
    assert.equal(request.targetBuildId, null);
    assert.ok(active.transferredPorts[0]);
    assert.equal(typeof active.transferredPorts[0].postMessage, 'function');
    assert.deepEqual(client.getState().controller, {
      buildId: PAGE_BUILD_ID,
      complete: true,
      resourceCount: 4,
      totalBytes: 2048,
      missing: [],
    });
  });
});

test('wrong response correlation and status timeouts become visible without hanging', async t => {
  await t.test('wrong request ID is rejected', async () => {
    const active = new MockServiceWorker({
      complete: true,
      mutateReply: (_message, reply) => ({ ...reply, requestId: 'wrong-request' }),
    });
    const serviceWorker = new MockServiceWorkerContainer({
      registrations: [createRegistration({ active })],
      controller: active,
    });

    await withClient(serviceWorker, {}, {}, async client => {
      await client.refresh();
      assert.match(client.getState().controllerError, /別の要求/);
      assert.equal(client.getState().error?.code, 'controller-status');
    });
  });

  await t.test('a missing status response times out', async () => {
    const active = new MockServiceWorker({ complete: true, dropRequests: ['GET_STATUS'] });
    const serviceWorker = new MockServiceWorkerContainer({
      registrations: [createRegistration({ active })],
      controller: active,
    });

    await withClient(serviceWorker, {}, { timeoutMs: 12 }, async client => {
      await client.refresh();
      assert.match(client.getState().controllerError, /時間がかかっています/);
      assert.equal(client.getState().error?.code, 'controller-status');
    });
  });
});

test('redundant workers are not queried and a controller without an owned registration remains unregistered', async () => {
  const redundant = new MockServiceWorker({ state: 'redundant' });
  const redundantRegistration = createRegistration({ active: redundant });
  const containerWithRedundant = new MockServiceWorkerContainer({
    registrations: [redundantRegistration],
    controller: redundant,
  });

  await withClient(containerWithRedundant, {}, {}, async client => {
    await client.refresh();
    assert.deepEqual(redundant.requests, []);
    assert.equal(client.getState().active, undefined);
  });

  const controller = new MockServiceWorker({ complete: true });
  const containerWithoutRegistration = new MockServiceWorkerContainer({ controller });
  await withClient(containerWithoutRegistration, {}, {}, async client => {
    await client.refresh();
    assert.equal(client.getState().registered, false);
    assert.equal(client.getState().controller?.buildId, PAGE_BUILD_ID);
  });
});

test('a waiting status failure does not erase the current controller status', async () => {
  const active = new MockServiceWorker({ buildId: 'page-build-old', complete: true });
  const waiting = new MockServiceWorker({
    buildId: 'page-build-new',
    complete: true,
    state: 'installed',
    mutateReply: (_message, reply) => ({ ...reply, requestId: 'wrong-waiting-request' }),
  });
  const serviceWorker = new MockServiceWorkerContainer({
    registrations: [createRegistration({ active, waiting })],
    controller: active,
  });

  await withClient(serviceWorker, { pageBuildId: 'page-build-old' }, {}, async client => {
    await client.refresh();

    assert.equal(client.getState().controller?.buildId, 'page-build-old');
    assert.equal(client.getState().active?.buildId, 'page-build-old');
    assert.equal(client.getState().waiting, undefined);
    assert.match(client.getState().waitingError, /別の要求/);
    assert.equal(client.getState().registered, true);
  });
});

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}
