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

## Database (Postgres in Docker + Drizzle)

- `npm run db:up` starts `repopilot-db` (`docker-compose.yml`: postgres:17.6-alpine, 127.0.0.1:5433,
  ~30 MB RAM, named volume); `npm run db:down` stops it. `DATABASE_URL` in `projects/server/.env`.
- Schema `projects/server/src/db/schema.ts`; after changing it: `npm run db:generate -w
  @repopilot/server -- --name <what>` (SQL in `projects/server/drizzle/`). The server applies
  migrations on startup; `npm run db:migrate -w @repopilot/server` does it alone.
- Optional by design: no `DATABASE_URL` or Postgres down → the server logs it and runs in memory;
  History / Audit log endpoints answer 503.
- Store tests hit a real database only when `TEST_DATABASE_URL` is set (never the dev DB, they empty
  it): `docker exec repopilot-db createdb -U repopilot repopilot_test`, then
  `TEST_DATABASE_URL=postgres://repopilot:repopilot@127.0.0.1:5433/repopilot_test npx vitest run
  src/store.integration.spec.ts` in `projects/server`.

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
- Theme: **Graphite by default**, Light as a toggle saved in localStorage (`repopilot-theme`),
  applied as `<html data-theme>`; index.html sets it before first paint.
- Persistence (doc §9b): **Postgres in local Docker + Drizzle, added in week 3** (runs, audit
  entries, then sessions/History). A hosted Postgres is chosen at deploy time (week 4).
- Routes: `/` landing (public), app pages inside the `Shell` layout: `/ask` (chat; `?q=` sends a
  prompt). The side nav shows the Screen Spec's six links (Ask, Pull requests, Issues, Releases,
  History, Audit log) with live PR/issue counts; unbuilt ones are dimmed, not links ("Coming soon"),
  and get a `path` in `NAV` (`layout/shell.ts`) as each page is built. Model switch on Ask only;
  each page draws its own top bar (Ask: repo, API quota, avatar); theme toggle sits in the nav foot.
  `/playground` is a dev-only renderer test page, out of the nav and landing (URL only).
