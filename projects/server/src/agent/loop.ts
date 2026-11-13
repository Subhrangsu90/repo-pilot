import * as z from 'zod';
import type { Interrupt } from '@ag-ui/core';
import {
  A2UI_OPERATIONS_KEY,
  APPROVAL_INTERRUPT,
  ApprovalDecision,
  approvalStepId,
  EventType,
  getPullRequest,
  getToolSpec,
  isClientTool,
  META_KEY,
  needsApproval,
  propsUpdate,
  readSurface,
  ROOT_ID,
  rootComponent,
  submitPullRequestReview,
  surfaceMessages,
  toolStepId,
  validateNode,
  type A2uiMessage,
  type ApprovalInterruptMeta,
  type PropsOf,
} from '@repopilot/shared';
import type { ChatMessage, LlmProvider, LlmToolDef, LlmUsage, ToolCall, ToolResult } from '../llm';
import type { ActionTool } from '../tools/actions';
import { contextWindow, withSummary } from './context';
import type { Inverse } from '../tools/undo';
import { Executor, ToolContext, ToolError } from '../tools/read-tools';
import { reasoning, stepFinished, stepStarted, surfaceDelta, surfaceSnapshot, text, toolCall, toolResult, type Emit } from '@repopilot/shared';

export interface AgentDeps {
  provider: LlmProvider;
  system: string;
  tools: LlmToolDef[];
  /** Read tools: run immediately. */
  executors: Record<string, Executor<any>>;
  /** Write and destructive tools: dry run, approval, then execute. */
  actions: Record<string, ActionTool<any>>;
  ctx: ToolContext;
  /** AG-UI events of the run. */
  emit: Emit;
  runId: string;
  maxIterations?: number;
  signal?: AbortSignal;
  /**
   * The run reviews this pull request (the PR review page). If the model stops
   * without drafting a review, the app drafts a summary-only one from its reply,
   * so the page always ends on a review the user can edit and submit.
   */
  reviewPullRequest?: number;
  /**
   * A side question while another change waits for approval: only read and
   * client tools run; any change is refused in code, so the waiting card stays
   * the only pending change.
   */
  readOnly?: boolean;
  /**
   * Client tools the browser declared in RunAgentInput.tools (it applies them on
   * screen). A client tool the page did not declare is refused. Omitted: all.
   */
  clientTools?: ReadonlySet<string>;
  /** Token usage of each model call (AG-UI RUN_FINISHED.usage). */
  onUsage?: (usage: LlmUsage) => void;
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

/** The surfaces a paused change can show; all carry status / selected / result. */
type GateComponent = 'ApprovalCard' | 'PrReview' | 'ReleaseForm';
type CardProps = Record<string, unknown> & Pick<PropsOf<'ApprovalCard'>, 'status' | 'selected' | 'result'>;

/** A tool call waiting for the user (an AG-UI interrupt). Kept on the thread until a run resumes it. */
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
 * - any non-read tool only gets a dry run, then the run pauses on an approval
 *   surface (an AG-UI interrupt); the real change happens in `resumeAgent`;
 * - UI from tools is validated before it is streamed as A2UI.
 *
 * Mutates `thread` so follow-up runs continue the conversation.
 */
export async function runAgent(thread: ChatMessage[], prompt: string, deps: AgentDeps): Promise<AgentOutcome> {
  thread.push({ role: 'user', text: prompt });
  return loop(thread, deps, false, REVIEW_REQUEST.test(prompt));
}

/** A prompt that asks for a review ("Review PR #16", "can you review #15?"). */
const REVIEW_REQUEST = /\breview/i;

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
    deps.emit(toolResult(pending.callId, content));
    thread.push({
      role: 'tool',
      results: pending.results.map((r) => (r.callId === pending.callId ? { ...r, content: cap(content) } : r)),
    });
  }
  // The card is on screen, so a model failure from here on degrades to a note.
  // No review fallback here: the review was just decided on.
  return loop(thread, { ...deps, reviewPullRequest: undefined }, true);
}

/** The root component of an A2UI surface activity, or undefined for any other event. */
function surfaceComponent(event: Parameters<Emit>[0]): string | undefined {
  if (event.type !== EventType.ACTIVITY_SNAPSHOT) return undefined;
  const ops = (event.content as Record<string, unknown>)[A2UI_OPERATIONS_KEY];
  return Array.isArray(ops) ? rootComponent(readSurface(ops as A2uiMessage[])) : undefined;
}

