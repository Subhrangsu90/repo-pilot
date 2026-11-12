import type { ChatMessage, ToolCall } from '../llm';

/**
 * A session's title (doc §9b step 1: "PR #42 review"), named after what the
 * agent did in the first run rather than the raw prompt. Built from the tool
 * calls in code, not by a model call; falls back to the prompt's first line.
 * Set once, when the session is first saved; renaming in History keeps the user's.
 */
export function sessionTitle(prompt: string | undefined, messages: ChatMessage[]): string {
  const calls = messages.flatMap((m) => (m.role === 'assistant' ? m.toolCalls : []));
  for (const name of PRIORITY) {
    const call = calls.find((c) => c.name === name);
    const title = call && describe(call, prompt ?? '');
    if (title) return clip(title);
  }
  return titleFrom(prompt ?? '');
}

/** The prompt's first line, capitalised, at most 78 characters. */
export function titleFrom(prompt: string): string {
  const line = prompt.trim().split('\n')[0].replace(/\s+/g, ' ');
  const text = line.length > 80 ? `${line.slice(0, 77)}…` : line;
  return text ? text[0].toUpperCase() + text.slice(1) : 'Untitled session';
}

/**
 * Changes say most about a session, then the one thing that was read for them.
 * List tools are left out: "Which of my open PRs are drafts?" says more than
 * "Open pull requests", so list questions keep the prompt as their title.
 */
const PRIORITY = [
  'submit_pull_request_review',
  'create_release',
  'bulk_update_issues',
  'get_pull_request',
  'get_release_changes',
  'get_repo_health',
];

type Args = Record<string, unknown>;

function describe(call: ToolCall, prompt: string): string | null {
  const a = (call.args && typeof call.args === 'object' ? call.args : {}) as Args;
  const num = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  switch (call.name) {
    case 'submit_pull_request_review': {
      const n = num(a['number']);
      return n ? `PR #${n} review` : null;
    }
    case 'get_pull_request': {
      const n = num(a['number']);
      return n ? (/\breview/i.test(prompt) ? `PR #${n} review` : `PR #${n}`) : null;
    }
    case 'create_release': {
      const tag = str(a['tag']);
      return tag ? `Release ${tag}` : 'Release draft';
    }
    case 'get_release_changes': {
      const since = str(a['since']);
      return since ? `Release notes since ${since}` : 'Release notes';
    }
    case 'bulk_update_issues': {
      const ids = Array.isArray(a['issueNumbers']) ? a['issueNumbers'].filter((n) => num(n) !== null) : [];
      if (!ids.length) return null;
      const verb = a['action'] === 'reopen' ? 'Reopen' : 'Close';
      const what = ids.length <= 3 ? `${ids.length === 1 ? 'issue' : 'issues'} ${ids.map((n) => `#${n}`).join(', ')}` : `${ids.length} issues`;
      return `${verb} ${what}`;
    }
    case 'get_repo_health':
      return 'Health report';
    default:
      return null;
  }
}

function clip(title: string): string {
  return title.length > 80 ? `${title.slice(0, 77)}…` : title;
}
