import { TestBed } from '@angular/core/testing';
import type { PropsOf, UiEvent } from '@repopilot/shared';
import { ApprovalCard } from './approval-card';

const props = (over: Partial<PropsOf<'ApprovalCard'>> = {}): PropsOf<'ApprovalCard'> => ({
  toolCallId: 'c1',
  tool: 'bulk_update_issues',
  risk: 'destructive',
  verb: 'close',
  noun: 'issue',
  summary: 'Each selected issue will be closed.',
  items: [
    { id: 9, title: 'Support IE11' },
    { id: 10, title: 'Rewrite in Bazel' },
    { id: 11, title: 'Dark mode' },
  ],
  skipped: [],
  details: [],
  reversible: true,
  status: 'pending',
  ...over,
});

async function render(p = props()) {
  const events: UiEvent[] = [];
  const fixture = TestBed.createComponent(ApprovalCard);
  fixture.componentRef.setInput('props', p);
  fixture.componentRef.setInput('emit', (e: UiEvent) => events.push(e));
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label))!;
  return { fixture, el, events, button };
}

describe('ApprovalCard', () => {
  it('moves focus to the card, never to Approve', async () => {
    const { el } = await render();
    expect(document.activeElement).toBe(el.querySelector('section'));
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
  });

  it('approves only the items still ticked, with a live count', async () => {
    const { el, events, fixture, button } = await render();
    expect(el.querySelector('h2')?.textContent).toContain('Close 3 issues');

    (el.querySelectorAll<HTMLInputElement>('li input[type=checkbox]')[1]).click();
    await fixture.whenStable();
    expect(el.querySelector('h2')?.textContent).toContain('Close 2 issues');

    button('Approve and close 2').click();
    expect(events).toEqual([{ component: 'ApprovalCard', name: 'approve', payload: { toolCallId: 'c1', selected: [9, 11] } }]);
  });

  it('counts one API request per ticked item, live', async () => {
    const { el, fixture } = await render(props({ requestMethod: 'PATCH' }));
    const calls = () => el.querySelector('aside dd[aria-live]')?.textContent?.trim();
    expect(calls()).toBe('3 PATCH requests');
    el.querySelectorAll<HTMLInputElement>('li input[type=checkbox]')[0].click();
    el.querySelectorAll<HTMLInputElement>('li input[type=checkbox]')[1].click();
    await fixture.whenStable();
    expect(calls()).toBe('1 PATCH request');
  });

  it('offers Reject, Edit request and Approve, in that order, and Edit sends its own event', async () => {
    const { el, events, button } = await render();
    const labels = [...el.querySelectorAll('section button')].map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Reject', 'Edit request', 'Approve and close 3']);

    button('Edit request').click();
    expect(events).toEqual([{ component: 'ApprovalCard', name: 'edit', payload: { toolCallId: 'c1' } }]);
  });

  it('uses the risk button for destructive changes and primary for writes', async () => {
    expect((await render()).button('Approve').classList).toContain('btn-risk');
    expect((await render(props({ risk: 'write' }))).button('Approve').classList).toContain('btn-primary');
  });

  it('shows the outcome and no buttons once decided', async () => {
    const { el } = await render(props({ status: 'approved', selected: [9], result: 'Closed 1 issue.' }));
    expect(el.querySelector('[role=status]')?.textContent).toContain('Closed 1 issue.');
    expect(el.querySelectorAll('section button')).toHaveLength(0);
  });
});
