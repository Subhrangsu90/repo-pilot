import { readSurface, rootComponent, surfaceMessages, toNode } from '@repopilot/shared';
import type { ChatMessage } from '../llm';
import { ToolError, type Executor } from '../tools/read-tools';
import { refreshableSurfaces, refreshSurface } from './refresh';
import { surfaceSnapshot } from '@repopilot/shared';

const RUN = '11111111-1111-4111-8111-111111111111';
/** A surface as runs saved before AG-UI + A2UI stored it (upgraded when read). */
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

  it('finds surfaces in A2UI activities (the current format)', () => {
    const table = { component: 'IssueTable', props: { rows: [] } };
    const current = [{ id: RUN, createdAt: '2026-11-11T10:00:00Z', events: [surfaceSnapshot(`${RUN}-c1`, surfaceMessages(`${RUN}-c1`, table))] }];
    expect([...refreshableSurfaces(current, messages).keys()]).toEqual([`${RUN}-c1`]);
  });

  it('ignores a surface id that belongs to another run (a gate card re-sent by the resumed run)', () => {
    const resumed = [{ id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-11-11T10:01:00Z', events: [ui(`${RUN}-c1`)] }];
    expect(refreshableSurfaces(resumed, messages).size).toBe(0);
  });
});

describe('refreshSurface', () => {
  const issueTable = { component: 'IssueTable', props: { rows: [{ number: 9, title: 'IE11', state: 'open', ageDays: 3 }] } };

  it('re-runs the read tool with the stored input (nulls dropped) and returns the surface as A2UI operations', async () => {
    const inputs: unknown[] = [];
    const listIssues: Executor<any> = async (input) => {
      inputs.push(input);
      return { data: {}, ui: issueTable };
    };
    const call = messages[1].role === 'assistant' ? messages[1].toolCalls[0] : (null as never);
    const ops = await refreshSurface(call, { list_issues: listIssues }, {} as never, 's9');
    const view = readSurface(ops);
    expect(view.surfaceId).toBe('s9');
    expect(rootComponent(view)).toBe('IssueTable');
    expect((toNode(view)!.props as { rows: { number: number }[] }).rows.map((r) => r.number)).toEqual([9]);
    expect(inputs).toEqual([{ state: 'open', labels: ['wontfix'], limit: 50 }]);
  });

  it('refuses tools that change things or were written by the model, and invalid output', async () => {
    const never: Executor<any> = async () => {
      throw new Error('must not run');
    };
    const bulk = { id: 'c3', name: 'bulk_update_issues', args: { issueNumbers: [9], action: 'close' } };
    await expect(refreshSurface(bulk, { bulk_update_issues: never }, {} as never, 's1')).rejects.toBeInstanceOf(ToolError);
    await expect(refreshSurface({ id: 'c2', name: 'render_ui', args: {} }, { render_ui: never }, {} as never, 's1')).rejects.toBeInstanceOf(ToolError);

    const broken: Executor<any> = async () => ({ data: {}, ui: { component: 'IssueTable', props: { rows: 'nope' } } });
    await expect(refreshSurface({ id: 'c1', name: 'list_issues', args: {} }, { list_issues: broken }, {} as never, 's1')).rejects.toThrow('could not be shown');
  });
});
