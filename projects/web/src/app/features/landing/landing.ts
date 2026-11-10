import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Theme } from '../../core/theme';
import { Icon } from '../../shared/ui/icon';
import { Logo } from '../../shared/ui/logo';

const SUGGESTIONS = ['Show my open PRs', 'Give me a health report of the repo', 'List wontfix issues'];

const STEPS = [
  { label: 'Read open issues labelled wontfix', state: 'done' },
  { label: 'Filtered to issues older than 90 days', state: 'done' },
  { label: 'Running a dry run of the close', state: 'running' },
  { label: 'Waiting for your approval', state: 'pending' },
] as const;

const PREVIEW_ISSUES = [
  { n: 118, title: 'Legacy IE11 polyfills', on: true },
  { n: 131, title: 'Dark mode for old dashboard', on: true },
  { n: 140, title: 'Export audit log to CSV', on: false },
];

const PATTERNS = [
  { title: 'Tool-based Generative UI', text: 'A tool result maps to a known component.', prompt: 'Show my open PRs' },
  { title: 'Declarative UI (A2UI)', text: 'The agent composes a layout from the catalog.', prompt: 'Health report of this repo' },
  { title: 'Human-in-the-loop', text: 'Every write pauses on an approval card.', prompt: 'Close stale wontfix issues' },
  { title: 'Shared state', text: 'Agent and user edit the same draft.', prompt: 'Draft release v1.2.0' },
  { title: 'Frontend tools', text: 'The agent navigates, filters and highlights.', prompt: 'Take me to the auth changes' },
  { title: 'Streaming steps', text: 'Progress shows live while the agent works.', prompt: 'Review a pull request' },
];

const HOW = [
  { n: '01', title: 'Ask', text: 'Type an intent in plain words. No query syntax and no clicking through ten tabs.' },
  {
    n: '02',
    title: 'See real UI',
    text: 'The agent picks components from an allowlisted catalog. They render live, validated, in your design system.',
  },
  {
    n: '03',
    title: 'Approve',
    text: 'Writes pause for your review. Destructive actions show a dry run first, and everything can be undone.',
  },
];

