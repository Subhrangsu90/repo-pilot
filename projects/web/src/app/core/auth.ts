import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { firstValueFrom, tap } from 'rxjs';

/** GET /api/auth/me */
export interface Me {
  mode: 'oauth' | 'token';
  user: { login: string; avatarUrl?: string } | null;
  signIn: string | null;
}

/**
 * Who is signed in (doc §10 "Auth"). The GitHub token stays on the server in a
 * sealed httpOnly cookie; the app only learns the login. In dev mode (no OAuth
 * app configured) the server acts as the GITHUB_TOKEN owner and nobody signs in.
 * The sign-in page is /signin; `requireSignIn` sends signed-out visitors there.
 */
@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly http = inject(HttpClient);
  private loading?: Promise<Me | null>;

  /** null until loaded, or when the server could not be reached. */
  readonly me = signal<Me | null>(null);
  readonly loaded = signal(false);
  /** Set when any API call answered 401 (signed out, or the session expired). */
  readonly expired = signal(false);

  readonly mode = computed(() => this.me()?.mode ?? null);
  readonly user = computed(() => (this.expired() ? null : (this.me()?.user ?? null)));
  /** OAuth is on and nobody is signed in. */
  readonly needsSignIn = computed(() => this.mode() === 'oauth' && !this.user());

  /** Loads /api/auth/me once (again with `force`). Resolves null when the server cannot be reached. */
  load(force = false): Promise<Me | null> {
    if (!this.loading || force) {
      this.loading = firstValueFrom(this.http.get<Me>('/api/auth/me'))
        .then((me) => {
          this.me.set(me);
          if (me.user) this.expired.set(false);
          return me;
        })
        .catch(() => {
          this.me.set(null);
          return null;
        })
        .finally(() => this.loaded.set(true));
    }
    return this.loading;
  }

  /** The server route that starts "Sign in with GitHub" and returns to `next` afterwards. */
  signInHref(next?: string | null): string {
    return next ? `/api/auth/login?next=${encodeURIComponent(next)}` : '/api/auth/login';
  }

  async signOut(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}));
    } finally {
      location.assign('/signin?signedOut=1');
    }
  }
}

/** The app pages: OAuth mode needs a signed-in user, otherwise off to /signin (and back afterwards). */
export const requireSignIn: CanActivateFn = async (_route, state) => {
  const auth = inject(Auth);
  const router = inject(Router);
  const me = await auth.load();
  if (me?.mode === 'oauth' && !me.user) return router.createUrlTree(['/signin'], { queryParams: { next: state.url } });
  return true;
};

/** Any 401 from the API means the session is gone: to /signin, returning to this page afterwards. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(Auth);
  const router = inject(Router);
  return next(req).pipe(
    tap({
      error: (err: unknown) => {
        if (!(err instanceof HttpErrorResponse) || err.status !== 401 || !req.url.startsWith('/api/') || req.url.startsWith('/api/auth/')) return;
        auth.expired.set(true);
        const here = router.url;
        if (!here.startsWith('/signin')) void router.navigate(['/signin'], { queryParams: { error: 'expired', next: here } });
      },
    }),
  );
};
