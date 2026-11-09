import type { ComponentName } from './catalog';

/**
 * A user action inside a rendered component, sent back to the agent
 * (approve, select, field-change, ...). `surfaceId` is filled in by the
 * session layer once the agent stream exists (week 2).
 */
export interface UiEvent {
  component: ComponentName;
  name: string;
  payload?: unknown;
  surfaceId?: string;
}

/** Callback every catalog component receives to report a UiEvent. */
export type EmitFn = (event: UiEvent) => void;
