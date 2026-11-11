import { AgentEvent, getToolSpec, needsApproval, PropsOf, submitPullRequestReview, toolStepId, validateNode } from '@repopilot/shared';
import type { ChatMessage, LlmProvider, LlmToolDef, ToolCall, ToolResult } from '../llm';
import type { ActionTool } from '../tools/actions';
import type { Inverse } from '../tools/undo';
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
  /**
   * The run reviews this pull request (the PR review page). If the model stops
   * without drafting a review, the app drafts a summary-only one from its reply,
   * so the page always ends on a review the user can edit and submit.
   */
  reviewPullRequest?: number;
  /** Called once per executed (or failed) approved change: the audit log. Errors are swallowed. */
  onExecuted?: (change: ExecutedChange) => Promise<void> | void;
}

/** An approved change after it ran, for the audit log. */
export interface ExecutedChange {
  runId: string;
  tool: string;
  risk: 'write' | 'destructive';
  summary: string;
  prompt?: string;
  input: unknown;
  edits?: unknown;
  approvedIds: number[];
  keptByUser: number[];
  ok: boolean;
  result: string;
  response?: unknown;
  inverse: Inverse | null;
}

/** The surfaces a paused change can show; both carry status / selected / result. */
type GateComponent = 'ApprovalCard' | 'PrReview' | 'ReleaseForm';
type CardProps = Record<string, unknown> & Pick<PropsOf<'ApprovalCard'>, 'status' | 'selected' | 'result'>;

/** A tool call waiting for the user. Kept on the thread until POST /actions answers it. */
export interface PendingApproval {
  runId: string;
  callId: string;
  tool: string;
  /** Validated input. */
  input: unknown;
  /** Item ids from the dry run: an approval may only pick from these. */
  ids: number[];
  /** True when approving with nothing ticked is still a change (e.g. a review without inline comments). */
  allowEmpty: boolean;
  /** Server-only facts from the dry run, handed to `execute`. */
  carry?: unknown;
  surfaceId: string;
  component: GateComponent;
  card: CardProps;
  /** Results for every call of the paused model turn; this call's slot is filled on resume. */
  results: ToolResult[];
  /** The user prompt that led here (for the audit log). Set by the caller. */
  prompt?: string;
  /**
   * Drafted by the app, not called by the model: the thread has no matching tool
   * call, so the outcome goes back to the model as a note instead of a tool result.
   */
  synthetic?: boolean;
}

export type AgentOutcome = { status: 'done' } | { status: 'awaiting-approval'; pending: PendingApproval };

export interface Decision {
  approve: boolean;
  /** Ids still ticked; anything outside the dry run is ignored. */
  selected?: number[];
  /** What the user changed in the surface; checked against the tool's own `edits` schema. */
  edits?: unknown;
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
  if (pending.synthetic) {
    thread.push({
      role: 'user',
      text: `[RepoPilot app] A review draft for this pull request was shown to the user and they decided on it. Result: ${JSON.stringify(cap(content))}`,
    });
  } else {
    thread.push({
      role: 'tool',
      results: pending.results.map((r) => (r.callId === pending.callId ? { ...r, content: cap(content) } : r)),
    });
  }
  // The card is on screen, so a model failure from here on degrades to a note.
  // No review fallback here: the review was just decided on.
  return loop(thread, { ...deps, reviewPullRequest: undefined }, true);
}

