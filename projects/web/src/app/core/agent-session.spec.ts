import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { HttpAgent, type RunAgentInput } from '@ag-ui/client';
import {
  EventType,
  propsUpdate,
  readSurface,
  stepFinished,
  stepStarted,
  surfaceDelta,
  surfaceMessages,
  surfaceSnapshot,
  text,
  toolCall,
  type AgUiEvent,
  type A2uiMessage,
} from '@repopilot/shared';
import type { SavedSession } from './api';
import { AGENT_FACTORY, AgentSession, routeFor } from './agent-session';
import { Auth } from './auth';
import { RepoChoice } from './repo';

const SESSION = '44da5e15-42e9-4db4-ad73-2d8ed1b35654';
const table = (numbers: number[]) => ({
  component: 'IssueTable',
  props: { rows: numbers.map((number) => ({ number, title: `Issue ${number}`, state: 'open', labels: [], assignees: [], ageDays: 1 })) },
});
const rowsOf = (ops: A2uiMessage[]) => (readSurface(ops).data['root'] as { rows: { number: number }[] }).rows.map((r) => r.number);

const saved: SavedSession = {
  id: SESSION,
  title: 'Show the open issues',
  status: 'done',
  repo: 'octo/demo',
  createdAt: '2026-11-11T10:00:00Z',
  updatedAt: '2026-11-11T10:00:05Z',
  runs: [
    {
      id: 'r1',
      prompt: 'Show the open issues',
      status: 'done',
      createdAt: '2026-11-11T10:00:00Z',
      events: [
        { type: EventType.RUN_STARTED, threadId: SESSION, runId: 'r1' },
        surfaceSnapshot('r1-c1', surfaceMessages('r1-c1', table([2, 3]))),
        { type: EventType.RUN_FINISHED, threadId: SESSION, runId: 'r1' },
      ],
    },
  ],
  refreshable: [{ surfaceId: 'r1-c1', capturedAt: '2026-11-11T10:00:00Z' }],
};

describe('AgentSession refresh', () => {
  async function reopen() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    const session = TestBed.inject(AgentSession);
    const http = TestBed.inject(HttpTestingController);
    const loaded = session.load(SESSION);
    http.expectOne(`/api/sessions/${SESSION}`).flush(saved);
    expect(await loaded).toBe(true);
    return { session, http };
  }

  it('marks reopened read-tool surfaces as captured, then swaps in the fresh A2UI surface in place', async () => {
    const { session, http } = await reopen();
    expect(session.freshness().get('r1-c1')).toEqual({ at: '2026-11-11T10:00:00Z', refreshed: false, busy: false });

    const done = session.refresh('r1-c1');
    expect(session.freshness().get('r1-c1')?.busy).toBe(true);
    const req = http.expectOne(`/api/sessions/${SESSION}/surfaces/r1-c1/refresh`);
    expect(req.request.method).toBe('POST');
    const fresh = surfaceMessages('r1-c1', table([5, 6, 7]));
    req.flush({ surfaceId: 'r1-c1', operations: fresh, refreshedAt: '2026-11-12T09:00:00Z' });
    await done;

    expect(session.turns()[0].surfaces).toEqual([{ surfaceId: 'r1-c1', operations: fresh }]);
    expect(session.freshness().get('r1-c1')).toEqual({ at: '2026-11-12T09:00:00Z', refreshed: true, busy: false });
  });

  it('keeps the captured data and shows why when the refresh fails', async () => {
    const { session, http } = await reopen();
    const done = session.refresh('r1-c1');
    http.expectOne(`/api/sessions/${SESSION}/surfaces/r1-c1/refresh`).flush({ error: 'GitHub did not answer.' }, { status: 502, statusText: 'Bad Gateway' });
    await done;
    expect(rowsOf(session.turns()[0].surfaces[0].operations)).toEqual([2, 3]);
    expect(session.freshness().get('r1-c1')).toMatchObject({ refreshed: false, busy: false, error: expect.any(String) });
  });

  it('has nothing to refresh for surfaces the server did not offer, or after a new chat', async () => {
    const { session, http } = await reopen();
    await session.refresh('r1-unknown');
    http.expectNone((r) => r.url.includes('/refresh'));
    session.reset();
    expect(session.freshness().size).toBe(0);
  });
});