/**
 * @param reviewOnRead The user asked for a review: if the run reads exactly one
 *   pull request, it must end on a review draft of it, as on the PR review page.
 */
async function loop(thread: ChatMessage[], deps: AgentDeps, uiShownBefore: boolean, reviewOnRead = false): Promise<AgentOutcome> {
  const { emit, provider } = deps;
  const max = deps.maxIterations ?? 6;
  let uiShown = uiShownBefore;
  let reviewShown = false;
  deps = {
    ...deps,
    emit: (event) => {
      const shown = surfaceComponent(event);
      if (shown) uiShown = true;
      if (shown === 'PrReview') reviewShown = true;
      emit(event);
    },
  };
  const readPulls = new Set<number>();
  /** The pull request this run owes a review draft for, if any. */
  const reviewTarget = (): number | undefined =>
    deps.reviewPullRequest ?? (reviewOnRead && readPulls.size === 1 ? [...readPulls][0] : undefined);
  const reviewOwed = () => !deps.readOnly && reviewTarget() !== undefined && !reviewShown && !deps.signal?.aborted;
  /** The model's last words before it was reminded to draft the review. */
  let beforeNudge: string | undefined;
  /** The model was reminded once that its reply was empty. */
  let emptyNudged = false;

  /** The model is finished: end the run, or first draft the review it did not write. */
  const finish = async (said: string): Promise<AgentOutcome> => {
    if (!reviewOwed()) return { status: 'done' };
    const pending = await draftReview(deps, reviewTarget()!, beforeNudge || said);
    return pending ? { status: 'awaiting-approval', pending } : { status: 'done' };
  };

  for (let i = 0; i < max; i++) {
    const thinkId = `${deps.runId}-think-${i}`;
    emit(stepStarted(thinkId, i === 0 && !uiShownBefore ? 'Understanding the request' : 'Reviewing results'));
    let reply;
    try {
      // The last turns in full, older ones as a summary; the thread itself keeps everything.
      const context = contextWindow(thread);
      reply = await provider.generate({
        system: withSummary(deps.system, context.summary),
        messages: context.messages,
        tools: deps.tools,
        signal: deps.signal,
      });
    } catch (err) {
      emit(stepFinished(thinkId, 'error', (err as Error).message));
      if (deps.signal?.aborted) throw err;
      // The model went down after its reminder: the review it owes is still drafted, from its earlier reply.
      if (beforeNudge !== undefined && reviewOwed()) return finish(beforeNudge);
      // Real data is already on screen: degrade to "no summary" instead of failing the run.
      if (uiShown) {
        const note = 'The results above are complete, but the model could not write a summary right now (it is overloaded or out of quota).';
        thread.push({ role: 'assistant', text: note, toolCalls: [] });
        text(emit, `${deps.runId}-msg-degraded`, note);
        return { status: 'done' };
      }
      throw err;
    }
    if (reply.usage) deps.onUsage?.(reply.usage);
    if (reply.reasoning) reasoning(emit, `${thinkId}-reasoning`, reply.reasoning);
    emit(stepFinished(thinkId, 'done', reply.model));

    thread.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });
    // Stopped without the review it was asked for: remind it once, in code. Its reply is held back,
    // since small models often claim "I have drafted a review" without calling the tool.
    if (reply.toolCalls.length === 0 && beforeNudge === undefined && reviewOwed() && i < max - 1) {
      beforeNudge = reply.text.trim();
      thread.push({ role: 'user', text: reviewReminder(reviewTarget()!) });
      continue;
    }
    const messageId = `${deps.runId}-msg-${i}`;
    const said = reply.text.trim();
    text(emit, messageId, said);
    if (reply.toolCalls.length === 0) {
      // Small models sometimes answer with nothing at all: the user would see only a finished step.
      if (!said && !uiShown && !deps.signal?.aborted) {
        if (!emptyNudged && i < max - 1) {
          emptyNudged = true;
          thread.push({ role: 'user', text: EMPTY_REMINDER });
          continue;
        }
        const note = 'I could not produce an answer to that. Try asking it another way, or switch to the Cloud model.';
        thread.push({ role: 'assistant', text: note, toolCalls: [] });
        text(emit, `${deps.runId}-msg-empty`, note);
      }
      return finish(reply.text);
    }

    const results: ToolResult[] = [];
    let pending: PendingApproval | undefined;
    const parent = said ? messageId : undefined;
    for (const call of reply.toolCalls) {
      // Client tools announce their call once validated (runTool), so the browser only sees clean arguments.
      if (!isClientTool(call.name)) toolCall(deps.emit, call.id, call.name, call.args, parent);
      const answer = (content: unknown) => {
        results.push({ callId: call.id, name: call.name, content });
        deps.emit(toolResult(call.id, content));
      };
      if (!needsApproval(call.name)) {
        const content = await runTool(call, deps, parent);
        answer(content);
        const read = (content as { number?: unknown; error?: unknown } | null) ?? {};
        if (call.name === getPullRequest.name && !read.error && typeof read.number === 'number') readPulls.add(read.number);
        continue;
      }
      if (deps.readOnly) {
        const error = 'Another change is waiting for the user\'s approval, so nothing else can change now. Ask them to approve or reject it first.';
        const stepId = toolStepId(deps.runId, call.id);
        emit(stepStarted(stepId, getToolSpec(call.name)?.label ?? call.name));
        emit(stepFinished(stepId, 'error', 'Not while a change waits for approval'));
        answer({ error });
        continue;
      }
      if (pending) {
        answer({ error: 'Only one change can wait for approval at a time. Offer this one again after the user decides on the first.' });
        continue;
      }
      const prepared = await prepareApproval(call, deps);
      if (prepared.kind === 'pending') {
        // No result yet: the call stays open until the user answers the interrupt.
        pending = prepared.pending;
        results.push({ callId: call.id, name: call.name, content: null });
      } else {
        answer(prepared.content);
      }
    }

    if (pending) {
      pending.results = results;
      return { status: 'awaiting-approval', pending };
    }
    thread.push({ role: 'tool', results });
  }

  text(emit, `${deps.runId}-msg-limit`, `I stopped after ${max} steps. Try a more specific request.`);
  return finish('');
}

