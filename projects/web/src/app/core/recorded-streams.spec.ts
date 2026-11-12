import { validateNode, type AgentEvent } from '@repopilot/shared';
import { replayRuns, visibleSurfaces } from './agent-run';
import healthThenOnlyBugs from './recorded/health-then-only-bugs.json';
import reviewWithSideQuestion from './recorded/review-with-side-question.json';

/**
 * Recorded AG-UI event streams (doc §11 "Fixtures to record"): real runs exported
 * from Postgres, made with local Gemma against the demo repo. Replaying them must
 * give the conversation the user saw, with every surface still valid.
 */
type Run = { id: string; prompt: string | null; events: AgentEvent[] };
const recorded = (runs: unknown) => runs as Run[];

describe('recorded streams', () => {
  it('health report, then "only show bugs": the later filter wins, and every surface validates', () => {
    const turns = replayRuns(recorded(healthThenOnlyBugs));
    expect(turns.map((t) => [t.prompt, t.status])).toEqual([
      ['Give me a health report of the repo', 'done'],
      ['Only show bugs', 'done'],
      ['Only show bugs', 'done'],
    ]);
    const report = turns[0].surfaces[0];
    for (const t of turns) for (const s of t.surfaces) expect(validateNode(s.node).ok).toBe(true);
    expect(validateNode(report.base).ok).toBe(true);

    // Gemma first filtered by state (a wrong guess), then by the bug label: a second filter starts from the fetched rows.
    expect(report.filter).toBe('bug');
    const table = (report.node.props as { children: { component: string; props: { rows: { labels: string[] }[] } }[] }).children.find(
      (c) => c.component === 'IssueTable',
    )!;
    expect(table.props.rows.length).toBeGreaterThan(0);
    expect(table.props.rows.every((r) => r.labels.includes('bug'))).toBe(true);
  });

  it('a review that waited through a side question: the resumed run lands on the review turn', () => {
    const turns = replayRuns(recorded(reviewWithSideQuestion));
    expect(turns.map((t) => [t.prompt, t.status])).toEqual([
      ['Review pull request #15', 'done'],
      ['Take me to where the rate limit key is built', 'done'],
    ]);
    const review = visibleSurfaces(turns[0]).find((s) => s.node.component === 'PrReview')!;
    expect(validateNode(review.node).ok).toBe(true);
    expect((review.node.props as { status: string }).status).toBe('rejected');
    // The side question only pointed at code: no surface of its own, and it never touched the review.
    expect(turns[1].surfaces).toEqual([]);
    expect(turns[1].text).toContain('attempts');
  });
});
