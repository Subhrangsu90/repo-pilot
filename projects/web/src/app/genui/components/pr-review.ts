import { afterNextRender, Component, computed, ElementRef, inject, InjectionToken, input, linkedSignal, viewChild } from '@angular/core';
import { EmitFn, PropsOf, PrReviewEdits, UiEvent } from '@repopilot/shared';
import { Icon } from '../../shared/ui/icon';
import { PrHeader } from '../../shared/ui/pr-header';
import { DiffViewer } from './diff-viewer';

type Props = PropsOf<'PrReview'>;
type ReviewEvent = Props['event'];

/** Provided by the PR review page, which shows the PR header itself. */
export const PR_REVIEW_ON_PAGE = new InjectionToken<boolean>('PR review page draws the header');

const EVENTS: { value: ReviewEvent; label: string }[] = [
  { value: 'COMMENT', label: 'Comment' },
  { value: 'APPROVE', label: 'Approve' },
  { value: 'REQUEST_CHANGES', label: 'Request changes' },
];

/**
 * The agent's draft review of a pull request (Screen Spec "PR review").
 * Human-in-the-loop like ApprovalCard: the user edits or removes comments,
 * rewrites the summary and picks the verdict; nothing is posted to GitHub until
 * Submit. The server re-sends this surface with a new `status` as it posts.
 */
