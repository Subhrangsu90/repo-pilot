import { httpResource } from '@angular/common/http';
import { valueOf } from './resource';
import { computed, Injectable } from '@angular/core';

/** The non-secret part of GET /api/health. */
export interface Health {
  llm: { provider: 'gemini' | 'claude' | 'ollama'; model: string };
  github: { tokenConfigured: boolean; repos: string[] };
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
  readonly health = httpResource<Health>(() => '/api/health');
  /** Reload after a run finishes: counts and the API quota change. */
  readonly overview = httpResource<Overview>(() => '/api/overview');

  /** First allowlisted repo, split for display ("owner / name"). */
  readonly repo = computed(() => {
    const full = valueOf(this.health)?.github.repos[0];
    if (!full) return null;
    const [owner, name] = full.split('/');
    return { owner, name: name ?? owner, full };
  });

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
