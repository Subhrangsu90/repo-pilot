import { httpResource } from '@angular/common/http';
import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { isGitHubAvatar, isGitHubUrl, type ModelOption } from '@repopilot/shared';
import { Auth } from '../../core/auth';
import { ModelChoice } from '../../core/model-choice';
import { ServerStatus } from '../../core/server-status';
import { valueOf } from '../../core/resource';
import { Theme } from '../../core/theme';
import { Icon } from '../../shared/ui/icon';
import { RepoPicker } from '../../shared/ui/repo-picker';

/** GET /api/profile */
interface Profile {
  user: {
    login: string;
    name: string | null;
    avatarUrl: string;
    url: string;
    company: string | null;
    location: string | null;
    bio: string | null;
    publicRepos: number;
    privateRepos: number | null;
    createdAt: string;
  };
  access: { mode: 'oauth' | 'token'; scopes: string[] | null; requestedScope: string | null; manageUrl: string };
  activity: { sessions: number; waiting: number; changes: number; undone: number } | null;
}


const THEMES = [
  { value: 'graphite', label: 'Graphite' },
  { value: 'light', label: 'Light' },
] as const;
const MODELS: { value: ModelOption; label: string; hint: string }[] = [
  { value: 'cloud', label: 'Cloud', hint: 'Gemini Flash: faster and more reliable with tools.' },
  { value: 'local', label: 'Local Gemma', hint: 'Runs on this machine through Ollama: nothing leaves it.' },
];

/**
 * Profile and settings: who you are on GitHub, how RepoPilot reaches GitHub for
 * you (and where to revoke it), your preferences, and what you have done here.
 * Preferences are kept in this browser.
 */
