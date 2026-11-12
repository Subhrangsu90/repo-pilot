import { validateNode } from '@repopilot/shared';
import { createMock } from '../llm/mock';
import type { ChatMessage } from '../llm';
import { bulkUpdateIssuesTool } from '../tools/actions';
import { runGetRepoHealth, runListIssues, runListPullRequests, type ToolContext } from '../tools/read-tools';
import { FAKE_REPO, FakeGitHub } from './fake-github';

describe('FakeGitHub (E2E_MODE)', () => {
  const setup = () => {
    const fake = new FakeGitHub();
    return { fake, ctx: { github: fake, allowlist: [FAKE_REPO] } as unknown as ToolContext };
  };

  it('answers every read tool the demo uses with valid UI', async () => {
    const { ctx } = setup();
    const prs = await runListPullRequests({ state: 'open', limit: 20 } as never, ctx);
    const issues = await runListIssues({ state: 'open', labels: ['wontfix'], limit: 50 } as never, ctx);
    const health = await runGetRepoHealth({} as never, ctx);
    for (const out of [prs, issues, health]) expect(validateNode(out.ui).ok).toBe(true);
    expect(prs.detail).toBe('3 found');
    expect((issues.data as { issues: { number: number }[] }).issues.map((i) => i.number)).toEqual([9, 10, 11]);
  });

  it('records writes, applies them, and resets to the seeded data', async () => {
    const { fake, ctx } = setup();
    const plan = await bulkUpdateIssuesTool.plan({ issueNumbers: [9, 10], action: 'close', reason: 'not_planned' }, ctx);
    expect(plan.kind).toBe('card');
    expect(fake.writes).toEqual([]); // the dry run only reads

    await bulkUpdateIssuesTool.execute({ issueNumbers: [9, 10], action: 'close', reason: 'not_planned' }, [9], ctx, {});
    expect(fake.writes).toEqual([{ method: 'PATCH', path: `/repos/${FAKE_REPO}/issues/9`, body: { state: 'closed', state_reason: 'not_planned' } }]);
    expect((await runListIssues({ state: 'open', labels: ['wontfix'], limit: 50 } as never, ctx)).detail).toBe('2 found');

    fake.reset();
    expect(fake.writes).toEqual([]);
    expect((await runListIssues({ state: 'open', labels: ['wontfix'], limit: 50 } as never, ctx)).detail).toBe('3 found');
  });

  it('refuses calls it does not mock and other repositories, instead of reaching the real API', async () => {
    const { fake } = setup();
    await expect(fake.rest(`/repos/${FAKE_REPO}/pulls/15/files`)).rejects.toThrow('not mocked');
    await expect(fake.rest('/repos/someone/else/issues')).rejects.toThrow('not found');
  });
});

describe('mock model (LLM_PROVIDER=mock)', () => {
  it('follows its script: list, then the bulk change, then a summary of the result', async () => {
    const mock = createMock();
    const messages: ChatMessage[] = [{ role: 'user', text: 'Close all open wontfix issues' }];
    const first = await mock.generate({ system: '', messages, tools: [] });
    expect(first.toolCalls.map((c) => c.name)).toEqual(['list_issues']);

    messages.push({ role: 'assistant', text: '', toolCalls: first.toolCalls }, { role: 'tool', results: [{ callId: first.toolCalls[0].id, name: 'list_issues', content: { issues: [{ number: 9 }, { number: 10 }] } }] });
    const second = await mock.generate({ system: '', messages, tools: [] });
    expect(second.toolCalls[0]).toMatchObject({ name: 'bulk_update_issues', args: { issueNumbers: [9, 10], action: 'close' } });

    messages.push({ role: 'assistant', text: '', toolCalls: second.toolCalls }, { role: 'tool', results: [{ callId: second.toolCalls[0].id, name: 'bulk_update_issues', content: { changed: [9] } }] });
    expect((await mock.generate({ system: '', messages, tools: [] })).text).toBe('Closed 1 issues.');
  });

  it('reads issue numbers from the Issues page prompt', async () => {
    const reply = await createMock().generate({ system: '', messages: [{ role: 'user', text: 'Close issues #9 and #10 as not planned' }], tools: [] });
    expect(reply.toolCalls[0]).toMatchObject({ name: 'bulk_update_issues', args: { issueNumbers: [9, 10], action: 'close' } });
  });
});
