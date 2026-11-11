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
  readonly enabled: boolean;
  readonly preferences: TranslationPreferences;
  readonly notice?: TranslationPreferenceLoadNotice;
}

export interface TranslationPreferenceStore {
  load(): TranslationPreferenceLoadResult;
  save(preferences: TranslationPreferences): boolean;
  disable(): boolean;
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface StoredTranslationPreferences extends TranslationPreferences {
  readonly version: 2;
  readonly enabled: true;
}

interface DisabledStoredTranslationPreferences {
  readonly version: 2;
  readonly enabled: false;
}

const STORED_PREFERENCE_KEYS = [
  'version',
  'enabled',
  'sourceLanguage',
  'targetLanguage',
  'requestedBackend',
] as const;
const DISABLED_PREFERENCE_KEYS = ['version', 'enabled'] as const;
const LEGACY_PREFERENCE_KEYS = ['version', 'sourceLanguage', 'targetLanguage', 'requestedBackend'] as const;

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

function hasExactKeys(candidate: Record<string, unknown>, keys: readonly string[]): boolean {
  const candidateKeys = Object.keys(candidate);
  return candidateKeys.length === keys.length && keys.every(key => Object.hasOwn(candidate, key));
}

function isStoredTranslationPreferences(value: unknown): value is StoredTranslationPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  if (!hasExactKeys(candidate, STORED_PREFERENCE_KEYS)) return false;

  return candidate.version === 2 && candidate.enabled === true && isTranslationPreferences(candidate) &&
    ((candidate.sourceLanguage === 'ja' && candidate.targetLanguage === 'en') ||
      (candidate.sourceLanguage === 'en' && candidate.targetLanguage === 'ja'));
}

function isDisabledTranslationPreferences(value: unknown): value is DisabledStoredTranslationPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, DISABLED_PREFERENCE_KEYS) &&
    candidate.version === 2 && candidate.enabled === false;
}

function isLegacyTranslationPreferences(value: unknown): value is TranslationPreferences & { version: 1 } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, LEGACY_PREFERENCE_KEYS) &&
    candidate.version === 1 && isTranslationPreferences(candidate) &&
    ((candidate.sourceLanguage === 'ja' && candidate.targetLanguage === 'en') ||
      (candidate.sourceLanguage === 'en' && candidate.targetLanguage === 'ja'));
}

function getDefaultStorage(): PreferenceStorage {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error('Browser storage is unavailable.');
  return storage;
}

function getPreferencesFromStoredValue(value: TranslationPreferences): TranslationPreferences {
  return Object.freeze({
    sourceLanguage: value.sourceLanguage,
    targetLanguage: value.targetLanguage,
    requestedBackend: value.requestedBackend,
  });
}

/** Persists the opt-in setting and, while enabled, the direction and requested backend. */
export function createTranslationPreferenceStore(
  injectedStorage?: PreferenceStorage,
): TranslationPreferenceStore {
  const getStorage = () => injectedStorage ?? getDefaultStorage();

  const saveDisabledSetting = (): boolean => {
    try {
      const disabledValue: DisabledStoredTranslationPreferences = { version: 2, enabled: false };
      getStorage().setItem(TRANSLATION_PREFERENCES_STORAGE_KEY, JSON.stringify(disabledValue));
      return true;
    } catch {
      try {
        getStorage().removeItem(TRANSLATION_PREFERENCES_STORAGE_KEY);
      } catch {
        // Keep disabling persistence available in this page even if storage is blocked.
      }
      return false;
    }
  };

  return {
    load(): TranslationPreferenceLoadResult {
      let storedValue: string | null;
      try {
        storedValue = getStorage().getItem(TRANSLATION_PREFERENCES_STORAGE_KEY);
      } catch {
        return { enabled: true, preferences: DEFAULT_TRANSLATION_PREFERENCES, notice: 'unavailable' };
      }

      if (storedValue === null) return { enabled: true, preferences: DEFAULT_TRANSLATION_PREFERENCES };

      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(storedValue);
      } catch {
        return { enabled: true, preferences: DEFAULT_TRANSLATION_PREFERENCES, notice: 'invalid' };
      }

      if (isDisabledTranslationPreferences(parsedValue)) {
        return { enabled: false, preferences: DEFAULT_TRANSLATION_PREFERENCES };
      }

      if (isLegacyTranslationPreferences(parsedValue)) {
        return { enabled: true, preferences: getPreferencesFromStoredValue(parsedValue) };
      }

      if (!isStoredTranslationPreferences(parsedValue)) {
        return { enabled: true, preferences: DEFAULT_TRANSLATION_PREFERENCES, notice: 'invalid' };
      }

      return { enabled: true, preferences: getPreferencesFromStoredValue(parsedValue) };
    },

    save(preferences: TranslationPreferences): boolean {
      try {
        if (!isTranslationPreferences(preferences) ||
            !((preferences.sourceLanguage === 'ja' && preferences.targetLanguage === 'en') ||
              (preferences.sourceLanguage === 'en' && preferences.targetLanguage === 'ja'))) {
          return false;
        }

        const storedValue: StoredTranslationPreferences = {
          version: 2,
          enabled: true,
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

    disable: saveDisabledSetting,
  };
}
