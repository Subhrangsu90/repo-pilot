/**
 * Setup doctor: `npm run check -w @repopilot/server`.
 * Calls each configured provider with the configured credentials and prints
 * only status codes and non-secret facts. Never prints a key or token.
 */
import { config } from './config';
import { resolveModel } from './llm/ollama';

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
const report = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

async function checkGemini() {
  if (!config.GEMINI_API_KEY) return report('Gemini', false, 'GEMINI_API_KEY is empty');
  const headers = { 'x-goog-api-key': config.GEMINI_API_KEY };
  const base = 'https://generativelanguage.googleapis.com/v1beta';

  const list = await fetch(`${base}/models?pageSize=200`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!list.ok) return report('Gemini', false, `listing models failed: HTTP ${list.status}`);
  const { models = [] } = (await list.json()) as { models?: { name: string }[] };
  const available = new Set(models.map((m) => m.name.replace('models/', '')));
  const flash = [...available].filter((n) => n.includes('flash'));

  // Primary and fallback are both checked: the demo works if either answers.
  const tries: [string, string][] = [
    ['Gemini model', config.GEMINI_MODEL],
    ['Gemini fallback', config.GEMINI_FALLBACK_MODEL],
  ];
  for (const [label, model] of tries) {
    if (!available.has(model)) {
      report(label, false, `"${model}" not found. Flash models: ${flash.join(', ')}`);
      continue;
    }
    const started = Date.now();
    try {
      const gen = await fetch(`${base}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with the single word OK.' }] }] }),
        signal: AbortSignal.timeout(30_000),
      });
      const ms = Date.now() - started;
      if (!gen.ok) {
        const hint = gen.status === 503 ? ' (overloaded; try an older Flash model)' : gen.status === 429 ? ' (free-tier rate limit)' : '';
        report(label, false, `${model}: HTTP ${gen.status}${hint}`);
        continue;
      }
      report(label, true, `${model} answered in ${ms} ms`);
    } catch {
      report(label, false, `${model}: no answer within 30 s (overloaded)`);
    }
  }
}

async function checkClaude() {
  if (!config.ANTHROPIC_API_KEY) return report('Claude', true, 'not configured (optional)');
  const res = await fetch('https://api.anthropic.com/v1/models', {
    headers: { 'x-api-key': config.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
  });
  report('Claude', res.ok, res.ok ? 'key accepted' : `HTTP ${res.status}`);
}

async function checkOllama() {
  try {
    // Same resolution the provider uses, so "available" here means it will work there.
    const model = await resolveModel(config.OLLAMA_URL, config.OLLAMA_MODEL);
    report('Ollama', true, `${config.OLLAMA_MODEL} -> ${model}`);
  } catch (err) {
    report('Ollama', false, `${(err as Error).message} (optional; needed only for the local model)`);
  }
}

async function checkGitHub() {
  if (!config.GITHUB_TOKEN) return report('GitHub', false, 'GITHUB_TOKEN is empty');
  const headers = {
    authorization: `Bearer ${config.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'repopilot-check',
  };
  const gh = (path: string) => fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(15_000) });

  const user = await gh('/user');
  if (!user.ok) return report('GitHub', false, `token rejected: HTTP ${user.status}`);
  const { login } = (await user.json()) as { login: string };
  const expiry = user.headers.get('github-authentication-token-expiration');
  report('GitHub token', true, `authenticated as ${login}${expiry ? `, expires ${expiry}` : ''}, rate limit left ${user.headers.get('x-ratelimit-remaining')}`);

  // The repositories the app's picker will list for the token owner (dev mode).
  const repos = await gh('/user/repos?per_page=100&affiliation=owner,collaborator,organization_member');
  if (!repos.ok) return report('GitHub repos', false, `HTTP ${repos.status}: cannot list repositories`);
  const list = (await repos.json()) as { private: boolean }[];
  const priv = list.filter((r) => r.private).length;
  report('GitHub repos', list.length > 0, list.length ? `${list.length} visible (${priv} private)` : 'the token can see no repositories');

  const oauth = [config.GITHUB_OAUTH_CLIENT_ID, config.GITHUB_OAUTH_CLIENT_SECRET, config.SESSION_SECRET].filter(Boolean).length;
  report('GitHub sign-in', oauth === 0 || oauth === 3, oauth === 3 ? `OAuth on, scope ${config.GITHUB_OAUTH_SCOPE}` : oauth === 0 ? 'off (dev mode)' : 'set all of GITHUB_OAUTH_CLIENT_ID, _SECRET and SESSION_SECRET, or none');
}

await Promise.allSettled([checkGemini(), checkClaude(), checkOllama(), checkGitHub()]).then((settled) => {
  for (const s of settled) if (s.status === 'rejected') report('error', false, String(s.reason).replaceAll(config.GITHUB_TOKEN ?? '\0', '***'));
});

console.log(`\nLLM_PROVIDER = ${config.LLM_PROVIDER}\n`);
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.name.padEnd(24)} ${r.detail}`);
// Optional providers and a single failing Gemini model (when the other answers) do not fail the check.
const gemini = results.filter((r) => r.name.startsWith('Gemini'));
const geminiOk = gemini.some((r) => r.ok);
process.exitCode = results.some((r) => !r.ok && !r.name.startsWith('Ollama') && !(r.name.startsWith('Gemini') && geminiOk)) ? 1 : 0;
