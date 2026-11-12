import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { ModelOption } from '@repopilot/shared';
import { filter, map } from 'rxjs';
import { ModelChoice } from '../core/model-choice';
import { ServerStatus } from '../core/server-status';
import { Auth } from '../core/auth';
import { RepoPicker } from '../shared/ui/repo-picker';
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
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, Logo, RepoPicker],
  // The component catalog loads with the app pages, not with the landing page.
  providers: [{ provide: GENUI_REGISTRY, useValue: REGISTRY }],
  host: { class: 'flex min-h-dvh flex-col min-[780px]:flex-row' },
  template: `
    <nav
      aria-label="Main"
      class="flex shrink-0 flex-col gap-6 border-b border-border bg-surface-1 px-3.5 py-5 min-[780px]:sticky min-[780px]:top-0 min-[780px]:h-dvh min-[780px]:w-62 min-[780px]:self-start min-[780px]:overflow-y-auto min-[780px]:border-r min-[780px]:border-b-0"
    >
      <a routerLink="/" class="self-start rounded-sm px-2 py-1" aria-label="RepoPilot home"><app-logo /></a>

      <app-repo-picker [compact]="true" />

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
        @if (auth.user(); as u) {
          <a
            routerLink="/settings"
            routerLinkActive="bg-surface-3 text-fg"
            ariaCurrentWhenActive="page"
            class="flex min-h-11 items-center gap-2.5 rounded-sm px-2 text-body-sm text-fg-muted hover:text-fg"
            aria-label="Profile and settings"
          >
            @if (status.viewer()?.avatarUrl; as avatar) {
              <img [src]="avatar" alt="" width="24" height="24" class="size-6 shrink-0 rounded-full bg-surface-3" referrerpolicy="no-referrer" />
            } @else {
              <span class="grid size-6 shrink-0 place-items-center rounded-full bg-surface-3 text-caption font-semibold uppercase" aria-hidden="true">{{ u.login.slice(0, 2) }}</span>
            }
            <span class="min-w-0 flex-1 truncate font-mono">{{ u.login }}</span>
            <span class="shrink-0 text-caption text-fg-faint">Settings</span>
          </a>
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
