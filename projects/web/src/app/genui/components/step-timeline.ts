import { Component, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';
import { Icon } from '../../shared/ui/icon';

/**
 * Live progress of a run (rows, or one wrapping line with `inline`). Driven by STEP_* events, not emitted by the model.
 * done = success check, running = spinning ring, waiting for approval = pulsing
 * dot, pending = border-strong ring,
 * error = danger cross plus the reason.
 */
@Component({
  selector: 'app-step-timeline',
  imports: [Icon],
  host: { class: 'block' },
  template: `
    <ol [class]="inline() ? 'flex flex-wrap items-center gap-x-4 gap-y-2' : 'flex flex-col gap-3'" aria-label="Agent progress">
      @for (step of props().steps; track step.id) {
        <li
          class="flex items-start gap-3 text-body-md"
          [class.gap-2]="inline()"
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
                <span class="size-4 animate-spin rounded-full border-2 border-fg border-t-transparent"></span>
              }
              @case ('error') {
                <span class="grid size-5 place-items-center rounded-full bg-danger text-bg">
                  <app-icon name="cross" [size]="10" [stroke]="4" />
                </span>
              }
              @default {
                @if (isApproval(step.id)) {
                  <!-- Paused on the user, not idle: a breathing dot so it reads as live. -->
                  <span class="relative grid size-5 place-items-center">
                    <span class="absolute inset-0 animate-ping rounded-full border-2 border-fg opacity-40"></span>
                    <span class="size-2.5 animate-pulse rounded-full bg-fg"></span>
                  </span>
                } @else {
                  <span class="size-5 rounded-full border-2 border-border-strong"></span>
                }
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
  /** The Screen Spec's "step strip": the same steps on one wrapping line (Ask, PR review). */
  readonly inline = input(false);

  protected isApproval(id: string) {
    return id.startsWith('approval-');
  }
}
