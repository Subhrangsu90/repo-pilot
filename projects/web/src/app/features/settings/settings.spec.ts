import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Settings } from './settings';

const profile = (over: { access?: object; activity?: object | null; user?: object } = {}) => ({
  user: {
    login: 'octocat',
    name: 'The Octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/583231',
    url: 'https://github.com/octocat',
    company: '@github',
    location: 'San Francisco',
    bio: null,
    publicRepos: 8,
    privateRepos: 2,
    createdAt: '2011-01-25T18:44:36Z',
    ...over.user,
  },
  access: { mode: 'oauth', scopes: ['repo'], requestedScope: 'repo', manageUrl: 'https://github.com/settings/connections/applications/abc', ...over.access },
  activity: over.activity === undefined ? { sessions: 12, waiting: 1, changes: 4, undone: 2 } : over.activity,
});

async function render(body: object) {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(Settings);
  fixture.detectChanges();
  http.expectOne('/api/profile').flush(body);
  // Requests other parts of the app make (health for the model default, the repo list): answer them empty.
  for (const r of http.match(() => true)) {
    r.flush(r.request.url === '/api/repos' ? { items: [] } : { ok: true, llm: { provider: 'gemini', model: 'x' }, github: { tokenConfigured: true } });
  }
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('Settings page', () => {
  it('shows the GitHub profile, the access granted and the activity counts', async () => {
    const el = await render(profile());
    expect(el.querySelector('#profile-title')?.textContent).toContain('The Octocat');
    expect(el.textContent).toContain('@octocat');
    expect(el.textContent).toContain('8 public · 2 private repositories');
    expect(el.textContent).toContain('public and private repositories');
    expect([...el.querySelectorAll('.badge')].map((b) => b.textContent?.trim())).toContain('repo');
    expect(el.querySelector('a[href="https://github.com/settings/connections/applications/abc"]')).not.toBeNull();
    expect([...el.querySelectorAll('dd')].map((d) => d.textContent?.trim())).toEqual(['12', '1', '4', '2']);
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Sign out')).toBe(true);
  });

  it('asks to sign in again when the sign-in has less access than the server now asks for', async () => {
    const el = await render(profile({ access: { scopes: ['public_repo'], requestedScope: 'repo' } }));
    expect(el.textContent).toContain('public repositories only');
    expect(el.querySelector('[role=status]')?.textContent).toContain('Sign out and sign in again');
  });

  it('explains dev mode, without Sign out', async () => {
    const el = await render(profile({ access: { mode: 'token', scopes: null, requestedScope: null, manageUrl: 'https://github.com/settings/personal-access-tokens' } }));
    expect(el.textContent).toContain('Dev mode');
    expect(el.textContent).toContain('Manage tokens on GitHub');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Sign out')).toBe(false);
  });

  it('says when History and the Audit log are off, and never renders unsafe links or images', async () => {
    const el = await render(profile({ activity: null, user: { avatarUrl: 'https://evil.example/x.png', url: 'javascript:alert(1)' } }));
    expect(el.textContent).toContain('need the database');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('a[href^="javascript"]')).toBeNull();
  });
});
