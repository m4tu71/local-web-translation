import type { Wllama } from '@wllama/wllama';
import type { RuntimePort } from './runtime-port.ts';
import type { InferenceRuntimeInfo } from './types.ts';
import { TRANSLATION_STOP_SEQUENCES } from './pfml.ts';

type WllamaClient = Pick<Wllama, 'loadModel' | 'getLoadedContextInfo' | 'createCompletion' | 'exit'> &
  Partial<Pick<Wllama, 'isSupportWebGPU'>>;

const EXPECTED_PLAMO_TOKEN_IDS = Object.freeze({ bos: 1, eos: 1, eot: 16 });

function assertPlamoTokenSettings(runtime: WllamaClient): void {
  const model = runtime.getLoadedContextInfo();
  const architecture = model.metadata['general.architecture'];
  const tokenizer = model.metadata['tokenizer.ggml.model'];
  const repeatedSpaceThreshold = model.metadata['tokenizer.ggml.break_around_consecutive_spaces_threshold'];
  const repeatedCharacterThreshold = model.metadata['tokenizer.ggml.break_around_repeated_chars_threshold'];

  if (architecture !== 'plamo3' || tokenizer !== 'plamo3') {
    throw new Error('PFML3 translation requires the pinned PLaMo 3 model and tokenizer.');
  }

  if (repeatedSpaceThreshold !== '2' || repeatedCharacterThreshold !== '4') {
    throw new Error('Unexpected PLaMo 3 tokenizer segmentation settings.');
  }

  // The pinned GGUF uses BOS=EOS=1, EOT=16, adds BOS and does not add EOS.
  // Raw completion adds these tokens using the vocabulary settings; adding BOS
  // to the prompt ourselves would duplicate it.
  if (model.add_bos_token !== true || model.add_eos_token !== false) {
    throw new Error('Unexpected BOS/EOS insertion policy: add_bos=true and add_eos=false are required.');
  }

  const tokenIdsMatch = model.token_bos === EXPECTED_PLAMO_TOKEN_IDS.bos &&
    model.token_eos === EXPECTED_PLAMO_TOKEN_IDS.eos &&
    model.token_eot === EXPECTED_PLAMO_TOKEN_IDS.eot;

  if (!tokenIdsMatch) {
    throw new Error('Unexpected BOS/EOS/EOT token IDs for the pinned PLaMo 3 model.');
  }

  if (!model.list_tokens_eog.includes(model.token_eos) ||
      !model.list_tokens_eog.includes(model.token_eot)) {
    throw new Error('PLaMo EOS and EOT tokens must be recognized as generation terminators.');
  }
}

export function adaptWllama(runtime: WllamaClient): RuntimePort {
  let runtimeInfo: InferenceRuntimeInfo | undefined;

  return {
    async load(files, options) {
      await runtime.loadModel([...files], {
        n_gpu_layers: options.backend === 'cpu' ? 0 : undefined,
        n_ctx: options.contextSize,
        n_threads: options.threads,
        n_parallel: 1,
      });
      assertPlamoTokenSettings(runtime);
      const contextInfo = runtime.getLoadedContextInfo();
      const actualContextSize = Number.isSafeInteger(contextInfo.n_ctx) && contextInfo.n_ctx > 0
        ? contextInfo.n_ctx
        : undefined;
      let webGpuApiAvailable: boolean | undefined;
      try {
        webGpuApiAvailable = runtime.isSupportWebGPU?.();
      } catch {
        // Environment detection is optional; the requested backend remains explicit.
      }

      runtimeInfo = Object.freeze({
        // wllama does not report successful GPU layer placement. A CPU request
        // explicitly disables its WebGPU initialization; auto remains unknown.
        backend: options.backend === 'cpu' ? 'cpu' : 'unknown',
        requestedContextSize: options.contextSize,
        contextSize: actualContextSize ?? options.contextSize,
        ...(actualContextSize === undefined ? {} : { actualContextSize }),
        ...(typeof webGpuApiAvailable === 'boolean' ? { webGpuApiAvailable } : {}),
        source: options.backend === 'cpu'
          ? 'n_gpu_layers=0 により WebGPU 初期化を無効化'
          : 'wllama が実際の GPU レイヤー数を公開していない',
        contextSizeSource: actualContextSize === undefined ? 'requested' : 'runtime',
      });
    },
    async complete(prompt, options) {
      const stream = await runtime.createCompletion({
        prompt,
        temperature: 0,
        max_tokens: options.maxTokens,
        stop: [...TRANSLATION_STOP_SEQUENCES],
        ignore_eos: false,
        echo: false,
        abortSignal: options.signal,
        stream: true,
      });

      let text = '';
      let finishReason: 'stop' | 'length' | undefined;
      for await (const chunk of stream) {
        if (options.signal.aborted) {
          throw options.signal.reason;
        }
        const choice = chunk.choices[0];
        if (!choice) continue;

        // Once a supported terminal chunk was received, ignore any later data.
        if (finishReason) continue;

        if (choice.finish_reason !== null &&
            choice.finish_reason !== 'stop' && choice.finish_reason !== 'length') {
          throw new Error('Completion did not return a supported finish reason.');
        }

        if (choice.text) {
          text += choice.text;
          try {
            options.onText?.(text);
          } catch {
            // Progress rendering is observational and must not cancel inference.
          }
        }
        if (choice.finish_reason === 'stop' || choice.finish_reason === 'length') {
          finishReason = choice.finish_reason;
        }
      }

      if (options.signal.aborted) {
        throw options.signal.reason;
      }

      if (!finishReason) {
        throw new Error('Completion did not return a supported finish reason.');
      }

      return { text, finishReason };
    },
    getInputTokenUpperBound(prompt) {
      if (!runtimeInfo) throw new Error('Load the pinned PLaMo 3 model before measuring its input budget.');
      // In the pinned llama.cpp tokenizer, a normal unigram consumes at least
      // one code point, while an unknown code point emits its UTF-8 byte tokens.
      // PLaMo 3 has no input-expanding normalization, so UTF-8 bytes bound the
      // prompt tokens. The model adds one BOS token; segmentation and special
      // tokens can only reduce this count. See the pinned implementation:
      // https://github.com/ggml-org/llama.cpp/blob/d38bea34227bbf9069d62fdc239c98ab6e05435a/src/llama-vocab.cpp
      return new TextEncoder().encode(prompt).byteLength + 1;
    },
    getRuntimeInfo() {
      if (!runtimeInfo) throw new Error('Runtime information is available after model loading.');
      return runtimeInfo;
    },
    async dispose() {
      await runtime.exit();
      runtimeInfo = undefined;
    },
  };
}
