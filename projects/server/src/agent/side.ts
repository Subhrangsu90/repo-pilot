import { needsApproval } from '@repopilot/shared';
import type { ChatMessage, LlmToolDef } from '../llm';
import type { PendingApproval } from './loop';

/**
 * Side questions while a change waits for approval ("take me to the auth
 * changes" with a review draft open). The run sees a copy of the conversation in
 * which the paused call is answered with "not decided yet", so every tool call
 * still has a result, and it only gets read and client tools. The copy is
 * thrown away afterwards: the real thread and its waiting change are untouched.
 */
export function sideHistory(messages: ChatMessage[], pending: PendingApproval): ChatMessage[] {
  const copy = structuredClone(messages);
  // A review drafted by the app has no tool call in the thread, so there is nothing to answer.
  if (pending.synthetic) return copy;
  const waiting = { waiting: true, note: 'The user has not decided on this change yet; it is still waiting on screen.' };
  copy.push({ role: 'tool', results: pending.results.map((r) => (r.callId === pending.callId ? { ...r, content: waiting } : r)) });
  return copy;
}

/** The tools a side question may use: no tool that changes the repository. */
export function readOnlyTools(tools: LlmToolDef[]): LlmToolDef[] {
  return tools.filter((t) => !needsApproval(t.name));
}
