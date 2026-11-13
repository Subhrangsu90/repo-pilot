import { afterNextRender, afterRenderEffect, Component, computed, ElementRef, input, linkedSignal, signal, viewChild } from '@angular/core';
import { EmitFn, githubUrl, PropsOf, ReleaseEdits } from '@repopilot/shared';
import { Icon } from '../../shared/ui/icon';

type Props = PropsOf<'ReleaseForm'>;
type Sections = Props['sections'];
type SectionKey = keyof Sections;
type Entry = Sections['features'][number];

const SECTIONS: { key: SectionKey; title: string }[] = [
  { key: 'features', title: 'Features' },
  { key: 'fixes', title: 'Fixes' },
  { key: 'breaking', title: 'Breaking changes' },
];

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * An agent-drafted release (design system FormSurface; Screen Spec "Release
 * builder"): the draft form beside a live preview. Shared state between agent
 * and user: fields the user changed say "edited by you". Nothing is published
 * until Review and publish, then Publish release. "Ask agent to rewrite" sends
 * the user's values back so the agent keeps them.
 */
@Component({
  selector: 'app-release-form',
  imports: [Icon],
  host: { class: 'block' },
  template: `
    @let p = props();
    <div class="flex flex-wrap items-start gap-5">
      <section
        #form
        tabindex="-1"
        class="flex min-w-0 flex-[3_1_460px] flex-col gap-4 rounded-xl border border-border-strong bg-surface-1 p-6"
        [attr.aria-labelledby]="id('title')"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 [id]="id('title')" class="font-display text-h2">New release</h2>
          <span class="badge">
            Drafted by agent{{ editedCount() ? ' · you edited ' + editedCount() + (editedCount() === 1 ? ' field' : ' fields') : '' }}
          </span>
        </div>

        <fieldset class="flex flex-col gap-4" [disabled]="!interactive() || confirming()">
          <legend class="sr-only">Release details</legend>
          <div class="flex flex-wrap gap-3">
            <div class="flex min-w-0 flex-[1_1_160px] flex-col gap-1.5">
              <label [for]="id('tag')" class="flex justify-between gap-2 text-label text-fg-muted">
                Tag
                @if (tag() !== p.tag) {
                  <span class="text-caption text-risk">edited by you</span>
                }
              </label>
              <input
                #tagBox
                [id]="id('tag')"
                class="field bg-bg font-mono"
                [class.border-primary]="tag() !== p.tag"
                maxlength="40"
                [value]="tag()"
                (input)="tag.set(tagBox.value.trim())"
                [attr.aria-invalid]="tagError() ? true : null"
                [attr.aria-describedby]="tagError() ? id('tag-error') : null"
              />
              @if (tagError()) {
                <span [id]="id('tag-error')" class="text-body-sm text-danger">{{ tagError() }}</span>
              }
            </div>
            <div class="flex min-w-0 flex-[2_1_220px] flex-col gap-1.5">
              <label [for]="id('name')" class="flex justify-between gap-2 text-label text-fg-muted">
                Name
                @if (name() !== p.name) {
                  <span class="text-caption text-risk">edited by you</span>
                }
              </label>
              <input
                #nameBox
                [id]="id('name')"
                class="field bg-bg"
                [class.border-primary]="name() !== p.name"
                maxlength="120"
                [value]="name()"
                (input)="name.set(nameBox.value)"
              />
            </div>
          </div>

          @for (s of sectionList; track s.key) {
            @let entries = sections()[s.key];
            <div class="flex flex-col gap-2">
              <h3 class="text-label text-fg-muted">{{ s.title }}</h3>
              @for (e of entries; track $index; let i = $index) {
                <div class="flex min-h-11 items-center gap-2.5 rounded-md border border-border bg-surface-2 py-1 pr-1 pl-3 text-body-md">
                  <span class="min-w-0 flex-1">{{ e.text }}</span>
                  @if (e.pr && prUrl(e.pr); as url) {
                    <a [href]="url" target="_blank" rel="noopener noreferrer" class="shrink-0 font-mono text-body-sm text-fg-muted hover:text-fg">
                      #{{ e.pr }}<span class="sr-only"> (opens in a new tab)</span>
                    </a>
                  }
                  <button type="button" class="btn btn-ghost min-w-11 px-0" [attr.aria-label]="'Remove: ' + e.text" (click)="removeEntry(s.key, i)">
                    <app-icon name="cross" [size]="16" />
                  </button>
                </div>
              } @empty {
                <p class="text-body-sm text-fg-muted">None.</p>
              }
            </div>
          }

          <!-- Add entry -->
          <div class="flex flex-col gap-2 border-t border-border pt-4">
            <h3 class="text-label text-fg-muted">Add entry</h3>
            <div class="flex flex-wrap items-end gap-2">
              <label class="flex flex-col gap-1.5">
                <span class="sr-only">Section</span>
                <select #section class="field bg-bg" [value]="newSection()" (change)="newSection.set($any(section.value))">
                  @for (s of sectionList; track s.key) {
                    <option [value]="s.key">{{ s.title }}</option>
                  }
                </select>
              </label>
              <label class="flex min-w-0 flex-[1_1_200px] flex-col gap-1.5">
                <span class="sr-only">Entry text</span>
                <input
                  #text
                  class="field bg-bg"
                  maxlength="200"
                  placeholder="What changed, in plain words"
                  [value]="newText()"
                  (input)="newText.set(text.value)"
                  (keydown.enter)="$event.preventDefault(); addEntry()"
                />
              </label>
              <label class="flex flex-col gap-1.5">
                <span class="sr-only">Pull request</span>
                <select #pr class="field bg-bg" [value]="newPr()" (change)="newPr.set(pr.value)">
                  <option value="">No PR</option>
                  @for (pull of p.pulls; track pull.number) {
                    <option [value]="pull.number">#{{ pull.number }} {{ pull.title.slice(0, 40) }}</option>
                  }
                </select>
              </label>
              <button type="button" class="btn" [disabled]="!newText().trim()" (click)="addEntry()">Add</button>
            </div>
          </div>

          <label class="flex min-h-11 cursor-pointer items-center gap-3 text-body-md">
            <input #pre type="checkbox" class="checkbox" [checked]="prerelease()" (change)="prerelease.set(pre.checked)" />
            Mark as pre-release
          </label>
        </fieldset>

        @for (n of p.notes; track n) {
          <p class="text-body-sm text-fg-muted">{{ n }}</p>
        }

        @switch (p.status) {
          @case ('running') {
            <p role="status" class="flex items-center gap-2.5 rounded-md bg-neutral-soft px-3.5 py-3 text-body-md">
              <span class="size-4 animate-spin rounded-full border-2 border-fg border-t-transparent" aria-hidden="true"></span>
              Publishing the release…
            </p>
          }
          @case ('approved') {
            <div role="status" class="flex flex-col gap-2 rounded-md bg-success-soft px-3.5 py-3 text-body-md text-success">
              <span class="flex items-center gap-2.5"><app-icon name="check" [size]="16" [stroke]="3" />{{ p.result }}</span>
              @if (p.releaseUrl) {
                <a [href]="p.releaseUrl" target="_blank" rel="noopener noreferrer" class="text-body-sm text-fg underline underline-offset-2">
                  View the release on GitHub<span class="sr-only"> (opens in a new tab)</span>
                </a>
              }
            </div>
          }
          @case ('rejected') {
            <p role="status" class="flex items-center gap-2.5 rounded-md bg-neutral-soft px-3.5 py-3 text-body-md text-fg-muted">
              <app-icon name="cross" [size]="16" [stroke]="2.5" />Discarded. Nothing was published.
            </p>
          }
          @case ('failed') {
            <p role="alert" class="flex items-center gap-2.5 rounded-md bg-danger-soft px-3.5 py-3 text-body-md text-danger">
              <app-icon name="cross" [size]="16" [stroke]="2.5" />{{ p.result }}
            </p>
          }
          @default {
            @if (confirming()) {
              <!-- The approval step: what publishing does, before it happens. -->
              <div #confirm tabindex="-1" class="flex flex-col gap-3 rounded-lg border border-border-strong bg-surface-2 p-4" role="group" [attr.aria-labelledby]="id('confirm')">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <h3 [id]="id('confirm')" class="text-body font-semibold">Publish {{ tag() }}?</h3>
                  <span class="badge badge-write">Write · needs approval</span>
                </div>
                <p class="text-body-sm text-fg-muted">
                  Creates the tag <span class="font-mono text-fg">{{ tag() }}</span> on
                  <span class="font-mono text-fg">{{ p.target }}</span> and publishes the release on GitHub{{ prerelease() ? ' as a pre-release' : '' }}.
                  To undo, delete the release and its tag on GitHub.
                </p>
                <div class="flex flex-wrap justify-end gap-2.5">
                  <button type="button" class="btn" [disabled]="!interactive()" (click)="confirming.set(false)">Back to editing</button>
                  <button type="button" class="btn btn-primary" [disabled]="!interactive()" (click)="decide('approve')">
                    @if (submitted()) {
                      <span class="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true"></span>
                      Sending…
                    } @else {
                      Publish release
                    }
                  </button>
                </div>
              </div>
            } @else {
              @if (problem(); as why) {
                <p class="text-body-sm text-danger">{{ why }}</p>
              }
              <div class="flex flex-wrap justify-end gap-2.5">
                <button type="button" class="btn" [disabled]="!interactive()" (click)="decide('reject')">Discard</button>
                <button type="button" class="btn" [disabled]="!interactive() || !!problem()" (click)="decide('rewrite')">Ask agent to rewrite</button>
                <button type="button" class="btn btn-primary" [disabled]="!interactive() || !!problem()" (click)="confirming.set(true)">
                  Review and publish
                </button>
              </div>
            }
          }
        }
      </section>

      <!-- Live preview, GitHub style. -->
      <aside class="flex min-w-0 flex-[2_1_300px] flex-col gap-3 rounded-xl border border-border bg-bg p-6" aria-label="Preview">
        <span class="text-caption text-fg-faint">Preview</span>
        <div class="flex flex-wrap items-center gap-2.5">
          <h3 class="font-display text-h2">{{ tag() }} — {{ name() }}</h3>
          @if (prerelease()) {
            <span class="badge">Pre-release</span>
          } @else {
            <span class="badge badge-success">Latest</span>
          }
        </div>
        <p class="text-body-sm text-fg-muted">
          {{ p.stats.commits }} {{ p.stats.commits === 1 ? 'commit' : 'commits' }} · {{ p.stats.pullRequests }} pull
          {{ p.stats.pullRequests === 1 ? 'request' : 'requests' }} · {{ p.stats.contributors }}
          {{ p.stats.contributors === 1 ? 'contributor' : 'contributors' }}
          {{ p.previousTag ? 'since ' + p.previousTag : '' }}
        </p>
        @for (s of sectionList; track s.key) {
          @if (sections()[s.key].length) {
            <h4 class="mt-2 text-body font-semibold">{{ s.title }}</h4>
            <ul class="flex list-disc flex-col gap-1 pl-5 text-body-md">
              @for (e of sections()[s.key]; track $index) {
                <li>
                  {{ e.text }}
                  @if (e.pr) {
                    <span class="font-mono text-body-sm text-fg-muted">#{{ e.pr }}</span>
                  }
                </li>
              }
            </ul>
          }
        }
      </aside>
    </div>
  `,
})
export class ReleaseForm {
  readonly props = input.required<Props>();
  readonly emit = input<EmitFn>();

  protected readonly sectionList = SECTIONS;
  private readonly form = viewChild.required<ElementRef<HTMLElement>>('form');
  private readonly confirmBox = viewChild<ElementRef<HTMLElement>>('confirm');

  // The user's working copy; every field resets when the server re-sends the surface.
  protected readonly tag = linkedSignal<Props, string>({ source: this.props, computation: (p) => p.tag });
  protected readonly name = linkedSignal<Props, string>({ source: this.props, computation: (p) => p.name });
  protected readonly prerelease = linkedSignal<Props, boolean>({ source: this.props, computation: (p) => p.prerelease });
  protected readonly sections = linkedSignal<Props, Sections>({ source: this.props, computation: (p) => p.sections });
  protected readonly confirming = linkedSignal<Props, boolean>({ source: this.props, computation: () => false });
  protected readonly submitted = linkedSignal<Props, boolean>({ source: this.props, computation: () => false });

  protected readonly newSection = signal<SectionKey>('features');
  protected readonly newText = signal('');
  protected readonly newPr = signal('');

  protected readonly interactive = computed(() => this.props().status === 'pending' && !this.submitted());

  protected readonly edits = computed<ReleaseEdits>(() => ({
    tag: this.tag(),
    name: this.name().trim(),
    prerelease: this.prerelease(),
    sections: this.sections(),
  }));

  /** Which fields differ from the agent's draft. */
  protected readonly changed = computed(() => {
    const p = this.props();
    const fields: string[] = [];
    if (this.tag() !== p.tag) fields.push('tag');
    if (this.name() !== p.name) fields.push('name');
    if (this.prerelease() !== p.prerelease) fields.push('prerelease');
    for (const s of SECTIONS) if (JSON.stringify(this.sections()[s.key]) !== JSON.stringify(p.sections[s.key])) fields.push(s.key);
    return fields;
  });
  protected readonly editedCount = computed(() => this.changed().length);

  protected readonly tagError = computed(() => (ReleaseEdits.shape.tag.safeParse(this.tag()).success ? null : 'Use a version tag such as v1.2.0.'));
  /** Why the draft cannot be published as it stands, or null. */
  protected readonly problem = computed(() => {
    const check = ReleaseEdits.safeParse(this.edits());
    if (check.success) return null;
    const issue = check.error.issues[0];
    return issue.path[0] === 'name' ? 'Give the release a name.' : issue.path[0] === 'tag' ? 'Fix the tag first.' : issue.message;
  });

  constructor() {
    // Focus the form, not a button: a stray Enter must never publish.
    afterNextRender(() => {
      if (this.props().status === 'pending') this.form().nativeElement.focus({ preventScroll: true });
    });
    // Move focus to the confirm step when it opens.
    afterRenderEffect(() => {
      if (this.confirming()) this.confirmBox()?.nativeElement.focus();
    });
  }

  protected id(part: string) {
    return `release-${this.props().toolCallId}-${part}`;
  }

  protected prUrl(n: number): string | null {
    const repo = this.props().repo;
    return REPO.test(repo) ? githubUrl.pullRequest(repo, n) : null;
  }

  protected removeEntry(key: SectionKey, index: number) {
    this.sections.update((s) => ({ ...s, [key]: s[key].filter((_, i) => i !== index) }));
  }

  protected addEntry() {
    const text = this.newText().trim().slice(0, 200);
    if (!text) return;
    const pr = Number(this.newPr());
    const entry: Entry = Number.isInteger(pr) && pr > 0 ? { text, pr } : { text };
    const key = this.newSection();
    this.sections.update((s) => ({ ...s, [key]: [...s[key], entry].slice(0, 30) }));
    this.newText.set('');
    this.newPr.set('');
  }

  protected decide(name: 'approve' | 'reject' | 'rewrite') {
    if (!this.interactive()) return;
    if (name !== 'reject' && this.problem()) return;
    this.submitted.set(true);
    const { toolCallId } = this.props();
    const payload =
      name === 'reject' ? { toolCallId } : name === 'approve' ? { toolCallId, edits: this.edits() } : { toolCallId, edits: this.edits(), changed: this.changed() };
    this.emit()?.({ component: 'ReleaseForm', name, payload });
  }
}
