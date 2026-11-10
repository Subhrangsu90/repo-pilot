import { Component, computed, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';

type Pr = PropsOf<'PrCard'>;

const STATE: Record<Pr['state'], { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'badge-success' },
  draft: { label: 'Draft', cls: '' },
  merged: { label: 'Merged', cls: 'badge-write' },
  closed: { label: 'Closed', cls: 'badge-danger' },
};

/** A dot plus a word, never the dot alone. */
const CI: Record<Pr['ci'], { label: string; dot: string | null }> = {
  success: { label: 'CI passing', dot: 'bg-success' },
  failure: { label: 'CI failing', dot: 'bg-danger' },
  pending: { label: 'CI pending', dot: 'bg-fg-muted' },
  none: { label: 'No CI', dot: null },
};

/**
 * One pull request. With a GitHub url the whole card is a link (a stretched
 * title link, so there is still exactly one focus stop per card).
 */
@Component({
  selector: 'app-pr-card',
  host: { class: 'block' },
  template: `
    @let p = props();
    <article class="group card relative flex flex-col gap-2.5 p-4 has-[a]:hover:bg-surface-3">
      <div class="flex flex-wrap items-center gap-2.5">
        <span class="badge" [class]="state().cls">{{ state().label }}</span>
        <h3 class="text-body font-semibold">
          @if (p.url) {
            <a [href]="p.url" target="_blank" rel="noopener noreferrer" class="after:absolute after:inset-0 after:rounded-lg" (click)="open()">
              {{ p.title }}
            </a>
          } @else {
            {{ p.title }}
          }
        </h3>
        <!-- text-faint fails contrast on surface-3, so it steps up to muted on hover. -->
        <span class="font-mono text-body-sm text-fg-faint group-has-[a]:group-hover:text-fg-muted">#{{ p.number }}</span>
      </div>

      <div class="flex flex-wrap gap-x-4.5 gap-y-1.5 text-body-sm text-fg-muted">
        @if (p.author) {
          <span class="font-mono">{{ p.author }}</span>
        }
        @if (p.branch) {
          <span class="max-w-full truncate font-mono" [title]="p.branch"><span class="sr-only">Branch: </span>{{ p.branch }}</span>
        }
        <span class="inline-flex items-center gap-1.5">
          @if (ci().dot; as dot) {
            <span class="size-2 rounded-full" [class]="dot" aria-hidden="true"></span>
          }
          {{ ci().label }}
        </span>
        <span>
          @if (p.reviewers.length) {
            Reviewers: <span class="font-mono">{{ p.reviewers.join(', ') }}</span>
          } @else {
            No reviewers
          }
        </span>
        <span>{{ age() }}</span>
        @if (p.additions !== undefined && p.deletions !== undefined) {
          <span class="font-mono tabular-nums" [attr.aria-label]="p.additions + ' additions, ' + p.deletions + ' deletions'">
            <span class="text-success">+{{ p.additions }}</span> <span class="text-danger">−{{ p.deletions }}</span>
          </span>
        }
      </div>

      @if (p.labels.length) {
        <div class="flex flex-wrap gap-1">
          @for (label of p.labels; track label) {
            <span class="badge px-2 py-0.5 font-normal" [class.badge-danger]="label.toLowerCase() === 'bug'">{{ label }}</span>
          }
        </div>
      }
    </article>
  `,
})
export class PrCard {
  readonly props = input.required<PropsOf<'PrCard'>>();
  readonly emit = input<EmitFn>();

  protected readonly state = computed(() => STATE[this.props().state]);
  protected readonly ci = computed(() => CI[this.props().ci]);
  protected readonly age = computed(() => {
    const d = this.props().ageDays;
    return d === 0 ? 'Opened today' : `${d} ${d === 1 ? 'day' : 'days'}`;
  });

  protected open() {
    this.emit()?.({ component: 'PrCard', name: 'open', payload: { number: this.props().number } });
  }
}
