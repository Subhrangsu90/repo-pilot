/**
 * Hand-written agent output used before the agent exists, and kept afterwards
 * for tests and for the playground. Valid fixtures must pass `validateNode`;
 * broken fixtures show how the client contains bad output.
 */
import type { UiNode } from './catalog';

export interface Fixture {
  id: string;
  label: string;
  node: unknown;
}

export const healthReport: UiNode = {
  component: 'Section',
  props: {
    title: 'Health report · repopilot-demo',
    description: 'Last 12 weeks of activity on the default branch.',
    children: [
      {
        component: 'Grid',
        props: {
          columns: 4,
          children: [
            { component: 'StatCard', props: { label: 'Open PRs', value: 7, tone: 'neutral' } },
            {
              component: 'StatCard',
              props: {
                label: 'Stale PRs',
                value: 3,
                tone: 'warning',
                hint: 'No activity for 14+ days',
              },
            },
            {
              component: 'StatCard',
              props: {
                label: 'Open issues',
                value: 24,
                tone: 'neutral',
                trend: { direction: 'down', text: '−5 vs last month' },
              },
            },
            {
              component: 'StatCard',
              props: {
                label: 'Median merge time',
                value: '2.4 d',
                tone: 'good',
                trend: { direction: 'down', text: 'faster than last month' },
              },
            },
          ],
        },
      },
      {
        component: 'Grid',
        props: {
          columns: 2,
          children: [
            {
              component: 'ActivityChart',
              props: {
                title: 'Commits per week',
                kind: 'bar',
                points: [12, 9, 15, 7, 11, 18, 14, 6, 10, 21, 16, 13].map((value, i) => ({
                  label: `W${i + 1}`,
                  value,
                })),
              },
            },
            {
              component: 'ContributorList',
              props: {
                items: [
                  { login: 'octocat', commits: 48 },
                  { login: 'hubot', commits: 31 },
                  { login: 'monalisa', commits: 22 },
                  { login: 'dependabot', commits: 9 },
                ],
              },
            },
          ],
        },
      },
      {
        component: 'IssueTable',
        props: {
          title: 'Oldest open issues',
          rows: [
            {
              number: 12,
              title: 'Login redirect loops on Safari',
              state: 'open',
              labels: ['bug'],
              author: 'monalisa',
              assignees: ['monalisa'],
              ageDays: 132,
            },
            {
              number: 15,
              title: 'Support dark mode in settings',
              state: 'open',
              labels: ['enhancement', 'wontfix'],
              author: 'hubot',
              ageDays: 118,
            },
            {
              number: 27,
              title: 'Flaky test: auth.spec.ts times out',
              state: 'open',
              labels: ['ci', 'bug'],
              author: 'octocat',
              assignees: ['octocat', 'hubot'],
              ageDays: 64,
            },
          ],
        },
      },
    ],
  },
};

export const issuePicker: UiNode = {
  component: 'IssueTable',
  props: {
    title: 'Pick issues to close',
    selectable: true,
    rows: [
      { number: 15, title: 'Support dark mode in settings', state: 'open', labels: ['wontfix'], ageDays: 118 },
      { number: 31, title: 'Rewrite build in Bazel', state: 'open', labels: ['wontfix'], ageDays: 97 },
      { number: 40, title: 'IE11 support', state: 'open', labels: ['wontfix'], ageDays: 210 },
    ],
  },
};

/** Unknown component carrying an XSS payload: must render as inert text. */
export const unknownComponent = {
  component: 'ScriptInjector',
  props: { html: '<img src=x onerror="alert(\'xss\')">' },
};

/** Known component, invalid props. */
export const invalidProps = {
  component: 'StatCard',
  props: { label: 'Open PRs', value: 7, tone: 'rainbow' },
};

/** One bad child inside a valid layout: only that slot should fail. */
export const partiallyBroken: UiNode = {
  component: 'Grid',
  props: {
    columns: 3,
    children: [
      { component: 'StatCard', props: { label: 'Open PRs', value: 7 } },
      { component: 'StatCard', props: { label: 'Missing value' } },
      { component: 'StatCard', props: { label: 'Stale PRs', value: 3, tone: 'warning' } },
    ],
  },
};

export const prList: UiNode = {
  component: 'PrList',
  props: {
    title: 'Open pull requests',
    items: [
      {
        number: 15,
        title: 'Add rate limiting to login',
        author: 'octocat',
        branch: 'feature/login-rate-limit',
        state: 'open',
        ci: 'success',
        reviewers: ['hubot'],
        labels: ['enhancement', 'security'],
        ageDays: 3,
        additions: 24,
        deletions: 3,
        url: 'https://github.com/octocat/repopilot-demo/pull/15',
      },
      { number: 16, title: 'Add API reference', author: 'monalisa', branch: 'docs/api-reference', state: 'draft', ci: 'pending', ageDays: 2, additions: 22, deletions: 0 },
      { number: 17, title: 'Filter notes by tag', author: 'dependabot[bot]', branch: 'feature/note-tags', state: 'open', ci: 'failure', ageDays: 19, additions: 5, deletions: 0 },
    ],
  },
};

export const fixtures: Fixture[] = [
  { id: 'health-report', label: 'Health report', node: healthReport },
  { id: 'pr-list', label: 'Pull requests', node: prList },
  { id: 'issue-picker', label: 'Selectable issues', node: issuePicker },
  { id: 'partially-broken', label: 'One bad child', node: partiallyBroken },
  { id: 'invalid-props', label: 'Invalid props', node: invalidProps },
  { id: 'unknown-component', label: 'Unknown component (XSS)', node: unknownComponent },
];
