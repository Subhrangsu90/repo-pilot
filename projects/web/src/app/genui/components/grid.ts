import { Component, computed, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';
import { GenUiHost } from '../genui-host';

// Literal class strings so Tailwind finds them. One column on phones.
const COLUMNS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 md:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4',
};

@Component({
  selector: 'app-grid',
  imports: [GenUiHost],
  host: { class: 'block' },
  template: `
    <div class="grid gap-4" [class]="columnsClass()">
      @for (child of props().children; track $index) {
        <app-genui-host [node]="child" [emit]="emit() ?? noop" />
      }
    </div>
  `,
})
export class Grid {
  readonly props = input.required<PropsOf<'Grid'>>();
  readonly emit = input<EmitFn>();

  protected readonly noop: EmitFn = () => {};
  protected readonly columnsClass = computed(() => COLUMNS[this.props().columns] ?? COLUMNS[2]);
}
