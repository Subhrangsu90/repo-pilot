import { Component, inject, input } from '@angular/core';
import { Auth } from '../../core/auth';
import { RepoChoice, type RepoItem } from '../../core/repo';
import { Icon } from './icon';

let nextId = 0;

/**
 * The repository picker (side nav and Settings): every repository the user can
 * access, public and private. Pages and the agent work on the selected one.
 */
@Component({
  selector: 'app-repo-picker',
  imports: [Icon],
  host: { class: 'flex flex-col gap-1.5' },
  template: `
    <label [for]="id" [class]="compact() ? 'px-1 text-caption text-fg-faint' : 'text-label text-fg-muted'">Repository</label>
    @if (repos.repos().length) {
      <div class="relative">
        <select
          [id]="id"
          class="field w-full cursor-pointer appearance-none pr-9 font-mono text-body-sm"
          [value]="repos.selected() ?? ''"
          [title]="repos.selected() ?? ''"
          (change)="pick($event)"
        >
          @for (r of repos.repos(); track r.full) {
            <option [value]="r.full" [selected]="r.full === repos.selected()">{{ label(r) }}</option>
          }
        </select>
        <app-icon name="chevron-down" [size]="16" class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-fg-muted" />
      </div>
    } @else if (repos.list.isLoading()) {
      <div class="h-11 animate-pulse rounded-md bg-surface-3" aria-hidden="true"></div>
    } @else if (repos.list.error()) {
      <p class="flex flex-wrap items-center gap-2 px-1 text-body-sm text-fg-muted" role="alert">
        Could not list your repositories.
        <button type="button" class="btn btn-ghost px-3" (click)="repos.list.reload()">Retry</button>
      </p>
    } @else {
      <p class="px-1 text-body-sm text-fg-muted">Your GitHub account has no repositories RepoPilot can see.</p>
    }
  `,
})
export class RepoPicker {
  /** Side-nav styling (small caption label). */
  readonly compact = input(false);

  protected readonly repos = inject(RepoChoice);
  private readonly auth = inject(Auth);
  protected readonly id = `repo-picker-${++nextId}`;

  /** "repo-pilot", "site · private", "js-loops · chaicodehq": the owner only when it is not you. */
  protected label(r: RepoItem): string {
    const [owner, name] = r.full.split('/');
    const mine = owner.toLowerCase() === (this.auth.user()?.login ?? '').toLowerCase();
    return [name, mine ? null : owner, r.private ? 'private' : null].filter(Boolean).join(' · ');
  }

  protected pick(event: Event) {
    const full = (event.target as HTMLSelectElement).value;
    if (full) this.repos.select(full);
  }
}
