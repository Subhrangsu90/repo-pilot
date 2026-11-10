import { afterNextRender, Component, computed, ElementRef, input, linkedSignal, viewChild } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';
import { Icon } from '../../shared/ui/icon';

type Props = PropsOf<'ApprovalCard'>;

/**
 * Human-in-the-loop. Shows the dry run of a change: the exact items, what
 * happens to each, and whether it can be undone. Nothing reaches GitHub until
 * Approve; unticked items are left alone. The server re-sends this surface
 * with a new `status` as the decision is carried out.
 */
@Component({
  selector: 'app-approval-card',
  imports: [Icon],
  host: { class: 'block' },
  template: `
    @let p = props();
    <div class="flex flex-wrap items-start gap-5">
      <section
        #card
        tabindex="-1"
        class="flex min-w-0 flex-[3_1_460px] flex-col gap-4 rounded-xl border bg-surface-1 p-6"
        [class]="destructive() ? 'border-risk' : 'border-border-strong'"
        [attr.aria-labelledby]="titleId()"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 [id]="titleId()" class="font-display text-h2">{{ title() }}</h2>
          <span class="badge" [class]="destructive() ? 'badge-risk' : 'badge-write'">
            {{ destructive() ? 'Destructive · dry run' : 'Write · needs approval' }}
          </span>
        </div>
        <p class="text-body text-fg-muted">{{ p.summary }}</p>

        @if (p.items.length) {
          <fieldset class="overflow-hidden rounded-lg border border-border" [disabled]="!interactive()">
            <legend class="sr-only">Items this change applies to</legend>
            <div class="flex items-center justify-between gap-3 border-b border-border bg-surface-2 px-4 py-1 text-body-sm text-fg-muted">
              <label class="flex min-h-11 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  class="checkbox"
                  [class.checkbox-risk]="destructive()"
                  [checked]="allSelected()"
                  [indeterminate]="selected().size > 0 && !allSelected()"
                  (change)="toggleAll()"
                />
                Select all
              </label>
              <span class="tabular-nums" aria-live="polite">{{ selected().size }} of {{ p.items.length }} selected</span>
            </div>
            <ul>
              @for (item of p.items; track item.id) {
                @let on = selected().has(item.id);
                <li class="border-b border-border last:border-b-0" [class.bg-bg]="!on">
                  <label class="flex min-h-14 cursor-pointer items-center gap-3.5 px-4 py-2.5">
                    <input
                      type="checkbox"
                      class="checkbox"
                      [class.checkbox-risk]="destructive()"
                      [checked]="on"
                      (change)="toggle(item.id)"
                    />
                    <span class="w-11 shrink-0 font-mono text-body-sm text-fg-faint">#{{ item.id }}</span>
                    <span class="min-w-0 flex-1 text-body-md" [class]="on ? 'text-fg' : 'text-fg-muted line-through'">{{ item.title }}</span>
                    @if (item.meta) {
                      <span class="hidden shrink-0 text-caption text-fg-faint sm:inline">{{ item.meta }}</span>
                    }
                  </label>
                </li>
              }
            </ul>
          </fieldset>
        }

        @if (p.skipped.length) {
          <p class="text-body-sm text-fg-muted">
            Left out by the dry run:
            @for (s of p.skipped; track s.id; let last = $last) {
              <span class="font-mono">#{{ s.id }}</span> {{ s.reason }}{{ last ? '.' : ', ' }}
            }
          </p>
        }

        @if (p.reversible && p.undoHint) {
          <p class="flex items-center gap-2 text-body-sm text-fg-muted">
            <span class="text-success"><app-icon name="refresh" [size]="16" /></span>{{ p.undoHint }}
          </p>
        }

        @switch (p.status) {
          @case ('running') {
            <p role="status" class="flex items-center gap-2.5 rounded-md bg-neutral-soft px-3.5 py-3 text-body-md">
              <span class="size-4 animate-spin rounded-full border-2 border-fg border-t-transparent" aria-hidden="true"></span>
              Applying the change…
            </p>
          }
          @case ('approved') {
            <p role="status" class="flex items-center gap-2.5 rounded-md bg-success-soft px-3.5 py-3 text-body-md text-success">
              <app-icon name="check" [size]="16" [stroke]="3" />{{ p.result }}
            </p>
          }
          @case ('rejected') {
            <p role="status" class="flex items-center gap-2.5 rounded-md bg-neutral-soft px-3.5 py-3 text-body-md text-fg-muted">
              <app-icon name="cross" [size]="16" [stroke]="2.5" />{{ p.result }}
            </p>
          }
          @case ('failed') {
            <p role="alert" class="flex items-center gap-2.5 rounded-md bg-danger-soft px-3.5 py-3 text-body-md text-danger">
              <app-icon name="cross" [size]="16" [stroke]="2.5" />{{ p.result }}
            </p>
          }
          @default {
            <div class="flex flex-wrap justify-end gap-2.5">
              <button type="button" class="btn" [disabled]="!interactive()" (click)="decide('reject')">Reject</button>
              <button
                type="button"
                class="btn"
                [disabled]="!interactive()"
                title="Cancel this change and put your request back in the prompt box"
                (click)="decide('edit')"
              >
                Edit request
              </button>
              <button
                type="button"
                class="btn"
                [class]="destructive() ? 'btn-risk' : 'btn-primary'"
                [disabled]="!interactive() || (p.items.length > 0 && selected().size === 0)"
                (click)="decide('approve')"
              >
                @if (submitted()) {
                  <span class="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true"></span>
                  Sending…
                } @else {
                  {{ approveLabel() }}
                }
              </button>
            </div>
          }
        }
      </section>

      <aside class="flex min-w-0 flex-[2_1_280px] flex-col gap-3.5" aria-label="What will happen">
        <div class="card flex flex-col gap-3 bg-surface-1 p-card">
          <h3 class="text-body font-semibold">What will happen</h3>
          @if (p.effect; as effect) {
            <p class="flex flex-wrap items-center gap-2.5">
              <span class="badge badge-success font-normal">{{ effect.from }}</span>
              <app-icon name="arrow-right" [size]="16" class="text-fg-faint" />
              <span class="badge badge-write font-normal">{{ effect.to }}</span>
            </p>
          }
          @if (p.details.length || p.requestMethod) {
            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-body-sm">
              @for (d of p.details; track d.label) {
                <dt class="text-fg-faint">{{ d.label }}</dt>
                <dd class="min-w-0 break-words" [class.font-mono]="d.mono">{{ d.value }}</dd>
              }
              @if (requests(); as r) {
                <dt class="text-fg-faint">API calls</dt>
                <dd class="tabular-nums" aria-live="polite">{{ r }}</dd>
              }
            </dl>
          }
        </div>
        <div class="card flex flex-col gap-2 bg-surface-1 p-card">
          <h3 class="text-body font-semibold">Why you are seeing this</h3>
          <p class="text-body-sm text-fg-muted">
            @if (destructive()) {
              Destructive changes always run as a dry run first. The real change only runs after you approve, and only
              for the items still ticked.
            } @else {
              Every change to the repository waits for your approval. Nothing is sent to GitHub until you approve.
            }
          </p>
        </div>
      </aside>
    </div>
  `,
})
export class ApprovalCard {
  readonly props = input.required<Props>();
  readonly emit = input<EmitFn>();

