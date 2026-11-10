import { httpResource } from '@angular/common/http';
import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { EmitFn } from '@repopilot/shared';
import { hasReview, visibleSurfaces } from '../../core/agent-run';
import { AgentSession } from '../../core/agent-session';
import { PR_REVIEW_ON_PAGE } from '../../genui/components/pr-review';
import { StepTimeline } from '../../genui/components/step-timeline';
import { GenUiHost } from '../../genui/genui-host';
import { PrHeader, PrInfo } from '../../shared/ui/pr-header';

/**
 * Screen Spec "PR review": the PR header, the agent's step strip, then its
 * draft review (diffs with inline comments, changed files, Submit review). The
 * page runs its own agent conversation, separate from Ask, and starts the
 * review as soon as it opens.
 */
@Component({
  selector: 'app-pull-review',
  imports: [GenUiHost, PrHeader, RouterLink, StepTimeline],
  providers: [AgentSession, { provide: PR_REVIEW_ON_PAGE, useValue: true }],
  host: { class: 'block' },
  template: `
    <div class="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-4 py-8 sm:px-8">
      <a routerLink="/pulls" class="self-start text-body-sm text-fg-muted hover:text-fg">← Pull requests</a>

      @if (!valid()) {
        <p class="card border-danger p-4 text-body-sm" role="alert">"{{ number() }}" is not a pull request number.</p>
      } @else {
        @if (pr.value(); as info) {
          <app-pr-header [pr]="info" [level]="1" />
        } @else if (pr.error()) {
          <p class="card border-danger p-4 text-body-sm" role="alert">Pull request #{{ number() }} could not be loaded.</p>
        } @else {
          <div class="flex flex-col gap-2" aria-hidden="true">
            <div class="h-10 w-2/3 animate-pulse rounded-sm bg-surface-3"></div>
            <div class="h-5 w-1/2 animate-pulse rounded-sm bg-surface-3"></div>
          </div>
        }

        @if (turn(); as t) {
          <div class="flex flex-col gap-5" aria-live="polite">
            @if (t.steps.length) {
              <app-step-timeline [props]="{ steps: t.steps }" [inline]="true" />
            }

            @if (t.status === 'running' && !hasReview(t)) {
              @if (t.surfaces.length === 0) {
                <!-- Reserve the review's space while the agent reads the diff. -->
                <div class="flex flex-wrap items-start gap-5" aria-hidden="true">
                  <div class="h-96 min-w-0 flex-[3_1_520px] animate-pulse rounded-lg bg-surface-3"></div>
                  <div class="h-80 min-w-0 flex-[2_1_300px] animate-pulse rounded-xl bg-surface-3"></div>
                </div>
              } @else {
                <p class="flex items-center gap-2 text-body-md text-fg-muted" role="status">
                  <span class="grid size-5 place-items-center" aria-hidden="true">
                    <span class="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"></span>
                  </span>
                  Drafting the review…
                </p>
              }
            }

            @for (surface of surfaces(t); track surface.surfaceId) {
              <app-genui-host class="animate-genui-enter" [node]="surface.node" [emit]="onEmit" />
            }

            @if (t.actionError) {
              <p class="card border-danger px-4 py-3 text-body-sm" role="alert">Your decision was not sent: {{ t.actionError }}</p>
            }
            @if (t.text) {
              <p class="max-w-[680px] text-body whitespace-pre-line text-fg-muted">{{ t.text }}</p>
            }
            @if (t.status === 'error') {
              <div class="card flex items-center justify-between gap-3 border-danger p-4" role="alert">
                <span class="text-body-sm">{{ t.error }}</span>
                <button type="button" class="btn shrink-0" (click)="start()">Try again</button>
              </div>
            }
          </div>
        }
      }
    </div>
  `,
})
export class PullReview {
  /** Route parameter `/pulls/:number`. */
  readonly number = input.required<string>();

  protected readonly session = inject(AgentSession);
  protected readonly valid = computed(() => /^[1-9]\d{0,9}$/.test(this.number()));
  protected readonly pr = httpResource<PrInfo>(() => (this.valid() ? `/api/pulls/${this.number()}` : undefined));
  protected readonly turn = computed(() => this.session.turns().at(-1));
  protected readonly onEmit: EmitFn = this.session.handleUiEvent;
  protected readonly surfaces = visibleSurfaces;
  protected readonly hasReview = hasReview;

  constructor() {
    // A new PR number starts a new review conversation.
    effect(() => {
      if (!this.valid()) return;
      this.number();
      untracked(() => this.start());
    });
  }

  protected start() {
    this.session.reset();
    void this.session.send(`Review pull request #${this.number()}`);
  }
}
