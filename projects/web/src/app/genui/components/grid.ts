import { Component, computed, input } from '@angular/core';
import { ComponentHostComponent, type Child } from '@a2ui/angular';
import { EmitFn, PropsOf } from '@repopilot/shared';

// Literal class strings so Tailwind finds them. One column on phones.
const COLUMNS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 md:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4',
};

/**
 * Lays out its children in columns. The children are A2UI component refs of
 * the same surface, each rendered (and validated) by its own A2UI host.
 */
@Component({
  selector: 'app-grid',
  imports: [ComponentHostComponent],
  host: { class: 'block' },
  template: `
    <div class="grid gap-3" [class]="columnsClass()">
      @for (child of childRefs(); track child.id) {
        <a2ui-v09-component-host class="block h-full min-w-0" [componentKey]="child" [surfaceId]="surfaceId()" />
      }
    </div>
  `,
})
export class Grid {
  readonly props = input.required<PropsOf<'Grid'>>();
  readonly emit = input<EmitFn>();
  readonly childRefs = input<Child[]>([]);
  readonly surfaceId = input<string>('');

  protected readonly columnsClass = computed(() => COLUMNS[this.props().columns] ?? COLUMNS[2]);
}
