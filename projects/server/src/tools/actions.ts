import * as z from 'zod';
import { bulkUpdateIssues, createRelease, PropsOf, ReleaseEdits, PrReviewEdits, submitPullRequestReview } from '@repopilot/shared';
import { GitHubError } from '../github/client';
import { commentableLines, fetchPullRequest, MAX_DIFFS, trimToComments } from '../github/pulls';
import { fetchReleaseChanges, renderNotes, tagExists } from '../github/releases';
import { findInjection } from './injection';
import { ageDays, resolveRepo, ToolContext, ToolError } from './read-tools';
import type { Inverse } from './undo';

/**
 * Write and destructive tools. Each has two halves:
 * - `plan` is the dry run: it only reads, and says exactly what would change;
 * - `execute` makes the change, and is only ever called by the agent loop
 *   after the user approved, with the ids they kept ticked.
 */
export type CardDraft = Omit<PropsOf<'ApprovalCard'>, 'toolCallId' | 'tool' | 'risk' | 'status' | 'selected' | 'result'>;

export type ReviewDraft = Omit<PropsOf<'PrReview'>, 'toolCallId' | 'tool' | 'risk' | 'status' | 'selected' | 'result' | 'reviewUrl'>;

interface CardPlan {
  kind: 'card';
  /** The only items an approval may pick. */
  ids: number[];
  detail: string;
  /** Server-only facts from the dry run that `execute` needs (e.g. the commit reviewed). Never sent to the client. */
  carry?: unknown;
  /** Approving with every item unticked is still a valid change (a review without inline comments). */
  allowEmpty?: boolean;
}

export type Plan =
  /** Nothing would change: no card, the data goes straight back to the model. */
  | { kind: 'empty'; data: Record<string, unknown>; detail: string }
  /** Show this surface and wait for the user. */
  | (CardPlan & { component?: 'ApprovalCard'; card: CardDraft })
  | (CardPlan & { component: 'PrReview'; card: ReviewDraft })
  | (CardPlan & { component: 'ReleaseForm'; card: ReleaseDraft });

export type ReleaseDraft = Omit<PropsOf<'ReleaseForm'>, 'toolCallId' | 'tool' | 'risk' | 'status' | 'selected' | 'result' | 'releaseUrl'>;

export interface Outcome {
  /** False when any part of the change failed. */
  ok: boolean;
  /** What the model sees. */
  data: Record<string, unknown>;
  /** One line for the card. */
  result: string;
  /** Short line for the step timeline. */
  detail: string;
  /** Extra fields for the surface once done (e.g. a link to what was created). */
  patch?: Record<string, unknown>;
}

export interface ExecuteOptions {
  /** The user's edits, already checked against the tool's `edits` schema. */
  edits?: unknown;
  carry?: unknown;
}

export interface ActionTool<S extends { input: z.ZodType }> {
  plan(input: z.output<S['input']>, ctx: ToolContext): Promise<Plan>;
  /** What the user may change in the surface before approving. Without it, edits are ignored. */
  edits?: z.ZodType;
  /** The surface fields that show the user's edits while (and after) the change runs. */
  editedCard?(card: Record<string, unknown>, edits: unknown): Record<string, unknown>;
  execute(input: z.output<S['input']>, ids: number[], ctx: ToolContext, opts: ExecuteOptions): Promise<Outcome>;
  /** One line for the audit log: "Close 5 issues", "Release v1.1.0". */
  summary(input: z.output<S['input']>, ids: number[], opts: ExecuteOptions): string;
  /** How to reverse an executed change, or null when it cannot be undone from here. */
  inverse?(input: z.output<S['input']>, ids: number[], out: Outcome, opts: ExecuteOptions): Inverse | null;
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

  summary(input, ids) {
    return `${input.action === 'close' ? 'Close' : 'Reopen'} ${ids.length} ${ids.length === 1 ? 'issue' : 'issues'}`;
  },

