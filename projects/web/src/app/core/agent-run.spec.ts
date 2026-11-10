import type { AgentEvent } from '@repopilot/shared';
import { applyEvent, newTurn, Turn } from './agent-run';

const fold = (events: AgentEvent[]): Turn => events.reduce(applyEvent, newTurn('t1', 'Show my open PRs'));
const prList = (title: string) => ({ component: 'PrList', props: { title, items: [] } });

describe('applyEvent', () => {
  it('keeps at most three follow-up prompts from the server', () => {
    const turn = fold([{ type: 'CUSTOM', name: 'followups', value: { prompts: ['a', 'b', 'c', 'd'] } }]);
    expect(turn.followups).toEqual(['a', 'b', 'c']);
  });

  it('builds a turn from a full run', () => {
    const turn = fold([
      { type: 'RUN_STARTED', threadId: 'th', runId: 'r' },
      { type: 'STEP_STARTED', stepId: 's1', stepName: 'Understanding the request' },
      { type: 'STEP_FINISHED', stepId: 's1', status: 'done', detail: 'gemini-3.6-flash' },
      { type: 'STEP_STARTED', stepId: 's2', stepName: 'Listing pull requests' },
      { type: 'CUSTOM', name: 'ui', value: { surfaceId: 'u1', node: prList('Open PRs') } },
      { type: 'STEP_FINISHED', stepId: 's2', status: 'done', detail: '3 found' },
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Three open PRs.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      { type: 'RUN_FINISHED', threadId: 'th', runId: 'r' },
    ]);

    expect(turn.status).toBe('done');
    expect(turn.steps.map((s) => [s.label, s.status, s.detail])).toEqual([
      ['Understanding the request', 'done', 'gemini-3.6-flash'],
      ['Listing pull requests', 'done', '3 found'],
    ]);
    expect(turn.surfaces).toHaveLength(1);
    expect(turn.text).toBe('Three open PRs.');
  });

  it('replaces a surface that arrives again with the same id', () => {
    const turn = fold([
      { type: 'CUSTOM', name: 'ui', value: { surfaceId: 'u1', node: prList('All') } },
      { type: 'CUSTOM', name: 'ui', value: { surfaceId: 'u1', node: prList('Only bugs') } },
    ]);
    expect(turn.surfaces).toHaveLength(1);
    expect(turn.surfaces[0].node).toEqual(prList('Only bugs'));
  });

  it('separates multiple assistant messages', () => {
    const msg = (id: string, text: string): AgentEvent[] => [
      { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: text },
    ];
    expect(fold([...msg('a', 'First.'), ...msg('b', 'Second.')]).text).toBe('First.\n\nSecond.');
  });

  it('marks running steps as failed on error', () => {
    const turn = fold([
      { type: 'STEP_STARTED', stepId: 's1', stepName: 'Thinking' },
      { type: 'RUN_ERROR', message: 'gemini: HTTP 503' },
    ]);
    expect(turn).toMatchObject({ status: 'error', error: 'gemini: HTTP 503' });
    expect(turn.steps[0].status).toBe('error');
  });

  it('pauses on an approval and continues in the same turn when the resumed run streams in', () => {
    const paused = fold([
      { type: 'RUN_STARTED', threadId: 'th', runId: 'r1' },
      { type: 'CUSTOM', name: 'ui', value: { surfaceId: 'r1-c1', node: { component: 'ApprovalCard', props: { status: 'pending' } } } },
      { type: 'CUSTOM', name: 'approval', value: { runId: 'r1', toolCallId: 'c1', surfaceId: 'r1-c1' } },
      { type: 'RUN_FINISHED', threadId: 'th', runId: 'r1' },
    ]);
    expect(paused.status).toBe('awaiting-approval');
    expect(paused.pending).toEqual({ runId: 'r1', toolCallId: 'c1', surfaceId: 'r1-c1' });
    // Settling the run must not mark the wait as done.
    expect(paused.steps).toEqual([{ id: 'approval-c1', label: 'Waiting for your approval', status: 'pending' }]);

    // The session clears `pending` when it sends the decision; then the resumed run arrives.
    const resumed: AgentEvent[] = [
      { type: 'RUN_STARTED', threadId: 'th', runId: 'r2' },
      { type: 'STEP_FINISHED', stepId: 'approval-c1', status: 'done', detail: 'Approved 5' },
      { type: 'CUSTOM', name: 'ui', value: { surfaceId: 'r1-c1', node: { component: 'ApprovalCard', props: { status: 'approved' } } } },
      { type: 'RUN_FINISHED', threadId: 'th', runId: 'r2' },
    ];
    const done = resumed.reduce(applyEvent, { ...paused, status: 'running', pending: undefined } as Turn);
    expect(done.status).toBe('done');
    expect(done.steps[0]).toMatchObject({ status: 'done', detail: 'Approved 5' });
    expect(done.surfaces).toHaveLength(1);
    expect(done.surfaces[0].node.props).toEqual({ status: 'approved' });
  });

  it('shows a finish event without a start as a notice (model fallback)', () => {
    const turn = fold([{ type: 'STEP_FINISHED', stepId: 'f', status: 'error', detail: 'overloaded; trying fallback' }]);
    expect(turn.steps).toEqual([{ id: 'f', label: 'Notice', status: 'error', detail: 'overloaded; trying fallback' }]);
  });
});
