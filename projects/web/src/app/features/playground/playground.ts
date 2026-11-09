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
    <div class="mb-5">
      <h2 class="text-xl font-semibold">Renderer playground</h2>
      <p class="mt-1 max-w-3xl text-sm text-muted">
        Edit a UI node as JSON. It goes through the same validator the agent's output will:
        only catalog components render, and anything invalid falls back in place.
      </p>
    </div>

    <div class="flex flex-wrap gap-2" role="group" aria-label="Load an example">
      @for (f of fixtures; track f.id) {
        <button
          type="button"
          class="btn"
          [class.btn-primary]="activeFixture() === f.id"
          [attr.aria-pressed]="activeFixture() === f.id"
          (click)="load(f.id)"
        >
          {{ f.label }}
        </button>
      }
    </div>

    <div class="mt-4 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div class="flex min-w-0 flex-col gap-4">
        <label class="flex flex-col gap-1.5">
          <span class="text-sm font-medium">Node JSON</span>
          <textarea
            class="card h-[28rem] resize-y p-3 font-mono text-xs leading-relaxed text-ink"
            spellcheck="false"
            [value]="source()"
            (input)="edit($event)"
            [attr.aria-invalid]="!parsed().ok"
            aria-describedby="json-status"
          ></textarea>
        </label>
        <p id="json-status" class="text-xs" [class.text-danger]="!parsed().ok" [class.text-muted]="parsed().ok">
          @if (parsed(); as p) {
            {{ p.ok ? 'Valid JSON' : p.error }}
          }
        </p>

        <section class="card p-4" aria-labelledby="events-title">
          <div class="flex items-center justify-between">
            <h3 id="events-title" class="text-sm font-medium">Events sent to the agent</h3>
            @if (events().length) {
              <button type="button" class="text-xs text-muted hover:text-ink" (click)="events.set([])">Clear</button>
            }
          </div>
          @if (events().length === 0) {
            <p class="mt-2 text-xs text-muted">Interact with a component (try "Selectable issues").</p>
          } @else {
            <ol class="mt-2 flex max-h-48 flex-col gap-1 overflow-auto font-mono text-xs" aria-live="polite">
              @for (e of events(); track e.id) {
                <li class="truncate">
                  <span class="text-muted">{{ e.at }}</span>
                  <span class="text-accent">{{ e.component }}.{{ e.name }}</span>
                  {{ stringify(e.payload) }}
                </li>
              }
            </ol>
          }
        </section>
      </div>

      <section class="min-w-0" aria-label="Rendered output">
        @if (parsed(); as p) {
          @if (p.ok) {
            <app-genui-host [node]="p.node" [emit]="onEmit" />
          } @else {
            <div class="card grid h-40 place-items-center text-sm text-muted">Fix the JSON to render.</div>
          }
        }
      </section>
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