@Component({
  selector: 'app-pr-review',
  imports: [DiffViewer, PrHeader, Icon],
  host: { class: 'flex flex-col gap-5' },
  template: `
    @let p = props();
    @if (!onPage) {
      <app-pr-header [pr]="p.pr" />
    }

    @if (p.injectionWarning) {
      <!-- Set by the server's own check, never by the model. The quote is untrusted text, shown as text. -->
      <div role="note" class="card flex items-start gap-3 border-border-strong p-card" [attr.aria-labelledby]="id('injection')">
        <app-icon name="warning" class="mt-0.5" />
        <div class="flex min-w-0 flex-col gap-1.5">
          <p [id]="id('injection')" class="text-body-md font-semibold">Possible prompt injection in this pull request</p>
          <p class="text-body-sm text-fg-muted">
            Its title or description contains text addressed to an AI. RepoPilot treated it as data and did not
            follow it. Nothing is posted until you submit.
          </p>
          <blockquote class="border-l-2 border-border-strong pl-3 font-mono text-body-sm break-words">{{ p.injectionWarning }}</blockquote>
        </div>
      </div>
    }

    <div class="flex flex-wrap items-start gap-5">
      <div class="flex min-w-0 flex-[3_1_520px] flex-col gap-4">
        @if (p.comments.length === 0) {
          <p class="card p-card text-body-sm text-fg-muted">No inline comments: the review is the summary only.</p>
        }
        @for (d of diffs(); track d.path) {
          <app-diff-viewer [props]="d" [editable]="interactive()" [emit]="onDiffEvent" />
        }
        @if (removed() > 0 && interactive()) {
          <p class="flex flex-wrap items-center gap-2 text-body-sm text-fg-muted">
            {{ removed() }} {{ removed() === 1 ? 'comment' : 'comments' }} removed from the review.
            <button type="button" class="btn btn-ghost px-3" (click)="restore()">Restore</button>
          </p>
        }
        @if (p.skipped.length) {
          <p class="text-body-sm text-fg-muted">
            Left out by the dry run:
            @for (s of p.skipped; track s.id; let last = $last) {
              {{ s.reason }}{{ last ? '.' : '; ' }}
            }
          </p>
        }
      </div>

      <aside class="flex min-w-0 flex-[2_1_300px] flex-col gap-3.5" aria-label="Review">
        <section class="card flex flex-col gap-3 bg-surface-1 p-card" [attr.aria-labelledby]="id('files')">
          <h3 [id]="id('files')" class="text-body font-semibold">
            Changed files <span class="font-normal text-fg-muted">{{ p.pr.changedFiles }}</span>
          </h3>
          <ul class="flex flex-col gap-1.5 text-body-sm">
            @for (f of p.files; track f.path) {
              <li class="flex items-center justify-between gap-3">
                <span class="min-w-0 truncate font-mono" [title]="f.path">{{ f.path }}</span>
                <span class="shrink-0 font-mono tabular-nums">
                  <span class="text-success">+{{ f.additions }}</span> <span class="text-danger">−{{ f.deletions }}</span>
                </span>
              </li>
            }
          </ul>
        </section>

        <section
          #panel
          tabindex="-1"
          class="flex flex-col gap-4 rounded-xl border border-border-strong bg-surface-1 p-6"
          [attr.aria-labelledby]="id('title')"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h3 [id]="id('title')" class="font-display text-h2">Submit review</h3>
            <span class="badge badge-write">Write</span>
          </div>

          <div class="flex flex-col gap-1.5">
            <label [for]="id('summary')" class="flex justify-between gap-3 text-label text-fg-muted">
              Summary
              @if (summary() !== p.summary) {
                <span class="text-caption text-risk">edited by you</span>
              }
            </label>
            <textarea
              #box
              [id]="id('summary')"
              class="field h-auto min-h-32 py-2.5"
              maxlength="2000"
              [disabled]="!interactive()"
              [value]="summary()"
              (input)="summary.set(box.value)"
            ></textarea>
          </div>

          <fieldset class="flex flex-col" [disabled]="!interactive()">
            <legend class="mb-1 text-label text-fg-muted">Verdict</legend>
            @for (opt of events; track opt.value) {
              @let allowed = p.allowedEvents.includes(opt.value);
              <label class="flex min-h-11 items-center gap-3 text-body-md" [class.text-fg-muted]="!allowed" [class.cursor-pointer]="allowed">
                <input
                  type="radio"
                  class="checkbox"
                  [name]="id('event')"
                  [checked]="event() === opt.value"
                  [disabled]="!allowed"
                  (change)="event.set(opt.value)"
                />
                {{ opt.label }}
              </label>
            }
            @if (p.eventNote) {
              <p class="text-body-sm text-fg-muted">{{ p.eventNote }}</p>
            }
          </fieldset>

          @switch (p.status) {
            @case ('running') {
              <p role="status" class="flex items-center gap-2.5 rounded-md bg-neutral-soft px-3.5 py-3 text-body-md">
                <span class="size-4 animate-spin rounded-full border-2 border-fg border-t-transparent" aria-hidden="true"></span>
                Posting the review…
              </p>
            }
            @case ('approved') {
              <div role="status" class="flex flex-col gap-2 rounded-md bg-success-soft px-3.5 py-3 text-body-md text-success">
                <span class="flex items-center gap-2.5"><app-icon name="check" [size]="16" [stroke]="3" />{{ p.result }}</span>
                @if (p.reviewUrl) {
                  <a [href]="p.reviewUrl" target="_blank" rel="noopener noreferrer" class="text-body-sm text-fg underline underline-offset-2">
                    View the review on GitHub<span class="sr-only"> (opens in a new tab)</span>
                  </a>
                }
              </div>
            }
            @case ('rejected') {
              <p role="status" class="flex items-center gap-2.5 rounded-md bg-neutral-soft px-3.5 py-3 text-body-md text-fg-muted">
                <app-icon name="cross" [size]="16" [stroke]="2.5" />Discarded. Nothing was posted.
              </p>
            }
            @case ('failed') {
              <p role="alert" class="flex items-center gap-2.5 rounded-md bg-danger-soft px-3.5 py-3 text-body-md text-danger">
                <app-icon name="cross" [size]="16" [stroke]="2.5" />{{ p.result }}
              </p>
            }
            @default {
              <div class="flex flex-wrap justify-end gap-2.5">
                <button type="button" class="btn" [disabled]="!interactive()" (click)="decide('reject')">Discard</button>
                <button
                  type="button"
                  class="btn btn-primary"
                  [disabled]="!interactive() || !summary().trim()"
                  (click)="decide('approve')"
                >
                  @if (submitted()) {
                    <span class="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true"></span>
                    Sending…
                  } @else {
                    {{ submitLabel() }}
                  }
                </button>
              </div>
            }
          }
          <p class="text-body-sm text-fg-muted">Nothing is posted to GitHub until you submit.</p>
        </section>
      </aside>
    </div>
  `,
})
export class PrReview {
  readonly props = input.required<Props>();
  readonly emit = input<EmitFn>();

