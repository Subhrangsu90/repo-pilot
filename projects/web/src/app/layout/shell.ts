import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import type { ModelOption } from '@repopilot/shared';
import { ModelChoice } from '../core/model-choice';
import { ServerStatus } from '../core/server-status';
import { Theme } from '../core/theme';
import { Icon, IconName } from '../shared/ui/icon';
import { Logo } from '../shared/ui/logo';

interface NavItem {
  path: string;
  label: string;
  icon: IconName;
}

/**
 * Pages from the design that exist. Pull requests, Issues, Releases, History
 * and Audit log join this list as they are built. (/playground is a dev tool
 * and deliberately not in the menu.)
 */
const NAV: NavItem[] = [{ path: '/ask', label: 'Ask', icon: 'ask' }];

const MODELS: { value: ModelOption; label: string }[] = [
  { value: 'cloud', label: 'Cloud' },
  { value: 'local', label: 'Local Gemma' },
];

/**
 * App layout from the design: side menu (stacks above the content below 780px,
 * never sticky), a top bar with the repo, and the routed page.
 */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, Logo],
  host: { class: 'flex min-h-dvh flex-col min-[780px]:flex-row' },
  template: `
    <nav
      aria-label="Main"
      class="flex shrink-0 flex-col gap-6 border-b border-border bg-surface-1 px-3.5 py-5 min-[780px]:w-62 min-[780px]:border-r min-[780px]:border-b-0"
    >
      <a routerLink="/" class="self-start rounded-sm px-2 py-1" aria-label="RepoPilot home"><app-logo /></a>

      @if (status.repo(); as repo) {
        <p class="flex min-h-11 items-center rounded-md border border-border-strong bg-bg px-3 font-mono text-body-sm text-fg">
          <span class="sr-only">Repository: </span>{{ repo.name }}
        </p>
      }

      <ul class="flex flex-col gap-1">
        @for (item of nav; track item.path) {
          <li>
            <a
              [routerLink]="item.path"
              routerLinkActive="bg-surface-3 font-medium text-fg"
              ariaCurrentWhenActive="page"
              class="flex min-h-11 items-center gap-2.5 rounded-sm px-3 text-[14px] text-fg-muted hover:text-fg"
            >
              <app-icon [name]="item.icon" />
              {{ item.label }}
            </a>
          </li>
        }
      </ul>

      <div class="flex flex-col gap-2 border-t border-border pt-4 min-[780px]:mt-auto">
        <span id="model-label" class="text-[12px] text-fg-faint">Model</span>
        <div role="group" aria-labelledby="model-label" class="flex rounded-md border border-border bg-bg p-1">
          @for (m of models; track m.value) {
            <button
              type="button"
              class="min-h-9 flex-1 cursor-pointer rounded-[7px] text-body-sm text-fg-muted aria-pressed:bg-surface-3 aria-pressed:text-fg"
              [attr.aria-pressed]="model.current() === m.value"
              (click)="model.pick(m.value)"
            >
              {{ m.label }}
            </button>
          }
        </div>
      </div>
    </nav>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-8">
        @if (status.repo(); as repo) {
          <span class="font-mono text-[14px] text-fg-muted">
            {{ repo.owner }} / <span class="text-fg">{{ repo.name }}</span>
          </span>
        } @else if (status.health.error()) {
          <span class="text-body-sm text-danger">Agent server not reachable</span>
        } @else {
          <span></span>
        }
        <button
          type="button"
          class="btn btn-ghost min-h-11 min-w-11 px-0"
          [attr.aria-label]="theme.current() === 'graphite' ? 'Switch to light theme' : 'Switch to graphite theme'"
          (click)="theme.toggle()"
        >
          <app-icon [name]="theme.current() === 'graphite' ? 'sun' : 'moon'" />
        </button>
      </header>

      <main id="main" class="flex min-w-0 flex-1 flex-col">
        <router-outlet />
      </main>
    </div>
  `,
})
export class Shell {
  protected readonly status = inject(ServerStatus);
  protected readonly model = inject(ModelChoice);
  protected readonly theme = inject(Theme);
  protected readonly nav = NAV;
  protected readonly models = MODELS;
}
