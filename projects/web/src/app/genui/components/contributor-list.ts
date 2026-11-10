import { Component, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';

@Component({
  selector: 'app-contributor-list',
  host: { class: 'block h-full' },
  template: `
    <section class="card h-full p-5" [attr.aria-label]="props().title">
      <h3 class="text-body font-semibold">{{ props().title }}</h3>
      @if (props().items.length === 0) {
        <p class="mt-3 text-body-sm text-fg-muted">No contributors in this period.</p>
      } @else {
        <ol class="mt-3.5 flex flex-col gap-3">
          @for (c of props().items; track c.login) {
            <li class="flex items-center gap-2.5">
              @if (c.avatarUrl) {
                <img
                  class="size-[30px] shrink-0 rounded-full bg-surface-3"
                  [src]="c.avatarUrl"
                  alt=""
                  width="30"
                  height="30"
                  referrerpolicy="no-referrer"
                  loading="lazy"
                />
              } @else {
                <span
                  class="grid size-[30px] shrink-0 place-items-center rounded-full bg-surface-3 text-[12px] font-semibold uppercase"
                  aria-hidden="true"
                  >{{ c.login.slice(0, 2) }}</span
                >
              }
              <span class="min-w-0 flex-1 truncate font-mono text-[14px]">{{ c.login }}</span>
              <span class="text-body-sm text-fg-muted tabular-nums">{{ c.commits }} commits</span>
            </li>
          }
        </ol>
      }
    </section>
  `,
})
export class ContributorList {
  readonly props = input.required<PropsOf<'ContributorList'>>();
  readonly emit = input<EmitFn>();
}
