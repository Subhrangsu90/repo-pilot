import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Me } from '../../core/auth';
import { SignIn } from './sign-in';

async function render(me: Me | 'down', inputs: Record<string, string> = {}) {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(SignIn);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  fixture.detectChanges();
  const req = http.expectOne('/api/auth/me');
  if (me === 'down') req.flush('down', { status: 502, statusText: 'Bad Gateway' });
  else req.flush(me);
  // Auth.load() settles a few microtasks after the response.
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

const oauth = (user: Me['user'] = null): Me => ({ mode: 'oauth', user, signIn: '/api/auth/login' });
const link = (el: HTMLElement, name: string) => [...el.querySelectorAll('a')].find((a) => a.textContent?.trim() === name);

describe('SignIn page', () => {
  it('offers "Sign in with GitHub", returning to the page the user wanted', async () => {
    const el = await render(oauth(), { next: '/issues?state=closed' });
    expect(el.querySelector('h1')?.textContent).toContain('Sign in to RepoPilot');
    expect(link(el, 'Sign in with GitHub')?.getAttribute('href')).toBe('/api/auth/login?next=%2Fissues%3Fstate%3Dclosed');
    expect(el.textContent).toContain('never see it');
  });

  it('never sends the user to another site afterwards', async () => {
    const el = await render(oauth(), { next: '//evil.example' });
    expect(link(el, 'Sign in with GitHub')?.getAttribute('href')).toBe('/api/auth/login?next=%2Fask');
  });

  it('explains a failed or expired sign-in, and a sign-out', async () => {
    expect((await render(oauth(), { error: 'denied' })).querySelector('[role=alert]')?.textContent).toContain('cancelled on GitHub');
    TestBed.resetTestingModule();
    expect((await render(oauth(), { error: 'expired' })).querySelector('[role=alert]')?.textContent).toContain('Your session ended');
    TestBed.resetTestingModule();
    expect((await render(oauth(), { signedOut: '1' })).querySelector('[role=status]')?.textContent).toContain('You signed out');
  });

  it('shows who is signed in, with Continue and Sign out', async () => {
    const el = await render(oauth({ login: 'octocat' }), { next: '/history' });
    expect(el.querySelector('h1')?.textContent).toContain("You're signed in");
    expect(el.textContent).toContain('octocat');
    expect(link(el, 'Continue to RepoPilot')?.getAttribute('href')).toBe('/history');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Sign out')).toBe(true);
  });

  it('needs no sign-in in dev mode', async () => {
    const el = await render({ mode: 'token', user: { login: 'octocat' }, signIn: null });
    expect(el.querySelector('h1')?.textContent).toContain('No sign-in needed');
    expect(link(el, 'Sign in with GitHub')).toBeUndefined();
    expect(link(el, 'Continue to RepoPilot')?.getAttribute('href')).toBe('/ask');
  });

  it('says so when the server cannot be reached', async () => {
    const el = await render('down');
    expect(el.querySelector('[role=alert]')?.textContent).toContain("Can't reach RepoPilot");
  });
});
