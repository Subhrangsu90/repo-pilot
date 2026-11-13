import { ChatMessage, LlmError, LlmProvider, LlmReply, LlmRequest, toLlmError, withTimeout } from './types';

/**
 * Local model (Gemma) through Ollama's chat API with tool calling. Nothing
 * leaves the machine: the privacy and cost side of the model switch.
 */
/**
 * `numCtx` caps the context window. Ollama otherwise picks its own default, and
 * the KV cache it reserves can exceed free RAM on a laptop. RepoPilot's prompt
 * is ~3k tokens plus tool results, so 8k is plenty.
 */
export function createOllama(baseUrl: string, configured: string, numCtx = 8192, timeoutMs = 180_000): LlmProvider {
  let resolved: Promise<string> | undefined;
  return {
    name: 'ollama',
    model: configured,
    async generate(request: LlmRequest): Promise<LlmReply> {
      resolved ??= resolveModel(baseUrl, configured).catch((err) => {
        resolved = undefined;
        throw err;
      });
      const model = await resolved;
      let res: Response;
      try {
        res = await fetch(new URL('/api/chat', baseUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            options: { temperature: 0.2, num_ctx: numCtx },
            messages: [{ role: 'system', content: request.system }, ...toMessages(request.messages)],
            tools: request.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }),
          signal: withTimeout(timeoutMs, request.signal),
        });
      } catch (err) {
        throw toLlmError(err, `ollama/${model}`);
      }

      if (!res.ok) {
        const text = await res.text();
        throw new LlmError(describeFailure(model, res.status, text), false, res.status);
      }

      const json = (await res.json()) as {
        message?: { content?: string; thinking?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      const calls = json.message?.tool_calls ?? [];
      const reasoning = json.message?.thinking?.trim();
      return {
        model,
        ...(reasoning ? { reasoning } : {}),
        usage: { provider: 'ollama', model, inputTokens: json.prompt_eval_count, outputTokens: json.eval_count },
        text: json.message?.content ?? '',
        toolCalls: calls.map((c, i) => ({
          id: `ollama-${Date.now()}-${i}`,
          name: c.function.name,
          args: typeof c.function.arguments === 'string' ? safeJson(c.function.arguments) : c.function.arguments,
        })),
      };
    },
  };
}

interface OllamaMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_name?: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
}

function toMessages(messages: ChatMessage[]): OllamaMessage[] {
  return messages.flatMap((m): OllamaMessage[] => {
    switch (m.role) {
      case 'user':
        return [{ role: 'user', content: m.text }];
      case 'assistant':
        return [
          {
            role: 'assistant',
            content: m.text,
            ...(m.toolCalls.length
              ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) }
              : {}),
          },
        ];
      case 'tool':
        return m.results.map((r) => ({ role: 'tool', tool_name: r.name, content: JSON.stringify(r.content) }));
    }
  });
}

/** Turns llama.cpp load failures (bad_alloc, failed to allocate buffer) into advice a user can act on. */
export function describeFailure(model: string, status: number, body: string): string {
  if (/bad_alloc|failed to allocate|out of memory|llama-server process has terminated/i.test(body)) {
    return (
      `ollama/${model}: not enough free memory to load the model. Close memory-heavy apps (VS Code, browsers), ` +
      `lower OLLAMA_NUM_CTX, pick a smaller OLLAMA_MODEL, or switch to LLM_PROVIDER=gemini.`
    );
  }
  return `ollama/${model}: HTTP ${status} ${body.slice(0, 200)}`;
}

/** Ollama needs the exact tag; accept a bare name ("gemma4") and pick the installed tag ("gemma4:e2b"). */
export async function resolveModel(baseUrl: string, name: string): Promise<string> {
  let models: string[];
  try {
    const res = await fetch(new URL('/api/tags', baseUrl), { signal: AbortSignal.timeout(3000) });
    models = (((await res.json()) as { models?: { name: string }[] }).models ?? []).map((m) => m.name);
  } catch (err) {
    throw toLlmError(err, `Ollama at ${baseUrl} is not reachable`);
  }
  const match = models.find((m) => m === name) ?? models.find((m) => m === `${name}:latest`) ?? models.find((m) => m.startsWith(`${name}:`));
  if (!match) throw new LlmError(`Ollama has no "${name}" model. Installed: ${models.join(', ') || 'none'}. Run: ollama pull ${name}`, false);
  return match;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
