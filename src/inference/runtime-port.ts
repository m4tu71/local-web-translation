// Internal boundary used by the adapter and its lifecycle tests, never by the UI.
export interface RuntimePort {
  load(files: readonly Blob[], options: {
    backend: 'auto' | 'cpu';
    contextSize: number;
    threads: number;
  }): Promise<void>;
  complete(prompt: string, options: { maxTokens: number; signal: AbortSignal }): Promise<{
    text: string;
    finishReason: 'stop' | 'length';
  }>;
  dispose(): Promise<void>;
}

export type RuntimeFactory = () => Promise<RuntimePort>;
