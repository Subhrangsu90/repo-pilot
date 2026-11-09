import type { Config } from '../config';
import { createGemini } from './gemini';
import { createOllama } from './ollama';
import { LlmError, LlmProvider, LlmReply, LlmRequest } from './types';

export * from './types';

/**
 * Tries the primary model; on a retryable failure (503 overloaded, 429, timeout)
 * the same request goes to the fallback. `onFallback` lets the run show it.
 */
export function withFallback(
  primary: LlmProvider,
  fallback: LlmProvider,
  onFallback?: (error: LlmError) => void,
): LlmProvider {
  return {
    name: primary.name,
    model: primary.model,
    async generate(request: LlmRequest): Promise<LlmReply> {
      try {
        return await primary.generate(request);
      } catch (err) {
        if (!(err instanceof LlmError) || !err.retryable || request.signal?.aborted) throw err;
        onFallback?.(err);
        return fallback.generate(request);
      }
    },
  };
}

export function createProvider(config: Config, onFallback?: (error: LlmError) => void): LlmProvider {
  switch (config.LLM_PROVIDER) {
    case 'gemini': {
      if (!config.GEMINI_API_KEY) throw new LlmError('GEMINI_API_KEY is not set in projects/server/.env', false);
      const primary = createGemini(config.GEMINI_API_KEY, config.GEMINI_MODEL);
      if (!config.GEMINI_FALLBACK_MODEL || config.GEMINI_FALLBACK_MODEL === config.GEMINI_MODEL) return primary;
      return withFallback(primary, createGemini(config.GEMINI_API_KEY, config.GEMINI_FALLBACK_MODEL), onFallback);
    }
    case 'ollama':
      return createOllama(config.OLLAMA_URL, config.OLLAMA_MODEL);
    case 'claude':
      // Added once an ANTHROPIC_API_KEY is available to test against.
      throw new LlmError('The Claude provider is not implemented yet; use gemini or ollama.', false);
  }
}
