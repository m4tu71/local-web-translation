import type { Language, TranslationDirection } from '../translation/input.ts';

export const TRANSLATION_PREFERENCES_STORAGE_KEY =
  'local-web-translation:translation-preferences:v1';

export const DEFAULT_TRANSLATION_PREFERENCES: TranslationPreferences = Object.freeze({
  sourceLanguage: 'ja',
  targetLanguage: 'en',
  requestedBackend: 'auto',
});

export type RequestedBackend = 'auto' | 'cpu';

export interface TranslationPreferences extends TranslationDirection {
  readonly requestedBackend: RequestedBackend;
}

export type TranslationPreferenceLoadNotice = 'invalid' | 'unavailable';

export interface TranslationPreferenceLoadResult {
  readonly preferences: TranslationPreferences;
  readonly notice?: TranslationPreferenceLoadNotice;
}

export interface TranslationPreferenceStore {
  load(): TranslationPreferenceLoadResult;
  save(preferences: TranslationPreferences): boolean;
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

interface StoredTranslationPreferences extends TranslationPreferences {
  readonly version: 1;
}

const STORED_PREFERENCE_KEYS = [
  'version',
  'sourceLanguage',
  'targetLanguage',
  'requestedBackend',
] as const;

function isLanguage(value: unknown): value is Language {
  return value === 'ja' || value === 'en';
}

function isRequestedBackend(value: unknown): value is RequestedBackend {
  return value === 'auto' || value === 'cpu';
}

function isTranslationPreferences(value: unknown): value is TranslationPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  return isLanguage(candidate.sourceLanguage) &&
    isLanguage(candidate.targetLanguage) &&
    candidate.sourceLanguage !== candidate.targetLanguage &&
    isRequestedBackend(candidate.requestedBackend);
}

function isStoredTranslationPreferences(value: unknown): value is StoredTranslationPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length !== STORED_PREFERENCE_KEYS.length ||
      !STORED_PREFERENCE_KEYS.every(key => Object.hasOwn(candidate, key))) return false;

  return candidate.version === 1 && isTranslationPreferences(candidate) &&
    ((candidate.sourceLanguage === 'ja' && candidate.targetLanguage === 'en') ||
      (candidate.sourceLanguage === 'en' && candidate.targetLanguage === 'ja'));
}

function getDefaultStorage(): PreferenceStorage {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error('Browser storage is unavailable.');
  return storage;
}

function getPreferencesFromStoredValue(value: StoredTranslationPreferences): TranslationPreferences {
  return Object.freeze({
    sourceLanguage: value.sourceLanguage,
    targetLanguage: value.targetLanguage,
    requestedBackend: value.requestedBackend,
  });
}

/** Persists only the translation direction and requested inference backend. */
export function createTranslationPreferenceStore(
  injectedStorage?: PreferenceStorage,
): TranslationPreferenceStore {
  const getStorage = () => injectedStorage ?? getDefaultStorage();

  return {
    load(): TranslationPreferenceLoadResult {
      let storedValue: string | null;
      try {
        storedValue = getStorage().getItem(TRANSLATION_PREFERENCES_STORAGE_KEY);
      } catch {
        return { preferences: DEFAULT_TRANSLATION_PREFERENCES, notice: 'unavailable' };
      }

      if (storedValue === null) return { preferences: DEFAULT_TRANSLATION_PREFERENCES };

      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(storedValue);
      } catch {
        return { preferences: DEFAULT_TRANSLATION_PREFERENCES, notice: 'invalid' };
      }

      if (!isStoredTranslationPreferences(parsedValue)) {
        return { preferences: DEFAULT_TRANSLATION_PREFERENCES, notice: 'invalid' };
      }

      return { preferences: getPreferencesFromStoredValue(parsedValue) };
    },

    save(preferences: TranslationPreferences): boolean {
      try {
        if (!isTranslationPreferences(preferences) ||
            !((preferences.sourceLanguage === 'ja' && preferences.targetLanguage === 'en') ||
              (preferences.sourceLanguage === 'en' && preferences.targetLanguage === 'ja'))) {
          return false;
        }

        const storedValue: StoredTranslationPreferences = {
          version: 1,
          sourceLanguage: preferences.sourceLanguage,
          targetLanguage: preferences.targetLanguage,
          requestedBackend: preferences.requestedBackend,
        };
        getStorage().setItem(
          TRANSLATION_PREFERENCES_STORAGE_KEY,
          JSON.stringify(storedValue),
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}
