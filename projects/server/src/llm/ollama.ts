import { ChatMessage, LlmError, LlmProvider, LlmReply, LlmRequest, toLlmError, withTimeout } from './types';

/**
 * Local model (Gemma) through Ollama's chat API with tool calling. Nothing
 * leaves the machine: the privacy and cost side of the model switch.
 */
export function createOllama(baseUrl: string, configured: string, timeoutMs = 180_000): LlmProvider {
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
            options: { temperature: 0.2 },
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
        const text = (await res.text()).slice(0, 200);
        throw new LlmError(`ollama/${model}: HTTP ${res.status} ${text}`, false, res.status);
      }

      const json = (await res.json()) as {
        message?: { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] };
      };
      const calls = json.message?.tool_calls ?? [];
      return {
        model,
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
