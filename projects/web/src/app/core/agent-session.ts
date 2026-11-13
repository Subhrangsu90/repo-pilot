import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { Router } from '@angular/router';
import { HttpAgent, type AbstractAgent, type Context, type Message, type ResumeEntry, type Tool } from '@ag-ui/client';
import * as z from 'zod';
import {
  ApprovalDecision,
  clientToolSpecs,
  EventType,
  getToolSpec,
  ReleaseEdits,
  type A2uiMessage,
  type A2uiUserAction,
  type AgUiEvent,
  type ForwardedProps,
  type UiEvent,
} from '@repopilot/shared';
import { firstValueFrom } from 'rxjs';
import type { SavedSession } from './api';
import { applyEvent, clearFilter, filterTables, newTurn, replayRuns, tableFilterOf, type ClientToolCall, type Turn } from './agent-run';
import { Auth } from './auth';
import { ClientTools } from './client-tools';
import { RepoChoice } from './repo';
import { ModelChoice } from './model-choice';

/** How current a reopened surface is. */
export interface Freshness {
  /** When the data was captured, or refreshed. */
  at: string;
  refreshed: boolean;
  busy: boolean;
  error?: string;
}

/** Creates the AG-UI agent for one run of a thread (tests swap in a fake transport). */
export const AGENT_FACTORY = new InjectionToken<(threadId: string) => AbstractAgent>('AGENT_FACTORY', {
  providedIn: 'root',
  factory: () => (threadId: string) => new HttpAgent({ url: '/api/agent', threadId }),
});

/** The tools this app can apply on screen, declared to the agent as AG-UI frontend tools. */
const CLIENT_TOOLS: Tool[] = clientToolSpecs.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }),
}));

/** A failed run start, with what the server said. */
interface RunFailure {
  status?: number;
  message: string;
}

/**
 * The conversation as signals, over the AG-UI protocol.
 *
 * Every run is one `HttpAgent.runAgent()` (POST /api/agent with a
 * RunAgentInput, events back over SSE): a prompt sends the new user message;
 * the answer to an approval sends an AG-UI `resume` entry for the run's
 * interrupt. The server keeps the conversation, so each run carries only the
 * new message. A fresh agent per run also lets side questions run while an
 * interrupt waits (an agent with pending interrupts would refuse them).
 * Components only read signals; nothing subscribes manually.
 */
@Injectable({ providedIn: 'root' })
export class AgentSession {
  private readonly http = inject(HttpClient);
  private readonly model = inject(ModelChoice);
  private readonly router = inject(Router);
  private readonly auth = inject(Auth);
  private readonly clientTools = inject(ClientTools);
  private readonly repoChoice = inject(RepoChoice);
  private readonly createAgent = inject(AGENT_FACTORY);
  private threadId: string | undefined;
  /** The agent of the run in progress (Stop aborts it). */
  private running: AbstractAgent | undefined;
  private stopRequested = false;
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

  /** The saved session this conversation belongs to (its AG-UI thread id), once it has one. */
  get sessionId(): string | undefined {
    return this.threadId;
  }

