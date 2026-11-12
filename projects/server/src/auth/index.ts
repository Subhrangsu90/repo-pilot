import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GitHub } from '../github/client';
import { cookie, readCookie, seal, unseal } from './seal';

/**
 * Who is asking (doc §10 "Auth").
 *
 * - oauth: "Sign in with GitHub". The server swaps the OAuth code for a token and
 *   keeps it in a sealed, httpOnly cookie; the browser never sees the token.
 *   Every request acts with the signed-in user's own token, and sees only their
 *   own sessions, runs and audit entries.
 * - token (dev): no OAuth app configured; everything acts as the owner of
 *   GITHUB_TOKEN, as before week 4.
 */

export interface User {
  login: string;
  avatarUrl?: string;
  /** GitHub client acting as this user. */
  github: GitHub;
}

export interface AuthOptions {
  clientId?: string;
  clientSecret?: string;
  sessionSecret?: string;
  /** Where the app is served (the OAuth callback is APP_URL/api/auth/callback). */
  appUrl: string;
  scope: string;
  /** The GitHub client for token mode (GITHUB_TOKEN). */
  tokenGithub: GitHub;
}

/** What the login step remembers until GitHub sends the user back. */
interface PendingSignIn {
  state: string;
  next: string;
}

interface SessionData {
  token: string;
  login: string;
  avatarUrl?: string;
}

const SESSION_COOKIE = 'rp_session';
const STATE_COOKIE = 'rp_oauth_state';
const SESSION_TTL_MS = 8 * 60 * 60_000;
const STATE_TTL_MS = 10 * 60_000;
/** Paths that work without signing in. */
const PUBLIC = /^\/api\/(auth\/|health$)/;

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(opts: AuthOptions) {
  const mode: 'oauth' | 'token' = opts.clientId && opts.clientSecret && opts.sessionSecret ? 'oauth' : 'token';
  const secure = opts.appUrl.startsWith('https://');
  const secret = opts.sessionSecret ?? '';
  const users = new WeakMap<FastifyRequest, User>();
  /** One client per token, so its cached login is reused across requests. */
  const clients = new Map<string, GitHub>();

  const clientFor = (token: string) => {
    let gh = clients.get(token);
    if (!gh) {
      if (clients.size > 500) clients.clear();
      gh = new GitHub(token);
      clients.set(token, gh);
    }
    return gh;
  };

  async function identify(req: FastifyRequest): Promise<User | null> {
    if (mode === 'token') return { login: await opts.tokenGithub.login(), github: opts.tokenGithub };
    const session = unseal<SessionData>(readCookie(req.headers.cookie, SESSION_COOKIE), secret);
    return session ? { login: session.login, avatarUrl: session.avatarUrl, github: clientFor(session.token) } : null;
  }

  function register(app: FastifyInstance) {
    // Every API request gets its user; with OAuth, anything but the public paths needs one.
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0];
      if (!path.startsWith('/api/') || (PUBLIC.test(path) && path !== '/api/auth/me')) return;
      let user: User | null = null;
      try {
        user = await identify(req);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'could not identify the user');
      }
      if (user) users.set(req, user);
      else if (path !== '/api/auth/me') return reply.code(401).send({ error: 'Sign in with GitHub to continue.', signIn: '/api/auth/login' });
    });

    app.get('/api/auth/me', async (req) => {
      const user = users.get(req);
      return { mode, user: user ? { login: user.login, avatarUrl: user.avatarUrl } : null, signIn: mode === 'oauth' ? '/api/auth/login' : null };
    });

    app.get<{ Querystring: { next?: string } }>('/api/auth/login', async (req, reply) => {
      const next = safeNext(req.query.next);
      if (mode !== 'oauth') return reply.redirect(next);
      const state = randomBytes(24).toString('base64url');
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', opts.clientId!);
      url.searchParams.set('redirect_uri', `${opts.appUrl}/api/auth/callback`);
      url.searchParams.set('scope', opts.scope);
      url.searchParams.set('state', state);
      url.searchParams.set('allow_signup', 'false');
      // The state (CSRF check) and where to return travel together in a sealed, short-lived cookie.
      const pending: PendingSignIn = { state, next };
      reply.header('set-cookie', cookie(STATE_COOKIE, seal(pending, secret, STATE_TTL_MS), { maxAgeSec: STATE_TTL_MS / 1000, secure, path: '/api/auth' }));
      return reply.redirect(url.toString());
    });

    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/auth/callback', async (req, reply) => {
      if (mode !== 'oauth') return reply.redirect('/ask');
      const clearState = cookie(STATE_COOKIE, '', { maxAgeSec: 0, secure, path: '/api/auth' });
      const expected = unseal<PendingSignIn>(readCookie(req.headers.cookie, STATE_COOKIE), secret);
      const { code, state, error } = req.query;
      if (error || !code || !state || !expected || !sameString(state, expected.state)) {
        reply.header('set-cookie', clearState);
        return failed(reply, error === 'access_denied' ? 'denied' : 'state');
      }
      try {
        const token = await exchangeCode(opts, code);
        const gh = clientFor(token);
        const me = await gh.rest<{ login: string; avatar_url?: string }>('/user');
        const session: SessionData = { token, login: me.login, avatarUrl: me.avatar_url };
        reply.header('set-cookie', [clearState, cookie(SESSION_COOKIE, seal(session, secret, SESSION_TTL_MS), { maxAgeSec: SESSION_TTL_MS / 1000, secure })]);
        req.log.info({ login: me.login }, 'signed in with GitHub');
        return reply.redirect(safeNext(expected.next));
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'GitHub sign-in failed');
        reply.header('set-cookie', clearState);
        return failed(reply, 'exchange');
      }
    });

    app.post('/api/auth/logout', async (_req, reply) => {
      reply.header('set-cookie', cookie(SESSION_COOKIE, '', { maxAgeSec: 0, secure }));
      return { ok: true };
    });
  }

  /** The user of a request that passed the hook. */
  function userOf(req: FastifyRequest): User {
    const user = users.get(req);
    if (!user) throw new Error('No user on this request (is the auth hook registered?)');
    return user;
  }

  return { mode, register, userOf, identify };
}

/** Back to the sign-in page, which explains what went wrong. */
function failed(reply: FastifyReply, reason: 'denied' | 'state' | 'exchange') {
  return reply.redirect(`/signin?error=${reason}`);
}

/**
 * Where to go after signing in: an in-app path only ("/issues?state=closed"), never
 * another site ("//evil.example", "https://…") or the API. Defaults to /ask.
 */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || next.length > 300) return '/ask';
  // One leading slash, not "//" or "/\" (both mean another host to a browser); no line breaks.
  if (!/^\/(?![/\\])/.test(next) || /[\r\n]/.test(next) || next.startsWith('/api/') || next.startsWith('/signin')) return '/ask';
  return next;
}

function sameString(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The OAuth code → access token exchange (server to server; the secret never leaves here). */
async function exchangeCode(opts: AuthOptions, code: string): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'repopilot' },
    body: JSON.stringify({ client_id: opts.clientId, client_secret: opts.clientSecret, code, redirect_uri: `${opts.appUrl}/api/auth/callback` }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`token exchange failed: ${body.error ?? `HTTP ${res.status}`}`);
  return body.access_token;
}
