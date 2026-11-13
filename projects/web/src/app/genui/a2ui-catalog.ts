import { InjectionToken } from '@angular/core';
import { AngularCatalog, createComponentImplementation } from '@a2ui/angular';
import { Catalog } from '@a2ui/web_core/v1_0';
import { A2UI_VERSION, catalogDocument, componentNames, REPOPILOT_CATALOG_ID } from '@repopilot/shared';
import { A2uiNode } from './a2ui-node';

/**
 * RepoPilot's A2UI catalog for `@a2ui/angular`. The catalog document is
 * generated from the shared Zod catalog (`catalogDocument()`), loaded with
 * `@a2ui/web_core` (which validates every component and binding against it),
 * and every entry renders through `A2uiNode`, which validates the resolved
 * props again with the shared schema before the registered Angular component
 * gets them.
 */
export function buildA2uiCatalog(): AngularCatalog {
  const api = Catalog.fromJson(catalogDocument(), A2UI_VERSION, REPOPILOT_CATALOG_ID);
  const components = componentNames.map((name) => {
    const entry = api.components.get(name);
    if (!entry) throw new Error(`The A2UI catalog has no ${name}.`);
    return createComponentImplementation(entry, A2uiNode);
  });
  return new AngularCatalog(REPOPILOT_CATALOG_ID, A2UI_VERSION, components);
}

/** Built once, on first use (only lazy app pages render surfaces, so the landing page never builds it). */
export const REPOPILOT_A2UI_CATALOG = new InjectionToken<AngularCatalog>('REPOPILOT_A2UI_CATALOG', {
  providedIn: 'root',
  factory: buildA2uiCatalog,
});
