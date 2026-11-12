import Fastify from 'fastify';
import { afterEach, vi } from 'vitest';
import type { GitHub } from '../github/client';
import { createAuth, safeNext } from './index';
import { cookie, readCookie, seal, unseal } from './seal';

const SECRET = 'x'.repeat(40);

describe('sealed cookies', () => {
  it('round-trips, and rejects tampering, another secret and expiry', () => {
    const sealed = seal({ token: 'gho_abc', login: 'octocat' }, SECRET, 60_000);
    expect(sealed).not.toContain('gho_abc');
    expect(unseal(sealed, SECRET)).toEqual({ token: 'gho_abc', login: 'octocat' });

    const flipped = sealed.slice(0, -2) + (sealed.at(-2) === 'A' ? 'B' : 'A') + sealed.at(-1);
    expect(unseal(flipped, SECRET)).toBeNull();
    expect(unseal(sealed, 'y'.repeat(40))).toBeNull();
    expect(unseal(seal({ a: 1 }, SECRET, -1), SECRET)).toBeNull();
    expect(unseal(undefined, SECRET)).toBeNull();
    expect(unseal('garbage', SECRET)).toBeNull();
  });

  it('reads cookies and writes httpOnly, SameSite=Lax ones (Secure on https)', () => {
    expect(readCookie('a=1; rp_session=abc%3D; b=2', 'rp_session')).toBe('abc=');
    expect(readCookie(undefined, 'x')).toBeUndefined();
    expect(cookie('rp_session', 'v', { maxAgeSec: 60, secure: true })).toBe('rp_session=v; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure');
    expect(cookie('rp_session', '', { maxAgeSec: 0, secure: false })).toBe('rp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  });
});

function app(oauth: boolean) {
  const tokenGithub = { login: async () => 'token-owner' } as unknown as GitHub;
  const auth = createAuth({
    clientId: oauth ? 'client-id' : undefined,
    clientSecret: oauth ? 'client-secret' : undefined,
    sessionSecret: oauth ? SECRET : undefined,
    appUrl: 'http://localhost:4200',
    scope: 'public_repo',
    tokenGithub,
  });
  const server = Fastify();
  auth.register(server);
  server.get('/api/whoami', async (req) => ({ login: auth.userOf(req).login }));
  server.get('/api/health', async () => ({ ok: true }));
  return { server, auth };
}

describe('auth (dev mode: no OAuth app configured)', () => {
  it('acts as the GITHUB_TOKEN owner without signing in', async () => {
    const { server, auth } = app(false);
    expect(auth.mode).toBe('token');
    expect((await server.inject('/api/whoami')).json()).toEqual({ login: 'token-owner' });
    expect((await server.inject('/api/auth/me')).json()).toEqual({ mode: 'token', user: { login: 'token-owner' }, signIn: null });
  });
});

describe('auth (OAuth mode)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('needs a session for the API, but not for health or the auth routes', async () => {
    const { server } = app(true);
    const res = await server.inject('/api/whoami');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ signIn: '/api/auth/login' });
    expect((await server.inject('/api/health')).statusCode).toBe(200);
    expect((await server.inject('/api/auth/me')).json()).toEqual({ mode: 'oauth', user: null, signIn: '/api/auth/login' });
  });

  it('sends the user to GitHub with a state that the callback checks', async () => {
    const { server } = app(true);
    const login = await server.inject('/api/auth/login');
    expect(login.statusCode).toBe(302);
    const to = new URL(login.headers.location as string);
    expect(to.origin + to.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(to.searchParams.get('client_id')).toBe('client-id');
    expect(to.searchParams.get('redirect_uri')).toBe('http://localhost:4200/api/auth/callback');
    expect(to.searchParams.get('scope')).toBe('public_repo');
    const stateCookie = String(login.headers['set-cookie']).split(';')[0];

    // A forged or missing state is refused without calling GitHub.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const forged = await server.inject({ url: '/api/auth/callback?code=c&state=forged', headers: { cookie: stateCookie } });
    expect(forged.headers.location).toBe('/signin?error=state');
    const noCookie = await server.inject(`/api/auth/callback?code=c&state=${to.searchParams.get('state')}`);
    expect(noCookie.headers.location).toBe('/signin?error=state');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('swaps the code for a token, keeps it only in a sealed cookie, and acts as that user', async () => {
    const { server } = app(true);
    const login = await server.inject('/api/auth/login?next=/issues%3Fstate%3Dclosed');
    const state = new URL(login.headers.location as string).searchParams.get('state')!;
    const stateCookie = String(login.headers['set-cookie']).split(';')[0];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).startsWith('https://github.com/login/oauth/access_token')
          ? new Response(JSON.stringify({ access_token: 'gho_secret' }), { status: 200 })
          : new Response(JSON.stringify({ login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/1' }), { status: 200 }),
      ),
    );
    const done = await server.inject({ url: `/api/auth/callback?code=the-code&state=${state}`, headers: { cookie: stateCookie } });
    expect(done.statusCode).toBe(302);
    // Back to the page the user was sent away from.
    expect(done.headers.location).toBe('/issues?state=closed');
    const cookies = ([] as string[]).concat(done.headers['set-cookie'] as string[]);
    const session = cookies.find((c) => c.startsWith('rp_session='))!;
    expect(session).toContain('HttpOnly');
    expect(session).not.toContain('gho_secret');

    const jar = session.split(';')[0];
    expect((await server.inject({ url: '/api/whoami', headers: { cookie: jar } })).json()).toEqual({ login: 'octocat' });
    expect((await server.inject({ url: '/api/auth/me', headers: { cookie: jar } })).json()).toMatchObject({ user: { login: 'octocat' } });

    const out = await server.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: jar } });
    expect(String(out.headers['set-cookie'])).toContain('rp_session=; Path=/; Max-Age=0');
  });
});

describe('safeNext (where to return after signing in)', () => {
  it('keeps in-app paths and refuses other sites, the API and the sign-in page itself', () => {
    expect(safeNext('/issues?state=closed')).toBe('/issues?state=closed');
    expect(safeNext('/pulls/15')).toBe('/pulls/15');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'ask', '/api/auth/logout', '/signin', '/a\r\nSet-Cookie: x', undefined, 42, `/${'x'.repeat(400)}`]) {
      expect(safeNext(bad)).toBe('/ask');
    }
  });

  it('dev mode sends /api/auth/login straight to the app page', async () => {
    const { server } = app(false);
    const res = await server.inject('/api/auth/login?next=/history');
    expect(res.headers.location).toBe('/history');
  });
});
