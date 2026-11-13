import type { AgentEvent, ApprovalRequest, PropsOf, UiSurface } from '@repopilot/shared';

export type Step = PropsOf<'StepTimeline'>['steps'][number];

/** One prompt and everything the agent streamed back for it, across the runs it took. */
export interface Turn {
  id: string;
  prompt: string;
  status: 'running' | 'awaiting-approval' | 'done' | 'error';
  steps: Step[];
  /** Validated server-side; validated again by GenUiHost before rendering. */
  surfaces: ShownSurface[];
  text: string;
  error?: string;
  /** The ApprovalCard this turn is paused on. */
  pending?: ApprovalRequest;
  /** Sending the approve / reject decision failed; the card can be used again. */
  actionError?: string;
  /** Follow-up prompts suggested from what this turn showed (chips above the prompt box). */
  followups?: string[];
}

/** A surface as shown: after apply_table_filter, `base` holds the rows the agent fetched. */
export interface ShownSurface extends UiSurface {
  base?: UiSurface['node'];
  /** What the agent filtered by, e.g. "bug · open". */
  filter?: string;
}

/** Client-side step shown while a run waits; the resumed run finishes it under the same id. */
export const approvalStepId = (toolCallId: string) => `approval-${toolCallId}`;

export function newTurn(id: string, prompt: string): Turn {
  return { id, prompt, status: 'running', steps: [], surfaces: [], text: '' };
}

/**
 * Pure reducer: folds one AG-UI-style event into a turn. Kept free of Angular
 * so it is trivial to test and to reuse for replays.
 */
export function applyEvent(turn: Turn, event: AgentEvent): Turn {
  switch (event.type) {
    case 'STEP_STARTED':
      return { ...turn, steps: [...turn.steps, { id: event.stepId, label: event.stepName, status: 'running' }] };

    case 'STEP_FINISHED': {
      const known = turn.steps.some((s) => s.id === event.stepId);
      const finished = { status: event.status, ...(event.detail ? { detail: event.detail } : {}) };
      return {
        ...turn,
        steps: known
          ? turn.steps.map((s) => (s.id === event.stepId ? { ...s, ...finished } : s))
          : // A notice without a start, e.g. "primary model overloaded, using fallback".
            [...turn.steps, { id: event.stepId, label: 'Notice', ...finished }],
      };
    }

    case 'TEXT_MESSAGE_START':
      return turn.text ? { ...turn, text: `${turn.text}\n\n` } : turn;

    case 'TEXT_MESSAGE_CONTENT':
      return { ...turn, text: turn.text + event.delta };

    case 'CUSTOM': {
      if (event.name === 'approval') {
        const step: Step = { id: approvalStepId(event.value.toolCallId), label: 'Waiting for your approval', status: 'pending' };
        return { ...turn, pending: event.value, steps: [...turn.steps, step] };
      }
      if (event.name === 'followups') return { ...turn, followups: event.value.prompts.slice(0, 3) };
      if (event.name !== 'ui') return turn;
      const exists = turn.surfaces.some((s) => s.surfaceId === event.value.surfaceId);
      return {
        ...turn,
        // Same surfaceId = update in place (follow-ups like "only show bugs").
        surfaces: exists
          ? turn.surfaces.map((s) => (s.surfaceId === event.value.surfaceId ? event.value : s))
          : [...turn.surfaces, event.value],
      };
    }

    case 'RUN_FINISHED':
      return { ...turn, status: turn.pending ? 'awaiting-approval' : 'done', steps: settle(turn.steps, 'done') };

    case 'RUN_ERROR':
      return { ...turn, status: 'error', error: event.message, steps: settle(turn.steps, 'error') };

    default:
      return turn;
  }
}

/**
 * Rebuilds a saved conversation from its stored runs (History → Resume). A run
 * with a prompt starts a turn; a run without one resumed after an approval and
 * continues the previous turn, exactly as it streamed live.
 */
export function replayRuns(runs: { id: string; prompt: string | null; events: AgentEvent[] }[]): Turn[] {
  let turns: Turn[] = [];
  for (const run of runs) {
    let at: number;
    if (run.prompt !== null || turns.length === 0) {
      turns.push(newTurn(run.id, run.prompt ?? ''));
      at = turns.length - 1;
    } else {
      // The approval was answered: it continues the turn that waited, which is not the last
      // one when side questions were asked meanwhile. The client cleared `pending` before streaming it.
      at = turns.length - 1;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].status === 'awaiting-approval') {
          at = i;
          break;
        }
      }
      turns[at] = { ...turns[at], pending: undefined, status: 'running' };
    }
    for (const event of run.events) {
      // Table filters are part of what the user saw, so they replay; navigation and highlights do not.
      const filter = tableFilterOf(event);
      turns = filter ? filterTables(turns, filter) : turns.map((t, i) => (i === at ? applyEvent(t, event) : t));
    }
  }
  return turns;
}

// ---------------------------------------------------------------------------
// apply_table_filter: the agent filters a table already on screen, in place
// ---------------------------------------------------------------------------

