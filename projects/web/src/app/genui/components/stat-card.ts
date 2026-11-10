import { Component, computed, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';

type Tone = PropsOf<'StatCard'>['tone'];

/** Design system: neutral; good = context in success; warning = value + border in risk. */
const TONE: Record<Tone, { card: string; value: string; context: string }> = {
  neutral: { card: 'border-border', value: 'text-fg', context: 'text-fg-muted' },
  good: { card: 'border-border', value: 'text-fg', context: 'text-success' },
  warning: { card: 'border-risk', value: 'text-risk', context: 'text-fg-muted' },
  danger: { card: 'border-danger', value: 'text-danger', context: 'text-fg-muted' },
};

const ARROW = { up: '↑', down: '↓', flat: '→' } as const;

@Component({
  selector: 'app-stat-card',
  host: { class: 'block h-full' },
  template: `
    @let tone = toneClasses();
    <article class="card flex h-full flex-col gap-1.5 p-[18px]" [class]="tone.card">
      <p class="text-label text-fg-muted">{{ props().label }}</p>
      <p class="font-display text-stat tabular-nums" [class]="tone.value">{{ props().value }}</p>
      @if (props().trend; as trend) {
        <p class="text-body-sm" [class]="tone.context">
          <span aria-hidden="true">{{ arrow() }}</span> {{ trend.text }}
        </p>
      }
      @if (props().hint) {
        <p class="mt-auto text-body-sm text-fg-faint">{{ props().hint }}</p>
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
