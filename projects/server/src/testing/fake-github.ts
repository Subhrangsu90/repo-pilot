import { GitHubError } from '../github/client';

/**
 * An in-process GitHub for end-to-end tests (E2E_MODE=1): the demo repo's
 * issues and pull requests, answering only the calls the demo paths make. Every
 * write is recorded so a test can check exactly what "reached GitHub". Anything
 * not mocked answers 404, so a new call shows up as a failing test, never as a
 * request to the real API.
 */

export interface RecordedWrite {
  method: string;
  path: string;
  body: unknown;
}

interface FakeIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  daysAgo: number;
  author: string;
}

interface FakePull {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  daysAgo: number;
  branch: string;
  labels: string[];
  ci: 'SUCCESS' | 'FAILURE' | 'PENDING' | null;
  additions: number;
  deletions: number;
}

export { E2E_REPO as FAKE_REPO } from '../config';
import { E2E_REPO as FAKE_REPO } from '../config';
const VIEWER = 'demo-user';

const ISSUES: FakeIssue[] = [
  { number: 1, title: 'Session expires almost immediately after login', state: 'closed', labels: ['bug'], daysAgo: 9, author: VIEWER },
  { number: 2, title: 'Add rate limiting to login', state: 'open', labels: ['enhancement', 'security'], daysAgo: 9, author: VIEWER },
  { number: 3, title: "formatRelative says 'today' for yesterday evening", state: 'open', labels: ['bug', 'good first issue'], daysAgo: 8, author: VIEWER },
  { number: 4, title: 'Search should ignore accents (café → cafe)', state: 'open', labels: ['enhancement'], daysAgo: 8, author: VIEWER },
  { number: 5, title: 'Notes with an empty title crash listNotes', state: 'open', labels: ['bug'], daysAgo: 7, author: VIEWER },
  { number: 6, title: 'CI should test on Node 20 and 22', state: 'open', labels: ['good first issue', 'ci'], daysAgo: 7, author: VIEWER },
  { number: 7, title: 'Document the session API', state: 'open', labels: ['documentation'], daysAgo: 6, author: VIEWER },
  { number: 8, title: 'How do I reset my password?', state: 'open', labels: ['question'], daysAgo: 6, author: 'octocat' },
  { number: 9, title: 'Support Internet Explorer 11', state: 'open', labels: ['wontfix'], daysAgo: 5, author: VIEWER },
  { number: 10, title: 'Rewrite the build in Bazel', state: 'open', labels: ['wontfix'], daysAgo: 5, author: VIEWER },
  { number: 11, title: 'Dark mode for the notes list', state: 'open', labels: ['enhancement', 'wontfix'], daysAgo: 4, author: VIEWER },
  { number: 12, title: 'Typo in README: "scrpyt"', state: 'closed', labels: ['documentation'], daysAgo: 4, author: VIEWER },
];

const PULLS: FakePull[] = [
  { number: 17, title: 'Filter notes by tag', state: 'OPEN', isDraft: false, daysAgo: 1, branch: 'feature/note-tags', labels: ['enhancement'], ci: 'SUCCESS', additions: 24, deletions: 2 },
  { number: 16, title: 'Add API reference', state: 'OPEN', isDraft: true, daysAgo: 2, branch: 'docs/api-reference', labels: ['documentation'], ci: null, additions: 60, deletions: 0 },
  { number: 15, title: 'Add rate limiting to login', state: 'OPEN', isDraft: false, daysAgo: 3, branch: 'feature/login-rate-limit', labels: ['enhancement', 'security'], ci: 'FAILURE', additions: 31, deletions: 4 },
];

const DAY = 86_400_000;

export class FakeGitHub {
  private issues = structuredClone(ISSUES);
  readonly writes: RecordedWrite[] = [];

  /** Back to the seeded demo data (between tests). */
  reset() {
    this.issues = structuredClone(ISSUES);
    this.writes.length = 0;
  }

  async login(): Promise<string> {
    return VIEWER;
  }

  async graphql<T>(query: string, vars: Record<string, unknown> = {}): Promise<T> {
    this.checkRepo(`${String(vars['owner'])}/${String(vars['name'])}`);
    // 'viewer { login' and not 'viewer {': the PR query also contains "requestedReviewer {".
    if (query.includes('viewer { login')) return this.overview() as T;
    if (query.includes('oldestIssues')) return this.health() as T;
    if (query.includes('pullRequests(states: $states')) return this.pulls(vars['states'] as string[] | undefined, Number(vars['first'] ?? 50)) as T;
    throw new GitHubError('GitHub GraphQL: query not mocked in FakeGitHub', 404);
  }