const EMPTY_REMINDER =
  '[RepoPilot app] Your last reply was empty, so the user saw nothing. Answer their last message now: call a tool if it needs repository data, otherwise reply in one to three sentences.';

function reviewReminder(number: number): string {
  return `[RepoPilot app] No review draft exists yet: submit_pull_request_review was not called, so the user sees nothing to review. Call submit_pull_request_review now for pull request #${number}, with comments only on real problems (an empty list is fine). Never say a draft exists before the tool was called.`;
}

/**
 * The fallback review: a comment review with the model's own words as the
 * summary and no inline comments. It goes through the same dry run and approval
 * as a model-drafted one, so nothing is posted until the user submits it.
 */
async function draftReview(deps: AgentDeps, number: number, said: string): Promise<PendingApproval | null> {
  const summary = said.trim().slice(0, 2000) || 'Reviewed the changes; no problems found in the diff.';
  const call: ToolCall = {
    id: `${deps.runId}-auto-review`,
    name: submitPullRequestReview.name,
    args: { number, event: 'COMMENT', summary, comments: [] },
  };
  const prepared = await prepareApproval(call, deps);
  if (prepared.kind !== 'pending') return null;
  return { ...prepared.pending, synthetic: true, results: [] };
}

async function runTool(call: ToolCall, deps: AgentDeps, parentMessageId?: string): Promise<unknown> {
  const { emit } = deps;
  const spec = getToolSpec(call.name);
  const stepId = toolStepId(deps.runId, call.id);
  emit(stepStarted(stepId, spec?.label ?? call.name));

  const client = spec?.side === 'client';
  const fail = (message: string) => {
    // A refused client tool still shows its call (as the model sent it) before the error result.
    if (client) toolCall(emit, call.id, call.name, call.args, parentMessageId);
    emit(stepFinished(stepId, 'error', message));
    return { error: message };
  };

  if (!spec || (!deps.executors[spec.name] && !client)) return fail(`Unknown tool "${call.name}".`);
  // Defence in depth: the loop routes these to prepareApproval, never here.
  if (needsApproval(spec.name)) return fail(`"${spec.name}" changes the repository and needs user approval.`);
  if (client && deps.clientTools && !deps.clientTools.has(spec.name)) return fail(`"${spec.name}" is not available on this page.`);

  const parsed = spec.input.safeParse(dropNulls(call.args));
  if (!parsed.success) return fail(invalidInput(spec.name, parsed.error));

  // Client tools only change what is on screen. The call goes out with the validated arguments;
  // the browser checks them with the same schema and applies them when TOOL_CALL_END arrives.
  if (client) {
    toolCall(emit, call.id, spec.name, parsed.data, parentMessageId);
    emit(stepFinished(stepId, 'done', clientDetail(spec.name, parsed.data)));
    return { sentToApp: true, note: 'The app applies this on the user\'s screen. Say briefly what you did; do not repeat data.' };
  }

  try {
    const out = await deps.executors[spec.name](parsed.data, deps.ctx);
    if (out.ui) {
      const check = validateNode(out.ui);
      if (!check.ok) return fail(`The tool produced invalid UI: ${check.error}`);
      const surfaceId = `${deps.runId}-${call.id}`;
      emit(surfaceSnapshot(surfaceId, surfaceMessages(surfaceId, out.ui)));
    }
    emit(stepFinished(stepId, 'done', out.detail));
    return cap(out.data);
  } catch (err) {
    // ToolError is meant for the model; anything else is reported without internals.
    return fail(err instanceof ToolError ? err.message : `Tool failed: ${(err as Error).message}`);
  }
}

