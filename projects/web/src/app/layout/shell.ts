import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { ModelOption } from '@repopilot/shared';
import { filter, map } from 'rxjs';
import { ModelChoice } from '../core/model-choice';
import { ServerStatus } from '../core/server-status';
import { Auth } from '../core/auth';
import { RepoChoice, type RepoItem } from '../core/repo';
import { REGISTRY } from '../genui/registry';
import { GENUI_REGISTRY } from '../genui/registry-token';
import { Theme } from '../core/theme';
import { Icon, IconName } from '../shared/ui/icon';
import { Logo } from '../shared/ui/logo';

interface NavItem {
  label: string;
  icon: IconName;
  /** Set once the page is built; until then the item shows but is not a link. */
  path?: string;
  count?: 'pulls' | 'issues';
}

/**
 * The six links of the Screen Spec, in its order. Pull requests, Issues,
 * Releases, History and Audit log get a `path` as each page is built.
 */
const NAV: NavItem[] = [
  { label: 'Ask', icon: 'ask', path: '/ask' },
  { label: 'Pull requests', icon: 'pull-request', path: '/pulls', count: 'pulls' },
  { label: 'Issues', icon: 'issue', path: '/issues', count: 'issues' },
  { label: 'Releases', icon: 'release', path: '/releases' },
  { label: 'History', icon: 'history', path: '/history' },
  { label: 'Audit log', icon: 'audit', path: '/audit' },
];

const MODELS: { value: ModelOption; label: string }[] = [
  { value: 'cloud', label: 'Cloud' },
  { value: 'local', label: 'Local Gemma' },
];

/**
 * App layout (Screen Spec "Shared layout"): side nav on the left, the page on
 * the right; below 780px the nav stacks above the content and is never sticky; from 780px
 * it is pinned to the viewport height and scrolls on its own, apart from the page.
 * The model switch shows on Ask only; each page draws its own top bar.
 */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, Logo],
  // The component catalog loads with the app pages, not with the landing page.
  providers: [{ provide: GENUI_REGISTRY, useValue: REGISTRY }],
  host: { class: 'flex min-h-dvh flex-col min-[780px]:flex-row' },
  template: `
    <nav
      aria-label="Main"
      class="flex shrink-0 flex-col gap-6 border-b border-border bg-surface-1 px-3.5 py-5 min-[780px]:sticky min-[780px]:top-0 min-[780px]:h-dvh min-[780px]:w-62 min-[780px]:self-start min-[780px]:overflow-y-auto min-[780px]:border-r min-[780px]:border-b-0"
    >
      <a routerLink="/" class="self-start rounded-sm px-2 py-1" aria-label="RepoPilot home"><app-logo /></a>

      <!-- Every repository the user can access (public and private). Pages and the agent work on this one. -->
      <div class="flex flex-col gap-1.5">
        <label for="repo-picker" class="px-1 text-caption text-fg-faint">Repository</label>
        @if (repos.repos().length) {
          <div class="relative">
            <select
              id="repo-picker"
              class="field w-full cursor-pointer appearance-none pr-9 font-mono text-body-sm"
              [value]="repos.selected() ?? ''"
              [title]="repos.selected() ?? ''"
              (change)="pick($event)"
            >
              @for (r of repos.repos(); track r.full) {
                <option [value]="r.full" [selected]="r.full === repos.selected()">{{ label(r) }}</option>
              }
            </select>
            <app-icon name="chevron-down" [size]="16" class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-fg-muted" />
          </div>
        } @else if (repos.list.isLoading()) {
          <div class="h-11 animate-pulse rounded-md bg-surface-3" aria-hidden="true"></div>
        } @else if (repos.list.error()) {
          <p class="flex flex-wrap items-center gap-2 px-1 text-body-sm text-fg-muted" role="alert">
            Could not list your repositories.
            <button type="button" class="btn btn-ghost px-3" (click)="repos.list.reload()">Retry</button>
          </p>
        } @else {
          <p class="px-1 text-body-sm text-fg-muted">Your GitHub account has no repositories RepoPilot can see.</p>
        }
      </div>

      <ul class="flex flex-col gap-1">
        @for (item of nav; track item.label) {
          @let count = item.count ? status.counts()[item.count] : null;
          <li>
            @if (item.path) {
              <a
                [routerLink]="item.path"
                routerLinkActive="bg-surface-3 font-medium text-fg"
                ariaCurrentWhenActive="page"
                class="group flex min-h-11 items-center gap-2.5 rounded-sm px-3 text-body-md text-fg-muted hover:text-fg"
              >
                <app-icon [name]="item.icon" />
                {{ item.label }}
                @if (count !== null) {
                  <span class="ml-auto text-caption text-fg-faint tabular-nums group-aria-[current=page]:text-fg-muted"><span class="sr-only">, </span>{{ count }}<span class="sr-only"> open</span></span>
                }
              </a>
            } @else {
              <span
                class="flex min-h-11 cursor-not-allowed items-center gap-2.5 rounded-sm px-3 text-body-md text-fg-faint"
                title="Coming soon"
              >
                <app-icon [name]="item.icon" />
                {{ item.label }}<span class="sr-only"> (coming soon)</span>
                @if (count !== null) {
                  <span class="ml-auto text-caption tabular-nums"><span class="sr-only">, </span>{{ count }}<span class="sr-only"> open</span></span>
                }
              </span>
            }
          </li>
        }
      </ul>

      <div class="flex flex-col gap-2 border-t border-border pt-4 min-[780px]:mt-auto">
        @if (onAsk()) {
          <span id="model-label" class="text-caption text-fg-faint">Model</span>
          <div role="group" aria-labelledby="model-label" class="flex rounded-md border border-border bg-bg p-1">
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
        }
        @if (auth.mode() === 'oauth' && auth.user(); as u) {
          <div class="flex min-h-11 items-center justify-between gap-2 px-1">
            <span class="min-w-0 truncate font-mono text-body-sm text-fg-muted"><span class="sr-only">Signed in as </span>{{ u.login }}</span>
            <button type="button" class="btn btn-ghost shrink-0 px-3" (click)="auth.signOut()">Sign out</button>
          </div>
        }
        <button type="button" class="btn btn-ghost justify-start px-3" (click)="theme.toggle()">
          <app-icon [name]="theme.current() === 'graphite' ? 'sun' : 'moon'" />
          {{ theme.current() === 'graphite' ? 'Light theme' : 'Graphite theme' }}
        </button>
      </div>
    </nav>

    <main id="main" class="flex min-w-0 flex-1 flex-col">
      <router-outlet />
    </main>
  `,
})
export class Shell {
  protected readonly status = inject(ServerStatus);
  protected readonly model = inject(ModelChoice);
  protected readonly theme = inject(Theme);
  protected readonly auth = inject(Auth);
  protected readonly repos = inject(RepoChoice);

  /** "repo-pilot", "site · private", "js-loops · chaicodehq": the owner only when it is not you. */
  protected label(r: RepoItem): string {
    const [owner, name] = r.full.split('/');
    const mine = owner.toLowerCase() === (this.auth.user()?.login ?? '').toLowerCase();
    return [name, mine ? null : owner, r.private ? 'private' : null].filter(Boolean).join(' · ');
  }

  protected pick(event: Event) {
    const full = (event.target as HTMLSelectElement).value;
    if (full) this.repos.select(full);
  }
  protected readonly nav = NAV;
  protected readonly models = MODELS;

  private readonly router = inject(Router);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  /** Screen Spec: the model switch appears only on the Ask screen. */
  protected readonly onAsk = computed(() => this.url().startsWith('/ask'));
}
