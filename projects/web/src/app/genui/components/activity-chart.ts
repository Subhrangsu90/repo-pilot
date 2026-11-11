import { Component, computed, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';

/**
 * Small dependency-free SVG chart (bar or line). Monochrome per the design
 * system: bars in border-strong, the peak in text colour. The chart is one
 * image with a label that states the finding; the full series follows as a
 * screen-reader list.
 */
@Component({
  selector: 'app-activity-chart',
  host: { class: 'block h-full' },
  template: `
    @let g = geometry();
    <figure class="card flex h-full flex-col gap-4 p-5">
      <figcaption class="flex items-baseline justify-between gap-2">
        <span class="text-body font-semibold">{{ props().title }}</span>
        <span class="text-body-sm text-fg-faint">{{ g.range }}</span>
      </figcaption>

      <div role="img" [attr.aria-label]="g.summary">
        <svg class="h-44 w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          @if (props().kind === 'bar') {
            @for (p of g.points; track $index) {
              <rect
                [class]="$index === g.peak ? 'fill-fg' : 'fill-border-strong'"
                [attr.x]="p.x + p.w * 0.12"
                [attr.y]="100 - p.h"
                [attr.width]="p.w * 0.76"
                [attr.height]="p.h"
                rx="0.8"
              >
                <title>{{ p.label }}: {{ p.value }}</title>
              </rect>
            }
          } @else {
            <polyline
              class="fill-none stroke-fg"
              stroke-width="2"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
              [attr.points]="g.line"
            />
          }
          <line x1="0" y1="100" x2="100" y2="100" class="stroke-border-strong" vector-effect="non-scaling-stroke" />
        </svg>
      </div>

      <div class="flex justify-between font-mono text-axis text-fg-faint" aria-hidden="true">
        @for (label of g.axis; track $index) {
          <span>{{ label }}</span>
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
    const { title, points: raw } = this.props();
    const max = Math.max(0, ...raw.map((p) => p.value));
    const peak = raw.findIndex((p) => p.value === max);
    const scale = max > 0 ? 100 / max : 0;
    const w = 100 / Math.max(1, raw.length);
    const points = raw.map((p, i) => ({ ...p, x: i * w, w, h: p.value * scale }));
    const line = points.map((p) => `${p.x + w / 2},${100 - p.h}`).join(' ');
    // First, middle and last labels only.
    const axis = raw.length > 2 ? [raw[0].label, raw[Math.floor((raw.length - 1) / 2)].label, raw.at(-1)!.label] : raw.map((p) => p.label);
    const summary = raw.length
      ? `${title}: ${raw.length} points, peaking at ${max} in ${raw[peak].label}`
      : `${title}: no data`;
    // The period covered, e.g. "W1 – W12" or "2026-08-17 – 2026-11-09".
    const range = raw.length > 1 ? `${raw[0].label} – ${raw.at(-1)!.label}` : (raw[0]?.label ?? '');
    return { points, line, peak, axis, summary, range };
  });
}
