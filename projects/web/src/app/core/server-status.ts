import { httpResource } from '@angular/common/http';
import { valueOf } from './resource';
import { computed, inject, Injectable } from '@angular/core';
import { RepoChoice } from './repo';

/** The non-secret part of GET /api/health. */
export interface Health {
  llm: { provider: 'gemini' | 'claude' | 'ollama'; model: string };
  github: { tokenConfigured: boolean };
}

/** GET /api/overview: live data for the side nav and the Ask top bar. */
export interface Overview {
  repo: string;
  openPullRequests: number | null;
  openIssues: number | null;
  latestRelease: string | null;
  rateLimit: { limit: number; remaining: number } | null;
  viewer: { login: string; avatarUrl: string };
}

/** Only GitHub's avatar CDN over https may load in the browser. */
const AVATAR = /^https:\/\/avatars\.githubusercontent\.com\//;

/** Shared server requests for the app chrome (shell, model switch, Ask top bar). */
@Injectable({ providedIn: 'root' })
export class ServerStatus {
  private readonly choice = inject(RepoChoice);
  readonly health = httpResource<Health>(() => '/api/health');
  /** For the selected repository. Reload after a run finishes: counts and the API quota change. */
  readonly overview = httpResource<Overview>(() => {
    const repo = this.choice.selected();
    return repo ? { url: '/api/overview', params: { repo } } : undefined;
  });

  /** The selected repo, split for display ("owner / name"). */
  readonly repo = this.choice.parts;

  readonly counts = computed(() => {
    const o = valueOf(this.overview);
    return { pulls: o?.openPullRequests ?? null, issues: o?.openIssues ?? null };
  });

  /** "4,812 / 5,000" requests left this hour, or null before it loads. */
  readonly quota = computed(() => {
    const r = valueOf(this.overview)?.rateLimit;
    return r ? { text: `${r.remaining.toLocaleString('en-US')} / ${r.limit.toLocaleString('en-US')}`, ...r } : null;
  });

  readonly viewer = computed(() => {
    const v = valueOf(this.overview)?.viewer;
    return v ? { login: v.login, avatarUrl: AVATAR.test(v.avatarUrl) ? v.avatarUrl : null } : null;
  });
}
