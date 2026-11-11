import type { AgentEvent } from '@repopilot/shared';
import { followupsFor, trackFollowups } from './followups';

describe('followups', () => {
  it('suggests follow-ups for the most recent surface first, at most three, no repeats', () => {
    expect(followupsFor(['Section'])).toEqual(['Only show bugs', 'Close stale wontfix issues', 'Review the stale PRs']);
    expect(followupsFor(['Section', 'IssueTable'])).toEqual([
      'Only show bugs',
      'Close all open wontfix issues',
      'Show the oldest open issues',
    ]);
    expect(followupsFor(['StepTimeline', 'Unknown'])).toEqual([]);
  });

  it('records shown components and only sends chips when finish is called', () => {
    const events: AgentEvent[] = [];
    const t = trackFollowups((e) => events.push(e));
    t.emit({ type: 'CUSTOM', name: 'ui', value: { surfaceId: 's1', node: { component: 'PrList', props: {} } } });
    expect(events).toHaveLength(1);
    t.finish();
    expect(events.at(-1)).toEqual({
      type: 'CUSTOM',
      name: 'followups',
      value: { prompts: ['Which PRs have failing CI?', 'Show only draft PRs', 'Show merged PRs'] },
    });
  });

  it('does not offer health-report follow-ups for a pull request diff', () => {
    const events: AgentEvent[] = [];
    const t = trackFollowups((e) => events.push(e));
    const diff = { component: 'DiffViewer', props: {} };
    t.emit({ type: 'CUSTOM', name: 'ui', value: { surfaceId: 's1', node: { component: 'Section', props: { title: 'Changes in #16', children: [diff] } } } });
    t.finish();
    expect(events.at(-1)).toEqual({ type: 'CUSTOM', name: 'followups', value: { prompts: ['Show my open PRs', 'Which PRs have failing CI?'] } });
  });

  it('sends nothing when the run showed no UI', () => {
    const events: AgentEvent[] = [];
    trackFollowups((e) => events.push(e)).finish();
    expect(events).toEqual([]);
  });
});
