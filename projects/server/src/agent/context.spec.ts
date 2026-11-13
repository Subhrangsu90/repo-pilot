import type { ChatMessage } from '../llm';
import { contextWindow, summarise, withSummary } from './context';

/** A turn: prompt, one tool call and its result, then the reply. */
function turn(n: number, content: unknown = { count: n }): ChatMessage[] {
  return [
    { role: 'user', text: `prompt ${n}` },
    { role: 'assistant', text: '', toolCalls: [{ id: `c${n}`, name: 'list_issues', args: { state: 'open' } }], raw: { provider: 'gemini', data: { n } } },
    { role: 'tool', results: [{ callId: `c${n}`, name: 'list_issues', content }] },
    { role: 'assistant', text: `reply ${n}`, toolCalls: [] },
  ];
}

describe('contextWindow', () => {
  it('sends short conversations whole, without a summary', () => {
    const thread = [1, 2, 3, 4, 5, 6].flatMap((n) => turn(n));
    expect(contextWindow(thread)).toEqual({ messages: thread });
  });

  it('keeps the last 6 turns whole, starting at a prompt, and summarises the rest', () => {
    const thread = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => turn(n));
    const { messages, summary } = contextWindow(thread);
    expect(messages).toEqual(thread.slice(8)); // turns 3–8
    expect(messages[0]).toEqual({ role: 'user', text: 'prompt 3' });
    // Tool calls stay with their results, and raw provider parts are untouched.
    expect(messages[1]).toMatchObject({ raw: { provider: 'gemini', data: { n: 3 } } });
    expect(summary!.split('\n')).toEqual([
      '- User: "prompt 1" → tools: list_issues({"state":"open"}) [done] → agent: "reply 1"',
      '- User: "prompt 2" → tools: list_issues({"state":"open"}) [done] → agent: "reply 2"',
    ]);
  });

  it('does not count app notes as turns', () => {
    const thread: ChatMessage[] = [
      ...turn(1),
      { role: 'user', text: '[RepoPilot app] A review draft was shown to the user and they decided on it.' },
      { role: 'assistant', text: 'Noted.', toolCalls: [] },
      ...[2, 3, 4, 5, 6].flatMap((n) => turn(n)),
    ];
    expect(contextWindow(thread).summary).toBeUndefined();
  });

  it('summarises how changes ended: rejected, failed or still waiting', () => {
    const summary = summarise([
      ...turn(1, { rejected: true, message: 'The user rejected this change.' }),
      ...turn(2, { error: 'GitHub said no' }),
      ...turn(3, null),
    ]);
    expect(summary).toContain('[rejected by the user, nothing changed]');
    expect(summary).toContain('[failed: GitHub said no]');
    expect(summary).toContain('[waiting for approval]');
  });

  it('keeps the summary short by dropping the oldest lines first', () => {
    const long = (n: number): ChatMessage[] => [
      { role: 'user', text: `prompt ${n} ${'x'.repeat(190)}` },
      { role: 'assistant', text: `reply ${n} ${'y'.repeat(290)}`, toolCalls: [] },
    ];
    const summary = summarise([...Array(20).keys()].flatMap(long));
    expect(summary.length).toBeLessThanOrEqual(4000);
    expect(summary).not.toContain('prompt 0 ');
    expect(summary).toContain('prompt 19 ');
  });

  it('appends the summary to the system prompt only when there is one', () => {
    expect(withSummary('sys', undefined)).toBe('sys');
    expect(withSummary('sys', '- User: "hi"')).toMatch(/^sys\n\nEarlier in this conversation .*\n- User: "hi"$/s);
  });
});
