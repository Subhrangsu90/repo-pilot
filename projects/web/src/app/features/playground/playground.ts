import { Component, computed, signal } from '@angular/core';
import { fixtures, UiEvent } from '@repopilot/shared';
import { GenUiHost } from '../../genui/genui-host';

type Parsed = { ok: true; node: unknown } | { ok: false; error: string };

interface LoggedEvent extends UiEvent {
  id: number;
  at: string;
}

/**
 * Declarative Generative UI without a model: edit a node as JSON and watch the
 * renderer validate and draw it. The same host renders agent output in week 2.
 */
@Component({
  selector: 'app-playground',
  imports: [GenUiHost],
  template: `
    <div class="mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-4 py-8 sm:px-8">
      <div class="flex flex-col gap-1.5">
        <h1 class="font-display text-h1">Renderer playground</h1>
        <p class="max-w-3xl text-body text-fg-muted">
          Edit a UI node as JSON. It goes through the same validator the agent's output does: only catalog components
          render, and anything invalid falls back in place.
        </p>
      </div>

      <div class="flex flex-wrap gap-2" role="group" aria-label="Load an example">
        @for (f of fixtures; track f.id) {
          <button
            type="button"
            class="chip aria-pressed:border-fg aria-pressed:bg-surface-3 aria-pressed:text-fg"
            [attr.aria-pressed]="activeFixture() === f.id"
            (click)="load(f.id)"
          >
            {{ f.label }}
          </button>
        }
      </div>

      <div class="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div class="flex min-w-0 flex-col gap-4">
          <label class="flex flex-col gap-1.5">
            <span class="text-label text-fg-muted">Node JSON</span>
            <textarea
              class="h-[28rem] resize-y rounded-md border border-border-strong bg-surface-2 p-3 font-mono text-[12px] leading-relaxed text-fg"
              spellcheck="false"
              [value]="source()"
              (input)="edit($event)"
              [attr.aria-invalid]="!parsed().ok"
              aria-describedby="json-status"
            ></textarea>
          </label>
          <p id="json-status" class="text-body-sm" [class.text-danger]="!parsed().ok" [class.text-fg-muted]="parsed().ok">
            @if (parsed(); as p) {
              {{ p.ok ? 'Valid JSON' : p.error }}
            }
          </p>

          <section class="card p-4" aria-labelledby="events-title">
            <div class="flex items-center justify-between">
              <h2 id="events-title" class="text-body font-semibold">Events sent to the agent</h2>
              @if (events().length) {
                <button type="button" class="btn btn-ghost min-h-9 px-2 text-body-sm" (click)="events.set([])">Clear</button>
              }
            </div>
            @if (events().length === 0) {
              <p class="mt-2 text-body-sm text-fg-muted">Interact with a component (try "Selectable issues").</p>
            } @else {
              <ol class="mt-2 flex max-h-48 flex-col gap-1 overflow-auto font-mono text-[12px]" aria-live="polite">
                @for (e of events(); track e.id) {
                  <li class="truncate">
                    <span class="text-fg-faint">{{ e.at }}</span>
                    <span class="text-fg">{{ e.component }}.{{ e.name }}</span>
                    <span class="text-fg-muted">{{ stringify(e.payload) }}</span>
                  </li>
                }
              </ol>
            }
          </section>
        </div>

        <section class="agent-surface flex min-w-0 flex-col gap-4 self-start p-4 sm:p-6" aria-label="Rendered output">
          <span class="badge badge-agent self-end">
            <span class="size-1.5 rounded-full bg-fg" aria-hidden="true"></span>
            Rendered from JSON
          </span>
          @if (parsed(); as p) {
            @if (p.ok) {
              <app-genui-host [node]="p.node" [emit]="onEmit" />
            } @else {
              <div class="card grid h-40 place-items-center text-body-sm text-fg-muted">Fix the JSON to render.</div>
            }
          }
        </section>
      </div>
    </div>
  `,
})
export class Playground {
  protected readonly fixtures = fixtures;
  protected readonly activeFixture = signal<string | null>(fixtures[0].id);
  protected readonly source = signal(pretty(fixtures[0].node));
  protected readonly events = signal<LoggedEvent[]>([]);
  private nextEventId = 1;

  protected readonly parsed = computed<Parsed>(() => {
    try {
      return { ok: true, node: JSON.parse(this.source()) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON' };
    }
  });

  protected readonly onEmit = (event: UiEvent) => {
    const at = new Date().toLocaleTimeString([], { hour12: false });
    this.events.update((list) => [{ ...event, id: this.nextEventId++, at }, ...list].slice(0, 30));
  };

  protected load(id: string) {
    const fixture = fixtures.find((f) => f.id === id);
    if (!fixture) return;
    this.activeFixture.set(id);
    this.source.set(pretty(fixture.node));
  }

  protected edit(event: Event) {
    this.activeFixture.set(null);
    this.source.set((event.target as HTMLTextAreaElement).value);
  }

  protected stringify(value: unknown) {
    return value === undefined ? '' : JSON.stringify(value);
  }
}

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}
