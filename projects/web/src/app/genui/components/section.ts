import { Component, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';
import { GenUiHost } from '../genui-host';

@Component({
  selector: 'app-section',
  imports: [GenUiHost],
  host: { class: 'block' },
  template: `
    <section class="flex flex-col gap-4" [attr.aria-label]="props().title">
      <header class="flex flex-col gap-1">
        <h2 class="font-display text-h2">{{ props().title }}</h2>
        @if (props().description) {
          <p class="text-body-sm text-fg-muted">{{ props().description }}</p>
        }
      </header>
      @for (child of props().children; track $index) {
        <app-genui-host [node]="child" [emit]="emit() ?? noop" />
      }
    </section>
  `,
})
export class Section {
  readonly props = input.required<PropsOf<'Section'>>();
  readonly emit = input<EmitFn>();

  protected readonly noop: EmitFn = () => {};
}
