import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { UiEvent } from '@repopilot/shared';
import { GenUiHost } from './genui-host';
import { provideGenUi } from './registry';

// Sample agent output, inline. Valid nodes must render; broken ones must be contained.
const stat = (label: string, value: number) => ({ component: 'StatCard', props: { label, value } });
const issue = (number: number, title: string) => ({ number, title, state: 'open', labels: ['wontfix'], ageDays: 100 });
const healthReport = {
  component: 'Section',
  props: {
    title: 'Health report',
    children: [
      { component: 'Grid', props: { columns: 4, children: [stat('Open PRs', 7), stat('Stale PRs', 3), stat('Open issues', 12), stat('Commits', 40)] } },
      { component: 'ActivityChart', props: { title: 'Commits per week', kind: 'bar', points: [{ label: 'W1', value: 3 }, { label: 'W2', value: 5 }] } },
      { component: 'ContributorList', props: { items: [{ login: 'octocat', commits: 12 }] } },
      { component: 'IssueTable', props: { title: 'Oldest open issues', rows: [issue(12, 'Flaky test')] } },
    ],
  },
};
const issuePicker = { component: 'IssueTable', props: { selectable: true, rows: [issue(15, 'Dark mode'), issue(31, 'Bazel'), issue(40, 'IE11')] } };
const unknownComponent = { component: 'ScriptInjector', props: { html: '<img src=x onerror="alert(1)">' } };
const invalidProps = { component: 'StatCard', props: { label: 'Open PRs', value: 7, tone: 'rainbow' } };
const partiallyBroken = {
  component: 'Grid',
  props: { columns: 3, children: [stat('Open PRs', 7), { component: 'StatCard', props: { label: 'Missing value' } }, stat('Stale PRs', 3)] },
};
const PR_URL = 'https://github.com/octocat/hello-world/pull/15';
const prList = {
  component: 'PrList',
  props: {
    items: [
      { number: 15, title: 'Add rate limiting', author: 'octocat', state: 'open', ci: 'success', ageDays: 3, url: PR_URL },
      { number: 16, title: 'Add API reference', author: 'monalisa', state: 'draft', ci: 'pending', ageDays: 2 },
      { number: 17, title: 'Bump deps', author: 'dependabot[bot]', state: 'open', ci: 'failure', ageDays: 19 },
    ],
  },
};

@Component({
  imports: [GenUiHost],
  template: `<app-genui-host [node]="node()" [emit]="onEmit" />`,
})
class HostTest {
  readonly node = signal<unknown>(null);
  readonly events: UiEvent[] = [];
  readonly onEmit = (e: UiEvent) => this.events.push(e);
}

async function render(node: unknown) {
  TestBed.configureTestingModule({ providers: [provideGenUi()] });
  const fixture = TestBed.createComponent(HostTest);
  fixture.componentInstance.node.set(node);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, events: fixture.componentInstance.events };
}

describe('GenUiHost', () => {
  it('renders the health report from catalog components only', async () => {
    const { el } = await render(healthReport);
    expect(el.querySelectorAll('app-stat-card').length).toBe(4);
    expect(el.querySelector('app-activity-chart')).not.toBeNull();
    expect(el.querySelector('app-contributor-list')?.textContent).toContain('octocat');
    expect(el.querySelector('app-issue-table')?.textContent).toContain('#12');
    expect(el.querySelector('app-error-fallback')).toBeNull();
  });

  it('renders ErrorFallback for an unknown component and keeps HTML inert', async () => {
    const { el } = await render(unknownComponent);
    const fallback = el.querySelector('app-error-fallback');
    expect(fallback?.textContent).toContain('Unknown component "ScriptInjector"');
    expect(fallback?.textContent).toContain('onerror');
    expect(el.querySelector('img')).toBeNull();
  });

  it('renders ErrorFallback for invalid props', async () => {
    const { el } = await render(invalidProps);
    expect(el.querySelector('app-stat-card')).toBeNull();
    expect(el.querySelector('app-error-fallback')?.textContent).toContain('tone');
  });

  it('contains a bad child to its own slot', async () => {
    const { el } = await render(partiallyBroken);
    expect(el.querySelectorAll('app-stat-card').length).toBe(2);
    expect(el.querySelectorAll('app-error-fallback').length).toBe(1);
  });

  it('re-renders when the node changes', async () => {
    const { fixture, el } = await render(invalidProps);
    fixture.componentInstance.node.set({ component: 'StatCard', props: { label: 'PRs', value: 3 } });
    await fixture.whenStable();
    expect(el.querySelector('app-error-fallback')).toBeNull();
    expect(el.querySelector('app-stat-card')?.textContent).toContain('3');
  });

  it('renders a PrList with state, CI and a safe link', async () => {
    const { el } = await render(prList);
    const cards = el.querySelectorAll('app-pr-card');
    expect(cards.length).toBe(3);
    expect(cards[0].textContent).toContain('CI passing');
    expect(cards[1].textContent).toContain('Draft');
    expect(cards[2].textContent).toContain('CI failing');
    const link = cards[0].querySelector('a');
    expect(link?.getAttribute('href')).toBe(PR_URL);
    expect(link?.getAttribute('rel')).toContain('noopener');
  });

  it('sends selection events from a nested IssueTable back through emit', async () => {
    const { fixture, el, events } = await render(issuePicker);
    const boxes = el.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]');
    boxes[0].click();
    boxes[2].click();
    await fixture.whenStable();
    expect(events.at(-1)).toEqual({
      component: 'IssueTable',
      name: 'select',
      payload: { numbers: [15, 40] },
    });
    expect(el.textContent).toContain('2 of 3 selected');
  });
});
