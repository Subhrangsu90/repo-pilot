import { httpResource } from '@angular/common/http';
import { computed, Injectable } from '@angular/core';

/** The non-secret part of GET /api/health. */
export interface Health {
  llm: { provider: 'gemini' | 'claude' | 'ollama'; model: string };
  github: { tokenConfigured: boolean; repos: string[] };
}

/** One shared /api/health request for the shell and the model switch. */
@Injectable({ providedIn: 'root' })
export class ServerStatus {
  readonly health = httpResource<Health>(() => '/api/health');

  /** First allowlisted repo, split for display ("owner / name"). */
  readonly repo = computed(() => {
    const full = this.health.value()?.github.repos[0];
    if (!full) return null;
    const [owner, name] = full.split('/');
    return { owner, name: name ?? owner, full };
  });
}
