import { TestBed } from '@angular/core/testing';
import type { PropsOf, UiEvent } from '@repopilot/shared';
import { rewritePrompt } from '../../core/agent-session';
import { nextMinor } from '../../features/releases/release-builder';
import { ReleaseForm } from './release-form';

const props = (over: Partial<PropsOf<'ReleaseForm'>> = {}): PropsOf<'ReleaseForm'> => ({
  toolCallId: 'c1',
  tool: 'create_release',
  risk: 'write',
  repo: 'octo/demo',
  target: 'main',
  previousTag: 'v1.0.0',
  stats: { commits: 14, pullRequests: 2, contributors: 3 },
  pulls: [
    { number: 14, title: 'Fix session expiry' },
    { number: 16, title: 'Add API reference' },
  ],
  tag: 'v1.1.0',
  name: 'API reference',
  prerelease: false,
  sections: { features: [{ text: 'An API reference', pr: 16 }], fixes: [{ text: 'Sessions last longer', pr: 14 }], breaking: [] },
  notes: [],
  status: 'pending',
  ...over,
});

async function render(p = props()) {
  const events: UiEvent[] = [];
  const fixture = TestBed.createComponent(ReleaseForm);
  fixture.componentRef.setInput('props', p);
  fixture.componentRef.setInput('emit', (e: UiEvent) => events.push(e));
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label))!;
  const type = async (selector: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
  };
  return { fixture, el, events, button, type };
}

describe('ReleaseForm', () => {
  it('shows the draft beside a preview with the release stats', async () => {
    const { el } = await render();
    const preview = el.querySelector('aside[aria-label="Preview"]')!;
    expect(preview.textContent).toContain('v1.1.0 — API reference');
    expect(preview.textContent).toContain('Latest');
    expect(preview.textContent?.replace(/\s+/g, ' ')).toContain('14 commits · 2 pull requests · 3 contributors since v1.0.0');
    expect(document.activeElement?.tagName).toBe('SECTION');
  });

  it('marks fields the user changed and keeps the preview live', async () => {
    const { el, type, fixture } = await render();
    await type('#release-c1-name', 'Sign in with GitHub');
    el.querySelector<HTMLButtonElement>('button[aria-label="Remove: Sessions last longer"]')!.click();
    await fixture.whenStable();

    expect(el.textContent).toContain('edited by you');
    expect(el.textContent).toContain('you edited 2 fields');
    expect(el.querySelector('aside')?.textContent).toContain('v1.1.0 — Sign in with GitHub');
    expect(el.querySelector('aside')?.textContent).not.toContain('Sessions last longer');
  });

  it('publishes only after the review step, with the user edits', async () => {
    const { events, fixture, button, type } = await render();
    await type('#release-c1-name', 'Sign in with GitHub');
    button('Review and publish').click();
    await fixture.whenStable();
    expect(events).toEqual([]);
    expect(document.activeElement?.textContent).toContain('Publish v1.1.0?');

    button('Publish release').click();
    expect(events).toEqual([
      {
        component: 'ReleaseForm',
        name: 'approve',
        payload: {
          toolCallId: 'c1',
          edits: {
            tag: 'v1.1.0',
            name: 'Sign in with GitHub',
            prerelease: false,
            sections: { features: [{ text: 'An API reference', pr: 16 }], fixes: [{ text: 'Sessions last longer', pr: 14 }], breaking: [] },
          },
        },
      },
    ]);
  });

  it('blocks publishing an invalid tag and says why', async () => {
    const { el, type, button } = await render();
    await type('#release-c1-tag', 'latest');
    expect(el.textContent).toContain('Use a version tag such as v1.2.0.');
    expect(button('Review and publish').disabled).toBe(true);
  });

  it('asks for a rewrite with the fields the user changed', async () => {
    const { events, type, button } = await render();
    await type('#release-c1-name', 'Sign in with GitHub');
    button('Ask agent to rewrite').click();
    expect(events[0]).toMatchObject({ name: 'rewrite', payload: { changed: ['name'] } });
  });
});

describe('release helpers', () => {
  it('suggests the next minor version', () => {
    expect(nextMinor('v1.0.0')).toBe('v1.1.0');
    expect(nextMinor('2.9.4')).toBe('2.10.0');
    expect(nextMinor(null)).toBe('v0.1.0');
  });

  it('asks the agent to keep exactly the values the user set', () => {
    const edits = { tag: 'v1.1.0', name: 'Sign in with GitHub', prerelease: false, sections: { features: [], fixes: [], breaking: [] } };
    expect(rewritePrompt(edits, ['name'])).toBe('Rewrite the release draft for v1.1.0. Keep exactly what I set: name "Sign in with GitHub".');
    expect(rewritePrompt(edits, [])).toBe('Rewrite the release draft with clearer wording.');
    expect(rewritePrompt({ tag: 'nope' }, ['tag'])).toBe('Rewrite the release draft with clearer wording.');
  });
});
