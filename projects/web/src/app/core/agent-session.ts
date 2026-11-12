import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ReleaseEdits, type AgentEvent, type ApprovalAction, type StartRunRequest, type StartRunResponse, type UiEvent, type UiSurface, type ClientToolCall } from '@repopilot/shared';
import { firstValueFrom } from 'rxjs';
import type { SavedSession } from './api';
import { applyEvent, clearFilter, filterTables, newTurn, replayRuns, tableFilterOf, Turn } from './agent-run';
import { ClientTools } from './client-tools';
import { ModelChoice } from './model-choice';

/** How current a reopened surface is. */
export interface Freshness {
  /** When the data was captured, or refreshed. */
  at: string;
  refreshed: boolean;
  busy: boolean;
  error?: string;
}

/**
 * The conversation as signals. Each prompt starts a run on the agent server
 * (POST /api/runs) and its events arrive over Server-Sent Events. A run that
 * pauses on an ApprovalCard is answered with POST /api/runs/:id/actions, and
 * the resumed run streams into the same turn. Components only read signals;
 * nothing subscribes manually.
 */
@Injectable({ providedIn: 'root' })
export class AgentSession {
  private readonly http = inject(HttpClient);
  private readonly model = inject(ModelChoice);
  private readonly router = inject(Router);
  private readonly clientTools = inject(ClientTools);
  private threadId: string | undefined;
  private source: EventSource | undefined;
  /** A prompt to send as soon as the current run finishes. */
  private queued: string | undefined;

  readonly turns = signal<Turn[]>([]);
  /** A run is streaming (the last turn, or the turn whose approval was just answered). */
  readonly isBusy = computed(() => this.turns().some((t) => t.status === 'running'));
  /**
   * A change waits for approval. New prompts are still allowed: the server runs them as
   * read-only side questions (read and screen tools only) until the card is answered.
   */
  readonly awaitingApproval = computed(() => this.turns().some((t) => t.status === 'awaiting-approval'));
  /** Text in the prompt box; kept here so "Edit request" can refill it. */
  readonly draft = signal('');
  /** Bumped when the prompt box should take focus. */
  readonly composerFocus = signal(0);
  /** Set when the conversation was reopened from History: its data is as it was then. */
  readonly reopened = signal<{ id: string; title: string; capturedAt: string } | null>(null);
  readonly loadError = signal<string | null>(null);
  /**
   * Surfaces of a reopened session that Refresh can re-run (read tools only), by
   * surface id: when the data was captured or last refreshed, and the refresh state.
   */
  readonly freshness = signal<ReadonlyMap<string, Freshness>>(new Map());

  /** The saved session this conversation belongs to (its thread id), once the server has one. */
  get sessionId(): string | undefined {
    return this.threadId;
  }

  /**
   * Reopens a saved session: replays its stored runs, no model call. New prompts
   * continue it, and a change that was waiting can still be approved.
   */
  async load(sessionId: string): Promise<boolean> {
    this.reset();
    try {
      const saved = await firstValueFrom(this.http.get<SavedSession>(`/api/sessions/${encodeURIComponent(sessionId)}`));
      this.threadId = saved.id;
      this.turns.set(replayRuns(saved.runs));
      this.reopened.set({ id: saved.id, title: saved.title, capturedAt: saved.updatedAt });
      this.freshness.set(new Map((saved.refreshable ?? []).map((r) => [r.surfaceId, { at: r.capturedAt, refreshed: false, busy: false }])));
      return true;
    } catch (err) {
      this.loadError.set(errorMessage(err));
      return false;
    }
  }

  async send(prompt: string, opts: { reviewPullRequest?: number } = {}): Promise<void> {
    const text = prompt.trim();
    if (!text || this.isBusy()) return;

    const turnId = crypto.randomUUID();
    this.turns.update((list) => [...list, newTurn(turnId, text)]);

    try {
      const model = this.model.requested();
      const body: StartRunRequest = {
        prompt: text,
        ...(this.threadId ? { threadId: this.threadId } : {}),
        ...(model ? { model } : {}),
        ...(opts.reviewPullRequest ? { reviewPullRequest: opts.reviewPullRequest } : {}),
      };
      const { runId, threadId } = await firstValueFrom(this.http.post<StartRunResponse>('/api/runs', body));
      this.threadId = threadId;
      this.listen(turnId, runId);
    } catch (err) {
      this.update(turnId, { type: 'RUN_ERROR', message: errorMessage(err) });
    }
  }

