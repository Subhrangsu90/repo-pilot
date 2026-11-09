import { Component, computed, input, linkedSignal } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';

/**
 * Issues as a table. With `selectable`, the user picks rows and every change
 * is sent to the agent as a `select` event with the chosen issue numbers.
 * The selection resets whenever the agent sends new rows.
 */
@Component({
  selector: 'app-issue-table',
  host: { class: 'block' },
  template: `
    <div class="card overflow-hidden">
      @if (props().title || props().selectable) {
        <div class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h3 class="text-sm font-medium text-ink">{{ props().title ?? 'Issues' }}</h3>
          @if (props().selectable) {
            <span class="text-xs text-muted tabular-nums" aria-live="polite">
              {{ selected().size }} of {{ props().rows.length }} selected
            </span>
          }
        </div>
      }

      @if (props().rows.length === 0) {
        <p class="px-4 py-6 text-center text-sm text-muted">{{ props().emptyText }}</p>
      } @else {
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead class="text-xs text-muted">
              <tr>
                @if (props().selectable) {
                  <th scope="col" class="w-10 px-4 py-2">
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
                <th scope="col" class="px-4 py-2 font-medium">Issue</th>
                <th scope="col" class="hidden px-4 py-2 font-medium sm:table-cell">Labels</th>
                <th scope="col" class="px-4 py-2 text-right font-medium">Age</th>
              </tr>
            </thead>
            <tbody>
              @for (row of props().rows; track row.number) {
                <tr
                  class="border-t border-border data-selected:bg-accent/5"
                  [attr.data-selected]="selected().has(row.number) ? '' : null"
                >
                  @if (props().selectable) {
                    <td class="px-4 py-2.5">
                      <input
                        type="checkbox"
                        class="checkbox"
                        [attr.aria-label]="'Select issue #' + row.number"
                        [checked]="selected().has(row.number)"
                        (change)="toggle(row.number)"
                      />
                    </td>
                  }
                  <td class="px-4 py-2.5">
                    <span class="font-mono text-xs text-muted">#{{ row.number }}</span>
                    <span class="ml-1.5 text-ink">{{ row.title }}</span>
                    @if (row.author) {
                      <span class="ml-1.5 text-xs text-muted">by {{ row.author }}</span>
                    }
                  </td>
                  <td class="hidden px-4 py-2.5 sm:table-cell">
                    <div class="flex flex-wrap gap-1">
                      @for (label of row.labels; track label) {
                        <span class="chip">{{ label }}</span>
                      }
                    </div>
                  </td>
                  <td class="px-4 py-2.5 text-right text-muted tabular-nums">{{ row.ageDays }}&nbsp;d</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
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
