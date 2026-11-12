import { HttpClient, HttpErrorResponse, httpResource } from '@angular/common/http';
import { valueOf } from '../../core/resource';
import { Component, computed, ElementRef, inject, linkedSignal, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuditEntry, formatWhen } from '../../core/api';

type Filter = 'all' | 'write' | 'destructive' | 'undone';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'write', label: 'Write' },
  { value: 'destructive', label: 'Destructive' },
  { value: 'undone', label: 'Undone' },
];

/**
 * Screen Spec "Audit log": every change the agent made after an approval, who
 * approved it, what happened, and Undo for reversible ones. Undo asks for
 * confirmation first and runs the stored inverse on the server (no model).
 */
@Component({
  selector: 'app-audit-log',
  imports: [RouterLink],
  host: { class: 'block' },
  template: `
    <div class="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-4 py-8 sm:px-8">
      <div class="flex flex-col gap-1.5">
        <h1 class="font-display text-h1">Audit log</h1>
        <p class="text-body text-fg-muted">Every change the agent made, who approved it, and how to undo it.</p>
      </div>

      <div class="flex flex-wrap gap-2" role="group" aria-label="Filter changes">
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

      @if (notice(); as n) {
        <p class="rounded-md px-4 py-3 text-body-sm" [class]="n.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'" role="status">
          {{ n.text }}
        </p>
      }

      @if (entries.error(); as err) {
        <p class="card border-danger p-4 text-body-sm" role="alert">{{ message(err) }}</p>
      } @else if (entries.isLoading() && !entries.hasValue()) {
        <div class="h-64 animate-pulse rounded-lg bg-surface-3" aria-hidden="true"></div>
      } @else {
        <div class="card overflow-x-auto">
          <table class="w-full min-w-[760px] border-collapse text-left text-body-md">
            <caption class="sr-only">Changes made by the agent</caption>
            <thead class="text-body-sm text-fg-faint">
              <tr>
                <th scope="col" class="px-5 py-2.5 font-normal">When</th>
                <th scope="col" class="px-2.5 py-2.5 font-normal">Action</th>
                <th scope="col" class="px-2.5 py-2.5 font-normal">Risk</th>
                <th scope="col" class="px-2.5 py-2.5 font-normal">Approved by</th>
                <th scope="col" class="px-2.5 py-2.5 font-normal">Result</th>
                <th scope="col" class="px-5 py-2.5 text-right font-normal">Undo</th>
              </tr>
            </thead>
            <tbody>
              @for (e of list(); track e.id) {
                <tr class="border-t border-border" [class.bg-neutral-soft]="selected()?.id === e.id">
                  <td class="px-5 py-3 whitespace-nowrap text-fg-muted">{{ when(e.createdAt) }}</td>
                  <td class="px-2.5 py-3">
                    <button
                      type="button"
                      class="flex min-h-11 cursor-pointer flex-col items-start text-left hover:underline"
                      [attr.aria-expanded]="selected()?.id === e.id"
                      (click)="select(e.id)"
                    >
                      <span>{{ e.summary }}</span>
                      <span class="font-mono text-caption text-fg-muted">{{ e.tool }}</span>
                    </button>
                  </td>
                  <td class="px-2.5 py-3">
                    <span class="badge" [class]="e.risk === 'destructive' ? 'badge-risk' : 'badge-write'">
                      {{ e.risk === 'destructive' ? 'Destructive' : 'Write' }}
                    </span>
                  </td>
                  <td class="px-2.5 py-3 font-mono text-body-sm">{{ e.approvedBy }}</td>
                  <td class="px-2.5 py-3">
                    @if (e.undoneAt) {
                      <span class="text-fg-muted">Undone</span>
                    } @else if (!e.ok) {
                      <span class="text-danger">Failed: {{ e.result }}</span>
                    } @else {
                      {{ e.result }}
                    }
                  </td>
                  <td class="px-5 py-3 text-right">
                    @if (e.undoable) {
                      <button type="button" class="btn" [disabled]="busy()" (click)="ask(e)">
                        Undo<span class="sr-only"> {{ e.summary }}</span>
                      </button>
                    } @else if (e.undoneAt) {
                      <span class="text-body-sm text-fg-muted">Already undone</span>
                    } @else {
                      <span class="text-body-sm text-fg-muted">Undo on GitHub</span>
                    }
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="6" class="px-5 py-8 text-center text-body-sm text-fg-muted">
                    {{ filter() === 'all' ? 'No changes yet. Approved changes show up here.' : 'No changes match this filter.' }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if (selected(); as e) {
          <section class="card flex flex-col gap-4 bg-surface-1 p-6" [attr.aria-labelledby]="'detail-' + e.id">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h2 [id]="'detail-' + e.id" class="font-display text-h2">{{ e.summary }}</h2>
              <span class="font-mono text-body-sm text-fg-muted">{{ e.id }}</span>
            </div>
            <dl class="grid gap-x-6 gap-y-2 text-body-sm sm:grid-cols-[auto_1fr]">
              @if (e.prompt) {
                <dt class="text-fg-faint">Original prompt</dt>
                <dd>“{{ e.prompt }}”</dd>
              }
              @if (e.keptByUser.length) {
                <dt class="text-fg-faint">Left out by you</dt>
                <dd class="font-mono">{{ issues(e.keptByUser) }}</dd>
              }
              <dt class="text-fg-faint">Undo</dt>
              <dd>
                @if (e.undoneAt) {
                  Done {{ when(e.undoneAt) }}: {{ e.undoResult }}
                } @else if (e.inverse) {
                  {{ e.inverse.label }}
                } @else {
                  Not reversible from RepoPilot; change it on GitHub.
                }
              </dd>
              @if (e.sessionId) {
                <dt class="text-fg-faint">Session</dt>
                <dd><a class="underline underline-offset-2" [routerLink]="['/ask']" [queryParams]="{ session: e.sessionId }">Open the conversation</a></dd>
              }
            </dl>
            <details class="text-body-sm">
              <summary class="flex min-h-11 cursor-pointer items-center text-fg-muted">Raw call (JSON)</summary>
              <pre class="mt-2 max-h-80 overflow-auto rounded-sm bg-bg p-3 font-mono text-caption text-fg-muted">{{ raw(e) }}</pre>
            </details>
          </section>
        }
      }

      <!-- Confirm before Undo: it changes the repository on GitHub. -->
      <dialog
        #confirm
        class="m-auto w-[min(480px,calc(100vw-32px))] rounded-xl border border-border-strong bg-surface-1 p-6 text-fg backdrop:bg-bg/70"
        aria-labelledby="undo-title"
        (close)="pending.set(null)"
      >
        @if (pending(); as e) {
          <div class="flex flex-col gap-4">
            <h2 id="undo-title" class="font-display text-h2">Undo “{{ e.summary }}”?</h2>
            <p class="text-body text-fg-muted">{{ e.inverse?.label }}. This changes the repository on GitHub.</p>
            <div class="flex flex-wrap justify-end gap-2.5">
              <button type="button" class="btn" autofocus (click)="confirm.close()">Cancel</button>
              <button type="button" class="btn" [class]="e.inverse?.destructive ? 'btn-risk' : 'btn-primary'" (click)="undo(e)">
                Undo change
              </button>
            </div>
          </div>
        }
      </dialog>
    </div>
  `,
})
export class AuditLog {
  private readonly http = inject(HttpClient);
  protected readonly filters = FILTERS;
  protected readonly filter = signal<Filter>('all');
  protected readonly entries = httpResource<{ items: AuditEntry[] }>(() => ({ url: '/api/audit', params: { filter: this.filter() } }));
  protected readonly list = computed(() => valueOf(this.entries)?.items ?? []);
  protected readonly selectedId = linkedSignal<AuditEntry[], string | null>({
    source: this.list,
    computation: (list, prev) => (prev && list.some((e) => e.id === prev.value) ? prev.value : null),
  });
  protected readonly selected = computed(() => this.list().find((e) => e.id === this.selectedId()) ?? null);
  protected readonly pending = signal<AuditEntry | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly when = formatWhen;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('confirm');

