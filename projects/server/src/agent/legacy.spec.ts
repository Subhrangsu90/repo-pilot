import { A2UI_OPERATIONS_KEY, readSurface, rootComponent, stepMeta, type A2uiMessage, type AgUiEvent } from '@repopilot/shared';
import { EventSchemas } from '@ag-ui/core/schemas';
import { isLegacy, upgradeEvents } from './legacy';

/** A paused approval run as stored before AG-UI + A2UI. */
const stored = [
  { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' },
  { type: 'STEP_STARTED', stepId: 'r1-think-0', stepName: 'Understanding the request' },
  { type: 'STEP_FINISHED', stepId: 'r1-think-0', status: 'done', detail: 'gemma4' },
  { type: 'STEP_FINISHED', stepId: 'r1-fallback', status: 'error', detail: 'overloaded' },
  { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Here it is.' },
  { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
  { type: 'CUSTOM', name: 'ui', value: { surfaceId: 'r1-c1', node: { component: 'StatCard', props: { label: 'PRs', value: 3 } } } },
  { type: 'CUSTOM', name: 'client_tool', value: { callId: 'h1', name: 'highlight_lines', args: { path: 'a.js', from: 1, to: 2 } } },
  { type: 'CUSTOM', name: 'followups', value: { prompts: ['Only show bugs'] } },
  { type: 'CUSTOM', name: 'approval', value: { runId: 'r1', toolCallId: 'c2', surfaceId: 'r1-c2' } },
  { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' },
];

describe('upgradeEvents', () => {
  it('turns stored runs from before AG-UI + A2UI into valid AG-UI events', () => {
    expect(isLegacy(stored)).toBe(true);
    const events = upgradeEvents(stored);
    for (const e of events) expect(() => EventSchemas.parse(e)).not.toThrow();

    const types = events.map((e) => e.type);
    expect(types).toContain('ACTIVITY_SNAPSHOT');
    expect(types).toContain('TOOL_CALL_START');
    expect(types).toContain('STATE_DELTA');
    // A finish without a start becomes a notice step (AG-UI pairs every step).
    const steps = events.filter((e) => e.type === 'STEP_STARTED').map((e) => stepMeta(e as never).label);
    expect(steps).toEqual(['Understanding the request', 'Notice']);
    // The UI node became an A2UI surface; the approval became the run's interrupt.
    const snapshot = events.find((e) => e.type === 'ACTIVITY_SNAPSHOT') as Extract<AgUiEvent, { type: 'ACTIVITY_SNAPSHOT' }>;
    expect(rootComponent(readSurface(snapshot.content[A2UI_OPERATIONS_KEY] as A2uiMessage[]))).toBe('StatCard');
    expect(events.at(-1)).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'interrupt', interrupts: [{ id: 'c2', toolCallId: 'c2' }] } });
  });

  it('leaves current events alone', () => {
    const current = [{ type: 'RUN_STARTED', threadId: 't', runId: 'r' }, { type: 'RUN_FINISHED', threadId: 't', runId: 'r' }];
    expect(isLegacy(current)).toBe(false);
    expect(upgradeEvents(current)).toBe(current);
    expect(upgradeEvents(null)).toEqual([]);
  });
});