- Screen Spec (2026-11-11, user's Claude Docs doc): <https://claude.ai/artifact/7PvQ8ojSvhP7zT8EaCvKwp>
  — the 7 screens, shared layout, play-mode behaviour and open gaps; read it with the Claude Docs
  tools. Where it and the design system disagree, the design system wins (user's decision); the
  differences are listed in the spec's "Inconsistencies between screens". Build order agreed: align
  Landing, layout, Ask and Approval (done 2026-11-11), then PR review, Release builder, Audit log
  and History one at a time as working features.

## Design sources (claude.ai artifacts, owned by the user)

- Design system "RepoPilot": <https://claude.ai/artifact/Tb41Yu1ZK5M24zNnKxMoGX> — read
  `project/README.md` + `project/tokens.json` (Artifact `read` with `paths`). Graphite monochrome:
  no brand hue; `risk` (amber) only for destructive, `success`/`danger` only for status. Fonts:
  Space Grotesk (display), Inter (sans), JetBrains Mono (mono). Themes `graphite` + `light`.
- Page designs "RepoPilot UI Design": <https://claude.ai/artifact/77EF7TsUucVhuJDGES8LGf> — artboards
  `project/{Main,Workspace,Review,Approval,Release,Audit,History}.dc.html` (landing, Ask/health
  report, PR review, bulk-close approval, release builder, audit log, session history).
- Design hexes outside `tokens.json` (#D0D0D4, #5A5A60, #333336, #232325) map to the nearest token.
  When a page artboard and the design system disagree, the design system wins.
- Design system v6 (2026-11-10, decided by the user): added tokens `body-md` (14), `caption` (12),
  `axis` (11, mono), `space-5` (20), `space-card` (18), `radius-xs` (7); inputs use `radius-md`;
  disabled buttons `text-muted` on `surface-3`; StatCard warning = `border-strong` + context in
  `text` (never `risk`), danger = `danger` border + context; chips and segments 44px. The app uses
  no hand-written sizes (only layout widths such as `max-w-[...]`). PrCard shows `branch`
  (`headRefName`); IssueTable shows `assignees` ("Unassigned" when empty).

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
- Styling: Tailwind v4 utilities over the design-system tokens in `projects/web/src/styles.css`.
  Raw vars keep DS names (`--surface-2`); utilities: `bg-bg`, `bg-surface-1..3`, `border-border`,
  `border-border-strong`, `text-fg` / `text-fg-muted` / `text-fg-faint` (DS `text*`), `primary`,
  `risk`, `success`, `danger` (+ `-soft`), `neutral-soft`. Type: `font-display`, `text-display`,
  `text-h1`, `text-h2`, `text-stat`, `text-body`, `text-body-md`, `text-body-sm`, `text-label`,
  `text-badge`, `text-caption`, `text-axis`. Spacing: Tailwind's 4px scale (`p-3` = `space-3`) plus
  `p-card` / `gap-card` (18). Radius xs 7 / sm 8 / md 10 / lg 14 / xl 18. Never write `text-[14px]`,
  `p-[18px]` and the like: if a size has no token, add it to the design system first. Tailwind's
  default palette is removed (no `text-white`, `bg-gray-*`).
- Shared classes: `.card`, `.agent-surface`, `.btn` (+ `-primary`, `-risk`, `-ghost`), `.chip`,
  `.badge` (+ `-write`, `-risk`, `-success`, `-danger`, `-agent`), `.field`, `.checkbox`. One filled
  button per surface; `btn-risk` only for a destructive approve. Every agent surface in the chat
  shows the "Rendered by agent · Name" badge.

## Build plan and status

- [x] Week 1 – workspace, shared catalog, `GenUiHost`, 7 components, playground at `/playground`.
      Gate: health-report fixture renders; invalid nodes render `ErrorFallback` in place.
- [x] Week 2 – agent server and chat. Gate passed 2026-11-10: "Show my open PRs" streams a real
      `PrList` (Gemini and local Gemma). Done: provider interface (Gemini REST with fallback, Ollama
      with tag resolution), GitHub client (fetch, REST + GraphQL; no Octokit dependency), read tools
      `list_pull_requests` / `list_issues` / `get_repo_health` / `render_ui`, agent loop, in-memory
      runs + SSE, `AgentSession` signals + pure `applyEvent` reducer, chat page, `PrCard` / `PrList` /
      `StepTimeline`. Open: Claude provider (no key to test yet).
- [x] Design restyle (2026-11-10) – design-system tokens + Graphite/Light themes, landing page,
      side-nav `Shell`, Ask page and all catalog components restyled, model switch (Cloud / Local
      Gemma → `model` on `POST /api/runs`).
- [x] Week 3 step 2 (2026-11-10) – approval gate: `bulk_update_issues` (destructive; close/reopen
      ≤100), server-side dry run (`plan`) → `ApprovalCard` (internal; `render_ui` refuses internal
      components even nested) → run pauses → `POST /api/runs/:id/actions` → `execute` only the
      approved ids from the dry run → card updated in place → model summarises. Verified on the live
      server with Gemma: card for #9–#11, 409 new prompt while waiting, 400 empty approve, reject
      resumes, 404 on a second answer, issues untouched. Demo prompt: "Close all open wontfix issues"
      (seeded issues are days old, so "older than 90 days" matches nothing).
- [x] Screen Spec alignment (2026-11-11) – six-link nav with live counts, Ask top bar, step strip,
      follow-up chips, live "N PATCH requests" on ApprovalCard, Landing per spec.
- [x] PR review (2026-11-11) – `/pulls` (open PRs → "Review #N") and `/pulls/:number` (header,
      step strip, PrReview). `get_pull_request` (read; diff lines numbered for the model, PR body
      returned as `untrustedDescription`) → `submit_pull_request_review` (write; dry run drops
      comments not on a diff line, own PR → Comment only) → PrReview (internal: DiffViewer with
      editable comments, summary, verdict, Submit) → POST with `edits` → one GitHub review on the
      reviewed commit. Verified live on PR #15 with Gemini: found all 3 planted bugs on the right
      lines; rejected, nothing posted. Not yet tried: a real submit, and a PR whose description
      carries a prompt injection.
- [x] Release builder (2026-11-11) – `/releases`: prompt prefilled from the latest release
      ("Draft release v1.1.0 from everything since v1.0.0") → `get_release_changes` (merged PRs via
      search since the previous release, commit and contributor counts) → `create_release` (write;
      dry run refuses an existing tag and unlinks PRs outside the release) → ReleaseForm (internal;
      FormSurface + live preview, "edited by you" markers, add/remove entries, pre-release) →
      Review and publish → confirm step → one GitHub release on the default branch. "Ask agent to
      rewrite" rejects, then sends a prompt listing the user's values (`rewritePrompt`); keeping
      them is asked of the model, not enforced. Verified live with Gemini (v1.1.0 from #14);
      rejected, nothing published. A real publish not tried yet.
- [x] Postgres + Audit log + History (2026-11-11). Tables `sessions` (thread id; full ChatMessage[]
      jsonb incl. tool calls and raw parts; `pending` jsonb), `runs` (event stream per run; prompt null
      = resumed after approval), `audit_entries` (aud_0001; input + edits, approved / kept-by-user ids,
      approver login, result, GitHub response, `inverse`). Differs from doc §9b on purpose: no
      `messages` / `ui_surfaces` tables — reopening replays stored events (`replayRuns`), no model call.
      `/audit` (filters, table, detail with raw JSON, Undo behind a confirm dialog) and `/history`
      (search, filters, Today/Yesterday/Earlier, preview, rename, delete, Resume → `/ask?session=id`).
      Verified live: a paused approval stored only in Postgres was answered after a restart; the resumed
      run was saved; a second answer got 404. Not tried live yet: approve → audit entry → Undo.
- [x] Week 3 merged to `master` (PR #1, 2026-11-11). FormSurface ships as the ReleaseForm pattern,
      not a separate catalog component. Stored sessions keep tool calls/results and provider `raw`
      parts (needed for replay and Gemini thought signatures).
- [ ] Week 3 wrap-up (branch `chore/week-3-wrap-up`) – live checks before week 4:
      approve → audit entry → Undo; prompt injection via issue #8 and via a PR description
      (`untrustedDescription`) must be treated as data; one real PR review submit; one real release
      publish. Then: Issues page (last dimmed nav link), last-6-turns + summary context (doc §9b
      step 5; needed for the "only show bugs" follow-up), agent naming sessions (now: first line of
      the prompt), Refresh on stale surfaces.
- [ ] Week 4 – client tools (demo step 4: "take me to the auth changes" scrolls/highlights diff
      lines), recorded event-stream fixtures + mock agent, Playwright e2e, GitHub OAuth, deploy
      (hosted Postgres).

## Agent server notes

- `POST /api/runs {prompt, threadId?, model?: 'cloud'|'local'}` → `{runId, threadId}` (`model`
  omitted = `LLM_PROVIDER`; local = Ollama; cloud = the configured cloud provider, else Gemini); `GET /api/runs/:id/events` is SSE with
  AG-UI-named events (`projects/shared/src/events.ts`). Runs buffer events, so late clients replay.
- Read tools return `{ data (for the model), ui (UiNode for the user), detail (timeline) }`. UI is
  validated in the loop before streaming.
- Write/destructive tools live in `projects/server/src/tools/actions.ts` as `{ plan, execute }`.
  `plan` only reads (dry run) and returns a card draft + the item ids; `execute(input, ids)` is only
  called by `resumeAgent` after approval. The model has no `dryRun` input. A paused call
  (`PendingApproval`) sits on the in-memory `Thread` until answered; new prompts on that thread
  get 409. `POST /api/runs/:runId/actions {toolCallId, decision, selected?}` → new run on the same
  thread; the client streams it into the same turn (`awaiting-approval` turn status).
- Persistence: `runs.ts` calls `onRunFinished` once per run → `Store.saveRun` (upserts the session,
  inserts the run). `ensureThread` reloads a thread from Postgres when it is not in memory (new prompt
  on an old session, or POST /actions for a pending run after a restart). Every approved change calls
  `AgentDeps.onExecuted` → `Store.recordAudit`; rejections write nothing. Actions declare `summary`
  and `inverse` (`tools/undo.ts`: reopen/close issues, delete release + tag; reviews have none).
  `POST /api/audit/:id/undo` runs the inverse directly (user confirms in the UI; never the model) and
  marks the entry undone once. Endpoints: `GET /api/sessions?q=&filter=all|waiting|changes|read`,
  `GET|PATCH|DELETE /api/sessions/:id`, `GET /api/audit?filter=all|write|destructive|undone`,
  `GET /api/audit/:id`, `POST /api/audit/:id/undo`.
- The GenUI registry is provided by the lazy `Shell` (not app config), so catalog components stay
  out of the landing page's initial bundle (336 kB vs the 500 kB budget).
- Approval gate surfaces: `ApprovalCard`, `PrReview` or `ReleaseForm` (`Plan.component`). An action may declare
  `edits` (Zod; the user's changes, sent as `edits` on POST /actions and re-checked in the loop;
  invalid edits change nothing), `editedCard` (show edits while running), `carry` (server-only
  dry-run facts such as the reviewed commit) and `allowEmpty` (approve with nothing ticked).
  DiffViewer is internal too: diffs come only from real patches, never typed by the model.
- `GET /api/pulls` (open PRs as PrCard props) and `GET /api/pulls/:number` (header, no diff) serve
  the pages; the review page runs its own `AgentSession` (component provider) separate from Ask.
- `GET /api/overview` → `{repo, openPullRequests, openIssues, rateLimit, viewer}` (one GraphQL call)
  for the nav counts and the Ask top bar; the client reloads it after each run.
- Follow-up chips: `agent/followups.ts` picks up to 3 prompts from the components a run showed and
  sends `CUSTOM followups` before RUN_FINISHED (not while an approval waits). Only prompts the
  current tools can answer.
- ApprovalCard focuses the card itself, never Approve (a stray Enter must not approve). "Edit
  request" rejects the change and puts the prompt back in the composer (`AgentSession.draft`).
  ErrorFallback "Ask the agent to retry" sends a new prompt with the reason.
- If the model fails after UI is on screen, the run finishes with a "no summary" note instead of
  an error (quota/503 resilience for live demos). A failed run rolls the thread back.
- Gemini free tier: newest Flash models often 503; daily/minute quota (429) runs out quickly when
  testing. Use `LLM_PROVIDER=ollama` (env var overrides `.env`) to keep working offline.
- Gemini 3 function calls carry thought signatures: assistant turns keep `raw` parts and replay them.