  protected select(id: string) {
    this.selectedId.set(this.selectedId() === id ? null : id);
  }

  protected ask(entry: AuditEntry) {
    this.notice.set(null);
    this.pending.set(entry);
    this.dialog().nativeElement.showModal();
  }

  protected async undo(entry: AuditEntry) {
    this.dialog().nativeElement.close();
    this.busy.set(true);
    try {
      const done = await firstValueFrom(this.http.post<AuditEntry>(`/api/audit/${encodeURIComponent(entry.id)}/undo`, {}));
      this.notice.set({ ok: true, text: `Undone: ${done.undoResult ?? entry.summary}` });
    } catch (err) {
      this.notice.set({ ok: false, text: `Undo failed: ${this.message(err)}` });
    } finally {
      this.busy.set(false);
      this.entries.reload();
    }
  }

  protected issues(ids: number[]) {
    return ids.map((n) => `#${n}`).join(', ');
  }

  protected raw(e: AuditEntry) {
    return JSON.stringify({ tool: e.tool, input: e.input, approvedIds: e.approvedIds, response: e.response }, null, 2);
  }

  protected message(err: unknown): string {
    if (err instanceof HttpErrorResponse) return err.error?.error ?? err.message;
    return err instanceof Error ? err.message : String(err);
  }
}