  inverse(input, _ids, out) {
    const changed = (out.data['changed'] as number[] | undefined) ?? [];
    if (!changed.length) return null;
    const action = input.action === 'close' ? 'reopen' : 'close';
    return {
      kind: 'issues',
      label: `${action === 'reopen' ? 'Reopen' : 'Close'} ${changed.map((n) => `#${n}`).join(', ')}`.slice(0, 200),
      input: { ...(input.repo ? { repo: input.repo } : {}), issueNumbers: changed, action, reason: input.reason },
    };
  },
};

// ---------------------------------------------------------------------------
// submit_pull_request_review
// ---------------------------------------------------------------------------

type ReviewComment = ReviewDraft['comments'][number];
type ReviewEvent = ReviewDraft['event'];

interface ReviewCarry {
  /** The commit the comments' line numbers belong to. */
  headSha: string;
  comments: ReviewComment[];
  allowedEvents: ReviewEvent[];
  event: ReviewEvent;
}

const ALL_EVENTS: ReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];
const EVENT_TEXT: Record<ReviewEvent, string> = {
  COMMENT: 'a comment review',
  APPROVE: 'an approving review',
  REQUEST_CHANGES: 'a review requesting changes',
};
const GITHUB_URL = /^https:\/\/github\.com\//;

export const submitPullRequestReviewTool: ActionTool<typeof submitPullRequestReview> = {
  edits: PrReviewEdits,

  async plan(input, ctx) {
    const repo = resolveRepo(input.repo, ctx);
    const pr = await fetchPullRequest(ctx, repo, input.number);
    if (!pr) throw new ToolError(`Pull request #${input.number} was not found in ${repo.full}.`);

    // Every comment must sit on a line of the diff, or GitHub rejects the whole review.
    const byPath = new Map(pr.files.map((f) => [f.path, f]));
    const shownPaths: string[] = [];
    const comments: ReviewComment[] = [];
    const skipped: ReviewDraft['skipped'] = [];
    input.comments.forEach((c, i) => {
      const id = i + 1;
      const file = byPath.get(c.path);
      const skip = (reason: string) => skipped.push({ id, reason: reason.slice(0, 120) });
      if (!file) return skip(`${c.path} is not changed in this pull request`);
      if (!file.hasPatch) return skip(`${c.path} has no diff to comment on`);
      if (!commentableLines(file.lines).has(c.line)) return skip(`line ${c.line} of ${c.path} is not in the diff`);
      if (!shownPaths.includes(c.path)) {
        if (shownPaths.length === MAX_DIFFS) return skip(`only ${MAX_DIFFS} files can be reviewed at once`);
        shownPaths.push(c.path);
      }
      comments.push({ id, path: c.path, line: c.line, severity: c.severity, body: c.body });
    });

    // GitHub refuses Approve and Request changes on your own pull request.
    const own = pr.info.author !== undefined && pr.info.author.toLowerCase() === (await ctx.github.login()).toLowerCase();
    const allowedEvents: ReviewEvent[] = own ? ['COMMENT'] : ALL_EVENTS;
    const event = allowedEvents.includes(input.event) ? input.event : 'COMMENT';

    // Files with comments first, then the rest of the change, so the user always sees the code being reviewed.
    for (const f of pr.files) {
      if (shownPaths.length === MAX_DIFFS) break;
      if (f.hasPatch && !shownPaths.includes(f.path)) shownPaths.push(f.path);
    }

    const diffs = shownPaths.map((path) => {
      const f = byPath.get(path)!;
      const lines = trimToComments(f.lines, comments.filter((c) => c.path === path).map((c) => c.line));
      return { path, additions: f.additions, deletions: f.deletions, lines, comments: [] };
    });

    const carry: ReviewCarry = { headSha: pr.headSha, comments, allowedEvents, event };
    // Checked in code: the warning shows even when the model did not notice the injection.
    const injection = findInjection(pr.body);
    return {
      kind: 'card',
      component: 'PrReview',
      ids: comments.map((c) => c.id),
      allowEmpty: true,
      carry,
      detail: `${comments.length} ${comments.length === 1 ? 'comment' : 'comments'} drafted`,
      card: {
        pr: pr.info,
        files: pr.files.slice(0, 100).map(({ path, additions, deletions }) => ({ path, additions, deletions })),
        diffs,
        comments,
        skipped,
        summary: input.summary,
        event,
        allowedEvents,
        ...(own ? { eventNote: 'You opened this pull request, and GitHub only allows a comment review on your own pull requests.' } : {}),
        ...(injection ? { injectionWarning: injection } : {}),
      },
    };
  },

  editedCard(card, edits) {
    const e = edits as PrReviewEdits;
    const bodies = new Map(e.comments.map((c) => [c.id, c.body]));
    const comments = (card['comments'] as ReviewComment[]).map((c) => ({ ...c, body: bodies.get(c.id) ?? c.body }));
    return { summary: e.summary, event: e.event, comments };
  },

  async execute(input, ids, ctx, { edits, carry }) {
    const repo = resolveRepo(input.repo, ctx);
    const c = carry as ReviewCarry;
    const e = edits as PrReviewEdits | undefined;
    const bodies = new Map(e?.comments.map((x) => [x.id, x.body]) ?? []);
    const kept = c.comments.filter((x) => ids.includes(x.id)).map((x) => ({ ...x, body: bodies.get(x.id) ?? x.body }));
    const event = e && c.allowedEvents.includes(e.event) ? e.event : c.event;
    const summary = e?.summary ?? input.summary;

    const review = await ctx.github.rest<{ id: number; html_url: string }>(`/repos/${repo.owner}/${repo.name}/pulls/${input.number}/reviews`, {
      method: 'POST',
      body: {
        commit_id: c.headSha,
        event,
        body: summary,
        comments: kept.map((k) => ({
          path: k.path,
          line: k.line,
          side: 'RIGHT',
          body: `${k.severity === 'issue' ? '**Issue:**' : '**Suggestion:**'} ${k.body}`,
        })),
      },
    });

    const n = kept.length;
    const count = `${n} ${n === 1 ? 'comment' : 'comments'}`;
    return {
      ok: true,
      data: { posted: true, pullRequest: input.number, event, comments: n },
      result: `Posted ${EVENT_TEXT[event]} with ${count} on #${input.number}.`,
      detail: `posted, ${count}`,
      patch: GITHUB_URL.test(review.html_url) ? { reviewUrl: review.html_url } : {},
    };
  },

  summary(input) {
    return `Review on PR #${input.number}`;
  },

  // A posted review cannot be deleted through the API (only dismissed, by admins, and not comment reviews).
  inverse: () => null,
};

