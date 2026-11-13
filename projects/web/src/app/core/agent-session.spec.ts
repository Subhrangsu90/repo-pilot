import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { SavedSession } from './api';
import { AgentSession, routeFor } from './agent-session';

const SESSION = '44da5e15-42e9-4db4-ad73-2d8ed1b35654';
const table = (numbers: number[]) => ({
  component: 'IssueTable',
  props: { rows: numbers.map((number) => ({ number, title: `Issue ${number}`, state: 'open', labels: [], assignees: [], ageDays: 1 })) },
});

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
        { type: 'RUN_STARTED', threadId: SESSION, runId: 'r1' },
        { type: 'CUSTOM', name: 'ui', value: { surfaceId: 'r1-c1', node: table([2, 3]) } },
        { type: 'RUN_FINISHED', threadId: SESSION, runId: 'r1' },
      ],
    },
  ],
  refreshable: [{ surfaceId: 'r1-c1', capturedAt: '2026-11-11T10:00:00Z' }],
};

describe('AgentSession refresh', () => {
  async function reopen() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const session = TestBed.inject(AgentSession);
    const http = TestBed.inject(HttpTestingController);
    const loaded = session.load(SESSION);
    http.expectOne(`/api/sessions/${SESSION}`).flush(saved);
    expect(await loaded).toBe(true);
    return { session, http };
  }

  it('marks reopened read-tool surfaces as captured, then swaps in fresh data in place', async () => {
    const { session, http } = await reopen();
    expect(session.freshness().get('r1-c1')).toEqual({ at: '2026-11-11T10:00:00Z', refreshed: false, busy: false });

    const done = session.refresh('r1-c1');
    expect(session.freshness().get('r1-c1')?.busy).toBe(true);
    const req = http.expectOne(`/api/sessions/${SESSION}/surfaces/r1-c1/refresh`);
    expect(req.request.method).toBe('POST');
    req.flush({ surfaceId: 'r1-c1', node: table([5, 6, 7]), refreshedAt: '2026-11-12T09:00:00Z' });
    await done;

    expect(session.turns()[0].surfaces).toEqual([{ surfaceId: 'r1-c1', node: table([5, 6, 7]) }]);
    expect(session.freshness().get('r1-c1')).toEqual({ at: '2026-11-12T09:00:00Z', refreshed: true, busy: false });
  });

  it('keeps the captured data and shows why when the refresh fails', async () => {
    const { session, http } = await reopen();
    const done = session.refresh('r1-c1');
    http.expectOne(`/api/sessions/${SESSION}/surfaces/r1-c1/refresh`).flush({ error: 'GitHub did not answer.' }, { status: 502, statusText: 'Bad Gateway' });
    await done;
    expect(session.turns()[0].surfaces[0].node).toEqual(table([2, 3]));
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
