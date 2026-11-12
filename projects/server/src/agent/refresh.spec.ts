import type { ChatMessage } from '../llm';
import { ToolError, type Executor } from '../tools/read-tools';
import { refreshableSurfaces, refreshSurface } from './refresh';

const RUN = '11111111-1111-4111-8111-111111111111';
const ui = (surfaceId: string, component = 'IssueTable') => ({ type: 'CUSTOM', name: 'ui', value: { surfaceId, node: { component, props: {} } } });

const messages: ChatMessage[] = [
  { role: 'user', text: 'Close the wontfix issues' },
  {
    role: 'assistant',
    text: '',
    toolCalls: [
      { id: 'c1', name: 'list_issues', args: { state: 'open', labels: ['wontfix'], limit: null } },
      { id: 'c2', name: 'render_ui', args: { node: { component: 'StatCard', props: { label: 'x', value: 1 } } } },
    ],
  },
  { role: 'tool', results: [] },
  { role: 'assistant', text: '', toolCalls: [{ id: 'c3', name: 'bulk_update_issues', args: { issueNumbers: [9], action: 'close' } }] },
];
const runs = [
  {
    id: RUN,
    createdAt: '2026-11-11T10:00:00Z',
    events: [ui(`${RUN}-c1`), ui(`${RUN}-c2`, 'StatCard'), ui(`${RUN}-c3`, 'ApprovalCard'), ui(`${RUN}-unknown`), { type: 'RUN_FINISHED' }],
  },
];

describe('refreshableSurfaces', () => {
  it('offers only surfaces made by read tools, never render_ui views or approval cards', () => {
    const found = refreshableSurfaces(runs, messages);
    expect([...found.keys()]).toEqual([`${RUN}-c1`]);
    expect(found.get(`${RUN}-c1`)).toMatchObject({ call: { name: 'list_issues' }, capturedAt: '2026-11-11T10:00:00.000Z' });
  });

  it('ignores a surface id that belongs to another run (a gate card re-sent by the resumed run)', () => {
    const resumed = [{ id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-11-11T10:01:00Z', events: [ui(`${RUN}-c1`)] }];
    expect(refreshableSurfaces(resumed, messages).size).toBe(0);
  });
});

describe('refreshSurface', () => {
  const issueTable = { component: 'IssueTable', props: { rows: [{ number: 9, title: 'IE11', state: 'open', ageDays: 3 }] } };

  it('re-runs the read tool with the stored input (nulls dropped) and returns the validated node', async () => {
    const inputs: unknown[] = [];
    const listIssues: Executor<any> = async (input) => {
      inputs.push(input);
      return { data: {}, ui: issueTable };
    };
    const node = await refreshSurface(messages[1].role === 'assistant' ? messages[1].toolCalls[0] : (null as never), { list_issues: listIssues }, {} as never);
    expect(node).toEqual(issueTable);
    expect(inputs).toEqual([{ state: 'open', labels: ['wontfix'], limit: 50 }]);
  });

  it('refuses tools that change things or were written by the model, and invalid output', async () => {
    const never: Executor<any> = async () => {
      throw new Error('must not run');
    };
    const bulk = { id: 'c3', name: 'bulk_update_issues', args: { issueNumbers: [9], action: 'close' } };
    await expect(refreshSurface(bulk, { bulk_update_issues: never }, {} as never)).rejects.toBeInstanceOf(ToolError);
    await expect(refreshSurface({ id: 'c2', name: 'render_ui', args: {} }, { render_ui: never }, {} as never)).rejects.toBeInstanceOf(ToolError);

    const broken: Executor<any> = async () => ({ data: {}, ui: { component: 'IssueTable', props: { rows: 'nope' } } });
    await expect(refreshSurface({ id: 'c1', name: 'list_issues', args: {} }, { list_issues: broken }, {} as never)).rejects.toThrow('could not be shown');
  });
});
