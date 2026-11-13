import type { AgentEvent } from '@repopilot/shared';
import { applyEvent, clearFilter, filterTables, newTurn, replayRuns, Turn, visibleSurfaces } from './agent-run';
import { dayDiff, formatWhen } from './api';

const fold = (events: AgentEvent[]): Turn => events.reduce(applyEvent, newTurn('t1', 'Show my open PRs'));
const prList = (title: string) => ({ component: 'PrList', props: { title, items: [] } });

describe('visibleSurfaces', () => {
  const diff = { component: 'Section', props: { title: 'Changes in #1', children: [{ component: 'DiffViewer', props: { path: 'a.ts', lines: [] } }] } };
  const ui = (surfaceId: string, node: unknown): AgentEvent => ({ type: 'CUSTOM', name: 'ui', value: { surfaceId, node } as never });

  it('keeps the plain diff until the review draft arrives, then drops it', () => {
    const reading = fold([ui('d', diff)]);
    expect(visibleSurfaces(reading).map((s) => s.surfaceId)).toEqual(['d']);

    const reviewed = applyEvent(reading, ui('r', { component: 'PrReview', props: {} }));
    expect(visibleSurfaces(reviewed).map((s) => s.surfaceId)).toEqual(['r']);
  });
});

describe('applyEvent', () => {
  it('keeps at most three follow-up prompts from the server', () => {
    const turn = fold([{ type: 'CUSTOM', name: 'followups', value: { prompts: ['a', 'b', 'c', 'd'] } }]);
    expect(turn.followups).toEqual(['a', 'b', 'c']);
  });

  it('builds a turn from a full run', () => {
    const turn = fold([
      { type: 'RUN_STARTED', threadId: 'th', runId: 'r' },
      { type: 'STEP_STARTED', stepId: 's1', stepName: 'Understanding the request' },
      { type: 'STEP_FINISHED', stepId: 's1', status: 'done', detail: 'gemini-3.6-flash' },
      { type: 'STEP_STARTED', stepId: 's2', stepName: 'Listing pull requests' },
      { type: 'CUSTOM', name: 'ui', value: { surfaceId: 'u1', node: prList('Open PRs') } },
      { type: 'STEP_FINISHED', stepId: 's2', status: 'done', detail: '3 found' },
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Three open PRs.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      { type: 'RUN_FINISHED', threadId: 'th', runId: 'r' },
    ]);

    expect(turn.status).toBe('done');
    expect(turn.steps.map((s) => [s.label, s.status, s.detail])).toEqual([
      ['Understanding the request', 'done', 'gemini-3.6-flash'],
      ['Listing pull requests', 'done', '3 found'],
    ]);
    expect(turn.surfaces).toHaveLength(1);
    expect(turn.text).toBe('Three open PRs.');
  });

  it('replaces a surface that arrives again with the same id', () => {
    const turn = fold([
      { type: 'CUSTOM', name: 'ui', value: { surfaceId: 'u1', node: prList('All') } },
      { type: 'CUSTOM', name: 'ui', value: { surfaceId: 'u1', node: prList('Only bugs') } },
    ]);
    expect(turn.surfaces).toHaveLength(1);
    expect(turn.surfaces[0].node).toEqual(prList('Only bugs'));
  });

  it('separates multiple assistant messages', () => {
    const msg = (id: string, text: string): AgentEvent[] => [
      { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: text },
    ];
    expect(fold([...msg('a', 'First.'), ...msg('b', 'Second.')]).text).toBe('First.\n\nSecond.');
  });

  it('marks running steps as failed on error', () => {
    const turn = fold([
      { type: 'STEP_STARTED', stepId: 's1', stepName: 'Thinking' },
      { type: 'RUN_ERROR', message: 'gemini: HTTP 503' },
    ]);
    expect(turn).toMatchObject({ status: 'error', error: 'gemini: HTTP 503' });
    expect(turn.steps[0].status).toBe('error');
  });

  it('pauses on an approval and continues in the same turn when the resumed run streams in', () => {
    const paused = fold([
      { type: 'RUN_STARTED', threadId: 'th', runId: 'r1' },
      { type: 'CUSTOM', name: 'ui', value: { surfaceId: 'r1-c1', node: { component: 'ApprovalCard', props: { status: 'pending' } } } },
      { type: 'CUSTOM', name: 'approval', value: { runId: 'r1', toolCallId: 'c1', surfaceId: 'r1-c1' } },
      { type: 'RUN_FINISHED', threadId: 'th', runId: 'r1' },
    ]);
    expect(paused.status).toBe('awaiting-approval');
    expect(paused.pending).toEqual({ runId: 'r1', toolCallId: 'c1', surfaceId: 'r1-c1' });
    // Settling the run must not mark the wait as done.
    expect(paused.steps).toEqual([{ id: 'approval-c1', label: 'Waiting for your approval', status: 'pending' }]);

    // The session clears `pending` when it sends the decision; then the resumed run arrives.
    const resumed: AgentEvent[] = [
      { type: 'RUN_STARTED', threadId: 'th', runId: 'r2' },
      { type: 'STEP_FINISHED', stepId: 'approval-c1', status: 'done', detail: 'Approved 5' },
      { type: 'CUSTOM', name: 'ui', value: { surfaceId: 'r1-c1', node: { component: 'ApprovalCard', props: { status: 'approved' } } } },
      { type: 'RUN_FINISHED', threadId: 'th', runId: 'r2' },
    ];
    const done = resumed.reduce(applyEvent, { ...paused, status: 'running', pending: undefined } as Turn);
    expect(done.status).toBe('done');
    expect(done.steps[0]).toMatchObject({ status: 'done', detail: 'Approved 5' });
    expect(done.surfaces).toHaveLength(1);
    expect(done.surfaces[0].node.props).toEqual({ status: 'approved' });
  });

  it('shows a finish event without a start as a notice (model fallback)', () => {
    const turn = fold([{ type: 'STEP_FINISHED', stepId: 'f', status: 'error', detail: 'overloaded; trying fallback' }]);
    expect(turn.steps).toEqual([{ id: 'f', label: 'Notice', status: 'error', detail: 'overloaded; trying fallback' }]);
  });
});

