import { EventType, type AgUiEvent, type ModelOption, type RepoPilotState } from '@repopilot/shared';
import type { RunFinishedOutcome, TokenUsage } from '@ag-ui/core';
import type { ChatMessage, LlmUsage } from '../llm';
import type { PendingApproval } from './loop';
import { StreamGuard } from '@repopilot/shared';

/** The AG-UI protocol version this server speaks (RUN_STARTED.protocolVersion). */
export const AGUI_PROTOCOL_VERSION = '1.0';

/**
 * In-memory runs and threads (Postgres keeps them across restarts). A run is
 * one AG-UI run: RUN_STARTED, a STATE_SNAPSHOT, the agent's events, then
 * RUN_FINISHED (success, interrupt or cancelled) or RUN_ERROR. The run buffers
 * its events for the store, and anything left open is closed before it ends.
 */
interface Run {
  id: string;
  threadId: string;
  events: AgUiEvent[];
  listeners: Set<(event: AgUiEvent) => void>;
  done: boolean;
  controller: AbortController;
  /** The user prompt that started it; undefined for a run that resumed after an approval. */
  prompt?: string;
}

/** What the store sees when a run ends. */
export interface FinishedRun {
  id: string;
  prompt?: string;
  events: AgUiEvent[];
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
  /** A tool call paused as an AG-UI interrupt. Answered by a run whose `resume` names it. */
  pending?: PendingApproval;
}

/** How a run body ends: its AG-UI outcome (absent = success). */
export interface RunEnd {
  outcome?: RunFinishedOutcome;
}

export interface RunControl {
  id: string;
  signal: AbortSignal;
  /** Token usage of one model call; RUN_FINISHED reports the sum per provider and model. */
  addUsage: (usage: LlmUsage) => void;
}

export type RunBody = (thread: Thread, emit: (e: AgUiEvent) => void, run: RunControl) => Promise<RunEnd | void>;

const RUN_TTL_MS = 10 * 60_000;
const MAX_THREADS = 200;

const runs = new Map<string, Run>();
const threads = new Map<string, Thread>();

export class ThreadBusyError extends Error {}
export class RunIdTakenError extends Error {}

export function getThread(id: string | undefined): Thread | undefined {
  return id ? threads.get(id) : undefined;
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

/** The shared state of a thread, sent as STATE_SNAPSHOT when a run starts. */
export function stateOf(thread: Thread): RepoPilotState {
  const p = thread.pending;
  return {
    repo: thread.repo ?? null,
    model: thread.model ?? null,
    pendingApproval: p ? { interruptId: p.callId, toolCallId: p.callId, surfaceId: p.surfaceId } : null,
    followups: [],
  };
}

/**
 * Starts an AG-UI run on a thread (created with the client's thread id when new).
 * The body's events are streamed to subscribers as they happen.
 */
export function startRun(
  threadId: string,
  runId: string,
  body: RunBody,
  opts: { prompt?: string; owner?: string; repo?: string } = {},
): { runId: string; threadId: string } {
  if (runs.has(runId)) throw new RunIdTakenError('This run id was used already.');
  const thread = threads.get(threadId) ?? { id: threadId, messages: [], busy: false, touched: Date.now(), owner: opts.owner, repo: opts.repo };
  if (thread.busy) throw new ThreadBusyError('This conversation is still running.');
  thread.busy = true;
  thread.touched = Date.now();
  threads.set(threadId, thread);
  evictOldThreads();

  const run: Run = { id: runId, threadId, events: [], listeners: new Set(), done: false, controller: new AbortController(), prompt: opts.prompt };
  runs.set(run.id, run);
  const guard = new StreamGuard();
  const usage = new Map<string, TokenUsage>();

  const emit = (event: AgUiEvent) => {
    if (run.done) return;
    guard.track(event);
    run.events.push(event);
    for (const l of run.listeners) l(event);
  };
  const usageList = (): TokenUsage[] | undefined => (usage.size ? [...usage.values()] : undefined);
  const control: RunControl = {
    id: run.id,
    signal: run.controller.signal,
    addUsage: (u) => {
      const key = `${u.provider}/${u.model}`;
      const sum = usage.get(key) ?? { provider: u.provider, model: u.model };
      for (const k of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedInputTokens'] as const) {
        if (typeof u[k] === 'number') sum[k] = (sum[k] ?? 0) + u[k];
      }
      if (sum.inputTokens !== undefined || sum.outputTokens !== undefined) sum.totalTokens = (sum.inputTokens ?? 0) + (sum.outputTokens ?? 0);
      usage.set(key, sum);
    },
  };

  emit({ type: EventType.RUN_STARTED, threadId, runId: run.id, protocolVersion: AGUI_PROTOCOL_VERSION });
  emit({ type: EventType.STATE_SNAPSHOT, snapshot: stateOf(thread) });

  const finish = (outcome: RunFinishedOutcome | undefined) => {
    guard.closeAll(emit, outcome?.type === 'cancelled' ? 'Stopped' : 'Did not finish');
    const u = usageList();
    emit({ type: EventType.RUN_FINISHED, threadId, runId: run.id, ...(outcome ? { outcome } : {}), ...(u ? { usage: u } : {}) });
  };

  void body(thread, emit, control)
    .then((end) => finish(run.controller.signal.aborted ? { type: 'cancelled' } : (end?.outcome ?? { type: 'success' })))
    .catch((err: Error) => {
      if (run.controller.signal.aborted) return finish({ type: 'cancelled' });
      const u = usageList();
      emit({ type: EventType.RUN_ERROR, message: err.message.slice(0, 300), ...(u ? { usage: u } : {}) });
    })
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

  return { runId: run.id, threadId };
}

/** Replays past events, then streams new ones. Returns an unsubscribe function, or null for an unknown run. */
export function subscribe(runId: string, listener: (event: AgUiEvent) => void): (() => void) | null {
  const run = runs.get(runId);
  if (!run) return null;
  for (const e of run.events) listener(e);
  if (run.done) return () => {};
  run.listeners.add(listener);
  return () => run.listeners.delete(listener);
}

/** Stops a run (the client went away or pressed Stop): it ends with outcome `cancelled`. */
export function cancelRun(runId: string) {
  const run = runs.get(runId);
  if (run && !run.done) run.controller.abort();
}

export function isTerminal(event: AgUiEvent) {
  return event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR;
}

function evictOldThreads() {
  if (threads.size <= MAX_THREADS) return;
  const oldest = [...threads].filter(([, t]) => !t.busy).sort((a, b) => a[1].touched - b[1].touched);
  for (const [id] of oldest.slice(0, threads.size - MAX_THREADS)) threads.delete(id);
}
