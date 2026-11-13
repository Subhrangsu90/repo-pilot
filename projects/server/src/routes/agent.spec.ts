import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { EventType, type AgUiEvent } from '@repopilot/shared';
import type { LlmProvider, LlmReply } from '../llm';
import { buildToolDefs } from '../agent/prompt';
import type { ActionTool } from '../tools/actions';
import { executors, type Executor } from '../tools/read-tools';
import { registerAgentRoutes } from './agent';

/** A model that answers from a script shared by every run of the test. */
function scripted(replies: Partial<LlmReply>[]): LlmProvider {
  return { name: 'fake', model: 'fake-1', generate: async () => ({ text: '', toolCalls: [], model: 'fake-1', ...(replies.shift() ?? { text: 'done' }) }) };
}

const prs: Executor<any> = async () => ({
  data: { count: 1 },
  ui: { component: 'PrList', props: { items: [{ number: 15, title: 'Add rate limiting', state: 'open', ageDays: 3 }] } },
  detail: '1 found',
});

function closeAction() {
  const executed: number[][] = [];
  const tool: ActionTool<any> = {
    async plan() {
      return {
        kind: 'card',
        ids: [118, 131],
        detail: '2 would change',
        card: { verb: 'close', noun: 'issue', summary: 'Close them.', items: [{ id: 118, title: 'A' }, { id: 131, title: 'B' }], skipped: [], details: [], reversible: true },
      };
    },
    async execute(_input, ids) {
      executed.push(ids);
      return { ok: true, data: { changed: ids }, result: `Closed ${ids.length}.`, detail: 'done' };
    },
    summary: () => 'Close issues',
  };
  return { tool, executed };
}

function server(replies: Partial<LlmReply>[], login = 'octocat') {
  const app = Fastify();
  const provider = scripted(replies);
  const action = closeAction();
  const user = { login };
  registerAgentRoutes(app, {
    who: () => ({ login: user.login, ctx: { github: {} as never } }),
    githubReady: true,
    noGithub: '',
    ensureThread: async () => {},
    toolDefs: buildToolDefs(),
    agentDeps: (u, _thread, run, emit, extra) => ({
      provider,
      system: 'test',
      tools: buildToolDefs(),
      executors: { ...executors, list_pull_requests: prs },
      actions: { bulk_update_issues: action.tool },
      ctx: u.ctx,
      emit,
      runId: run.id,
      signal: run.signal,
      onUsage: run.addUsage,
      ...extra,
    }),
  });
  return { app, action, user };
}

const input = (threadId: string, extra: Record<string, unknown> = {}) => ({
  threadId,
  runId: randomUUID(),
  messages: [{ id: randomUUID(), role: 'user', content: 'Show my open PRs' }],
  tools: [],
  context: [],
  forwardedProps: { repo: 'octo/demo' },
  ...extra,
});

/** The run's AG-UI events from an SSE response body. */
function sse(body: string): AgUiEvent[] {
  return body
    .split('\n\n')
    .map((chunk) => chunk.split('\n').find((l) => l.startsWith('data: ')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(6)) as AgUiEvent);
}

async function post(app: FastifyInstance, payload: unknown, accept = 'text/event-stream') {
  return app.inject({ method: 'POST', url: '/api/agent', payload: payload as object, headers: { accept } });
}

