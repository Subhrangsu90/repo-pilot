# RepoPilot

Manage GitHub in plain English; an AI agent answers with validated, interactive UI
components instead of chat text. Interview POC for Generative UI + Agentic UI.
Full design: [docs/project-documentation.md](docs/project-documentation.md).

## Layout (npm workspaces)

| Path | What | Run |
| --- | --- | --- |
| `projects/web` | Angular 22 app (`@repopilot/web`) | `npm run dev:web` → `http://localhost:4200` |
| `projects/server` | Node agent server, Fastify + tsx (`@repopilot/server`) | `npm run dev:server` → `http://localhost:3000/api/health` |
| `projects/shared` | Contract shared by both (`@repopilot/shared`): Zod catalog, `validateNode`, prompt doc, fixtures | `npm test -w @repopilot/shared` |

`@repopilot/shared` exports TypeScript source (no build step). The web app resolves it
through a `paths` entry in `projects/web/tsconfig.json`; the server runs it through tsx.

Root scripts: `npm test` (all workspaces), `npm run build`, `npm run typecheck`.

## Demo repository (`Subhrangsu90/repopilot-demo`)

- `npm run check -w @repopilot/server` – verifies Gemini (primary + fallback), Ollama, Claude and
  the GitHub token/permissions. Prints status only, never secrets.
- `npm run seed:demo -w @repopilot/server [-- --yes]` – seeds the demo repo from
  `projects/server/src/seed-demo-content.ts`. Dry run without `--yes`. Idempotent: once the
  `v1.0.0` release exists it only creates missing files and never replays history over later
  commits. Content is planted for the demo: #8 is a prompt-injection issue (must be treated as
  data), PR #15 has 3 deliberate review bugs (unnormalised rate-limit key, `>` off-by-one,
  password logged), PR #14 is merged (undo demo), #16 draft, #17 open.
- Known limitation: the Contents API ignores commit dates, so all commits are dated 2026-11-09;
  backdating would need a Git Data API rewrite + force-push of `main` (user declined for now).

## Decisions (agreed 2026-11-10)

- npm workspaces, not Nx. All workspaces live under `projects/` (user's choice over
  `apps/` + `packages/`).
- LLM: **Gemini Flash** (free tier) is the default; **Claude Haiku** optional; **Gemma via
  Ollama** for the local/private story. Selected by `LLM_PROVIDER` in `projects/server/.env`.
  Keep providers behind one interface so the switch is a config change.
- GitHub: fine-grained PAT in `projects/server/.env` until week 4, then GitHub OAuth.
- Routes render client-side (`RenderMode.Client`); the SSR server only serves the shell.

## Rules that must not break

- The agent renders **only** catalog components. Every node passes `validateNode()` on
  the server and again in `GenUiHost` on the client. Invalid → `ErrorFallback`.
- Model output is never rendered as HTML: no `innerHTML`, no `bypassSecurityTrust*`.
  Raw payloads, diffs and code are shown as text.
- Every array in a props schema has `.max()`.
- Non-read tools are gated in server code by `needsApproval()`, never only by the prompt.
- Secrets stay in `projects/server`; nothing secret reaches the browser or the model.

## Angular conventions

- Angular 22: standalone by default, `OnPush` is the default strategy (do not set Eager),
  zoneless. Signals for state, signal `input()` / `output()`, built-in control flow.
- Suffixless file names (`stat-card.ts` → `class StatCard`), matching the CLI output.
- Catalog components live in `projects/web/src/app/genui/components/`, take
  `props = input.required<PropsOf<'Name'>>()` and `emit = input<EmitFn>()`, make no HTTP
  calls, and are keyboard accessible.
- Adding a catalog component: schema + entry in `projects/shared/src/catalog.ts`, then
  register it in `projects/web/src/app/genui/registry.ts` (missing registration = compile error).
- Styling: Tailwind v4 utilities with the design tokens in `projects/web/src/styles.css`
  (light + dark).

## Build plan and status

- [x] Week 1 – workspace, shared catalog, `GenUiHost`, 7 components, playground at `/playground`.
      Gate: health-report fixture renders; invalid nodes render `ErrorFallback` in place.
- [x] Week 2 – agent server and chat. Gate passed 2026-11-10: "Show my open PRs" streams a real
      `PrList` (Gemini and local Gemma). Done: provider interface (Gemini REST with fallback, Ollama
      with tag resolution), GitHub client (fetch, REST + GraphQL; no Octokit dependency), read tools
      `list_pull_requests` / `list_issues` / `get_repo_health` / `render_ui`, agent loop, in-memory
      runs + SSE, `AgentSession` signals + pure `applyEvent` reducer, chat page, `PrCard` / `PrList` /
      `StepTimeline`. Open: Claude provider (no key to test yet).
- [ ] Week 3 – approval gate, dry-run, `ApprovalCard`, `FormSurface`, audit log + undo. First read
      tool that returns issue/PR bodies must be tested against prompt-injection issue #8.
- [ ] Week 4 – `DiffViewer` review, client tools, Playwright e2e, OAuth, deploy.

## Agent server notes

- `POST /api/runs {prompt, threadId?}` → `{runId, threadId}`; `GET /api/runs/:id/events` is SSE with
  AG-UI-named events (`projects/shared/src/events.ts`). Runs buffer events, so late clients replay.
- Tools return `{ data (for the model), ui (UiNode for the user), detail (timeline) }`. UI is
  validated in the loop before streaming; non-read tools are refused in `runTool` until week 3.
- If the model fails after UI is on screen, the run finishes with a "no summary" note instead of
  an error (quota/503 resilience for live demos). A failed run rolls the thread back.
- Gemini free tier: newest Flash models often 503; daily/minute quota (429) runs out quickly when
  testing. Use `LLM_PROVIDER=ollama` (env var overrides `.env`) to keep working offline.
- Gemini 3 function calls carry thought signatures: assistant turns keep `raw` parts and replay them.
