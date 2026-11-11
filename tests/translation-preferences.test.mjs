import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTranslationPreferenceStore,
  DEFAULT_TRANSLATION_PREFERENCES,
  TRANSLATION_PREFERENCES_STORAGE_KEY,
} from '../src/storage/translation-preferences.ts';

function createMemoryStorage(initialValues = new Map()) {
  const values = new Map(initialValues);
  const calls = { reads: [], writes: [] };
  return {
    calls,
    values,
    getItem(key) {
      calls.reads.push(key);
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      calls.writes.push({ key, value });
      values.set(key, value);
    },
    removeItem(key) {
      calls.removals = (calls.removals ?? []).concat(key);
      values.delete(key);
    },
  };
}

test('preferences default on first use without writing to storage', () => {
  const storage = createMemoryStorage();
  const store = createTranslationPreferenceStore(storage);

  assert.deepEqual(store.load(), { enabled: true, preferences: DEFAULT_TRANSLATION_PREFERENCES });
  assert.deepEqual(storage.calls.reads, [TRANSLATION_PREFERENCES_STORAGE_KEY]);
  assert.deepEqual(storage.calls.writes, []);
});

test('preferences save and restore only the allowlisted direction and backend', () => {
  const storage = createMemoryStorage();
  const store = createTranslationPreferenceStore(storage);
  const preferences = {
    sourceLanguage: 'en',
    targetLanguage: 'ja',
    requestedBackend: 'cpu',
    input: 'do not persist this text',
    result: 'do not persist this result',
    logs: ['do not persist these logs'],
    model: 'do not persist this model',
  };

  assert.equal(store.save(preferences), true);
  assert.deepEqual(storage.calls.writes, [{
    key: TRANSLATION_PREFERENCES_STORAGE_KEY,
    value: JSON.stringify({
      version: 2,
      enabled: true,
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      requestedBackend: 'cpu',
    }),
  }]);

  const restored = createTranslationPreferenceStore(storage).load();
  assert.deepEqual(restored, {
    enabled: true,
    preferences: {
      sourceLanguage: 'en',
      targetLanguage: 'ja',
      requestedBackend: 'cpu',
    },
  });
  assert.equal(storage.calls.writes.length, 1);
});

test('malformed JSON and unsupported preference schemas fall back without rewriting storage', async t => {
  const invalidValues = [
    ['partial JSON', '{"version":1,"sourceLanguage":"ja"'],
    ['unknown version', JSON.stringify({
      version: 2, sourceLanguage: 'ja', targetLanguage: 'en', requestedBackend: 'auto',
    })],
    ['missing field', JSON.stringify({
      version: 1, sourceLanguage: 'ja', targetLanguage: 'en',
    })],
    ['same direction', JSON.stringify({
      version: 1, sourceLanguage: 'ja', targetLanguage: 'ja', requestedBackend: 'auto',
    })],
    ['unknown language', JSON.stringify({
      version: 1, sourceLanguage: 'fr', targetLanguage: 'ja', requestedBackend: 'auto',
    })],
    ['unknown backend', JSON.stringify({
      version: 1, sourceLanguage: 'ja', targetLanguage: 'en', requestedBackend: 'gpu',
    })],
    ['extra private field', JSON.stringify({
      version: 1, sourceLanguage: 'ja', targetLanguage: 'en', requestedBackend: 'auto',
      input: 'must not be restored',
    })],
  ];

  for (const [description, rawValue] of invalidValues) {
    await t.test(description, () => {
      const storage = createMemoryStorage(new Map([[TRANSLATION_PREFERENCES_STORAGE_KEY, rawValue]]));
      const result = createTranslationPreferenceStore(storage).load();

      assert.deepEqual(result, {
        enabled: true,
        preferences: DEFAULT_TRANSLATION_PREFERENCES,
        notice: 'invalid',
      });
      assert.deepEqual(storage.calls.writes, []);
    });
  }
});

