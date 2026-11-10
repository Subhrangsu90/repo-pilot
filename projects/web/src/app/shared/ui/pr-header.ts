import { Component, computed, input } from '@angular/core';
import type { PropsOf } from '@repopilot/shared';

export type PrInfo = PropsOf<'PrReview'>['pr'];

const STATE: Record<PrInfo['state'], { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'badge-success' },
  draft: { label: 'Draft', cls: '' },
  merged: { label: 'Merged', cls: 'badge-write' },
  closed: { label: 'Closed', cls: 'badge-danger' },
};

/**
 * Screen Spec PR review header: state badge, title and number, the branch line
 * "head → base", size, and CI checks. Used by the review page (h1) and by the
 * PrReview surface in the chat (h2).
 */
@Component({
  selector: 'app-pr-header',
  host: { class: 'flex flex-col gap-2' },
  template: `
    @let p = pr();
    <div class="flex flex-wrap items-center gap-2.5">
      <span class="badge" [class]="state().cls">{{ state().label }}</span>
      @if (level() === 1) {
        <h1 class="font-display text-h1">{{ p.title }}</h1>
      } @else {
        <h2 class="font-display text-h2">{{ p.title }}</h2>
      }
      <a [href]="p.url" target="_blank" rel="noopener noreferrer" class="font-mono text-body-md text-fg-muted hover:text-fg">
        #{{ p.number }}<span class="sr-only"> on GitHub (opens in a new tab)</span>
      </a>
    </div>
    <p class="flex flex-wrap items-center gap-x-4.5 gap-y-1 text-body-sm text-fg-muted">
      <span class="font-mono"><span class="sr-only">Branch: </span>{{ p.branch }} → {{ p.base }}</span>
      <span>
        <span class="font-mono tabular-nums"><span class="text-success">+{{ p.additions }}</span> / <span class="text-danger">−{{ p.deletions }}</span></span>
        in {{ p.changedFiles }} {{ p.changedFiles === 1 ? 'file' : 'files' }}
      </span>
      @if (p.checks; as c) {
        <span class="inline-flex items-center gap-1.5">
          <span class="size-2 rounded-full" [class]="c.passed === c.total ? 'bg-success' : 'bg-danger'" aria-hidden="true"></span>
          {{ c.passed }} of {{ c.total }} {{ c.total === 1 ? 'check' : 'checks' }} passed
        </span>
      }
    </p>
  `,
})
export class PrHeader {
  readonly pr = input.required<PrInfo>();
  /** 1 on the review page, 2 inside a chat surface. */
  readonly level = input<1 | 2>(2);
  protected readonly state = computed(() => STATE[this.pr().state]);
}
