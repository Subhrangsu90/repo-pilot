import { AgentEvent, getToolSpec, needsApproval, PropsOf, toolStepId, validateNode } from '@repopilot/shared';
import type { ChatMessage, LlmProvider, LlmToolDef, ToolCall, ToolResult } from '../llm';
import type { ActionTool } from '../tools/actions';
import { Executor, ToolContext, ToolError } from '../tools/read-tools';

export interface AgentDeps {
  provider: LlmProvider;
  system: string;
  tools: LlmToolDef[];
  /** Read tools: run immediately. */
  executors: Record<string, Executor<any>>;
  /** Write and destructive tools: dry run, approval, then execute. */
  actions: Record<string, ActionTool<any>>;
  ctx: ToolContext;
  emit: (event: AgentEvent) => void;
  runId: string;
  maxIterations?: number;
  signal?: AbortSignal;
}

type CardProps = PropsOf<'ApprovalCard'>;

/** A tool call waiting for the user. Kept on the thread until POST /actions answers it. */
export interface PendingApproval {
  runId: string;
  callId: string;
  tool: string;
  /** Validated input. */
  input: unknown;
  /** Item ids from the dry run: an approval may only pick from these. */
  ids: number[];
  surfaceId: string;
  card: CardProps;
  /** Results for every call of the paused model turn; this call's slot is filled on resume. */
  results: ToolResult[];
}

export type AgentOutcome = { status: 'done' } | { status: 'awaiting-approval'; pending: PendingApproval };

export interface Decision {
  approve: boolean;
  /** Ids still ticked; anything outside the dry run is ignored. */
  selected?: number[];
}

/** What the model sees back from a tool, capped so one big result cannot flood the context. */
const RESULT_LIMIT = 20_000;

/**
 * The tool-calling loop. Each model call and each tool call is a visible step.
 * Rules enforced here, in code, not in the prompt:
 * - tool input is validated against the tool's schema before anything runs;
 * - any non-read tool only gets a dry run, then the run pauses on an
 *   ApprovalCard; the real change happens in `resumeAgent`, after approval;
 * - UI from tools is validated before it is streamed.
 *
 * Mutates `thread` so follow-up runs continue the conversation.
 */
export async function runAgent(thread: ChatMessage[], prompt: string, deps: AgentDeps): Promise<AgentOutcome> {
  thread.push({ role: 'user', text: prompt });
  return loop(thread, deps, false);
}

/**
 * Carries out the user's decision on a paused call, gives the model the
 * result, and lets it continue (usually a one-line summary).
 */
export async function resumeAgent(
  thread: ChatMessage[],
  pending: PendingApproval,
  decision: Decision,
  deps: AgentDeps,
): Promise<AgentOutcome> {
  const content = await carryOut(pending, decision, deps);
  thread.push({
    role: 'tool',
    results: pending.results.map((r) => (r.callId === pending.callId ? { ...r, content: cap(content) } : r)),
  });
  // The card is on screen, so a model failure from here on degrades to a note.
  return loop(thread, deps, true);
}

async function loop(thread: ChatMessage[], deps: AgentDeps, uiShownBefore: boolean): Promise<AgentOutcome> {
  const { emit, provider } = deps;
  const max = deps.maxIterations ?? 6;
  let uiShown = uiShownBefore;
  deps = {
    ...deps,
    emit: (event) => {
      if (event.type === 'CUSTOM') uiShown = true;
      emit(event);
    },
  };

  for (let i = 0; i < max; i++) {
    const thinkId = `${deps.runId}-think-${i}`;
    emit({ type: 'STEP_STARTED', stepId: thinkId, stepName: i === 0 && !uiShownBefore ? 'Understanding the request' : 'Reviewing results' });
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
        return { status: 'done' };
      }
      throw err;
    }
    emit({ type: 'STEP_FINISHED', stepId: thinkId, status: 'done', detail: reply.model });

    thread.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });
    if (reply.text.trim()) emitText(emit, `${deps.runId}-msg-${i}`, reply.text.trim());
    if (reply.toolCalls.length === 0) return { status: 'done' };

    const results: ToolResult[] = [];
    let pending: PendingApproval | undefined;
    for (const call of reply.toolCalls) {
      if (!needsApproval(call.name)) {
        results.push({ callId: call.id, name: call.name, content: await runTool(call, deps) });
        continue;
      }
      if (pending) {
        const error = 'Only one change can wait for approval at a time. Offer this one again after the user decides on the first.';
        results.push({ callId: call.id, name: call.name, content: { error } });
        continue;
      }
      const prepared = await prepareApproval(call, deps);
      if (prepared.kind === 'pending') pending = prepared.pending;
      results.push({ callId: call.id, name: call.name, content: prepared.kind === 'pending' ? null : prepared.content });
    }

    if (pending) {
      pending.results = results;
      emit({ type: 'CUSTOM', name: 'approval', value: { runId: deps.runId, toolCallId: pending.callId, surfaceId: pending.surfaceId } });
      return { status: 'awaiting-approval', pending };
    }
    thread.push({ role: 'tool', results });
  }

  emitText(emit, `${deps.runId}-msg-limit`, `I stopped after ${max} steps. Try a more specific request.`);
  return { status: 'done' };
}

