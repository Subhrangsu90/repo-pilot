import Fastify from 'fastify';
import * as z from 'zod';
import { componentNames, type AgentEvent, type ModelOption } from '@repopilot/shared';
import { config, type Config } from './config';
import { trackFollowups } from './agent/followups';
import { resumeAgent, runAgent, type AgentDeps } from './agent/loop';
import { buildSystemPrompt, buildToolDefs } from './agent/prompt';
import {
  dropThread,
  findPendingByRun,
  getThread,
  isTerminal,
  onRunFinished,
  restoreThread,
  startRun,
  subscribe,
  ThreadBusyError,
} from './agent/runs';
import { openDb } from './db/client';
import { registerAuditRoutes } from './routes/audit';
import { registerSessionRoutes } from './routes/sessions';
import { Store } from './store';
import { GitHub } from './github/client';
import { createProvider } from './llm';
import { fetchPullRequest } from './github/pulls';
import { actions } from './tools/actions';
import { executors, resolveRepo, runListPullRequests, type ToolContext } from './tools/read-tools';

const app = Fastify({ logger: { level: 'info' } });
const github = new GitHub(config.GITHUB_TOKEN ?? '');
const toolCtx: ToolContext = { github, allowlist: config.GITHUB_REPO_ALLOWLIST };
const toolDefs = buildToolDefs();

/** Postgres (sessions, runs, audit log). Without it the server still runs, in memory only. */
async function connectStore(): Promise<Store | null> {
  if (!config.DATABASE_URL) {
    app.log.warn('DATABASE_URL is not set: sessions and the audit log stay in memory only.');
    return null;
  }
  try {
    const { db } = await openDb(config.DATABASE_URL);
    app.log.info('Postgres connected; migrations applied.');
    return new Store(db, { login: () => github.login(), repo: config.GITHUB_REPO_ALLOWLIST[0] ?? '' }, (msg, err) =>
      app.log.error({ err: (err as Error).message }, msg),
    );
  } catch (err) {
    app.log.error({ err: (err as Error).message }, 'Postgres is not reachable; running without it. Start it with npm run db:up.');
    return null;
  }
}

const store = await connectStore();
if (store) onRunFinished((run, thread) => void store.saveRun(run, thread));

/** Brings a conversation back from the database when it is not in memory (e.g. after a restart). */
async function ensureThread(id: string | undefined) {
  if (!id || getThread(id) || !store) return;
  const data = await store.loadThread(id).catch(() => null);
  if (data) restoreThread(data);
}

registerSessionRoutes(app, store, { onDelete: dropThread });
registerAuditRoutes(app, store, toolCtx);

/** Liveness plus a quick view of what is configured (never the secrets). */
app.get('/api/health', async () => ({
  ok: true,
  llm: {
    provider: config.LLM_PROVIDER,
    model: config.LLM_PROVIDER === 'ollama' ? config.OLLAMA_MODEL : config.GEMINI_MODEL,
    configured: {
      gemini: Boolean(config.GEMINI_API_KEY),
      claude: Boolean(config.ANTHROPIC_API_KEY),
      ollama: true,
    },
  },
  github: { tokenConfigured: Boolean(config.GITHUB_TOKEN), repos: config.GITHUB_REPO_ALLOWLIST },
  catalog: componentNames,
}));

const OVERVIEW_QUERY = `
query ($owner: String!, $name: String!) {
  viewer { login avatarUrl(size: 64) }
  rateLimit { limit remaining }
  repository(owner: $owner, name: $name) {
    latestRelease { tagName }
    pullRequests(states: OPEN) { totalCount }
    issues(states: OPEN) { totalCount }
  }
}`;

interface OverviewData {
  viewer: { login: string; avatarUrl: string };
  rateLimit: { limit: number; remaining: number } | null;
  repository: { latestRelease: { tagName: string } | null; pullRequests: { totalCount: number }; issues: { totalCount: number } } | null;
}

/**
 * The app chrome's live data (Screen Spec: side-nav counts, Ask top bar): open
 * PR and issue counts for the default repo, the GitHub API quota left this hour,
 * and who the token belongs to. No secrets.
 */
