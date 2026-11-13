import { InjectionToken, Type } from '@angular/core';
import type { ComponentName } from '@repopilot/shared';

/**
 * Maps every catalog name to the Angular component that renders it.
 * Kept in its own file so `A2uiNode` (the A2UI catalog entry of every
 * component) can inject it without importing the components.
 */
export type GenUiRegistry = Record<ComponentName, Type<unknown>>;

export const GENUI_REGISTRY = new InjectionToken<GenUiRegistry>('GENUI_REGISTRY');