async function runTool(call: ToolCall, deps: AgentDeps): Promise<unknown> {
  const { emit } = deps;
  const spec = getToolSpec(call.name);
  const stepId = toolStepId(deps.runId, call.id);
  emit({ type: 'STEP_STARTED', stepId, stepName: spec?.label ?? call.name });

  const fail = (message: string) => {
    emit({ type: 'STEP_FINISHED', stepId, status: 'error', detail: message.slice(0, 200) });
    return { error: message };
  };

  if (!spec || !deps.executors[spec.name]) return fail(`Unknown tool "${call.name}".`);
  // Defence in depth: the loop routes these to prepareApproval, never here.
  if (needsApproval(spec.name)) return fail(`"${spec.name}" changes the repository and needs user approval.`);

  const parsed = spec.input.safeParse(dropNulls(call.args));
  if (!parsed.success) return fail(invalidInput(spec.name, parsed.error));

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

type Prepared = { kind: 'pending'; pending: PendingApproval } | { kind: 'result'; content: unknown };

/** Validate, dry-run and show the ApprovalCard. Nothing here writes to GitHub. */
async function prepareApproval(call: ToolCall, deps: AgentDeps): Promise<Prepared> {
  const { emit } = deps;
  const spec = getToolSpec(call.name);
  const stepId = toolStepId(deps.runId, call.id);
  emit({ type: 'STEP_STARTED', stepId, stepName: `Dry run · ${spec?.label ?? call.name}` });

  const fail = (message: string): Prepared => {
    emit({ type: 'STEP_FINISHED', stepId, status: 'error', detail: message.slice(0, 200) });
    return { kind: 'result', content: { error: message } };
  };

  const action = spec && deps.actions[spec.name];
  if (!spec || !action || spec.risk === 'read') return fail(`Unknown tool "${call.name}".`);
  const risk = spec.risk;

  const parsed = spec.input.safeParse(dropNulls(call.args));
  if (!parsed.success) return fail(invalidInput(spec.name, parsed.error));

  let plan;
  try {
    plan = await action.plan(parsed.data, deps.ctx);
  } catch (err) {
    return fail(err instanceof ToolError ? err.message : `Dry run failed: ${(err as Error).message}`);
  }

  if (plan.kind === 'empty') {
    emit({ type: 'STEP_FINISHED', stepId, status: 'done', detail: plan.detail });
    return { kind: 'result', content: cap(plan.data) };
  }

  const surfaceId = `${deps.runId}-${call.id}`;
  const card: CardProps = { ...plan.card, toolCallId: call.id, tool: spec.name, risk, status: 'pending', selected: plan.ids };
  const shown = showCard(deps, surfaceId, card);
  if (shown) return fail(`Could not build the approval card: ${shown}`);

  emit({ type: 'STEP_FINISHED', stepId, status: 'done', detail: plan.detail });
  return {
    kind: 'pending',
    pending: { runId: deps.runId, callId: call.id, tool: spec.name, input: parsed.data, ids: plan.ids, surfaceId, card, results: [] },
  };
}

/** The real change, after the user decided. Returns the tool result for the model. */
async function carryOut(pending: PendingApproval, decision: Decision, deps: AgentDeps): Promise<unknown> {
  const { emit } = deps;
  // Step id the client added when the run paused ("Waiting for your approval").
  const waitId = `approval-${pending.callId}`;
  const update = (patch: Partial<CardProps>) => showCard(deps, pending.surfaceId, { ...pending.card, ...patch });

  const allowed = new Set(pending.ids);
  const ids = [...new Set(decision.selected ?? pending.ids)].filter((id) => allowed.has(id));

  if (!decision.approve || (pending.ids.length > 0 && ids.length === 0)) {
    update({ status: 'rejected', result: 'Rejected. Nothing was changed.' });
    emit({ type: 'STEP_FINISHED', stepId: waitId, status: 'done', detail: 'Rejected' });
    return { rejected: true, message: 'The user rejected this change. Nothing was changed.' };
  }

  emit({ type: 'STEP_FINISHED', stepId: waitId, status: 'done', detail: `Approved ${ids.length}` });
  update({ status: 'running', selected: ids });

  const spec = getToolSpec(pending.tool);
  const stepId = `${deps.runId}-exec-${pending.callId}`;
  emit({ type: 'STEP_STARTED', stepId, stepName: spec?.label ?? pending.tool });
  try {
    const action = deps.actions[pending.tool];
    if (!action) throw new ToolError(`Unknown tool "${pending.tool}".`);
    const out = await action.execute(pending.input, ids, deps.ctx);
    update({ status: out.ok ? 'approved' : 'failed', selected: ids, result: out.result });
    emit({ type: 'STEP_FINISHED', stepId, status: out.ok ? 'done' : 'error', detail: out.detail });
    const deselected = pending.ids.filter((id) => !ids.includes(id));
    return { ...out.data, ...(deselected.length ? { keptByUser: deselected } : {}) };
  } catch (err) {
    const message = err instanceof ToolError ? err.message : `The change failed: ${(err as Error).message}`;
    update({ status: 'failed', selected: ids, result: message.slice(0, 400) });
    emit({ type: 'STEP_FINISHED', stepId, status: 'error', detail: message.slice(0, 200) });
    return { error: message };
  }
}

/** Streams an ApprovalCard (validated like any other node). Returns an error message, or null. */
function showCard(deps: AgentDeps, surfaceId: string, props: CardProps): string | null {
  const node = { component: 'ApprovalCard', props };
  const check = validateNode(node);
  if (!check.ok) return check.error;
  deps.emit({ type: 'CUSTOM', name: 'ui', value: { surfaceId, node } });
  return null;
}

function invalidInput(tool: string, error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return `Invalid input for ${tool}: ${error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`;
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
