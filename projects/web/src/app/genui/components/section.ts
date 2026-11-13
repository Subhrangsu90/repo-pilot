import { Component, input } from '@angular/core';
import { ComponentHostComponent, type Child } from '@a2ui/angular';
import { EmitFn, PropsOf } from '@repopilot/shared';

/** A titled group. The children are A2UI component refs of the same surface. */
@Component({
  selector: 'app-section',
  imports: [ComponentHostComponent],
  host: { class: 'block' },
  template: `
    <section class="flex flex-col gap-4" [attr.aria-label]="props().title">
      <header class="flex flex-col gap-1">
        <h2 class="font-display text-h2">{{ props().title }}</h2>
        @if (props().description) {
          <p class="text-body-sm text-fg-muted">{{ props().description }}</p>
        }
      </header>
      @for (child of childRefs(); track child.id) {
        <a2ui-v09-component-host class="block min-w-0" [componentKey]="child" [surfaceId]="surfaceId()" />
      }
    </section>
  `,
})
export class Section {
  readonly props = input.required<PropsOf<'Section'>>();
  readonly emit = input<EmitFn>();
  readonly childRefs = input<Child[]>([]);
  readonly surfaceId = input<string>('');
}
