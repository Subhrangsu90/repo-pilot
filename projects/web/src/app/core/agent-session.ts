import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { AgentEvent, ApprovalAction, StartRunRequest, StartRunResponse, UiEvent } from '@repopilot/shared';
import { firstValueFrom } from 'rxjs';
import { applyEvent, newTurn, Turn } from './agent-run';
import { ModelChoice } from './model-choice';

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
  private threadId: string | undefined;
  private source: EventSource | undefined;

  readonly turns = signal<Turn[]>([]);
  readonly isBusy = computed(() => this.turns().at(-1)?.status === 'running');
  /** The prompt box stays locked until the waiting card is answered. */
  readonly awaitingApproval = computed(() => this.turns().at(-1)?.status === 'awaiting-approval');
  /** Text in the prompt box; kept here so "Edit request" can refill it. */
  readonly draft = signal('');
  /** Bumped when the prompt box should take focus. */
  readonly composerFocus = signal(0);

  async send(prompt: string): Promise<void> {
    const text = prompt.trim();
    if (!text || this.isBusy() || this.awaitingApproval()) return;

    const turnId = crypto.randomUUID();
    this.turns.update((list) => [...list, newTurn(turnId, text)]);

    try {
      const model = this.model.requested();
      const body: StartRunRequest = {
        prompt: text,
        ...(this.threadId ? { threadId: this.threadId } : {}),
        ...(model ? { model } : {}),
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
    const payload = (event.payload ?? {}) as { toolCallId?: unknown; selected?: unknown; message?: unknown };

    if (event.component === 'ErrorFallback' && event.name === 'retry') {
      const reason = typeof payload.message === 'string' ? payload.message.slice(0, 300) : 'it failed validation';
      void this.send(`Part of your last answer could not be shown (${reason}). Please try again.`);
      return;
    }

    if (event.component !== 'ApprovalCard' || typeof payload.toolCallId !== 'string') return;
    if (event.name === 'edit') {
      void this.editRequest(payload.toolCallId);
    } else if (event.name === 'approve' || event.name === 'reject') {
      const selected = Array.isArray(payload.selected) ? payload.selected.filter((n): n is number => Number.isInteger(n)) : undefined;
      void this.decide(payload.toolCallId, event.name, selected);
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

  /** Sends the decision on a paused run. Resolves true when the server accepted it. */
  async decide(toolCallId: string, decision: ApprovalAction['decision'], selected?: number[]): Promise<boolean> {
    // Only a card the server actually paused on can be answered.
    const turn = this.turns().find((t) => t.status === 'awaiting-approval' && t.pending?.toolCallId === toolCallId);
    if (!turn?.pending) return false;
    const { runId, surfaceId } = turn.pending;
    this.patch(turn.id, { actionError: undefined });

    try {
      const body: ApprovalAction = { toolCallId, decision, ...(decision === 'approve' && selected ? { selected } : {}) };
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

  /** Start a fresh conversation. */
  reset(): void {
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
      if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') source.close();
    };

    source.onerror = () => {
      source.close();
      if (this.turns().find((t) => t.id === turnId)?.status === 'running') {
        this.update(turnId, { type: 'RUN_ERROR', message: 'Lost the connection to the agent server.' });
      }
    };
  }

  private update(turnId: string, event: AgentEvent) {
    this.turns.update((list) => list.map((t) => (t.id === turnId ? applyEvent(t, event) : t)));
  }

  private patch(turnId: string, changes: Partial<Turn>) {
    this.turns.update((list) => list.map((t) => (t.id === turnId ? { ...t, ...changes } : t)));
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    return err.error?.error ?? (err.status === 0 || err.status === 504 ? 'The agent server is not reachable. Is it running?' : err.message);
  }
  return String(err);
}
