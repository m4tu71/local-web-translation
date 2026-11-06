import { Wllama, type AssetsPathConfig, type WllamaCompat } from '@wllama/wllama';
import defaultWasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url';
import compatWasmUrl from '@wllama/wllama-compat/wasm/wllama.wasm?url';
import compatWorkerCode from '@wllama/wllama-compat/wasm/wllama.js?raw';
import type { RuntimePort } from './runtime-port.ts';
import { adaptWllama } from './wllama-adapter.ts';

const paths: AssetsPathConfig = { default: defaultWasmUrl };
const compat: WllamaCompat = {
  wasm: compatWasmUrl,
  worker: { code: compatWorkerCode },
};

function assertWasmCapabilities(): void {
  // The pinned upstream constructor starts an async check without awaiting it.
  // Check the same WASM prerequisites synchronously so failures reach loadModel().
  const exceptionHandlingProbe = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0,
    3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11,
  ]);
  const simdProbe = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
    3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
  ]);
  const probes = [exceptionHandlingProbe, simdProbe];
  const supported = typeof WebAssembly !== 'undefined' &&
    probes.every(bytes => WebAssembly.validate(bytes));

  if (!supported) {
    throw new Error('WebAssembly SIMD and exception handling are required.');
  }
}

// Each engine owns its runtime; construct only when loadModel is requested.
export function createWllamaRuntime(): RuntimePort {
  assertWasmCapabilities();

  const runtime = new Wllama(paths, { skipVersionCheck: false });
  // Keep local compat resources available on Firefox as well as Safari.
  // Selection still depends on JSPI / Memory64; this does not force compat mode.
  runtime.setCompat(compat, 'firefox_safari');
  return adaptWllama(runtime);
}