  /**
   * Reopens a saved session: replays its stored AG-UI events, no model call. New
   * prompts continue it, and a change that was waiting can still be approved.
   */
  async load(sessionId: string): Promise<boolean> {
    this.reset();
    try {
      const saved = await firstValueFrom(this.http.get<SavedSession>(`/api/sessions/${encodeURIComponent(sessionId)}`));
      this.threadId = saved.id;
      // A conversation belongs to its repository: show the app on that repo.
      if (saved.repo) this.repoChoice.select(saved.repo);
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
    const message: Message = { id: crypto.randomUUID(), role: 'user', content: text };
    const failure = await this.run(turnId, { messages: [message], forwardedProps: { ...this.forwarded(), ...(opts.reviewPullRequest ? { reviewPullRequest: opts.reviewPullRequest } : {}) } });
    if (failure) this.update(turnId, { type: EventType.RUN_ERROR, message: failure.message });
  }

  /** Stops the run in progress: the server ends it as cancelled (an approved change that already started still completes). */
  stop(): void {
    if (!this.running) return;
    this.stopRequested = true;
    this.queued = undefined;
    this.running.abortRun();
  }

  /**
   * User actions from rendered components (A2UI actions, as UiEvents):
   * - ApprovalCard / PrReview / ReleaseForm approve / reject answer the run's
   *   interrupt; edit rejects it and hands the request back to the prompt box;
   * - ErrorFallback retry asks the agent again, saying what went wrong.
   */
  readonly handleUiEvent = (event: UiEvent): void => {
    const payload = (event.payload ?? {}) as { toolCallId?: unknown; selected?: unknown; message?: unknown; edits?: unknown; changed?: unknown };

    if (event.component === 'ErrorFallback' && event.name === 'retry') {
      const reason = typeof payload.message === 'string' ? payload.message.slice(0, 300) : 'it failed validation';
      void this.send(`Part of your last answer could not be shown (${reason}). Please try again.`);
      return;
    }

    const gate = event.component === 'ApprovalCard' || event.component === 'PrReview' || event.component === 'ReleaseForm';
    if (!gate || typeof payload.toolCallId !== 'string') return;
    if (event.name === 'edit') {
      void this.editRequest(payload.toolCallId, event.action);
    } else if (event.name === 'rewrite') {
      void this.rewrite(payload.toolCallId, payload.edits, payload.changed, event.action);
    } else if (event.name === 'approve' || event.name === 'reject') {
      const selected = Array.isArray(payload.selected) ? payload.selected.filter((n): n is number => Number.isInteger(n)) : undefined;
      void this.decide(payload.toolCallId, event.name, selected, payload.edits, event.action);
    }
  };

  /** Rejects the waiting change, then puts the request back in the prompt box to rephrase. */
  async editRequest(toolCallId: string, action?: A2uiUserAction): Promise<void> {
    const prompt = this.turns().find((t) => t.pending?.toolCallId === toolCallId)?.prompt;
    if (prompt === undefined) return;
    if (await this.decide(toolCallId, 'reject', undefined, undefined, action)) {
      this.draft.set(prompt);
      this.composerFocus.update((n) => n + 1);
    }
  }

  /**
   * "Ask agent to rewrite" on a ReleaseForm: discard this draft, then ask for a new
   * one that keeps exactly the values the user set. Sent once the discard run ends.
   */
  async rewrite(toolCallId: string, edits: unknown, changed: unknown, action?: A2uiUserAction): Promise<void> {
    const prompt = rewritePrompt(edits, Array.isArray(changed) ? changed.filter((c): c is string => typeof c === 'string') : []);
    if (await this.decide(toolCallId, 'reject', undefined, undefined, action)) this.queued = prompt;
  }

  /**
   * Answers the paused run's interrupt with an AG-UI resume entry; the new run
   * streams into the same turn. Resolves true when the server accepted it.
   */
  async decide(toolCallId: string, decision: ApprovalDecision['decision'], selected?: number[], edits?: unknown, action?: A2uiUserAction): Promise<boolean> {
    // Only a card the server actually paused on can be answered.
    const turn = this.turns().find((t) => t.status === 'awaiting-approval' && t.pending?.toolCallId === toolCallId);
    if (!turn?.pending || !this.threadId) return false;
    const { interruptId, surfaceId } = turn.pending;
    this.patch(turn.id, { actionError: undefined, status: 'running', pending: undefined });

    const payload: ApprovalDecision = {
      decision,
      ...(decision === 'approve' && selected ? { selected } : {}),
      ...(decision === 'approve' && edits !== undefined ? { edits } : {}),
    };
    const resume: ResumeEntry[] = [{ interruptId, status: 'resolved', payload }];
    const failure = await this.run(turn.id, { resume, forwardedProps: { ...this.forwarded(), ...(action ? { a2uiAction: { userAction: action } } : {}) } });
    if (!failure) return true;

    if (failure.status === 404) {
      // Already answered or lost (e.g. the server restarted): unlock the conversation.
      this.patch(turn.id, { status: 'error', error: failure.message });
      return false;
    }
    // Not accepted: the card waits again. Re-send its surface as a new list so it resets.
    this.turns.update((list) =>
      list.map((t) =>
        t.id !== turn.id
          ? t
          : {
              ...t,
              status: 'awaiting-approval',
              pending: turn.pending,
              actionError: failure.message,
              surfaces: t.surfaces.map((s) => (s.surfaceId === surfaceId ? { ...s, operations: [...s.operations] } : s)),
            },
      ),
    );
    return false;
  }

  /**
   * Refresh on a reopened surface: the server re-runs the read tool behind it
   * (no model call) and its new A2UI operations replace the surface in place.
   * Not saved: reopening the session again shows what was captured.
   */
  async refresh(surfaceId: string): Promise<void> {
    const sessionId = this.threadId;
    const current = this.freshness().get(surfaceId);
    if (!sessionId || !current || current.busy) return;
    this.setFreshness(surfaceId, { ...current, busy: true, error: undefined });
    try {
      const res = await firstValueFrom(
        this.http.post<{ surfaceId: string; operations: A2uiMessage[]; refreshedAt: string }>(
          `/api/sessions/${encodeURIComponent(sessionId)}/surfaces/${encodeURIComponent(surfaceId)}/refresh`,
          {},
        ),
      );
      this.turns.update((list) =>
        list.map((t) => ({ ...t, surfaces: t.surfaces.map((s) => (s.surfaceId === surfaceId ? { surfaceId: s.surfaceId, operations: res.operations } : s)) })),
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
    if (this.running) this.stop();
    this.freshness.set(new Map());
    this.reopened.set(null);
    this.loadError.set(null);
    this.threadId = undefined;
    this.turns.set([]);
  }

  /** forwardedProps every run carries: the repository picked in the app and the model switch. */
  private forwarded(): ForwardedProps {
    const model = this.model.requested();
    const repo = this.repoChoice.selected();
    return { ...(model ? { model } : {}), ...(repo ? { repo } : {}) };
  }

  /** AG-UI context: where the user is in the app (the agent may use it; it is not an instruction). */
  private context(): Context[] {
    return [{ description: 'Current page', value: this.router.url.split('?')[0].slice(0, 200) }];
  }

  /**
   * One AG-UI run into a turn. Resolves null when the run streamed (even if it
   * then ended with RUN_ERROR, which the reducer shows), or the failure when the
   * server did not accept it.
   */
  private async run(turnId: string, input: { messages?: Message[]; resume?: ResumeEntry[]; forwardedProps: ForwardedProps }): Promise<RunFailure | null> {
    this.threadId ??= crypto.randomUUID();
    const agent = this.createAgent(this.threadId);
    if (input.messages) agent.setMessages(input.messages);
    this.running = agent;
    this.stopRequested = false;
    let streamed = false;
    let ended = false;
    try {
      await agent.runAgent(
        {
          runId: crypto.randomUUID(),
          tools: CLIENT_TOOLS,
          context: this.context(),
          forwardedProps: input.forwardedProps,
          ...(input.resume ? { resume: input.resume } : {}),
        },
        {
          onEvent: ({ event }) => {
            streamed = true;
            const e = event as AgUiEvent;
            if (e.type === EventType.RUN_FINISHED || e.type === EventType.RUN_ERROR) ended = true;
            this.update(turnId, e);
          },
          onToolCallEndEvent: ({ event, toolCallName, toolCallArgs }) => this.runClientTool({ callId: event.toolCallId, name: toolCallName, args: toolCallArgs }),
        },
      );
      const next = this.queued;
      this.queued = undefined;
      if (next && this.turns().find((t) => t.id === turnId)?.status === 'done') void this.send(next);
      return null;
    } catch (err) {
      if (this.stopRequested) {
        // The connection was closed on purpose; the server ends the run as cancelled.
        this.update(turnId, { type: EventType.RUN_FINISHED, threadId: this.threadId, runId: '', outcome: { type: 'cancelled' } });
        return null;
      }
      const failure = runFailure(err);
      if (failure.status === 401) this.signInAgain();
      if (streamed) {
        if (!ended) this.update(turnId, { type: EventType.RUN_ERROR, message: failure.status ? failure.message : 'Lost the connection to the agent server.' });
        return null;
      }
      return failure;
    } finally {
      if (this.running === agent) this.running = undefined;
    }
  }

  private update(turnId: string, event: AgUiEvent) {
    this.turns.update((list) => list.map((t) => (t.id === turnId ? applyEvent(t, event) : t)));
  }

  /** A 401 means the sign-in is gone: to /signin, back to this page afterwards (as the HTTP interceptor does). */
  private signInAgain() {
    this.auth.expired.set(true);
    const here = this.router.url;
    if (!here.startsWith('/signin')) void this.router.navigate(['/signin'], { queryParams: { error: 'expired', next: here } });
  }

  /**
   * Client tools from the agent (AG-UI frontend tools this app declared). The
   * arguments are checked with the tool's own schema here too. They only change
   * what is on screen: filter a table in place, scroll to diff lines, or open a page.
   */
  private runClientTool(call: ClientToolCall) {
    const spec = getToolSpec(call.name);
    if (spec?.side !== 'client') return;
    const parsed = spec.input.safeParse(call.args);
    if (!parsed.success) return;
    const checked = { ...call, args: parsed.data };
    const filter = tableFilterOf(checked);
    if (filter) {
      this.turns.update((list) => filterTables(list, filter));
      return;
    }
    const a = parsed.data as Record<string, unknown>;
    if (call.name === 'highlight_lines') {
      const seq = this.clientTools.requestHighlight(a['path'] as string, a['from'] as number, a['to'] as number);
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

/** What went wrong starting a run: HttpAgent puts the HTTP status and the parsed body on its error. */
function runFailure(err: unknown): RunFailure {
  const e = err as { status?: unknown; payload?: unknown; message?: unknown; name?: unknown };
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const fromServer = (e?.payload as { error?: unknown } | undefined)?.error;
  if (typeof fromServer === 'string') return { status, message: fromServer };
  if (status === undefined && (e?.name === 'TypeError' || /fetch|network/i.test(String(e?.message)))) {
    return { message: 'The agent server is not reachable. Is it running?' };
  }
  if (status === 504 || status === 502) return { status, message: 'The agent server is not reachable. Is it running?' };
  return { status, message: String(e?.message ?? err) };
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
