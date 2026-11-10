import Fastify from 'fastify';
import * as z from 'zod';
import { componentNames, type AgentEvent, type ModelOption } from '@repopilot/shared';
import { config, type Config } from './config';
import { runAgent } from './agent/loop';
import { buildSystemPrompt, buildToolDefs } from './agent/prompt';
import { isTerminal, startRun, subscribe, ThreadBusyError } from './agent/runs';
import { GitHub } from './github/client';
import { createProvider } from './llm';
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

app.post('/api/runs', async (req, reply) => {
  const parsed = StartRunBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Send { prompt: string, threadId?: uuid, model?: 'cloud' | 'local' }." });
  }
  if (!config.GITHUB_TOKEN) return reply.code(503).send({ error: 'GITHUB_TOKEN is not set in projects/server/.env.' });

  try {
    const started = startRun(parsed.data.threadId, async (thread, emit, run) => {
      const before = thread.length;
      try {
        const provider = createProvider({ ...config, LLM_PROVIDER: providerFor(parsed.data.model) }, (err) =>
          emit({ type: 'STEP_FINISHED', stepId: `${run.id}-fallback`, status: 'error', detail: `${err.message}; trying ${config.GEMINI_FALLBACK_MODEL}` }),
        );
        await runAgent(thread, parsed.data.prompt, {
          provider,
          system: buildSystemPrompt({ allowlist: config.GITHUB_REPO_ALLOWLIST, today: new Date() }),
          tools: toolDefs,
          executors,
          ctx: { github, allowlist: config.GITHUB_REPO_ALLOWLIST },
          emit,
          runId: run.id,
          signal: run.signal,
        });
      } catch (err) {
        // Drop the half-finished turn so the next prompt starts from a consistent history.
        thread.splice(before);
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
