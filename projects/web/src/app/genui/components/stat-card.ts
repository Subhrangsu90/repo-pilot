import { Component, computed, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';

type Tone = PropsOf<'StatCard'>['tone'];

/**
 * Design system (StatCard): the value always stays `text`; the tone colours the
 * context line, which says why. Warning is emphasis by contrast, never `risk`
 * (risk only marks destructive actions). The context line is the trend, or the
 * hint when there is no trend.
 */
const TONE: Record<Tone, { card: string; context: string }> = {
  neutral: { card: 'border-border', context: '' },
  good: { card: 'border-border', context: 'text-success' },
  warning: { card: 'border-border-strong', context: 'font-medium text-fg' },
  danger: { card: 'border-danger', context: 'text-danger' },
};

const ARROW = { up: '↑', down: '↓', flat: '→' } as const;

@Component({
  selector: 'app-stat-card',
  host: { class: 'block h-full' },
  template: `
    @let tone = toneClasses();
    <article class="card flex h-full flex-col gap-1.5 p-card" [class]="tone.card">
      <p class="text-label text-fg-muted">{{ props().label }}</p>
      <p class="font-display text-stat text-fg tabular-nums">{{ props().value }}</p>
      @if (props().trend; as trend) {
        <p class="text-body-sm" [class]="tone.context || 'text-fg-muted'">
          <span aria-hidden="true">{{ arrow() }}</span> {{ trend.text }}
        </p>
      }
      @if (props().hint) {
        <p class="mt-auto text-body-sm" [class]="(!props().trend && tone.context) || 'text-fg-faint'">{{ props().hint }}</p>
      }
    </article>
  `,
})
export class StatCard {
  readonly props = input.required<PropsOf<'StatCard'>>();
  readonly emit = input<EmitFn>();

  protected readonly toneClasses = computed(() => TONE[this.props().tone]);
  protected readonly arrow = computed(() => {
    const trend = this.props().trend;
    return trend ? ARROW[trend.direction] : '';
  });
}
