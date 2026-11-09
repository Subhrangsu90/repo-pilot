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
- [ ] Week 2 – agent server: LLM provider interface, Octokit read tools, SSE stream,
      `AgentSession` signals, `StepTimeline`, `PrList`/`PrCard`. Gate: "Show my open PRs" on real data.
- [ ] Week 3 – approval gate, dry-run, `ApprovalCard`, `FormSurface`, audit log + undo.
- [ ] Week 4 – `DiffViewer` review, client tools, Playwright e2e, OAuth, deploy.

Week 2 needs from the user: Gemini API key, a `repopilot-demo` repo, a fine-grained PAT.
