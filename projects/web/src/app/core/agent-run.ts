import {
  A2UI_ACTIVITY_TYPE,
  A2UI_OPERATIONS_KEY,
  APPROVAL_INTERRUPT,
  approvalStepId,
  EventType,
  META_KEY,
  propUpdate,
  readSurface,
  ROOT_ID,
  rootComponent,
  stepMeta,
  type A2uiMessage,
  type AgUiEvent,
  type ApprovalInterruptMeta,
  type PropsOf,
} from '@repopilot/shared';

export type Step = PropsOf<'StepTimeline'>['steps'][number];

/** The change a turn waits on: an AG-UI interrupt of the run that paused. */
export interface PendingInterrupt {
  interruptId: string;
  toolCallId: string;
  /** The approval surface. */
  surfaceId: string;
  message?: string;
}

/** One prompt and everything the agent streamed back for it, across the runs it took. */
export interface Turn {
  id: string;
  prompt: string;
  status: 'running' | 'awaiting-approval' | 'done' | 'error';
  steps: Step[];
  /** A2UI surfaces, validated server-side; A2UI and the shared schemas check them again before rendering. */
  surfaces: ShownSurface[];
  text: string;
  /** The model's thought summary (AG-UI reasoning), shown as text. */
  reasoning?: string;
  error?: string;
  /** The interrupt this turn is paused on. */
  pending?: PendingInterrupt;
  /** Sending the approve / reject decision failed; the card can be used again. */
  actionError?: string;
  /** Follow-up prompts suggested from what this turn showed (AG-UI shared state). */
  followups?: string[];
  /** The user pressed Stop (the run ended as cancelled). */
  stopped?: boolean;
  /** Tokens the turn's runs used (AG-UI RUN_FINISHED.usage). */
  tokens?: number;
}

/** A surface as shown: its A2UI operations. After apply_table_filter, `base` holds them as the agent sent them. */
export interface ShownSurface {
  surfaceId: string;
  operations: A2uiMessage[];
  base?: A2uiMessage[];
  /** What the agent filtered by, e.g. "bug · open". */
  filter?: string;
}

export function newTurn(id: string, prompt: string): Turn {
  return { id, prompt, status: 'running', steps: [], surfaces: [], text: '' };
}

const operationsOf = (content: unknown): A2uiMessage[] | null => {
  const ops = (content as Record<string, unknown> | null)?.[A2UI_OPERATIONS_KEY];
  return Array.isArray(ops) ? (ops as A2uiMessage[]) : null;
};

/** The surface id of an A2UI activity message id (`a2ui-surface-<surfaceId>`). */
const surfaceOfActivity = (messageId: string) => (messageId.startsWith('a2ui-surface-') ? messageId.slice('a2ui-surface-'.length) : messageId);

/**
 * Pure reducer: folds one AG-UI event into a turn. Kept free of Angular so it
 * is trivial to test and to reuse for replays.
 */
