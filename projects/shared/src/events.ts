import type { ComponentName, UiNode } from './catalog';

// ---------------------------------------------------------------------------
// UI -> agent
// ---------------------------------------------------------------------------

/**
 * A user action inside a rendered component, sent back to the agent
 * (approve, select, field-change, ...). `surfaceId` is filled in by the
 * session layer.
 */
export interface UiEvent {
  component: ComponentName;
  name: string;
  payload?: unknown;
  surfaceId?: string;
}

/** Callback every catalog component receives to report a UiEvent. */
export type EmitFn = (event: UiEvent) => void;

// ---------------------------------------------------------------------------
// Agent -> UI: run events streamed over SSE
// ---------------------------------------------------------------------------

/**
 * Event names follow the AG-UI protocol (RUN_STARTED, STEP_STARTED,
 * TEXT_MESSAGE_CONTENT, CUSTOM, ...), so the stream could later be consumed by
 * any AG-UI client. Only the subset RepoPilot needs is defined here.
 */
export type AgentEvent =
  | { type: 'RUN_STARTED'; threadId: string; runId: string }
  | { type: 'RUN_FINISHED'; threadId: string; runId: string }
  | { type: 'RUN_ERROR'; message: string; code?: string }
  /** One unit of visible progress: a model call or a tool call. */
  | { type: 'STEP_STARTED'; stepId: string; stepName: string }
  | { type: 'STEP_FINISHED'; stepId: string; status: 'done' | 'error'; detail?: string }
  | { type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant' }
  | { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string }
  | { type: 'TEXT_MESSAGE_END'; messageId: string }
  /** A validated UI node. Same surfaceId again = replace that surface in place. */
  | { type: 'CUSTOM'; name: 'ui'; value: UiSurface };

export interface UiSurface {
  surfaceId: string;
  node: UiNode;
}

export type AgentEventType = AgentEvent['type'];

// ---------------------------------------------------------------------------
// HTTP contract
// ---------------------------------------------------------------------------

export interface StartRunRequest {
  prompt: string;
  /** Continue a conversation; omitted for a new one. */
  threadId?: string;
}

export interface StartRunResponse {
  runId: string;
  threadId: string;
}