  /**
   * User actions from rendered components:
   * - ApprovalCard approve / reject resume the paused run; edit rejects it and
   *   hands the original request back to the prompt box;
   * - ErrorFallback retry asks the agent again, saying what went wrong.
   */
  readonly handleUiEvent = (event: UiEvent): void => {
    const payload = (event.payload ?? {}) as { toolCallId?: unknown; selected?: unknown; message?: unknown; edits?: unknown; changed?: unknown };

    if (event.component === 'ErrorFallback' && event.name === 'retry') {
      const reason = typeof payload.message === 'string' ? payload.message.slice(0, 300) : 'it failed validation';
      void this.send(`Part of your last answer could not be shown (${reason}). Please try again.`);
      return;
    }

    // The approval surfaces: ApprovalCard and PrReview (a review the user submits or discards).
    const gate = event.component === 'ApprovalCard' || event.component === 'PrReview' || event.component === 'ReleaseForm';
    if (!gate || typeof payload.toolCallId !== 'string') return;
    if (event.name === 'edit') {
      void this.editRequest(payload.toolCallId);
    } else if (event.name === 'rewrite') {
      void this.rewrite(payload.toolCallId, payload.edits, payload.changed);
    } else if (event.name === 'approve' || event.name === 'reject') {
      const selected = Array.isArray(payload.selected) ? payload.selected.filter((n): n is number => Number.isInteger(n)) : undefined;
      void this.decide(payload.toolCallId, event.name, selected, payload.edits);
    }
  };

  /** Rejects the waiting change, then puts the request back in the prompt box to rephrase. */
  async editRequest(toolCallId: string): Promise<void> {
    const prompt = this.turns().find((t) => t.pending?.toolCallId === toolCallId)?.prompt;
    if (prompt === undefined) return;
    if (await this.decide(toolCallId, 'reject')) {
      this.draft.set(prompt);
      this.composerFocus.update((n) => n + 1);
    }
  }

  /**
   * "Ask agent to rewrite" on a ReleaseForm: discard this draft, then ask for a new
   * one that keeps exactly the values the user set. Sent once the discard run ends.
   */
  async rewrite(toolCallId: string, edits: unknown, changed: unknown): Promise<void> {
    const prompt = rewritePrompt(edits, Array.isArray(changed) ? changed.filter((c): c is string => typeof c === 'string') : []);
    if (await this.decide(toolCallId, 'reject')) this.queued = prompt;
  }

