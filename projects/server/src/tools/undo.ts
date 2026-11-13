import { GitHubError } from '../github/client';
import { bulkUpdateIssuesTool } from './actions';
import { resolveRepo, type ToolContext } from './read-tools';

/**
 * How to reverse an executed change, stored with its audit entry (doc: the
 * `inverse` field). Undo runs it directly after the user confirms in the
 * Audit log; it never goes through the model.
 */
export type Inverse =
  | {
      kind: 'issues';
      label: string;
      input: { repo?: string; issueNumbers: number[]; action: 'close' | 'reopen'; reason: 'not_planned' | 'completed' };
    }
  | { kind: 'release'; label: string; repo: string; releaseId: number; tag: string };

export interface UndoOutcome {
  ok: boolean;
  result: string;
}

/** Records the repository in the inverse, so Undo acts there whatever repo is selected later. */
export function pinRepo(inverse: Inverse, repo: string): Inverse {
  return inverse.kind === 'issues' ? { ...inverse, input: { ...inverse.input, repo } } : { ...inverse, repo };
}

/** The repository an inverse acts on, when it was recorded (entries from before week 4 may lack it). */
export function inverseRepo(inverse: Inverse): string | undefined {
  return (inverse.kind === 'issues' ? inverse.input.repo : inverse.repo) || undefined;
}

export async function runInverse(inverse: Inverse, ctx: ToolContext): Promise<UndoOutcome> {
  switch (inverse.kind) {
    case 'issues': {
      const out = await bulkUpdateIssuesTool.execute(inverse.input, inverse.input.issueNumbers, ctx, {});
      return { ok: out.ok, result: out.result };
    }
    case 'release': {
      const repo = resolveRepo(inverse.repo || undefined, ctx);
      const base = `/repos/${repo.owner}/${repo.name}`;
      await ignoreMissing(() => ctx.github.rest(`${base}/releases/${inverse.releaseId}`, { method: 'DELETE' }));
      await ignoreMissing(() => ctx.github.rest(`${base}/git/refs/tags/${encodeURIComponent(inverse.tag)}`, { method: 'DELETE' }));
      return { ok: true, result: `Deleted release ${inverse.tag} and its tag.` };
    }
  }
}

/** Already gone counts as undone. */
async function ignoreMissing(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof GitHubError && err.status === 404)) throw err;
  }
}
