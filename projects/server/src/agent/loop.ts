import { AgentEvent, getToolSpec, needsApproval, validateNode } from '@repopilot/shared';
import type { ChatMessage, LlmProvider, LlmToolDef, ToolResult } from '../llm';
import { Executor, ToolContext, ToolError } from '../tools/read-tools';

export interface AgentDeps {
  provider: LlmProvider;
  system: string;
  tools: LlmToolDef[];
  executors: Record<string, Executor<any>>;
  ctx: ToolContext;
  emit: (event: AgentEvent) => void;
  runId: string;
  maxIterations?: number;
  signal?: AbortSignal;
}

/** What the model sees back from a tool, capped so one big result cannot flood the context. */
const RESULT_LIMIT = 20_000;

/**
 * The tool-calling loop. Each model call and each tool call is a visible step.
 * Rules enforced here, in code, not in the prompt:
 * - tool input is validated against the tool's schema before anything runs;
 * - any non-read tool is refused (the approval gate arrives in week 3);
 * - UI from tools is validated before it is streamed.
 *
 * Mutates `thread` so follow-up runs continue the conversation.
 */
export async function runAgent(thread: ChatMessage[], prompt: string, deps: AgentDeps): Promise<void> {
  const { emit, provider } = deps;
  const max = deps.maxIterations ?? 6;
  thread.push({ role: 'user', text: prompt });
  let uiShown = false;
  const trackingEmit = (event: AgentEvent) => {
    if (event.type === 'CUSTOM') uiShown = true;
    emit(event);
  };
  deps = { ...deps, emit: trackingEmit };

  for (let i = 0; i < max; i++) {
    const thinkId = `${deps.runId}-think-${i}`;
    emit({ type: 'STEP_STARTED', stepId: thinkId, stepName: i === 0 ? 'Understanding the request' : 'Reviewing results' });
    let reply;
    try {
      reply = await provider.generate({ system: deps.system, messages: thread, tools: deps.tools, signal: deps.signal });
    } catch (err) {
      emit({ type: 'STEP_FINISHED', stepId: thinkId, status: 'error', detail: (err as Error).message.slice(0, 200) });
      // Real data is already on screen: degrade to "no summary" instead of failing the run.
      if (uiShown && !deps.signal?.aborted) {
        const note = 'The results above are complete, but the model could not write a summary right now (it is overloaded or out of quota).';
        thread.push({ role: 'assistant', text: note, toolCalls: [] });
        emitText(emit, `${deps.runId}-msg-degraded`, note);
        return;
      }
      throw err;
    }
    emit({ type: 'STEP_FINISHED', stepId: thinkId, status: 'done', detail: reply.model });

    thread.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });
    if (reply.text.trim()) emitText(emit, `${deps.runId}-msg-${i}`, reply.text.trim());
    if (reply.toolCalls.length === 0) return;

    const results: ToolResult[] = [];
    for (const call of reply.toolCalls) {
      results.push({ callId: call.id, name: call.name, content: await runTool(call, deps) });
    }
    thread.push({ role: 'tool', results });
  }

  emitText(emit, `${deps.runId}-msg-limit`, `I stopped after ${max} steps. Try a more specific request.`);
}

async function runTool(call: { id: string; name: string; args: unknown }, deps: AgentDeps): Promise<unknown> {
  const { emit } = deps;
  const spec = getToolSpec(call.name);
  const stepId = `${deps.runId}-tool-${call.id}`;
  emit({ type: 'STEP_STARTED', stepId, stepName: spec?.label ?? call.name });

  const fail = (message: string) => {
    emit({ type: 'STEP_FINISHED', stepId, status: 'error', detail: message.slice(0, 200) });
    return { error: message };
  };

  if (!spec || !deps.executors[spec.name]) return fail(`Unknown tool "${call.name}".`);
  if (needsApproval(spec.name)) return fail(`"${spec.name}" changes the repository and needs user approval, which is not available yet.`);

  const parsed = spec.input.safeParse(dropNulls(call.args));
  if (!parsed.success) return fail(`Invalid input for ${spec.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);

  try {
    const out = await deps.executors[spec.name](parsed.data, deps.ctx);
    if (out.ui) {
      const check = validateNode(out.ui);
      if (!check.ok) return fail(`The tool produced invalid UI: ${check.error}`);
      emit({ type: 'CUSTOM', name: 'ui', value: { surfaceId: `${deps.runId}-${call.id}`, node: out.ui } });
    }
    emit({ type: 'STEP_FINISHED', stepId, status: 'done', detail: out.detail });
    return cap(out.data);
  } catch (err) {
    // ToolError is meant for the model; anything else is reported without internals.
    return fail(err instanceof ToolError ? err.message : `Tool failed: ${(err as Error).message}`);
  }
}

function emitText(emit: AgentDeps['emit'], messageId: string, text: string) {
  emit({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
  emit({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text });
  emit({ type: 'TEXT_MESSAGE_END', messageId });
}

/**
 * Small models often send `null` for optional fields they do not want to set.
 * Treat that as "not provided" so schema defaults apply, instead of failing
 * validation and burning an iteration.
 */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, dropNulls(v)]),
    );
  }
  return value;
}

function cap(data: unknown): unknown {
  const text = JSON.stringify(data);
  return text.length <= RESULT_LIMIT ? data : { truncated: true, preview: text.slice(0, RESULT_LIMIT) };
}