@Component({
  selector: 'app-settings',
  imports: [RouterLink, Icon, RepoPicker],
  host: { class: 'block' },
  template: `
    <div class="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-4 py-8 sm:px-8">
      <div class="flex flex-col gap-1.5">
        <h1 class="font-display text-h1">Profile &amp; settings</h1>
        <p class="text-body text-fg-muted">Your GitHub account, how RepoPilot reaches it, and your preferences.</p>
      </div>

      @if (profile.isLoading() && !profile.hasValue()) {
        <div class="h-40 animate-pulse rounded-xl bg-surface-3" aria-hidden="true"></div>
      } @else if (profile.error()) {
        <div class="card flex items-center justify-between gap-3 border-danger p-4" role="alert">
          <span class="text-body-sm">Could not load your GitHub profile.</span>
          <button type="button" class="btn" (click)="profile.reload()">Retry</button>
        </div>
      } @else if (data(); as p) {
        <!-- Profile -->
        <section class="card flex flex-wrap items-start gap-5 p-6" aria-labelledby="profile-title">
          @if (avatar(); as src) {
            <img [src]="src" alt="" width="72" height="72" class="size-18 shrink-0 rounded-full bg-surface-3" referrerpolicy="no-referrer" />
          }
          <div class="flex min-w-0 flex-[1_1_260px] flex-col gap-2">
            <div class="flex flex-col gap-0.5">
              <h2 id="profile-title" class="font-display text-h2">{{ p.user.name || p.user.login }}</h2>
              <span class="font-mono text-body-sm text-fg-muted">&#64;{{ p.user.login }}</span>
            </div>
            @if (p.user.bio) {
              <p class="text-body-md text-fg-muted">{{ p.user.bio }}</p>
            }
            <ul class="flex flex-wrap gap-x-4 gap-y-1 text-body-sm text-fg-muted">
              @if (p.user.company) {
                <li>{{ p.user.company }}</li>
              }
              @if (p.user.location) {
                <li>{{ p.user.location }}</li>
              }
              <li>On GitHub since {{ since(p.user.createdAt) }}</li>
              <li>
                {{ p.user.publicRepos }} public{{ p.user.privateRepos !== null ? ' · ' + p.user.privateRepos + ' private' : '' }} repositories
              </li>
            </ul>
          </div>
          @if (safe(p.user.url); as url) {
            <a class="btn shrink-0" [href]="url" target="_blank" rel="noopener noreferrer">
              View on GitHub<span class="sr-only"> (opens in a new tab)</span>
            </a>
          }
        </section>

        <!-- GitHub access -->
        <section class="card flex flex-col gap-4 p-6" aria-labelledby="access-title">
          <h2 id="access-title" class="text-body font-semibold">GitHub access</h2>
          @if (p.access.mode === 'oauth') {
            <p class="text-body-md">
              Signed in with GitHub. RepoPilot acts with your own account; your access token stays on the server in an
              encrypted cookie and never reaches this page or the AI model.
            </p>
            <div class="flex flex-wrap items-center gap-2 text-body-sm text-fg-muted">
              Access granted:
              @for (s of p.access.scopes ?? []; track s) {
                <span class="badge font-mono">{{ s }}</span>
              } @empty {
                <span class="badge">none</span>
              }
            </div>
            <p class="text-body-sm text-fg-muted">{{ reach() }}</p>
            @if (missingScope()) {
              <p class="rounded-md border border-border-strong px-4 py-3 text-body-sm" role="status">
                The server now asks for <span class="font-mono">{{ p.access.requestedScope }}</span>, but this sign-in
                has less. Sign out and sign in again to grant it.
              </p>
            }
          } @else {
            <p class="text-body-md">
              Dev mode: GitHub sign-in is not configured on this server, so RepoPilot acts as the owner of the server's
              access token (<span class="font-mono">{{ p.user.login }}</span>).
            </p>
          }
          @if (status.quota(); as q) {
            <p class="text-body-sm text-fg-muted">
              GitHub API requests left this hour: <span class="font-mono text-fg tabular-nums">{{ q.text }}</span>
            </p>
          }
          <p class="text-body-sm text-fg-muted">Every change still waits for your approval, and approved changes can be undone from the Audit log.</p>
          <div class="flex flex-wrap gap-2.5">
            @if (safe(p.access.manageUrl); as url) {
              <a class="btn" [href]="url" target="_blank" rel="noopener noreferrer">
                {{ p.access.mode === 'oauth' ? 'Manage access on GitHub' : 'Manage tokens on GitHub' }}<span class="sr-only"> (opens in a new tab)</span>
              </a>
            }
            @if (p.access.mode === 'oauth') {
              <button type="button" class="btn btn-ghost" (click)="auth.signOut()">Sign out</button>
            }
          </div>
        </section>
      }

      <!-- Preferences (work even if the profile did not load) -->
      <section class="card flex flex-col gap-5 p-6" aria-labelledby="prefs-title">
        <div class="flex flex-col gap-1">
          <h2 id="prefs-title" class="text-body font-semibold">Preferences</h2>
          <p class="text-body-sm text-fg-muted">Saved in this browser.</p>
        </div>

        <div class="flex flex-col gap-1.5">
          <span id="theme-label" class="text-label text-fg-muted">Theme</span>
          <div role="group" aria-labelledby="theme-label" class="flex max-w-[360px] rounded-md border border-border bg-bg p-1">
            @for (t of themes; track t.value) {
              <button
                type="button"
                class="min-h-11 flex-1 cursor-pointer rounded-xs text-body-sm text-fg-muted aria-pressed:bg-surface-3 aria-pressed:text-fg"
                [attr.aria-pressed]="theme.current() === t.value"
                (click)="theme.current.set(t.value)"
              >
                {{ t.label }}
              </button>
            }
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <span id="model-label-settings" class="text-label text-fg-muted">Model for the agent</span>
          <div role="group" aria-labelledby="model-label-settings" class="flex max-w-[360px] rounded-md border border-border bg-bg p-1">
            @for (m of models; track m.value) {
              <button
                type="button"
                class="min-h-11 flex-1 cursor-pointer rounded-xs text-body-sm text-fg-muted aria-pressed:bg-surface-3 aria-pressed:text-fg"
                [attr.aria-pressed]="model.current() === m.value"
                (click)="model.pick(m.value)"
              >
                {{ m.label }}
              </button>
            }
          </div>
          <p class="text-body-sm text-fg-muted">{{ modelHint() }}</p>
        </div>

        <app-repo-picker class="max-w-[360px]" />
      </section>

      <!-- Your data -->
      @if (data(); as p) {
        <section class="card flex flex-col gap-4 p-6" aria-labelledby="data-title">
          <h2 id="data-title" class="text-body font-semibold">Your activity</h2>
          @if (p.activity; as a) {
            <dl class="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div class="flex flex-col gap-1">
                <dt class="text-body-sm text-fg-muted">Conversations</dt>
                <dd class="font-display text-stat tabular-nums">{{ a.sessions }}</dd>
              </div>
              <div class="flex flex-col gap-1">
                <dt class="text-body-sm text-fg-muted">Waiting for you</dt>
                <dd class="font-display text-stat tabular-nums">{{ a.waiting }}</dd>
              </div>
              <div class="flex flex-col gap-1">
                <dt class="text-body-sm text-fg-muted">Changes approved</dt>
                <dd class="font-display text-stat tabular-nums">{{ a.changes }}</dd>
              </div>
              <div class="flex flex-col gap-1">
                <dt class="text-body-sm text-fg-muted">Undone</dt>
                <dd class="font-display text-stat tabular-nums">{{ a.undone }}</dd>
              </div>
            </dl>
            <div class="flex flex-wrap gap-2.5">
              <a class="btn" routerLink="/history">Open History</a>
              <a class="btn" routerLink="/audit">Open Audit log</a>
            </div>
          } @else {
            <p class="text-body-sm text-fg-muted">History and the Audit log need the database, which is not connected on this server.</p>
          }
        </section>
      }

      <p class="flex items-center gap-2 text-body-sm text-fg-faint">
        <app-icon name="check" [size]="14" />
        Your preferences apply right away; nothing here changes anything on GitHub.
      </p>
    </div>
  `,
})
export class Settings {
  protected readonly auth = inject(Auth);
  protected readonly theme = inject(Theme);
  protected readonly model = inject(ModelChoice);
  protected readonly status = inject(ServerStatus);
  protected readonly themes = THEMES;
  protected readonly models = MODELS;

  protected readonly profile = httpResource<Profile>(() => '/api/profile');
  protected readonly data = computed(() => valueOf(this.profile));

  protected readonly avatar = computed(() => {
    const url = this.data()?.user.avatarUrl;
    return isGitHubAvatar(url) ? url : null;
  });

  /** What the granted scopes reach, in words. */
  protected readonly reach = computed(() => {
    const scopes = this.data()?.access.scopes ?? [];
    if (scopes.includes('repo')) return 'RepoPilot can work on your public and private repositories.';
    if (scopes.includes('public_repo')) return 'RepoPilot can work on your public repositories only.';
    return 'RepoPilot can read public data only.';
  });

  /** The server asks for more than this sign-in granted (e.g. it moved from public_repo to repo). */
  protected readonly missingScope = computed(() => {
    const a = this.data()?.access;
    return !!a?.requestedScope && !!a.scopes && !a.scopes.includes(a.requestedScope);
  });

  protected readonly modelHint = computed(() => MODELS.find((m) => m.value === this.model.current())?.hint ?? '');

  protected safe(url: string): string | null {
    return isGitHubUrl(url) ? url : null;
  }

  protected since(iso: string): string {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }
}
