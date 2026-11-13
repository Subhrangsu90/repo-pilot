import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { A2UI_VERSION, propUpdate, REPOPILOT_CATALOG_ID, surfaceMessages, type A2uiMessage, type UiEvent } from '@repopilot/shared';
import { A2uiSurfaceView } from './a2ui-surface';
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
  imports: [A2uiSurfaceView],
  template: `
    @if (ops(); as o) {
      <app-a2ui-surface [operations]="o" [emit]="onEmit" />
    } @else {
      <app-a2ui-surface [node]="node()" [emit]="onEmit" />
    }
  `,
})
class HostTest {
  readonly node = signal<unknown>(null);
  readonly ops = signal<A2uiMessage[] | null>(null);
  readonly events: UiEvent[] = [];
  readonly onEmit = (e: UiEvent) => this.events.push(e);
}

async function render(input: { node?: unknown; ops?: A2uiMessage[] }) {
  TestBed.configureTestingModule({ providers: [provideGenUi()] });
  const fixture = TestBed.createComponent(HostTest);
  if (input.ops) fixture.componentInstance.ops.set(input.ops);
  else fixture.componentInstance.node.set(input.node);
  await settle(fixture);
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, events: fixture.componentInstance.events };
}

async function settle(fixture: { whenStable(): Promise<unknown>; detectChanges(): void }) {
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
}

describe('A2uiSurfaceView', () => {
  it('renders the health report from catalog components only, through A2UI', async () => {
    const { el } = await render({ ops: surfaceMessages('s1', healthReport) });
    expect(el.querySelector('a2ui-v09-surface')).not.toBeNull();
    expect(el.querySelectorAll('app-stat-card').length).toBe(4);
    expect(el.querySelector('app-activity-chart')).not.toBeNull();
    expect(el.querySelector('app-contributor-list')?.textContent).toContain('octocat');
    expect(el.querySelector('app-issue-table')?.textContent).toContain('#12');
    expect(el.querySelector('app-error-fallback')).toBeNull();
  });

  it('renders ErrorFallback for an unknown component and keeps HTML inert', async () => {
    const { el } = await render({ node: unknownComponent });
    const fallback = el.querySelector('app-error-fallback');
    expect(fallback?.textContent).toContain('Unknown component "ScriptInjector"');
    expect(fallback?.textContent).toContain('onerror');
    expect(el.querySelector('img')).toBeNull();
  });

  it('renders ErrorFallback for invalid props', async () => {
    const { el } = await render({ node: invalidProps });
    expect(el.querySelector('app-stat-card')).toBeNull();
    expect(el.querySelector('app-error-fallback')?.textContent).toContain('tone');
  });

  it('contains a bad child to its own slot', async () => {
    const { el } = await render({ node: partiallyBroken });
    expect(el.querySelectorAll('app-stat-card').length).toBe(2);
    expect(el.querySelectorAll('app-error-fallback').length).toBe(1);
  });

  it('re-renders when the node changes', async () => {
    const { fixture, el } = await render({ node: invalidProps });
    fixture.componentInstance.node.set({ component: 'StatCard', props: { label: 'PRs', value: 3 } });
    await settle(fixture);
    expect(el.querySelector('app-error-fallback')).toBeNull();
    expect(el.querySelector('app-stat-card')?.textContent).toContain('3');
  });

  it('applies an A2UI data model update in place', async () => {
    const ops = surfaceMessages('s1', stat('Open PRs', 7));
    const { fixture, el } = await render({ ops });
    expect(el.querySelector('app-stat-card')?.textContent).toContain('7');
    fixture.componentInstance.ops.set([...ops, propUpdate('s1', 'root', 'value', 9)]);
    await settle(fixture);
    expect(el.querySelector('app-stat-card')?.textContent).toContain('9');
  });

  it('validates bound data again in the browser: a bad data model value becomes ErrorFallback in its slot', async () => {
    const ops = surfaceMessages('s1', partiallyBroken);
    const { fixture, el } = await render({ ops });
    fixture.componentInstance.ops.set([...ops, propUpdate('s1', 'root_0', 'tone', 'rainbow')]);
    await settle(fixture);
    expect(el.querySelectorAll('app-error-fallback').length).toBe(2);
    expect(el.querySelectorAll('app-stat-card').length).toBe(1);
  });

  it('shows ErrorFallback when A2UI refuses the messages', async () => {
    const bad: A2uiMessage[] = [
      { version: A2UI_VERSION, createSurface: { surfaceId: 'x', catalogId: REPOPILOT_CATALOG_ID } },
      { version: A2UI_VERSION, updateComponents: { surfaceId: 'x', components: [{ id: 'root', component: 'StatCard', label: 5, value: 1 }] } },
    ];
    const { el } = await render({ ops: bad });
    expect(el.querySelector('app-stat-card')).toBeNull();
    expect(el.querySelector('app-error-fallback')?.textContent).toContain('could not be shown');
  });

  it('renders a PrList with state, CI and a safe link', async () => {
    const { el } = await render({ node: prList });
    const cards = el.querySelectorAll('app-pr-card');
    expect(cards.length).toBe(3);
    expect(cards[0].textContent).toContain('CI passing');
    expect(cards[1].textContent).toContain('Draft');
    expect(cards[2].textContent).toContain('CI failing');
    const link = cards[0].querySelector('a');
    expect(link?.getAttribute('href')).toBe(PR_URL);
    expect(link?.getAttribute('rel')).toContain('noopener');
  });

  it('sends a component event as an A2UI action and back to the page as a UiEvent', async () => {
    const { fixture, el, events } = await render({ ops: surfaceMessages('s7', issuePicker) });
    const boxes = el.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]');
    boxes[0].click();
    boxes[2].click();
    await settle(fixture);
    await new Promise((r) => setTimeout(r, 0));
    expect(events.at(-1)).toMatchObject({
      component: 'IssueTable',
      name: 'select',
      payload: { numbers: [15, 40] },
      surfaceId: 's7',
      action: { name: 'select', surfaceId: 's7', sourceComponentId: 'root', context: { component: 'IssueTable', payload: { numbers: [15, 40] } } },
    });
    expect(el.textContent).toContain('2 of 3 selected');
  });
});
