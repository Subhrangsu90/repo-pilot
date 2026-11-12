import type { ChatMessage, LlmProvider, LlmReply, ToolCall } from './types';

/**
 * A scripted model for end-to-end tests (LLM_PROVIDER=mock). The model is the
 * one non-deterministic part of RepoPilot (doc §11), so e2e runs replace it
 * with fixed replies for the demo prompts and test everything around it for
 * real: tool validation, the approval gate, streaming and rendering.
 *
 * Each scenario looks at the latest user prompt and at the tool results since
 * then, and answers the next step.
 */

interface Step {
  prompt: string;
  /** Results of the tools called since the prompt, latest last. */
  results: { name: string; content: unknown }[];
}

interface Scenario {
  match: RegExp;
  reply: (step: Step) => Partial<LlmReply>;
}

let ids = 0;
const call = (name: string, args: unknown): ToolCall => ({ id: `mock-${++ids}`, name, args });
const text = (t: string): Partial<LlmReply> => ({ text: t, toolCalls: [] });
const last = (s: Step) => s.results.at(-1);

const SCENARIOS: Scenario[] = [
  {
    // The Issues page: "Close issues #9 and #10 as not planned", "Reopen issue #12".
    match: /^(close|reopen) issues? #\d/i,
    reply: (s) => {
      const r = last(s)?.content as { rejected?: boolean; changed?: number[] } | undefined;
      if (r) return text(r.rejected ? 'Understood, nothing changed.' : `Updated ${(r.changed ?? []).length} issues.`);
      const numbers = [...s.prompt.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
      return { toolCalls: [call('bulk_update_issues', { issueNumbers: numbers, action: /^reopen/i.test(s.prompt) ? 'reopen' : 'close' })] };
    },
  },
  {
    match: /close .*wontfix/i,
    reply: (s) => {
      if (!last(s)) return { toolCalls: [call('list_issues', { state: 'open', labels: ['wontfix'] })] };
      if (last(s)!.name === 'list_issues') {
        const issues = ((last(s)!.content as { issues?: { number: number }[] }).issues ?? []).map((i) => i.number);
        return { toolCalls: [call('bulk_update_issues', { issueNumbers: issues, action: 'close' })] };
      }
      const r = last(s)!.content as { rejected?: boolean; changed?: number[] };
      if (r.rejected) return text('Understood, nothing was closed.');
      return text(`Closed ${(r.changed ?? []).length} issues.`);
    },
  },
  {
    match: /health report/i,
    reply: (s) => (last(s) ? text('The repository has 3 open pull requests; the oldest open issues are listed above.') : { toolCalls: [call('get_repo_health', {})] }),
  },
  {
    match: /only show bugs/i,
    reply: (s) =>
      last(s) ? text('The table now shows only issues labelled bug.') : { toolCalls: [call('apply_table_filter', { target: 'IssueTable', labels: ['bug'] })] },
  },
  {
    match: /open (prs|pull requests)/i,
    reply: (s) => (last(s) ? text('You have 3 open pull requests; #15 has failing CI.') : { toolCalls: [call('list_pull_requests', { state: 'open' })] }),
  },
];

export function createMock(): LlmProvider {
  return {
    name: 'mock',
    model: 'mock-1',
    async generate({ messages }) {
      const prompt = latestPrompt(messages);
      const scenario = SCENARIOS.find((s) => s.match.test(prompt.text));
      const reply = scenario ? scenario.reply({ prompt: prompt.text, results: resultsSince(messages, prompt.index) }) : text('The mock model has no script for this prompt.');
      return { text: '', toolCalls: [], model: 'mock-1', ...reply };
    },
  };
}

function latestPrompt(messages: ChatMessage[]): { text: string; index: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && !m.text.startsWith('[RepoPilot app]')) return { text: m.text, index: i };
  }
  return { text: '', index: -1 };
}

function resultsSince(messages: ChatMessage[], from: number) {
  return messages.slice(from + 1).flatMap((m) => (m.role === 'tool' ? m.results.map((r) => ({ name: r.name, content: r.content })) : []));
}
