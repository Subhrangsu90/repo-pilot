import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  healthReport,
  invalidProps,
  issuePicker,
  partiallyBroken,
  UiEvent,
  unknownComponent,
} from '@repopilot/shared';
import { GenUiHost } from './genui-host';
import { provideGenUi } from './registry';

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
