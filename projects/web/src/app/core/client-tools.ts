import { Injectable, signal } from '@angular/core';

/** A highlight_lines request: new-file lines `from`–`to` of `path`. `seq` makes each request new. */
export interface Highlight {
  path: string;
  from: number;
  to: number;
  seq: number;
}

/**
 * State for client tools that act on components already on screen (doc §8
 * "Client tools"). AgentSession writes it; DiffViewer reads it and scrolls to /
 * highlights its lines. Navigation goes through the Router, and table filters
 * are a pure transform of the turns (agent-run.ts), so neither lives here.
 */
@Injectable({ providedIn: 'root' })
export class ClientTools {
  private seq = 0;
  readonly highlight = signal<Highlight | null>(null);
  /** Set when no DiffViewer on screen had the requested lines, so the user is told. */
  readonly missed = signal<Highlight | null>(null);

  requestHighlight(path: string, from: number, to: number): number {
    this.missed.set(null);
    this.highlight.set({ path, from, to, seq: ++this.seq });
    return this.seq;
  }

  /** DiffViewer reports that it showed the highlight. */
  shown(seq: number) {
    if (this.highlight()?.seq === seq) this.claimed = seq;
  }

  /** After the views had a chance to claim it: no DiffViewer had those lines. */
  checkMissed(seq: number) {
    const h = this.highlight();
    if (h?.seq === seq && this.claimed !== seq) this.missed.set(h);
  }

  private claimed = 0;
}