describe('replayRuns (History → Resume)', () => {
  const card = { component: 'ApprovalCard', props: {} };
  const paused = {
    id: 'r1',
    prompt: 'Close all wontfix issues',
    events: [
      { type: 'CUSTOM', name: 'ui', value: { surfaceId: 's1', node: card } },
      { type: 'CUSTOM', name: 'approval', value: { runId: 'r1', toolCallId: 'c1', surfaceId: 's1' } },
      { type: 'RUN_FINISHED', threadId: 't', runId: 'r1' },
    ] as AgentEvent[],
  };

  it('restores a change that is still waiting, so it can be approved after a reload', () => {
    const [turn] = replayRuns([paused]);
    expect(turn).toMatchObject({ prompt: 'Close all wontfix issues', status: 'awaiting-approval', pending: { runId: 'r1', toolCallId: 'c1' } });
  });

  it('continues the same turn with the run that resumed after the approval, and starts a new turn per prompt', () => {
    const resumed = {
      id: 'r2',
      prompt: null,
      events: [
        { type: 'STEP_FINISHED', stepId: 'approval-c1', status: 'done', detail: 'Approved 2' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Closed 2 issues.' },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r2' },
      ] as AgentEvent[],
    };
    const next = { id: 'r3', prompt: 'Show my open PRs', events: [{ type: 'RUN_FINISHED', threadId: 't', runId: 'r3' }] as AgentEvent[] };
    const turns = replayRuns([paused, resumed, next]);
    expect(turns.map((t) => [t.prompt, t.status, t.pending])).toEqual([
      ['Close all wontfix issues', 'done', undefined],
      ['Show my open PRs', 'done', undefined],
    ]);
    expect(turns[0].text).toBe('Closed 2 issues.');
    expect(turns[0].steps.find((s) => s.id === 'approval-c1')?.status).toBe('done');
  });
});