/**
 * The AG-UI transport, end to end in the browser: the real `HttpAgent` from
 * `@ag-ui/client` (which validates and orders every event) talks to a fake
 * server that answers with streams built by the server's own event builders.
 */
describe('AgentSession over AG-UI', () => {
  type Reply = { status?: number; body?: unknown; events?: (input: RunAgentInput) => AgUiEvent[] };

  function setup(replies: Reply[]) {
    const inputs: RunAgentInput[] = [];
    const fetch = async (_url: string, init: RequestInit) => {
      const input = JSON.parse(String(init.body)) as RunAgentInput;
      inputs.push(input);
      const reply = replies.shift() ?? { events: () => [] };
      if (reply.status && reply.status >= 400) {
        return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { 'content-type': 'application/json' } });
      }
      const events = [
        { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
        ...(reply.events?.(input) ?? []),
      ] as AgUiEvent[];
      const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AGENT_FACTORY, useValue: (threadId: string) => new HttpAgent({ url: '/api/agent', threadId, fetch }) },
      ],
    });
    TestBed.inject(RepoChoice).select('octo/demo');
    return { session: TestBed.inject(AgentSession), inputs };
  }

  const end = (input: RunAgentInput, outcome?: object): AgUiEvent =>
    ({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, ...(outcome ? { outcome } : {}) }) as AgUiEvent;
  const say = (id: string, body: string) => {
    const out: AgUiEvent[] = [];
    text((e) => out.push(e), id, body);
    return out;
  };
  const card = { component: 'ApprovalCard', props: { toolCallId: 'c1', tool: 'bulk_update_issues', risk: 'destructive', verb: 'close', noun: 'issue', summary: '', items: [{ id: 9, title: 'IE11' }], reversible: true } };

  it('sends a RunAgentInput with only the new message, the app\'s frontend tools, page context and forwarded props', async () => {
    const { session, inputs } = setup([
      { events: (i) => [stepStarted('s1', 'Listing pull requests'), surfaceSnapshot('u1', surfaceMessages('u1', table([1]))), stepFinished('s1', 'done'), ...say('m', 'One issue.'), end(i, { type: 'success' })] },
      { events: (i) => [...say('m2', 'Still one.'), end(i)] },
    ]);
    await session.send('Show the open issues');
    await session.send('And now?');

    const [first, second] = inputs;
    expect(first.messages).toEqual([{ id: expect.any(String), role: 'user', content: 'Show the open issues' }]);
    expect(second.messages.map((m) => (m as { content: string }).content)).toEqual(['And now?']);
    expect(second.threadId).toBe(first.threadId);
    expect(first.tools.map((t) => t.name)).toEqual(['navigate_to', 'highlight_lines', 'apply_table_filter']);
    expect(first.context).toEqual([{ description: 'Current page', value: '/' }]);
    expect(first.forwardedProps).toEqual({ repo: 'octo/demo' });

    const [turn] = session.turns();
    expect(turn).toMatchObject({ status: 'done', text: 'One issue.' });
    expect(rowsOf(turn.surfaces[0].operations)).toEqual([1]);
  });

  it('pauses on an interrupt and answers it with an AG-UI resume entry carrying the A2UI action', async () => {
    const { session, inputs } = setup([
      {
        events: (i) => [
          surfaceSnapshot('r1-c1', surfaceMessages('r1-c1', card)),
          end(i, { type: 'interrupt', interrupts: [{ id: 'c1', reason: 'tool_approval', toolCallId: 'c1', metadata: { repopilot: { surfaceId: 'r1-c1' } } }] }),
        ],
      },
      {
        events: (i) => [
          stepStarted('approval-c1', 'Waiting for your approval'),
          stepFinished('approval-c1', 'done', 'Approved 1'),
          surfaceDelta('r1-c1', [propsUpdate('r1-c1', 'root', { ...card.props, status: 'approved' })]),
          ...say('m', 'Closed #9.'),
          end(i),
        ],
      },
    ]);
    await session.send('Close #9');
    expect(session.awaitingApproval()).toBe(true);
    expect(session.turns()[0].pending).toMatchObject({ interruptId: 'c1', surfaceId: 'r1-c1' });

    const action = { name: 'approve', surfaceId: 'r1-c1', sourceComponentId: 'root', timestamp: '2026-11-13T10:00:00Z', context: {} };
    session.handleUiEvent({ component: 'ApprovalCard', name: 'approve', payload: { toolCallId: 'c1', selected: [9] }, action });
    await vi.waitFor(() => expect(session.turns()[0].status).toBe('done'));

    expect(inputs[1].resume).toEqual([{ interruptId: 'c1', status: 'resolved', payload: { decision: 'approve', selected: [9] } }]);
    expect(inputs[1].messages).toEqual([]);
    expect(inputs[1].forwardedProps).toMatchObject({ a2uiAction: { userAction: action } });
    const turn = session.turns()[0];
    expect(turn.text).toBe('Closed #9.');
    expect((readSurface(turn.surfaces[0].operations).data['root'] as { status: string }).status).toBe('approved');
  });

  it('keeps the card usable and shows the server\'s reason when the answer is refused', async () => {
    const { session } = setup([
      { events: (i) => [surfaceSnapshot('s', surfaceMessages('s', card)), end(i, { type: 'interrupt', interrupts: [{ id: 'c1', reason: 'tool_approval', toolCallId: 'c1', metadata: { repopilot: { surfaceId: 's' } } }] })] },
      { status: 400, body: { error: 'Select at least one item to approve.' } },
    ]);
    await session.send('Close #9');
    expect(await session.decide('c1', 'approve', [])).toBe(false);
    expect(session.turns()[0]).toMatchObject({ status: 'awaiting-approval', actionError: 'Select at least one item to approve.', pending: { interruptId: 'c1' } });
  });

  it('applies validated frontend tool calls on screen and ignores invalid ones', async () => {
    const { session } = setup([
      {
        events: (i) => {
          const out: AgUiEvent[] = [surfaceSnapshot('h', surfaceMessages('h', table([3, 4])))];
          toolCall((e) => out.push(e), 'f1', 'apply_table_filter', { target: 'IssueTable', state: 'closed' });
          toolCall((e) => out.push(e), 'n1', 'navigate_to', { page: 'pull_request' });
          toolCall((e) => out.push(e), 'n2', 'navigate_to', { page: 'audit' });
          return [...out, end(i)];
        },
      },
    ]);
    const router = TestBed.inject(Router);
    const navigated: string[] = [];
    vi.spyOn(router, 'navigateByUrl').mockImplementation(async (url) => (navigated.push(String(url)), true));
    await session.send('Show closed ones, then open the audit log');

    expect(session.turns()[0].surfaces[0].filter).toBe('closed');
    expect(rowsOf(session.turns()[0].surfaces[0].operations)).toEqual([]);
    expect(navigated).toEqual(['/audit']);
  });

  it('shows the server\'s message when a run is refused, and sends a 401 to sign-in', async () => {
    const { session } = setup([{ status: 409, body: { error: 'This conversation is still running.' } }, { status: 401, body: { error: 'Sign in first.' } }]);
    await session.send('hi');
    expect(session.turns()[0]).toMatchObject({ status: 'error', error: 'This conversation is still running.' });

    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    await session.send('again');
    expect(TestBed.inject(Auth).expired()).toBe(true);
    expect(navigate).toHaveBeenCalledWith(['/signin'], expect.objectContaining({ queryParams: expect.objectContaining({ error: 'expired' }) }));
  });
});

describe('routeFor (navigate_to)', () => {
  it('maps pages to app routes and refuses anything else', () => {
    expect(routeFor({ page: 'audit' })).toBe('/audit');
    expect(routeFor({ page: 'pull_requests' })).toBe('/pulls');
    expect(routeFor({ page: 'pull_request', number: 15 })).toBe('/pulls/15');
    expect(routeFor({ page: 'pull_request' })).toBeNull();
    expect(routeFor({ page: 'https://evil.example' })).toBeNull();
    expect(routeFor({})).toBeNull();
  });
});
