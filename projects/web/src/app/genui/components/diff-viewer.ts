import { Component, computed, effect, ElementRef, inject, input, signal, untracked } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';
import { ClientTools } from '../../core/client-tools';

type Props = PropsOf<'DiffViewer'>;
type Line = Props['lines'][number];
type Comment = Props['comments'][number];

/**
 * A unified diff of one file with review comments between its lines (design
 * system DiffViewer). Code is always rendered as text, never as HTML, and the
 * body scrolls sideways instead of wrapping. With `editable`, each comment has
 * Edit and Remove; the changes go out as `comment-edit` / `comment-remove`
 * events and the owner (PrReview) keeps the state.
 */
@Component({
  selector: 'app-diff-viewer',
  host: { class: 'block' },
  template: `
    @let p = props();
    <section class="overflow-hidden rounded-lg border border-border" [attr.aria-label]="'Changes in ' + p.path">
      <header class="flex flex-wrap items-center justify-between gap-2.5 border-b border-border bg-surface-1 px-4 py-3">
        <span class="flex min-w-0 items-center gap-3">
          <span class="truncate font-mono text-body-sm" [title]="p.path">{{ p.path }}</span>
          @if (p.additions !== undefined && p.deletions !== undefined) {
            <span class="shrink-0 font-mono text-body-sm tabular-nums">
              <span class="text-success">+{{ p.additions }}</span> <span class="text-danger">−{{ p.deletions }}</span>
            </span>
          }
        </span>
        <span class="badge badge-agent">
          <span class="size-1.5 rounded-full bg-fg" aria-hidden="true"></span>
          Rendered by agent · DiffViewer
        </span>
      </header>

      <div class="overflow-x-auto bg-bg font-mono text-body-sm">
        <div class="min-w-max py-1">
          @for (line of p.lines; track $index) {
            @if (line.kind === 'hunk') {
              <div class="bg-surface-1 px-4 py-1 whitespace-pre text-fg-muted">{{ line.text }}</div>
            } @else {
              @let lit = isLit(line);
              <div
                class="flex"
                [class.bg-success-soft]="line.kind === 'add'"
                [class.bg-danger-soft]="line.kind === 'del'"
                [class.outline-2]="lit"
                [class.-outline-offset-2]="lit"
                [class.outline-fg]="lit"
                [attr.data-highlighted]="lit ? '' : null"
              >
                @if (lit) {
                  <span class="sr-only">Highlighted by the agent. </span>
                }
                <span class="w-13 shrink-0 pr-3 text-right text-fg-faint select-none" aria-hidden="true">{{ number(line) }}</span>
                <span
                  class="w-5 shrink-0 select-none"
                  [class.text-success]="line.kind === 'add'"
                  [class.text-danger]="line.kind === 'del'"
                  aria-hidden="true"
                  >{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ' }}</span
                >
                <span class="sr-only">{{ line.kind === 'add' ? 'Added line ' + line.new : line.kind === 'del' ? 'Removed line' : 'Line ' + line.new }}: </span>
                <span class="pr-4 whitespace-pre">{{ line.text }}</span>
              </div>
              @if (line.kind !== 'del' && line.new) {
                @for (c of commentsAt().get(line.new) ?? []; track c.id) {
                  @let issue = c.severity === 'issue';
                  <article
                    class="sticky left-0 my-2 mr-4 ml-18 flex max-w-[640px] flex-col gap-2.5 rounded-lg border bg-surface-2 p-4 font-sans whitespace-normal"
                    [class]="issue ? 'border-danger' : 'border-border-strong'"
                    [attr.aria-label]="(issue ? 'Issue' : 'Suggestion') + ' on line ' + c.line"
                  >
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="badge" [class.badge-danger]="issue">{{ issue ? 'Issue' : 'Suggestion' }}</span>
                      <span class="text-caption text-fg-muted">RepoPilot · line {{ c.line }}</span>
                    </div>
                    @if (editing() === c.id) {
                      <label class="sr-only" [for]="'comment-' + c.id">Comment text</label>
                      <textarea
                        #box
                        [id]="'comment-' + c.id"
                        class="field h-auto min-h-24 py-2.5"
                        maxlength="1000"
                        [value]="draft()"
                        (input)="draft.set(box.value)"
                      ></textarea>
                      <div class="flex flex-wrap gap-2">
                        <button type="button" class="btn" [disabled]="!draft().trim()" (click)="save(c.id)">Save</button>
                        <button type="button" class="btn btn-ghost" (click)="editing.set(null)">Cancel</button>
                      </div>
                    } @else {
                      <p class="text-body whitespace-pre-line">{{ c.body }}</p>
                      @if (editable()) {
                        <div class="flex flex-wrap gap-2">
                          <button type="button" class="btn" (click)="edit(c)">Edit<span class="sr-only"> comment on line {{ c.line }}</span></button>
                          <button type="button" class="btn btn-ghost" (click)="remove(c.id)">
                            Remove<span class="sr-only"> comment on line {{ c.line }}</span>
                          </button>
                        </div>
                      }
                    }
                  </article>
                }
              }
            }
          }
        </div>
      </div>
    </section>
  `,
})
export class DiffViewer {
  readonly props = input.required<Props>();
  readonly emit = input<EmitFn>();
  /** Show Edit / Remove on comments (inside a pending PrReview). */
  readonly editable = input(false);

  protected readonly editing = signal<number | null>(null);
  protected readonly draft = signal('');

  private readonly clientTools = inject(ClientTools);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The agent's highlight_lines request, when it is for this file and its lines are in this diff. */
  protected readonly lit = computed(() => {
    const h = this.clientTools.highlight();
    const p = this.props();
    if (!h || !samePath(h.path, p.path)) return null;
    const hit = p.lines.some((l) => l.kind !== 'hunk' && l.kind !== 'del' && l.new !== undefined && l.new >= h.from && l.new <= h.to);
    return hit ? h : null;
  });

  constructor() {
    // Claim the highlight and bring its first line into view.
    effect(() => {
      const h = this.lit();
      if (!h) return;
      untracked(() => {
        this.clientTools.shown(h.seq);
        setTimeout(() => {
          const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
          this.host.nativeElement.querySelector('[data-highlighted]')?.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
        });
      });
    });
  }

  protected isLit(line: Line): boolean {
    const h = this.lit();
    return !!h && line.kind !== 'hunk' && line.kind !== 'del' && line.new !== undefined && line.new >= h.from && line.new <= h.to;
  }

  /** Comments by the new-file line they sit under. */
  protected readonly commentsAt = computed(() => {
    const map = new Map<number, Comment[]>();
    for (const c of this.props().comments) map.set(c.line, [...(map.get(c.line) ?? []), c]);
    return map;
  });

  protected number(line: Line) {
    return line.kind === 'del' ? line.old : line.new;
  }

  protected edit(c: Comment) {
    this.draft.set(c.body);
    this.editing.set(c.id);
  }

  protected save(id: number) {
    const body = this.draft().trim();
    if (!body) return;
    this.emit()?.({ component: 'DiffViewer', name: 'comment-edit', payload: { id, body } });
    this.editing.set(null);
  }

  protected remove(id: number) {
    this.emit()?.({ component: 'DiffViewer', name: 'comment-remove', payload: { id } });
  }
}

/** "./src/auth/login.js" and "src/auth/login.js" are the same file. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.trim().replace(/^\.?\//, '');
  return norm(a) === norm(b);
}
