import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { AgentEvent, StartRunRequest, StartRunResponse } from '@repopilot/shared';
import { firstValueFrom } from 'rxjs';
import { applyEvent, newTurn, Turn } from './agent-run';
import { ModelChoice } from './model-choice';

/**
 * The conversation as signals. Each prompt starts a run on the agent server
 * (POST /api/runs) and its events arrive over Server-Sent Events. Components
 * only read signals; nothing subscribes manually.
 */
@Injectable({ providedIn: 'root' })
export class AgentSession {
  private readonly http = inject(HttpClient);
  private readonly model = inject(ModelChoice);
  private threadId: string | undefined;
  private source: EventSource | undefined;

  readonly turns = signal<Turn[]>([]);
  readonly isBusy = computed(() => this.turns().at(-1)?.status === 'running');

  async send(prompt: string): Promise<void> {
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
      };
      const { runId, threadId } = await firstValueFrom(this.http.post<StartRunResponse>('/api/runs', body));
      this.threadId = threadId;
      this.listen(turnId, runId);
    } catch (err) {
      const message =
        err instanceof HttpErrorResponse
          ? (err.error?.error ?? (err.status === 0 || err.status === 504 ? 'The agent server is not reachable. Is it running?' : err.message))
          : String(err);
      this.update(turnId, { type: 'RUN_ERROR', message });
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
}
