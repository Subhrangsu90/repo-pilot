import { Component, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';

/** Live progress of a run. Driven by STEP_* events, not emitted by the model. */
@Component({
  selector: 'app-step-timeline',
  host: { class: 'block' },
  template: `
    <ol class="flex flex-col gap-1.5" aria-label="Agent progress">
      @for (step of props().steps; track step.id) {
        <li class="flex items-start gap-2 text-sm" [attr.aria-current]="step.status === 'running' ? 'step' : null">
          <span class="mt-0.5 grid size-4 shrink-0 place-items-center" aria-hidden="true">
            @switch (step.status) {
              @case ('running') {
                <span class="size-3 animate-spin rounded-full border-2 border-accent border-t-transparent"></span>
              }
              @case ('done') {
                <span class="text-xs text-good">✓</span>
              }
              @case ('error') {
                <span class="text-xs text-danger">✕</span>
              }
              @default {
                <span class="size-1.5 rounded-full bg-muted"></span>
              }
            }
          </span>
          <span class="min-w-0">
            <span [class.text-muted]="step.status === 'done'" [class.text-danger]="step.status === 'error'">{{ step.label }}</span>
            @if (step.detail) {
              <span class="ml-1.5 text-xs text-muted">{{ step.detail }}</span>
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