  async rest<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? 'GET';
    const url = new URL(path, 'https://api.github.test');
    const m = /^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+))?$/.exec(url.pathname);
    if (m) {
      this.checkRepo(m[1]);
      if (!m[2] && method === 'GET') return this.listIssues(url.searchParams) as T;
      const issue = this.issues.find((i) => i.number === Number(m[2]));
      if (!issue) throw new GitHubError(`GitHub ${method} ${path}: 404`, 404);
      if (method === 'GET') return this.issueJson(issue) as T;
      if (method === 'PATCH') {
        this.writes.push({ method, path: url.pathname, body: init.body });
        const state = (init.body as { state?: unknown } | undefined)?.state;
        if (state === 'open' || state === 'closed') issue.state = state;
        return this.issueJson(issue) as T;
      }
    }
    throw new GitHubError(`GitHub ${method} ${path}: not mocked in FakeGitHub`, 404);
  }

  private checkRepo(full: string) {
    if (full !== FAKE_REPO) throw new GitHubError(`GitHub: repository ${full} not found`, 404);
  }

  private date(daysAgo: number) {
    return new Date(Date.now() - daysAgo * DAY).toISOString();
  }

  private issueJson(i: FakeIssue) {
    return {
      number: i.number,
      title: i.title,
      state: i.state,
      created_at: this.date(i.daysAgo),
      user: { login: i.author },
      assignees: [],
      labels: i.labels.map((name) => ({ name })),
    };
  }

  private listIssues(params: URLSearchParams) {
    const state = params.get('state') ?? 'open';
    const labels = (params.get('labels') ?? '').split(',').filter(Boolean);
    return this.issues
      .filter((i) => state === 'all' || i.state === state)
      .filter((i) => labels.every((l) => i.labels.includes(l)))
      .map((i) => this.issueJson(i));
  }

  private overview() {
    return {
      viewer: { login: VIEWER, avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4' },
      rateLimit: { limit: 5000, remaining: 4990 },
      repository: {
        latestRelease: { tagName: 'v1.1.0' },
        pullRequests: { totalCount: PULLS.filter((p) => p.state === 'OPEN').length },
        issues: { totalCount: this.issues.filter((i) => i.state === 'open').length },
      },
    };
  }

  private pulls(states: string[] | undefined, first: number) {
    const nodes = PULLS.filter((p) => !states || states.includes(p.state))
      .slice(0, first)
      .map((p) => ({
        number: p.number,
        title: p.title,
        url: `https://github.com/${FAKE_REPO}/pull/${p.number}`,
        state: p.state,
        isDraft: p.isDraft,
        createdAt: this.date(p.daysAgo),
        additions: p.additions,
        deletions: p.deletions,
        headRefName: p.branch,
        author: { login: VIEWER },
        labels: { nodes: p.labels.map((name) => ({ name })) },
        reviewRequests: { nodes: [] },
        latestReviews: { nodes: [] },
        commits: { nodes: [{ commit: { statusCheckRollup: p.ci ? { state: p.ci } : null } }] },
      }));
    return { repository: { pullRequests: { nodes } } };
  }

  private health() {
    const open = this.issues.filter((i) => i.state === 'open').sort((a, b) => b.daysAgo - a.daysAgo);
    return {
      repository: {
        openPrs: { totalCount: 3, nodes: PULLS.map((p) => ({ updatedAt: this.date(p.daysAgo) })) },
        openIssues: { totalCount: open.length },
        oldestIssues: {
          nodes: open.slice(0, 5).map((i) => ({
            number: i.number,
            title: i.title,
            createdAt: this.date(i.daysAgo),
            author: { login: i.author },
            assignees: { nodes: [] },
            labels: { nodes: i.labels.map((name) => ({ name })) },
          })),
        },
        defaultBranchRef: {
          name: 'main',
          target: {
            history: {
              totalCount: 19,
              nodes: Array.from({ length: 19 }, (_, k) => ({ committedDate: this.date(k % 10), author: { user: { login: VIEWER } } })),
            },
          },
        },
      },
    };
  }
}