/** The filter input, as validated by the server (ApplyTableFilterInput). */
export interface TableFilter {
  target: 'IssueTable' | 'PrList';
  labels?: string[];
  state?: 'open' | 'closed' | 'draft' | 'merged';
  author?: string;
  clear?: boolean;
}

/** A filter event from the stream, or null. */
export function tableFilterOf(event: AgentEvent): TableFilter | null {
  if (event.type !== 'CUSTOM' || event.name !== 'client_tool' || event.value.name !== 'apply_table_filter') return null;
  const a = event.value.args as TableFilter | null;
  return a && (a.target === 'IssueTable' || a.target === 'PrList') ? a : null;
}

/** "bug · open · by octocat" */
export function describeFilter(f: TableFilter): string {
  return [...(f.labels ?? []), f.state, f.author ? `by ${f.author}` : undefined].filter(Boolean).join(' · ') || 'all rows';
}

/**
 * Filters the most recent surface that shows the target table (also nested,
 * e.g. the health report's oldest issues), keeping the unfiltered node as
 * `base` so Clear can restore it. A second filter starts from the base again.
 */
export function filterTables(turns: Turn[], f: TableFilter): Turn[] {
  for (let t = turns.length - 1; t >= 0; t--) {
    const surfaces = turns[t].surfaces;
    for (let s = surfaces.length - 1; s >= 0; s--) {
      const surface = surfaces[s];
      const base = surface.base ?? surface.node;
      if (!contains(base, f.target)) continue;
      const next: ShownSurface = f.clear || isEmptyFilter(f)
        ? { surfaceId: surface.surfaceId, node: base }
        : { surfaceId: surface.surfaceId, node: mapTables(base, f), base, filter: describeFilter(f) };
      return turns.map((turn, i) => (i === t ? { ...turn, surfaces: turn.surfaces.map((x, j) => (j === s ? next : x)) } : turn));
    }
  }
  return turns;
}

/** Clear on a filtered surface: back to the rows the agent fetched. */
export function clearFilter(turns: Turn[], surfaceId: string): Turn[] {
  return turns.map((t) => ({
    ...t,
    surfaces: t.surfaces.map((s) => (s.surfaceId === surfaceId && s.base ? { surfaceId: s.surfaceId, node: s.base } : s)),
  }));
}

function isEmptyFilter(f: TableFilter): boolean {
  return !f.labels?.length && !f.state && !f.author;
}

type AnyNode = { component?: unknown; props?: Record<string, unknown> };

function childrenOf(node: AnyNode): AnyNode[] | null {
  const c = node.props?.['children'];
  return Array.isArray(c) ? (c as AnyNode[]) : null;
}

function contains(node: unknown, target: string): boolean {
  const n = node as AnyNode;
  return n?.component === target || (childrenOf(n)?.some((c) => contains(c, target)) ?? false);
}

function mapTables(node: unknown, f: TableFilter): UiSurface['node'] {
  const n = node as AnyNode;
  if (n.component === f.target && n.props) {
    const key = f.target === 'IssueTable' ? 'rows' : 'items';
    const rows = Array.isArray(n.props[key]) ? (n.props[key] as Record<string, unknown>[]) : [];
    return { ...n, props: { ...n.props, [key]: rows.filter((r) => matches(r, f)) } } as UiSurface['node'];
  }
  const children = childrenOf(n);
  if (!children) return n as UiSurface['node'];
  return { ...n, props: { ...n.props, children: children.map((c) => mapTables(c, f)) } } as UiSurface['node'];
}

function matches(row: Record<string, unknown>, f: TableFilter): boolean {
  const labels = (Array.isArray(row['labels']) ? row['labels'] : []).map((l) => String(l).toLowerCase());
  if (f.labels?.some((l) => !labels.includes(l.toLowerCase()))) return false;
  if (f.state && row['state'] !== f.state) return false;
  if (f.author && String(row['author'] ?? '').toLowerCase() !== f.author.toLowerCase()) return false;
  return true;
}

const componentOf = (node: unknown) => (node as { component?: unknown } | null)?.component;

/** The plain diff get_pull_request shows: a Section of DiffViewers (server-only, so the model cannot build one). */
function isDiffSection(node: unknown): boolean {
  if (componentOf(node) !== 'Section') return false;
  const children = (node as { props?: { children?: unknown } }).props?.children;
  return Array.isArray(children) && children.length > 0 && children.every((c) => componentOf(c) === 'DiffViewer');
}

/**
 * The surfaces to draw for a turn. Once the review draft is on screen it carries
 * the same diffs itself, so the plain diff shown while the agent read the PR is dropped.
 */
export function visibleSurfaces(turn: Turn): ShownSurface[] {
  if (!turn.surfaces.some((s) => componentOf(s.node) === 'PrReview')) return turn.surfaces;
  return turn.surfaces.filter((s) => !isDiffSection(s.node));
}

/** True once the turn shows a PR review draft. */
export function hasReview(turn: Turn): boolean {
  return turn.surfaces.some((s) => componentOf(s.node) === 'PrReview');
}

function settle(steps: Step[], status: 'done' | 'error'): Step[] {
  return steps.map((s) => (s.status === 'running' ? { ...s, status } : s));
}
