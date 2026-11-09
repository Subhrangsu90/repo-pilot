import { randomUUID } from 'node:crypto';
import type { AgentEvent, StartRunResponse } from '@repopilot/shared';
import type { ChatMessage } from '../llm';

/**
 * In-memory runs and threads (Postgres arrives with the audit log in week 3).
 * A run buffers its events, so a client that connects late, or reconnects,
 * replays everything from the start.
 */
interface Run {
  id: string;
  threadId: string;
  events: AgentEvent[];
  listeners: Set<(event: AgentEvent) => void>;
  done: boolean;
  controller: AbortController;
}

interface Thread {
  messages: ChatMessage[];
  busy: boolean;
  touched: number;
}

const RUN_TTL_MS = 10 * 60_000;
const MAX_THREADS = 200;

const runs = new Map<string, Run>();
const threads = new Map<string, Thread>();

export class ThreadBusyError extends Error {}

export type RunBody = (thread: ChatMessage[], emit: (e: AgentEvent) => void, run: { id: string; signal: AbortSignal }) => Promise<void>;

export function startRun(threadId: string | undefined, body: RunBody): StartRunResponse {
  const tid = threadId && threads.has(threadId) ? threadId : randomUUID();
  const thread = threads.get(tid) ?? { messages: [], busy: false, touched: Date.now() };
  if (thread.busy) throw new ThreadBusyError('This conversation is still running.');
  thread.busy = true;
  thread.touched = Date.now();
  threads.set(tid, thread);
  evictOldThreads();

  const run: Run = { id: randomUUID(), threadId: tid, events: [], listeners: new Set(), done: false, controller: new AbortController() };
  runs.set(run.id, run);

  const emit = (event: AgentEvent) => {
    if (run.done) return;
    run.events.push(event);
    for (const l of run.listeners) l(event);
  };

  emit({ type: 'RUN_STARTED', threadId: tid, runId: run.id });
  void body(thread.messages, emit, { id: run.id, signal: run.controller.signal })
    .then(() => emit({ type: 'RUN_FINISHED', threadId: tid, runId: run.id }))
    .catch((err: Error) => emit({ type: 'RUN_ERROR', message: err.message.slice(0, 300) }))
    .finally(() => {
      run.done = true;
      thread.busy = false;
      setTimeout(() => runs.delete(run.id), RUN_TTL_MS).unref();
    });

  return { runId: run.id, threadId: tid };
}

/** Replays past events, then streams new ones. Returns an unsubscribe function, or null for an unknown run. */
export function subscribe(runId: string, listener: (event: AgentEvent) => void): (() => void) | null {
  const run = runs.get(runId);
  if (!run) return null;
  for (const e of run.events) listener(e);
  if (run.done) return () => {};
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}

export function isTerminal(event: AgentEvent) {
  return event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR';
}

function evictOldThreads() {
  if (threads.size <= MAX_THREADS) return;
  const oldest = [...threads].filter(([, t]) => !t.busy).sort((a, b) => a[1].touched - b[1].touched);
  for (const [id] of oldest.slice(0, threads.size - MAX_THREADS)) threads.delete(id);
}
