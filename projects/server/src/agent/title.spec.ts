import type { ChatMessage } from '../llm';
import { sessionTitle } from './title';

const calls = (...list: [string, unknown][]): ChatMessage[] => [
  { role: 'user', text: 'prompt' },
  { role: 'assistant', text: '', toolCalls: list.map(([name, args], i) => ({ id: `c${i}`, name, args })) },
];

describe('sessionTitle', () => {
  it('names the session after what the agent did', () => {
    expect(sessionTitle('Review pull request #16', calls(['get_pull_request', { number: 16 }], ['submit_pull_request_review', { number: 16 }]))).toBe(
      'PR #16 review',
    );
    expect(sessionTitle('What does PR #16 change?', calls(['get_pull_request', { number: 16 }]))).toBe('PR #16');
    expect(sessionTitle('Draft release v1.1.0', calls(['get_release_changes', {}], ['create_release', { tag: 'v1.1.0', name: 'Tags' }]))).toBe(
      'Release v1.1.0',
    );
    expect(sessionTitle('Close all open wontfix issues', calls(['list_issues', { labels: ['wontfix'] }], ['bulk_update_issues', { issueNumbers: [9, 10], action: 'close' }]))).toBe(
      'Close issues #9, #10',
    );
    expect(sessionTitle('reopen them', calls(['bulk_update_issues', { issueNumbers: [1, 2, 3, 4], action: 'reopen' }]))).toBe('Reopen 4 issues');
    expect(sessionTitle('Give me a health report of the repo', calls(['get_repo_health', {}]))).toBe('Health report');
  });

  it('keeps the prompt for list questions, which says more than the list', () => {
    expect(sessionTitle('Which of my open PRs are drafts?', calls(['list_pull_requests', { state: 'open', author: '@me' }]))).toBe(
      'Which of my open PRs are drafts?',
    );
    expect(sessionTitle('any wontfix bugs?', calls(['list_issues', { labels: ['bug', 'wontfix'] }]))).toBe('Any wontfix bugs?');
  });

  it('falls back to the first line of the prompt when no tool says more', () => {
    expect(sessionTitle('  hello there\nsecond line', [{ role: 'user', text: 'hello there' }])).toBe('Hello there');
    expect(sessionTitle('show a chart', calls(['render_ui', { node: {} }]))).toBe('Show a chart');
    expect(sessionTitle('review #x', calls(['get_pull_request', { number: 'x' }]))).toBe('Review #x');
    expect(sessionTitle(undefined, [])).toBe('Untitled session');
  });
});
