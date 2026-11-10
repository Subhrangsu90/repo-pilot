import Fastify from 'fastify';
import * as z from 'zod';
import { componentNames, type AgentEvent, type ModelOption } from '@repopilot/shared';
import { config, type Config } from './config';
import { trackFollowups } from './agent/followups';
import { resumeAgent, runAgent, type AgentDeps } from './agent/loop';
import { buildSystemPrompt, buildToolDefs } from './agent/prompt';
import { findPendingByRun, getThread, isTerminal, startRun, subscribe, ThreadBusyError } from './agent/runs';
import { GitHub } from './github/client';
import { createProvider } from './llm';
import { actions } from './tools/actions';
import { executors } from './tools/read-tools';

const app = Fastify({ logger: { level: 'info' } });
const github = new GitHub(config.GITHUB_TOKEN ?? '');
const toolDefs = buildToolDefs();

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
    pullRequests(states: OPEN) { totalCount }
    issues(states: OPEN) { totalCount }
  }
}`;

interface OverviewData {
  viewer: { login: string; avatarUrl: string };
  rateLimit: { limit: number; remaining: number } | null;
  repository: { pullRequests: { totalCount: number }; issues: { totalCount: number } } | null;
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
      rateLimit: d.rateLimit,
      viewer: d.viewer,
    };
  } catch (err) {
    req.log.warn({ err: (err as Error).message }, 'overview failed');
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

function agentDeps(model: ModelOption | undefined, emit: (e: AgentEvent) => void, run: { id: string; signal: AbortSignal }): AgentDeps {
  const provider = createProvider({ ...config, LLM_PROVIDER: providerFor(model) }, (err) =>
    emit({ type: 'STEP_FINISHED', stepId: `${run.id}-fallback`, status: 'error', detail: `${err.message}; trying ${config.GEMINI_FALLBACK_MODEL}` }),
  );
  return {
    provider,
    system: buildSystemPrompt({ allowlist: config.GITHUB_REPO_ALLOWLIST, today: new Date() }),
    tools: toolDefs,
    executors,
    actions,
    ctx: { github, allowlist: config.GITHUB_REPO_ALLOWLIST },
    emit,
    runId: run.id,
    signal: run.signal,
  };
}

app.post('/api/runs', async (req, reply) => {
  const parsed = StartRunBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Send { prompt: string, threadId?: uuid, model?: 'cloud' | 'local' }." });
  }
  if (!config.GITHUB_TOKEN) return reply.code(503).send({ error: 'GITHUB_TOKEN is not set in projects/server/.env.' });
  if (getThread(parsed.data.threadId)?.pending) {
    return reply.code(409).send({ error: 'A change is waiting for your approval. Approve or reject it first.' });
  }

  try {
    const started = startRun(parsed.data.threadId, async (thread, emit, run) => {
      const before = thread.messages.length;
      thread.model = parsed.data.model;
      const followups = trackFollowups(emit);
      try {
        const outcome = await runAgent(thread.messages, parsed.data.prompt, agentDeps(thread.model, followups.emit, run));
        if (outcome.status === 'awaiting-approval') thread.pending = outcome.pending;
        else followups.finish();
      } catch (err) {
        // Drop the half-finished turn so the next prompt starts from a consistent history.
        thread.messages.splice(before);
        req.log.warn({ err: (err as Error).message }, 'run failed');
        throw err;
      }
    });
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
  const { toolCallId, decision, selected } = parsed.data;
  const thread = findPendingByRun(req.params.id);
  const pending = thread?.pending;
  if (!thread || !pending || pending.callId !== toolCallId) {
    return reply.code(404).send({ error: 'No approval is waiting for this run. It may have been answered already.' });
  }
  const approve = decision === 'approve';
  if (approve && pending.ids.length > 0 && !(selected ?? pending.ids).some((id) => pending.ids.includes(id))) {
    return reply.code(400).send({ error: 'Select at least one item to approve.' });
  }

  thread.pending = undefined; // answered exactly once
  try {
    const started = startRun(thread.id, async (t, emit, run) => {
      const followups = trackFollowups(emit);
      const outcome = await resumeAgent(t.messages, pending, { approve, selected }, agentDeps(t.model, followups.emit, run));
      if (outcome.status === 'awaiting-approval') t.pending = outcome.pending;
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
