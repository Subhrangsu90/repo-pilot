import { and, desc, eq, exists, ilike, isNotNull, or, sql } from 'drizzle-orm';
import type { AgentEvent } from '@repopilot/shared';
import type { Db } from './db/client';
import { auditEntries, runs, sessions } from './db/schema';
import type { ExecutedChange, PendingApproval } from './agent/loop';
import type { FinishedRun, Thread } from './agent/runs';
import type { ChatMessage } from './llm';
import type { Inverse } from './tools/undo';

export type AuditFilter = 'all' | 'write' | 'destructive' | 'undone';
export type SessionFilter = 'all' | 'waiting' | 'changes' | 'read';

/** aud_0007 ⇄ 7 */
export const auditId = (seq: number) => `aud_${String(seq).padStart(4, '0')}`;
export const auditSeq = (id: string) => (/^aud_(\d{1,12})$/.exec(id) ? Number(id.slice(4)) : null);

/** First line of the prompt, as a session title (the agent does not name sessions yet). */
export function titleFrom(prompt: string): string {
  const line = prompt.trim().split('\n')[0].replace(/\s+/g, ' ');
  const text = line.length > 80 ? `${line.slice(0, 77)}…` : line;
  return text ? text[0].toUpperCase() + text.slice(1) : 'Untitled session';
}

/** The components a run showed, in order, without repeats. */
export function componentsIn(events: AgentEvent[]): string[] {
  const names: string[] = [];
  for (const e of events) {
    if (e.type === 'CUSTOM' && e.name === 'ui' && !names.includes(e.value.node.component)) names.push(e.value.node.component);
  }
  return names;
}

/** The assistant's text in a run (the last message), for the History card. */
export function lastText(events: AgentEvent[]): string {
  let text = '';
  for (const e of events) {
    if (e.type === 'TEXT_MESSAGE_START') text = '';
    if (e.type === 'TEXT_MESSAGE_CONTENT') text += e.delta;
  }
  return text.trim().slice(0, 240);
}

export class Store {
  constructor(
    private readonly db: Db,
    private readonly who: { login: () => Promise<string>; repo: string },
    private readonly log: (msg: string, err: unknown) => void,
  ) {}

  // -------------------------------------------------------------------------
  // Sessions and runs
  // -------------------------------------------------------------------------

  /** Saves a finished run and the conversation state after it. Never throws. */
  async saveRun(run: FinishedRun, thread: Thread): Promise<void> {
    try {
      const last = run.events.at(-1);
      const waiting = thread.pending?.runId === run.id;
      const status = last?.type === 'RUN_ERROR' ? 'error' : waiting ? 'awaiting-approval' : 'done';
      const now = new Date();
      const userId = await this.who.login();
      await this.db.transaction(async (tx) => {
        await tx
          .insert(sessions)
          .values({
            id: thread.id,
            userId,
            repo: this.who.repo,
            title: titleFrom(run.prompt ?? 'Untitled session'),
            status: thread.pending ? 'awaiting-approval' : 'done',
            model: thread.model ?? null,
            messages: thread.messages,
            pending: thread.pending ?? null,
          })
          .onConflictDoUpdate({
            target: sessions.id,
            set: {
              status: thread.pending ? 'awaiting-approval' : 'done',
              model: thread.model ?? null,
              messages: thread.messages,
              pending: thread.pending ?? null,
              updatedAt: now,
            },
          });
        await tx.insert(runs).values({ id: run.id, sessionId: thread.id, prompt: run.prompt ?? null, status, events: run.events });
      });
    } catch (err) {
      this.log('could not save run', err);
    }
  }

  /** A conversation to put back in memory, e.g. after a server restart. */
  async loadThread(id: string): Promise<Pick<Thread, 'id' | 'messages' | 'model' | 'pending'> | null> {
    const row = await this.db.query.sessions.findFirst({ where: eq(sessions.id, id) });
    if (!row) return null;
    return {
      id: row.id,
      messages: row.messages as ChatMessage[],
      model: (row.model as Thread['model']) ?? undefined,
      pending: (row.pending as PendingApproval | null) ?? undefined,
    };
  }

  /** The session waiting on an approval raised by this run. */
  async findSessionPendingOnRun(runId: string): Promise<string | null> {
    const row = await this.db.query.sessions.findFirst({
      columns: { id: true },
      where: sql`${sessions.pending}->>'runId' = ${runId}`,
    });
    return row?.id ?? null;
  }