describe('POST /api/agent (AG-UI)', () => {
  it('answers a RunAgentInput with the run as an SSE stream of AG-UI events', async () => {
    const { app } = server([{ toolCalls: [{ id: 'c1', name: 'list_pull_requests', args: {} }] }, { text: 'One open PR.' }]);
    const res = await post(app, input(randomUUID()));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = sse(res.body);
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[1].type).toBe(EventType.STATE_SNAPSHOT);
    expect(events.map((e) => e.type)).toContain(EventType.ACTIVITY_SNAPSHOT);
    expect(events.at(-2)).toMatchObject({ type: 'STATE_DELTA', delta: [{ path: '/followups' }] });
    expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'success' } });
  });

  it('answers SSE to a client that accepts anything', async () => {
    const { app } = server([{ text: 'Hi.' }]);
    const res = await post(app, input(randomUUID()), '*/*');
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(sse(res.body).at(-1)).toMatchObject({ type: 'RUN_FINISHED' });
  });

  it('streams AG-UI protobuf when the client asks for it', async () => {
    const { app } = server([{ text: 'Hi.' }]);
    const res = await post(app, input(randomUUID()), 'application/vnd.ag-ui.event+proto');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.ag-ui.event+proto');
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it('pauses on an interrupt, and the resume run carries out exactly the approved items, once', async () => {
    const { app, action } = server([
      { toolCalls: [{ id: 'c1', name: 'bulk_update_issues', args: { issueNumbers: [118, 131], action: 'close' } }] },
      { text: 'Closed #118.' },
    ]);
    const threadId = randomUUID();
    const first = sse((await post(app, input(threadId, { messages: [{ id: 'u1', role: 'user', content: 'Close them' }] }))).body);
    expect(first.at(-1)).toMatchObject({ outcome: { type: 'interrupt', interrupts: [{ id: 'c1', reason: 'tool_approval', toolCallId: 'c1' }] } });
    expect(first).toContainEqual(expect.objectContaining({ type: 'STATE_DELTA', delta: [expect.objectContaining({ path: '/pendingApproval' })] }));
    expect(action.executed).toEqual([]);

    const answer = input(threadId, { messages: [], resume: [{ interruptId: 'c1', status: 'resolved', payload: { decision: 'approve', selected: [118] } }] });
    const second = sse((await post(app, answer)).body);
    expect(action.executed).toEqual([[118]]);
    expect(second.map((e) => e.type)).toEqual(expect.arrayContaining(['ACTIVITY_DELTA', 'TOOL_CALL_RESULT']));
    expect(second.at(-1)).toMatchObject({ outcome: { type: 'success' } });

    // Answered exactly once.
    expect((await post(app, { ...answer, runId: randomUUID() })).statusCode).toBe(404);
  });

  it('treats a cancelled interrupt as a rejection', async () => {
    const { app, action } = server([{ toolCalls: [{ id: 'c1', name: 'bulk_update_issues', args: { issueNumbers: [118], action: 'close' } }] }, { text: 'OK.' }]);
    const threadId = randomUUID();
    await post(app, input(threadId));
    const res = await post(app, input(threadId, { messages: [], resume: [{ interruptId: 'c1', status: 'cancelled' }] }));
    expect(res.statusCode).toBe(200);
    expect(action.executed).toEqual([]);
  });

  it('refuses bad input, a missing prompt, and someone else\'s conversation', async () => {
    const { app, user } = server([{ text: 'Hi.' }, { text: 'Hi.' }]);
    expect((await post(app, { hello: 'world' })).statusCode).toBe(400);
    expect((await post(app, input('not-a-uuid'))).statusCode).toBe(400);
    expect((await post(app, input(randomUUID(), { messages: [] }))).statusCode).toBe(400);
    expect((await post(app, input(randomUUID(), { forwardedProps: {} }))).statusCode).toBe(400);

    const threadId = randomUUID();
    await post(app, input(threadId));
    user.login = 'mallory';
    expect((await post(app, input(threadId))).statusCode).toBe(404);
  });

  it('serves AG-UI capabilities and the A2UI catalog', async () => {
    const { app } = server([]);
    const caps = (await app.inject({ method: 'GET', url: '/api/agent/capabilities' })).json();
    expect(caps).toMatchObject({ humanInTheLoop: { interrupts: true }, state: { deltas: true }, custom: { a2ui: { version: '1.0' } } });
    const catalog = (await app.inject({ method: 'GET', url: '/api/a2ui/catalog' })).json();
    expect(catalog).toMatchObject({ protocolVersion: '1.0', catalogId: 'repopilot:catalog/v1' });
  });
});
