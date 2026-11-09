# RepoPilot

Manage GitHub in plain English. An AI agent answers with real, validated UI components
(dashboards, tables, approval cards) instead of chat text, and never changes a repository
without your approval.

Design document: [docs/project-documentation.md](docs/project-documentation.md)

## Structure

```text
projects/web       Angular 22 app (renderer, catalog components, playground)
projects/server    Node agent server (Fastify): model loop, GitHub tools, event stream
projects/shared    Zod component catalog, validateNode(), prompt doc, fixtures
```

## Getting started

Requires Node 22+ (developed on Node 24) and npm 11.

```bash
npm install          # installs every workspace from the repo root
npm run dev:web      # http://localhost:4200  (renderer playground)
npm run dev:server   # http://localhost:3000/api/health
npm test             # all unit tests
npm run build        # production builds
```

Server settings: copy `projects/server/.env.example` to `projects/server/.env`.
The model is chosen with `LLM_PROVIDER`: `gemini` (Gemini Flash, default), `claude`
(Claude Haiku) or `ollama` (Gemma, local).

## Status

Week 1 of 4: shared catalog, renderer and playground are in place. The agent loop and
GitHub tools arrive in week 2.