  protected readonly onPage = inject(PR_REVIEW_ON_PAGE, { optional: true }) ?? false;
  protected readonly events = EVENTS;
  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');

  // The user's working copy; every one resets when the server re-sends the surface.
  protected readonly bodies = linkedSignal<Props, ReadonlyMap<number, string>>({
    source: this.props,
    computation: (p) => new Map(p.comments.map((c) => [c.id, c.body])),
  });
  protected readonly kept = linkedSignal<Props, ReadonlySet<number>>({
    source: this.props,
    computation: (p) => new Set(p.selected ?? p.comments.map((c) => c.id)),
  });
  protected readonly summary = linkedSignal<Props, string>({ source: this.props, computation: (p) => p.summary });
  protected readonly event = linkedSignal<Props, ReviewEvent>({ source: this.props, computation: (p) => p.event });
  /** True after a click until the server answers with a new surface. */
  protected readonly submitted = linkedSignal<Props, boolean>({ source: this.props, computation: () => false });

  protected readonly interactive = computed(() => this.props().status === 'pending' && !this.submitted());
  protected readonly comments = computed(() =>
    this.props()
      .comments.filter((c) => this.kept().has(c.id))
      .map((c) => ({ ...c, body: this.bodies().get(c.id) ?? c.body })),
  );
  protected readonly removed = computed(() => this.props().comments.length - this.comments().length);
  protected readonly diffs = computed(() =>
    this.props().diffs.map((d) => ({
      ...d,
      comments: this.comments()
        .filter((c) => c.path === d.path)
        .map(({ path: _path, ...c }) => c),
    })),
  );
  protected readonly submitLabel = computed(() => {
    const n = this.comments().length;
    return n ? `Submit review with ${n} ${n === 1 ? 'comment' : 'comments'}` : 'Submit review';
  });

  constructor() {
    // Focus the panel, not Submit: a stray Enter must never post a review.
    afterNextRender(() => {
      if (this.props().status === 'pending') this.panel().nativeElement.focus({ preventScroll: true });
    });
  }

  protected id(part: string) {
    return `review-${this.props().toolCallId}-${part}`;
  }

  /** Edit / Remove inside the diffs change the working copy only. */
  protected readonly onDiffEvent = (e: UiEvent) => {
    if (!this.interactive()) return;
    const payload = (e.payload ?? {}) as { id?: unknown; body?: unknown };
    if (typeof payload.id !== 'number') return;
    const id = payload.id;
    if (e.name === 'comment-edit' && typeof payload.body === 'string' && payload.body.trim()) {
      const body = payload.body.trim().slice(0, 1000);
      this.bodies.update((m) => new Map(m).set(id, body));
    } else if (e.name === 'comment-remove') {
      this.kept.update((s) => new Set([...s].filter((x) => x !== id)));
    }
  };

  protected restore() {
    this.kept.set(new Set(this.props().comments.map((c) => c.id)));
  }

  protected decide(name: 'approve' | 'reject') {
    if (!this.interactive()) return;
    this.submitted.set(true);
    const { toolCallId } = this.props();
    if (name === 'reject') {
      this.emit()?.({ component: 'PrReview', name, payload: { toolCallId } });
      return;
    }
    const comments = this.comments();
    const edits: PrReviewEdits = {
      event: this.event(),
      summary: this.summary().trim(),
      comments: comments.map((c) => ({ id: c.id, body: c.body })),
    };
    this.emit()?.({ component: 'PrReview', name, payload: { toolCallId, selected: comments.map((c) => c.id), edits } });
  }
}
