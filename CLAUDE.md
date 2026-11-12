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

Root scripts: `npm test` (all workspaces), `npm run build`, `npm run typecheck`. Note: `typecheck`
does not check Angular templates; `ng build` does.

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

## Setup check

- `npm run check -w @repopilot/server` – verifies Gemini (primary + fallback), Ollama, Claude, the
  GitHub token (repositories it can see) and whether GitHub sign-in is fully configured. Prints
  status only, never secrets.
- No seed data, demo repository, fixtures, playground or e2e suite any more (removed 2026-11-12 at
  the user's request). The repo `Subhrangsu90/repopilot-demo` still exists on GitHub with the data
  seeded earlier (#8 injection issue, PR #15 with 3 planted bugs, PR #16 with an injected
  description), but nothing in the code assumes it.

## Decisions (agreed 2026-11-10)

- npm workspaces, not Nx. All workspaces live under `projects/` (user's choice over
  `apps/` + `packages/`).
- LLM: **Gemini Flash** (free tier) is the default; **Claude Haiku** optional; **Gemma via
  Ollama** for the local/private story. Selected by `LLM_PROVIDER` in `projects/server/.env`.
  Keep providers behind one interface so the switch is a config change.
- GitHub: OAuth App sign-in when `GITHUB_OAUTH_CLIENT_ID` + `_SECRET` + `SESSION_SECRET` are set
  (week 4); otherwise dev mode, everyone acting as the fine-grained PAT's owner (`GITHUB_TOKEN`).
- Repositories (2026-11-12, user's decision): no allowlist. Scope `repo` (public + private; an
  OAuth App cannot narrow it per repo). The side nav lists every repo the user can access and the
  app works on the selected one only (see "Multi-repo" under week 4).
- Routes render client-side (`RenderMode.Client`); the SSR server only serves the shell.
- Theme: **Graphite by default**, Light as a toggle saved in localStorage (`repopilot-theme`),
  applied as `<html data-theme>`; index.html sets it before first paint.
- Persistence (doc §9b): **Postgres in local Docker + Drizzle, added in week 3** (runs, audit
  entries, then sessions/History). A hosted Postgres is chosen at deploy time (week 4).
- Routes: `/` landing (public), app pages inside the `Shell` layout: `/ask` (chat; `?q=` sends a
  prompt). The side nav shows the Screen Spec's six links (Ask, Pull requests, Issues, Releases,
  History, Audit log) with live PR/issue counts (all six built as of 2026-11-12); unbuilt ones are dimmed, not links ("Coming soon"),
  and get a `path` in `NAV` (`layout/shell.ts`) as each page is built. Model switch on Ask only;
  each page draws its own top bar (Ask: repo, API quota, avatar); theme toggle sits in the nav foot.
  `/signin` is outside the Shell (see week 4).
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
- [x] Week 3 wrap-up (branch `chore/week-3-wrap-up`, done 2026-11-12) – live checks before week 4. Verified
      2026-11-10 against GitHub: approve → audit → Undo (`aud_0001`: closed #9, #10 with #11
      deselected, then reopened), real release publish + Undo (`aud_0002`: v1.0.1 release and tag
      deleted), real review submit (`aud_0003`: Comment on PR #17; reviews have no undo).
      Prompt injection (2026-11-11): issue bodies never reach the model (issue tools send titles
      only), so #8 cannot fire. PR #16's description now plants an injection (also in the seed).
      "Review pull request #16": Gemini drafted a Comment-only PrReview, Gemma drafted nothing;
      neither obeyed it (no issue tools, no Approve; own PR allows Comment only anyway) and nothing
      reached GitHub. Gaps found, then fixed (2026-11-12): (1) neither model flagged it →
      `tools/injection.ts` `findInjection()` checks the PR description in code; `get_pull_request`
      adds `injectionWarning` for the model and a warning in the diff Section, the review dry run
      sets PrReview `injectionWarning` (flagged sentence, shown as text in a `role="note"` box);
      (2) Gemma claimed a draft without the tool → a review is owed when `reviewPullRequest` is set
      or the prompt says "review" and the run read exactly one PR; the loop reminds the model once
      (its claim is held back), then the summary-only fallback drafts it; (3) PR diff Sections got
      health-report chips → `surfaceKey()` keys them `PullRequestDiff`. Re-verified live on #16:
      Gemma and Gemini both drafted a real PrReview with the warning and mentioned the injection;
      rejected, nothing posted. Titles (2026-11-12): `markTitles()` / `titleWarning()` flag issue and
      PR titles in `list_issues`, `list_pull_requests`, `get_repo_health` (oldest issues) and
      `get_release_changes` (model note only, no UI); flagged rows/cards carry `injection: true`
      (IssueRow, PrCard) and show `InjectionBadge`; `get_pull_request` and the review dry run check
      the PR title as well as the body. No false alarms on the demo repo's 17 titles; no planted
      title injection exists, so the badge is covered by tests only. `ng test` sometimes fails on
      the first (cold) run with "Timeout waiting for worker to respond" / "no tests"; a re-run passes.
      Issues page (2026-11-12, no artboard; user chose "list + bulk close via agent"): `/issues`,
      `GET /api/issues?state=open|closed|all` (reuses `list_issues`: validated rows with injection
      flags, max 100), state chips + label chips (labels filtered in the browser), selectable
      IssueTable → "Close N…" / "Reopen N…" sends "Close issues #9 and #10 as not planned" to the
      page's own AgentSession; only the ApprovalCard + steps are shown (the table is already there);
      list and nav counts reload when the run settles. Verified with Gemma via the API: card listed
      exactly #9, #10; rejected, nothing changed. Clicked through by the user (`aud_0004`: closed
      #2, #3, #4 from the page; not undone).
      Context window (2026-11-12, doc §9b step 5): `agent/context.ts` `contextWindow()` sends the
      model the last 6 turns whole (a turn starts at a user prompt; `[RepoPilot app]` notes are not
      prompts, so tool calls, results and `raw` parts are never split) and appends older turns to
      the system prompt as a summary. Differs from the doc on purpose: the summary is built in code
      (prompt → tools run and how they ended → the agent's reply, ≤ 4000 chars, oldest lines
      dropped first), not by a model call, so it costs no quota, cannot invent facts and needs no
      `summary` column; the stored thread stays complete. Follow-ups such as "only show bugs"
      never depended on this (the whole thread was sent before). Checked on stored sessions.
      Refresh (2026-11-12, doc §9b step 6): `GET /api/sessions/:id` adds `refreshable` (surfaceId +
      capturedAt = the run's start) for surfaces made by read tools, matched by `${runId}-${callId}`
      to the stored tool call (never render_ui or gate surfaces); `POST
      /api/sessions/:id/surfaces/:surfaceId/refresh` re-runs that tool with its stored input (no
      model) and returns a validated node (`agent/refresh.ts`). Ask shows "Captured …" + Refresh on
      those surfaces of a reopened session and swaps the node in place; not saved, so reopening
      again shows the captured data. Session titles (`agent/title.ts` `sessionTitle()`): named in
      code from the first run's tool calls, set on insert only (a rename sticks): "PR #16 review",
      "Release v1.1.0", "Close issues #9, #10", "Reopen 4 issues", "Health report"; list questions
      keep the prompt line (it says more than "Open pull requests"). Not a model call, unlike doc
      §9b step 1.
- [ ] Week 4 (branch `feat/week-4`, from `chore/week-3-wrap-up`).
  - [x] Client tools (2026-11-12): `navigate_to`, `highlight_lines`, `apply_table_filter` in
        `shared/src/tools.ts` with `side: 'client'` (risk read). The loop validates the input, streams
        `CUSTOM client_tool` and tells the model the app applied it (no executor). Browser:
        `AgentSession.runClientTool` → Router (`routeFor`), `ClientTools.requestHighlight` (DiffViewer
        outlines the new-file lines, scrolls, claims it; unclaimed after 300 ms → "not on screen" note
        in Ask), `filterTables` (pure, `agent-run.ts`: filters the latest surface containing the
        IssueTable/PrList, also nested in the health report; keeps `base` for Clear; replays from
        History; navigation/highlights do not replay). Side questions while a change waits:
        `POST /api/runs` on a pending thread runs `agent/side.ts` (copy of the thread with the paused
        call answered "not decided yet", read + client tools only, `readOnly` refuses changes in code);
        the copy is discarded, the run is saved, `replayRuns` attaches the resumed run to the turn that
        waited. Ask no longer locks the prompt box while a card waits (`locked` = busy only).
        Verified live with Gemma: health report → "Only show bugs" filtered in place (needed examples
        in the tool description); "Review pull request #15" pending → "Take me to where the rate
        limit key is built" → `highlight_lines` src/auth/login.js:6–34; rejected, nothing posted.
  - [x] (Removed 2026-11-12 at the user's request, with the playground, `shared/src/fixtures.ts`
        and the seed script; tests that used fixtures now use inline data.) Was: mock agent + fake
        GitHub + Playwright + recorded streams: `E2E_MODE=1` forced
        `LLM_PROVIDER=mock` (`llm/mock.ts`, scripts per demo prompt), an in-process `FakeGitHub`
        (`testing/fake-github.ts`, demo data for `demo-owner/repopilot-demo`, records writes,
        anything unmocked → 404) and no database, whatever `.env` says; adds
        `GET /api/__test__/github-writes` and `POST /api/__test__/reset`. `npm run e2e` (root
        `playwright.config.ts`, `e2e/demo.spec.ts`) starts the server on :3100 and `ng serve` on
        :4300 with `proxy.e2e.json` (never the dev :3000/:4200): PR list, approve 2 of 3 → exactly
        two PATCHes, reject → no writes, "only show bugs" filter + Clear, Issues page close, invalid /
        XSS fallback. 6 passed. Recorded streams: `web/src/app/core/recorded/*.json` (real runs
        exported from Postgres) replayed in `recorded-streams.spec.ts`. Note: `npm run typecheck`
        does not check templates; `ng build` (or the e2e run) does.
  - [x] GitHub OAuth, code complete (2026-11-12; needs a registered OAuth App to try for real):
        `auth/index.ts` `createAuth()` → mode `oauth` (all three env vars set) or `token` (dev: acts as
        the GITHUB_TOKEN owner, as before). `/api/auth/login` (state in a sealed cookie, scope
        `GITHUB_OAUTH_SCOPE`, default `public_repo`) → GitHub → `/api/auth/callback` (state checked,
        code exchanged server-side, `/user`) → sealed `rp_session` cookie (AES-256-GCM, httpOnly,
        SameSite=Lax, Secure on https, 8 h; holds the token, never readable by the page) → `/ask`.
        `/api/auth/me`, `POST /api/auth/logout`. An `onRequest` hook gives every `/api/*` request
        its user (401 in OAuth mode without one; public: `/api/auth/*`, `/api/health`,
        `/api/__test__/*`). `who(req)` → `{ login, ctx }`: all GitHub calls use that user's token.
        Ownership: threads carry `owner` (new prompts, approvals and SSE of someone else's run →
        404 / not_found); the store scopes sessions by `user_id` and the audit log by `approved_by`
        (`recordAudit` takes `approver`). Existing rows keep working in dev mode (they carry the PAT
        owner's login). Web: sign-in page `/signin` (`features/auth/sign-in.ts`, outside the Shell;
        states: signed out, `?error=denied|state|exchange|expired`, `?signedOut=1`, already signed in,
        dev mode, server unreachable). `requireSignIn` guard on the Shell route sends signed-out
        visitors to `/signin?next=<page>`; `/api/auth/login?next=` keeps it in the sealed state cookie
        and the callback returns there (`safeNext()`: in-app paths only, never `//host`, `/api/`,
        `/signin`); failures redirect to `/signin?error=…`. `Auth.load()` (promise, shared), 401
        interceptor → `expired` + `/signin?error=expired&next=<here>`. Login + Sign out in the nav
        foot; Landing's Sign in buttons go to `/signin` when OAuth needs it. Lesson: read
        `httpResource` values through `core/resource.ts` `valueOf()` (`.value()` throws in the error
        state, which stopped the view and left the sign-in link without an href). Verified: dev mode unchanged on the live server;
        OAuth mode with placeholder settings → every API 401, login redirect correct. Not done: token
        revocation on sign-out, a GitHub App (fine-grained) instead of an OAuth App.
  - [x] Multi-repo (2026-11-12): config has no `GITHUB_REPO_ALLOWLIST`; `GITHUB_OAUTH_SCOPE`
        defaults to `repo`; empty OAuth env values count as unset. `GET /api/repos` (the user's
        repos, owner/collaborator/org, sorted by push, archived hidden, max 100). `ToolContext.repo`
        = the selected repo; `resolveRepo()` refuses any other repo the model names ("This
        conversation works on X only"). Pages pass `?repo=owner/name` (validated by
        `REPO_PATTERN`; GitHub 403/404 → "not found or no access"). `POST /api/runs {repo}`: a
        thread keeps the repo of its first prompt (`Thread.repo`, stored in `sessions.repo`), a
        different repo → 409 "start a new chat"; approvals and Refresh use the thread's/session's
        repo. Audit: `recordAudit` gets `repo`; inverses are pinned to it (`pinRepo`) so Undo acts
        there; older entries fall back to the session's repo. Web: `core/repo.ts` `RepoChoice`
        (list, `selected`, pick saved in localStorage `repopilot-repo`, falls back to the most
        recently pushed repo), picker in the Shell (repo name; owner shown only when not yours;
        "private"), `onRepoSwitch()`: Ask starts a new chat, Issues / Releases reset, PR review
        goes back to `/pulls`; reopening a session from History selects its repo. Verified in a
        browser on a dev-mode server (84 repos listed, switching updates counts and pages, pick
        survives reload).
  - [ ] Deploy (hosted Postgres): host not chosen yet.

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
