import { Component, computed, input, linkedSignal } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';
import { InjectionBadge } from '../../shared/ui/injection-badge';

/**
 * Issues as a table. With `selectable`, the user picks rows and every change
 * is sent to the agent as a `select` event with the chosen issue numbers.
 * The selection resets whenever the agent sends new rows.
 */
@Component({
  selector: 'app-issue-table',
  imports: [InjectionBadge],
  host: { class: 'block' },
  template: `
    <div class="card overflow-x-auto">
      @if (props().rows.length === 0) {
        @if (props().title) {
          <h3 class="px-5 pt-4 text-body font-semibold">{{ props().title }}</h3>
        }
        <p class="px-5 py-6 text-center text-body-sm text-fg-muted">{{ props().emptyText }}</p>
      } @else {
        <table class="w-full min-w-[560px] border-collapse text-left text-body-md">
          <caption class="px-5 pt-4 pb-2 text-left">
            <span class="text-body font-semibold">{{ props().title ?? 'Issues' }}</span>
            @if (props().selectable) {
              <span class="ml-3 text-body-sm text-fg-muted tabular-nums" aria-live="polite">
                {{ selected().size }} of {{ props().rows.length }} selected
              </span>
            }
          </caption>
          <thead class="text-body-sm text-fg-faint">
            <tr>
              @if (props().selectable) {
                <th scope="col" class="w-12 py-2.5 pl-5 font-normal">
                  <input
                    type="checkbox"
                    class="checkbox"
                    aria-label="Select all issues"
                    [checked]="allSelected()"
                    [indeterminate]="selected().size > 0 && !allSelected()"
                    (change)="toggleAll()"
                  />
                </th>
              }
              <th scope="col" class="px-5 py-2.5 font-normal">Issue</th>
              <th scope="col" class="px-2.5 py-2.5 font-normal">Labels</th>
              <th scope="col" class="px-2.5 py-2.5 font-normal">Assignee</th>
              <th scope="col" class="px-5 py-2.5 text-right font-normal">Age</th>
            </tr>
          </thead>
          <tbody>
            @for (row of props().rows; track row.number) {
              <tr
                class="group h-12 border-t border-border hover:bg-surface-3 data-selected:bg-neutral-soft"
                [attr.data-selected]="selected().has(row.number) ? '' : null"
              >
                @if (props().selectable) {
                  <td class="py-2.5 pl-5">
                    <input
                      type="checkbox"
                      class="checkbox"
                      [attr.aria-label]="'Select issue #' + row.number"
                      [checked]="selected().has(row.number)"
                      (change)="toggle(row.number)"
                    />
                  </td>
                }
                <td class="px-5 py-2.5">
                  <span class="mr-2 font-mono text-fg-faint group-hover:text-fg-muted">#{{ row.number }}</span>{{ row.title }}
                  @if (row.injection) {
                    <app-injection-badge class="ml-2 align-middle" />
                  }
                </td>
                <td class="px-2.5 py-2.5">
                  <div class="flex flex-wrap gap-1">
                    @for (label of row.labels; track label) {
                      <span class="badge px-2 py-0.5 font-normal" [class.badge-danger]="label.toLowerCase() === 'bug'">{{ label }}</span>
                    }
                  </div>
                </td>
                <td class="px-2.5 py-2.5 text-body-sm text-fg-muted">
                  @if (row.assignees.length) {
                    <span class="font-mono">{{ row.assignees.join(', ') }}</span>
                  } @else {
                    Unassigned
                  }
                </td>
                <td class="px-5 py-2.5 text-right whitespace-nowrap text-fg-muted tabular-nums">
                  {{ row.ageDays }} {{ row.ageDays === 1 ? 'day' : 'days' }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
})
export class IssueTable {
  readonly props = input.required<PropsOf<'IssueTable'>>();
  readonly emit = input<EmitFn>();

  protected readonly selected = linkedSignal<PropsOf<'IssueTable'>, ReadonlySet<number>>({
    source: this.props,
    computation: () => new Set(),
  });

  protected readonly allSelected = computed(
    () => this.props().rows.length > 0 && this.selected().size === this.props().rows.length,
  );

  protected toggle(number: number) {
    const next = new Set(this.selected());
    if (next.has(number)) next.delete(number);
    else next.add(number);
    this.commit(next);
  }

  protected toggleAll() {
    this.commit(this.allSelected() ? new Set() : new Set(this.props().rows.map((r) => r.number)));
  }

  private commit(next: ReadonlySet<number>) {
    this.selected.set(next);
    this.emit()?.({
      component: 'IssueTable',
      name: 'select',
      payload: { numbers: [...next].sort((a, b) => a - b) },
    });
  }
}
