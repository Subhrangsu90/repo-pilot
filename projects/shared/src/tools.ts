/**
 * Agent tool specs: name, risk tier, input schema and the description the
 * model sees. Executors live in the server; the risk tier, not the model,
 * decides whether a tool runs immediately (see `needsApproval`).
 */
import * as z from 'zod';
import { UiNodeSchema } from './catalog';

export type Risk = 'read' | 'write' | 'destructive';

export interface ToolSpec<I extends z.ZodType = z.ZodType> {
  name: string;
  risk: Risk;
  /** Told to the model: when to use the tool, not only what it does. */
  description: string;
  /** Shown in the step timeline while the tool runs. */
  label: string;
  input: I;
}

const repoRef = z
  .string()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'Use owner/repo')
  .optional()
  .describe('owner/repo. Omit to use the default repository.');

export const listPullRequests = {
  name: 'list_pull_requests',
  risk: 'read',
  label: 'Listing pull requests',
  description:
    'List pull requests with CI status, reviewers, age and size. Use for "show my PRs", "which PRs are stuck", ' +
    '"open PRs". The result is shown to the user as a PrList automatically.',
  input: z.object({
    repo: repoRef,
    state: z.enum(['open', 'closed', 'merged', 'all']).default('open'),
    author: z.string().max(39).optional().describe('GitHub login, or "@me" for the signed-in user.'),
    limit: z.number().int().min(1).max(50).default(20),
  }),
} as const satisfies ToolSpec;

export const listIssues = {
  name: 'list_issues',
  risk: 'read',
  label: 'Listing issues',
  description:
    'List issues (pull requests excluded) with labels and age. Use for issue questions and before any ' +
    'bulk change. The result is shown to the user as an IssueTable automatically.',
  input: z.object({
    repo: repoRef,
    state: z.enum(['open', 'closed', 'all']).default('open'),
    labels: z.array(z.string().max(50)).max(5).default([]).describe('Issues must have all of these labels.'),
    olderThanDays: z.number().int().min(0).max(3650).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
} as const satisfies ToolSpec;

export const getRepoHealth = {
  name: 'get_repo_health',
  risk: 'read',
  label: 'Building health report',
  description:
    'One-shot repository health: open/stale PRs, open issues, 12-week commit activity, top contributors and ' +
    'oldest issues. Use for "health report", "overview", "how is the repo doing". Shown as a dashboard automatically.',
  input: z.object({ repo: repoRef }),
} as const satisfies ToolSpec;

export const renderUi = {
  name: 'render_ui',
  risk: 'read',
  label: 'Composing view',
  description:
    'Show a custom layout built from catalog components, e.g. a Grid of StatCards comparing numbers you already ' +
    'have. Only use when no data tool already renders what the user asked for. The node is validated; if it is ' +
    'invalid you get the reason back and may fix it.',
  input: z.object({ node: UiNodeSchema }),
} as const satisfies ToolSpec;

/**
 * Destructive. The model only says what it wants; the server runs the dry run,
 * shows an ApprovalCard, and executes only what the user approves. There is
 * deliberately no `dryRun` input: the model cannot skip the preview.
 */
export const bulkUpdateIssues = {
  name: 'bulk_update_issues',
  risk: 'destructive',
  label: 'Updating issues',
  description:
    'Close or reopen up to 100 issues by number. Use for bulk changes such as "close all wontfix issues": first ' +
    'call list_issues to find the numbers, then call this once with all of them. The app runs a dry run and shows ' +
    'the user an approval card listing every issue; nothing changes until they approve, and they may untick items. ' +
    'Do not ask for confirmation in text. Only claim a change happened when the tool result says so.',
  input: z.object({
    repo: repoRef,
    issueNumbers: z.array(z.number().int().positive()).min(1).max(100),
    action: z.enum(['close', 'reopen']),
    reason: z
      .enum(['not_planned', 'completed'])
      .default('not_planned')
      .describe('Why the issues are closed. Ignored when reopening.'),
  }),
} as const satisfies ToolSpec;

export const toolSpecs = [listPullRequests, listIssues, getRepoHealth, renderUi, bulkUpdateIssues] as const;

export type ToolName = (typeof toolSpecs)[number]['name'];

export function getToolSpec(name: string): ToolSpec | undefined {
  return toolSpecs.find((t) => t.name === name);
}

/**
 * The guarantee behind human-in-the-loop: anything that is not a read pauses
 * for approval. Enforced in server code, never left to the prompt. Unknown
 * tools count as destructive.
 */
export function needsApproval(name: string): boolean {
  return (getToolSpec(name)?.risk ?? 'destructive') !== 'read';
}