  /** Sends the decision on a paused run. Resolves true when the server accepted it. */
  async decide(toolCallId: string, decision: ApprovalAction['decision'], selected?: number[], edits?: unknown): Promise<boolean> {
    // Only a card the server actually paused on can be answered.
    const turn = this.turns().find((t) => t.status === 'awaiting-approval' && t.pending?.toolCallId === toolCallId);
    if (!turn?.pending) return false;
    const { runId, surfaceId } = turn.pending;
    this.patch(turn.id, { actionError: undefined });

    try {
      const body: ApprovalAction = {
        toolCallId,
        decision,
        ...(decision === 'approve' && selected ? { selected } : {}),
        ...(decision === 'approve' && edits !== undefined ? { edits } : {}),
      };
      const next = await firstValueFrom(this.http.post<StartRunResponse>(`/api/runs/${encodeURIComponent(runId)}/actions`, body));
      this.patch(turn.id, { status: 'running', pending: undefined });
      this.listen(turn.id, next.runId);
      return true;
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 404) {
        // Already answered or lost (e.g. the server restarted): unlock the conversation.
        this.patch(turn.id, { status: 'error', pending: undefined, error: errorMessage(err) });
        return false;
      }
      // Re-send the card as a new object so it resets and can be used again.
      this.turns.update((list) =>
        list.map((t) =>
          t.id !== turn.id
            ? t
            : {
                ...t,
                actionError: errorMessage(err),
                surfaces: t.surfaces.map((s) => (s.surfaceId === surfaceId ? { ...s, node: { ...s.node } } : s)),
              },
        ),
      );
      return false;
    }
  }

  /**
   * Refresh on a reopened surface: the server re-runs the read tool behind it
   * (no model call) and the new data replaces the surface in place. Not saved:
   * reopening the session again shows what was captured.
   */
  async refresh(surfaceId: string): Promise<void> {
    const sessionId = this.threadId;
    const current = this.freshness().get(surfaceId);
    if (!sessionId || !current || current.busy) return;
    this.setFreshness(surfaceId, { ...current, busy: true, error: undefined });
    try {
      const res = await firstValueFrom(
        this.http.post<{ surfaceId: string; node: UiSurface['node']; refreshedAt: string }>(
          `/api/sessions/${encodeURIComponent(sessionId)}/surfaces/${encodeURIComponent(surfaceId)}/refresh`,
          {},
        ),
      );
      this.turns.update((list) =>
        list.map((t) => ({ ...t, surfaces: t.surfaces.map((s) => (s.surfaceId === surfaceId ? { surfaceId: s.surfaceId, node: res.node } : s)) })),
      );
      this.setFreshness(surfaceId, { at: res.refreshedAt, refreshed: true, busy: false });
    } catch (err) {
      this.setFreshness(surfaceId, { ...current, busy: false, error: errorMessage(err) });
    }
  }

  private setFreshness(surfaceId: string, value: Freshness) {
    this.freshness.update((m) => new Map(m).set(surfaceId, value));
  }

  /** Start a fresh conversation. */
  reset(): void {
    this.queued = undefined;
    this.freshness.set(new Map());
    this.reopened.set(null);
    this.loadError.set(null);
    this.source?.close();
    this.source = undefined;
    this.threadId = undefined;
    this.turns.set([]);
  }

  private listen(turnId: string, runId: string) {
    this.source?.close();
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    this.source = source;

    source.onmessage = (message) => {
      let event: AgentEvent;
      try {
        event = JSON.parse(message.data) as AgentEvent;
      } catch {
        return;
      }
      this.update(turnId, event);
      if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') {
        source.close();
        const next = this.queued;
        this.queued = undefined;
        if (next && event.type === 'RUN_FINISHED') void this.send(next);
      }
    };

    source.onerror = () => {
      source.close();
      if (this.turns().find((t) => t.id === turnId)?.status === 'running') {
        this.update(turnId, { type: 'RUN_ERROR', message: 'Lost the connection to the agent server.' });
      }
    };
  }

  private update(turnId: string, event: AgentEvent) {
    if (event.type === 'CUSTOM' && event.name === 'client_tool') {
      this.runClientTool(event.value);
      return;
    }
    this.turns.update((list) => list.map((t) => (t.id === turnId ? applyEvent(t, event) : t)));
  }

  /**
   * Client tools from the agent (validated by the server). They only change
   * what is on screen: filter a table in place, scroll to diff lines, or open a page.
   */
  private runClientTool(call: ClientToolCall) {
    const filter = tableFilterOf({ type: 'CUSTOM', name: 'client_tool', value: call });
    if (filter) {
      this.turns.update((list) => filterTables(list, filter));
      return;
    }
    const a = (call.args ?? {}) as Record<string, unknown>;
    if (call.name === 'highlight_lines' && typeof a['path'] === 'string' && Number.isInteger(a['from']) && Number.isInteger(a['to'])) {
      const seq = this.clientTools.requestHighlight(a['path'], a['from'] as number, a['to'] as number);
      // Give the diff views a frame to claim it; otherwise tell the user the lines are not on screen.
      setTimeout(() => this.clientTools.checkMissed(seq), 300);
      return;
    }
    if (call.name === 'navigate_to') {
      const route = routeFor(a);
      if (route) void this.router.navigateByUrl(route);
    }
  }

  /** Clear on a table the agent filtered: show the rows it fetched again. */
  clearFilter(surfaceId: string) {
    this.turns.update((list) => clearFilter(list, surfaceId));
  }

  private patch(turnId: string, changes: Partial<Turn>) {
    this.turns.update((list) => list.map((t) => (t.id === turnId ? { ...t, ...changes } : t)));
  }
}

/** The rewrite request for a release draft, listing the values the user set so the agent keeps them. */
export function rewritePrompt(edits: unknown, changed: string[]): string {
  const parsed = ReleaseEdits.safeParse(edits);
  if (!parsed.success || changed.length === 0) return 'Rewrite the release draft with clearer wording.';
  const e = parsed.data;
  const notes = (key: keyof ReleaseEdits['sections']) =>
    e.sections[key].map((x) => `${x.text}${x.pr ? ` (#${x.pr})` : ''}`).join('; ') || 'none';
  const keep: string[] = [];
  if (changed.includes('tag')) keep.push(`tag ${e.tag}`);
  if (changed.includes('name')) keep.push(`name "${e.name}"`);
  if (changed.includes('prerelease')) keep.push(e.prerelease ? 'a pre-release' : 'not a pre-release');
  if (changed.includes('features')) keep.push(`features: ${notes('features')}`);
  if (changed.includes('fixes')) keep.push(`fixes: ${notes('fixes')}`);
  if (changed.includes('breaking')) keep.push(`breaking changes: ${notes('breaking')}`);
  return `Rewrite the release draft for ${e.tag}. Keep exactly what I set: ${keep.join('; ')}.`.slice(0, 2000);
}

function errorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    return err.error?.error ?? (err.status === 0 || err.status === 504 ? 'The agent server is not reachable. Is it running?' : err.message);
  }
  return String(err);
}

/** navigate_to → an app route, or null for anything unexpected. */
export function routeFor(args: Record<string, unknown>): string | null {
  const pages: Record<string, string> = {
    ask: '/ask',
    pull_requests: '/pulls',
    issues: '/issues',
    releases: '/releases',
    history: '/history',
    audit: '/audit',
  };
  if (args['page'] === 'pull_request') return Number.isInteger(args['number']) && (args['number'] as number) > 0 ? `/pulls/${args['number']}` : null;
  return typeof args['page'] === 'string' ? (pages[args['page']] ?? null) : null;
}
