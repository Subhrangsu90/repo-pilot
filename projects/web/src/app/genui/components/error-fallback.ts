import { Component, input } from '@angular/core';
import { EmitFn, PropsOf } from '@repopilot/shared';

/**
 * Shown in place of a node that failed validation. The reason and the raw
 * payload are rendered with interpolation, which Angular escapes, so even a
 * payload full of HTML stays inert text.
 */
@Component({
  selector: 'app-error-fallback',
  host: { class: 'block' },
  template: `
    <div class="card flex flex-col gap-3 border-danger p-[18px]" role="group" aria-label="Component could not be rendered">
      <p class="text-body">Couldn't render this part of the answer.</p>
      <p class="rounded-sm bg-bg px-3 py-2 font-mono text-[12px] break-words whitespace-pre-wrap text-fg-muted">{{ props().message }}</p>
      @if (props().raw) {
        <details>
          <summary class="cursor-pointer text-body-sm text-fg-muted">Show raw payload</summary>
          <pre class="mt-2 max-h-64 overflow-auto rounded-sm bg-bg p-3 font-mono text-[12px] text-fg-muted">{{ props().raw }}</pre>
        </details>
      }
      <button type="button" class="btn self-start" (click)="retry()">Ask the agent to retry</button>
    </div>
  `,
})
export class ErrorFallback {
  readonly props = input.required<PropsOf<'ErrorFallback'>>();
  readonly emit = input<EmitFn>();

  protected retry() {
    this.emit()?.({ component: 'ErrorFallback', name: 'retry' });
  }
}
