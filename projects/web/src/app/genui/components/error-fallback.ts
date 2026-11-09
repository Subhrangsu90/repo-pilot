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
    <div class="card border-danger/40 bg-danger/5 p-4" role="group" aria-label="Component could not be rendered">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-sm font-semibold text-danger">Could not render this part</p>
          <p class="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{{ props().message }}</p>
        </div>
        <button type="button" class="btn shrink-0" (click)="retry()">Retry</button>
      </div>
      @if (props().raw) {
        <details class="mt-3">
          <summary class="cursor-pointer text-xs text-muted">Show raw payload</summary>
          <pre class="mt-2 max-h-64 overflow-auto rounded-lg bg-canvas p-3 font-mono text-xs text-ink">{{ props().raw }}</pre>
        </details>
      }
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
