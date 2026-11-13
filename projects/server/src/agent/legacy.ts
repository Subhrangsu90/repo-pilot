import { APPROVAL_INTERRUPT, EventType, META_KEY, surfaceMessages, type AgUiEvent } from '@repopilot/shared';
import { notice, stepFinished, stepStarted, surfaceSnapshot, text, toolCall } from '@repopilot/shared';

/**
 * Runs saved before the switch to AG-UI + A2UI (2026-11-13) stored RepoPilot's
 * own event shapes: CUSTOM `ui` with a node tree, CUSTOM `approval`, CUSTOM
 * `followups`, CUSTOM `client_tool`, and steps keyed by `stepId`. They are
 * upgraded when read, so old conversations still reopen from History.
 */

interface Legacy {
  type?: unknown;
  name?: unknown;
  value?: any;
  stepId?: unknown;
  stepName?: unknown;
  status?: unknown;
  detail?: unknown;
  messageId?: unknown;
  delta?: unknown;
  threadId?: unknown;
  runId?: unknown;
  message?: unknown;
  code?: unknown;
}

/** True when a stored event list uses the old shapes. */
export function isLegacy(events: unknown): boolean {
  if (!Array.isArray(events)) return false;
  return events.some((e: Legacy) => (e?.type === 'CUSTOM' && ['ui', 'approval', 'followups', 'client_tool'].includes(String(e.name))) || ((e?.type === 'STEP_STARTED' || e?.type === 'STEP_FINISHED') && typeof e.stepId === 'string'));
}

/** Stored events in the current shape (old ones upgraded). Unknown entries are dropped. */
export function upgradeEvents(events: unknown): AgUiEvent[] {
  if (!Array.isArray(events)) return [];
  if (!isLegacy(events)) return events as AgUiEvent[];

  const out: AgUiEvent[] = [];
  const emit = (e: AgUiEvent) => void out.push(e);
  const started = new Set<string>();
  let approval: { runId: string; toolCallId: string; surfaceId: string } | undefined;

  for (const e of events as Legacy[]) {
    switch (e?.type) {
      case 'RUN_STARTED':
        emit({ type: EventType.RUN_STARTED, threadId: String(e.threadId), runId: String(e.runId) });
        break;
      case 'STEP_STARTED':
        started.add(String(e.stepId));
        emit(stepStarted(String(e.stepId), String(e.stepName ?? '')));
        break;
      case 'STEP_FINISHED': {
        const id = String(e.stepId);
        const status = e.status === 'error' ? 'error' : 'done';
        const detail = typeof e.detail === 'string' ? e.detail : undefined;
        if (started.has(id)) emit(stepFinished(id, status, detail));
        else notice(emit, id, id.startsWith('approval-') ? 'Waiting for your approval' : 'Notice', status, detail);
        break;
      }
      case 'TEXT_MESSAGE_START':
      case 'TEXT_MESSAGE_END':
        break;
      case 'TEXT_MESSAGE_CONTENT':
        text(emit, String(e.messageId), String(e.delta ?? ''));
        break;
      case 'CUSTOM':
        if (e.name === 'ui' && e.value && typeof e.value.surfaceId === 'string') {
          emit(surfaceSnapshot(e.value.surfaceId, surfaceMessages(e.value.surfaceId, e.value.node)));
        } else if (e.name === 'approval' && e.value) {
          approval = { runId: String(e.value.runId), toolCallId: String(e.value.toolCallId), surfaceId: String(e.value.surfaceId) };
        } else if (e.name === 'followups' && Array.isArray(e.value?.prompts)) {
          emit({ type: EventType.STATE_DELTA, delta: [{ op: 'replace', path: '/followups', value: e.value.prompts.slice(0, 3) }] });
        } else if (e.name === 'client_tool' && e.value) {
          toolCall(emit, String(e.value.callId), String(e.value.name), e.value.args);
        }
        break;
      case 'RUN_FINISHED':
        emit({
          type: EventType.RUN_FINISHED,
          threadId: String(e.threadId),
          runId: String(e.runId),
          outcome: approval
            ? {
                type: 'interrupt',
                interrupts: [
                  {
                    id: approval.toolCallId,
                    reason: APPROVAL_INTERRUPT,
                    toolCallId: approval.toolCallId,
                    metadata: { [META_KEY]: { surfaceId: approval.surfaceId } },
                  },
                ],
              }
            : { type: 'success' },
        });
        break;
      case 'RUN_ERROR':
        emit({ type: EventType.RUN_ERROR, message: String(e.message ?? 'The run failed.'), ...(typeof e.code === 'string' ? { code: e.code } : {}) });
        break;
    }
  }
  return out;
}
