import { httpResource } from '@angular/common/http';
import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { valueOf } from './resource';

/** GET /api/repos items: the repositories the signed-in user can access. */
export interface RepoItem {
  full: string;
  private: boolean;
  description: string | null;
  pushedAt: string | null;
  canWrite: boolean;
}

const KEY = 'repopilot-repo';

function stored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * The repository the app works on, picked in the side nav from every repo the
 * user can access (public and private, with the `repo` OAuth scope). Pages and
 * the agent use only this one; a conversation stays on the repo it started with.
 * The pick is remembered in this browser.
 */
@Injectable({ providedIn: 'root' })
export class RepoChoice {
  readonly list = httpResource<{ items: RepoItem[] }>(() => '/api/repos');
  readonly repos = computed(() => valueOf(this.list)?.items ?? []);
  private readonly picked = signal<string | null>(stored());

  /** The picked repo while it is in the list (or the list is loading), else the most recently pushed one. */
  readonly selected = computed<string | null>(() => {
    const p = this.picked();
    if (!this.list.hasValue()) return p;
    const items = this.repos();
    const match = p ? items.find((r) => r.full.toLowerCase() === p.toLowerCase()) : undefined;
    return match?.full ?? items[0]?.full ?? null;
  });

  /** "owner / name" pieces for display. */
  readonly parts = computed(() => {
    const full = this.selected();
    if (!full) return null;
    const [owner, name] = full.split('/');
    return { owner, name, full };
  });

  select(full: string) {
    this.picked.set(full);
    try {
      localStorage.setItem(KEY, full);
    } catch {
      // Private mode or blocked storage: the pick lasts for this page only.
    }
  }
}

/**
 * Runs `fn` when the user switches from one repository to another (not when the
 * first one is resolved at load). Call it in an injection context (a constructor
 * or field initializer).
 */
export function onRepoSwitch(fn: (repo: string) => void): void {
  const choice = inject(RepoChoice);
  let previous: string | null = null;
  effect(() => {
    const repo = choice.selected();
    untracked(() => {
      if (previous && repo && repo !== previous) fn(repo);
      if (repo) previous = repo;
    });
  });
}
