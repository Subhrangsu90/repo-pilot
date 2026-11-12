import { httpResource } from '@angular/common/http';
import { valueOf } from '../../core/resource';
import { Component, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { PropsOf } from '@repopilot/shared';
import { GenUiHost } from '../../genui/genui-host';

interface PullsResponse {
  repo: string;
  items: PropsOf<'PrCard'>[];
}

/**
 * Open pull requests, each with a way into the agent review (Screen Spec gap
 * "pull request list page"). Cards go through GenUiHost, so they are validated
 * like any agent output.
 */
@Component({
  selector: 'app-pull-list',
  imports: [GenUiHost, RouterLink],
  host: { class: 'block' },
  template: `
    <div class="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-4 py-8 sm:px-8">
      <div class="flex flex-col gap-1.5">
        <h1 class="font-display text-h1">Pull requests</h1>
        <p class="text-body text-fg-muted">
          Open pull requests. Pick one for the agent to review; nothing is posted to GitHub until you submit.
        </p>
      </div>

      @if (pulls.isLoading()) {
        <div class="flex flex-col gap-2" aria-hidden="true">
          @for (i of [1, 2, 3]; track i) {
            <div class="h-24 animate-pulse rounded-lg bg-surface-3"></div>
          }
        </div>
      } @else if (pulls.error()) {
        <div class="card flex items-center justify-between gap-3 border-danger p-4" role="alert">
          <span class="text-body-sm">Could not load pull requests.</span>
          <button type="button" class="btn" (click)="pulls.reload()">Retry</button>
        </div>
      } @else {
        <ul class="flex flex-col gap-2">
          @for (pr of items(); track pr.number) {
            <li class="flex flex-wrap items-center gap-3">
              <app-genui-host class="min-w-0 flex-[1_1_480px]" [node]="{ component: 'PrCard', props: pr }" />
              <a class="btn" [routerLink]="['/pulls', pr.number]">Review #{{ pr.number }}</a>
            </li>
          } @empty {
            <li class="card p-6 text-center text-body-sm text-fg-muted">No open pull requests.</li>
          }
        </ul>
      }
    </div>
  `,
})
export class PullList {
  protected readonly pulls = httpResource<PullsResponse>(() => '/api/pulls');
  protected readonly items = computed(() => valueOf(this.pulls)?.items ?? []);
}