async function loop(thread: ChatMessage[], deps: AgentDeps, uiShownBefore: boolean): Promise<AgentOutcome> {
  const { emit, provider } = deps;
  const max = deps.maxIterations ?? 6;
  let uiShown = uiShownBefore;
  let reviewShown = false;
  deps = {
    ...deps,
    emit: (event) => {
      if (event.type === 'CUSTOM') uiShown = true;
      if (event.type === 'CUSTOM' && event.name === 'ui' && (event.value.node as { component?: unknown }).component === 'PrReview') reviewShown = true;
      emit(event);
    },
  };
  /** The model is finished: end the run, or first draft the review it did not write. */
  const finish = async (text: string): Promise<AgentOutcome> => {
    if (deps.reviewPullRequest === undefined || reviewShown || deps.signal?.aborted) return { status: 'done' };
    const pending = await draftReview(deps, deps.reviewPullRequest, text);
    return pending ? { status: 'awaiting-approval', pending } : { status: 'done' };
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
    if (reply.toolCalls.length === 0) return finish(reply.text);

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
  return finish('');
}

/**
 * The fallback review: a comment review with the model's own words as the
 * summary and no inline comments. It goes through the same dry run and approval
 * as a model-drafted one, so nothing is posted until the user submits it.
 */
async function draftReview(deps: AgentDeps, number: number, text: string): Promise<PendingApproval | null> {
  const summary = text.trim().slice(0, 2000) || 'Reviewed the changes; no problems found in the diff.';
  const call: ToolCall = {
    id: `${deps.runId}-auto-review`,
    name: submitPullRequestReview.name,
    args: { number, event: 'COMMENT', summary, comments: [] },
  };
  const prepared = await prepareApproval(call, deps);
  if (prepared.kind !== 'pending') return null;
  const pending: PendingApproval = { ...prepared.pending, synthetic: true, results: [] };
  deps.emit({ type: 'CUSTOM', name: 'approval', value: { runId: deps.runId, toolCallId: pending.callId, surfaceId: pending.surfaceId } });
  return pending;
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
  const component: GateComponent = plan.component ?? 'ApprovalCard';
  const card: CardProps = { ...plan.card, toolCallId: call.id, tool: spec.name, risk, status: 'pending', selected: plan.ids };
  const shown = showCard(deps, surfaceId, component, card);
  if (shown) return fail(`Could not build the approval card: ${shown}`);

  emit({ type: 'STEP_FINISHED', stepId, status: 'done', detail: plan.detail });
  return {
    kind: 'pending',
    pending: {
      runId: deps.runId,
      callId: call.id,
      tool: spec.name,
      input: parsed.data,
      ids: plan.ids,
      allowEmpty: plan.allowEmpty ?? false,
      carry: plan.carry,
      surfaceId,
      component,
      card,
      results: [],
    },
  };
}

/** The real change, after the user decided. Returns the tool result for the model. */
async function carryOut(pending: PendingApproval, decision: Decision, deps: AgentDeps): Promise<unknown> {
  const { emit } = deps;
  // Step id the client added when the run paused ("Waiting for your approval").
  const waitId = `approval-${pending.callId}`;
  let shownCard = pending.card;
  const update = (patch: Partial<CardProps>) => showCard(deps, pending.surfaceId, pending.component, { ...shownCard, ...patch });

  const allowed = new Set(pending.ids);
  const ids = [...new Set(decision.selected ?? pending.ids)].filter((id) => allowed.has(id));
  const action = deps.actions[pending.tool];

  if (!decision.approve || (!pending.allowEmpty && pending.ids.length > 0 && ids.length === 0)) {
    update({ status: 'rejected', result: 'Rejected. Nothing was changed.' });
    emit({ type: 'STEP_FINISHED', stepId: waitId, status: 'done', detail: 'Rejected' });
    return { rejected: true, message: 'The user rejected this change. Nothing was changed.' };
  }

  // Edits only count when the tool declares what may be edited, and only in that shape.
  let edits: unknown;
  if (action?.edits && decision.edits !== undefined) {
    const parsed = action.edits.safeParse(decision.edits);
    if (!parsed.success) {
      const message = `Your changes could not be used (${parsed.error.issues[0]?.message ?? 'invalid'}). Nothing was changed.`;
      update({ status: 'failed', result: message.slice(0, 400) });
      emit({ type: 'STEP_FINISHED', stepId: waitId, status: 'error', detail: 'Invalid edits' });
      return { error: message };
    }
    edits = parsed.data;
    if (action.editedCard) shownCard = { ...shownCard, ...action.editedCard(shownCard, edits) };
  }

  // "Approved 2" for item lists; just "Approved" for a review or a release, which have no items to tick.
  emit({ type: 'STEP_FINISHED', stepId: waitId, status: 'done', detail: pending.ids.length ? `Approved ${ids.length}` : 'Approved' });
  update({ status: 'running', selected: ids });

  const spec = getToolSpec(pending.tool);
  const stepId = `${deps.runId}-exec-${pending.callId}`;
  emit({ type: 'STEP_STARTED', stepId, stepName: spec?.label ?? pending.tool });
  const opts = { edits, carry: pending.carry };
  const deselected = pending.ids.filter((id) => !ids.includes(id));
  // Every approved change is recorded, whether it worked or not. A logging failure never undoes the run.
  const audit = async (fields: Pick<ExecutedChange, 'ok' | 'result' | 'response' | 'inverse'>) => {
    if (!deps.onExecuted || !action) return;
    try {
      await deps.onExecuted({
        runId: deps.runId,
        tool: pending.tool,
        risk: spec?.risk === 'destructive' ? 'destructive' : 'write',
        summary: action.summary(pending.input, ids, opts),
        prompt: pending.prompt,
        input: pending.input,
        edits,
        approvedIds: ids,
        keptByUser: deselected,
        ...fields,
      });
    } catch {
      // The store logs its own errors.
    }
  };

  try {
    if (!action) throw new ToolError(`Unknown tool "${pending.tool}".`);
    const out = await action.execute(pending.input, ids, deps.ctx, opts);
    shownCard = { ...shownCard, ...out.patch };
    update({ status: out.ok ? 'approved' : 'failed', selected: ids, result: out.result });
    emit({ type: 'STEP_FINISHED', stepId, status: out.ok ? 'done' : 'error', detail: out.detail });
    await audit({ ok: out.ok, result: out.result, response: out.data, inverse: action.inverse?.(pending.input, ids, out, opts) ?? null });
    return { ...out.data, ...(deselected.length ? { keptByUser: deselected } : {}) };
  } catch (err) {
    const message = err instanceof ToolError ? err.message : `The change failed: ${(err as Error).message}`;
    await audit({ ok: false, result: message.slice(0, 400), inverse: null });
    update({ status: 'failed', selected: ids, result: message.slice(0, 400) });
    emit({ type: 'STEP_FINISHED', stepId, status: 'error', detail: message.slice(0, 200) });
    return { error: message };
  }
}

/** Streams the gate surface (validated like any other node). Returns an error message, or null. */
function showCard(deps: AgentDeps, surfaceId: string, component: GateComponent, props: CardProps): string | null {
  const node = { component, props };
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
