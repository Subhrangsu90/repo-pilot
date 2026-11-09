import Fastify from 'fastify';
import { componentNames } from '@repopilot/shared';
import { config } from './config';

const app = Fastify({ logger: true });

/** Liveness plus a quick view of what is configured (never the secrets). */
app.get('/api/health', async () => ({
  ok: true,
  llm: {
    provider: config.LLM_PROVIDER,
    configured: {
      gemini: Boolean(config.GEMINI_API_KEY),
      claude: Boolean(config.ANTHROPIC_API_KEY),
      ollama: true,
    },
  },
  github: { tokenConfigured: Boolean(config.GITHUB_TOKEN), repos: config.GITHUB_REPO_ALLOWLIST },
  catalog: componentNames,
}));

// Week 2: POST /api/runs, GET /api/runs/:id/events (SSE), POST /api/runs/:id/actions

try {
  await app.listen({ port: config.PORT, host: '127.0.0.1' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
