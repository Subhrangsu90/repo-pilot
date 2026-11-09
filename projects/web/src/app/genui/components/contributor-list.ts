import { Component, computed, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';

@Component({
  selector: 'app-contributor-list',
  host: { class: 'block h-full' },
  template: `
    <section class="card h-full p-4" [attr.aria-label]="props().title">
      <h3 class="text-sm font-medium text-ink">{{ props().title }}</h3>
      @if (rows().length === 0) {
        <p class="mt-3 text-sm text-muted">No contributors in this period.</p>
      } @else {
        <ol class="mt-3 flex flex-col gap-3">
          @for (c of rows(); track c.login) {
            <li class="flex items-center gap-3">
              @if (c.avatarUrl) {
                <img
                  class="size-7 shrink-0 rounded-full bg-canvas"
                  [src]="c.avatarUrl"
                  alt=""
                  width="28"
                  height="28"
                  referrerpolicy="no-referrer"
                  loading="lazy"
                />
              } @else {
                <span
                  class="grid size-7 shrink-0 place-items-center rounded-full bg-accent/15 text-xs font-semibold uppercase text-accent"
                  aria-hidden="true"
                  >{{ c.login.slice(0, 2) }}</span
                >
              }
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline justify-between gap-2 text-sm">
                  <span class="truncate text-ink">{{ c.login }}</span>
                  <span class="text-xs text-muted tabular-nums">{{ c.commits }} commits</span>
                </div>
                <div class="mt-1 h-1.5 rounded-full bg-canvas" aria-hidden="true">
                  <div class="h-full rounded-full bg-accent/70" [style.width.%]="c.share"></div>
                </div>
              </div>
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

  protected readonly rows = computed(() => {
    const items = this.props().items;
    const max = Math.max(1, ...items.map((i) => i.commits));
    return items.map((i) => ({ ...i, share: (i.commits / max) * 100 }));
  });
}
