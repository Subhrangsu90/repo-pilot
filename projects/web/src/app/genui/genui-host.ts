import { NgComponentOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { EmitFn, PropsOf, validateNode } from '@repopilot/shared';
import { ErrorFallback } from './components/error-fallback';
import { GENUI_REGISTRY } from './registry-token';

const noop: EmitFn = () => {};

/**
 * Renders one untrusted UI node.
 *
 * 1. `validateNode` checks the name against the catalog and parses the props.
 * 2. Valid: the registered component renders through NgComponentOutlet with
 *    two inputs, `props` (typed, defaults applied) and `emit`.
 * 3. Invalid: ErrorFallback renders in this slot only; siblings are unaffected.
 *
 * Grid and Section render nested hosts for their children, so any layout the
 * agent composes still consists only of catalog components.
 */
@Component({
  selector: 'app-genui-host',
  imports: [NgComponentOutlet, ErrorFallback],
  host: { class: 'block min-w-0' },
  template: `
    @let view = rendered();
    @if (view.ok) {
      <ng-container *ngComponentOutlet="view.type; inputs: view.inputs" />
    } @else {
      <app-error-fallback [props]="view.fallback" [emit]="emit()" />
    }
  `,
})
export class GenUiHost {
  private readonly registry = inject(GENUI_REGISTRY);

  /** Untrusted: whatever the agent produced. */
  readonly node = input.required<unknown>();
  readonly emit = input<EmitFn>(noop);

  protected readonly rendered = computed(() => {
    const result = validateNode(this.node());
    if (!result.ok) {
      const fallback: PropsOf<'ErrorFallback'> = { message: result.error, raw: result.raw };
      return { ok: false as const, fallback };
    }
    return {
      ok: true as const,
      type: this.registry[result.component],
      inputs: { props: result.props, emit: this.emit() },
    };
  });
}
