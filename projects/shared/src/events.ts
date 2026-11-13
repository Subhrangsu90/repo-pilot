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
  | { type: 'CUSTOM'; name: 'ui'; value: UiSurface }
  /** The run paused on an ApprovalCard; it resumes through POST /api/runs/:runId/actions. */
  | { type: 'CUSTOM'; name: 'approval'; value: ApprovalRequest }
  /** Follow-up prompts suggested from what the run showed; rendered as chips above the prompt box. */
  | { type: 'CUSTOM'; name: 'followups'; value: { prompts: string[] } }
  /** A client tool call (navigate_to, highlight_lines, apply_table_filter), validated by the server; the browser runs it. */
  | { type: 'CUSTOM'; name: 'client_tool'; value: ClientToolCall };

export interface ClientToolCall {
  callId: string;
  name: string;
  /** Parsed with the tool's own input schema on the server. */
  args: unknown;
}

export interface UiSurface {
  surfaceId: string;
  node: UiNode;
}

export interface ApprovalRequest {
  /** The run that paused (the actions endpoint is keyed by it). */
  runId: string;
  toolCallId: string;
  /** The ApprovalCard surface. */
  surfaceId: string;
}

export type AgentEventType = AgentEvent['type'];

/**
 * Step id of a tool call. The client shows a placeholder of an agent surface
 * while such a step runs, so the layout does not jump when the UI arrives.
 */
export const toolStepId = (runId: string, callId: string) => `${runId}-tool-${callId}`;
export const isToolStepId = (stepId: string) => stepId.includes('-tool-');

// ---------------------------------------------------------------------------
// HTTP contract
// ---------------------------------------------------------------------------

/** The side-nav model switch: the cloud model or the local Ollama model. */
export type ModelOption = 'cloud' | 'local';

export interface StartRunRequest {
  prompt: string;
  /** Continue a conversation; omitted for a new one. */
  threadId?: string;
  /** Omitted: the server's LLM_PROVIDER decides. */
  model?: ModelOption;
  /** The PR review page: the run must end on a review draft of this pull request. */
  reviewPullRequest?: number;
  /** "owner/name" picked in the app; a conversation stays on the repo it started with. */
  repo?: string;
}

export interface StartRunResponse {
  runId: string;
  threadId: string;
}

/** POST /api/runs/:runId/actions — the user's decision on a paused run. Answered with a StartRunResponse. */
export interface ApprovalAction {
  toolCallId: string;
  decision: 'approve' | 'reject';
  /** Approve only: the item ids still ticked. Ids that were not in the dry run are ignored. */
  selected?: number[];
  /** Approve only: what the user changed in the surface (e.g. PrReviewEdits), checked by the tool's own schema. */
  edits?: unknown;
}
