import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, linkedSignal, signal, untracked } from '@angular/core';
import type { EmitFn, PropsOf, UiEvent, UiNode } from '@repopilot/shared';
import { AgentSession } from '../../core/agent-session';
import { ServerStatus } from '../../core/server-status';
import { StepTimeline } from '../../genui/components/step-timeline';
import { GenUiHost } from '../../genui/genui-host';

type Row = PropsOf<'IssueTable'>['rows'][number];
type State = 'open' | 'closed' | 'all';

interface IssuesResponse {
  repo: string;
  rows: Row[];
  /** The server returns at most 100 issues. */
  truncated: boolean;
}

const STATES: { value: State; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

/** "#9, #10 and #11" */
export function issueRefs(numbers: number[]): string {
  const refs = numbers.map((n) => `#${n}`);
  return refs.length <= 1 ? refs.join('') : `${refs.slice(0, -1).join(', ')} and ${refs.at(-1)}`;
}

/** What the page asks the agent for; the approval card's dry run checks every number. */
export function bulkPrompt(action: 'close' | 'reopen', numbers: number[]): string {
  const noun = numbers.length === 1 ? 'issue' : 'issues';
  return action === 'close' ? `Close ${noun} ${issueRefs(numbers)} as not planned` : `Reopen ${noun} ${issueRefs(numbers)}`;
}

/**
 * Issues of the repository (no artboard; built from the IssueTable and the
 * approval gate). Filter by state and labels, tick rows, then ask the agent to
 * close or reopen them: its dry run shows an ApprovalCard here, nothing changes
 * before Approve, and approved changes land in the Audit log with Undo. Runs
 * its own agent conversation, separate from Ask.
 */
@Component({
  selector: 'app-issue-list',
  imports: [GenUiHost, StepTimeline],
  providers: [AgentSession],
  host: { class: 'block' },
  template: `
    <div class="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-4 py-8 sm:px-8">
      <div class="flex flex-col gap-1.5">
        <h1 class="font-display text-h1">Issues</h1>
        <p class="max-w-3xl text-body text-fg-muted">
          Tick issues to close or reopen them. The agent shows exactly what will change on an approval card; nothing
          reaches GitHub until you approve, and every change can be undone from the Audit log.
        </p>
      </div>

      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap gap-2" role="group" aria-label="Issue state">
          @for (s of states; track s.value) {
            <button
              type="button"
              class="chip aria-pressed:border-fg aria-pressed:bg-surface-3 aria-pressed:text-fg"
              [attr.aria-pressed]="state() === s.value"
              (click)="state.set(s.value)"
            >
              {{ s.label }}
            </button>
          }
        </div>
        @if (labels().length) {
          <div class="flex flex-wrap gap-2" role="group" aria-label="Filter by label">
            @for (label of labels(); track label) {
              <button
                type="button"
                class="chip aria-pressed:border-fg aria-pressed:bg-surface-3 aria-pressed:text-fg"
                [attr.aria-pressed]="picked().has(label)"
                (click)="toggleLabel(label)"
              >
                {{ label }}
              </button>
            }
          </div>
        }
      </div>

      @if (issues.isLoading() && !issues.hasValue()) {
        <div class="h-96 animate-pulse rounded-lg bg-surface-3" aria-hidden="true"></div>
      } @else if (issues.error()) {
        <div class="card flex items-center justify-between gap-3 border-danger p-4" role="alert">
          <span class="text-body-sm">Could not load issues.</span>
          <button type="button" class="btn" (click)="issues.reload()">Retry</button>
        </div>
      } @else if (table(); as node) {
        <app-genui-host [node]="node" [emit]="onEmit" />
        @if (issues.value()?.truncated) {
          <p class="text-body-sm text-fg-muted">Showing the first 100 issues.</p>
        }
      }

      @if (selectedRows().length) {
        <div class="card flex flex-wrap items-center gap-3 bg-surface-1 p-4" role="region" aria-label="Selected issues">
          <span class="text-body-md tabular-nums">{{ selectedRows().length }} selected</span>
          <span class="flex-1"></span>
          <button type="button" class="btn" [disabled]="!canAsk() || closable().length === 0" (click)="ask('close', closable())">
            Close {{ closable().length || '' }}…
          </button>
          <button type="button" class="btn" [disabled]="!canAsk() || reopenable().length === 0" (click)="ask('reopen', reopenable())">
            Reopen {{ reopenable().length || '' }}…
          </button>
        </div>
      }

      @if (turn(); as t) {
        <section class="flex flex-col gap-5" aria-live="polite" aria-label="Agent">
          <p class="ml-auto max-w-[min(520px,85%)] rounded-lg rounded-br-sm bg-surface-3 px-4 py-3 text-body">{{ t.prompt }}</p>

          @if (t.steps.length) {
            <app-step-timeline [props]="{ steps: t.steps }" [inline]="true" />
          }

          <!-- Only the gate: the issues themselves are already in the table above. -->
          @for (surface of t.surfaces; track surface.surfaceId) {
            @if (isGate(surface.node)) {
              <app-genui-host class="animate-genui-enter" [node]="surface.node" [emit]="onEmit" />
            }
          }

          @if (t.status === 'running' && !hasGate(t.surfaces)) {
            <div class="h-64 animate-pulse rounded-xl bg-surface-3" aria-hidden="true"></div>
          }
          @if (t.actionError) {
            <p class="card border-danger px-4 py-3 text-body-sm" role="alert">Your decision was not sent: {{ t.actionError }}</p>
          }
          @if (t.text) {
            <p class="max-w-[680px] text-body whitespace-pre-line text-fg-muted">{{ t.text }}</p>
          }
          @if (t.status === 'error') {
            <p class="card border-danger p-4 text-body-sm" role="alert">{{ t.error }}</p>
          }
        </section>
      }
    </div>
  `,
})
export class IssueList {
  protected readonly session = inject(AgentSession);
  private readonly status = inject(ServerStatus);

  protected readonly states = STATES;
  protected readonly state = signal<State>('open');
  protected readonly issues = httpResource<IssuesResponse>(() => ({ url: '/api/issues', params: { state: this.state() } }));

  /** Every label on the loaded issues, for the filter chips. */
  protected readonly labels = computed(() => [...new Set((this.issues.value()?.rows ?? []).flatMap((r) => r.labels))].sort());
  /** Picked labels; an issue must have all of them. Cleared when the state changes. */
  protected readonly picked = linkedSignal<State, ReadonlySet<string>>({ source: this.state, computation: () => new Set() });

  private readonly rows = computed(() => {
    const picked = [...this.picked()];
    return (this.issues.value()?.rows ?? []).filter((r) => picked.every((l) => r.labels.includes(l)));
  });

  protected readonly table = computed<UiNode | null>(() => {
    const res = this.issues.value();
    if (!res) return null;
    const label = STATES.find((s) => s.value === this.state())!.label;
    const filtered = this.picked().size ? ' with the picked labels' : '';
    return {
      component: 'IssueTable',
      props: {
        title: `${label} issues · ${res.repo}`.slice(0, 80),
        rows: this.rows(),
        selectable: true,
        emptyText: `No ${this.state() === 'all' ? '' : `${this.state()} `}issues${filtered}.`.slice(0, 80),
      },
    };
  });

  /** Ticked issue numbers, from the table's `select` events. The table clears its ticks on new rows, and so does this. */
  private readonly selected = linkedSignal<UiNode | null, number[]>({ source: this.table, computation: () => [] });
  protected readonly selectedRows = computed(() => {
    const ids = new Set(this.selected());
    return this.rows().filter((r) => ids.has(r.number));
  });
  protected readonly closable = computed(() => this.selectedRows().filter((r) => r.state === 'open').map((r) => r.number));
  protected readonly reopenable = computed(() => this.selectedRows().filter((r) => r.state === 'closed').map((r) => r.number));

  protected readonly turn = computed(() => this.session.turns().at(-1));
  protected readonly canAsk = computed(() => !this.session.isBusy() && !this.session.awaitingApproval());

  protected readonly onEmit: EmitFn = (event: UiEvent) => {
    if (event.component === 'IssueTable' && event.name === 'select') {
      const numbers = (event.payload as { numbers?: unknown } | undefined)?.numbers;
      this.selected.set(Array.isArray(numbers) ? numbers.filter((n): n is number => Number.isInteger(n)) : []);
      return;
    }
    this.session.handleUiEvent(event);
  };

  constructor() {
    // When a run settles (approved, rejected or failed), show the issues as they are now.
    let wasActive = false;
    effect(() => {
      const active = this.session.isBusy() || this.session.awaitingApproval();
      if (wasActive && !active) {
        untracked(() => {
          this.issues.reload();
          this.status.overview.reload();
        });
      }
      wasActive = active;
    });
  }

  protected toggleLabel(label: string) {
    const next = new Set(this.picked());
    if (next.has(label)) next.delete(label);
    else next.add(label);
    this.picked.set(next);
  }

  protected ask(action: 'close' | 'reopen', numbers: number[]) {
    if (!numbers.length || !this.canAsk()) return;
    this.session.reset();
    void this.session.send(bulkPrompt(action, numbers));
  }

  protected isGate(node: unknown): boolean {
    return (node as { component?: unknown } | null)?.component === 'ApprovalCard';
  }

  protected hasGate(surfaces: { node: unknown }[]): boolean {
    return surfaces.some((s) => this.isGate(s.node));
  }
}
