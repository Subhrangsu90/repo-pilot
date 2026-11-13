import { A2UI_ACTIVITY_TYPE, A2UI_OPERATIONS_KEY, activityIdOf, type A2uiMessage } from './a2ui';
import { EventType, META_KEY, type AgUiEvent, type StepMeta } from './events';

/**
 * AG-UI event builders (used by the agent server, and by tests on both sides), and the guard that keeps a run's
 * stream valid. AG-UI clients reject a run that finishes with a step, text
 * message, reasoning span or tool call still open, or that sends anything
 * after RUN_FINISHED; the guard closes what is open when a run ends early
 * (cancelled, failed after UI, ...).
 */

export type Emit = (event: AgUiEvent) => void;

const meta = (m: StepMeta) => ({ [META_KEY]: m });

export function stepStarted(stepId: string, label: string): AgUiEvent {
  return { type: EventType.STEP_STARTED, stepName: stepId, metadata: meta({ label }) };
}

export function stepFinished(stepId: string, status: 'done' | 'error', detail?: string): AgUiEvent {
  return { type: EventType.STEP_FINISHED, stepName: stepId, metadata: meta({ status, ...(detail ? { detail: detail.slice(0, 200) } : {}) }) };
}

/** A notice in the step list (e.g. "primary model overloaded"): a step that starts and ends at once. */
export function notice(emit: Emit, stepId: string, label: string, status: 'done' | 'error', detail?: string) {
  emit(stepStarted(stepId, label));
  emit(stepFinished(stepId, status, detail));
}

/** One complete assistant text message. Empty text sends nothing. */
export function text(emit: Emit, messageId: string, body: string) {
  if (!body) return;
  emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
  emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: body });
  emit({ type: EventType.TEXT_MESSAGE_END, messageId });
}

/** The model's thought summary as one AG-UI reasoning span. Shown as text, never as HTML. */
export function reasoning(emit: Emit, messageId: string, body: string) {
  if (!body) return;
  emit({ type: EventType.REASONING_START, messageId });
  emit({ type: EventType.REASONING_MESSAGE_START, messageId, role: 'reasoning' });
  emit({ type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta: body.slice(0, 4000) });
  emit({ type: EventType.REASONING_MESSAGE_END, messageId });
  emit({ type: EventType.REASONING_END, messageId });
}

/** A tool call as AG-UI events: start, its arguments as JSON, end. */
export function toolCall(emit: Emit, callId: string, name: string, args: unknown, parentMessageId?: string) {
  emit({ type: EventType.TOOL_CALL_START, toolCallId: callId, toolCallName: name, ...(parentMessageId ? { parentMessageId } : {}) });
  emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: callId, delta: JSON.stringify(args ?? {}) });
  emit({ type: EventType.TOOL_CALL_END, toolCallId: callId });
}

/** What a tool returned, as the browser sees it (capped; the model gets the full result). */
export function toolResult(callId: string, content: unknown): AgUiEvent {
  const json = JSON.stringify(content ?? null);
  return {
    type: EventType.TOOL_CALL_RESULT,
    messageId: `${callId}-result`,
    toolCallId: callId,
    role: 'tool',
    content: json.length <= 2000 ? json : `${json.slice(0, 2000)}…`,
  };
}

/** A new A2UI surface: an AG-UI activity holding its full operation list. */
export function surfaceSnapshot(surfaceId: string, operations: A2uiMessage[]): AgUiEvent {
  return {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: activityIdOf(surfaceId),
    activityType: A2UI_ACTIVITY_TYPE,
    content: { [A2UI_OPERATIONS_KEY]: operations },
    replace: true,
  };
}

/** More operations for a surface already on screen (JSON Patch appends to the activity's operations). */
export function surfaceDelta(surfaceId: string, operations: A2uiMessage[]): AgUiEvent {
  return {
    type: EventType.ACTIVITY_DELTA,
    messageId: activityIdOf(surfaceId),
    activityType: A2UI_ACTIVITY_TYPE,
    patch: operations.map((value) => ({ op: 'add' as const, path: `/${A2UI_OPERATIONS_KEY}/-`, value })),
  };
}

/**
 * Tracks what is open in a run so it can be closed before RUN_FINISHED.
 * `track` sees every event; `closeAll` emits the missing ends.
 */
export class StreamGuard {
  private readonly steps = new Set<string>();
  private readonly texts = new Set<string>();
  private readonly tools = new Set<string>();
  private readonly reasoningSpans = new Set<string>();
  private readonly reasoningMessages = new Set<string>();

  track(e: AgUiEvent) {
    switch (e.type) {
      case EventType.STEP_STARTED:
        this.steps.add(e.stepName);
        break;
      case EventType.STEP_FINISHED:
        this.steps.delete(e.stepName);
        break;
      case EventType.TEXT_MESSAGE_START:
        this.texts.add(e.messageId);
        break;
      case EventType.TEXT_MESSAGE_END:
        this.texts.delete(e.messageId);
        break;
      case EventType.TOOL_CALL_START:
        this.tools.add(e.toolCallId);
        break;
      case EventType.TOOL_CALL_END:
        this.tools.delete(e.toolCallId);
        break;
      case EventType.REASONING_START:
        this.reasoningSpans.add(e.messageId);
        break;
      case EventType.REASONING_END:
        this.reasoningSpans.delete(e.messageId);
        break;
      case EventType.REASONING_MESSAGE_START:
        this.reasoningMessages.add(e.messageId);
        break;
      case EventType.REASONING_MESSAGE_END:
        this.reasoningMessages.delete(e.messageId);
        break;
    }
  }

  /** True when a step with this id is running in this run. */
  hasStep(stepId: string): boolean {
    return this.steps.has(stepId);
  }

  closeAll(emit: Emit, why: string) {
    for (const id of [...this.texts]) emit({ type: EventType.TEXT_MESSAGE_END, messageId: id });
    for (const id of [...this.reasoningMessages]) emit({ type: EventType.REASONING_MESSAGE_END, messageId: id });
    for (const id of [...this.reasoningSpans]) emit({ type: EventType.REASONING_END, messageId: id });
    for (const id of [...this.tools]) emit({ type: EventType.TOOL_CALL_END, toolCallId: id });
    for (const id of [...this.steps]) emit(stepFinished(id, 'error', why));
  }
}
