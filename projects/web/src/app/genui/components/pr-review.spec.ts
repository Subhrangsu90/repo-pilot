import { TestBed } from '@angular/core/testing';
import type { PropsOf, UiEvent } from '@repopilot/shared';
import { PrReview } from './pr-review';

const props = (over: Partial<PropsOf<'PrReview'>> = {}): PropsOf<'PrReview'> => ({
  toolCallId: 'c1',
  tool: 'submit_pull_request_review',
  risk: 'write',
  pr: {
    number: 15,
    title: 'Add rate limiting',
    url: 'https://github.com/octo/demo/pull/15',
    state: 'open',
    author: 'octocat',
    branch: 'feature/rate-limit',
    base: 'main',
    additions: 24,
    deletions: 3,
    changedFiles: 2,
  },
  files: [
    { path: 'src/auth.ts', additions: 20, deletions: 3 },
    { path: 'README.md', additions: 4, deletions: 0 },
  ],
  diffs: [
    {
      path: 'src/auth.ts',
      lines: [
        { kind: 'hunk', text: '@@ -1,2 +1,3 @@' },
        { kind: 'ctx', old: 1, new: 1, text: 'const a = 1;' },
        { kind: 'del', old: 2, text: 'log(password);' },
        { kind: 'add', new: 2, text: 'const key = ip;' },
        { kind: 'add', new: 3, text: 'log(user);' },
      ],
      comments: [],
    },
  ],
  comments: [
    { id: 1, path: 'src/auth.ts', line: 2, severity: 'issue', body: 'Normalise the key.' },
    { id: 2, path: 'src/auth.ts', line: 3, severity: 'suggestion', body: 'Do not log the user.' },
  ],
  skipped: [],
  summary: 'The rate limit key is not normalised.',
  event: 'REQUEST_CHANGES',
  allowedEvents: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'],
  status: 'pending',
  ...over,
});

async function render(p = props()) {
  const events: UiEvent[] = [];
  const fixture = TestBed.createComponent(PrReview);
  fixture.componentRef.setInput('props', p);
  fixture.componentRef.setInput('emit', (e: UiEvent) => events.push(e));
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label))!;
  return { fixture, el, events, button };
}

describe('PrReview', () => {
  it('shows the diff with each comment under its line, and focuses the panel, never Submit', async () => {
    const { el } = await render();
    const issue = el.querySelector('article[aria-label="Issue on line 2"]');
    expect(issue?.textContent).toContain('Normalise the key.');
    expect(el.textContent).toContain('feature/rate-limit → main');
    expect(document.activeElement?.tagName).toBe('SECTION');
  });

  it('submits the kept comments with the user edits and verdict', async () => {
    const { el, events, fixture, button } = await render();

    // Edit comment 1 inside the diff.
    button('Edit').click();
    await fixture.whenStable();
    const box = el.querySelector<HTMLTextAreaElement>('textarea[id="comment-1"]')!;
    box.value = 'Lower-case the key before counting.';
    box.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    button('Save').click();
    await fixture.whenStable();

    // Remove comment 2 and switch the verdict to Comment.
    const remove = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith('Remove') && b.textContent.includes('line 3'));
    remove!.click();
    el.querySelectorAll<HTMLInputElement>('input[type=radio]')[0].click();
    await fixture.whenStable();

    expect(button('Submit review').textContent).toContain('Submit review with 1 comment');
    button('Submit review').click();
    expect(events).toEqual([
      {
        component: 'PrReview',
        name: 'approve',
        payload: {
          toolCallId: 'c1',
          selected: [1],
          edits: {
            event: 'COMMENT',
            summary: 'The rate limit key is not normalised.',
            comments: [{ id: 1, body: 'Lower-case the key before counting.' }],
          },
        },
      },
    ]);
  });

  it('only offers the verdicts GitHub allows, with the reason', async () => {
    const { el } = await render(
      props({ event: 'COMMENT', allowedEvents: ['COMMENT'], eventNote: 'GitHub only allows a comment review on your own pull requests.' }),
    );
    const radios = [...el.querySelectorAll<HTMLInputElement>('input[type=radio]')];
    expect(radios.map((r) => r.disabled)).toEqual([false, true, true]);
    expect(el.textContent).toContain('your own pull requests');
  });

  it('discarding sends a reject and nothing else', async () => {
    const { events, button } = await render();
    button('Discard').click();
    expect(events).toEqual([{ component: 'PrReview', name: 'reject', payload: { toolCallId: 'c1' } }]);
  });

  it('after posting shows the result and a link to the review, with no buttons in the panel', async () => {
    const { el } = await render(
      props({ status: 'approved', selected: [1], result: 'Posted a review with 1 comment on #15.', reviewUrl: 'https://github.com/octo/demo/pull/15#r1' }),
    );
    expect(el.querySelector('[role=status]')?.textContent).toContain('Posted a review with 1 comment');
    expect(el.querySelector('a[href="https://github.com/octo/demo/pull/15#r1"]')).not.toBeNull();
    expect(el.querySelectorAll('aside section button')).toHaveLength(0);
    expect(el.querySelectorAll('article')).toHaveLength(1);
  });
});
