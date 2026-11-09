import type { AgentEvent } from '@repopilot/shared';
import { applyEvent, newTurn, Turn } from './agent-run';

const fold = (events: AgentEvent[]): Turn => events.reduce(applyEvent, newTurn('t1', 'Show my open PRs'));
const prList = (title: string) => ({ component: 'PrList', props: { title, items: [] } });

describe('applyEvent', () => {
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

  it('shows a finish event without a start as a notice (model fallback)', () => {
    const turn = fold([{ type: 'STEP_FINISHED', stepId: 'f', status: 'error', detail: 'overloaded; trying fallback' }]);
    expect(turn.steps).toEqual([{ id: 'f', label: 'Notice', status: 'error', detail: 'overloaded; trying fallback' }]);
  });
});
