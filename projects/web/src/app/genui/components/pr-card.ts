import { Component, computed, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';

const STATE: Record<PropsOf<'PrCard'>['state'], { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'text-good border-good/40' },
  draft: { label: 'Draft', cls: 'text-muted border-border' },
  merged: { label: 'Merged', cls: 'text-accent border-accent/40' },
  closed: { label: 'Closed', cls: 'text-danger border-danger/40' },
};

const CI: Record<PropsOf<'PrCard'>['ci'], { icon: string; label: string; cls: string }> = {
  success: { icon: '✓', label: 'CI passing', cls: 'text-good' },
  failure: { icon: '✕', label: 'CI failing', cls: 'text-danger' },
  pending: { icon: '●', label: 'CI running', cls: 'text-warning' },
  none: { icon: '–', label: 'No CI', cls: 'text-muted' },
};

@Component({
  selector: 'app-pr-card',
  host: { class: 'block' },
  template: `
    @let p = props();
    <article class="card flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="chip" [class]="state().cls">{{ state().label }}</span>
          <span class="font-mono text-xs text-muted">#{{ p.number }}</span>
        </div>
        <h3 class="mt-1.5 text-sm font-medium text-ink">
          @if (p.url) {
            <a class="hover:underline" [href]="p.url" target="_blank" rel="noopener noreferrer" (click)="open()">{{ p.title }}</a>
          } @else {
            {{ p.title }}
          }
        </h3>
        <p class="mt-1 text-xs text-muted">
          @if (p.author) {
            {{ p.author }} ·
          }
          opened {{ p.ageDays === 0 ? 'today' : p.ageDays + ' d ago' }}
          @if (p.reviewers.length) {
            · reviewers: {{ p.reviewers.join(', ') }}
          } @else if (p.state === 'open') {
            · <span class="text-warning">no reviewers</span>
          }
        </p>
        @if (p.labels.length) {
          <div class="mt-2 flex flex-wrap gap-1">
            @for (label of p.labels; track label) {
              <span class="chip">{{ label }}</span>
            }
          </div>
        }
      </div>
      <div class="flex shrink-0 items-center gap-3 text-xs sm:flex-col sm:items-end sm:gap-1">
        <span [class]="ci().cls" [attr.aria-label]="ci().label" [title]="ci().label">
          <span aria-hidden="true">{{ ci().icon }}</span> {{ ci().label }}
        </span>
        @if (p.additions !== undefined && p.deletions !== undefined) {
          <span class="font-mono tabular-nums" [attr.aria-label]="p.additions + ' additions, ' + p.deletions + ' deletions'">
            <span class="text-good">+{{ p.additions }}</span> <span class="text-danger">−{{ p.deletions }}</span>
          </span>
        }
      </div>
    </article>
  `,
})
export class PrCard {
  readonly props = input.required<PropsOf<'PrCard'>>();
  readonly emit = input<EmitFn>();

  protected readonly state = computed(() => STATE[this.props().state]);
  protected readonly ci = computed(() => CI[this.props().ci]);

  protected open() {
    this.emit()?.({ component: 'PrCard', name: 'open', payload: { number: this.props().number } });
  }
}
