import type { AgentEvent } from '@repopilot/shared';

/**
 * Follow-up prompts offered as chips under an answer (Screen Spec: Ask
 * "Follow-up chips"). They are picked from the components the run showed, so
 * they always relate to the current result and only ask for things the agent's
 * tools can do. Keyed by the catalog name of the top-level surface.
 */
const BY_COMPONENT: Record<string, string[]> = {
  // get_repo_health renders a Section (stat cards, chart, contributors, oldest issues).
  Section: ['Only show bugs', 'Close stale wontfix issues', 'Review the stale PRs'],
  // get_pull_request renders a Section of DiffViewers (see surfaceKey).
  PullRequestDiff: ['Show my open PRs', 'Which PRs have failing CI?'],
  PrList: ['Which PRs have failing CI?', 'Show only draft PRs', 'Show merged PRs'],
  IssueTable: ['Only show bugs', 'Close all open wontfix issues', 'Show the oldest open issues'],
  ApprovalCard: ['Show the open issues', 'Give me a health report of the repo'],
  ReleaseForm: ['Show my open PRs', 'Give me a health report of the repo'],
  PrReview: ['Show my open PRs', 'Which PRs have failing CI?'],
};

const MAX = 3;

/**
 * The key a surface's follow-ups are listed under: its component name, except
 * that a Section of diffs (a pull request's changes) is not a health report.
 */
export function surfaceKey(node: { component: string; props?: unknown }): string {
  const children = (node.props as { children?: { component?: unknown }[] } | undefined)?.children;
  if (node.component === 'Section' && children?.some((c) => c.component === 'DiffViewer')) return 'PullRequestDiff';
  return node.component;
}

/** Follow-ups for the surfaces a run showed, most recent surface first, without repeats. */
export function followupsFor(components: string[]): string[] {
  const prompts: string[] = [];
  for (const name of [...components].reverse()) {
    for (const p of BY_COMPONENT[name] ?? []) if (!prompts.includes(p)) prompts.push(p);
  }
  return prompts.slice(0, MAX);
}

/**
 * Wraps a run's emit so it records which components were shown, and returns a
 * `finish` that sends the follow-up chips (call it only when the run ends
 * normally, not while it waits for an approval).
 */
export function trackFollowups(emit: (e: AgentEvent) => void) {
  const shown: string[] = [];
  return {
    emit: (e: AgentEvent) => {
      if (e.type === 'CUSTOM' && e.name === 'ui') shown.push(surfaceKey(e.value.node));
      emit(e);
    },
    finish: () => {
      const prompts = followupsFor(shown);
      if (prompts.length) emit({ type: 'CUSTOM', name: 'followups', value: { prompts } });
    },
  };
}