app.get('/api/overview', async (req, reply) => {
  const full = config.GITHUB_REPO_ALLOWLIST[0];
  if (!config.GITHUB_TOKEN || !full) return reply.code(503).send({ error: 'GITHUB_TOKEN or GITHUB_REPO_ALLOWLIST is not set.' });
  const [owner, name] = full.split('/');
  try {
    const d = await github.graphql<OverviewData>(OVERVIEW_QUERY, { owner, name });
    return {
      repo: full,
      openPullRequests: d.repository?.pullRequests.totalCount ?? null,
      openIssues: d.repository?.issues.totalCount ?? null,
      latestRelease: d.repository?.latestRelease?.tagName ?? null,
      rateLimit: d.rateLimit,
      viewer: d.viewer,
    };
  } catch (err) {
    req.log.warn({ err: (err as Error).message }, 'overview failed');
    return reply.code(502).send({ error: 'GitHub did not answer.' });
  }
});

/** The Pull requests page: open PRs of the default repo, as PrCard props. */
app.get('/api/pulls', async (req, reply) => {
  if (!config.GITHUB_TOKEN) return reply.code(503).send({ error: 'GITHUB_TOKEN is not set.' });
  try {
    const out = await runListPullRequests({ state: 'open', limit: 50 }, toolCtx);
    return { repo: config.GITHUB_REPO_ALLOWLIST[0], items: (out.ui?.props as { items: unknown[] }).items };
  } catch (err) {
    req.log.warn({ err: (err as Error).message }, 'pull list failed');
    return reply.code(502).send({ error: 'GitHub did not answer.' });
  }
});

/** The PR review page header: one pull request without its diff. */
app.get<{ Params: { number: string } }>('/api/pulls/:number', async (req, reply) => {
  const number = Number(req.params.number);
  if (!Number.isInteger(number) || number < 1) return reply.code(400).send({ error: 'Not a pull request number.' });
  if (!config.GITHUB_TOKEN) return reply.code(503).send({ error: 'GITHUB_TOKEN is not set.' });
  try {
    const pr = await fetchPullRequest(toolCtx, resolveRepo(undefined, toolCtx), number, { files: false });
    if (!pr) return reply.code(404).send({ error: `Pull request #${number} was not found.` });
    return pr.info;
  } catch (err) {
    req.log.warn({ err: (err as Error).message }, 'pull request failed');
    return reply.code(502).send({ error: 'GitHub did not answer.' });
  }
});

const StartRunBody = z.object({
  prompt: z.string().trim().min(1).max(2000),
  threadId: z.uuid().optional(),
  model: z.enum(['cloud', 'local']).optional(),
});

/** The UI's Cloud / Local switch. Cloud keeps a configured cloud provider, else Gemini. */
function providerFor(model: ModelOption | undefined): Config['LLM_PROVIDER'] {
  if (model === 'local') return 'ollama';
  if (model === 'cloud') return config.LLM_PROVIDER === 'ollama' ? 'gemini' : config.LLM_PROVIDER;
  return config.LLM_PROVIDER;
}

function agentDeps(
  threadId: string,
  model: ModelOption | undefined,
  emit: (e: AgentEvent) => void,
  run: { id: string; signal: AbortSignal },
): AgentDeps {
  const provider = createProvider({ ...config, LLM_PROVIDER: providerFor(model) }, (err) =>
    emit({ type: 'STEP_FINISHED', stepId: `${run.id}-fallback`, status: 'error', detail: `${err.message}; trying ${config.GEMINI_FALLBACK_MODEL}` }),
  );
  return {
    provider,
    system: buildSystemPrompt({ allowlist: config.GITHUB_REPO_ALLOWLIST, today: new Date() }),
    tools: toolDefs,
    executors,
    actions,
    ctx: toolCtx,
    emit,
    runId: run.id,
    signal: run.signal,
    onExecuted: store ? async (change) => void (await store.recordAudit(threadId, change)) : undefined,
  };
}

