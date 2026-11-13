/**
 * Agent ↔ UI transport: the AG-UI protocol (v1.0, `@ag-ui/core`).
 *
 * The browser starts every run with `POST /api/agent` and an AG-UI
 * `RunAgentInput`; the answer is the run's AG-UI event stream (SSE, or
 * protobuf when the client asks for it). This file holds RepoPilot's
 * conventions on top of the protocol, used by both sides:
 *
 * - UI: A2UI surfaces as ACTIVITY_SNAPSHOT / ACTIVITY_DELTA (see a2ui.ts).
 * - Steps: STEP_STARTED / STEP_FINISHED carry a unique `stepName` and the
 *   label, status and detail in `metadata.repopilot`.
 * - Approvals: a change waits as an AG-UI interrupt (RUN_FINISHED with outcome
 *   `interrupt`); the answer is a new run whose `resume` entry carries an
 *   `ApprovalDecision`.
 * - Client tools: TOOL_CALL_* events for tools the browser declared in
 *   `RunAgentInput.tools`; the browser applies them on screen.
 * - Shared state: STATE_SNAPSHOT / STATE_DELTA with `RepoPilotState`.
 */
import * as z from 'zod';
import type { Event as AgUiEvent, Metadata } from '@ag-ui/core';
import type { ComponentName } from './catalog';

export { EventType } from '@ag-ui/core';
export type { AgUiEvent };

// ---------------------------------------------------------------------------
// UI -> agent (inside the browser: catalog component → A2UI action)
// ---------------------------------------------------------------------------

/**
 * A user action inside a rendered component (approve, select, retry, ...).
 * The A2UI host turns it into an A2UI `action` on the component's surface.
 */
export interface UiEvent {
  component: ComponentName;
  name: string;
  payload?: unknown;
  surfaceId?: string;
  /** The A2UI action this event travelled as (set by the A2UI surface view). */
  action?: A2uiUserAction;
}

/** Callback every catalog component receives to report a UiEvent. */
export type EmitFn = (event: UiEvent) => void;

// ---------------------------------------------------------------------------
// Event metadata
// ---------------------------------------------------------------------------

/** The `metadata` key RepoPilot uses on AG-UI events (the `ag-ui` key is reserved by the protocol). */
export const META_KEY = 'repopilot';

/** One visible progress step: a model call or a tool call. */
export interface StepMeta {
  label?: string;
  status?: 'done' | 'error';
  detail?: string;
}

export function stepMeta(event: { metadata?: Metadata }): StepMeta {
  const meta = event.metadata?.[META_KEY];
  return meta && typeof meta === 'object' ? (meta as StepMeta) : {};
}

/**
 * Step id of a tool call. The client shows a placeholder of an agent surface
 * while such a step runs, so the layout does not jump when the UI arrives.
 */
export const toolStepId = (runId: string, callId: string) => `${runId}-tool-${callId}`;
export const isToolStepId = (stepId: string) => stepId.includes('-tool-');
/** The step a paused change shows until it is answered; the resuming run finishes it. */
export const approvalStepId = (toolCallId: string) => `approval-${toolCallId}`;

// ---------------------------------------------------------------------------
// Human in the loop: interrupts and resume
// ---------------------------------------------------------------------------

/** `Interrupt.reason` of a change waiting for the user's approval. */
export const APPROVAL_INTERRUPT = 'tool_approval';

/** `Interrupt.metadata.repopilot` of an approval: where its surface is. */
export interface ApprovalInterruptMeta {
  surfaceId: string;
  tool: string;
  risk: 'write' | 'destructive';
}

/** The answer to an approval interrupt (`ResumeEntry.payload`). */
export const ApprovalDecision = z.object({
  decision: z.enum(['approve', 'reject']),
  /** Approve only: the item ids still ticked. Ids that were not in the dry run are ignored. */
  selected: z.array(z.number().int().positive()).max(100).optional(),
  /** Approve only: what the user changed in the surface, checked by the tool's own schema. */
  edits: z.unknown().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

// ---------------------------------------------------------------------------
// RunAgentInput.forwardedProps
// ---------------------------------------------------------------------------

/** The side-nav model switch: the cloud model or the local Ollama model. */
export type ModelOption = 'cloud' | 'local';

/** An A2UI action, forwarded the way the AG-UI A2UI middleware does (`forwardedProps.a2uiAction.userAction`). */
export const A2uiUserAction = z.object({
  name: z.string().min(1).max(64),
  surfaceId: z.string().min(1).max(200),
  sourceComponentId: z.string().min(1).max(100),
  timestamp: z.string().max(40),
  context: z.record(z.string(), z.unknown()),
});
export type A2uiUserAction = z.infer<typeof A2uiUserAction>;

export const ForwardedProps = z.object({
  /** "owner/name" picked in the app; a conversation stays on the repo it started with. */
  repo: z.string().max(140).optional(),
  /** Omitted: the server's LLM_PROVIDER decides. */
  model: z.enum(['cloud', 'local']).optional(),
  /** The PR review page: the run must end on a review draft of this pull request. */
  reviewPullRequest: z.number().int().positive().optional(),
  /** The surface action that led to this run (approve, reject, retry, ...). Informational. */
  a2uiAction: z.object({ userAction: A2uiUserAction }).optional(),
});
export type ForwardedProps = z.infer<typeof ForwardedProps>;

// ---------------------------------------------------------------------------
// Shared state (STATE_SNAPSHOT / STATE_DELTA)
// ---------------------------------------------------------------------------

export interface RepoPilotState {
  repo: string | null;
  model: ModelOption | null;
  /** The change waiting for the user, if any. */
  pendingApproval: { interruptId: string; toolCallId: string; surfaceId: string } | null;
  /** Follow-up prompts suggested from what the run showed (chips above the prompt box). */
  followups: string[];
}
