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
  LLM_PROVIDER: z.enum(['gemini', 'claude', 'ollama']).default('gemini'),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),

  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default('claude-haiku-5-5'),

  OLLAMA_URL: z.url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('gemma3'),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO_ALLOWLIST: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((r) => r.trim()).filter(Boolean)),
});

export type Config = z.infer<typeof ConfigSchema>;

export const config: Config = ConfigSchema.parse(process.env);
