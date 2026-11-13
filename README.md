# RepoPilot

Manage GitHub in plain English. An AI agent answers with real, validated UI components
(dashboards, tables, diffs, approval cards) instead of chat text, and never changes a repository
without your approval.

Design document: [docs/project-documentation.md](docs/project-documentation.md)

## Structure

```text
projects/web       Angular 22 app: pages, the agent chat, catalog components, A2UI renderer
projects/server    Node agent server (Fastify): model loop, GitHub tools, AG-UI endpoint, auth, Postgres store
projects/shared    Zod component catalog, validateNode(), A2UI conversion, AG-UI conventions, tool specs, prompt doc
```

The agent and the app speak two open protocols:

- **AG-UI** (transport): every run is one `POST /api/agent` with an AG-UI `RunAgentInput`, answered
  by the run's event stream (steps, reasoning, tool calls, shared state, text). A change that
  needs approval ends the run as an AG-UI interrupt; the answer is a run that resumes it.
- **A2UI** (rendering): everything the agent shows is A2UI v1.0 messages, rendered by
  `@a2ui/angular` with RepoPilot's own component catalog. The agent sends layout and data, never
  code, and everything is validated on both sides.

`.npmrc` sets `legacy-peer-deps=true` because `@a2ui/angular` still declares Angular 21 as a peer.

## Getting started

Requires Node 22+ (developed on Node 24), npm 11 and Docker (for Postgres).

```bash
npm install          # installs every workspace from the repo root
npm run db:up        # Postgres in Docker (History and the Audit log need it)
npm run dev:server   # http://localhost:3000/api/health
npm run dev:web      # http://localhost:4200
npm test             # all unit tests
npm run build        # production builds
```

Server settings: copy `projects/server/.env.example` to `projects/server/.env`.

- **Model:** `LLM_PROVIDER` = `gemini` (Gemini Flash, default), `claude` (Claude Haiku) or
  `ollama` (Gemma, local).
- **GitHub:** set `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` and `SESSION_SECRET` to
  let people sign in with GitHub (scope `repo`: public and private repositories). Without them the
  server runs in dev mode and acts as the owner of `GITHUB_TOKEN`.
- **Repositories:** after signing in, pick any repository you can access in the side nav. Pages
  and the agent work on that repository only, and every change waits for your approval.

`npm run check -w @repopilot/server` checks the model providers and GitHub access (status only,
never secrets).