export function applyEvent(turn: Turn, event: AgUiEvent): Turn {
  switch (event.type) {
    case EventType.STEP_STARTED: {
      const label = stepMeta(event).label ?? event.stepName;
      // The approval step the client added while the run waited: the resumed run carries it on.
      if (turn.steps.some((s) => s.id === event.stepName)) {
        return { ...turn, steps: turn.steps.map((s) => (s.id === event.stepName ? { ...s, label, status: 'running' } : s)) };
      }
      return { ...turn, steps: [...turn.steps, { id: event.stepName, label, status: 'running' }] };
    }

    case EventType.STEP_FINISHED: {
      const meta = stepMeta(event);
      const finished = { status: meta.status ?? 'done', ...(meta.detail ? { detail: meta.detail } : {}) };
      return { ...turn, steps: turn.steps.map((s) => (s.id === event.stepName ? { ...s, ...finished } : s)) };
    }

    case EventType.TEXT_MESSAGE_START:
      return turn.text ? { ...turn, text: `${turn.text}\n\n` } : turn;

    case EventType.TEXT_MESSAGE_CONTENT:
      return { ...turn, text: turn.text + event.delta };

    case EventType.REASONING_MESSAGE_CONTENT:
      return { ...turn, reasoning: turn.reasoning ? `${turn.reasoning}\n\n${event.delta}` : event.delta };

    case EventType.ACTIVITY_SNAPSHOT: {
      if (event.activityType !== A2UI_ACTIVITY_TYPE) return turn;
      const ops = operationsOf(event.content);
      if (!ops) return turn;
      const surfaceId = readSurface(ops).surfaceId || surfaceOfActivity(event.messageId);
      const next: ShownSurface = { surfaceId, operations: ops };
      const exists = turn.surfaces.some((s) => s.surfaceId === surfaceId);
      return {
        ...turn,
        // replace (the AG-UI default) = the surface again from scratch, in place.
        surfaces: exists ? turn.surfaces.map((s) => (s.surfaceId === surfaceId ? next : s)) : [...turn.surfaces, next],
      };
    }

    case EventType.ACTIVITY_DELTA: {
      if (event.activityType !== A2UI_ACTIVITY_TYPE) return turn;
      const surfaceId = surfaceOfActivity(event.messageId);
      // RepoPilot's deltas append A2UI operations: [{ op: 'add', path: '/a2ui_operations/-', value }].
      const added = event.patch.filter((p) => p.op === 'add' && p.path === `/${A2UI_OPERATIONS_KEY}/-`).map((p) => (p as { value: A2uiMessage }).value);
      if (!added.length) return turn;
      return {
        ...turn,
        surfaces: turn.surfaces.map((s) =>
          s.surfaceId === surfaceId ? { ...s, operations: [...s.operations, ...added], ...(s.base ? { base: [...s.base, ...added] } : {}) } : s,
        ),
      };
    }

    case EventType.STATE_SNAPSHOT: {
      const followups = (event.snapshot as { followups?: unknown } | null)?.followups;
      return Array.isArray(followups) && followups.length ? { ...turn, followups: followups.slice(0, 3).map(String) } : turn;
    }

    case EventType.STATE_DELTA: {
      const change = event.delta.find((d) => d.path === '/followups' && (d.op === 'replace' || d.op === 'add')) as { value?: unknown } | undefined;
      return Array.isArray(change?.value) ? { ...turn, followups: change.value.slice(0, 3).map(String) } : turn;
    }

    case EventType.RUN_FINISHED: {
      const tokens = (event.usage ?? []).reduce((n, u) => n + (u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)), 0);
      const withUsage = tokens ? { tokens: (turn.tokens ?? 0) + tokens } : {};
      const outcome = event.outcome;
      if (outcome?.type === 'interrupt') {
        const i = outcome.interrupts.find((x) => x.reason === APPROVAL_INTERRUPT) ?? outcome.interrupts[0];
        const meta = (i.metadata?.[META_KEY] ?? {}) as Partial<ApprovalInterruptMeta>;
        const pending: PendingInterrupt = {
          interruptId: i.id,
          toolCallId: i.toolCallId ?? i.id,
          surfaceId: meta.surfaceId ?? '',
          ...(i.message ? { message: i.message } : {}),
        };
        const step: Step = { id: approvalStepId(i.id), label: 'Waiting for your approval', status: 'pending' };
        return { ...turn, ...withUsage, pending, status: 'awaiting-approval', steps: [...settle(turn.steps, 'done'), step] };
      }
      if (outcome?.type === 'cancelled') return { ...turn, ...withUsage, status: 'done', stopped: true, steps: settle(turn.steps, 'error') };
      return { ...turn, ...withUsage, status: turn.pending ? 'awaiting-approval' : 'done', steps: settle(turn.steps, 'done') };
    }

    case EventType.RUN_ERROR:
      return { ...turn, status: 'error', error: event.message, steps: settle(turn.steps, 'error') };

    default:
      return turn;
  }
}

/** A client tool call completed on the stream (name + parsed arguments), built from TOOL_CALL_* events. */
export interface ClientToolCall {
  callId: string;
  name: string;
  args: unknown;
}

/** Collects TOOL_CALL_START / ARGS / END into whole calls, as replays need them. */
export function toolCallCollector() {
  const open = new Map<string, { name: string; args: string }>();
  return (event: AgUiEvent): ClientToolCall | null => {
    if (event.type === EventType.TOOL_CALL_START) open.set(event.toolCallId, { name: event.toolCallName, args: '' });
    else if (event.type === EventType.TOOL_CALL_ARGS) {
      const call = open.get(event.toolCallId);
      if (call) call.args += event.delta;
    } else if (event.type === EventType.TOOL_CALL_END) {
      const call = open.get(event.toolCallId);
      open.delete(event.toolCallId);
      if (!call) return null;
      try {
        return { callId: event.toolCallId, name: call.name, args: JSON.parse(call.args || '{}') };
      } catch {
        return null;
      }
    }
    return null;
  };
}

/**
 * Rebuilds a saved conversation from its stored runs (History → Resume). A run
 * with a prompt starts a turn; a run without one resumed after an approval and
 * continues the turn that waited, exactly as it streamed live.
 */
