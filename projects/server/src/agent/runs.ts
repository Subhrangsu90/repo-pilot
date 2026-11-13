import { randomUUID } from 'node:crypto';
import type { AgentEvent, ModelOption, StartRunResponse } from '@repopilot/shared';
import type { ChatMessage } from '../llm';
import type { PendingApproval } from './loop';

/**
 * In-memory runs and threads (moving to Postgres with the audit log).
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
  /** The user prompt that started it; undefined for a run that resumed after an approval. */
  prompt?: string;
}

/** What the store sees when a run ends. */
export interface FinishedRun {
  id: string;
  prompt?: string;
  events: AgentEvent[];
}

export interface Thread {
  id: string;
  messages: ChatMessage[];
  busy: boolean;
  touched: number;
  /** The GitHub login that started the conversation; only they may continue it or answer its approvals. */
  owner?: string;
  /** The repository ("owner/name") the conversation works on; set by its first prompt. */
  repo?: string;
  /** Model picked in the UI when the conversation last ran; resumed runs use it too. */
  model?: ModelOption;
  /** A tool call paused on an ApprovalCard. New prompts are refused until it is answered. */
  pending?: PendingApproval;
}

const RUN_TTL_MS = 10 * 60_000;
const MAX_THREADS = 200;

const runs = new Map<string, Run>();
const threads = new Map<string, Thread>();

export class ThreadBusyError extends Error {}

export type RunBody = (thread: Thread, emit: (e: AgentEvent) => void, run: { id: string; signal: AbortSignal }) => Promise<void>;

export function getThread(id: string | undefined): Thread | undefined {
  return id ? threads.get(id) : undefined;
}

/** The thread whose pending approval was raised by this run. */
export function findPendingByRun(runId: string): Thread | undefined {
  for (const thread of threads.values()) if (thread.pending?.runId === runId) return thread;
  return undefined;
}

let observer: ((run: FinishedRun, thread: Thread) => void) | undefined;

/** Called once per finished run (persistence). Errors in it never affect the run. */
export function onRunFinished(fn: (run: FinishedRun, thread: Thread) => void) {
  observer = fn;
}

/** Puts a conversation loaded from the database back in memory (after a restart). */
export function restoreThread(data: Pick<Thread, 'id' | 'messages' | 'model' | 'pending' | 'owner' | 'repo'>): Thread {
  const existing = threads.get(data.id);
  if (existing) return existing;
  const thread: Thread = { ...data, busy: false, touched: Date.now() };
  threads.set(thread.id, thread);
  evictOldThreads();
  return thread;
}

/** Forgets a conversation (deleted from History). */
export function dropThread(id: string) {
  const thread = threads.get(id);
  if (thread && !thread.busy) threads.delete(id);
}

export function startRun(threadId: string | undefined, body: RunBody, opts: { prompt?: string; owner?: string; repo?: string } = {}): StartRunResponse {
  const tid = threadId && threads.has(threadId) ? threadId : randomUUID();
  const thread = threads.get(tid) ?? { id: tid, messages: [], busy: false, touched: Date.now(), owner: opts.owner, repo: opts.repo };
  if (thread.busy) throw new ThreadBusyError('This conversation is still running.');
  thread.busy = true;
  thread.touched = Date.now();
  threads.set(tid, thread);
  evictOldThreads();

  const run: Run = {
    id: randomUUID(),
    threadId: tid,
    events: [],
    listeners: new Set(),
    done: false,
    controller: new AbortController(),
    prompt: opts.prompt,
  };
  runs.set(run.id, run);

  const emit = (event: AgentEvent) => {
    if (run.done) return;
    run.events.push(event);
    for (const l of run.listeners) l(event);
  };

  emit({ type: 'RUN_STARTED', threadId: tid, runId: run.id });
  void body(thread, emit, { id: run.id, signal: run.controller.signal })
    .then(() => emit({ type: 'RUN_FINISHED', threadId: tid, runId: run.id }))
    .catch((err: Error) => emit({ type: 'RUN_ERROR', message: err.message.slice(0, 300) }))
    .finally(() => {
      run.done = true;
      thread.busy = false;
      try {
        observer?.({ id: run.id, prompt: run.prompt, events: run.events }, thread);
      } catch {
        // Persistence problems are logged by the store; the run itself is done.
      }
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

/** The owner of the conversation a run belongs to (undefined for an unknown run). */
export function runOwner(runId: string): string | undefined {
  const run = runs.get(runId);
  return run ? threads.get(run.threadId)?.owner : undefined;
}

export function isTerminal(event: AgentEvent) {
  return event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR';
}

function evictOldThreads() {
  if (threads.size <= MAX_THREADS) return;
  const oldest = [...threads].filter(([, t]) => !t.busy).sort((a, b) => a[1].touched - b[1].touched);
  for (const [id] of oldest.slice(0, threads.size - MAX_THREADS)) threads.delete(id);
}
