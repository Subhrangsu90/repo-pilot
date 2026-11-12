import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';
import { GitHubError } from '../github/client';
import { auditSeq, type Store } from '../store';
import { ToolError, type ToolContext } from '../tools/read-tools';
import { inverseRepo, runInverse } from '../tools/undo';

const ListQuery = z.object({ filter: z.enum(['all', 'write', 'destructive', 'undone']).default('all') });

/**
 * The audit log: every approved change, who approved it, what GitHub answered,
 * and Undo for reversible ones. Undo runs the stored inverse directly (the user
 * confirms it in the UI); it never goes through the model.
 */
/** Each user sees the changes they approved, and undoes them with their own GitHub access. */
export function registerAuditRoutes(app: FastifyInstance, store: Store | null, who: (req: FastifyRequest) => { login: string; ctx: ToolContext }) {
  const off = (reply: FastifyReply) =>
    reply.code(503).send({ error: 'The audit log needs the database. Start it with npm run db:up, then restart the server.' });
  /** Undo in progress, so a double click cannot run the inverse twice. */
  const undoing = new Set<number>();

  app.get('/api/audit', async (req, reply) => {
    if (!store) return off(reply);
    const query = ListQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'Use ?filter=all|write|destructive|undone.' });
    return { items: await store.listAudit(query.data.filter, who(req).login) };
  });

  app.get<{ Params: { id: string } }>('/api/audit/:id', async (req, reply) => {
    if (!store) return off(reply);
    const seq = auditSeq(req.params.id);
    const entry = seq === null ? null : await store.getAudit(seq, who(req).login);
    return entry ?? reply.code(404).send({ error: 'Audit entry not found.' });
  });

  app.post<{ Params: { id: string } }>('/api/audit/:id/undo', async (req, reply) => {
    if (!store) return off(reply);
    const { login, ctx } = who(req);
    const seq = auditSeq(req.params.id);
    const entry = seq === null ? null : await store.getAudit(seq, login);
    if (seq === null || !entry) return reply.code(404).send({ error: 'Audit entry not found.' });
    if (entry.undoneAt || undoing.has(seq)) return reply.code(409).send({ error: 'This change was already undone.' });
    const inverse = await store.getInverse(seq);
    if (!inverse) return reply.code(400).send({ error: 'This change cannot be undone from here.' });

    undoing.add(seq);
    try {
      // Undo acts on the repository the change was made in (pinned in the inverse, else its session's).
      const repo = inverseRepo(inverse) ?? (entry.sessionId ? (await store.getSession(entry.sessionId, login))?.repo : undefined);
      if (!repo) return reply.code(400).send({ error: 'This change does not record its repository, so it cannot be undone from here.' });
      const out = await runInverse(inverse, { ...ctx, repo });
      if (!out.ok) return reply.code(502).send({ error: out.result });
      await store.markUndone(seq, out.result);
      req.log.info({ id: entry.id, tool: entry.tool }, 'change undone');
      return await store.getAudit(seq, login);
    } catch (err) {
      const message = err instanceof ToolError || err instanceof GitHubError ? err.message : 'The undo failed.';
      return reply.code(502).send({ error: message.slice(0, 300) });
    } finally {
      undoing.delete(seq);
    }
  });
}
