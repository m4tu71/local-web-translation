import { InferenceController } from './engine.ts';
import type { InferenceEngine } from './types.ts';

export { InferenceError } from './types.ts';
export type {
  InferenceEngine,
  InferenceRuntimeInfo,
  InferenceState,
  InferencePhase,
  InferenceErrorCode,
  ModelLoadOptions,
  TranslationBudget,
  TranslationOptions,
  TranslationRequest,
  TranslationResult,
} from './types.ts';

export function createInferenceEngine(): InferenceEngine {
  return new InferenceController(async () => {
    const { createWllamaRuntime } = await import('./wllama-runtime.ts');
    return createWllamaRuntime();
  });
}

// A page-scoped instance; creating it does not initialize wllama or load a model.
export const inferenceEngine = createInferenceEngine();
