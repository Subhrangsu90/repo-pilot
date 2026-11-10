import type { FastifyInstance, FastifyReply } from 'fastify';
import * as z from 'zod';
import type { Store } from '../store';

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  filter: z.enum(['all', 'waiting', 'changes', 'read']).default('all'),
});
const Id = z.object({ id: z.uuid() });
const Rename = z.object({ title: z.string().trim().min(1).max(80) });

/**
 * History (doc §9b): saved sessions. Reopening one replays its stored runs in
 * the client; no model call is made. Deleting keeps its audit entries.
 */
export function registerSessionRoutes(app: FastifyInstance, store: Store | null, opts: { onDelete: (id: string) => void }) {
  const off = (reply: FastifyReply) =>
    reply.code(503).send({ error: 'History needs the database. Start it with npm run db:up, then restart the server.' });

  app.get('/api/sessions', async (req, reply) => {
    if (!store) return off(reply);
    const query = ListQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'Use ?q=text&filter=all|waiting|changes|read.' });
    return { items: await store.listSessions(query.data) };
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    if (!store) return off(reply);
    const params = Id.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Not a session id.' });
    const session = await store.getSession(params.data.id);
    return session ?? reply.code(404).send({ error: 'Session not found.' });
  });

  app.patch('/api/sessions/:id', async (req, reply) => {
    if (!store) return off(reply);
    const params = Id.safeParse(req.params);
    const body = Rename.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Send { title: string } (1-80 characters).' });
    return (await store.renameSession(params.data.id, body.data.title)) ? { ok: true } : reply.code(404).send({ error: 'Session not found.' });
  });

  app.delete('/api/sessions/:id', async (req, reply) => {
    if (!store) return off(reply);
    const params = Id.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Not a session id.' });
    if (!(await store.deleteSession(params.data.id))) return reply.code(404).send({ error: 'Session not found.' });
    opts.onDelete(params.data.id);
    return reply.code(204).send();
  });
}