describe('apply_table_filter (filterTables)', () => {
  const row = (number: number, labels: string[], state = 'open', author = 'octocat') => ({ number, title: `#${number}`, state, labels, author, assignees: [], ageDays: 1 });
  const health = {
    component: 'Section',
    props: {
      title: 'Health report',
      children: [
        { component: 'Grid', props: { columns: 4, children: [{ component: 'StatCard', props: { label: 'Open', value: 3 } }] } },
        { component: 'IssueTable', props: { title: 'Oldest open issues', rows: [row(3, ['bug']), row(4, ['enhancement']), row(5, ['Bug', 'good first issue'])] } },
      ],
    },
  };
  const filterEvent = (args: Record<string, unknown>): AgentEvent => ({ type: 'CUSTOM', name: 'client_tool', value: { callId: 'f', name: 'apply_table_filter', args } });
  const rowsOf = (t: Turn[]) => ((t[0].surfaces[0].node.props as typeof health.props).children[1].props as { rows: { number: number }[] }).rows.map((r) => r.number);

  it('filters the table inside the latest surface in place, case-insensitively, and Clear restores it', () => {
    const turns = [fold([{ type: 'CUSTOM', name: 'ui', value: { surfaceId: 'h', node: health } } as AgentEvent])];
    const filtered = filterTables(turns, { target: 'IssueTable', labels: ['bug'] });
    expect(rowsOf(filtered)).toEqual([3, 5]);
    expect(filtered[0].surfaces[0]).toMatchObject({ surfaceId: 'h', filter: 'bug', base: health });
    // The rest of the report is untouched.
    expect((filtered[0].surfaces[0].node.props as typeof health.props).children[0]).toEqual(health.props.children[0]);

    // A new filter starts from the fetched rows, not from the filtered ones.
    expect(rowsOf(filterTables(filtered, { target: 'IssueTable', labels: ['enhancement'] }))).toEqual([4]);
    expect(clearFilter(filtered, 'h')[0].surfaces[0]).toEqual({ surfaceId: 'h', node: health });
    expect(filterTables(filtered, { target: 'IssueTable', clear: true })[0].surfaces[0]).toEqual({ surfaceId: 'h', node: health });
  });

  it('looks back across turns for the table, and leaves everything alone when none is shown', () => {
    const prs = { component: 'PrList', props: { items: [row(15, [], 'open'), row(16, [], 'draft')] } };
    const turns = [fold([{ type: 'CUSTOM', name: 'ui', value: { surfaceId: 'p', node: prs } } as AgentEvent]), newTurn('t2', 'just the drafts')];
    const out = filterTables(turns, { target: 'PrList', state: 'draft' });
    expect((out[0].surfaces[0].node.props as { items: { number: number }[] }).items.map((i) => i.number)).toEqual([16]);
    expect(out[0].surfaces[0].filter).toBe('draft');
    expect(filterTables(turns, { target: 'IssueTable', labels: ['bug'] })).toBe(turns);
  });

  it('replays filters from History, and a resumed run continues the turn that waited even after a side question', () => {
    const turns = replayRuns([
      { id: 'r1', prompt: 'Health report', events: [{ type: 'CUSTOM', name: 'ui', value: { surfaceId: 'h', node: health } }, { type: 'RUN_FINISHED', threadId: 't', runId: 'r1' }] as AgentEvent[] },
      { id: 'r2', prompt: 'Only show bugs', events: [filterEvent({ target: 'IssueTable', labels: ['bug'] }), { type: 'RUN_FINISHED', threadId: 't', runId: 'r2' }] },
      {
        id: 'r3',
        prompt: 'Close #4',
        events: [
          { type: 'CUSTOM', name: 'approval', value: { runId: 'r3', toolCallId: 'c1', surfaceId: 's1' } },
          { type: 'RUN_FINISHED', threadId: 't', runId: 'r3' },
        ] as AgentEvent[],
      },
      { id: 'r4', prompt: 'Where is the bug?', events: [{ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Line 12.' }, { type: 'RUN_FINISHED', threadId: 't', runId: 'r4' }] as AgentEvent[] },
      { id: 'r5', prompt: null, events: [{ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'Closed #4.' }, { type: 'RUN_FINISHED', threadId: 't', runId: 'r5' }] as AgentEvent[] },
    ]);
    expect(rowsOf(turns)).toEqual([3, 5]);
    expect(turns.map((t) => [t.prompt, t.status, t.text])).toEqual([
      ['Health report', 'done', ''],
      ['Only show bugs', 'done', ''],
      ['Close #4', 'done', 'Closed #4.'],
      ['Where is the bug?', 'done', 'Line 12.'],
    ]);
  });
});

describe('formatWhen', () => {
  const now = new Date(2026, 10, 11, 18, 0);
  it('says Today, Yesterday or the date, with the time', () => {
    expect(formatWhen(new Date(2026, 10, 11, 16, 12).toISOString(), now)).toBe('Today, 16:12');
    expect(formatWhen(new Date(2026, 10, 10, 18, 30).toISOString(), now)).toBe('Yesterday, 18:30');
    expect(formatWhen(new Date(2026, 10, 8, 17, 48).toISOString(), now)).toBe('8 Nov, 17:48');
    expect(dayDiff(new Date(2026, 10, 1), now)).toBe(10);
  });
});
