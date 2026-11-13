import {
  EventType,
  propsUpdate,
  readSurface,
  stepFinished,
  stepStarted,
  surfaceDelta,
  surfaceMessages,
  surfaceSnapshot,
  text as say,
  toNode,
  toolCall,
  REPOPILOT_CATALOG_ID,
  type AgUiEvent,
} from '@repopilot/shared';
import { applyEvent, clearFilter, filterTables, newTurn, replayRuns, surfaceComponent, Turn, visibleSurfaces, type ShownSurface } from './agent-run';
import { dayDiff, formatWhen } from './api';

const fold = (events: AgUiEvent[]): Turn => events.reduce(applyEvent, newTurn('t1', 'Show my open PRs'));
const prList = (title: string) => ({ component: 'PrList', props: { title, items: [] } });
const ui = (surfaceId: string, node: unknown) => surfaceSnapshot(surfaceId, surfaceMessages(surfaceId, node));
const started = (runId: string): AgUiEvent => ({ type: EventType.RUN_STARTED, threadId: 'th', runId });
type Finished = Extract<AgUiEvent, { type: EventType.RUN_FINISHED }>;
const finished = (runId: string, outcome?: Finished['outcome'], usage?: Finished['usage']): AgUiEvent => ({
  type: EventType.RUN_FINISHED,
  threadId: 'th',
  runId,
  ...(outcome ? { outcome } : {}),
  ...(usage ? { usage } : {}),
});
const interrupt = (id: string, surfaceId: string): Finished['outcome'] => ({
  type: 'interrupt',
  interrupts: [{ id, reason: 'tool_approval', toolCallId: id, message: 'Close 5 issues', metadata: { repopilot: { surfaceId } } }],
});
/** An assistant message, as the server streams it. */
const text = (id: string, body: string): AgUiEvent[] => {
  const out: AgUiEvent[] = [];
  say((e) => out.push(e), id, body);
  return out;
};
/** The props of a surface's top component, as A2UI would render them. */
const rootProps = (s: ShownSurface) => toNode(readSurface(s.operations))!.props as Record<string, unknown>;

describe('visibleSurfaces', () => {
  const diff = { component: 'Section', props: { title: 'Changes in #1', children: [{ component: 'DiffViewer', props: { path: 'a.ts', lines: [] } }] } };

  // Only the surface's structure matters here, so the review is a bare A2UI component list.
  const review: ShownSurface = {
    surfaceId: 'r',
    operations: [
      { version: '1.0', createSurface: { surfaceId: 'r', catalogId: REPOPILOT_CATALOG_ID } },
      { version: '1.0', updateComponents: { surfaceId: 'r', components: [{ id: 'root', component: 'PrReview' }] } },
    ],
  };

  it('keeps the plain diff until the review draft arrives, then drops it', () => {
    const reading = fold([ui('d', diff)]);
    expect(visibleSurfaces(reading).map((s) => s.surfaceId)).toEqual(['d']);
    const reviewed: Turn = { ...reading, surfaces: [...reading.surfaces, review] };
    expect(visibleSurfaces(reviewed).map((s) => s.surfaceId)).toEqual(['r']);
    expect(surfaceComponent(review)).toBe('PrReview');
  });
});

