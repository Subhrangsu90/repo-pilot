import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Auth } from '../../core/auth';
import { Theme } from '../../core/theme';
import { Icon } from '../../shared/ui/icon';
import { Logo } from '../../shared/ui/logo';

/** `?error=` from the server's OAuth callback, or from the app when a session ends. */
const PROBLEMS: Record<string, string> = {
  denied: 'Sign-in was cancelled on GitHub. Nothing was shared.',
  state: 'The sign-in link expired or did not match. Please sign in again.',
  exchange: 'GitHub did not complete the sign-in. Please try again in a moment.',
  expired: 'Your session ended. Sign in again to continue where you were.',
};

/**
 * The sign-in page (/signin), outside the app layout. "Sign in with GitHub"
 * goes to the server, which sends the user to GitHub and back to `next`. The
 * GitHub token never reaches this page. It also covers: already signed in,
 * just signed out, a failed sign-in, and dev mode (no OAuth app configured).
 */
@Component({
  selector: 'app-sign-in',
  imports: [RouterLink, Logo, Icon],
  host: { class: 'flex min-h-dvh flex-col bg-bg' },
  template: `
    <header class="mx-auto flex w-full max-w-[1120px] items-center justify-between gap-4 px-4 py-6 sm:px-8">
      <a routerLink="/" class="rounded-sm px-1 py-1" aria-label="RepoPilot home"><app-logo /></a>
      <button type="button" class="btn btn-ghost px-3" (click)="theme.toggle()">
        <app-icon [name]="theme.current() === 'graphite' ? 'sun' : 'moon'" />
        {{ theme.current() === 'graphite' ? 'Light theme' : 'Graphite theme' }}
      </button>
    </header>

    <main id="main" class="mx-auto flex w-full max-w-[460px] flex-1 flex-col gap-5 px-4 pt-6 pb-16 sm:pt-14">
      @if (!auth.loaded()) {
        <div class="h-72 animate-pulse rounded-xl bg-surface-3" aria-hidden="true"></div>
      } @else if (!auth.me()) {
        <section class="card flex flex-col gap-4 p-6" role="alert">
          <h1 class="font-display text-h1">Can't reach RepoPilot</h1>
          <p class="text-body text-fg-muted">The RepoPilot server did not answer. Check that it is running, then try again.</p>
          <button type="button" class="btn self-start" (click)="auth.load(true)">Try again</button>
        </section>
      } @else if (auth.mode() === 'token') {
        <section class="card flex flex-col gap-4 p-6" aria-labelledby="signin-title">
          <h1 id="signin-title" class="font-display text-h1">No sign-in needed</h1>
          <p class="text-body text-fg-muted">
            This server runs in dev mode: GitHub sign-in is not configured, so RepoPilot acts as the owner of its access token
            @if (auth.user(); as u) {
              (<span class="font-mono text-fg">{{ u.login }}</span>)
            }.
          </p>
          <a class="btn btn-primary self-start" [href]="target()">Continue to RepoPilot</a>
        </section>
      } @else if (auth.user(); as u) {
        <section class="card flex flex-col gap-4 p-6" aria-labelledby="signin-title">
          <h1 id="signin-title" class="font-display text-h1">You're signed in</h1>
          <p class="text-body text-fg-muted">
            Signed in with GitHub as <span class="font-mono text-fg">{{ u.login }}</span>.
          </p>
          <div class="flex flex-wrap gap-2.5">
            <a class="btn btn-primary" [href]="target()">Continue to RepoPilot</a>
            <button type="button" class="btn btn-ghost" (click)="auth.signOut()">Sign out</button>
          </div>
        </section>
      } @else {
        @if (problem(); as p) {
          <p class="card border-danger px-4 py-3 text-body-sm" role="alert">{{ p }}</p>
        } @else if (signedOut()) {
          <p class="rounded-md border border-border bg-surface-1 px-4 py-3 text-body-sm text-fg-muted" role="status">You signed out.</p>
        }

        <section class="card flex flex-col gap-5 p-6" aria-labelledby="signin-title">
          <div class="flex flex-col gap-2">
            <h1 id="signin-title" class="font-display text-h1">Sign in to RepoPilot</h1>
            <p class="text-body text-fg-muted">Manage your GitHub repositories in plain English, with your own GitHub account.</p>
          </div>

          <a class="btn btn-primary justify-center" [href]="auth.signInHref(target())">Sign in with GitHub</a>

          <ul class="flex flex-col gap-3 border-t border-border pt-5 text-body-sm text-fg-muted">
            <li class="flex gap-2.5">
              <app-icon name="check" [size]="16" class="mt-0.5 text-fg" />
              <span>GitHub asks you to allow access to <span class="text-fg">public repositories</span>. You can revoke it any time in your GitHub settings.</span>
            </li>
            <li class="flex gap-2.5">
              <app-icon name="check" [size]="16" class="mt-0.5 text-fg" />
              <span>Your access token stays on the RepoPilot server in an encrypted cookie. This page and the AI model never see it.</span>
            </li>
            <li class="flex gap-2.5">
              <app-icon name="check" [size]="16" class="mt-0.5 text-fg" />
              <span>Nothing changes on GitHub until you approve it, and approved changes can be undone from the Audit log.</span>
            </li>
          </ul>
        </section>
      }
    </main>
  `,
})
export class SignIn {
  /** Query params: where to return after signing in, and why the user is here. */
  readonly next = input<string>();
  readonly error = input<string>();
  readonly signedOut = input<string>();

  protected readonly auth = inject(Auth);
  protected readonly theme = inject(Theme);

  /** In-app paths only; the server checks this again. */
  protected readonly target = computed(() => {
    const n = this.next();
    return n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/signin') && !n.startsWith('/api/') ? n : '/ask';
  });
  protected readonly problem = computed(() => PROBLEMS[this.error() ?? ''] ?? null);

  constructor() {
    void this.auth.load();
  }
}
