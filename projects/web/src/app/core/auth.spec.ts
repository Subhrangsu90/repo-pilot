import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Auth, authInterceptor, requireSignIn } from './auth';

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting(), provideRouter([])],
  });
  return { auth: TestBed.inject(Auth), http: TestBed.inject(HttpTestingController), client: TestBed.inject(HttpClient), router: TestBed.inject(Router) };
}

const guard = (url: string) =>
  TestBed.runInInjectionContext(() => requireSignIn({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot)) as Promise<boolean | UrlTree>;

describe('Auth', () => {
  it('loads who is signed in once, and asks for sign-in only in OAuth mode without a user', async () => {
    const { auth, http } = setup();
    const first = auth.load();
    const again = auth.load();
    http.expectOne('/api/auth/me').flush({ mode: 'oauth', user: null, signIn: '/api/auth/login' });
    expect(await first).toEqual(await again);
    expect(auth.needsSignIn()).toBe(true);
    expect(auth.signInHref('/issues?state=closed')).toBe('/api/auth/login?next=%2Fissues%3Fstate%3Dclosed');
  });

  it('never asks in dev mode (the server acts as the GITHUB_TOKEN owner)', async () => {
    const { auth, http } = setup();
    const loaded = auth.load();
    http.expectOne('/api/auth/me').flush({ mode: 'token', user: { login: 'octocat' }, signIn: null });
    await loaded;
    expect(auth.needsSignIn()).toBe(false);
    expect(auth.user()).toEqual({ login: 'octocat' });
  });

  it('resolves null when the server cannot be reached', async () => {
    const { auth, http } = setup();
    const loaded = auth.load();
    http.expectOne('/api/auth/me').flush('down', { status: 502, statusText: 'Bad Gateway' });
    expect(await loaded).toBeNull();
    expect(auth.loaded()).toBe(true);
  });
});

describe('requireSignIn', () => {
  it('sends signed-out visitors to /signin, remembering the page they wanted', async () => {
    const { http, router } = setup();
    const result = guard('/issues?state=closed');
    http.expectOne('/api/auth/me').flush({ mode: 'oauth', user: null, signIn: '/api/auth/login' });
    expect(router.serializeUrl((await result) as UrlTree)).toBe('/signin?next=%2Fissues%3Fstate%3Dclosed');
  });

  it('lets signed-in users and dev mode through', async () => {
    let s = setup();
    let result = guard('/ask');
    s.http.expectOne('/api/auth/me').flush({ mode: 'oauth', user: { login: 'octocat' }, signIn: '/api/auth/login' });
    expect(await result).toBe(true);

    TestBed.resetTestingModule();
    s = setup();
    result = guard('/ask');
    s.http.expectOne('/api/auth/me').flush({ mode: 'token', user: { login: 'octocat' }, signIn: null });
    expect(await result).toBe(true);
  });
});

describe('authInterceptor', () => {
  it('on a 401 marks the session expired and opens /signin, returning to this page afterwards', async () => {
    const { auth, http, client, router } = setup();
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    vi.spyOn(router, 'url', 'get').mockReturnValue('/history');

    const call = firstValueFrom(client.get('/api/sessions')).catch(() => 'failed');
    http.expectOne('/api/sessions').flush({ error: 'Sign in' }, { status: 401, statusText: 'Unauthorized' });
    expect(await call).toBe('failed');
    expect(auth.expired()).toBe(true);
    expect(navigate).toHaveBeenCalledWith(['/signin'], { queryParams: { error: 'expired', next: '/history' } });
  });

  it('ignores 401s from the auth routes themselves', async () => {
    const { auth, http, client, router } = setup();
    const navigate = vi.spyOn(router, 'navigate');
    const call = firstValueFrom(client.post('/api/auth/logout', {})).catch(() => 'failed');
    http.expectOne('/api/auth/logout').flush({}, { status: 401, statusText: 'Unauthorized' });
    await call;
    expect(auth.expired()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