describe('applyEvent', () => {
  it('keeps at most three follow-up prompts from the shared state', () => {
    const turn = fold([{ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/followups', value: ['a', 'b', 'c', 'd'] }] }]);
    expect(turn.followups).toEqual(['a', 'b', 'c']);
  });

  it('builds a turn from a full AG-UI run', () => {
    const turn = fold([
      started('r'),
      { type: EventType.STATE_SNAPSHOT, snapshot: { repo: 'octo/demo', followups: [] } },
      stepStarted('s1', 'Understanding the request'),
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'x', delta: 'The user wants PRs.' },
      stepFinished('s1', 'done', 'gemini-3.6-flash'),
      stepStarted('s2', 'Listing pull requests'),
      ui('u1', prList('Open PRs')),
      stepFinished('s2', 'done', '3 found'),
      ...text('m1', 'Three open PRs.'),
      finished('r', { type: 'success' }, [{ provider: 'gemini', model: 'flash', inputTokens: 900, outputTokens: 100 }]),
    ]);

    expect(turn.status).toBe('done');
    expect(turn.steps.map((s) => [s.label, s.status, s.detail])).toEqual([
      ['Understanding the request', 'done', 'gemini-3.6-flash'],
      ['Listing pull requests', 'done', '3 found'],
    ]);
    expect(turn.surfaces.map(surfaceComponent)).toEqual(['PrList']);
    expect(turn.text).toBe('Three open PRs.');
    expect(turn.reasoning).toBe('The user wants PRs.');
    expect(turn.tokens).toBe(1000);
  });

  it('replaces a surface whose snapshot arrives again, and appends data updates from deltas', () => {
    let turn = fold([ui('u1', prList('All')), ui('u1', prList('Only bugs'))]);
    expect(turn.surfaces).toHaveLength(1);
    expect(rootProps(turn.surfaces[0])['title']).toBe('Only bugs');
    turn = applyEvent(turn, surfaceDelta('u1', [propsUpdate('u1', 'root', { title: 'Renamed', items: [] })]));
    expect(rootProps(turn.surfaces[0])['title']).toBe('Renamed');
  });

  it('separates multiple assistant messages', () => {
    expect(fold([...text('a', 'First.'), ...text('b', 'Second.')]).text).toBe('First.\n\nSecond.');
  });

  it('marks running steps as failed on error', () => {
    const turn = fold([stepStarted('s1', 'Thinking'), { type: EventType.RUN_ERROR, message: 'gemini: HTTP 503' }]);
    expect(turn).toMatchObject({ status: 'error', error: 'gemini: HTTP 503' });
    expect(turn.steps[0].status).toBe('error');
  });

  it('shows a stopped run as stopped, not as an error', () => {
    const turn = fold([stepStarted('s1', 'Thinking'), finished('r', { type: 'cancelled' })]);
    expect(turn).toMatchObject({ status: 'done', stopped: true });
  });

  it('pauses on an AG-UI interrupt and continues in the same turn when the resumed run streams in', () => {
    const card = { component: 'ApprovalCard', props: { toolCallId: 'c1', tool: 'bulk_update_issues', risk: 'destructive', verb: 'close', noun: 'issue', summary: '', reversible: true } };
    const paused = fold([started('r1'), ui('r1-c1', card), finished('r1', interrupt('c1', 'r1-c1'))]);
    expect(paused.status).toBe('awaiting-approval');
    expect(paused.pending).toEqual({ interruptId: 'c1', toolCallId: 'c1', surfaceId: 'r1-c1', message: 'Close 5 issues' });
    expect(paused.steps).toEqual([{ id: 'approval-c1', label: 'Waiting for your approval', status: 'pending' }]);

    // The session clears `pending` when it sends the resume entry; then the resumed run arrives.
    const resumed: AgUiEvent[] = [
      started('r2'),
      stepStarted('approval-c1', 'Waiting for your approval'),
      stepFinished('approval-c1', 'done', 'Approved 5'),
      surfaceDelta('r1-c1', [propsUpdate('r1-c1', 'root', { ...card.props, status: 'approved' })]),
      finished('r2', { type: 'success' }),
    ];
    const done = resumed.reduce(applyEvent, { ...paused, status: 'running', pending: undefined } as Turn);
    expect(done.status).toBe('done');
    expect(done.steps).toEqual([{ id: 'approval-c1', label: 'Waiting for your approval', status: 'done', detail: 'Approved 5' }]);
    expect(done.surfaces).toHaveLength(1);
    expect(rootProps(done.surfaces[0])['status']).toBe('approved');
  });
});

describe('replayRuns (History → Resume)', () => {
  const card = { component: 'ApprovalCard', props: { toolCallId: 'c1', tool: 't', risk: 'write', verb: 'close', noun: 'issue', summary: '', reversible: true } };
  const paused = { id: 'r1', prompt: 'Close all wontfix issues', events: [ui('s1', card), finished('r1', interrupt('c1', 's1'))] };

  it('restores a change that is still waiting, so it can be approved after a reload', () => {
    const [turn] = replayRuns([paused]);
    expect(turn).toMatchObject({ prompt: 'Close all wontfix issues', status: 'awaiting-approval', pending: { interruptId: 'c1', surfaceId: 's1' } });
  });

  it('continues the same turn with the run that resumed after the approval, and starts a new turn per prompt', () => {
    const resumed = {
      id: 'r2',
      prompt: null,
      events: [stepStarted('approval-c1', 'Waiting for your approval'), stepFinished('approval-c1', 'done', 'Approved 2'), ...text('m', 'Closed 2 issues.'), finished('r2')],
    };
    const next = { id: 'r3', prompt: 'Show my open PRs', events: [finished('r3')] };
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
  const filterCall = (args: Record<string, unknown>): AgUiEvent[] => {
    const out: AgUiEvent[] = [];
    toolCall((e) => out.push(e), 'f', 'apply_table_filter', args);
    return out;
  };
  /** Rows of the report's table, as A2UI renders them (the data model after every update). */
  const rowsOf = (t: Turn[]) => (readSurface(t[0].surfaces[0].operations).data['root_1'] as { rows: { number: number }[] }).rows.map((r) => r.number);

  it('filters the table inside the latest surface with an A2UI data update, case-insensitively, and Clear restores it', () => {
    const turns = [fold([ui('h', health)])];
    const sent = turns[0].surfaces[0].operations;
    const filtered = filterTables(turns, { target: 'IssueTable', labels: ['bug'] });
    expect(rowsOf(filtered)).toEqual([3, 5]);
    expect(filtered[0].surfaces[0]).toMatchObject({ surfaceId: 'h', filter: 'bug', base: sent });
    // One updateDataModel on the table's rows; the rest of the report is untouched.
    expect(filtered[0].surfaces[0].operations.slice(sent.length)).toEqual([{ version: '1.0', updateDataModel: { surfaceId: 'h', path: '/root_1/rows', value: expect.any(Array) } }]);

    // A new filter starts from the fetched rows, not from the filtered ones.
    expect(rowsOf(filterTables(filtered, { target: 'IssueTable', labels: ['enhancement'] }))).toEqual([4]);
    expect(clearFilter(filtered, 'h')[0].surfaces[0]).toEqual({ surfaceId: 'h', operations: sent });
    expect(filterTables(filtered, { target: 'IssueTable', clear: true })[0].surfaces[0]).toEqual({ surfaceId: 'h', operations: sent });
  });

  it('looks back across turns for the table, and leaves everything alone when none is shown', () => {
    const prs = { component: 'PrList', props: { items: [{ number: 15, title: 'a', state: 'open', ageDays: 1 }, { number: 16, title: 'b', state: 'draft', ageDays: 1 }] } };
    const turns = [fold([ui('p', prs)]), newTurn('t2', 'just the drafts')];
    const out = filterTables(turns, { target: 'PrList', state: 'draft' });
    expect((readSurface(out[0].surfaces[0].operations).data['root'] as { items: { number: number }[] }).items.map((i) => i.number)).toEqual([16]);
    expect(out[0].surfaces[0].filter).toBe('draft');
    expect(filterTables(turns, { target: 'IssueTable', labels: ['bug'] })).toBe(turns);
  });

  it('replays filters from History, and a resumed run continues the turn that waited even after a side question', () => {
    const turns = replayRuns([
      { id: 'r1', prompt: 'Health report', events: [ui('h', health), finished('r1')] },
      { id: 'r2', prompt: 'Only show bugs', events: [...filterCall({ target: 'IssueTable', labels: ['bug'] }), finished('r2')] },
      { id: 'r3', prompt: 'Close #4', events: [finished('r3', interrupt('c1', 's1'))] },
      { id: 'r4', prompt: 'Where is the bug?', events: [...text('m', 'Line 12.'), finished('r4')] },
      { id: 'r5', prompt: null, events: [...text('m2', 'Closed #4.'), finished('r5')] },
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
