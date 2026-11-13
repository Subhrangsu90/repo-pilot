import { Component, computed, effect, inject, Injectable, input, signal, untracked } from '@angular/core';
import { A2UI_RENDERER_CONFIG, A2uiRendererService, SurfaceComponent, type RendererConfiguration } from '@a2ui/angular';
import type { ActionPayload } from '@a2ui/web_core/v1_0';
import { A2UI_VERSION, isComponentName, readSurface, surfaceMessages, type A2uiMessage, type EmitFn, type PropsOf, type UiEvent } from '@repopilot/shared';
import { REPOPILOT_A2UI_CATALOG } from './a2ui-catalog';
import { ErrorFallback } from './components/error-fallback';

/** Routes this view's A2UI actions to its `emit` input. */
@Injectable()
class SurfaceActions {
  handler: (action: ActionPayload) => void = () => {};
}

const noop: EmitFn = () => {};
let localSurfaces = 0;

/** An A2UI action from one of our components, back as the UiEvent the page handles. */
export function toUiEvent(action: ActionPayload): UiEvent | null {
  const context = (action.context ?? {}) as { component?: unknown; payload?: unknown };
  if (typeof context.component !== 'string' || !isComponentName(context.component)) return null;
  return {
    component: context.component,
    name: action.name,
    payload: context.payload ?? undefined,
    surfaceId: action.surfaceId,
    action: {
      name: action.name,
      surfaceId: action.surfaceId,
      sourceComponentId: action.sourceComponentId,
      timestamp: action.timestamp,
      context: action.context,
    },
  };
}

/**
 * Renders one A2UI surface with `@a2ui/angular`.
 *
 * Give it the surface's A2UI operations as they arrive from the agent (AG-UI
 * activity content), or a `node` the app built itself (converted and validated
 * the same way, so every catalog component on screen goes through A2UI). Each
 * view has its own renderer: surface ids only need to be unique per view.
 *
 * New operations are applied incrementally (A2UI data model updates re-render
 * in place); a list that no longer extends what was applied (refresh, filter
 * cleared) rebuilds the surface. A message A2UI refuses shows ErrorFallback.
 */
@Component({
  selector: 'app-a2ui-surface',
  imports: [SurfaceComponent, ErrorFallback],
  providers: [
    SurfaceActions,
    {
      provide: A2UI_RENDERER_CONFIG,
      useFactory: (): RendererConfiguration => {
        const actions = inject(SurfaceActions);
        return { catalogs: [inject(REPOPILOT_A2UI_CATALOG)], actionHandler: (a) => actions.handler(a) };
      },
    },
    A2uiRendererService,
  ],
  host: { class: 'block min-w-0' },
  template: `
    @if (failure(); as f) {
      <app-error-fallback [props]="f" [emit]="emit()" />
    } @else {
      @for (key of [renderKey()]; track key) {
        @if (shownId(); as id) {
          <a2ui-v09-surface [surfaceId]="id" />
        }
      }
    }
  `,
})
export class A2uiSurfaceView {
  /** The surface's A2UI operations (createSurface, updateComponents, updateDataModel, ...). */
  readonly operations = input<readonly A2uiMessage[] | undefined>(undefined);
  /** Or: a node built by the app (e.g. rows from a REST call), rendered as a local surface. */
  readonly node = input<unknown>(undefined);
  readonly emit = input<EmitFn>(noop);

  private readonly renderer = inject(A2uiRendererService);
  private readonly localId = `local_${++localSurfaces}`;

  protected readonly shownId = signal<string | null>(null);
  /** Bumped when the surface is rebuilt, so the A2UI surface component starts over. */
  protected readonly renderKey = signal(0);
  protected readonly failure = signal<PropsOf<'ErrorFallback'> | null>(null);

  private readonly messages = computed<readonly A2uiMessage[]>(() => {
    const ops = this.operations();
    if (ops) return ops;
    const node = this.node();
    return node === undefined ? [] : surfaceMessages(this.localId, node);
  });
  private applied: readonly A2uiMessage[] = [];

  constructor() {
    const actions = inject(SurfaceActions);
    actions.handler = (action) => {
      const event = toUiEvent(action);
      if (event) this.emit()(event);
    };
    effect(() => {
      const ops = this.messages();
      untracked(() => this.apply(ops));
    });
  }

  private apply(ops: readonly A2uiMessage[]) {
    const extendsApplied = this.applied.length > 0 && ops.length >= this.applied.length && this.applied.every((m, i) => ops[i] === m);
    const id = readSurface(ops).surfaceId;
    try {
      if (extendsApplied) {
        if (ops.length > this.applied.length) this.renderer.processMessages(ops.slice(this.applied.length));
      } else {
        for (const old of [...this.renderer.surfaceGroup.surfacesMap.keys()]) {
          this.renderer.processMessages([{ version: A2UI_VERSION, deleteSurface: { surfaceId: old } }]);
        }
        if (ops.length) this.renderer.processMessages([...ops]);
        this.renderKey.update((k) => k + 1);
      }
      this.applied = ops;
      this.shownId.set(id || null);
      this.failure.set(null);
    } catch (err) {
      this.applied = [];
      this.shownId.set(null);
      const raw = JSON.stringify(ops, null, 2) ?? '';
      this.failure.set({
        message: `This view could not be shown: ${(err as Error).message}`.slice(0, 500),
        raw: raw.length > 4000 ? `${raw.slice(0, 4000)}\n… (truncated)` : raw,
      });
    }
  }
}
