import {
  A2UI_OPERATIONS_KEY,
  EventType,
  navigateTo,
  propsOf,
  readSurface,
  ROOT_ID,
  rootComponent,
  stepMeta,
  type A2uiMessage,
  type AgUiEvent,
} from '@repopilot/shared';
import { EventSchemas } from '@ag-ui/core/schemas';
import * as z from 'zod';
import type { ChatMessage, LlmProvider, LlmReply, LlmRequest } from '../llm';
import { LlmError, withFallback } from '../llm';
import { interruptOf, resumeAgent, runAgent, type AgentDeps, type ExecutedChange, type PendingApproval } from './loop';
import { buildToolDefs } from './prompt';
import type { ActionTool, Plan } from '../tools/actions';
import { executors, ToolError, type Executor } from '../tools/read-tools';

/** A model that replies from a script, and records what it was sent. */
function scripted(...replies: Partial<LlmReply>[]): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-1',
    requests,
    async generate(req) {
      requests.push(structuredClone(req));
      const next = replies.shift() ?? { text: 'done' };
      return { text: '', toolCalls: [], model: 'fake-1', ...next };
    },
  };
}

const prs: Executor<any> = async () => ({
  data: { count: 1 },
  ui: { component: 'PrList', props: { items: [{ number: 15, title: 'Add rate limiting', state: 'open', ageDays: 3 }] } },
  detail: '1 found',
});

function setup(provider: LlmProvider, overrides: Partial<AgentDeps> = {}) {
  const events: AgUiEvent[] = [];
  const thread: ChatMessage[] = [];
  const deps: AgentDeps = {
    provider,
    system: 'test',
    tools: buildToolDefs(),
    executors: { ...executors, list_pull_requests: prs },
    actions: {},
    ctx: { github: {} as never, repo: 'octo/demo' },
    emit: (e) => events.push(e),
    runId: 'r1',
    ...overrides,
  };
  return { events, thread, deps, run: (prompt: string) => runAgent(thread, prompt, deps) };
}

const ofType = <T extends AgUiEvent['type']>(events: AgUiEvent[], type: T) =>
  events.filter((e): e is Extract<AgUiEvent, { type: T }> => e.type === type);

/** A2UI surfaces the run created (ACTIVITY_SNAPSHOT), as surface id + root component. */
const shown = (events: AgUiEvent[]) =>
  ofType(events, EventType.ACTIVITY_SNAPSHOT).map((e) => {
    const view = readSurface((e.content as Record<string, A2uiMessage[]>)[A2UI_OPERATIONS_KEY]);
    return { surfaceId: view.surfaceId, component: rootComponent(view) };
  });

const stepLabels = (events: AgUiEvent[]) => ofType(events, EventType.STEP_STARTED).map((e) => stepMeta(e).label);
const finished = (events: AgUiEvent[]) => ofType(events, EventType.STEP_FINISHED).map((e) => ({ id: e.stepName, ...stepMeta(e) }));
const texts = (events: AgUiEvent[]) => ofType(events, EventType.TEXT_MESSAGE_CONTENT).map((e) => e.delta);

