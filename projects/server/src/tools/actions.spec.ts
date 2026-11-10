import { validateNode } from '@repopilot/shared';
import { GitHubError } from '../github/client';
import { bulkUpdateIssuesTool, type CardDraft } from './actions';
import type { ToolContext } from './read-tools';

const old = new Date(Date.now() - 120 * 86_400_000).toISOString();

const ISSUES: Record<number, object> = {
  118: { number: 118, title: 'Support IE11', state: 'open', created_at: old, labels: [{ name: 'wontfix' }] },
  124: { number: 124, title: 'Rewrite in Bazel', state: 'open', created_at: old, labels: [] },
  131: { number: 131, title: 'Already handled', state: 'closed', created_at: old, labels: [{ name: 'wontfix' }] },
  140: { number: 140, title: 'A pull request', state: 'open', created_at: old, labels: [], pull_request: {} },
};

/** Fake GitHub: GETs read ISSUES, PATCHes are recorded; issue 124 refuses writes. */
function fakeCtx() {
  const patches: { path: string; body: unknown }[] = [];
  const github = {
    async rest(path: string, init: { method?: string; body?: unknown } = {}) {
      const n = Number(path.split('/').at(-1));
      if (init.method === 'PATCH') {
        if (n === 124) throw new GitHubError('GitHub PATCH: HTTP 403 Resource not accessible', 403);
        patches.push({ path, body: init.body });
        return {};
      }
      if (!ISSUES[n]) throw new GitHubError('GitHub GET: HTTP 404 Not Found', 404);
      return ISSUES[n];
    },
  };
  const ctx = { github, allowlist: ['octo/demo'] } as unknown as ToolContext;
  return { ctx, patches };
}

const input = (issueNumbers: number[], action: 'close' | 'reopen' = 'close') =>
  ({ issueNumbers, action, reason: 'not_planned' }) as const;

describe('bulk_update_issues', () => {
  it('dry run lists what would change and why the rest is skipped, without writing', async () => {
    const { ctx, patches } = fakeCtx();
    const plan = await bulkUpdateIssuesTool.plan(input([118, 124, 131, 140, 999, 118]), ctx);

    expect(patches).toEqual([]);
    if (plan.kind !== 'card' || (plan.component ?? 'ApprovalCard') !== 'ApprovalCard') throw new Error('expected an ApprovalCard');
    const card = plan.card as CardDraft;
    expect(plan.ids).toEqual([118, 124]);
    expect(card.items[0]).toEqual({ id: 118, title: 'Support IE11', meta: 'wontfix · 120 days' });
    expect(card.skipped).toEqual([
      { id: 131, reason: 'already closed' },
      { id: 140, reason: 'is a pull request' },
      { id: 999, reason: 'not found' },
    ]);
    // The card the loop builds from this plan passes the catalog schema.
    const node = { component: 'ApprovalCard', props: { ...plan.card, toolCallId: 'c1', tool: 'bulk_update_issues', risk: 'destructive' } };
    expect(validateNode(node).ok).toBe(true);
  });

  it('reports nothing to change instead of a card', async () => {
    const { ctx } = fakeCtx();
    const plan = await bulkUpdateIssuesTool.plan(input([131]), ctx);
    expect(plan).toMatchObject({ kind: 'empty', data: { nothingToChange: true } });
  });

  it('refuses repositories outside the allowlist', async () => {
    const { ctx } = fakeCtx();
    await expect(bulkUpdateIssuesTool.plan({ ...input([118]), repo: 'evil/repo' }, ctx)).rejects.toThrow('not allowed');
  });

  it('closes exactly the given ids as not planned and reports partial failure', async () => {
    const { ctx, patches } = fakeCtx();
    const out = await bulkUpdateIssuesTool.execute(input([118, 124]), [118, 124], ctx, {});

    expect(patches).toEqual([{ path: '/repos/octo/demo/issues/118', body: { state: 'closed', state_reason: 'not_planned' } }]);
    expect(out.ok).toBe(false);
    expect(out.data).toMatchObject({ changed: [118], failed: [{ number: 124, error: 'HTTP 403' }] });
    expect(out.result).toBe('Closed 1 of 2 issues. Failed: #124 (HTTP 403).');
  });

  it('reopens', async () => {
    const { ctx, patches } = fakeCtx();
    const out = await bulkUpdateIssuesTool.execute(input([131], 'reopen'), [131], ctx, {});
    expect(patches[0].body).toEqual({ state: 'open' });
    expect(out).toMatchObject({ ok: true, result: 'Reopened 1 issue.' });
  });
});
