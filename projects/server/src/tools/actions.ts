import * as z from 'zod';
import { bulkUpdateIssues, PropsOf } from '@repopilot/shared';
import { GitHubError } from '../github/client';
import { ageDays, resolveRepo, ToolContext, ToolError } from './read-tools';

/**
 * Write and destructive tools. Each has two halves:
 * - `plan` is the dry run: it only reads, and says exactly what would change;
 * - `execute` makes the change, and is only ever called by the agent loop
 *   after the user approved, with the ids they kept ticked.
 */
export type CardDraft = Omit<PropsOf<'ApprovalCard'>, 'toolCallId' | 'tool' | 'risk' | 'status' | 'selected' | 'result'>;

export type Plan =
  /** Nothing would change: no card, the data goes straight back to the model. */
  | { kind: 'empty'; data: Record<string, unknown>; detail: string }
  /** Show this card; `ids` are the only items an approval may pick. */
  | { kind: 'card'; card: CardDraft; ids: number[]; detail: string };

export interface Outcome {
  /** False when any part of the change failed. */
  ok: boolean;
  /** What the model sees. */
  data: Record<string, unknown>;
  /** One line for the card. */
  result: string;
  /** Short line for the step timeline. */
  detail: string;
}

export interface ActionTool<S extends { input: z.ZodType }> {
  plan(input: z.output<S['input']>, ctx: ToolContext): Promise<Plan>;
  execute(input: z.output<S['input']>, ids: number[], ctx: ToolContext): Promise<Outcome>;
}

// ---------------------------------------------------------------------------
// bulk_update_issues
// ---------------------------------------------------------------------------

interface IssueJson {
  number: number;
  title: string;
  state: 'open' | 'closed';
  created_at: string;
  labels: { name: string }[];
  pull_request?: unknown;
}

const REASON_TEXT = { not_planned: 'not planned', completed: 'completed' } as const;

export const bulkUpdateIssuesTool: ActionTool<typeof bulkUpdateIssues> = {
  async plan(input, ctx) {
    const repo = resolveRepo(input.repo, ctx);
    const numbers = [...new Set(input.issueNumbers)];
    const closing = input.action === 'close';

    // One GET per issue: exact, and cheap next to the 5,000/hour budget.
    const fetched = await mapLimit(numbers, 6, async (n) => {
      try {
        return await ctx.github.rest<IssueJson>(`/repos/${repo.owner}/${repo.name}/issues/${n}`);
      } catch (err) {
        if (err instanceof GitHubError && (err.status === 404 || err.status === 410)) return null;
        throw err;
      }
    });

    const items: CardDraft['items'] = [];
    const skipped: CardDraft['skipped'] = [];
    numbers.forEach((n, i) => {
      const issue = fetched[i];
      if (!issue) return skipped.push({ id: n, reason: 'not found' });
      if (issue.pull_request) return skipped.push({ id: n, reason: 'is a pull request' });
      if (closing && issue.state === 'closed') return skipped.push({ id: n, reason: 'already closed' });
      if (!closing && issue.state === 'open') return skipped.push({ id: n, reason: 'already open' });
      const labels = issue.labels.map((l) => l.name).join(', ');
      const age = ageDays(issue.created_at);
      items.push({
        id: n,
        title: issue.title.slice(0, 256),
        meta: `${labels ? `${labels} · ` : ''}${age} ${age === 1 ? 'day' : 'days'}`.slice(0, 80),
      });
    });

    if (items.length === 0) {
      return {
        kind: 'empty',
        data: { repo: repo.full, nothingToChange: true, skipped },
        detail: 'nothing to change',
      };
    }

    const reason = REASON_TEXT[input.reason];
    return {
      kind: 'card',
      ids: items.map((i) => i.id),
      detail: `${items.length} would change`,
      card: {
        verb: input.action,
        noun: 'issue',
        summary: closing
          ? `Each selected issue will be closed as "${reason}". Labels and comments stay as they are.`
          : 'Each selected issue will be reopened. Labels and comments stay as they are.',
        items,
        skipped,
        effect: closing ? { from: 'open', to: `closed · ${reason}` } : { from: 'closed', to: 'open' },
        details: [
          { label: 'Tool', value: bulkUpdateIssues.name, mono: true },
          { label: 'Repo', value: repo.full, mono: true },
        ],
        requestMethod: 'PATCH',
        reversible: true,
        undoHint: closing ? 'Reversible: closed issues can be reopened.' : 'Reversible: the issues can be closed again.',
      },
    };
  },

  async execute(input, ids, ctx) {
    const repo = resolveRepo(input.repo, ctx);
    if (ids.length === 0) throw new ToolError('No issues were approved.');
    const body = input.action === 'close' ? { state: 'closed', state_reason: input.reason } : { state: 'open' };

    const results = await mapLimit(ids, 4, async (n) => {
      try {
        await ctx.github.rest(`/repos/${repo.owner}/${repo.name}/issues/${n}`, { method: 'PATCH', body });
        return { number: n, ok: true as const };
      } catch (err) {
        const error = err instanceof GitHubError ? `HTTP ${err.status}` : 'request failed';
        return { number: n, ok: false as const, error };
      }
    });

    const changed = results.filter((r) => r.ok).map((r) => r.number);
    const failed = results.filter((r) => !r.ok).map(({ number, error }) => ({ number, error }));
    const verb = input.action === 'close' ? 'Closed' : 'Reopened';
    const noun = (n: number) => `${n} ${n === 1 ? 'issue' : 'issues'}`;
    const result = failed.length
      ? `${verb} ${changed.length} of ${noun(ids.length)}. Failed: ${failed.map((f) => `#${f.number} (${f.error})`).join(', ')}.`
      : `${verb} ${noun(changed.length)}.`;

    return {
      ok: failed.length === 0,
      data: { repo: repo.full, action: input.action, changed, failed },
      result: result.slice(0, 400),
      detail: failed.length ? `${changed.length} done, ${failed.length} failed` : `${changed.length} ${input.action === 'close' ? 'closed' : 'reopened'}`,
    };
  },
};

// ---------------------------------------------------------------------------

export const actions: Record<string, ActionTool<{ input: z.ZodType }>> = {
  [bulkUpdateIssues.name]: bulkUpdateIssuesTool as ActionTool<{ input: z.ZodType }>,
};

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
