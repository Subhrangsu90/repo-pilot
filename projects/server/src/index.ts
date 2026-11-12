import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import * as z from 'zod';
import { componentNames, type AgentEvent, type ModelOption } from '@repopilot/shared';
import { config, type Config } from './config';
import { createAuth } from './auth';
import { trackFollowups } from './agent/followups';
import { resumeAgent, runAgent, type AgentDeps } from './agent/loop';
import { buildSystemPrompt, buildToolDefs } from './agent/prompt';
import { readOnlyTools, sideHistory } from './agent/side';
import {
  dropThread,
  findPendingByRun,
  getThread,
  isTerminal,
  onRunFinished,
  restoreThread,
  runOwner,
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
import { executors, REPO_PATTERN, resolveRepo, runListIssues, runListPullRequests, ToolError, type ToolContext } from './tools/read-tools';
import { pinRepo } from './tools/undo';
import { GitHubError } from './github/client';

const app = Fastify({ logger: { level: 'info' } });
const github = new GitHub(config.GITHUB_TOKEN ?? '');
const toolDefs = buildToolDefs();

/** Sign in with GitHub (OAuth mode), or everyone acts as GITHUB_TOKEN's owner (dev mode). */
const auth = createAuth({
  clientId: config.GITHUB_OAUTH_CLIENT_ID,
  clientSecret: config.GITHUB_OAUTH_CLIENT_SECRET,
  sessionSecret: config.SESSION_SECRET,
  appUrl: config.APP_URL,
  scope: config.GITHUB_OAUTH_SCOPE,
  tokenGithub: github,
});
auth.register(app);
app.log.info(`auth: ${auth.mode === 'oauth' ? 'Sign in with GitHub' : 'dev mode, acting as the GITHUB_TOKEN owner'}`);

/** The user of a request and a tool context that acts with their GitHub access. */
function who(req: FastifyRequest): { login: string; ctx: ToolContext } {
  const user = auth.userOf(req);
  return { login: user.login, ctx: { github: user.github } };
}

/** `?repo=owner/name` (the repository picked in the app), or null when missing or malformed. */
function repoParam(req: FastifyRequest): string | null {
  const repo = (req.query as { repo?: unknown } | undefined)?.repo;
  return typeof repo === 'string' && REPO_PATTERN.test(repo) ? repo : null;
}

const NO_REPO = 'Pick a repository first (?repo=owner/name).';

/** GitHub refused or failed: "no access" for 403/404, otherwise "did not answer". */
function githubFailure(req: FastifyRequest, reply: FastifyReply, err: unknown, what: string) {
  req.log.warn({ err: (err as Error).message }, `${what} failed`);
  if (err instanceof GitHubError && (err.status === 404 || err.status === 403)) {
    return reply.code(404).send({ error: 'Repository not found, or your GitHub account has no access to it.' });
  }
  if (err instanceof ToolError) return reply.code(400).send({ error: err.message });
  return reply.code(502).send({ error: 'GitHub did not answer.' });
}

/** GitHub can be called: a signed-in user's token (OAuth) or GITHUB_TOKEN (dev). */
const githubReady = auth.mode === 'oauth' || Boolean(config.GITHUB_TOKEN);
const NO_GITHUB = 'GITHUB_TOKEN is not set in projects/server/.env (or configure GitHub OAuth).';

/** Postgres (sessions, runs, audit log). Without it the server still runs, in memory only. */
async function connectStore(): Promise<Store | null> {
  if (!config.DATABASE_URL) {
    app.log.warn('DATABASE_URL is not set: sessions and the audit log stay in memory only.');
    return null;
  }
  try {
    const { db } = await openDb(config.DATABASE_URL);
    app.log.info('Postgres connected; migrations applied.');
    return new Store(db, (msg, err) =>
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

registerSessionRoutes(app, store, { onDelete: dropThread, executors, who });
registerAuditRoutes(app, store, who);

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
  github: { tokenConfigured: Boolean(config.GITHUB_TOKEN) },
  auth: auth.mode,
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
  if (!githubReady) return reply.code(503).send({ error: NO_GITHUB });
  const full = repoParam(req);
  if (!full) return reply.code(400).send({ error: NO_REPO });
  const [owner, name] = full.split('/');
  try {
    const d = await who(req).ctx.github.graphql<OverviewData>(OVERVIEW_QUERY, { owner, name });
    return {
      repo: full,
      openPullRequests: d.repository?.pullRequests.totalCount ?? null,
      openIssues: d.repository?.issues.totalCount ?? null,
      latestRelease: d.repository?.latestRelease?.tagName ?? null,
      rateLimit: d.rateLimit,
      viewer: d.viewer,
    };
  } catch (err) {
    return githubFailure(req, reply, err, 'overview');
  }
});

interface RepoJson {
  full_name: string;
  private: boolean;
  description: string | null;
  pushed_at: string | null;
  archived: boolean;
  permissions?: { push?: boolean };
}

/**
 * The repository picker: every repository the signed-in user can access (owned,
 * collaborator, organization), most recently pushed first. Private ones need the
 * `repo` OAuth scope (GITHUB_OAUTH_SCOPE).
 */
interface GitHubUserJson {
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
  company: string | null;
  location: string | null;
  bio: string | null;
  public_repos: number;
  total_private_repos?: number;
  created_at: string;
}

/**
 * The profile page: who you are on GitHub, how RepoPilot reaches GitHub for you
 * (sign-in mode, the scopes GitHub granted, where to revoke access) and how much
 * you have done here. Never the token.
 */
app.get('/api/profile', async (req, reply) => {
  if (!githubReady) return reply.code(503).send({ error: NO_GITHUB });
  const { login, ctx } = who(req);
  try {
    const [{ user, scopes }, counts] = await Promise.all([
      ctx.github.me<GitHubUserJson>(),
      store ? store.countsFor(login).catch(() => null) : Promise.resolve(null),
    ]);
    return {
      user: {
        login: user.login,
        name: user.name,
        avatarUrl: user.avatar_url,
        url: user.html_url,
        company: user.company,
        location: user.location,
        bio: user.bio?.slice(0, 300) ?? null,
        publicRepos: user.public_repos,
        privateRepos: user.total_private_repos ?? null,
        createdAt: user.created_at,
      },
      access: {
        mode: auth.mode,
        // OAuth: what GitHub granted (may be less than requested). Dev mode: a fine-grained token has no scopes.
        scopes,
        requestedScope: auth.mode === 'oauth' ? config.GITHUB_OAUTH_SCOPE : null,
        manageUrl:
          auth.mode === 'oauth'
            ? `https://github.com/settings/connections/applications/${config.GITHUB_OAUTH_CLIENT_ID}`
            : 'https://github.com/settings/personal-access-tokens',
      },
      // null without the database (History and the Audit log are off then).
      activity: counts,
    };
  } catch (err) {
    return githubFailure(req, reply, err, 'profile');
  }
});

app.get('/api/repos', async (req, reply) => {
  if (!githubReady) return reply.code(503).send({ error: NO_GITHUB });
  try {
    const params = 'per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member';
    const repos = await who(req).ctx.github.rest<RepoJson[]>(`/user/repos?${params}`);
    return {
      items: repos
        .filter((r) => !r.archived)
        .map((r) => ({ full: r.full_name, private: r.private, description: r.description?.slice(0, 200) ?? null, pushedAt: r.pushed_at, canWrite: r.permissions?.push ?? false })),
    };
  } catch (err) {
    return githubFailure(req, reply, err, 'repo list');
  }
});

/** The Pull requests page: open PRs of the selected repo, as PrCard props. */
app.get('/api/pulls', async (req, reply) => {
  if (!githubReady) return reply.code(503).send({ error: NO_GITHUB });
  const repo = repoParam(req);
  if (!repo) return reply.code(400).send({ error: NO_REPO });
  try {
    const out = await runListPullRequests({ state: 'open', limit: 50 }, { ...who(req).ctx, repo });
    return { repo, items: (out.ui?.props as { items: unknown[] }).items };
  } catch (err) {
    return githubFailure(req, reply, err, 'pull list');
  }
});

const IssuesQuery = z.object({ state: z.enum(['open', 'closed', 'all']).default('open'), repo: z.string().optional() });
const ISSUE_LIMIT = 100;

/**
 * The Issues page: issues of the default repo as IssueTable rows (validated and
 * injection-flagged like the agent's list_issues, which this reuses). Labels
 * are filtered in the browser. Changes go through the agent and its approval card.
 */
app.get('/api/issues', async (req, reply) => {
  const query = IssuesQuery.safeParse(req.query);
  if (!query.success) return reply.code(400).send({ error: 'state must be open, closed or all.' });
  if (!githubReady) return reply.code(503).send({ error: NO_GITHUB });
  const repo = repoParam(req);
  if (!repo) return reply.code(400).send({ error: NO_REPO });
  try {
    const out = await runListIssues({ state: query.data.state, labels: [], limit: ISSUE_LIMIT }, { ...who(req).ctx, repo });
    const rows = (out.ui?.props as { rows: unknown[] }).rows;
    return { repo, rows, truncated: rows.length === ISSUE_LIMIT };
  } catch (err) {
    return githubFailure(req, reply, err, 'issue list');
  }
});

/** The PR review page header: one pull request without its diff. */
app.get<{ Params: { number: string } }>('/api/pulls/:number', async (req, reply) => {
  const number = Number(req.params.number);
  if (!Number.isInteger(number) || number < 1) return reply.code(400).send({ error: 'Not a pull request number.' });
  if (!githubReady) return reply.code(503).send({ error: NO_GITHUB });
  const repo = repoParam(req);
  if (!repo) return reply.code(400).send({ error: NO_REPO });
  try {
    const ctx = { ...who(req).ctx, repo };
    const pr = await fetchPullRequest(ctx, resolveRepo(undefined, ctx), number, { files: false });
    if (!pr) return reply.code(404).send({ error: `Pull request #${number} was not found.` });
    return pr.info;
  } catch (err) {
    return githubFailure(req, reply, err, 'pull request');
  }
});

const StartRunBody = z.object({
  prompt: z.string().trim().min(1).max(2000),
  threadId: z.uuid().optional(),
  model: z.enum(['cloud', 'local']).optional(),
  reviewPullRequest: z.number().int().positive().optional(),
  /** The repository picked in the app; a conversation stays on the repo it started with. */
  repo: z.string().regex(REPO_PATTERN, 'Use owner/name').optional(),
});

/** The UI's Cloud / Local switch. Cloud keeps a configured cloud provider, else Gemini. */
function providerFor(model: ModelOption | undefined): Config['LLM_PROVIDER'] {
  if (model === 'local') return 'ollama';
  if (model === 'cloud') return config.LLM_PROVIDER === 'ollama' ? 'gemini' : config.LLM_PROVIDER;
  return config.LLM_PROVIDER;
}

function agentDeps(
  user: { login: string; ctx: ToolContext },
  threadId: string,
  model: ModelOption | undefined,
  emit: (e: AgentEvent) => void,
  run: { id: string; signal: AbortSignal },
  reviewPullRequest?: number,
): AgentDeps {
  const provider = createProvider({ ...config, LLM_PROVIDER: providerFor(model) }, (err) =>
    emit({ type: 'STEP_FINISHED', stepId: `${run.id}-fallback`, status: 'error', detail: `${err.message}; trying ${config.GEMINI_FALLBACK_MODEL}` }),
  );
  return {
    provider,
    system: buildSystemPrompt({ repo: user.ctx.repo, today: new Date() }),
    tools: toolDefs,
    executors,
    actions,
    ctx: user.ctx,
    emit,
    runId: run.id,
    signal: run.signal,
    reviewPullRequest,
    // The audit log records who approved each change.
    onExecuted: store
      ? async (change) =>
          void (await store.recordAudit(threadId, {
            ...change,
            approver: user.login,
            repo: user.ctx.repo ?? '',
            // Undo must act on the repo the change was made in, whatever is selected later.
            inverse: change.inverse && user.ctx.repo ? pinRepo(change.inverse, user.ctx.repo) : change.inverse,
          }))
      : undefined,
  };
}

app.post('/api/runs', async (req, reply) => {
  const parsed = StartRunBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Send { prompt: string, threadId?: uuid, model?: 'cloud' | 'local' }." });
  }
  if (!githubReady) return reply.code(503).send({ error: NO_GITHUB });
  const me = who(req);
  await ensureThread(parsed.data.threadId);
  const existing = getThread(parsed.data.threadId);
  // Only the person who started a conversation may continue it.
  if (existing?.owner && existing.owner !== me.login) return reply.code(404).send({ error: 'Conversation not found.' });
  // A conversation stays on its repository; another repo means a new chat.
  const repo = existing?.repo ?? parsed.data.repo;
  if (!repo) return reply.code(400).send({ error: 'Pick a repository first.' });
  if (existing?.repo && parsed.data.repo && existing.repo.toLowerCase() !== parsed.data.repo.toLowerCase()) {
    return reply.code(409).send({ error: `This conversation is about ${existing.repo}. Start a new chat to work on ${parsed.data.repo}.` });
  }
  const user = { login: me.login, ctx: { ...me.ctx, repo } };
  const waiting = existing?.pending;
  if (waiting) {
    // A side question: read and client tools only, on a copy of the conversation (agent/side.ts).
    try {
      const started = startRun(parsed.data.threadId, async (thread, emit, run) => {
        const deps = agentDeps(user, thread.id, thread.model, emit, run);
        await runAgent(sideHistory(thread.messages, waiting), parsed.data.prompt, { ...deps, tools: readOnlyTools(deps.tools), actions: {}, readOnly: true });
      }, { prompt: parsed.data.prompt, owner: user.login, repo });
      return reply.code(202).send(started);
    } catch (err) {
      if (err instanceof ThreadBusyError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  }

  try {
    const started = startRun(parsed.data.threadId, async (thread, emit, run) => {
      const before = thread.messages.length;
      thread.model = parsed.data.model;
      const followups = trackFollowups(emit);
      try {
        const outcome = await runAgent(thread.messages, parsed.data.prompt, agentDeps(user, thread.id, thread.model, followups.emit, run, parsed.data.reviewPullRequest));
        if (outcome.status === 'awaiting-approval') thread.pending = { ...outcome.pending, prompt: parsed.data.prompt };
        else followups.finish();
      } catch (err) {
        // Drop the half-finished turn so the next prompt starts from a consistent history.
        thread.messages.splice(before);
        req.log.warn({ err: (err as Error).message }, 'run failed');
        throw err;
      }
    }, { prompt: parsed.data.prompt, owner: user.login, repo });
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
 * once, and only by the person who started the conversation.
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
  const me = who(req);
  // The change runs on the conversation's repository, whatever is selected in the app now.
  const user = { login: me.login, ctx: { ...me.ctx, repo: thread?.repo } };
  const pending = thread?.pending;
  if (!thread || !pending || pending.callId !== toolCallId || (thread.owner && thread.owner !== user.login)) {
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
      const outcome = await resumeAgent(t.messages, pending, { approve, selected, edits }, agentDeps(user, t.id, t.model, followups.emit, run));
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

  // Only the conversation's owner may watch its runs.
  const owner = runOwner(req.params.id);
  unsubscribe = owner && owner !== who(req).login ? null : subscribe(req.params.id, send);
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
