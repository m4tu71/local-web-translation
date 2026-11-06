import type { Wllama } from '@wllama/wllama';
import type { RuntimePort } from './runtime-port.ts';
import { TRANSLATION_STOP_SEQUENCES } from './pfml.ts';

type WllamaClient = Pick<Wllama, 'loadModel' | 'getLoadedContextInfo' | 'createCompletion' | 'exit'>;

const EXPECTED_PLAMO_TOKEN_IDS = Object.freeze({ bos: 1, eos: 1, eot: 16 });

function assertPlamoTokenSettings(runtime: WllamaClient): void {
  const model = runtime.getLoadedContextInfo();
  const architecture = model.metadata['general.architecture'];
  const tokenizer = model.metadata['tokenizer.ggml.model'];

  if (architecture !== 'plamo3' || tokenizer !== 'plamo3') {
    throw new Error('PFML3 translation requires the pinned PLaMo 3 model and tokenizer.');
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
  return {
    async load(files, options) {
      await runtime.loadModel([...files], {
        n_gpu_layers: options.backend === 'cpu' ? 0 : undefined,
        n_ctx: options.contextSize,
        n_threads: options.threads,
        n_parallel: 1,
      });
      assertPlamoTokenSettings(runtime);
    },
    async complete(prompt, options) {
      const result = await runtime.createCompletion({
        prompt,
        temperature: 0,
        max_tokens: options.maxTokens,
        stop: [...TRANSLATION_STOP_SEQUENCES],
        ignore_eos: false,
        echo: false,
        abortSignal: options.signal,
        stream: false,
      });
      const choice = result.choices[0];
      if (!choice || (choice.finish_reason !== 'stop' && choice.finish_reason !== 'length')) {
        throw new Error('Completion did not return a supported finish reason.');
      }
      return { text: choice.text, finishReason: choice.finish_reason };
    },
    dispose: () => runtime.exit(),
  };
}
