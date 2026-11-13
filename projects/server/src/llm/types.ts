/**
 * Provider-neutral chat types. The agent loop only talks to `LlmProvider`, so
 * switching Gemini / Ollama (Gemma) / Claude is a config change.
 */

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: unknown;
}

export type ChatMessage =
  | { role: 'user'; text: string }
  | {
      role: 'assistant';
      text: string;
      toolCalls: ToolCall[];
      /** Provider-native turn, replayed verbatim (Gemini 3 needs its thought signatures back). */
      raw?: { provider: string; data: unknown };
    }
  | { role: 'tool'; results: ToolResult[] };

export interface LlmToolDef {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  messages: ChatMessage[];
  tools: LlmToolDef[];
  signal?: AbortSignal;
}

export interface LlmReply {
  text: string;
  toolCalls: ToolCall[];
  raw?: { provider: string; data: unknown };
  /** The model that actually answered (differs from the primary after a fallback). */
  model: string;
  /** The model's thought summary, when the provider shares one (shown as AG-UI reasoning, as text). */
  reasoning?: string;
  /** Token counts for this call, in AG-UI's accounting (reasoning and cached tokens are parts of the totals). */
  usage?: LlmUsage;
}

export interface LlmUsage {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(request: LlmRequest): Promise<LlmReply>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    /** Overloaded, rate limited or timed out: worth trying another model. */
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Network failures and timeouts are retryable; HTTP errors decide for themselves. */
export function toLlmError(err: unknown, label: string): LlmError {
  if (err instanceof LlmError) return err;
  const name = (err as Error)?.name;
  if (name === 'TimeoutError') return new LlmError(`${label}: no answer in time`, true);
  if (name === 'AbortError') return new LlmError(`${label}: cancelled`, false);
  return new LlmError(`${label}: ${(err as Error)?.message ?? String(err)}`, true);
}

export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