export function replayRuns(runs: { id: string; prompt: string | null; events: AgUiEvent[] }[]): Turn[] {
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
    const collect = toolCallCollector();
    for (const event of run.events) {
      // Table filters are part of what the user saw, so they replay; navigation and highlights do not.
      const call = collect(event);
      const filter = call ? tableFilterOf(call) : null;
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

/** A filter from a client tool call, or null. */
export function tableFilterOf(call: ClientToolCall): TableFilter | null {
  if (call.name !== 'apply_table_filter') return null;
  const a = call.args as TableFilter | null;
  return a && (a.target === 'IssueTable' || a.target === 'PrList') ? a : null;
}

/** "bug · open · by octocat" */
export function describeFilter(f: TableFilter): string {
  return [...(f.labels ?? []), f.state, f.author ? `by ${f.author}` : undefined].filter(Boolean).join(' · ') || 'all rows';
}

const rowsKey = (target: TableFilter['target']) => (target === 'IssueTable' ? 'rows' : 'items');

/**
 * Filters the most recent surface that shows the target table (also nested,
 * e.g. the health report's oldest issues). The filter is an A2UI data model
 * update of the table's rows on top of the operations the agent sent, which are
 * kept as `base` so Clear can restore them. A second filter starts from the base.
 */
export function filterTables(turns: Turn[], f: TableFilter): Turn[] {
  for (let t = turns.length - 1; t >= 0; t--) {
    const surfaces = turns[t].surfaces;
    for (let s = surfaces.length - 1; s >= 0; s--) {
      const surface = surfaces[s];
      const base = surface.base ?? surface.operations;
      const view = readSurface(base);
      const tables = view.components.filter((c) => c.component === f.target);
      if (!tables.length) continue;
      let next: ShownSurface;
      if (f.clear || isEmptyFilter(f)) {
        next = { surfaceId: surface.surfaceId, operations: base };
      } else {
        const key = rowsKey(f.target);
        const updates = tables.map((c) => {
          const rows = (view.data[c.id] as Record<string, unknown> | undefined)?.[key];
          const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
          return propUpdate(view.surfaceId, c.id, key, list.filter((r) => matches(r, f)));
        });
        next = { surfaceId: surface.surfaceId, operations: [...base, ...updates], base, filter: describeFilter(f) };
      }
      return turns.map((turn, i) => (i === t ? { ...turn, surfaces: turn.surfaces.map((x, j) => (j === s ? next : x)) } : turn));
    }
  }
  return turns;
}

/** Clear on a filtered surface: back to the rows the agent fetched. */
export function clearFilter(turns: Turn[], surfaceId: string): Turn[] {
  return turns.map((t) => ({
    ...t,
    surfaces: t.surfaces.map((s) => (s.surfaceId === surfaceId && s.base ? { surfaceId: s.surfaceId, operations: s.base } : s)),
  }));
}

function isEmptyFilter(f: TableFilter): boolean {
  return !f.labels?.length && !f.state && !f.author;
}

function matches(row: Record<string, unknown>, f: TableFilter): boolean {
  const labels = (Array.isArray(row['labels']) ? row['labels'] : []).map((l) => String(l).toLowerCase());
  if (f.labels?.some((l) => !labels.includes(l.toLowerCase()))) return false;
  if (f.state && row['state'] !== f.state) return false;
  if (f.author && String(row['author'] ?? '').toLowerCase() !== f.author.toLowerCase()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Reading surfaces
// ---------------------------------------------------------------------------

/** The top component of a surface, e.g. "ApprovalCard" (for badges and layout choices). */
export function surfaceComponent(surface: Pick<ShownSurface, 'operations'>): string {
  return rootComponent(readSurface(surface.operations)) ?? 'UI';
}

/** The approval surfaces the server builds (never the model). */
export function isGateSurface(surface: Pick<ShownSurface, 'operations'>): boolean {
  const name = surfaceComponent(surface);
  return name === 'ApprovalCard' || name === 'PrReview' || name === 'ReleaseForm';
}

/** The plain diff get_pull_request shows: a Section of DiffViewers (server-only, so the model cannot build one). */
function isDiffSection(surface: ShownSurface): boolean {
  const view = readSurface(surface.operations);
  const root = view.components.find((c) => c.id === ROOT_ID);
  const children = Array.isArray(root?.['children']) ? (root['children'] as string[]) : [];
  return root?.component === 'Section' && children.length > 0 && children.every((id) => view.components.find((c) => c.id === id)?.component === 'DiffViewer');
}

/**
 * The surfaces to draw for a turn. Once the review draft is on screen it carries
 * the same diffs itself, so the plain diff shown while the agent read the PR is dropped.
 */
export function visibleSurfaces(turn: Turn): ShownSurface[] {
  if (!hasReview(turn)) return turn.surfaces;
  return turn.surfaces.filter((s) => !isDiffSection(s));
}

/** True once the turn shows a PR review draft. */
export function hasReview(turn: Turn): boolean {
  return turn.surfaces.some((s) => surfaceComponent(s) === 'PrReview');
}


function settle(steps: Step[], status: 'done' | 'error'): Step[] {
  return steps.map((s) => (s.status === 'running' ? { ...s, status } : s));
}
