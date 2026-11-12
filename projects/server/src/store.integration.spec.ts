import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@repopilot/shared';
import type { ExecutedChange, PendingApproval } from './agent/loop';
import type { Thread } from './agent/runs';
import { openDb } from './db/client';
import { auditEntries, runs, sessions } from './db/schema';
import { auditId, componentsIn, lastText, Store, titleFrom } from './store';

/**
 * Runs against a real Postgres when TEST_DATABASE_URL is set, e.g.
 *   docker exec repopilot-db createdb -U repopilot repopilot_test
 *   TEST_DATABASE_URL=postgres://repopilot:repopilot@127.0.0.1:5433/repopilot_test npx vitest run src/store.integration.spec.ts
 * Never point it at the dev database: it empties the tables.
 */
const url = process.env['TEST_DATABASE_URL'];
const maybe = url ? describe : describe.skip;

const ui = (component: string): AgentEvent => ({ type: 'CUSTOM', name: 'ui', value: { surfaceId: randomUUID(), node: { component, props: {} } } });
const text = (delta: string): AgentEvent[] => [
  { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta },
];

maybe('Store (Postgres)', () => {
  let store: Store;
  let close: () => Promise<void>;
  const errors: string[] = [];

  beforeAll(async () => {
    const opened = await openDb(url!);
    close = opened.close;
    await opened.db.delete(auditEntries);
    await opened.db.delete(runs);
    await opened.db.delete(sessions);
    store = new Store(opened.db, { repo: 'octo/demo' }, (m) => errors.push(m));
  });
  afterAll(() => close?.());

  const ME = 'octocat';
  const thread = (over: Partial<Thread> = {}): Thread => ({ id: randomUUID(), messages: [{ role: 'user', text: 'hi' }], busy: false, touched: 0, owner: ME, ...over });

  it('saves a session with its runs and lists it with prompt, last answer and components', async () => {
    const t = thread();
    await store.saveRun({ id: randomUUID(), prompt: 'show my open PRs', events: [ui('PrList'), ...text('3 open PRs.')] }, t);
    await store.saveRun({ id: randomUUID(), prompt: 'health report', events: [ui('Section'), ...text('Looks healthy.')] }, t);

    const [item] = await store.listSessions({ userId: ME, filter: 'all', q: 'open prs' });
    expect(item).toMatchObject({ id: t.id, title: 'Show my open PRs', status: 'done', repo: 'octo/demo', madeChanges: false });
    expect(item.prompt).toBe('show my open PRs');
    expect(item.lastResult).toBe('Looks healthy.');
    expect(item.components).toEqual(['PrList', 'Section']);

    const full = await store.getSession(t.id, ME);
    expect(full?.runs.map((r) => r.prompt)).toEqual(['show my open PRs', 'health report']);
    expect(errors).toEqual([]);
  });

  it('keeps a pending approval, finds it by run, and restores the thread', async () => {
    const runId = randomUUID();
    const pending = { runId, callId: 'c1', tool: 'bulk_update_issues', ids: [9] } as unknown as PendingApproval;
    const t = thread({ pending, model: 'cloud' });
    await store.saveRun({ id: runId, prompt: 'close wontfix', events: [ui('ApprovalCard')] }, t);

    expect(await store.findSessionPendingOnRun(runId)).toBe(t.id);
    expect(await store.loadThread(t.id)).toMatchObject({ id: t.id, model: 'cloud', owner: ME, pending: { runId, callId: 'c1' } });
    expect((await store.listSessions({ userId: ME, filter: 'waiting' })).map((s) => s.id)).toEqual([t.id]);
  });

  it('records audit entries, filters them, and marks an undo only once', async () => {
    const t = thread();
    const change: ExecutedChange = {
      runId: randomUUID(),
      tool: 'bulk_update_issues',
      risk: 'destructive',
      summary: 'Close 2 issues',
      prompt: 'close wontfix',
      input: { issueNumbers: [9, 10, 11], action: 'close' },
      approvedIds: [9, 10],
      keptByUser: [11],
      ok: true,
      result: 'Closed 2 issues.',
      response: { changed: [9, 10] },
      inverse: { kind: 'issues', label: 'Reopen #9, #10', input: { issueNumbers: [9, 10], action: 'reopen', reason: 'not_planned' } },
    };
    // Recorded before the run is saved: the session row is created as a stub.
    const id = await store.recordAudit(t.id, { ...change, approver: ME });
    expect(id).toMatch(/^aud_\d{4}$/);

    const [entry] = await store.listAudit('destructive', ME);
    expect(entry).toMatchObject({ id, summary: 'Close 2 issues', approvedBy: 'octocat', keptByUser: [11], undoable: true, inverse: { label: 'Reopen #9, #10' } });
    expect(await store.listAudit('write', ME)).toEqual([]);
    expect((await store.listSessions({ userId: ME, filter: 'changes' })).map((s) => s.id)).toContain(t.id);

    const seq = Number(id!.slice(4));
    expect(await store.getInverse(seq)).toMatchObject({ kind: 'issues' });
    expect(await store.markUndone(seq, 'Reopened 2 issues.')).toBe(true);
    expect(await store.markUndone(seq, 'again')).toBe(false);
    expect(await store.getAudit(seq, ME)).toMatchObject({ undoable: false, undoResult: 'Reopened 2 issues.' });
    expect((await store.listAudit('undone', ME)).map((e) => e.id)).toEqual([id]);

    // Deleting the session keeps its audit entry.
    expect(await store.deleteSession(t.id, ME)).toBe(true);
    expect(await store.getAudit(seq, ME)).toMatchObject({ id, sessionId: null });
  });

  it('renames and reports missing sessions', async () => {
    const t = thread();
    await store.saveRun({ id: randomUUID(), prompt: 'x', events: [] }, t);
    expect(await store.renameSession(t.id, 'PR #15 review', ME)).toBe(true);
    expect((await store.getSession(t.id, ME))?.title).toBe('PR #15 review');
    expect(await store.renameSession(randomUUID(), 'nope', ME)).toBe(false);
  });

  it('keeps each user to their own sessions and audit entries', async () => {
    const t = thread({ owner: 'someone-else' });
    await store.saveRun({ id: randomUUID(), prompt: 'their question', events: [] }, t);
    const id = await store.recordAudit(t.id, { runId: randomUUID(), tool: 'bulk_update_issues', risk: 'destructive', summary: 'Close 1 issue', input: {}, approvedIds: [9], keptByUser: [], ok: true, result: 'Closed 1 issue.', inverse: null, approver: 'someone-else' });
    const seq = Number(id!.slice(4));

    expect((await store.listSessions({ userId: ME, filter: 'all' })).map((s) => s.id)).not.toContain(t.id);
    expect(await store.getSession(t.id, ME)).toBeNull();
    expect(await store.renameSession(t.id, 'mine now', ME)).toBe(false);
    expect(await store.deleteSession(t.id, ME)).toBe(false);
    expect(await store.getAudit(seq, ME)).toBeNull();
    expect((await store.listAudit('all', ME)).map((e) => e.id)).not.toContain(id);

    expect(await store.getSession(t.id, 'someone-else')).not.toBeNull();
    expect(await store.getAudit(seq, 'someone-else')).toMatchObject({ approvedBy: 'someone-else' });
  });
});

describe('store helpers', () => {
  it('titles, audit ids, components and last text', () => {
    expect(titleFrom('  close all wontfix issues\nplease')).toBe('Close all wontfix issues');
    expect(titleFrom('x'.repeat(100))).toHaveLength(78);
    expect(auditId(7)).toBe('aud_0007');
    expect(componentsIn([ui('PrList'), ui('PrList'), ui('Grid')])).toEqual(['PrList', 'Grid']);
    expect(lastText([...text('first'), ...text('second')])).toBe('second');
  });
});