// ---------------------------------------------------------------------------
// create_release
// ---------------------------------------------------------------------------

interface ReleaseCarry {
  target: string;
  /** PR numbers merged since the previous release: the only ones an entry may link. */
  pullNumbers: number[];
}

type Sections = ReleaseEdits['sections'];

/** Drops PR links that are not part of this release; returns what was dropped, for the notes. */
function checkLinks(sections: Sections, allowed: number[]): { sections: Sections; dropped: number[] } {
  const dropped: number[] = [];
  const fix = (entries: Sections['features']) =>
    entries.map((e) => {
      if (e.pr === undefined || allowed.includes(e.pr)) return e;
      dropped.push(e.pr);
      return { text: e.text };
    });
  return { sections: { features: fix(sections.features), fixes: fix(sections.fixes), breaking: fix(sections.breaking) }, dropped };
}

export const createReleaseTool: ActionTool<typeof createRelease> = {
  edits: ReleaseEdits,

  async plan(input, ctx) {
    const repo = resolveRepo(input.repo, ctx);
    if (await tagExists(ctx, repo, input.tag)) throw new ToolError(`Tag ${input.tag} already exists in ${repo.full}. Use a new version.`);
    const changes = await fetchReleaseChanges(ctx, repo);
    const allowed = changes.pulls.map((p) => p.number);
    const since = changes.previousTag ? `since ${changes.previousTag}` : 'in this release';
    const { sections, dropped } = checkLinks({ features: input.features, fixes: input.fixes, breaking: input.breaking }, allowed);

    const carry: ReleaseCarry = { target: changes.target, pullNumbers: allowed };
    return {
      kind: 'card',
      component: 'ReleaseForm',
      ids: [],
      allowEmpty: true,
      carry,
      detail: `${input.tag} drafted`,
      card: {
        repo: repo.full,
        target: changes.target,
        ...(changes.previousTag ? { previousTag: changes.previousTag } : {}),
        stats: { commits: changes.commits, pullRequests: changes.pulls.length, contributors: changes.contributors },
        pulls: changes.pulls.slice(0, 100).map(({ number, title }) => ({ number, title })),
        tag: input.tag,
        name: input.name,
        prerelease: input.prerelease,
        sections,
        notes: dropped.map((n) => `Removed the link to #${n}: it was not merged ${since}.`),
      },
    };
  },

  editedCard(_card, edits) {
    const e = edits as ReleaseEdits;
    return { tag: e.tag, name: e.name, prerelease: e.prerelease, sections: e.sections };
  },

  async execute(input, _ids, ctx, { edits, carry }) {
    const repo = resolveRepo(input.repo, ctx);
    const c = carry as ReleaseCarry;
    const e = (edits as ReleaseEdits | undefined) ?? {
      tag: input.tag,
      name: input.name,
      prerelease: input.prerelease,
      sections: { features: input.features, fixes: input.fixes, breaking: input.breaking },
    };
    // The user may have changed the tag: check it again right before creating it.
    if (await tagExists(ctx, repo, e.tag)) throw new ToolError(`Tag ${e.tag} already exists. Nothing was published.`);
    const { sections } = checkLinks(e.sections, c.pullNumbers);

    const release = await ctx.github.rest<{ id: number; html_url: string }>(`/repos/${repo.owner}/${repo.name}/releases`, {
      method: 'POST',
      body: {
        tag_name: e.tag,
        target_commitish: c.target,
        name: e.name,
        body: renderNotes(sections),
        prerelease: e.prerelease,
        draft: false,
        make_latest: e.prerelease ? 'false' : 'true',
      },
    });

    return {
      ok: true,
      data: { published: true, releaseId: release.id, tag: e.tag, name: e.name, prerelease: e.prerelease },
      result: `Published ${e.tag} — ${e.name}.`,
      detail: `published ${e.tag}`,
      patch: GITHUB_URL.test(release.html_url) ? { releaseUrl: release.html_url } : {},
    };
  },

  summary(input, _ids, { edits }) {
    return `Release ${(edits as ReleaseEdits | undefined)?.tag ?? input.tag}`;
  },

  inverse(input, _ids, out) {
    const releaseId = out.data['releaseId'];
    const tag = out.data['tag'];
    if (typeof releaseId !== 'number' || typeof tag !== 'string') return null;
    return { kind: 'release', label: `Delete release ${tag} and its tag`, repo: input.repo ?? '', releaseId, tag };
  },
};

export { trimToComments } from '../github/pulls';

// ---------------------------------------------------------------------------

export const actions: Record<string, ActionTool<{ input: z.ZodType }>> = {
  [bulkUpdateIssues.name]: bulkUpdateIssuesTool as ActionTool<{ input: z.ZodType }>,
  [submitPullRequestReview.name]: submitPullRequestReviewTool as unknown as ActionTool<{ input: z.ZodType }>,
  [createRelease.name]: createReleaseTool as unknown as ActionTool<{ input: z.ZodType }>,
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
