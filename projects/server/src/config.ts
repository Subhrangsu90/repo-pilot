import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * Server configuration, validated once at startup. Secrets live only here:
 * they are never sent to the browser or to the model.
 *
 * LLM providers (switchable for the privacy/cost talking point):
 * - gemini: Gemini Flash, free tier, the default for the live demo
 * - claude: Claude Haiku, optional paid alternative
 * - ollama: Gemma running locally through Ollama, no data leaves the laptop
 */
const ConfigSchema = z.object({
  PORT: z.coerce.number().int().default(3000),
  // mock: scripted replies for end-to-end tests (llm/mock.ts), no model at all.
  LLM_PROVIDER: z.enum(['gemini', 'claude', 'ollama', 'mock']).default('gemini'),

  GEMINI_API_KEY: z.string().optional(),
  // Newest Flash models (3.7, 3.8) were overloaded on the free tier when tested on
  // 2026-11-10 (HTTP 503 / timeouts); 3.6 and 3.5 answered in about 2 s. Week 2 retries
  // on GEMINI_FALLBACK_MODEL when the primary returns 503 or times out.
  GEMINI_MODEL: z.string().default('gemini-3.6-flash'),
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-3.5-flash'),

  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default('claude-haiku-5-5'),

  OLLAMA_URL: z.url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('gemma4'),
  // Context window for local models; bounds the memory Ollama reserves for it.
  OLLAMA_NUM_CTX: z.coerce.number().int().min(2048).max(131072).default(8192),

  // Postgres (docker-compose.yml). Optional: without it the server keeps state in memory only.
  DATABASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),

  GITHUB_TOKEN: z.string().optional(),
  // "Sign in with GitHub" (auth/index.ts). All three set → OAuth mode: each user acts with their own
  // token, kept in a sealed httpOnly cookie. Unset → dev mode: everyone acts as GITHUB_TOKEN's owner.
  GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters').optional(),
  // OAuth App scopes: public_repo covers issues, reviews and releases on public repositories.
  GITHUB_OAUTH_SCOPE: z.string().default('public_repo'),
  // Where the browser opens the app; the OAuth callback URL is APP_URL/api/auth/callback.
  APP_URL: z.url().default('http://localhost:4200').transform((u) => u.replace(/\/+$/, '')),
  // End-to-end tests only (see below). Never set it for real use.
  E2E_MODE: z.enum(['0', '1']).default('0').transform((v) => v === '1'),
  GITHUB_REPO_ALLOWLIST: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
    ),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse(process.env);

/** The fake repository E2E_MODE serves (testing/fake-github.ts). */
export const E2E_REPO = 'demo-owner/repopilot-demo';

/**
 * E2E_MODE=1 (Playwright): an in-process fake GitHub, the scripted mock model and
 * no database, whatever .env says, so a test run can never reach the real
 * GitHub API, a real model or the dev database. Adds /api/__test__ endpoints.
 */
if (config.E2E_MODE) {
  Object.assign(config, {
    LLM_PROVIDER: 'mock',
    GITHUB_TOKEN: 'e2e',
    GITHUB_REPO_ALLOWLIST: [E2E_REPO],
    DATABASE_URL: undefined,
    GITHUB_OAUTH_CLIENT_ID: undefined,
    GITHUB_OAUTH_CLIENT_SECRET: undefined,
  });
}
