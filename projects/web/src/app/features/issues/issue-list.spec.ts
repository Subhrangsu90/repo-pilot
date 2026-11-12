import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideGenUi } from '../../genui/registry';
import { bulkPrompt, IssueList, issueRefs } from './issue-list';

const row = (number: number, title: string, labels: string[], state: 'open' | 'closed' = 'open') => ({
  number,
  title,
  state,
  labels,
  assignees: [],
  ageDays: 3,
});

describe('issue prompts', () => {
  it('lists the numbers the way a person writes them', () => {
    expect(issueRefs([9])).toBe('#9');
    expect(issueRefs([9, 10, 11])).toBe('#9, #10 and #11');
    expect(bulkPrompt('close', [9, 10])).toBe('Close issues #9 and #10 as not planned');
    expect(bulkPrompt('reopen', [13])).toBe('Reopen issue #13');
  });
});

describe('IssueList', () => {
  async function render() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideGenUi()] });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(IssueList);
    fixture.detectChanges();
    // The repository picker's list: the page works on the selected repo.
    http.expectOne('/api/repos').flush({ items: [{ full: 'octo/demo', private: true, description: null, pushedAt: null, canWrite: true }] });
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
    // The app chrome's requests (ServerStatus), so the page can become stable.
    for (const r of http.match((r) => r.url === '/api/health' || r.url === '/api/overview')) {
      r.flush(
        r.request.url === '/api/health'
          ? { ok: true, llm: { provider: 'ollama', model: 'gemma', configured: { gemini: false, claude: false, ollama: true } }, github: { tokenConfigured: true }, catalog: [] }
          : { repo: 'octo/demo', openPullRequests: 0, openIssues: 3, rateLimit: { limit: 5000, remaining: 5000 } },
      );
    }
    http.expectOne((r) => r.url === '/api/issues' && r.params.get('state') === 'open' && r.params.get('repo') === 'octo/demo').flush({
      repo: 'octo/demo',
      truncated: false,
      rows: [row(8, 'How do I reset my password?', ['question']), row(9, 'Support IE11', ['wontfix']), row(10, 'Bazel', ['wontfix'])],
    });
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text));
    const rows = () => [...el.querySelectorAll('tbody tr')];
    return { fixture, http, el, button, rows };
  }

  it('filters by label and asks the agent to close the ticked issues, which waits for an approval card', async () => {
    const { fixture, http, el, button, rows } = await render();
    expect(rows()).toHaveLength(3);

    button('wontfix')!.click();
    await fixture.whenStable();
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('#9'), expect.stringContaining('#10')]);

    // No action bar until something is ticked.
    expect(el.querySelector('[aria-label="Selected issues"]')).toBeNull();
    el.querySelector<HTMLInputElement>('input[aria-label="Select all issues"]')!.click();
    await fixture.whenStable();
    expect(el.querySelector('[aria-label="Selected issues"]')?.textContent).toContain('2 selected');
    // Nothing ticked is closed, so there is nothing to reopen.
    expect(button('Reopen')!.disabled).toBe(true);

    button('Close 2')!.click();
    const run = http.expectOne('/api/runs');
    expect(run.request.method).toBe('POST');
    // The run carries the selected repository; the agent works on that one only.
    expect(run.request.body).toMatchObject({ prompt: 'Close issues #9 and #10 as not planned', repo: 'octo/demo' });
  });

  it('clears the label filter and the ticks when the state changes', async () => {
    const { fixture, http, el, button } = await render();
    button('wontfix')!.click();
    await fixture.whenStable();
    el.querySelector<HTMLInputElement>('input[aria-label="Select issue #9"]')!.click();
    await fixture.whenStable();
    expect(el.querySelector('[aria-label="Selected issues"]')).not.toBeNull();

    button('Closed')!.click();
    fixture.detectChanges();
    http.expectOne((r) => r.params.get('state') === 'closed' && r.params.get('repo') === 'octo/demo').flush({ repo: 'octo/demo', truncated: false, rows: [row(13, 'Native app', ['wontfix'], 'closed')] });
    await fixture.whenStable();
    expect(button('wontfix')!.getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('[aria-label="Selected issues"]')).toBeNull();
  });
});
