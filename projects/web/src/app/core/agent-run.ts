import type { AgentEvent, ApprovalRequest, PropsOf, UiSurface } from '@repopilot/shared';

export type Step = PropsOf<'StepTimeline'>['steps'][number];

/** One prompt and everything the agent streamed back for it, across the runs it took. */
export interface Turn {
  id: string;
  prompt: string;
  status: 'running' | 'awaiting-approval' | 'done' | 'error';
  steps: Step[];
  /** Validated server-side; validated again by GenUiHost before rendering. */
  surfaces: UiSurface[];
  text: string;
  error?: string;
  /** The ApprovalCard this turn is paused on. */
  pending?: ApprovalRequest;
  /** Sending the approve / reject decision failed; the card can be used again. */
  actionError?: string;
  /** Follow-up prompts suggested from what this turn showed (chips above the prompt box). */
  followups?: string[];
}

/** Client-side step shown while a run waits; the resumed run finishes it under the same id. */
export const approvalStepId = (toolCallId: string) => `approval-${toolCallId}`;

export function newTurn(id: string, prompt: string): Turn {
  return { id, prompt, status: 'running', steps: [], surfaces: [], text: '' };
}

/**
 * Pure reducer: folds one AG-UI-style event into a turn. Kept free of Angular
 * so it is trivial to test and to reuse for replays.
 */
export function applyEvent(turn: Turn, event: AgentEvent): Turn {
  switch (event.type) {
    case 'STEP_STARTED':
      return { ...turn, steps: [...turn.steps, { id: event.stepId, label: event.stepName, status: 'running' }] };

    case 'STEP_FINISHED': {
      const known = turn.steps.some((s) => s.id === event.stepId);
      const finished = { status: event.status, ...(event.detail ? { detail: event.detail } : {}) };
      return {
        ...turn,
        steps: known
          ? turn.steps.map((s) => (s.id === event.stepId ? { ...s, ...finished } : s))
          : // A notice without a start, e.g. "primary model overloaded, using fallback".
            [...turn.steps, { id: event.stepId, label: 'Notice', ...finished }],
      };
    }

    case 'TEXT_MESSAGE_START':
      return turn.text ? { ...turn, text: `${turn.text}\n\n` } : turn;

    case 'TEXT_MESSAGE_CONTENT':
      return { ...turn, text: turn.text + event.delta };

    case 'CUSTOM': {
      if (event.name === 'approval') {
        const step: Step = { id: approvalStepId(event.value.toolCallId), label: 'Waiting for your approval', status: 'pending' };
        return { ...turn, pending: event.value, steps: [...turn.steps, step] };
      }
      if (event.name === 'followups') return { ...turn, followups: event.value.prompts.slice(0, 3) };
      if (event.name !== 'ui') return turn;
      const exists = turn.surfaces.some((s) => s.surfaceId === event.value.surfaceId);
      return {
        ...turn,
        // Same surfaceId = update in place (follow-ups like "only show bugs").
        surfaces: exists
          ? turn.surfaces.map((s) => (s.surfaceId === event.value.surfaceId ? event.value : s))
          : [...turn.surfaces, event.value],
      };
    }

    case 'RUN_FINISHED':
      return { ...turn, status: turn.pending ? 'awaiting-approval' : 'done', steps: settle(turn.steps, 'done') };

    case 'RUN_ERROR':
      return { ...turn, status: 'error', error: event.message, steps: settle(turn.steps, 'error') };

    default:
      return turn;
  }
}

/**
 * Rebuilds a saved conversation from its stored runs (History → Resume). A run
 * with a prompt starts a turn; a run without one resumed after an approval and
 * continues the previous turn, exactly as it streamed live.
 */
export function replayRuns(runs: { id: string; prompt: string | null; events: AgentEvent[] }[]): Turn[] {
  const turns: Turn[] = [];
  for (const run of runs) {
    if (run.prompt !== null || turns.length === 0) {
      turns.push(newTurn(run.id, run.prompt ?? ''));
    } else {
      // The approval was answered: the client cleared `pending` before streaming the resumed run.
      turns[turns.length - 1] = { ...turns[turns.length - 1], pending: undefined, status: 'running' };
    }
    turns[turns.length - 1] = run.events.reduce(applyEvent, turns[turns.length - 1]);
  }
  return turns;
}

function settle(steps: Step[], status: 'done' | 'error'): Step[] {
  return steps.map((s) => (s.status === 'running' ? { ...s, status } : s));
}
