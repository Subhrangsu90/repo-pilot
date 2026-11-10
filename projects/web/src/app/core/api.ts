import type { AgentEvent } from '@repopilot/shared';

/** GET /api/sessions items (History list). */
export interface SessionSummary {
  id: string;
  title: string;
  status: 'active' | 'awaiting-approval' | 'done';
  repo: string;
  createdAt: string;
  updatedAt: string;
  madeChanges: boolean;
  prompt: string;
  lastResult: string;
  components: string[];
  turns: number;
}

/** GET /api/sessions/:id: the stored runs, replayed in order to rebuild the conversation. */
export interface SavedSession {
  id: string;
  title: string;
  status: SessionSummary['status'];
  repo: string;
  createdAt: string;
  updatedAt: string;
  runs: { id: string; prompt: string | null; status: string; events: AgentEvent[]; createdAt: string }[];
}

/** GET /api/audit items. */
export interface AuditEntry {
  id: string;
  sessionId: string | null;
  tool: string;
  risk: 'write' | 'destructive';
  summary: string;
  prompt: string | null;
  input: unknown;
  approvedIds: number[];
  keptByUser: number[];
  approvedBy: string;
  ok: boolean;
  result: string;
  response: unknown;
  inverse: { label: string; destructive: boolean } | null;
  undoable: boolean;
  undoneAt: string | null;
  undoResult: string | null;
  createdAt: string;
}

const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** "Today, 16:12", "Yesterday, 18:30", "8 Nov, 17:48" (Screen Spec audit log). */
export function formatWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const days = dayDiff(d, now);
  const prefix = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : day.format(d);
  return `${prefix}, ${time.format(d)}`;
}

/** Whole calendar days between two dates, in local time. */
export function dayDiff(a: Date, b: Date): number {
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((start(b) - start(a)) / 86_400_000);
}
