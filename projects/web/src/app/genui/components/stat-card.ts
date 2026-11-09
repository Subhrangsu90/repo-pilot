import { Component, computed, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';

const TONE: Record<PropsOf<'StatCard'>['tone'], string> = {
  neutral: 'text-ink',
  good: 'text-good',
  warning: 'text-warning',
  danger: 'text-danger',
};

const ARROW = { up: '↑', down: '↓', flat: '→' } as const;

@Component({
  selector: 'app-stat-card',
  host: { class: 'block h-full' },
  template: `
    <article class="card flex h-full flex-col p-4">
      <p class="text-sm text-muted">{{ props().label }}</p>
      <p class="mt-1 text-3xl font-semibold tabular-nums" [class]="toneClass()">
        {{ props().value }}
      </p>
      @if (props().trend; as trend) {
        <p class="mt-1 text-xs text-muted">
          <span aria-hidden="true">{{ arrow() }}</span> {{ trend.text }}
        </p>
      }
      @if (props().hint) {
        <p class="mt-auto pt-2 text-xs text-muted">{{ props().hint }}</p>
      }
    </article>
  `,
})
export class StatCard {
  readonly props = input.required<PropsOf<'StatCard'>>();
  readonly emit = input<EmitFn>();

  protected readonly toneClass = computed(() => TONE[this.props().tone]);
  protected readonly arrow = computed(() => {
    const trend = this.props().trend;
    return trend ? ARROW[trend.direction] : '';
  });
}
