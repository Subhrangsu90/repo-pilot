import { randomUUID } from 'node:crypto';
import { EventType, type AgUiEvent } from '@repopilot/shared';
import { EventSchemas } from '@ag-ui/core/schemas';
import { cancelRun, RunIdTakenError, startRun, subscribe, ThreadBusyError, type RunBody } from './runs';
import { stepFinished, stepStarted } from '@repopilot/shared';

/** Starts a run and resolves with all its events once it ends. */
function run(body: RunBody, threadId = randomUUID(), runId = randomUUID()) {
  startRun(threadId, runId, body, { owner: 'octocat', repo: 'octo/demo' });
  const events: AgUiEvent[] = [];
  const done = new Promise<AgUiEvent[]>((resolve) => {
    subscribe(runId, (e) => {
      events.push(e);
      if (e.type === EventType.RUN_FINISHED || e.type === EventType.RUN_ERROR) resolve(events);
    });
  });
  return { threadId, runId, done };
}

const types = (events: AgUiEvent[]) => events.map((e) => e.type);

describe('AG-UI runs', () => {
  it('opens with RUN_STARTED and the shared state, and closes with the outcome and summed token usage', async () => {
    const { done, threadId, runId } = run(async (_t, emit, ctl) => {
      emit(stepStarted('s1', 'Understanding the request'));
      emit(stepFinished('s1', 'done'));
      ctl.addUsage({ provider: 'gemini', model: 'flash', inputTokens: 5, outputTokens: 2, reasoningTokens: 1 });
      ctl.addUsage({ provider: 'gemini', model: 'flash', inputTokens: 1, outputTokens: 1 });
    });
    const events = await done;
    expect(types(events)).toEqual(['RUN_STARTED', 'STATE_SNAPSHOT', 'STEP_STARTED', 'STEP_FINISHED', 'RUN_FINISHED']);
    expect(events[0]).toMatchObject({ threadId, runId, protocolVersion: '1.0' });
    expect(events[1]).toMatchObject({ snapshot: { repo: 'octo/demo', pendingApproval: null, followups: [] } });
    expect(events.at(-1)).toMatchObject({
      outcome: { type: 'success' },
      usage: [{ provider: 'gemini', model: 'flash', inputTokens: 6, outputTokens: 3, reasoningTokens: 1, totalTokens: 9 }],
    });
    for (const e of events) expect(() => EventSchemas.parse(e)).not.toThrow();
  });

  it('ends with the interrupt outcome the body returns', async () => {
    const { done } = run(async () => ({ outcome: { type: 'interrupt', interrupts: [{ id: 'c1', reason: 'tool_approval', toolCallId: 'c1' }] } }));
    expect((await done).at(-1)).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'interrupt', interrupts: [{ id: 'c1' }] } });
  });

  it('closes open steps and messages, then ends as cancelled, when the run is stopped', async () => {
    const { done, runId } = run(async (_t, emit, ctl) => {
      emit(stepStarted('s1', 'Thinking'));
      emit({ type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' });
      await new Promise((resolve) => ctl.signal.addEventListener('abort', resolve));
      throw new Error('aborted');
    });
    setTimeout(() => cancelRun(runId), 5);
    const events = await done;
    expect(types(events).slice(-3)).toEqual(['TEXT_MESSAGE_END', 'STEP_FINISHED', 'RUN_FINISHED']);
    expect(events.at(-1)).toMatchObject({ outcome: { type: 'cancelled' } });
  });

  it('ends a failed run with RUN_ERROR and nothing after it', async () => {
    const { done } = run(async () => {
      throw new Error('model down');
    });
    const events = await done;
    expect(events.at(-1)).toMatchObject({ type: 'RUN_ERROR', message: 'model down' });
  });

  it('refuses a reused run id and a second run on a busy thread', async () => {
    let release!: () => void;
    const first = run(() => new Promise<void>((r) => (release = r)));
    expect(() => startRun(randomUUID(), first.runId, async () => {})).toThrow(RunIdTakenError);
    expect(() => startRun(first.threadId, randomUUID(), async () => {})).toThrow(ThreadBusyError);
    release();
    await first.done;
  });
});
