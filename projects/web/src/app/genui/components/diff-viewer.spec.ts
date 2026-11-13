import { TestBed } from '@angular/core/testing';
import type { PropsOf } from '@repopilot/shared';
import { ClientTools } from '../../core/client-tools';
import { DiffViewer } from './diff-viewer';

const props: PropsOf<'DiffViewer'> = {
  path: 'src/auth/login.js',
  lines: [
    { kind: 'hunk', text: '@@ -10,3 +10,4 @@' },
    { kind: 'ctx', old: 10, new: 10, text: 'const attempts = new Map();' },
    { kind: 'del', old: 11, text: 'const key = email;' },
    { kind: 'add', new: 11, text: 'const key = email.toLowerCase();' },
    { kind: 'add', new: 12, text: 'if (count > 5) block();' },
    { kind: 'ctx', old: 12, new: 13, text: 'return ok;' },
  ],
  comments: [],
};

describe('DiffViewer highlight_lines', () => {
  async function render() {
    const fixture = TestBed.createComponent(DiffViewer);
    fixture.componentRef.setInput('props', props);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement, tools: TestBed.inject(ClientTools) };
  }

  it('highlights the requested new-file lines of its own file and claims the request', async () => {
    const { fixture, el, tools } = await render();
    const seq = tools.requestHighlight('./src/auth/login.js', 11, 12);
    await fixture.whenStable();

    const lit = [...el.querySelectorAll('[data-highlighted]')].map((l) => l.textContent?.replace(/\s+/g, ' ').trim());
    expect(lit).toHaveLength(2);
    expect(lit[0]).toContain('email.toLowerCase()');
    expect(lit[1]).toContain('count > 5');
    expect(el.querySelector('[data-highlighted] .sr-only')?.textContent).toContain('Highlighted by the agent');

    tools.checkMissed(seq);
    expect(tools.missed()).toBeNull();
  });

  it('ignores other files and lines outside the diff, which then count as missed', async () => {
    const { fixture, el, tools } = await render();
    let seq = tools.requestHighlight('src/notes/notes.js', 11, 12);
    await fixture.whenStable();
    expect(el.querySelectorAll('[data-highlighted]')).toHaveLength(0);
    tools.checkMissed(seq);
    expect(tools.missed()).toMatchObject({ path: 'src/notes/notes.js' });

    seq = tools.requestHighlight('src/auth/login.js', 40, 45);
    await fixture.whenStable();
    expect(el.querySelectorAll('[data-highlighted]')).toHaveLength(0);
    tools.checkMissed(seq);
    expect(tools.missed()).toMatchObject({ from: 40 });
  });
});