describe('runAgent', () => {
  it('runs a read tool, streams its UI, then the model summary', async () => {
    const model = scripted(
      { toolCalls: [{ id: 'c1', name: 'list_pull_requests', args: { state: 'open' } }] },
      { text: 'One open PR; CI is green.' },
    );
    const { events, run, thread } = setup(model);
    await run('Show my open PRs');

    expect(shown(events)).toEqual([{ surfaceId: 'r1-c1', component: 'PrList' }]);
    expect(texts(events)).toEqual(['One open PR; CI is green.']);

    expect(stepLabels(events)).toEqual(['Understanding the request', 'Listing pull requests', 'Reviewing results']);
    expect(finished(events).every((s) => s.status === 'done')).toBe(true);

    // The call and its result are on the stream too (AG-UI tool call events).
    expect(ofType(events, EventType.TOOL_CALL_START)).toEqual([expect.objectContaining({ toolCallId: 'c1', toolCallName: 'list_pull_requests' })]);
    expect(JSON.parse(ofType(events, EventType.TOOL_CALL_ARGS)[0].delta)).toEqual({ state: 'open' });
    expect(ofType(events, EventType.TOOL_CALL_RESULT)).toEqual([expect.objectContaining({ toolCallId: 'c1', content: '{"count":1}' })]);
    // Every event is a valid AG-UI event.
    for (const e of events) expect(() => EventSchemas.parse(e)).not.toThrow();

    // The model received the tool result, and the thread keeps the whole exchange.
    const second = model.requests[1].messages.at(-1);
    expect(second).toMatchObject({ role: 'tool', results: [{ callId: 'c1', content: { count: 1 } }] });
    expect(thread.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('returns invalid tool input to the model instead of running the tool', async () => {
    let called = false;
    const spy: Executor<any> = async () => ((called = true), { data: {} });
    const model = scripted({ toolCalls: [{ id: 'c1', name: 'list_pull_requests', args: { limit: 9999 } }] });
    const { events, run } = setup(model, { executors: { list_pull_requests: spy } });
    await run('x');

    expect(called).toBe(false);
    const result = model.requests[1].messages.at(-1) as Extract<ChatMessage, { role: 'tool' }>;
    expect(JSON.stringify(result.results[0].content)).toContain('limit');
    expect(finished(events).some((s) => s.status === 'error')).toBe(true);
  });

  it('never runs an unknown non-read tool, even when an executor exists', async () => {
    let called = false;
    const merge: Executor<any> = async () => ((called = true), { data: {} });
    const model = scripted({ toolCalls: [{ id: 'c1', name: 'merge_pull_request', args: { number: 15 } }] });
    const { events, run } = setup(model, { executors: { ...executors, merge_pull_request: merge } });
    await run('merge #15');

    expect(called).toBe(false);
    expect(shown(events)).toHaveLength(0);
    const result = model.requests[1].messages.at(-1) as Extract<ChatMessage, { role: 'tool' }>;
    expect(JSON.stringify(result.results[0].content)).toContain('Unknown tool');
  });

  it('does not let render_ui show an approval card, even nested', async () => {
    const fake = { component: 'ApprovalCard', props: { toolCallId: 'x', tool: 't', risk: 'write', verb: 'close', noun: 'issue', summary: '', reversible: true } };
    const model = scripted({ toolCalls: [{ id: 'c1', name: 'render_ui', args: { node: { component: 'Grid', props: { children: [fake] } } } }] });
    const { events, run } = setup(model);
    await run('x');

    expect(shown(events)).toHaveLength(0);
    const result = model.requests[1].messages.at(-1) as Extract<ChatMessage, { role: 'tool' }>;
    expect(JSON.stringify(result.results[0].content)).toContain('ApprovalCard is shown by the app itself');
  });

  it('lets the model fix an invalid render_ui node', async () => {
    const model = scripted(
      { toolCalls: [{ id: 'c1', name: 'render_ui', args: { node: { component: 'StatCard', props: { label: 'PRs' } } } }] },
      { toolCalls: [{ id: 'c2', name: 'render_ui', args: { node: { component: 'StatCard', props: { label: 'PRs', value: 3 } } } }] },
      { text: 'Shown.' },
    );
    const { events, run } = setup(model);
    await run('show a stat');

    const firstResult = model.requests[1].messages.at(-1) as Extract<ChatMessage, { role: 'tool' }>;
    expect(JSON.stringify(firstResult.results[0].content)).toContain('Invalid UI node');
    expect(shown(events).map((s) => s.surfaceId)).toEqual(['r1-c2']);
  });

  it('never streams UI that fails validation', async () => {
    const bad: Executor<any> = async () => ({ data: {}, ui: { component: 'ScriptInjector', props: {} } });
    const model = scripted({ toolCalls: [{ id: 'c1', name: 'list_pull_requests', args: {} }] });
    const { events, run } = setup(model, { executors: { list_pull_requests: bad } });
    await run('x');
    expect(shown(events)).toHaveLength(0);
  });

  it('passes ToolError messages to the model', async () => {
    const denied: Executor<any> = async () => {
      throw new ToolError('Repository "evil/repo" is not allowed.');
    };
    const model = scripted({ toolCalls: [{ id: 'c1', name: 'list_issues', args: { repo: 'evil/repo' } }] });
    const { run } = setup(model, { executors: { list_issues: denied } });
    await run('x');
    const result = model.requests[1].messages.at(-1) as Extract<ChatMessage, { role: 'tool' }>;
    expect(result.results[0].content).toEqual({ error: 'Repository "evil/repo" is not allowed.' });
  });

  it('finishes with a note when the model fails after data is on screen', async () => {
    const model = scripted({ toolCalls: [{ id: 'c1', name: 'list_pull_requests', args: {} }] });
    const failing: LlmProvider = {
      ...model,
      generate: async (req) => {
        if (model.requests.length === 0) return model.generate(req);
        throw new LlmError('HTTP 429 quota', true, 429);
      },
    };
    const { events, run, thread } = setup(failing);
    await expect(run('Show my open PRs')).resolves.toEqual({ status: 'done' });
    expect(shown(events)).toHaveLength(1);
    expect(texts(events).at(-1)).toContain('could not write a summary');
    // History stays consistent: the tool results are answered by an assistant turn.
    expect(thread.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('still fails when the model is down before anything was shown', async () => {
    const down: LlmProvider = { name: 'x', model: 'x', generate: async () => { throw new LlmError('HTTP 429 quota', true, 429); } };
    const { run } = setup(down);
    await expect(run('Show my open PRs')).rejects.toThrow('429');
  });

  it('treats null optional arguments from small models as absent', async () => {
    let received: unknown;
    const spy: Executor<any> = async (input) => ((received = input), { data: {} });
    const model = scripted({ toolCalls: [{ id: 'c1', name: 'list_pull_requests', args: { repo: null, limit: null, state: 'open' } }] });
    const { run } = setup(model, { executors: { list_pull_requests: spy } });
    await run('Show my open PRs');
    expect(received).toEqual({ state: 'open', limit: 20 });
  });

  it('sends the model the last 6 turns and a summary of older ones, but keeps the whole thread', async () => {
    const model = scripted();
    const { run, thread } = setup(model);
    for (let n = 1; n <= 7; n++) await run(`question ${n}`);

    const last = model.requests.at(-1)!;
    expect(last.messages[0]).toEqual({ role: 'user', text: 'question 2' });
    expect(last.messages.filter((m) => m.role === 'user')).toHaveLength(6);
    expect(last.system).toContain('Earlier in this conversation');
    expect(last.system).toContain('- User: "question 1" → agent: "done"');
    expect(thread.filter((m) => m.role === 'user')).toHaveLength(7);
  });

  it('reminds the model once when it replies with nothing, and the user gets its real answer', async () => {
    const model = scripted({ text: '' }, { text: 'It is a small Angular app with 8 open PRs.' });
    const { run, events, thread } = setup(model);
    await run('give details about this repo');

    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].messages.at(-1)).toMatchObject({ role: 'user', text: expect.stringContaining('Your last reply was empty') });
    expect(texts(events)).toEqual(['It is a small Angular app with 8 open PRs.']);
    expect(thread.at(-1)).toMatchObject({ role: 'assistant', text: 'It is a small Angular app with 8 open PRs.' });
  });

  it('says so instead of showing nothing when the model stays empty', async () => {
    const model = scripted({ text: '' }, { text: '  ' });
    const { run, events } = setup(model);
    expect(await run('give details about this repo')).toEqual({ status: 'done' });
    expect(texts(events)).toEqual([expect.stringContaining('could not produce an answer')]);
    expect(model.requests).toHaveLength(2);
  });

  it('does not nag when a tool already showed the answer', async () => {
    const model = scripted({ toolCalls: [{ id: 'c1', name: 'list_pull_requests', args: {} }] }, { text: '' });
    const { run, events } = setup(model);
    await run('Show my open PRs');
    expect(model.requests).toHaveLength(2);
    expect(texts(events)).toEqual([]);
  });

  it('stops after the iteration limit', async () => {
    const loop = { toolCalls: [{ id: 'c', name: 'list_pull_requests', args: {} }] };
    const { events, run } = setup(scripted(loop, loop, loop, loop), { maxIterations: 3 });
    await run('x');
    expect(texts(events).at(-1)).toContain('stopped after 3 steps');
  });
});

/** A destructive tool double that records what the loop asked of it. */
function fakeAction(ids = [118, 131, 140], plan?: Plan) {
  const calls = { plan: 0, execute: [] as number[][] };
  const tool: ActionTool<any> = {
    async plan() {
      calls.plan++;
      return (
        plan ?? {
          kind: 'card',
          ids,
          detail: `${ids.length} would change`,
          card: {
            verb: 'close',
            noun: 'issue',
            summary: 'Close them.',
            items: ids.map((id) => ({ id, title: `Issue ${id}` })),
            skipped: [],
            details: [],
            reversible: true,
          },
        }
      );
    },
    async execute(_input, picked) {
      calls.execute.push(picked);
      return { ok: true, data: { changed: picked }, result: `Closed ${picked.length} issues.`, detail: 'done' };
    },
    summary: (_input, picked) => `Close ${picked.length} issues`,
    inverse: (_input, picked) => ({ kind: 'issues', label: 'Reopen them', input: { issueNumbers: picked, action: 'reopen', reason: 'not_planned' } }),
  };
  return { tool, calls };
}

const closeCall = (id = 'c1') => ({ id, name: 'bulk_update_issues', args: { issueNumbers: [118, 131, 140], action: 'close' } });

/**
 * The approval card's props after each change: its A2UI surface is created once
 * (ACTIVITY_SNAPSHOT), then updated in place by data model updates (ACTIVITY_DELTA).
 */
const cards = (events: AgUiEvent[]) => {
  const ops = new Map<string, A2uiMessage[]>();
  const out: Record<string, unknown>[] = [];
  for (const e of events) {
    if (e.type === EventType.ACTIVITY_SNAPSHOT) ops.set(e.messageId, [...(e.content as Record<string, A2uiMessage[]>)[A2UI_OPERATIONS_KEY]]);
    else if (e.type === EventType.ACTIVITY_DELTA) ops.get(e.messageId)?.push(...e.patch.map((p) => (p as { value: A2uiMessage }).value));
    else continue;
    const view = readSurface(ops.get(e.messageId) ?? []);
    if (rootComponent(view) === 'ApprovalCard') out.push(propsOf(view, ROOT_ID));
  }
  return out;
};

/** Arguments of the client tool calls on the stream that the browser would apply (they pass the tool's schema). */
const clientCalls = (events: AgUiEvent[]) =>
  ofType(events, EventType.TOOL_CALL_START)
    .filter((s) => ['highlight_lines', 'navigate_to', 'apply_table_filter'].includes(s.toolCallName))
    .map((s) => ({ name: s.toolCallName, args: JSON.parse(ofType(events, EventType.TOOL_CALL_ARGS).find((a) => a.toolCallId === s.toolCallId)!.delta) }));

describe('client tools', () => {
  it('validates the input and hands the call to the browser as AG-UI tool call events, without an executor', async () => {
    const model = scripted(
      { toolCalls: [{ id: 'h1', name: 'highlight_lines', args: { path: 'src/auth/login.js', from: 12, to: 18 } }] },
      { text: 'The rate limit is set on lines 12–18.' },
    );
    const { run, events } = setup(model);
    await run('take me to the auth changes');

    expect(clientCalls(events)).toEqual([{ name: 'highlight_lines', args: { path: 'src/auth/login.js', from: 12, to: 18 } }]);
    expect(ofType(events, EventType.TOOL_CALL_END).map((e) => e.toolCallId)).toEqual(['h1']);
    expect(finished(events).find((s) => s.id.includes('h1'))).toMatchObject({ status: 'done', detail: 'src/auth/login.js:12–18' });
    expect(model.requests[1].messages.at(-1)).toMatchObject({ role: 'tool', results: [{ content: { sentToApp: true } }] });
  });

  it('sends invalid client tool input only as the model wrote it, with an error result the browser will not apply', async () => {
    const model = scripted({ toolCalls: [{ id: 'n1', name: 'navigate_to', args: { page: 'pull_request' } }] }, { text: 'Sorry.' });
    const { run, events } = setup(model);
    await run('open the PR');
    const [call] = clientCalls(events);
    expect(navigateTo.input.safeParse(call.args).success).toBe(false);
    expect(ofType(events, EventType.TOOL_CALL_RESULT)[0].content).toContain('needs a number');
    expect(JSON.stringify(model.requests[1].messages.at(-1))).toContain('needs a number');
  });

  it('refuses a client tool the page did not declare', async () => {
    const model = scripted({ toolCalls: [{ id: 'h1', name: 'highlight_lines', args: { path: 'a.js', from: 1, to: 2 } }] }, { text: 'ok' });
    const { run } = setup(model, { clientTools: new Set(['navigate_to']) });
    await run('x');
    expect(JSON.stringify(model.requests[1].messages.at(-1))).toContain('not available on this page');
  });
});

describe('reasoning and usage', () => {
  it('streams the model\'s thought summary as an AG-UI reasoning span and reports token usage', async () => {
    const usage: unknown[] = [];
    const model = scripted({ text: 'Hi.', reasoning: 'The user greets me.', usage: { provider: 'fake', model: 'fake-1', inputTokens: 10, outputTokens: 3 } });
    const { run, events } = setup(model, { onUsage: (u) => void usage.push(u) });
    await run('hello');
    expect(events.map((e) => e.type).filter((t) => t.startsWith('REASONING'))).toEqual([
      'REASONING_START',
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END',
      'REASONING_END',
    ]);
    expect(ofType(events, EventType.REASONING_MESSAGE_CONTENT)[0].delta).toBe('The user greets me.');
    expect(usage).toEqual([{ provider: 'fake', model: 'fake-1', inputTokens: 10, outputTokens: 3 }]);
  });
});

describe('side questions while a change waits (readOnly)', () => {
  it('refuses any change in code, without a dry run', async () => {
    const { tool, calls } = fakeAction();
    const model = scripted({ toolCalls: [closeCall()] }, { text: 'It has to wait.' });
    const { run, events } = setup(model, { actions: { bulk_update_issues: tool }, readOnly: true });

    expect(await run('also close #118')).toEqual({ status: 'done' });
    expect(calls.plan).toBe(0);
    expect(cards(events)).toEqual([]);
    expect(JSON.stringify(model.requests[1].messages.at(-1))).toContain('Another change is waiting');
  });

  it('owes no review draft in a side question', async () => {
    const model = scripted({ text: 'Lines 12–18.' });
    const { tool, calls } = fakeAction();
    const { run } = setup(model, { actions: { submit_pull_request_review: tool }, reviewPullRequest: 16, readOnly: true });
    expect(await run('Review where the key is built')).toEqual({ status: 'done' });
    expect(calls.plan).toBe(0);
    expect(model.requests).toHaveLength(1);
  });
});

describe('approval gate', () => {
  it('pauses a destructive call on an approval card without changing anything', async () => {
    const model = scripted({ text: 'Here is what would change.', toolCalls: [closeCall()] });
    const { tool, calls } = fakeAction();
    const { events, run, thread } = setup(model, { actions: { bulk_update_issues: tool } });
    const outcome = await run('Close all wontfix issues');

    expect(outcome.status).toBe('awaiting-approval');
    expect(calls.plan).toBe(1);
    expect(calls.execute).toEqual([]);
    expect(model.requests).toHaveLength(1); // the model waits too
    expect(cards(events)).toEqual([
      expect.objectContaining({ toolCallId: 'c1', risk: 'destructive', status: 'pending', selected: [118, 131, 140] }),
    ]);
    // The run ends as an AG-UI interrupt for this call; the call stays open (no result yet).
    expect(interruptOf((outcome as { pending: PendingApproval }).pending)).toMatchObject({
      id: 'c1',
      reason: 'tool_approval',
      toolCallId: 'c1',
      message: 'Close 3 issues',
      responseSchema: expect.objectContaining({ type: 'object' }),
      metadata: { repopilot: { surfaceId: 'r1-c1', tool: 'bulk_update_issues', risk: 'destructive' } },
    });
    expect(ofType(events, EventType.TOOL_CALL_START).map((e) => e.toolCallId)).toEqual(['c1']);
    expect(ofType(events, EventType.TOOL_CALL_RESULT)).toEqual([]);
    expect(stepLabels(events)).toContain('Dry run · Updating issues');
    expect(thread.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('executes only approved items from the dry run, then lets the model summarise', async () => {
    const model = scripted({ toolCalls: [closeCall()] }, { text: 'Closed 2 issues; #131 stays open.' });
    const { tool, calls } = fakeAction();
    const { events, run, thread, deps } = setup(model, { actions: { bulk_update_issues: tool } });
    const paused = await run('Close all wontfix issues');
    const pending = (paused as { pending: PendingApproval }).pending;

    // 999 was never in the dry run: it is dropped, not executed.
    const outcome = await resumeAgent(thread, pending, { approve: true, selected: [118, 140, 999] }, deps);

    expect(outcome).toEqual({ status: 'done' });
    expect(calls.execute).toEqual([[118, 140]]);
    expect(cards(events).map((c) => c.status)).toEqual(['pending', 'running', 'approved']);
    expect(cards(events).at(-1)).toMatchObject({ selected: [118, 140], result: 'Closed 2 issues.' });
    const result = model.requests[1].messages.at(-1) as Extract<ChatMessage, { role: 'tool' }>;
    expect(result.results[0].content).toEqual({ changed: [118, 140], keptByUser: [131] });
    expect(thread.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('changes nothing on reject and tells the model', async () => {
    const model = scripted({ toolCalls: [closeCall()] }, { text: 'OK, nothing was closed.' });
    const { tool, calls } = fakeAction();
    const { events, run, thread, deps } = setup(model, { actions: { bulk_update_issues: tool } });
    const paused = (await run('Close all wontfix issues')) as { pending: PendingApproval };
    await resumeAgent(thread, paused.pending, { approve: false }, deps);

    expect(calls.execute).toEqual([]);
    expect(cards(events).at(-1)).toMatchObject({ status: 'rejected' });
    const result = model.requests[1].messages.at(-1) as Extract<ChatMessage, { role: 'tool' }>;
    expect(result.results[0].content).toMatchObject({ rejected: true });
  });

  /** A gate whose tool declares editable fields and allows approving with nothing ticked (like a PR review). */
  function editableAction() {
    const base = fakeAction();
    const seen: unknown[] = [];
    const tool: ActionTool<any> = {
      async plan(input, ctx) {
        const plan = await base.tool.plan(input, ctx);
        return { ...plan, allowEmpty: true, carry: { sha: 'abc' } } as Plan;
      },
      edits: z.object({ summary: z.string().max(5) }),
      editedCard: (_card, edits) => ({ summary: (edits as { summary: string }).summary }),
      summary: () => 'Edited change',
      async execute(_input, ids, _ctx, opts) {
        seen.push({ ids, ...opts });
        return { ok: true, data: {}, result: 'Done.', detail: 'done' };
      },
    };
    return { tool, seen };
  }

  it('hands checked edits and the dry-run carry to execute, and allows an empty selection when the tool does', async () => {
    const model = scripted({ toolCalls: [closeCall()] }, { text: 'done' });
    const { tool, seen } = editableAction();
    const { events, run, thread, deps } = setup(model, { actions: { bulk_update_issues: tool } });
    const paused = (await run('x')) as { pending: PendingApproval };
    await resumeAgent(thread, paused.pending, { approve: true, selected: [], edits: { summary: 'hi' } }, deps);

    expect(seen).toEqual([{ ids: [], edits: { summary: 'hi' }, carry: { sha: 'abc' } }]);
    // The surface shows the user's edit while running and after.
    expect(cards(events).slice(1)).toEqual([
      expect.objectContaining({ status: 'running', summary: 'hi' }),
      expect.objectContaining({ status: 'approved', summary: 'hi' }),
    ]);
  });

  it('changes nothing when the edits do not match the tool schema', async () => {
    const model = scripted({ toolCalls: [closeCall()] }, { text: 'done' });
    const { tool, seen } = editableAction();
    const { events, run, thread, deps } = setup(model, { actions: { bulk_update_issues: tool } });
    const paused = (await run('x')) as { pending: PendingApproval };
    await resumeAgent(thread, paused.pending, { approve: true, edits: { summary: 'far too long' } }, deps);

    expect(seen).toEqual([]);
    expect(cards(events).at(-1)).toMatchObject({ status: 'failed' });
    const result = model.requests[1].messages.at(-1) as Extract<ChatMessage, { role: 'tool' }>;
    expect(JSON.stringify(result.results[0].content)).toContain('Nothing was changed');
  });

  it('records every approved change for the audit log, with what the user kept and how to undo it', async () => {
    const model = scripted({ toolCalls: [closeCall()] }, { text: 'done' });
    const { tool } = fakeAction();
    const changes: ExecutedChange[] = [];
    const { run, thread, deps } = setup(model, { actions: { bulk_update_issues: tool }, onExecuted: (c) => void changes.push(c) });
    const paused = (await run('Close all wontfix issues')) as { pending: PendingApproval };
    await resumeAgent(thread, { ...paused.pending, prompt: 'Close all wontfix issues' }, { approve: true, selected: [118, 140] }, deps);

    expect(changes).toEqual([
      expect.objectContaining({
        tool: 'bulk_update_issues',
        risk: 'destructive',
        summary: 'Close 2 issues',
        prompt: 'Close all wontfix issues',
        approvedIds: [118, 140],
        keptByUser: [131],
        ok: true,
        result: 'Closed 2 issues.',
        inverse: expect.objectContaining({ kind: 'issues' }),
      }),
    ]);
  });

  it('writes no audit entry when the user rejects', async () => {
    const model = scripted({ toolCalls: [closeCall()] }, { text: 'done' });
    const { tool } = fakeAction();
    const changes: ExecutedChange[] = [];
    const { run, thread, deps } = setup(model, { actions: { bulk_update_issues: tool }, onExecuted: (c) => void changes.push(c) });
    const paused = (await run('x')) as { pending: PendingApproval };
    await resumeAgent(thread, paused.pending, { approve: false }, deps);
    expect(changes).toEqual([]);
  });

  it('lets only one change wait per model turn', async () => {
    const model = scripted({ toolCalls: [closeCall('c1'), closeCall('c2')] }, { text: 'done' });
    const { tool, calls } = fakeAction();
    const { run, thread, deps } = setup(model, { actions: { bulk_update_issues: tool } });
    const paused = (await run('x')) as { pending: PendingApproval };

    expect(calls.plan).toBe(1);
    await resumeAgent(thread, paused.pending, { approve: false }, deps);
    const result = model.requests[1].messages.at(-1) as Extract<ChatMessage, { role: 'tool' }>;
    expect(result.results.map((r) => r.callId)).toEqual(['c1', 'c2']);
    expect(JSON.stringify(result.results[1].content)).toContain('Only one change');
  });

  it('does not pause when the dry run finds nothing to change', async () => {
    const empty: Plan = { kind: 'empty', data: { nothingToChange: true }, detail: 'nothing to change' };
    const model = scripted({ toolCalls: [closeCall()] }, { text: 'They are already closed.' });
    const { tool, calls } = fakeAction([], empty);
    const { events, run } = setup(model, { actions: { bulk_update_issues: tool } });

    expect(await run('x')).toEqual({ status: 'done' });
    expect(calls.execute).toEqual([]);
    expect(shown(events)).toHaveLength(0);
    const result = model.requests[1].messages.at(-1) as Extract<ChatMessage, { role: 'tool' }>;
    expect(result.results[0].content).toEqual({ nothingToChange: true });
  });

  it('returns invalid input to the model without a dry run', async () => {
    const model = scripted({ toolCalls: [{ id: 'c1', name: 'bulk_update_issues', args: { issueNumbers: [], action: 'close' } }] });
    const { tool, calls } = fakeAction();
    const { run } = setup(model, { actions: { bulk_update_issues: tool } });
    await run('x');

    expect(calls.plan).toBe(0);
    const result = model.requests[1].messages.at(-1) as Extract<ChatMessage, { role: 'tool' }>;
    expect(JSON.stringify(result.results[0].content)).toContain('Invalid input for bulk_update_issues');
  });
});

describe('review fallback (PR review page)', () => {
  function reviewAction() {
    const inputs: unknown[] = [];
    const { tool, calls } = fakeAction();
    const wrapped: ActionTool<any> = {
      ...tool,
      async plan(input, ctx) {
        inputs.push(input);
        return { ...(await tool.plan(input, ctx)), allowEmpty: true } as Plan;
      },
    };
    return { tool: wrapped, inputs, calls };
  }

  it('reminds the model once, then drafts a summary-only review from its first reply, and reports the outcome as a note', async () => {
    const model = scripted({ text: 'It adds an API reference to docs/api.md.' }, { text: 'Sorry.' }, { text: 'Review posted.' });
    const { tool, inputs, calls } = reviewAction();
    const { run, thread, deps, events } = setup(model, { actions: { submit_pull_request_review: tool }, reviewPullRequest: 16 });

    const outcome = await run('Review pull request #16');
    expect(outcome.status).toBe('awaiting-approval');
    const pending = (outcome as { pending: PendingApproval }).pending;
    expect(pending.synthetic).toBe(true);
    expect(inputs).toEqual([{ number: 16, event: 'COMMENT', summary: 'It adds an API reference to docs/api.md.', comments: [] }]);
    // The reminder is the only app message; no fake tool call in the history.
    expect(thread.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(thread[2]).toMatchObject({ text: expect.stringContaining('submit_pull_request_review was not called') });
    // The reply before the reminder is held back (it may claim a draft that does not exist).
    expect(texts(events)).toEqual(['Sorry.']);

    const resumed = await resumeAgent(thread, pending, { approve: true, selected: [] }, deps);
    expect(resumed).toEqual({ status: 'done' }); // no second draft after the decision
    expect(calls.execute).toHaveLength(1);
    expect(model.requests[2].messages.at(-1)).toMatchObject({ role: 'user', text: expect.stringContaining('[RepoPilot app]') });
  });

  it('lets the model draft the real review after the reminder, without showing its false claim', async () => {
    const model = scripted(
      { text: 'I have drafted a review for pull request #16.' },
      { toolCalls: [{ id: 'r1', name: 'submit_pull_request_review', args: { number: 16, event: 'COMMENT', summary: 'Docs only.', comments: [] } }] },
    );
    const { tool, inputs } = reviewAction();
    const { run, events } = setup(model, { actions: { submit_pull_request_review: tool }, reviewPullRequest: 16 });

    const outcome = await run('Review pull request #16');
    expect(outcome.status).toBe('awaiting-approval');
    expect((outcome as { pending: PendingApproval }).pending.synthetic).toBeUndefined();
    expect(inputs).toEqual([{ number: 16, event: 'COMMENT', summary: 'Docs only.', comments: [] }]);
    expect(texts(events)).not.toContain('I have drafted a review for pull request #16.');
  });

  it('owes a review in Ask too, when the user asks for one and the run read exactly one pull request', async () => {
    const readPr: Executor<any> = async (input: { number: number }) => ({ data: { number: input.number, files: [] }, detail: 'read' });
    const read = { toolCalls: [{ id: 'g1', name: 'get_pull_request', args: { number: 16 } }] };

    const asked = reviewAction();
    const ask = setup(scripted(read, { text: 'Looks fine.' }, { text: 'Done.' }), {
      executors: { ...executors, get_pull_request: readPr },
      actions: { submit_pull_request_review: asked.tool },
    });
    expect((await ask.run('Can you review PR #16?')).status).toBe('awaiting-approval');
    expect(asked.inputs).toEqual([{ number: 16, event: 'COMMENT', summary: 'Looks fine.', comments: [] }]);

    // Reading a pull request without asking for a review drafts nothing.
    const notAsked = reviewAction();
    const look = setup(scripted(read, { text: 'It adds docs.' }), {
      executors: { ...executors, get_pull_request: readPr },
      actions: { submit_pull_request_review: notAsked.tool },
    });
    expect(await look.run('What does PR #16 change?')).toEqual({ status: 'done' });
    expect(notAsked.inputs).toEqual([]);
  });

  it('still drafts the review when the model fails after the reminder', async () => {
    const model = scripted({ text: 'Adds docs.' });
    model.generate = (async (req: LlmRequest) => {
      model.requests.push(req);
      if (model.requests.length > 1) throw new LlmError('overloaded', true, 503);
      return { text: 'Adds docs.', toolCalls: [], model: 'fake-1' };
    }) as typeof model.generate;
    const { tool, inputs } = reviewAction();
    const { run } = setup(model, { actions: { submit_pull_request_review: tool }, reviewPullRequest: 16 });
    expect((await run('Review pull request #16')).status).toBe('awaiting-approval');
    expect(inputs).toEqual([{ number: 16, event: 'COMMENT', summary: 'Adds docs.', comments: [] }]);
  });

  it('does not draft one when the run is not a PR review', async () => {
    const { tool, inputs } = reviewAction();
    const { run } = setup(scripted({ text: 'Hi.' }), { actions: { submit_pull_request_review: tool } });
    expect(await run('hello')).toEqual({ status: 'done' });
    expect(inputs).toEqual([]);
  });
});

describe('withFallback', () => {
  const failing = (retryable: boolean): LlmProvider => ({
    name: 'p',
    model: 'primary',
    generate: async () => {
      throw new LlmError('HTTP 503', retryable, 503);
    },
  });

  it('uses the fallback model when the primary is overloaded', async () => {
    const seen: string[] = [];
    const p = withFallback(failing(true), scripted({ text: 'hi' }), (e) => seen.push(e.message));
    const reply = await p.generate({ system: '', messages: [], tools: [] });
    expect(reply.text).toBe('hi');
    expect(seen).toEqual(['HTTP 503']);
  });

  it('does not hide non-retryable errors', async () => {
    const p = withFallback(failing(false), scripted({ text: 'hi' }));
    await expect(p.generate({ system: '', messages: [], tools: [] })).rejects.toThrow('HTTP 503');
  });
});
