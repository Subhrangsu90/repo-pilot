import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';
import { refreshableSurfaces, refreshSurface } from '../agent/refresh';
import type { Store } from '../store';
import { ToolError, type Executor, type ToolContext } from '../tools/read-tools';

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  filter: z.enum(['all', 'waiting', 'changes', 'read']).default('all'),
});
const Id = z.object({ id: z.uuid() });
const Rename = z.object({ title: z.string().trim().min(1).max(80) });
const RefreshParams = z.object({ id: z.uuid(), surfaceId: z.string().min(1).max(200) });

/**
 * History (doc §9b): saved sessions. Reopening one replays its stored runs in
 * the client; no model call is made. Deleting keeps its audit entries.
 */
export function registerSessionRoutes(
  app: FastifyInstance,
  store: Store | null,
  opts: {
    onDelete: (id: string) => void;
    /** Read tools for Refresh (re-run without the model). */
    executors: Record<string, Executor<any>>;
    /** The signed-in user (auth/index.ts) and the tool context acting as them. Sessions are per user. */
    who: (req: FastifyRequest) => { login: string; ctx: ToolContext };
  },
) {
  const off = (reply: FastifyReply) =>
    reply.code(503).send({ error: 'History needs the database. Start it with npm run db:up, then restart the server.' });

  app.get('/api/sessions', async (req, reply) => {
    if (!store) return off(reply);
    const query = ListQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'Use ?q=text&filter=all|waiting|changes|read.' });
    return { items: await store.listSessions({ ...query.data, userId: opts.who(req).login }) };
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    if (!store) return off(reply);
    const params = Id.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Not a session id.' });
    const session = await store.getSession(params.data.id, opts.who(req).login);
    if (!session) return reply.code(404).send({ error: 'Session not found.' });
    const thread = await store.loadThread(params.data.id);
    const refreshable = [...refreshableSurfaces(session.runs, thread?.messages ?? [])].map(([surfaceId, s]) => ({
      surfaceId,
      capturedAt: s.capturedAt,
    }));
    return { ...session, refreshable };
  });

  /** Re-runs the read tool behind one surface of a saved session. Nothing is saved. */
  app.post('/api/sessions/:id/surfaces/:surfaceId/refresh', async (req, reply) => {
    if (!store) return off(reply);
    const params = RefreshParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Not a session or surface id.' });
    const { login, ctx } = opts.who(req);
    const [session, thread] = await Promise.all([store.getSession(params.data.id, login), store.loadThread(params.data.id)]);
    if (!session || !thread) return reply.code(404).send({ error: 'Session not found.' });
    const target = refreshableSurfaces(session.runs, thread.messages).get(params.data.surfaceId);
    if (!target) return reply.code(404).send({ error: 'This result cannot be refreshed.' });
    try {
      // Re-run on the session's own repository.
      const node = await refreshSurface(target.call, opts.executors, { ...ctx, repo: session.repo || undefined });
      return { surfaceId: params.data.surfaceId, node, refreshedAt: new Date().toISOString() };
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'refresh failed');
      const message = err instanceof ToolError ? err.message : 'GitHub did not answer. Try again in a moment.';
      return reply.code(502).send({ error: message });
    }
  });

  app.patch('/api/sessions/:id', async (req, reply) => {
    if (!store) return off(reply);
    const params = Id.safeParse(req.params);
    const body = Rename.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Send { title: string } (1-80 characters).' });
    return (await store.renameSession(params.data.id, body.data.title, opts.who(req).login)) ? { ok: true } : reply.code(404).send({ error: 'Session not found.' });
  });

  app.delete('/api/sessions/:id', async (req, reply) => {
    if (!store) return off(reply);
    const params = Id.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Not a session id.' });
    if (!(await store.deleteSession(params.data.id, opts.who(req).login))) return reply.code(404).send({ error: 'Session not found.' });
    opts.onDelete(params.data.id);
    return reply.code(204).send();
  });
}
