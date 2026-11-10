import { Component, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';
import { Icon } from '../../shared/ui/icon';

/**
 * Live progress of a run. Driven by STEP_* events, not emitted by the model.
 * done = success check, running = text ring, pending = border-strong ring,
 * error = danger cross plus the reason.
 */
@Component({
  selector: 'app-step-timeline',
  imports: [Icon],
  host: { class: 'block' },
  template: `
    <ol class="flex flex-col gap-3" aria-label="Agent progress">
      @for (step of props().steps; track step.id) {
        <li
          class="flex items-start gap-3 text-[14px]"
          [class.text-fg-muted]="step.status === 'pending'"
          [attr.aria-current]="step.status === 'running' ? 'step' : null"
        >
          <span class="mt-px grid size-5 shrink-0 place-items-center" aria-hidden="true">
            @switch (step.status) {
              @case ('done') {
                <span class="grid size-5 place-items-center rounded-full bg-success text-bg">
                  <app-icon name="check" [size]="12" [stroke]="3.5" />
                </span>
              }
              @case ('running') {
                <span class="size-5 animate-spin rounded-full border-2 border-fg border-t-transparent"></span>
              }
              @case ('error') {
                <span class="grid size-5 place-items-center rounded-full bg-danger text-bg">
                  <app-icon name="cross" [size]="10" [stroke]="4" />
                </span>
              }
              @default {
                <span class="size-5 rounded-full border-2 border-border-strong"></span>
              }
            }
          </span>
          <span class="min-w-0">
            {{ step.label }}
            @if (step.detail) {
              <span class="ml-1 text-body-sm" [class]="step.status === 'error' ? 'text-danger' : 'text-fg-muted'">— {{ step.detail }}</span>
            }
            <span class="sr-only">({{ step.status }})</span>
          </span>
        </li>
      }
    </ol>
  `,
})
export class StepTimeline {
  readonly props = input.required<PropsOf<'StepTimeline'>>();
  readonly emit = input<EmitFn>();
}
