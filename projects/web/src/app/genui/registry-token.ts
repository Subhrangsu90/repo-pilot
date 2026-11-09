import { InjectionToken, Type } from '@angular/core';
import type { ComponentName } from '@repopilot/shared';

/**
 * Maps every catalog name to the Angular component that renders it.
 * Kept in its own file so `GenUiHost` can inject it without importing the
 * components (Grid and Section render hosts, so a direct import would cycle).
 */
export type GenUiRegistry = Record<ComponentName, Type<unknown>>;

export const GENUI_REGISTRY = new InjectionToken<GenUiRegistry>('GENUI_REGISTRY');