  private readonly card = viewChild.required<ElementRef<HTMLElement>>('card');

  /** Starts from the server's selection and resets whenever the server re-sends the card. */
  protected readonly selected = linkedSignal<Props, ReadonlySet<number>>({
    source: this.props,
    computation: (p) => new Set(p.selected ?? p.items.map((i) => i.id)),
  });

  /** True after a click until the server answers with a new card. */
  protected readonly submitted = linkedSignal<Props, boolean>({ source: this.props, computation: () => false });

  protected readonly destructive = computed(() => this.props().risk === 'destructive');
  protected readonly interactive = computed(() => this.props().status === 'pending' && !this.submitted());
  protected readonly titleId = computed(() => `approval-${this.props().toolCallId}`);
  protected readonly allSelected = computed(() => this.selected().size === this.props().items.length);

  protected readonly title = computed(() => {
    const { verb, noun, items } = this.props();
    const Verb = verb[0].toUpperCase() + verb.slice(1);
    if (!items.length) return `${Verb} ${noun}`;
    const n = this.selected().size;
    return `${Verb} ${n} ${n === 1 ? noun : `${noun}s`}`;
  });

  /** "5 PATCH requests": one request per ticked item, live as the user unticks. */
  protected readonly requests = computed(() => {
    const method = this.props().requestMethod;
    if (!method) return null;
    const n = this.selected().size;
    return `${n} ${method} ${n === 1 ? 'request' : 'requests'}`;
  });

  protected readonly approveLabel = computed(() => {
    const { verb, items } = this.props();
    return items.length ? `Approve and ${verb} ${this.selected().size}` : 'Approve';
  });

  constructor() {
    // Move focus to the card, not to Approve: a stray Enter must never approve a change.
    afterNextRender(() => {
      if (this.props().status === 'pending') this.card().nativeElement.focus({ preventScroll: true });
    });
  }

  protected toggle(id: number) {
    const next = new Set(this.selected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selected.set(next);
  }

  protected toggleAll() {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.props().items.map((i) => i.id)));
  }

  /** approve / reject answer the card; edit rejects it and hands the request back to the prompt box. */
  protected decide(name: 'approve' | 'reject' | 'edit') {
    if (!this.interactive()) return;
    this.submitted.set(true);
    const { toolCallId, items } = this.props();
    // Keep the order the server listed them in.
    const selected = items.map((i) => i.id).filter((id) => this.selected().has(id));
    this.emit()?.({ component: 'ApprovalCard', name, payload: name === 'approve' ? { toolCallId, selected } : { toolCallId } });
  }
}
