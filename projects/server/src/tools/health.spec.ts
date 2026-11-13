import { validateNode } from '@repopilot/shared';
import { runGetRepoHealth, type ToolContext } from './read-tools';

const DAY = 86_400_000;
const commit = (daysAgo: number, login = 'octocat') => ({ committedDate: new Date(Date.now() - daysAgo * DAY).toISOString(), author: { user: { login } } });

/** A repo with `total` commits in the period, served 100 per page like GitHub. */
function fakeCtx(total: number) {
  const all = Array.from({ length: total }, (_, i) => commit(i % 70, i % 3 ? 'octocat' : 'hubot'));
  const page = (from: number) => ({
    pageInfo: { hasNextPage: from + 100 < total, endCursor: from + 100 < total ? String(from + 100) : null },
    nodes: all.slice(from, from + 100),
  });
  const queries: string[] = [];
  const github = {
    async graphql(query: string, vars: { after?: string }) {
      queries.push(vars.after ?? 'first');
      if (vars.after) return { repository: { defaultBranchRef: { target: { history: page(Number(vars.after)) } } } };
      return {
        repository: {
          openPrs: { totalCount: 0, nodes: [] },
          openIssues: { totalCount: 0 },
          oldestIssues: { nodes: [] },
          defaultBranchRef: { name: 'main', target: { history: { totalCount: total, ...page(0) } } },
        },
      };
    },
  };
  return { ctx: { github, repo: 'octo/app' } as unknown as ToolContext, queries };
}

const weekly = (data: unknown) => (data as { commitsPerWeek: { commits: number }[] }).commitsPerWeek.reduce((n, w) => n + w.commits, 0);

describe('get_repo_health commits', () => {
  it('counts every commit of the period, page by page (109 > one page of 100)', async () => {
    const { ctx, queries } = fakeCtx(109);
    const out = await runGetRepoHealth({} as never, ctx);
    expect(queries).toEqual(['first', '100']);
    expect(weekly(out.data)).toBe(109);
    expect(out.data).toMatchObject({ commitsLast12Weeks: 109, contributors: [{ login: 'octocat', commits: 72 }, { login: 'hubot', commits: 37 }] });
    expect(out.data).not.toHaveProperty('note');
    expect(validateNode(out.ui).ok).toBe(true);
  });

  it('gives the model the weekly numbers the chart shows', async () => {
    const { ctx } = fakeCtx(5);
    const out = await runGetRepoHealth({} as never, ctx);
    const weeks = (out.data as { commitsPerWeek: { weekStarting: string; commits: number }[] }).commitsPerWeek;
    expect(weeks).toHaveLength(12);
    expect(weeks.every((w) => typeof w.weekStarting === 'string')).toBe(true);
  });

  it('stops after 500 commits and says the counts are partial', async () => {
    const { ctx, queries } = fakeCtx(730);
    const out = await runGetRepoHealth({} as never, ctx);
    expect(queries).toHaveLength(5);
    expect(weekly(out.data)).toBe(500);
    expect(out.data).toMatchObject({ commitsLast12Weeks: 730, note: 'Weekly counts and contributors cover the latest 500 of 730 commits.' });
    expect((out.ui!.props as { description: string }).description).toContain('latest 500 of 730 commits');
  });
});
