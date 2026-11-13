import { NgComponentOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { A2uiRendererService, type BoundProperty, type CatalogComponentInstance, type Child } from '@a2ui/angular';
import { isContainer, validateNode, type EmitFn, type PropsOf } from '@repopilot/shared';
import { ErrorFallback } from './components/error-fallback';
import { GENUI_REGISTRY } from './registry-token';

/**
 * One A2UI component of RepoPilot's catalog, as `@a2ui/angular` renders it.
 *
 * 1. A2UI resolves the component's `{ "@path" }` bindings against the surface's
 *    data model (signals: a data model update re-renders in place).
 * 2. The resolved props are validated with the shared Zod schema (the second
 *    validation, after the server's): invalid → ErrorFallback in this slot only.
 * 3. The registered Angular component renders with typed props and `emit`.
 *    Containers (Grid, Section) also get their children as A2UI child refs.
 * 4. `emit` dispatches an A2UI action on the surface (name + context), which the
 *    surface view turns back into a UiEvent for the page.
 */
@Component({
  selector: 'app-a2ui-node',
  imports: [NgComponentOutlet, ErrorFallback],
  // h-full: a stat card in a Grid still fills its row.
  host: { class: 'block h-full min-w-0' },
  template: `
    @let view = rendered();
    @if (view.ok) {
      <ng-container *ngComponentOutlet="view.type; inputs: view.inputs" />
    } @else {
      <app-error-fallback [props]="view.fallback" [emit]="emit" />
    }
  `,
})
export class A2uiNode implements CatalogComponentInstance {
  readonly props = input<Record<string, BoundProperty>>({});
  readonly surfaceId = input.required<string>();
  readonly componentId = input.required<string>();
  readonly dataContextPath = input<string>('/');

  private readonly renderer = inject(A2uiRendererService);
  private readonly registry = inject(GENUI_REGISTRY);

  /** The catalog name of this component, from the surface's component model. */
  private readonly type = computed(() => this.renderer.surfaceGroup.getSurface(this.surfaceId())?.componentsModel.get(this.componentId())?.type ?? '');

  protected readonly rendered = computed(() => {
    const name = this.type();
    const values: Record<string, unknown> = {};
    let childRefs: Child[] = [];
    for (const [key, bound] of Object.entries(this.props())) {
      if (key === 'children') childRefs = (bound.value() as Child[] | undefined) ?? [];
      else values[key] = bound.value();
    }
    const container = isContainer(name);
    // Children are A2UI component refs, rendered by A2UI hosts; the rest is validated as usual.
    const result = validateNode({ component: name, props: container ? { ...values, children: [] } : values });
    if (!result.ok) {
      const fallback: PropsOf<'ErrorFallback'> = { message: result.error, raw: result.raw };
      return { ok: false as const, fallback };
    }
    return {
      ok: true as const,
      type: this.registry[result.component],
      inputs: { props: result.props, emit: this.emit, ...(container ? { childRefs, surfaceId: this.surfaceId() } : {}) },
    };
  });

  /** A user action in the component, sent as an A2UI action of this surface. */
  protected readonly emit: EmitFn = (event) => {
    const context = { component: event.component, payload: event.payload === undefined ? null : event.payload };
    void this.renderer.surfaceGroup.getSurface(this.surfaceId())?.dispatchAction({ event: { name: event.name, context } }, this.componentId());
  };
}
