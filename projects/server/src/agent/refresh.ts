import { getToolSpec, needsApproval, validateNode, type UiNode } from '@repopilot/shared';
import type { ChatMessage, ToolCall } from '../llm';
import { ToolError, type Executor, type ToolContext } from '../tools/read-tools';
import { dropNulls } from './loop';

/**
 * Refresh on reopened surfaces (doc §9b step 6). A saved session shows its data
 * as captured; Refresh re-runs the read tool that produced a surface, with its
 * stored input, and returns the new node. No model call, and only read tools:
 * approval surfaces and render_ui views (written by the model) cannot be re-run.
 */

interface StoredRun {
  id: string;
  createdAt: Date | string;
  events: unknown;
}

/** Tools whose surface is their own data, so running them again gives fresh data. */
function canRefresh(name: string): boolean {
  const spec = getToolSpec(name);
  return !!spec && spec.risk === 'read' && !needsApproval(name) && name !== 'render_ui';
}

/**
 * Surfaces of a session that can be refreshed, with the tool call behind each
 * and when it was captured. Tool surfaces are named `${runId}-${callId}`.
 */
export function refreshableSurfaces(runs: StoredRun[], messages: ChatMessage[]): Map<string, { call: ToolCall; capturedAt: string }> {
  const calls = new Map<string, ToolCall>();
  for (const m of messages) if (m.role === 'assistant') for (const c of m.toolCalls) calls.set(c.id, c);

  const out = new Map<string, { call: ToolCall; capturedAt: string }>();
  for (const run of runs) {
    const events = Array.isArray(run.events) ? (run.events as { type?: unknown; name?: unknown; value?: { surfaceId?: unknown } }[]) : [];
    for (const e of events) {
      if (e.type !== 'CUSTOM' || e.name !== 'ui' || typeof e.value?.surfaceId !== 'string') continue;
      const surfaceId = e.value.surfaceId;
      if (!surfaceId.startsWith(`${run.id}-`)) continue;
      const call = calls.get(surfaceId.slice(run.id.length + 1));
      if (call && canRefresh(call.name)) out.set(surfaceId, { call, capturedAt: new Date(run.createdAt).toISOString() });
    }
  }
  return out;
}

/** Runs the read tool again with its stored input; returns the validated node. Throws ToolError for the user. */
export async function refreshSurface(call: ToolCall, executors: Record<string, Executor<any>>, ctx: ToolContext): Promise<UiNode> {
  const spec = getToolSpec(call.name);
  const run = spec && canRefresh(spec.name) ? executors[spec.name] : undefined;
  if (!spec || !run) throw new ToolError('This result cannot be refreshed.');
  const parsed = spec.input.safeParse(dropNulls(call.args));
  if (!parsed.success) throw new ToolError('The stored request is no longer valid, so it cannot be refreshed.');
  const out = await run(parsed.data, ctx);
  if (!out.ui) throw new ToolError('The tool returned nothing to show.');
  const check = validateNode(out.ui);
  if (!check.ok) throw new ToolError('The refreshed data could not be shown.');
  return out.ui;
}
