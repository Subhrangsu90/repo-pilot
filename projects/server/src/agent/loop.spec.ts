import type { AgentEvent } from '@repopilot/shared';
import type { ChatMessage, LlmProvider, LlmReply, LlmRequest } from '../llm';
import { LlmError, withFallback } from '../llm';
import { runAgent, type AgentDeps } from './loop';
import { buildToolDefs } from './prompt';
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
  const events: AgentEvent[] = [];
  const thread: ChatMessage[] = [];
  const deps: AgentDeps = {
    provider,
    system: 'test',
    tools: buildToolDefs(),
    executors: { ...executors, list_pull_requests: prs },
    ctx: { github: {} as never, allowlist: ['octo/demo'] },
    emit: (e) => events.push(e),
    runId: 'r1',
    ...overrides,
  };
  return { events, thread, deps, run: (prompt: string) => runAgent(thread, prompt, deps) };
}

const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);

describe('runAgent', () => {
  it('runs a read tool, streams its UI, then the model summary', async () => {
    const model = scripted(
      { toolCalls: [{ id: 'c1', name: 'list_pull_requests', args: { state: 'open' } }] },
      { text: 'One open PR; CI is green.' },
    );
    const { events, run, thread } = setup(model);
    await run('Show my open PRs');

    const ui = ofType(events, 'CUSTOM');
    expect(ui).toHaveLength(1);
    expect(ui[0].value).toMatchObject({ surfaceId: 'r1-c1', node: { component: 'PrList' } });
    expect(ofType(events, 'TEXT_MESSAGE_CONTENT').map((e) => e.delta)).toEqual(['One open PR; CI is green.']);

    const steps = ofType(events, 'STEP_STARTED').map((e) => e.stepName);
    expect(steps).toEqual(['Understanding the request', 'Listing pull requests', 'Reviewing results']);
    expect(ofType(events, 'STEP_FINISHED').every((e) => e.status === 'done')).toBe(true);

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
    expect(ofType(events, 'STEP_FINISHED').some((e) => e.status === 'error')).toBe(true);
  });

  it('refuses tools that are not read-only, in code', async () => {
    const model = scripted({ toolCalls: [{ id: 'c1', name: 'merge_pull_request', args: { number: 15 } }] });
    const { events, run } = setup(model, { executors: { ...executors, merge_pull_request: prs } });
    await run('merge #15');

    expect(ofType(events, 'CUSTOM')).toHaveLength(0);
    const result = model.requests[1].messages.at(-1) as Extract<ChatMessage, { role: 'tool' }>;
    expect(JSON.stringify(result.results[0].content)).toMatch(/Unknown tool|approval/);
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
    expect(ofType(events, 'CUSTOM').map((e) => e.value.surfaceId)).toEqual(['r1-c2']);
  });

  it('never streams UI that fails validation', async () => {
    const bad: Executor<any> = async () => ({ data: {}, ui: { component: 'ScriptInjector', props: {} } });
    const model = scripted({ toolCalls: [{ id: 'c1', name: 'list_pull_requests', args: {} }] });
    const { events, run } = setup(model, { executors: { list_pull_requests: bad } });
    await run('x');
    expect(ofType(events, 'CUSTOM')).toHaveLength(0);
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
    await expect(run('Show my open PRs')).resolves.toBeUndefined();
    expect(ofType(events, 'CUSTOM')).toHaveLength(1);
    expect(ofType(events, 'TEXT_MESSAGE_CONTENT').at(-1)?.delta).toContain('could not write a summary');
    // History stays consistent: the tool results are answered by an assistant turn.
    expect(thread.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('still fails when the model is down before anything was shown', async () => {
    const down: LlmProvider = { name: 'x', model: 'x', generate: async () => { throw new LlmError('HTTP 429 quota', true, 429); } };
    const { run } = setup(down);
    await expect(run('Show my open PRs')).rejects.toThrow('429');
  });

  it('stops after the iteration limit', async () => {
    const loop = { toolCalls: [{ id: 'c', name: 'list_pull_requests', args: {} }] };
    const { events, run } = setup(scripted(loop, loop, loop, loop), { maxIterations: 3 });
    await run('x');
    expect(ofType(events, 'TEXT_MESSAGE_CONTENT').at(-1)?.delta).toContain('stopped after 3 steps');
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
