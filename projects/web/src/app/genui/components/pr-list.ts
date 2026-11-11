import { Component, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';
import { PrCard } from './pr-card';

@Component({
  selector: 'app-pr-list',
  imports: [PrCard],
  host: { class: 'block' },
  template: `
    <section class="flex flex-col gap-2" [attr.aria-label]="props().title ?? 'Pull requests'">
      @if (props().title) {
        <div class="mb-1 flex items-baseline justify-between gap-2">
          <h3 class="font-display text-h2">{{ props().title }}</h3>
          <span class="text-body-sm text-fg-muted tabular-nums">{{ props().items.length }}</span>
        </div>
      }
      @for (item of props().items; track item.number) {
        <app-pr-card [props]="item" [emit]="emit()" />
      } @empty {
        <p class="card px-4 py-6 text-center text-body-sm text-fg-muted">{{ props().emptyText }}</p>
      }
    </section>
  `,
})
export class PrList {
  readonly props = input.required<PropsOf<'PrList'>>();
  readonly emit = input<EmitFn>();
}