app.post('/api/runs', async (req, reply) => {
  const parsed = StartRunBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Send { prompt: string, threadId?: uuid, model?: 'cloud' | 'local' }." });
  }
  if (!config.GITHUB_TOKEN) return reply.code(503).send({ error: 'GITHUB_TOKEN is not set in projects/server/.env.' });
  await ensureThread(parsed.data.threadId);
  if (getThread(parsed.data.threadId)?.pending) {
    return reply.code(409).send({ error: 'A change is waiting for your approval. Approve or reject it first.' });
  }

  try {
    const started = startRun(parsed.data.threadId, async (thread, emit, run) => {
      const before = thread.messages.length;
      thread.model = parsed.data.model;
      const followups = trackFollowups(emit);
      try {
        const outcome = await runAgent(thread.messages, parsed.data.prompt, agentDeps(thread.id, thread.model, followups.emit, run));
        if (outcome.status === 'awaiting-approval') thread.pending = { ...outcome.pending, prompt: parsed.data.prompt };
        else followups.finish();
      } catch (err) {
        // Drop the half-finished turn so the next prompt starts from a consistent history.
        thread.messages.splice(before);
        req.log.warn({ err: (err as Error).message }, 'run failed');
        throw err;
      }
    }, { prompt: parsed.data.prompt });
    return reply.code(202).send(started);
  } catch (err) {
    if (err instanceof ThreadBusyError) return reply.code(409).send({ error: err.message });
    throw err;
  }
});

const ActionBody = z.object({
  toolCallId: z.string().min(1).max(100),
  decision: z.enum(['approve', 'reject']),
  selected: z.array(z.number().int().positive()).max(100).optional(),
  // Shape-checked by the tool's own schema in the loop; only the size is limited here.
  edits: z.unknown().refine((v) => v === undefined || JSON.stringify(v).length <= 40_000, 'edits too large').optional(),
});

/**
 * The user's answer to an ApprovalCard. Starts a new run on the same thread
 * that carries out the decision and lets the model summarise it; the client
 * streams it with GET /api/runs/:newRunId/events. Each approval can be answered
 * once. (Run ids are random UUIDs and the body must be JSON; owner checks
 * arrive with OAuth in week 4.)
 */
app.post<{ Params: { id: string } }>('/api/runs/:id/actions', async (req, reply) => {
  const parsed = ActionBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Send { toolCallId: string, decision: 'approve' | 'reject', selected?: number[] }." });
  }
  const { toolCallId, decision, selected, edits } = parsed.data;
  let thread = findPendingByRun(req.params.id);
  if (!thread && store) {
    // After a restart the paused run lives only in the database.
    await ensureThread((await store.findSessionPendingOnRun(req.params.id).catch(() => null)) ?? undefined);
    thread = findPendingByRun(req.params.id);
  }
  const pending = thread?.pending;
  if (!thread || !pending || pending.callId !== toolCallId) {
    return reply.code(404).send({ error: 'No approval is waiting for this run. It may have been answered already.' });
  }
  const approve = decision === 'approve';
  if (approve && !pending.allowEmpty && pending.ids.length > 0 && !(selected ?? pending.ids).some((id) => pending.ids.includes(id))) {
    return reply.code(400).send({ error: 'Select at least one item to approve.' });
  }

  thread.pending = undefined; // answered exactly once
  try {
    const started = startRun(thread.id, async (t, emit, run) => {
      const followups = trackFollowups(emit);
      const outcome = await resumeAgent(t.messages, pending, { approve, selected, edits }, agentDeps(t.id, t.model, followups.emit, run));
      if (outcome.status === 'awaiting-approval') t.pending = { ...outcome.pending, prompt: pending.prompt };
      else followups.finish();
    });
    req.log.info({ tool: pending.tool, decision, selected: selected?.length }, 'approval answered');
    return reply.code(202).send(started);
  } catch (err) {
    thread.pending = pending;
    if (err instanceof ThreadBusyError) return reply.code(409).send({ error: err.message });
    throw err;
  }
});

/** Server-Sent Events: one `data:` line per AgentEvent; closes after RUN_FINISHED / RUN_ERROR. */
app.get<{ Params: { id: string } }>('/api/runs/:id/events', (req, reply) => {
  const send = (event: AgentEvent) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    if (isTerminal(event)) close();
  };

  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let unsubscribe: (() => void) | null = null;
  const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);
  function close() {
    clearInterval(heartbeat);
    unsubscribe?.();
    if (!reply.raw.writableEnded) reply.raw.end();
  }
  req.raw.on('close', close);

  unsubscribe = subscribe(req.params.id, send);
  if (!unsubscribe) {
    send({ type: 'RUN_ERROR', message: 'Unknown or expired run.', code: 'not_found' });
  }
});

try {
  await app.listen({ port: config.PORT, host: '127.0.0.1' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
