import type { Wllama } from '@wllama/wllama';
import type { RuntimePort } from './runtime-port.ts';

type WllamaClient = Pick<Wllama, 'loadModel' | 'createCompletion' | 'exit'>;

export function adaptWllama(runtime: WllamaClient): RuntimePort {
  return {
    async load(files, options) {
      await runtime.loadModel([...files], {
        n_gpu_layers: options.backend === 'cpu' ? 0 : undefined,
        n_ctx: options.contextSize,
        n_threads: options.threads,
        n_parallel: 1,
      });
    },
    async complete(prompt, options) {
      const result = await runtime.createCompletion({
        prompt,
        temperature: 0,
        max_tokens: options.maxTokens,
        stop: ['<|plamo:tag|>', '<|plamo:bos|>'],
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
