import { bigserial, boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Postgres schema (doc §9b). Two choices differ from the doc sketch:
 * - a session keeps the model's full message history as one jsonb array, because
 *   replayed history must keep tool calls, tool results and provider `raw` parts
 *   (Gemini thought signatures), not only role + text;
 * - a run keeps its event stream; reopening a session replays those events
 *   through the same reducer the live stream uses, instead of a separate
 *   ui_surfaces table.
 */

export const sessions = pgTable(
  'sessions',
  {
    /** The agent thread id. */
    id: uuid('id').primaryKey(),
    /** GitHub login of the token owner (OAuth users in week 4). */
    userId: text('user_id').notNull(),
    repo: text('repo').notNull(),
    title: text('title').notNull(),
    status: text('status', { enum: ['active', 'awaiting-approval', 'done'] }).notNull().default('active'),
    model: text('model'),
    /** ChatMessage[] as the LLM layer uses it. */
    messages: jsonb('messages').notNull().default([]),
    /** PendingApproval while a change waits; survives a server restart. */
    pending: jsonb('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('sessions_updated_idx').on(t.updatedAt)],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .references(() => sessions.id, { onDelete: 'cascade' })
      .notNull(),
    /** The user's prompt; null for a run that resumed after an approval (it belongs to the previous prompt). */
    prompt: text('prompt'),
    status: text('status', { enum: ['done', 'error', 'awaiting-approval'] }).notNull(),
    /** AgentEvent[] exactly as streamed. */
    events: jsonb('events').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('runs_session_idx').on(t.sessionId, t.createdAt)],
);

export const auditEntries = pgTable(
  'audit_entries',
  {
    /** Shown as aud_0001. */
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    /** Kept when the session is deleted (doc §9b). */
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    runId: uuid('run_id'),
    tool: text('tool').notNull(),
    risk: text('risk', { enum: ['write', 'destructive'] }).notNull(),
    /** "Close 5 issues", "Review on PR #15", "Release v1.1.0". */
    summary: text('summary').notNull(),
    prompt: text('prompt'),
    /** The validated tool input, with the user's edits applied. */
    input: jsonb('input').notNull(),
    approvedIds: jsonb('approved_ids').notNull().default([]),
    /** Items the dry run offered that the user unticked. */
    keptByUser: jsonb('kept_by_user').notNull().default([]),
    approvedBy: text('approved_by').notNull(),
    ok: boolean('ok').notNull(),
    result: text('result').notNull(),
    /** What GitHub answered, as the tool summarised it. */
    response: jsonb('response'),
    /** How to reverse it (see tools/undo.ts), or null when it cannot be undone here. */
    inverse: jsonb('inverse'),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    undoResult: text('undo_result'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('audit_created_idx').on(t.createdAt), index('audit_session_idx').on(t.sessionId)],
);
