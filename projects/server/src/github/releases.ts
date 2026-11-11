import type { ReleaseEdits } from '@repopilot/shared';
import { ToolError, type ToolContext } from '../tools/read-tools';
import { GitHubError } from './client';

export interface MergedPull {
  number: number;
  title: string;
  labels: string[];
  author?: string;
}

export interface ReleaseChanges {
  /** Tag of the release this one follows, if there is one. */
  previousTag?: string;
  /** Default branch: the new tag points at it. */
  target: string;
  pulls: MergedPull[];
  commits: number;
  contributors: number;
}

const SEARCH_QUERY = `
query ($q: String!) {
  search(query: $q, type: ISSUE, first: 100) {
    nodes { ... on PullRequest { number title author { login } labels(first: 5) { nodes { name } } } }
  }
}`;

interface CommitJson {
  author: { login: string } | null;
  commit: { author: { name: string } | null };
}

/**
 * Everything merged into the default branch since the previous release (or
 * since the start, when there is none): the pull requests, commit count and
 * number of distinct authors.
 */
export async function fetchReleaseChanges(ctx: ToolContext, repo: { owner: string; name: string }, since?: string): Promise<ReleaseChanges> {
  const base = `/repos/${repo.owner}/${repo.name}`;
  const { default_branch: target } = await ctx.github.rest<{ default_branch: string }>(base);

  let previous: { tag_name: string; published_at: string | null; created_at: string } | null = null;
  try {
    previous = await ctx.github.rest(since ? `${base}/releases/tags/${encodeURIComponent(since)}` : `${base}/releases/latest`);
  } catch (err) {
    if (!(err instanceof GitHubError && err.status === 404)) throw err;
    if (since) throw new ToolError(`There is no release tagged ${since}.`);
  }

  let commits: CommitJson[];
  let commitCount: number;
  if (previous) {
    const cmp = await ctx.github.rest<{ total_commits: number; commits: CommitJson[] }>(
      `${base}/compare/${encodeURIComponent(previous.tag_name)}...${encodeURIComponent(target)}`,
    );
    commits = cmp.commits;
    commitCount = cmp.total_commits;
  } else {
    commits = await ctx.github.rest<CommitJson[]>(`${base}/commits?sha=${encodeURIComponent(target)}&per_page=100`);
    commitCount = commits.length;
  }
  const authors = new Set(commits.map((c) => c.author?.login ?? c.commit.author?.name).filter(Boolean));

  const after = previous ? ` merged:>=${previous.published_at ?? previous.created_at}` : '';
  const found = await ctx.github.graphql<{
    search: { nodes: ({ number: number; title: string; author: { login: string } | null; labels: { nodes: { name: string }[] } } | Record<string, never>)[] };
  }>(SEARCH_QUERY, { q: `repo:${repo.owner}/${repo.name} is:pr is:merged base:${target}${after}` });

  const pulls = found.search.nodes
    .filter((n): n is Exclude<typeof n, Record<string, never>> => 'number' in n)
    .map((n) => ({ number: n.number, title: n.title.slice(0, 256), labels: n.labels.nodes.map((l) => l.name), author: n.author?.login }))
    .sort((a, b) => a.number - b.number);

  return { previousTag: previous?.tag_name, target, pulls, commits: commitCount, contributors: authors.size };
}

/** True when the tag already exists in the repository. */
export async function tagExists(ctx: ToolContext, repo: { owner: string; name: string }, tag: string): Promise<boolean> {
  try {
    await ctx.github.rest(`/repos/${repo.owner}/${repo.name}/git/ref/tags/${encodeURIComponent(tag)}`);
    return true;
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return false;
    throw err;
  }
}

const HEADINGS: [keyof ReleaseEdits['sections'], string][] = [
  ['features', 'Features'],
  ['fixes', 'Fixes'],
  ['breaking', 'Breaking changes'],
];

/** The release body: one Markdown section per non-empty group; GitHub links "#12" to the pull request. */
export function renderNotes(sections: ReleaseEdits['sections']): string {
  return HEADINGS.filter(([key]) => sections[key].length)
    .map(([key, title]) => `## ${title}\n\n${sections[key].map((e) => `- ${e.text}${e.pr ? ` (#${e.pr})` : ''}`).join('\n')}`)
    .join('\n\n');
}
