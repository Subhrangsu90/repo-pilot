import { validateNode } from './catalog';
import { prList } from './fixtures';
import { listIssues, listPullRequests, needsApproval, toolSpecs } from './tools';

describe('needsApproval', () => {
  it('lets read tools run immediately', () => {
    for (const t of toolSpecs) expect(needsApproval(t.name)).toBe(t.risk !== 'read');
  });

  it('treats unknown tools as needing approval', () => {
    expect(needsApproval('delete_repository')).toBe(true);
    expect(needsApproval('')).toBe(true);
  });
});

describe('tool inputs', () => {
  it('apply defaults', () => {
    expect(listPullRequests.input.parse({})).toEqual({ state: 'open', limit: 20 });
    expect(listIssues.input.parse({ labels: ['wontfix'] })).toMatchObject({ state: 'open', labels: ['wontfix'] });
  });

  it('reject repo names that are not owner/repo', () => {
    expect(listPullRequests.input.safeParse({ repo: '../../etc/passwd' }).success).toBe(false);
    expect(listPullRequests.input.safeParse({ repo: 'octocat/hello-world' }).success).toBe(true);
  });

  it('cap limits', () => {
    expect(listPullRequests.input.safeParse({ limit: 500 }).success).toBe(false);
  });

  it('have unique names', () => {
    const names = toolSpecs.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('PR components', () => {
  it('accept the PrList fixture, including bot authors', () => {
    expect(validateNode(prList)).toMatchObject({ ok: true });
  });

  it('only link to github.com', () => {
    const card = (url: string) => ({
      component: 'PrCard',
      props: { number: 1, title: 't', state: 'open', ageDays: 0, url },
    });
    expect(validateNode(card('https://github.com/o/r/pull/1')).ok).toBe(true);
    expect(validateNode(card('https://evil.example/pull/1')).ok).toBe(false);
    expect(validateNode(card('javascript:alert(1)')).ok).toBe(false);
  });
});
