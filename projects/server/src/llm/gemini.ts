import {
  ChatMessage,
  LlmError,
  LlmProvider,
  LlmReply,
  LlmRequest,
  RETRYABLE_STATUS,
  toLlmError,
  withTimeout,
} from './types';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const LOCAL_ID = 'gemini-local-';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { id?: string; name: string; args?: unknown };
  functionResponse?: { id?: string; name: string; response: unknown };
  thoughtSignature?: string;
}

/** Gemini over REST (no SDK): function calling with JSON Schema parameters. */
export function createGemini(apiKey: string, model: string, timeoutMs = 45_000): LlmProvider {
  return {
    name: 'gemini',
    model,
    async generate(request: LlmRequest): Promise<LlmReply> {
      const body = {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: toContents(request.messages),
        ...(request.tools.length
          ? {
              tools: [
                {
                  functionDeclarations: request.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parametersJsonSchema: t.parameters,
                  })),
                },
              ],
            }
          : {}),
        generationConfig: { temperature: 0.2 },
      };

      let res: Response;
      try {
        res = await fetch(`${BASE}/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: withTimeout(timeoutMs, request.signal),
        });
      } catch (err) {
        throw toLlmError(err, model);
      }

      if (!res.ok) {
        const detail = await errorMessage(res);
        throw new LlmError(`${model}: HTTP ${res.status}${detail ? ` ${detail}` : ''}`, RETRYABLE_STATUS.has(res.status), res.status);
      }

      const json = (await res.json()) as {
        candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
        promptFeedback?: { blockReason?: string };
      };
      const candidate = json.candidates?.[0];
      if (!candidate) {
        throw new LlmError(`${model}: no answer${json.promptFeedback?.blockReason ? ` (blocked: ${json.promptFeedback.blockReason})` : ''}`, false);
      }

      const parts = candidate.content?.parts ?? [];
      return {
        model,
        text: parts
          .filter((p) => typeof p.text === 'string' && !p.thought)
          .map((p) => p.text)
          .join(''),
        toolCalls: parts
          .filter((p) => p.functionCall)
          .map((p, i) => ({
            id: p.functionCall!.id ?? `${LOCAL_ID}${Date.now()}-${i}`,
            name: p.functionCall!.name,
            args: p.functionCall!.args ?? {},
          })),
        raw: { provider: 'gemini', data: parts },
      };
    },
  };
}

function toContents(messages: ChatMessage[]) {
  return messages.map((m) => {
    switch (m.role) {
      case 'user':
        return { role: 'user', parts: [{ text: m.text }] };
      case 'assistant':
        // Replay Gemini's own parts so thought signatures survive the round trip.
        if (m.raw?.provider === 'gemini') return { role: 'model', parts: m.raw.data as GeminiPart[] };
        return {
          role: 'model',
          parts: [
            ...(m.text ? [{ text: m.text }] : []),
            ...m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.args } })),
          ],
        };
      case 'tool':
        return {
          role: 'user',
          parts: m.results.map((r) => ({
            functionResponse: {
              ...(r.callId.startsWith(LOCAL_ID) ? {} : { id: r.callId }),
              name: r.name,
              response: { result: r.content },
            },
          })),
        };
    }
  });
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return (body.error?.message ?? '').slice(0, 200);
  } catch {
    return '';
  }
}
