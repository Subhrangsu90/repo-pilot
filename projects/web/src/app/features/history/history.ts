import { HttpClient, HttpErrorResponse, httpResource } from '@angular/common/http';
import { Component, computed, ElementRef, inject, linkedSignal, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AgentSession } from '../../core/agent-session';
import { dayDiff, formatWhen, SessionSummary } from '../../core/api';

type Filter = 'all' | 'waiting' | 'changes' | 'read';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'waiting', label: 'Waiting for approval' },
  { value: 'changes', label: 'Made changes' },
  { value: 'read', label: 'Read only' },
];

const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** The status tag of a session card. */
function statusOf(s: SessionSummary): { label: string; cls: string } {
  if (s.status === 'awaiting-approval') return { label: 'Waiting for you', cls: 'badge-write' };
  if (s.madeChanges) return { label: 'Made changes', cls: 'badge-success' };
  return { label: 'Read only', cls: '' };
}

/**
 * Screen Spec "History": every conversation is saved (doc §9b). Search and
 * filter them, preview one, rename or delete it, or resume it in Ask, where it
 * replays without calling the model and a waiting approval still works.
 */
@Component({
  selector: 'app-history',
  imports: [RouterLink],
  host: { class: 'block' },
  template: `
    <div class="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-4 py-8 sm:px-8">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div class="flex flex-col gap-1.5">
          <h1 class="font-display text-h1">History</h1>
          <p class="text-body text-fg-muted">Every conversation is saved. Reopen one to see what the agent showed, or pick up where it stopped.</p>
        </div>
        <button type="button" class="btn btn-primary" (click)="newSession()">New session</button>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <label class="flex min-w-0 flex-[1_1_280px] flex-col gap-1.5">
          <span class="sr-only">Search sessions</span>
          <input
            #search
            type="search"
            class="field"
            placeholder="Search titles and prompts, e.g. #15"
            maxlength="100"
            [value]="query()"
            (input)="query.set(search.value)"
          />
        </label>
        <div class="flex flex-wrap gap-2" role="group" aria-label="Filter sessions">
          @for (f of filters; track f.value) {
            <button
              type="button"
              class="chip aria-pressed:border-fg aria-pressed:bg-surface-3 aria-pressed:text-fg"
              [attr.aria-pressed]="filter() === f.value"
              (click)="filter.set(f.value)"
            >
              {{ f.label }}
            </button>
          }
        </div>
      </div>

      @if (notice(); as n) {
        <p class="rounded-md bg-danger-soft px-4 py-3 text-body-sm text-danger" role="alert">{{ n }}</p>
      }

      @if (sessions.error(); as err) {
        <p class="card border-danger p-4 text-body-sm" role="alert">{{ message(err) }}</p>
      } @else {
        <div class="flex flex-wrap items-start gap-5">
          <div class="flex min-w-0 flex-[3_1_480px] flex-col gap-5" aria-live="polite">
            @for (g of groups(); track g.label) {
              <section class="flex flex-col gap-2" [attr.aria-labelledby]="'group-' + g.label">
                <h2 [id]="'group-' + g.label" class="text-label text-fg-muted">
                  {{ g.label }} <span class="text-fg-faint">({{ g.items.length }})</span>
                </h2>
                <ul class="flex flex-col gap-2">
                  @for (s of g.items; track s.id) {
                    @let st = status(s);
                    <li>
                      <button
                        type="button"
                        class="card flex w-full cursor-pointer flex-col gap-2 p-4 text-left hover:bg-surface-3 aria-pressed:border-fg aria-pressed:bg-surface-3"
                        [attr.aria-pressed]="selected()?.id === s.id"
                        (click)="selectedId.set(s.id)"
                      >
                        <span class="flex flex-wrap items-center gap-2.5">
                          <span class="text-body font-semibold">{{ s.title }}</span>
                          <span class="badge" [class]="st.cls">{{ st.label }}</span>
                          <span class="ml-auto text-body-sm text-fg-muted">{{ clock(s.updatedAt) }}</span>
                        </span>
                        @if (s.lastResult) {
                          <span class="line-clamp-2 text-body-sm text-fg-muted">{{ s.lastResult }}</span>
                        }
                        <span class="flex flex-wrap items-center gap-2 text-caption text-fg-muted">
                          <span class="font-mono">{{ s.repo }}</span>
                          @for (c of s.components; track c) {
                            <span class="badge px-2 py-0.5 font-mono font-normal">{{ c }}</span>
                          }
                        </span>
                      </button>
                    </li>
                  }
                </ul>
              </section>
            } @empty {
              @if (sessions.isLoading()) {
                <div class="h-48 animate-pulse rounded-lg bg-surface-3" aria-hidden="true"></div>
              } @else {
                <p class="card p-6 text-center text-body-sm text-fg-muted">
                  {{ filter() === 'all' && !query().trim() ? 'No sessions yet. Ask something to start one.' : 'No sessions match this filter.' }}
                </p>
              }
            }
          </div>

          @if (selected(); as s) {
            <aside class="flex min-w-0 flex-[2_1_320px] flex-col gap-4 rounded-xl border border-border-strong bg-surface-1 p-6" aria-label="Session preview">
              <span class="text-body-sm text-fg-muted"><span class="font-mono">{{ s.repo }}</span> · {{ when(s.updatedAt) }}</span>

              @if (renaming()) {
                <form class="flex flex-wrap items-end gap-2" (submit)="rename($event, s)">
                  <label class="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span class="text-label text-fg-muted">Title</span>
                    <input #title class="field bg-bg" maxlength="80" [value]="s.title" (input)="newTitle.set(title.value)" />
                  </label>
                  <button type="submit" class="btn" [disabled]="!newTitle().trim()">Save</button>
                  <button type="button" class="btn btn-ghost" (click)="renaming.set(false)">Cancel</button>
                </form>
              } @else {
                <h2 class="font-display text-h2">{{ s.title }}</h2>
              }

              @if (s.prompt) {
                <p class="rounded-lg rounded-br-sm bg-surface-3 px-4 py-3 text-body">{{ s.prompt }}</p>
              }
              @if (s.components.length) {
                <div class="flex flex-wrap gap-1.5">
                  @for (c of s.components; track c) {
                    <span class="badge badge-agent">{{ c }}</span>
                  }
                </div>
              }
              @if (s.status === 'awaiting-approval') {
                <p class="rounded-md bg-neutral-soft px-3.5 py-3 text-body-md">Waiting for you: a change in this session needs your approval.</p>
              }
              <p class="text-body-sm text-fg-muted">
                Data captured {{ when(s.updatedAt) }}, {{ s.turns }} {{ s.turns === 1 ? 'prompt' : 'prompts' }}. Reopening shows it as it was; ask again for fresh data.
              </p>

              <div class="flex flex-wrap justify-end gap-2.5">
                <button type="button" class="btn btn-ghost" (click)="askDelete(s)">Delete</button>
                <button type="button" class="btn" (click)="startRename(s)">Rename</button>
                <a class="btn btn-primary" [routerLink]="['/ask']" [queryParams]="{ session: s.id }">Resume session</a>
              </div>
            </aside>
          }
        </div>
      }

      <dialog
        #confirm
        class="m-auto w-[min(440px,calc(100vw-32px))] rounded-xl border border-border-strong bg-surface-1 p-6 text-fg backdrop:bg-bg/70"
        aria-labelledby="delete-title"
        (close)="deleting.set(null)"
      >
        @if (deleting(); as s) {
          <div class="flex flex-col gap-4">
            <h2 id="delete-title" class="font-display text-h2">Delete “{{ s.title }}”?</h2>
            <p class="text-body text-fg-muted">The conversation is removed from History. Changes it made stay in the audit log.</p>
            <div class="flex flex-wrap justify-end gap-2.5">
              <button type="button" class="btn" autofocus (click)="confirm.close()">Cancel</button>
              <button type="button" class="btn btn-primary" (click)="remove(s)">Delete session</button>
            </div>
          </div>
        }
      </dialog>
    </div>
  `,
})
export class History {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly agent = inject(AgentSession);

