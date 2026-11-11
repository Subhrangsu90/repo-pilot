import type { PropsOf } from '@repopilot/shared';
import type { ToolContext } from '../tools/read-tools';
import { GitHubError } from './client';

type DiffLine = PropsOf<'DiffViewer'>['lines'][number];
type PrInfo = PropsOf<'PrReview'>['pr'];

export interface PrFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** Parsed patch; empty when GitHub sends none (binary or too large). */
  lines: DiffLine[];
  hasPatch: boolean;
}

export interface PullRequest {
  info: PrInfo;
  /** Untrusted text written by the PR author. */
  body: string;
  headSha: string;
  files: PrFile[];
}

interface PrJson {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  additions: number;
  deletions: number;
  changed_files: number;
}

interface FileJson {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

const MAX_LINE = 500;
/** Files one surface shows as diffs, and rows per file (catalog limits). */
export const MAX_DIFFS = 5;
const MAX_DIFF_LINES = 400;

/** Long diffs keep only the hunks that carry a comment, so the surface stays readable and within limits. */
export function trimToComments<L extends { kind: string; new?: number }>(lines: L[], commentLines: number[]): L[] {
  if (lines.length <= MAX_DIFF_LINES) return lines;
  const hunks: L[][] = [];
  for (const line of lines) {
    if (line.kind === 'hunk' || hunks.length === 0) hunks.push([]);
    hunks.at(-1)!.push(line);
  }
  const wanted = hunks.filter((h) => h.some((l) => l.new !== undefined && commentLines.includes(l.new)));
  return (wanted.length ? wanted : hunks).flat().slice(0, MAX_DIFF_LINES);
}

/**
 * A GitHub unified patch as rows with old/new line numbers. "\ No newline at
 * end of file" markers are dropped; very long lines are cut (shown as text only).
 */
export function parsePatch(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      lines.push({ kind: 'hunk', text: raw.slice(0, MAX_LINE) });
      continue;
    }
    if (raw.startsWith('\\')) continue;
    const text = raw.slice(1, MAX_LINE + 1);
    if (raw.startsWith('+')) lines.push({ kind: 'add', new: newNo++, text });
    else if (raw.startsWith('-')) lines.push({ kind: 'del', old: oldNo++, text });
    else if (oldNo > 0 || newNo > 0) lines.push({ kind: 'ctx', old: oldNo++, new: newNo++, text });
  }
  return lines;
}

/** Line numbers a review comment may point at (added or unchanged lines on the new side). */
export function commentableLines(lines: DiffLine[]): Set<number> {
  return new Set(lines.filter((l) => l.kind !== 'del' && l.kind !== 'hunk' && l.new).map((l) => l.new!));
}

/**
 * The diff as the model reads it: each row prefixed with its new-file line
 * number, so review comments can point at real lines.
 */
export function annotate(lines: DiffLine[]): string {
  return lines
    .map((l) => {
      if (l.kind === 'hunk') return l.text;
      if (l.kind === 'del') return `-     | ${l.text}`;
      return `${l.kind === 'add' ? '+' : ' '} ${String(l.new).padStart(4)}| ${l.text}`;
    })
    .join('\n');
}

export async function fetchPullRequest(
  ctx: ToolContext,
  repo: { owner: string; name: string },
  number: number,
  opts: { files: boolean } = { files: true },
): Promise<PullRequest | null> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  let pr: PrJson;
  try {
    pr = await ctx.github.rest<PrJson>(`${base}/pulls/${number}`);
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }

  const [files, checks] = await Promise.all([
    opts.files ? ctx.github.rest<FileJson[]>(`${base}/pulls/${number}/files?per_page=100`) : Promise.resolve([]),
    fetchChecks(ctx, base, pr.head.sha),
  ]);

  return {
    info: {
      number: pr.number,
      title: pr.title.slice(0, 256),
      url: pr.html_url,
      state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open',
      author: pr.user?.login,
      branch: pr.head.ref.slice(0, 255),
      base: pr.base.ref.slice(0, 255),
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      ...(checks ? { checks } : {}),
    },
    body: (pr.body ?? '').slice(0, 2000),
    headSha: pr.head.sha,
    files: files.map((f) => ({
      path: f.filename.slice(0, 300),
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      lines: f.patch ? parsePatch(f.patch) : [],
      hasPatch: Boolean(f.patch),
    })),
  };
}

/** "4 of 4 checks passed": check runs on the head commit. Skipped and neutral count as passed. */
async function fetchChecks(ctx: ToolContext, base: string, sha: string): Promise<{ passed: number; total: number } | undefined> {
  try {
    const res = await ctx.github.rest<{ check_runs: { status: string; conclusion: string | null }[] }>(
      `${base}/commits/${sha}/check-runs?per_page=100`,
    );
    const runs = res.check_runs;
    if (!runs.length) return undefined;
    const passed = runs.filter((r) => r.status === 'completed' && ['success', 'neutral', 'skipped'].includes(r.conclusion ?? '')).length;
    return { passed, total: runs.length };
  } catch {
    // Checks are a nice-to-have in the header; a missing permission must not fail the review.
    return undefined;
  }
}
