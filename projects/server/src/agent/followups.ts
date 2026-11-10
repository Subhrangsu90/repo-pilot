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
  PrList: ['Which PRs have failing CI?', 'Show only draft PRs', 'Show merged PRs'],
  IssueTable: ['Only show bugs', 'Close all open wontfix issues', 'Show the oldest open issues'],
  ApprovalCard: ['Show the open issues', 'Give me a health report of the repo'],
};

const MAX = 3;

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
      if (e.type === 'CUSTOM' && e.name === 'ui') shown.push(e.value.node.component);
      emit(e);
    },
    finish: () => {
      const prompts = followupsFor(shown);
      if (prompts.length) emit({ type: 'CUSTOM', name: 'followups', value: { prompts } });
    },
  };
}