  protected readonly filters = FILTERS;
  protected readonly filter = signal<Filter>('all');
  protected readonly query = signal('');
  protected readonly sessions = httpResource<{ items: SessionSummary[] }>(() => ({
    url: '/api/sessions',
    params: { filter: this.filter(), ...(this.query().trim() ? { q: this.query().trim() } : {}) },
  }));
  protected readonly list = computed(() => this.sessions.value()?.items ?? []);

  /** Today / Yesterday / Earlier, newest first, empty groups left out. */
  protected readonly groups = computed(() => {
    const now = new Date();
    const groups = [
      { label: 'Today', items: [] as SessionSummary[] },
      { label: 'Yesterday', items: [] as SessionSummary[] },
      { label: 'Earlier', items: [] as SessionSummary[] },
    ];
    for (const s of this.list()) groups[Math.min(2, dayDiff(new Date(s.updatedAt), now))].items.push(s);
    return groups.filter((g) => g.items.length);
  });

  /** The first session is selected until the user picks another; a vanished one falls back. */
  protected readonly selectedId = linkedSignal<SessionSummary[], string | null>({
    source: this.list,
    computation: (list, prev) => (prev && list.some((s) => s.id === prev.value) ? prev.value : (list[0]?.id ?? null)),
  });
  protected readonly selected = computed(() => this.list().find((s) => s.id === this.selectedId()) ?? null);

  protected readonly renaming = signal(false);
  protected readonly newTitle = signal('');
  protected readonly deleting = signal<SessionSummary | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly when = formatWhen;
  protected readonly status = statusOf;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('confirm');

  protected clock(iso: string) {
    return time.format(new Date(iso));
  }

  protected newSession() {
    this.agent.reset();
    void this.router.navigate(['/ask']);
  }

  protected startRename(s: SessionSummary) {
    this.newTitle.set(s.title);
    this.renaming.set(true);
  }

  protected async rename(event: Event, s: SessionSummary) {
    event.preventDefault();
    const title = this.newTitle().trim().slice(0, 80);
    if (!title) return;
    try {
      await firstValueFrom(this.http.patch(`/api/sessions/${s.id}`, { title }));
      this.renaming.set(false);
      this.sessions.reload();
    } catch (err) {
      this.notice.set(`Rename failed: ${this.message(err)}`);
    }
  }

  protected askDelete(s: SessionSummary) {
    this.deleting.set(s);
    this.dialog().nativeElement.showModal();
  }

  protected async remove(s: SessionSummary) {
    this.dialog().nativeElement.close();
    try {
      await firstValueFrom(this.http.delete(`/api/sessions/${s.id}`));
      if (this.agent.sessionId === s.id) this.agent.reset();
      this.sessions.reload();
    } catch (err) {
      this.notice.set(`Delete failed: ${this.message(err)}`);
    }
  }

  protected message(err: unknown): string {
    if (err instanceof HttpErrorResponse) return err.error?.error ?? err.message;
    return err instanceof Error ? err.message : String(err);
  }
}
