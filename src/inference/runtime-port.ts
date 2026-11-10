// Internal boundary used by the adapter and its lifecycle tests, never by the UI.
import type { InferenceRuntimeInfo } from './types.ts';

export interface RuntimePort {
  load(files: readonly Blob[], options: {
    backend: 'auto' | 'cpu';
    contextSize: number;
    threads: number;
  }): Promise<void>;
  complete(prompt: string, options: {
    maxTokens: number;
    signal: AbortSignal;
    onText?: (cumulativeText: string) => void;
  }): Promise<{
    text: string;
    finishReason: 'stop' | 'length';
  }>;
  /** Optional safe upper bound for the fully rendered model prompt. */
  getInputTokenUpperBound?(prompt: string): number;
  getRuntimeInfo?(): InferenceRuntimeInfo;
  dispose(): Promise<void>;
}

export type RuntimeFactory = () => Promise<RuntimePort>;
