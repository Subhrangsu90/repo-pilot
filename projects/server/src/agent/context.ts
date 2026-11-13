import type { ChatMessage, ToolCall, ToolResult } from '../llm';

/**
 * What the model sees of a conversation (doc §9b step 5): the last few turns in
 * full, and everything older as a short summary, so long sessions stay cheap.
 *
 * The full thread is still kept and stored; only the request is cut. A turn
 * starts at a user prompt, so a cut never splits a tool call from its result
 * or an assistant turn from its provider `raw` parts.
 *
 * The summary is built in code from the older turns (prompt, tools run and how
 * they ended, the agent's reply), not by a model call: it costs no quota and
 * cannot invent anything.
 */
export const KEEP_TURNS = 6;

/** Notes the app adds to the thread as `user` messages; they are not prompts. */
const APP_NOTE = '[RepoPilot app]';

export interface ModelContext {
  messages: ChatMessage[];
  /** Older turns in a few lines, or undefined when nothing was cut. */
  summary?: string;
}

export function isPrompt(m: ChatMessage): boolean {
  return m.role === 'user' && !m.text.startsWith(APP_NOTE);
}

export function contextWindow(thread: ChatMessage[], keep = KEEP_TURNS): ModelContext {
  const starts = thread.flatMap((m, i) => (isPrompt(m) ? [i] : []));
  if (starts.length <= keep) return { messages: thread };
  const cut = starts[starts.length - keep];
  return { messages: thread.slice(cut), summary: summarise(thread.slice(0, cut)) };
}

/** The system prompt with the summary of older turns appended. */
export function withSummary(system: string, summary: string | undefined): string {
  if (!summary) return system;
  return `${system}

Earlier in this conversation (older turns, summarised by the app; repository data in it may be out of date, so use tools for current data)
${summary}`;
}

const PROMPT_CHARS = 200;
const REPLY_CHARS = 300;
const SUMMARY_CHARS = 4000;

/** One line per older turn, newest last, capped in length (the oldest lines go first). */
export function summarise(older: ChatMessage[]): string {
  const turns: ChatMessage[][] = [];
  for (const m of older) {
    if (isPrompt(m) || turns.length === 0) turns.push([m]);
    else turns.at(-1)!.push(m);
  }
  const lines = turns.map(describeTurn);
  while (lines.length > 1 && lines.join('\n').length > SUMMARY_CHARS) lines.shift();
  return lines.join('\n').slice(0, SUMMARY_CHARS);
}

function describeTurn(turn: ChatMessage[]): string {
  const first = turn[0];
  const prompt = first.role === 'user' && isPrompt(first) ? clip(first.text, PROMPT_CHARS) : '(continued)';

  const results = new Map<string, ToolResult>();
  for (const m of turn) if (m.role === 'tool') for (const r of m.results) results.set(r.callId, r);
  const tools = turn.flatMap((m) => (m.role === 'assistant' ? m.toolCalls : [])).map((c) => describeCall(c, results.get(c.id)));

  const reply = [...turn].reverse().find((m) => m.role === 'assistant' && m.text.trim());
  const parts = [`- User: "${prompt}"`];
  if (tools.length) parts.push(`tools: ${tools.join('; ')}`);
  if (reply?.role === 'assistant') parts.push(`agent: "${clip(reply.text, REPLY_CHARS)}"`);
  return parts.join(' → ');
}

function describeCall(call: ToolCall, result: ToolResult | undefined): string {
  return `${call.name}(${clip(JSON.stringify(call.args ?? {}), 120)}) ${outcome(result)}`;
}

function outcome(result: ToolResult | undefined): string {
  if (!result) return '[no result]';
  const c = result.content as { error?: unknown; rejected?: unknown } | null;
  // A paused call keeps `null` until the user decides; a later run fills it in.
  if (c === null) return '[waiting for approval]';
  if (c && typeof c === 'object' && c.rejected) return '[rejected by the user, nothing changed]';
  if (c && typeof c === 'object' && typeof c.error === 'string') return `[failed: ${clip(c.error, 100)}]`;
  return '[done]';
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