type Prepared = { kind: 'pending'; pending: PendingApproval } | { kind: 'result'; content: unknown };

/** Validate, dry-run and show the approval surface. Nothing here writes to GitHub. */
async function prepareApproval(call: ToolCall, deps: AgentDeps): Promise<Prepared> {
  const { emit } = deps;
  const spec = getToolSpec(call.name);
  const stepId = toolStepId(deps.runId, call.id);
  emit(stepStarted(stepId, `Dry run · ${spec?.label ?? call.name}`));

  const fail = (message: string): Prepared => {
    emit(stepFinished(stepId, 'error', message));
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
    emit(stepFinished(stepId, 'done', plan.detail));
    return { kind: 'result', content: cap(plan.data) };
  }

  const surfaceId = `${deps.runId}-${call.id}`;
  const component: GateComponent = plan.component ?? 'ApprovalCard';
  const card: CardProps = { ...plan.card, toolCallId: call.id, tool: spec.name, risk, status: 'pending', selected: plan.ids };
  const check = validateNode({ component, props: card });
  if (!check.ok) return fail(`Could not build the approval card: ${check.error}`);
  emit(surfaceSnapshot(surfaceId, surfaceMessages(surfaceId, { component, props: card })));

  emit(stepFinished(stepId, 'done', plan.detail));
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

/** JSON Schema of the answer an approval interrupt expects (Interrupt.responseSchema). */
const DECISION_SCHEMA = z.toJSONSchema(ApprovalDecision, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;

/** The AG-UI interrupt that pauses a run on a waiting change. Its id is the paused tool call's id. */
export function interruptOf(pending: PendingApproval): Interrupt {
  const meta: ApprovalInterruptMeta = { surfaceId: pending.surfaceId, tool: pending.tool, risk: pending.card['risk'] === 'destructive' ? 'destructive' : 'write' };
  return {
    id: pending.callId,
    reason: APPROVAL_INTERRUPT,
    message: approvalMessage(pending),
    // A review the app drafted itself has no tool call on the stream.
    ...(pending.synthetic ? {} : { toolCallId: pending.callId }),
    responseSchema: DECISION_SCHEMA,
    metadata: { [META_KEY]: meta },
  };
}

/** One line on what waits for the user, e.g. "Close 3 issues". */
function approvalMessage(pending: PendingApproval): string {
  const c = pending.card as Record<string, unknown>;
  if (pending.component === 'PrReview') return `Submit a review on pull request #${String((c['pr'] as { number?: unknown } | undefined)?.number ?? '')}`;
  if (pending.component === 'ReleaseForm') return `Publish release ${String(c['tag'] ?? '')}`;
  const n = pending.ids.length;
  return `${String(c['verb'] ?? 'Apply')} ${n} ${String(c['noun'] ?? 'item')}${n === 1 ? '' : 's'}`.replace(/^\w/, (s) => s.toUpperCase());
}

/** The real change, after the user decided. Returns the tool result for the model. */
async function carryOut(pending: PendingApproval, decision: Decision, deps: AgentDeps): Promise<unknown> {
  const { emit } = deps;
  // The step the client showed while the run waited; this run finishes it.
  const waitId = approvalStepId(pending.callId);
  emit(stepStarted(waitId, 'Waiting for your approval'));
  let shownCard = pending.card;
  const update = (patch: Partial<CardProps>) => showUpdate(deps, pending.surfaceId, pending.component, { ...shownCard, ...patch });

  const allowed = new Set(pending.ids);
  const ids = [...new Set(decision.selected ?? pending.ids)].filter((id) => allowed.has(id));
  const action = deps.actions[pending.tool];

  if (!decision.approve || (!pending.allowEmpty && pending.ids.length > 0 && ids.length === 0)) {
    update({ status: 'rejected', result: 'Rejected. Nothing was changed.' });
    emit(stepFinished(waitId, 'done', 'Rejected'));
    return { rejected: true, message: 'The user rejected this change. Nothing was changed.' };
  }

  // Edits only count when the tool declares what may be edited, and only in that shape.
  let edits: unknown;
  if (action?.edits && decision.edits !== undefined) {
    const parsed = action.edits.safeParse(decision.edits);
    if (!parsed.success) {
      const message = `Your changes could not be used (${parsed.error.issues[0]?.message ?? 'invalid'}). Nothing was changed.`;
      update({ status: 'failed', result: message.slice(0, 400) });
      emit(stepFinished(waitId, 'error', 'Invalid edits'));
      return { error: message };
    }
    edits = parsed.data;
    if (action.editedCard) shownCard = { ...shownCard, ...action.editedCard(shownCard, edits) };
  }

  // "Approved 2" for item lists; just "Approved" for a review or a release, which have no items to tick.
  emit(stepFinished(waitId, 'done', pending.ids.length ? `Approved ${ids.length}` : 'Approved'));
  update({ status: 'running', selected: ids });

  const spec = getToolSpec(pending.tool);
  const stepId = `${deps.runId}-exec-${pending.callId}`;
  emit(stepStarted(stepId, spec?.label ?? pending.tool));
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
    emit(stepFinished(stepId, out.ok ? 'done' : 'error', out.detail));
    await audit({ ok: out.ok, result: out.result, response: out.data, inverse: action.inverse?.(pending.input, ids, out, opts) ?? null });
    return { ...out.data, ...(deselected.length ? { keptByUser: deselected } : {}) };
  } catch (err) {
    const message = err instanceof ToolError ? err.message : `The change failed: ${(err as Error).message}`;
    await audit({ ok: false, result: message.slice(0, 400), inverse: null });
    update({ status: 'failed', selected: ids, result: message.slice(0, 400) });
    emit(stepFinished(stepId, 'error', message));
    return { error: message };
  }
}

/**
 * Updates the approval surface in place: the new props are validated like any
 * node, then sent as an A2UI data model update (the structure does not change).
 */
function showUpdate(deps: AgentDeps, surfaceId: string, component: GateComponent, props: CardProps) {
  const check = validateNode({ component, props });
  if (!check.ok) return;
  deps.emit(surfaceDelta(surfaceId, [propsUpdate(surfaceId, ROOT_ID, check.props as Record<string, unknown>)]));
}

/** The step detail for a client tool, e.g. "src/auth/login.js:12–18". */
function clientDetail(name: string, args: unknown): string {
  const a = args as Record<string, unknown>;
  if (name === 'highlight_lines') return `${String(a['path'])}:${String(a['from'])}–${String(a['to'])}`.slice(0, 200);
  if (name === 'navigate_to') return a['page'] === 'pull_request' ? `Pull request #${String(a['number'])}` : String(a['page']).replace('_', ' ');
  if (name === 'apply_table_filter') {
    if (a['clear']) return 'Filter cleared';
    const parts = [...((a['labels'] as string[]) ?? []), a['state'], a['author']].filter(Boolean);
    return parts.length ? parts.join(', ').slice(0, 200) : 'No filter';
  }
  return 'Done';
}

function invalidInput(tool: string, error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return `Invalid input for ${tool}: ${error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`;
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
