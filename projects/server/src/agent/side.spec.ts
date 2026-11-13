import type { ChatMessage, LlmToolDef } from '../llm';
import type { PendingApproval } from './loop';
import { buildToolDefs } from './prompt';
import { readOnlyTools, sideHistory } from './side';

const thread: ChatMessage[] = [
  { role: 'user', text: 'Review pull request #15' },
  {
    role: 'assistant',
    text: '',
    toolCalls: [
      { id: 'r1', name: 'submit_pull_request_review', args: { number: 15 } },
      { id: 'g1', name: 'get_pull_request', args: { number: 15 } },
    ],
  },
];
const pending = {
  callId: 'r1',
  results: [
    { callId: 'r1', name: 'submit_pull_request_review', content: null },
    { callId: 'g1', name: 'get_pull_request', content: { number: 15 } },
  ],
} as unknown as PendingApproval;

describe('sideHistory', () => {
  it('answers the paused call with "not decided yet" on a copy, leaving the thread as it was', () => {
    const before = structuredClone(thread);
    const copy = sideHistory(thread, pending);
    expect(thread).toEqual(before);
    expect(copy.at(-1)).toEqual({
      role: 'tool',
      results: [
        { callId: 'r1', name: 'submit_pull_request_review', content: { waiting: true, note: expect.stringContaining('not decided') } },
        { callId: 'g1', name: 'get_pull_request', content: { number: 15 } },
      ],
    });
  });

  it('adds nothing for a review the app drafted (it has no tool call in the thread)', () => {
    const tail: ChatMessage[] = [...thread.slice(0, 1), { role: 'assistant', text: 'Looks fine.', toolCalls: [] }];
    expect(sideHistory(tail, { ...pending, synthetic: true })).toEqual(tail);
  });
});

describe('readOnlyTools', () => {
  it('keeps read and client tools and drops every tool that changes the repository', () => {
    const names = readOnlyTools(buildToolDefs()).map((t: LlmToolDef) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_issues', 'get_pull_request', 'navigate_to', 'highlight_lines', 'apply_table_filter']));
    expect(names).not.toContain('bulk_update_issues');
    expect(names).not.toContain('submit_pull_request_review');
    expect(names).not.toContain('create_release');
  });
});
