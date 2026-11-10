export type InferencePhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'translating'
  | 'stopping'
  | 'disposing'
  | 'disposed'
  | 'error';

export type InferenceErrorCode =
  | 'invalid-input'
  | 'unsupported'
  | 'busy'
  | 'not-ready'
  | 'disposed'
  | 'load-failed'
  | 'translation-failed'
  | 'dispose-failed'
  | 'cancelled';

export class InferenceError extends Error {
  readonly code: InferenceErrorCode;

  constructor(code: InferenceErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'InferenceError';
    this.code = code;
  }
}

export interface InferenceState {
  readonly phase: InferencePhase;
  readonly modelLoaded: boolean;
  readonly runtimeInfo?: InferenceRuntimeInfo;
  readonly error?: Readonly<{ code: InferenceErrorCode; message: string }>;
}

export interface InferenceRuntimeInfo {
  /** Confirmed CPU use, or unknown when the runtime exposes no actual device data. */
  readonly backend: 'cpu' | 'gpu' | 'unknown';
  readonly contextSize: number;
  readonly requestedContextSize: number;
  readonly actualContextSize?: number;
  readonly gpuLayers?: number;
  readonly webGpuApiAvailable?: boolean;
  readonly source?: string;
  readonly contextSizeSource?: 'runtime' | 'requested';
}

export interface ModelLoadOptions {
  /** auto prefers GPU when available; it does not guarantee GPU execution. */
  backend?: 'auto' | 'cpu';
  contextSize?: number;
  threads?: number;
}

export interface TranslationRequest {
  text: string;
  targetLanguage: 'ja' | 'en';
  sourceLanguage?: 'ja' | 'en';
  maxTokens?: number;
}

export interface TranslationResult {
  readonly text: string;
  /** Token limit reached; the result may be incomplete. */
  readonly truncated: boolean;
}

export interface TranslationBudget {
  /** Conservative upper bound; this is not the model tokenizer's exact count. */
  readonly inputTokenUpperBound: number;
  readonly contextSize: number;
  readonly maxOutputTokens: number;
  readonly method: 'utf8-upper-bound';
  readonly fits: boolean;
}

export interface TranslationOptions {
  /** Receives the current complete generated text while decoding. */
  onText?: (cumulativeText: string) => void;
}

export interface InferenceEngine {
  getState(): InferenceState;

  /** Immediately notifies the listener; returns an unsubscribe function. */
  subscribe(listener: (state: InferenceState) => void): () => void;

  loadModel(files: readonly Blob[], options?: ModelLoadOptions): Promise<void>;
  translate(request: TranslationRequest, options?: TranslationOptions): Promise<TranslationResult>;
  getTranslationBudget(request: TranslationRequest): TranslationBudget;

  /** Cancels an operation and unloads its model. The original call rejects. */
  abort(): Promise<void>;

  /** Terminal operation. Create a new engine after successful disposal. */
  dispose(): Promise<void>;
}
