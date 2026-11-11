import { computed, inject, Injectable, signal } from '@angular/core';
import type { ModelOption } from '@repopilot/shared';
import { ServerStatus } from './server-status';

const KEY = 'repopilot-model';

function readStored(): ModelOption | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'cloud' || value === 'local' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The side-nav model switch (Cloud / Local Gemma). Until the user picks one,
 * runs use the server's configured default (LLM_PROVIDER), so an env override
 * on the server still wins.
 */
@Injectable({ providedIn: 'root' })
export class ModelChoice {
  private readonly status = inject(ServerStatus);
  private readonly picked = signal<ModelOption | null>(readStored());

  private readonly serverDefault = computed<ModelOption>(() =>
    this.status.health.value()?.llm.provider === 'ollama' ? 'local' : 'cloud',
  );

  /** What the switch shows. */
  readonly current = computed<ModelOption>(() => this.picked() ?? this.serverDefault());

  /** What a run sends: only an explicit choice. */
  readonly requested = this.picked.asReadonly();

  pick(option: ModelOption): void {
    this.picked.set(option);
    try {
      localStorage.setItem(KEY, option);
    } catch {
      // Not persisted; still applies for this tab.
    }
  }
}
