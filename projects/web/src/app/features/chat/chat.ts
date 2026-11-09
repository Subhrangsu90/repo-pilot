import { afterRenderEffect, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import type { EmitFn } from '@repopilot/shared';
import { AgentSession } from '../../core/agent-session';
import { StepTimeline } from '../../genui/components/step-timeline';
import { GenUiHost } from '../../genui/genui-host';

const SUGGESTIONS = [
  'Show my open PRs',
  'Give me a health report of the repo',
  'List wontfix issues',
  'Which PRs have failing CI or no reviewers?',
];

@Component({
  selector: 'app-chat',
  imports: [GenUiHost, StepTimeline],
  host: { class: 'flex min-h-[calc(100dvh-8.5rem)] flex-col' },
  template: `
    <div class="flex-1">
      @if (session.turns().length === 0) {
        <div class="mx-auto mt-10 max-w-2xl text-center sm:mt-16">
          <h2 class="text-2xl font-semibold">What do you want to know about your repo?</h2>
          <p class="mt-2 text-sm text-muted">Ask in plain English. Answers come back as live UI built from real GitHub data.</p>
          <div class="mt-6 flex flex-wrap justify-center gap-2">
            @for (s of suggestions; track s) {
              <button type="button" class="btn" (click)="ask(s)">{{ s }}</button>
            }
          </div>
        </div>
      }

      <ol class="flex flex-col gap-8" aria-label="Conversation" aria-live="polite">
        @for (turn of session.turns(); track turn.id) {
          <li class="flex flex-col gap-3">
            <p class="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2 text-sm text-white">{{ turn.prompt }}</p>

            @if (turn.steps.length) {
              <app-step-timeline class="px-1" [props]="{ steps: turn.steps }" />
            }

            @for (surface of turn.surfaces; track surface.surfaceId) {
              <app-genui-host [node]="surface.node" [emit]="onEmit" />
            }

            @if (turn.text) {
              <p class="max-w-3xl whitespace-pre-line text-sm leading-relaxed text-ink">{{ turn.text }}</p>
            }

            @if (turn.status === 'error') {
              <div class="card flex items-center justify-between gap-3 border-danger/40 bg-danger/5 p-3 text-sm" role="alert">
                <span class="text-danger">{{ turn.error }}</span>
                <button type="button" class="btn shrink-0" (click)="ask(turn.prompt)" [disabled]="session.isBusy()">Retry</button>
              </div>
            }
          </li>
        }
      </ol>
      <div #end></div>
    </div>

    <form class="sticky bottom-0 mt-6 bg-canvas pb-4 pt-2" (submit)="submit($event)">
      <div class="card flex items-end gap-2 p-2 focus-within:outline-2 focus-within:outline-accent">
        <label for="prompt" class="sr-only">Ask RepoPilot</label>
        <textarea
          #promptBox
          id="prompt"
          rows="1"
          class="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-ink outline-none placeholder:text-muted"
          placeholder="Ask about pull requests, issues or repo health…"
          [value]="draft()"
          (input)="draft.set(promptBox.value)"
          (keydown.enter)="onEnter($event)"
        ></textarea>
        @if (session.turns().length) {
          <button type="button" class="btn" (click)="newChat()" [disabled]="session.isBusy()">New chat</button>
        }
        <button type="submit" class="btn btn-primary" [disabled]="session.isBusy() || !draft().trim()">
          {{ session.isBusy() ? 'Working…' : 'Send' }}
        </button>
      </div>
    </form>
  `,
})
export class Chat {
  protected readonly session = inject(AgentSession);
  protected readonly suggestions = SUGGESTIONS;
  protected readonly draft = signal('');
  private readonly end = viewChild.required<ElementRef<HTMLElement>>('end');

  /** User actions inside rendered components. Sent to the agent from week 3 (approvals, selections). */
  protected readonly onEmit: EmitFn = () => {};

  constructor() {
    // Keep the newest output in view as it streams in.
    afterRenderEffect(() => {
      this.session.turns();
      this.end().nativeElement.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });
  }

  protected ask(prompt: string) {
    this.draft.set('');
    void this.session.send(prompt);
  }

  protected submit(event: Event) {
    event.preventDefault();
    if (!this.session.isBusy()) this.ask(this.draft());
  }

  protected onEnter(event: Event) {
    const key = event as KeyboardEvent;
    if (key.shiftKey || key.isComposing) return;
    this.submit(event);
  }

  protected newChat() {
    this.session.reset();
  }
}
