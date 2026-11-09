import { Component, computed, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';

/**
 * Small dependency-free SVG chart (bar or line). Bars get a native tooltip via
 * <title>; screen readers get the full series as a list.
 */
@Component({
  selector: 'app-activity-chart',
  host: { class: 'block h-full' },
  template: `
    @let g = geometry();
    <figure class="card flex h-full flex-col p-4">
      <figcaption class="flex items-baseline justify-between gap-2">
        <span class="text-sm font-medium text-ink">{{ props().title }}</span>
        <span class="text-xs text-muted tabular-nums">max {{ g.max }}</span>
      </figcaption>

      <svg
        class="mt-3 h-40 w-full overflow-visible"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line x1="0" y1="100" x2="100" y2="100" class="stroke-border" vector-effect="non-scaling-stroke" />
        @if (props().kind === 'bar') {
          @for (p of g.points; track $index) {
            <rect
              class="fill-accent/80 hover:fill-accent"
              [attr.x]="p.x + p.w * 0.15"
              [attr.y]="100 - p.h"
              [attr.width]="p.w * 0.7"
              [attr.height]="p.h"
              rx="0.6"
            >
              <title>{{ p.label }}: {{ p.value }}</title>
            </rect>
          }
        } @else {
          <polyline
            class="fill-none stroke-accent"
            stroke-width="2"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
            [attr.points]="g.line"
          />
        }
      </svg>

      <div class="mt-1 flex text-[10px] text-muted" aria-hidden="true">
        @for (p of g.points; track $index) {
          <span class="flex-1 truncate text-center">{{ $index % g.labelEvery === 0 ? p.label : '' }}</span>
        }
      </div>

      <ul class="sr-only">
        @for (p of g.points; track $index) {
          <li>{{ p.label }}: {{ p.value }}</li>
        }
      </ul>
    </figure>
  `,
})
export class ActivityChart {
  readonly props = input.required<PropsOf<'ActivityChart'>>();
  readonly emit = input<EmitFn>();

  protected readonly geometry = computed(() => {
    const raw = this.props().points;
    const max = Math.max(...raw.map((p) => p.value));
    const scale = max > 0 ? 100 / max : 0;
    const w = 100 / raw.length;
    const points = raw.map((p, i) => ({ ...p, x: i * w, w, h: p.value * scale }));
    const line = points.map((p) => `${p.x + w / 2},${100 - p.h}`).join(' ');
    return { max, points, line, labelEvery: Math.ceil(raw.length / 12) };
  });
}