/** Public landing page (design artboard "Landing"). The prompt opens the Ask page. */
@Component({
  selector: 'app-landing',
  imports: [RouterLink, Icon, Logo],
  host: { class: 'block min-h-dvh bg-bg text-fg' },
  template: `
    <div class="mx-auto max-w-[1240px] px-4 sm:px-8">
      <header class="flex flex-wrap items-center justify-between gap-4 py-6">
        <app-logo [size]="32" />
        <nav aria-label="Primary" class="flex flex-wrap items-center gap-2">
          <a href="#how" class="px-3.5 py-3 text-body text-fg-muted hover:text-fg">How it works</a>
          <a href="#patterns" class="px-3.5 py-3 text-body text-fg-muted hover:text-fg">Patterns</a>
          <button
            type="button"
            class="btn btn-ghost min-w-11 px-0"
            [attr.aria-label]="theme.current() === 'graphite' ? 'Switch to light theme' : 'Switch to graphite theme'"
            (click)="theme.toggle()"
          >
            <app-icon [name]="theme.current() === 'graphite' ? 'sun' : 'moon'" />
          </button>
          <a routerLink="/ask" class="btn">Open app</a>
        </nav>
      </header>

      <main id="main">
        <section class="flex flex-wrap items-center gap-14 pt-12 pb-24 sm:pt-18">
          <div class="flex min-w-0 flex-[1_1_480px] flex-col gap-7">
            <span class="inline-flex items-center gap-2 self-start rounded-full border border-border-strong px-3 py-1.5 text-body-sm text-fg-muted">
              <span class="size-2 rounded-full bg-success" aria-hidden="true"></span>
              Generative UI · Agentic UI · Built with Angular
            </span>
            <h1 class="font-display text-[44px] leading-[1.04] font-bold tracking-[-0.03em] sm:text-[68px]">
              GitHub, in <span class="text-fg-faint">plain English.</span>
            </h1>
            <p class="max-w-[540px] text-[19px] leading-relaxed text-fg-muted">
              Ask for what you want. RepoPilot answers with real, interactive components (dashboards, diffs, editable
              drafts) and never changes your repo until you approve.
            </p>

            <form class="flex max-w-[560px] flex-col gap-3.5 rounded-lg border border-border bg-surface-1 p-4" (submit)="submit($event)">
              <div class="flex items-center gap-3">
                <label for="hero-ask" class="sr-only">Ask RepoPilot</label>
                <input
                  #box
                  id="hero-ask"
                  class="field h-12 min-w-0 flex-1 bg-bg"
                  placeholder="Show my open PRs"
                  [value]="draft()"
                  (input)="draft.set(box.value)"
                />
                <button type="submit" class="btn btn-primary size-12 px-0" aria-label="Ask" [disabled]="!draft().trim()">
                  <app-icon name="send" [size]="20" [stroke]="2.2" />
                </button>
              </div>
              <div class="flex flex-wrap gap-2">
                @for (s of suggestions; track s) {
                  <button type="button" class="chip" (click)="go(s)">{{ s }}</button>
                }
              </div>
            </form>

            <div class="flex flex-wrap items-center gap-3">
              <a routerLink="/ask" class="btn btn-primary min-h-13 rounded-[12px] px-5.5 text-base">
                Start asking <app-icon name="arrow-right" />
              </a>
              <a href="#how" class="btn min-h-13 rounded-[12px] px-5.5 text-base">See how it works</a>
            </div>
            <p class="text-body-sm text-fg-faint">Your token stays on the server. Every change waits for your approval.</p>
          </div>

          <!-- Illustration of an agent run: static and not focusable. -->
          <figure class="flex min-w-0 flex-[1_1_420px] flex-col gap-4">
            <figcaption class="sr-only">
              Example: the agent reads and filters wontfix issues, runs a dry run, and waits for approval to close 2 of 3 issues.
            </figcaption>
            <div class="rounded-lg border border-border bg-surface-1 p-5" aria-hidden="true">
              <div class="mb-4 flex items-center justify-between">
                <span class="font-mono text-body-sm text-fg-faint">agent run · 4 steps</span>
                <span class="badge badge-write">Running</span>
              </div>
              <ol class="flex flex-col gap-3 text-[14px]">
                @for (s of steps; track s.label) {
                  <li class="flex items-center gap-3" [class.text-fg-muted]="s.state === 'pending'">
                    @switch (s.state) {
                      @case ('done') {
                        <span class="grid size-5 place-items-center rounded-full bg-success text-bg">
                          <app-icon name="check" [size]="12" [stroke]="3.5" />
                        </span>
                      }
                      @case ('running') {
                        <span class="size-5 rounded-full border-2 border-fg"></span>
                      }
                      @default {
                        <span class="size-5 rounded-full border-2 border-border-strong"></span>
                      }
                    }
                    {{ s.label }}
                  </li>
                }
              </ol>
            </div>

            <div class="flex flex-col gap-3.5 rounded-lg border border-risk bg-surface-1 p-5" aria-hidden="true">
              <div class="flex items-center justify-between gap-3">
                <span class="font-display text-lg font-semibold">Close 2 stale issues</span>
                <span class="badge badge-risk">Destructive · dry run</span>
              </div>
              <ul class="flex flex-col gap-2 text-[14px]">
                @for (i of previewIssues; track i.n) {
                  <li class="flex min-h-8 items-center gap-2.5" [class.text-fg-muted]="!i.on">
                    <span
                      class="grid size-[18px] place-items-center rounded-[4px] border"
                      [class]="i.on ? 'border-risk bg-risk text-on-risk' : 'border-border-strong'"
                    >
                      @if (i.on) {
                        <app-icon name="check" [size]="12" [stroke]="3.5" />
                      }
                    </span>
                    <span class="font-mono text-fg-faint">#{{ i.n }}</span>
                    {{ i.title }}
                  </li>
                }
              </ul>
              <div class="flex justify-end gap-2.5">
                <span class="btn">Reject</span>
                <span class="btn btn-risk">Approve 2</span>
              </div>
            </div>
          </figure>
        </section>

        <section id="how" class="flex scroll-mt-6 flex-col gap-10 border-t border-border py-18">
          <div class="flex max-w-[640px] flex-col gap-3">
            <span class="font-mono text-body-sm">How it works</span>
            <h2 class="font-display text-[34px] leading-tight font-semibold tracking-[-0.02em] sm:text-[42px]">
              Ask. See real UI. Approve.
            </h2>
          </div>
          <div class="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-5">
            @for (h of how; track h.n) {
              <div class="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-7">
                <span class="font-display text-[40px] font-bold text-fg-faint" aria-hidden="true">{{ h.n }}</span>
                <h3 class="font-display text-xl font-semibold">{{ h.title }}</h3>
                <p class="text-body text-fg-muted">{{ h.text }}</p>
              </div>
            }
          </div>
        </section>

        <section id="patterns" class="flex scroll-mt-6 flex-col gap-10 border-t border-border py-18">
          <div class="flex max-w-[680px] flex-col gap-3">
            <span class="font-mono text-body-sm">Six patterns, one app</span>
            <h2 class="font-display text-[34px] leading-tight font-semibold tracking-[-0.02em] sm:text-[42px]">
              Every Generative and Agentic UI pattern, in context.
            </h2>
          </div>
          <ul class="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
            @for (p of patterns; track p.title) {
              <li class="flex flex-col gap-2.5 rounded-lg border border-border p-6">
                <h3 class="text-[17px] font-semibold">{{ p.title }}</h3>
                <p class="text-[14px] text-fg-muted">{{ p.text }}</p>
                <code class="font-mono text-body-sm text-fg-muted">"{{ p.prompt }}"</code>
              </li>
            }
          </ul>
        </section>
      </main>

      <footer class="flex flex-wrap justify-between gap-4 border-t border-border pt-10 pb-14 text-body-sm text-fg-faint">
        <span>RepoPilot, a Generative UI proof of concept</span>
        <span class="font-mono">Angular · AG-UI · A2UI · GitHub API</span>
      </footer>
    </div>
  `,
})
export class Landing {
  private readonly router = inject(Router);
  protected readonly theme = inject(Theme);
  protected readonly draft = signal('');
  protected readonly suggestions = SUGGESTIONS;
  protected readonly steps = STEPS;
  protected readonly previewIssues = PREVIEW_ISSUES;
  protected readonly patterns = PATTERNS;
  protected readonly how = HOW;

  protected submit(event: Event) {
    event.preventDefault();
    this.go(this.draft());
  }

  protected go(prompt: string) {
    const q = prompt.trim();
    if (q) void this.router.navigate(['/ask'], { queryParams: { q } });
  }
}