test('storage getter and read errors fall back with an unavailable notice', () => {
  const throwingStorage = {
    getItem() { throw new Error('storage read failed'); },
    setItem() { throw new Error('storage write failed'); },
  };
  const store = createTranslationPreferenceStore(throwingStorage);

  assert.deepEqual(store.load(), {
    enabled: true,
    preferences: DEFAULT_TRANSLATION_PREFERENCES,
    notice: 'unavailable',
  });
  assert.equal(store.save({
    sourceLanguage: 'ja', targetLanguage: 'en', requestedBackend: 'auto',
  }), false);
});

test('a throwing localStorage getter is handled without throwing from the store', () => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('storage getter failed'); },
  });

  try {
    const store = createTranslationPreferenceStore();
    assert.deepEqual(store.load(), {
      enabled: true,
      preferences: DEFAULT_TRANSLATION_PREFERENCES,
      notice: 'unavailable',
    });
    assert.equal(store.save({
      sourceLanguage: 'ja', targetLanguage: 'en', requestedBackend: 'auto',
    }), false);
  } finally {
    if (previousDescriptor) Object.defineProperty(globalThis, 'localStorage', previousDescriptor);
    else delete globalThis.localStorage;
  }
});

test('invalid save values and storage write errors fail safely', () => {
  const invalidStorage = createMemoryStorage();
  const invalidStore = createTranslationPreferenceStore(invalidStorage);

  assert.equal(invalidStore.save({
    sourceLanguage: 'ja', targetLanguage: 'ja', requestedBackend: 'auto',
  }), false);
  assert.equal(invalidStore.save({
    sourceLanguage: 'ja', targetLanguage: 'en', requestedBackend: 'gpu',
  }), false);
  assert.deepEqual(invalidStorage.calls.writes, []);

  const writeErrorStore = createTranslationPreferenceStore({
    getItem() { return null; },
    setItem() { throw new Error('storage write failed'); },
  });
  assert.equal(writeErrorStore.save({
    sourceLanguage: 'en', targetLanguage: 'ja', requestedBackend: 'cpu',
  }), false);
});

test('legacy v1 preferences load with saving enabled by default', () => {
  const storage = createMemoryStorage(new Map([[TRANSLATION_PREFERENCES_STORAGE_KEY, JSON.stringify({
    version: 1,
    sourceLanguage: 'en',
    targetLanguage: 'ja',
    requestedBackend: 'cpu',
  })]]));

  assert.deepEqual(createTranslationPreferenceStore(storage).load(), {
    enabled: true,
    preferences: { sourceLanguage: 'en', targetLanguage: 'ja', requestedBackend: 'cpu' },
  });
  assert.deepEqual(storage.calls.writes, []);
});

test('disabling saves only the choice and drops a previously saved direction and backend', () => {
  const storage = createMemoryStorage();
  const store = createTranslationPreferenceStore(storage);
  store.save({ sourceLanguage: 'en', targetLanguage: 'ja', requestedBackend: 'cpu' });

  assert.equal(store.disable(), true);
  assert.equal(storage.values.get(TRANSLATION_PREFERENCES_STORAGE_KEY), '{"version":2,"enabled":false}');
  assert.deepEqual(store.load(), {
    enabled: false,
    preferences: DEFAULT_TRANSLATION_PREFERENCES,
  });
});

test('failed disabling tries to remove prior preferences and reports that next startup cannot be guaranteed', () => {
  const values = new Map([[TRANSLATION_PREFERENCES_STORAGE_KEY, 'existing private preferences']]);
  const store = createTranslationPreferenceStore({
    getItem: key => values.get(key) ?? null,
    setItem() { throw new Error('storage write failed'); },
    removeItem: key => values.delete(key),
  });

  assert.equal(store.disable(), false);
  assert.equal(values.has(TRANSLATION_PREFERENCES_STORAGE_KEY), false);
});
