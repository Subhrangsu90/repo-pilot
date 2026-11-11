import { validateNode } from '@repopilot/shared';
import { GitHubError } from '../github/client';
import { renderNotes } from '../github/releases';
import { createReleaseTool } from './actions';
import type { ToolContext } from './read-tools';

/** Fake GitHub: v1.0.0 is the latest release; PRs 14 and 16 were merged since; tag v1.0.0 exists. */
function fakeCtx(existingTags = ['v1.0.0']) {
  const posted: { path: string; body: unknown }[] = [];
  const github = {
    async rest(path: string, init: { method?: string; body?: unknown } = {}) {
      if (init.method === 'POST') {
        posted.push({ path, body: init.body });
        return { id: 1, html_url: 'https://github.com/octo/demo/releases/tag/v1.1.0' };
      }
      if (path === '/repos/octo/demo') return { default_branch: 'main' };
      if (path === '/repos/octo/demo/releases/latest') return { tag_name: 'v1.0.0', published_at: '2026-11-01T10:00:00Z', created_at: '' };
      if (path.startsWith('/repos/octo/demo/compare/v1.0.0...main')) {
        return { total_commits: 5, commits: [{ author: { login: 'a' }, commit: { author: null } }, { author: { login: 'b' }, commit: { author: null } }] };
      }
      const tag = /\/git\/ref\/tags\/(.+)$/.exec(path)?.[1];
      if (tag && existingTags.includes(decodeURIComponent(tag))) return { ref: `refs/tags/${tag}` };
      throw new GitHubError(`GitHub GET ${path}: 404`, 404);
    },
    async graphql(_q: string, vars: { q: string }) {
      expect(vars.q).toBe('repo:octo/demo is:pr is:merged base:main merged:>=2026-11-01T10:00:00Z');
      return {
        search: {
          nodes: [
            { number: 16, title: 'Add API reference', author: { login: 'a' }, labels: { nodes: [{ name: 'docs' }] } },
            { number: 14, title: 'Fix session expiry', author: { login: 'b' }, labels: { nodes: [] } },
          ],
        },
      };
    },
  };
  return { ctx: { github, allowlist: ['octo/demo'] } as unknown as ToolContext, posted };
}

const draft = {
  tag: 'v1.1.0',
  name: 'API reference',
  prerelease: false,
  features: [{ text: 'An API reference for every endpoint', pr: 16 }],
  fixes: [
    { text: 'Sessions no longer expire early', pr: 14 },
    { text: 'Something from long ago', pr: 3 },
  ],
  breaking: [],
};

describe('create_release', () => {
  it('dry run drafts the release with its stats and drops links to PRs outside it, without publishing', async () => {
    const { ctx, posted } = fakeCtx();
    const plan = await createReleaseTool.plan(draft, ctx);

    expect(posted).toEqual([]);
    if (plan.kind !== 'card' || plan.component !== 'ReleaseForm') throw new Error('expected a ReleaseForm');
    expect(plan.card).toMatchObject({
      previousTag: 'v1.0.0',
      target: 'main',
      stats: { commits: 5, pullRequests: 2, contributors: 2 },
      pulls: [
        { number: 14, title: 'Fix session expiry' },
        { number: 16, title: 'Add API reference' },
      ],
      notes: ['Removed the link to #3: it was not merged since v1.0.0.'],
    });
    expect(plan.card.sections.fixes[1]).toEqual({ text: 'Something from long ago' });
    const node = { component: 'ReleaseForm', props: { ...plan.card, toolCallId: 'c1', tool: 'create_release', risk: 'write' } };
    expect(validateNode(node).ok).toBe(true);
  });

  it('refuses a tag that already exists', async () => {
    const { ctx } = fakeCtx();
    await expect(createReleaseTool.plan({ ...draft, tag: 'v1.0.0' }, ctx)).rejects.toThrow('already exists');
  });

  it('publishes the user edits on the default branch, keeping only links to PRs in the release', async () => {
    const { ctx, posted } = fakeCtx();
    const plan = await createReleaseTool.plan(draft, ctx);
    if (plan.kind !== 'card') throw new Error('expected a card');
    const edits = {
      tag: 'v1.1.0',
      name: 'Sign in with GitHub',
      prerelease: true,
      sections: { features: [{ text: 'Edited by me', pr: 16 }], fixes: [{ text: 'Sneaky link', pr: 99 }], breaking: [] },
    };
    const out = await createReleaseTool.execute(draft, [], ctx, { edits, carry: plan.carry });

    expect(posted).toEqual([
      {
        path: '/repos/octo/demo/releases',
        body: {
          tag_name: 'v1.1.0',
          target_commitish: 'main',
          name: 'Sign in with GitHub',
          body: '## Features\n\n- Edited by me (#16)\n\n## Fixes\n\n- Sneaky link',
          prerelease: true,
          draft: false,
          make_latest: 'false',
        },
      },
    ]);
    expect(out).toMatchObject({ ok: true, result: 'Published v1.1.0 — Sign in with GitHub.', patch: { releaseUrl: expect.stringContaining('/releases/tag/v1.1.0') } });
  });

  it('checks the tag again at publish time, because the user may have changed it', async () => {
    const { ctx, posted } = fakeCtx();
    const plan = await createReleaseTool.plan(draft, ctx);
    if (plan.kind !== 'card') throw new Error('expected a card');
    const edits = { tag: 'v1.0.0', name: 'x', prerelease: false, sections: { features: [], fixes: [], breaking: [] } };
    await expect(createReleaseTool.execute(draft, [], ctx, { edits, carry: plan.carry })).rejects.toThrow('already exists');
    expect(posted).toEqual([]);
  });
});

describe('renderNotes', () => {
  it('writes one section per non-empty group', () => {
    expect(renderNotes({ features: [], fixes: [{ text: 'Fixed it', pr: 2 }], breaking: [{ text: 'Dropped Node 18' }] })).toBe(
      '## Fixes\n\n- Fixed it (#2)\n\n## Breaking changes\n\n- Dropped Node 18',
    );
  });
});
