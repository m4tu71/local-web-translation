import { Wllama, type AssetsPathConfig, type WllamaCompat } from '@wllama/wllama';
import defaultWasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url';
import compatWasmUrl from '@wllama/wllama-compat/wasm/wllama.wasm?url';
import compatWorkerCode from '@wllama/wllama-compat/wasm/wllama.js?raw';

const paths: AssetsPathConfig = { default: defaultWasmUrl };
const compat: WllamaCompat = {
  wasm: compatWasmUrl,
  worker: { code: compatWorkerCode },
};

let instance: Wllama | undefined;

// Configure asset sources only. Workers and WASM start when a model is loaded.
export function configureInferenceRuntime(): void {
  if (instance) return;

  const runtime = new Wllama(paths, { skipVersionCheck: false });
  // Keep local compat resources available on Firefox as well as Safari.
  // Selection still depends on JSPI / Memory64; this does not force compat mode.
  runtime.setCompat(compat, 'firefox_safari');
  instance = runtime;
}