  async listSessions(opts: { q?: string; filter: SessionFilter; limit?: number }) {
    const conditions = [];
    if (opts.q) {
      const like = `%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(
        or(ilike(sessions.title, like), exists(this.db.select({ x: sql`1` }).from(runs).where(and(eq(runs.sessionId, sessions.id), ilike(runs.prompt, like))))),
      );
    }
    const changed = exists(this.db.select({ x: sql`1` }).from(auditEntries).where(and(eq(auditEntries.sessionId, sessions.id), eq(auditEntries.ok, true))));
    if (opts.filter === 'waiting') conditions.push(eq(sessions.status, 'awaiting-approval'));
    if (opts.filter === 'changes') conditions.push(changed);
    if (opts.filter === 'read') conditions.push(sql`not ${changed}`, eq(sessions.status, 'done'));

    const rows = await this.db
      .select({
        id: sessions.id,
        title: sessions.title,
        status: sessions.status,
        repo: sessions.repo,
        createdAt: sessions.createdAt,
        updatedAt: sessions.updatedAt,
        madeChanges: sql<boolean>`${changed}`,
      })
      .from(sessions)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(sessions.updatedAt))
      .limit(opts.limit ?? 100);

    // Per session: first prompt, last answer, components made (from its runs' events).
    const details = await Promise.all(
      rows.map(async (s) => {
        const r = await this.db
          .select({ prompt: runs.prompt, events: runs.events })
          .from(runs)
          .where(eq(runs.sessionId, s.id))
          .orderBy(runs.createdAt);
        const events = r.map((x) => x.events as AgentEvent[]);
        return {
          prompt: r.find((x) => x.prompt)?.prompt ?? '',
          lastResult: [...events].reverse().map(lastText).find(Boolean) ?? '',
          components: [...new Set(events.flatMap(componentsIn))].slice(0, 8),
          turns: r.filter((x) => x.prompt).length,
        };
      }),
    );
    return rows.map((s, i) => ({ ...s, ...details[i] }));
  }

  async getSession(id: string) {
    const session = await this.db.query.sessions.findFirst({
      columns: { id: true, title: true, status: true, repo: true, createdAt: true, updatedAt: true },
      where: eq(sessions.id, id),
    });
    if (!session) return null;
    const r = await this.db
      .select({ id: runs.id, prompt: runs.prompt, status: runs.status, events: runs.events, createdAt: runs.createdAt })
      .from(runs)
      .where(eq(runs.sessionId, id))
      .orderBy(runs.createdAt);
    return { ...session, runs: r };
  }

  async renameSession(id: string, title: string): Promise<boolean> {
    const r = await this.db.update(sessions).set({ title, updatedAt: new Date() }).where(eq(sessions.id, id)).returning({ id: sessions.id });
    return r.length > 0;
  }

  /** Deletes the session and its runs; its audit entries stay (session link cleared). */
  async deleteSession(id: string): Promise<boolean> {
    const r = await this.db.delete(sessions).where(eq(sessions.id, id)).returning({ id: sessions.id });
    return r.length > 0;
  }

  // -------------------------------------------------------------------------
  // Audit log
  // -------------------------------------------------------------------------

  async recordAudit(sessionId: string, change: ExecutedChange): Promise<string | null> {
    try {
      // The session row may not exist yet (it is saved when the run ends); create a stub so the link holds.
      await this.db
        .insert(sessions)
        .values({ id: sessionId, userId: await this.who.login(), repo: this.who.repo, title: titleFrom(change.prompt ?? change.summary) })
        .onConflictDoNothing();
      const [row] = await this.db
        .insert(auditEntries)
        .values({
          sessionId,
          runId: change.runId,
          tool: change.tool,
          risk: change.risk,
          summary: change.summary,
          prompt: change.prompt ?? null,
          input: change.edits === undefined ? change.input : { ...(change.input as object), edits: change.edits },
          approvedIds: change.approvedIds,
          keptByUser: change.keptByUser,
          approvedBy: await this.who.login(),
          ok: change.ok,
          result: change.result,
          response: change.response ?? null,
          inverse: change.inverse,
        })
        .returning({ seq: auditEntries.seq });
      return auditId(row.seq);
    } catch (err) {
      this.log('could not write audit entry', err);
      return null;
    }
  }

  async listAudit(filter: AuditFilter, limit = 100) {
    const where =
      filter === 'write'
        ? eq(auditEntries.risk, 'write')
        : filter === 'destructive'
          ? eq(auditEntries.risk, 'destructive')
          : filter === 'undone'
            ? isNotNull(auditEntries.undoneAt)
            : undefined;
    const rows = await this.db.select().from(auditEntries).where(where).orderBy(desc(auditEntries.createdAt)).limit(limit);
    return rows.map(present);
  }

  async getAudit(seq: number) {
    const row = await this.db.query.auditEntries.findFirst({ where: eq(auditEntries.seq, seq) });
    return row ? present(row) : null;
  }

  /** The stored inverse (server only: the API shows its label). */
  async getInverse(seq: number): Promise<Inverse | null> {
    const row = await this.db.query.auditEntries.findFirst({ columns: { inverse: true }, where: eq(auditEntries.seq, seq) });
    return (row?.inverse as Inverse | null) ?? null;
  }

  /** Marks an entry undone, once. Returns false if it was already undone. */
  async markUndone(seq: number, result: string): Promise<boolean> {
    const r = await this.db
      .update(auditEntries)
      .set({ undoneAt: new Date(), undoResult: result })
      .where(and(eq(auditEntries.seq, seq), sql`${auditEntries.undoneAt} is null`))
      .returning({ seq: auditEntries.seq });
    return r.length > 0;
  }
}

type AuditRow = typeof auditEntries.$inferSelect;

/** The API shape of an audit entry. */
function present(row: AuditRow) {
  const inverse = row.inverse as Inverse | null;
  return {
    id: auditId(row.seq),
    sessionId: row.sessionId,
    tool: row.tool,
    risk: row.risk,
    summary: row.summary,
    prompt: row.prompt,
    input: row.input,
    approvedIds: row.approvedIds as number[],
    keptByUser: row.keptByUser as number[],
    approvedBy: row.approvedBy,
    ok: row.ok,
    result: row.result,
    response: row.response,
    // Deleting a release is destructive; reopening or re-closing issues is a write.
    inverse: inverse ? { label: inverse.label, destructive: inverse.kind === 'release' } : null,
    // A partly failed bulk change can still undo the part that happened.
    undoable: Boolean(inverse) && !row.undoneAt,
    undoneAt: row.undoneAt,
    undoResult: row.undoResult,
    createdAt: row.createdAt,
  };
}
