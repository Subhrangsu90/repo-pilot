# RepoPilot — Project Documentation

Nov 9, 2026 · @Subhrangsu

## 1. Overview

RepoPilot is an Angular app where you manage GitHub in plain English, and an AI agent answers with real interactive UI (dashboards, diff viewers, approval cards, editable forms) instead of chat text. It is a proof of concept built to demonstrate Generative UI and Agentic UI end to end in a job interview.

### The problem

Git and GitHub are powerful but hard to use well. Simple questions ("which PRs are stuck?", "what changed since the last release?") take many clicks across many pages. Bulk work (closing stale issues, writing release notes, reviewing a large PR) is slow and repetitive. A chat-only AI assistant helps a little, but it answers with walls of text and cannot safely act on your repo.

### The solution

The user types an intent. The agent reads GitHub through the API and replies with UI components chosen from a fixed, validated catalog. Any change to the repo is shown first as a preview the user approves, edits or rejects.

### Goals

- Cover every major Generative UI and Agentic UI pattern in one coherent product.
- Use real data from the GitHub API, not mock data.
- Make every agent action safe: validated output, approval before writes, dry-run before destructive actions, undo through an audit log.
- Showcase modern Angular: signals, standalone components, OnPush, dynamic component rendering.

### Non-goals

- Running local `git` commands. The browser cannot do this; the GitHub API covers repos, branches, commits, PRs, issues, reviews, releases and Actions.
- Replacing GitHub's own UI. RepoPilot is an intent-driven layer on top of it.
- Production scale (multi-tenant, billing). This is a POC with a dedicated demo repository.

## 2. Core concepts

Generative UI means the agent decides what interface to show at runtime; Agentic UI means the agent takes actions with the user in the loop. RepoPilot implements six patterns that together cover both.

| Pattern | What it means | Where RepoPilot uses it |
| --- | --- | --- |
| Tool-based Generative UI | The model calls a tool; the app maps the tool result to a known component | "Show my open PRs" → `PrList` |
| Declarative Generative UI | The model emits a JSON tree of components (A2UI style); the client renders it from its own catalog | "Repo health report" → `Grid` of `StatCard`, `ActivityChart`, `IssueTable` |
| Human-in-the-loop | Write actions pause for the user to approve, edit or reject | `ApprovalCard` before every write or destructive tool |
| Shared state | Agent and user edit the same state; each sees the other's changes | `FormSurface` for PR descriptions, issues, release notes |
| Frontend tools | The agent controls the UI itself, not just the data | `navigate_to`, `highlight_lines`, `apply_table_filter` |
| Streaming steps | The agent's progress is shown live as a step list | `StepTimeline` during reviews and reports |

### Key terms

- **Component catalog**: the allowlist of components the agent may render, each with a props schema. It is the contract between agent and UI.
- **UI node**: one JSON object `{ component, props }` emitted by the agent. Nodes nest through `Grid` and `Section`.
- **A2UI**: Google's open standard for declarative agent UI. Agents send JSON describing UI intent; the client renders it with native components. It has an official Angular renderer.
- **AG-UI**: an event protocol that streams agent messages, tool calls, state and UI payloads to the client, and carries user actions back.
- **Risk tier**: every tool is `read`, `write` or `destructive`. The tier decides whether it runs immediately, needs approval, or needs approval plus a dry-run preview.

### Why not let the model write HTML?

Raw model HTML is an XSS risk, breaks your design system, and is hard to test. A catalog keeps the output safe like data and consistent like your own components, while still letting the agent compose new layouts.

## 3. Features

Ten features, each tied to a pattern and triggered by a plain-English prompt. Features 1–5 are the core demo; 6–10 make it memorable.

| # | Feature | Example prompt | Pattern | Rendered with |
| --- | --- | --- | --- | --- |
| 1 | PR overview | "Show my open PRs" | Tool-based GenUI | `PrList` |
| 2 | Repo health report | "Give me a health report of this repo" | Declarative GenUI | `Grid` + `StatCard` + `ActivityChart` + `IssueTable` + `ContributorList` |
| 3 | Bulk issue cleanup | "Close all wontfix issues older than 90 days" | Human-in-the-loop + dry-run | `ApprovalCard` with selectable items |
| 4 | Drafted issue or PR | "Open a PR from feature/login with a good description" | Shared state | `FormSurface` → `ApprovalCard` |
| 5 | Live progress | Any multi-step request | Streaming steps | `StepTimeline` |
| 6 | AI PR review | "Review PR #42" | Declarative GenUI + HITL | `DiffViewer` with inline comments → `ApprovalCard` |
| 7 | Explain a change | "Explain PR #42 for a non-developer" | Tool-based GenUI | `PrCard` + summary text |
| 8 | Release builder | "Create release v1.2.0" | Shared state | `ReleaseNotesEditor` → `ApprovalCard` |
| 9 | Safe undo | "Undo the last merge" | HITL + dry-run | `DiffViewer` + `ApprovalCard` (opens a revert PR) |
| 10 | Agent drives the UI | "Take me to the auth changes in #42" | Frontend tools | `navigate_to` + `highlight_lines` |

### Cross-cutting behaviour

- **Audit log**: every executed write is recorded with who approved it, the inputs, and the GitHub response. Reversible actions show an Undo button.
- **Follow-up refinement**: "only show bugs" or "sort by age" updates the component already on screen through `apply_table_filter`, without a new fetch.
- **Model switch**: a settings toggle swaps the cloud model for a local model, to show privacy and cost tradeoffs.

## 4. Architecture

RepoPilot has three zones: the Angular app renders and collects actions, a Node agent server runs the model and enforces approval, and GitHub plus the LLM sit behind the server. The browser never talks to GitHub or the model directly.

&#91;embedded content: RepoPilot architecture · browser, agent server, external services\]

The browser and server speak two open protocols: **AG-UI** (v1.0) carries every run as one event stream, and **A2UI** (v1.0) describes every piece of UI the agent shows. Only the tool executor, after the approval gate, can change the repo.

### Request lifecycle

1. The user types an intent; `AgentSession` starts an AG-UI run (`HttpAgent`, `POST /api/agent` with a `RunAgentInput`: the new message, the app's frontend tools, page context, the selected repo in `forwardedProps`). The response is the run's event stream.
2. The agent loop sends the prompt, catalog doc and tool list to the LLM.
3. Every tool call streams as `TOOL_CALL_*` events, and every step as `STEP_*` events, so `StepTimeline` updates live. Read tools run at once.
4. UI from tools (or from `render_ui`) is validated and converted into A2UI messages (`createSurface`, `updateComponents`, `updateDataModel`), sent as an AG-UI `ACTIVITY_SNAPSHOT` of type `a2ui-surface`.
5. `@a2ui/angular` renders the surface against RepoPilot's A2UI catalog; each component's resolved props are validated again before it renders.
6. A write tool call hits the approval gate: the approval surface streams, and the run ends as an AG-UI **interrupt**.
7. The user approves, edits or rejects; the component's A2UI action becomes a new run whose `resume` entry answers the interrupt. The card updates in place through A2UI data model updates (`ACTIVITY_DELTA`).
8. The executed action is written to the audit log with its inverse, so the Undo button can reverse it.

### Events on the stream

All events are standard AG-UI 1.0 events (`@ag-ui/core`); RepoPilot-specific details live in `metadata.repopilot`, the shared state, or interrupt metadata.

| AG-UI event | Carries | Updates in Angular |
| --- | --- | --- |
| `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` | Outcome (success, interrupt, cancelled), token usage | Turn status, pending approval, token count |
| `STATE_SNAPSHOT` / `STATE_DELTA` | Repo, model, pending approval, follow-up prompts | Follow-up chips |
| `STEP_STARTED` / `STEP_FINISHED` | Step label, status, detail | Step timeline |
| `REASONING_*` | The model's thought summary | Collapsible "How the agent reasoned" (text) |
| `TOOL_CALL_START/ARGS/END/RESULT` | Every tool call; frontend tools are applied on `TOOL_CALL_END` | Table filter, navigation, diff highlight |
| `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` (`a2ui-surface`) | A2UI messages for one surface | Rendered by `@a2ui/angular` |
| `TEXT_MESSAGE_*` | The agent's reply | Answer text |

## 5. Tech stack

Angular on the front, a thin Node agent server in the middle, GitHub and an LLM behind it. Every choice below is one you can defend in an interview.

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend framework | Angular (latest), standalone components, signals, OnPush | Your core skill; signals make streaming and shared state simple |
| Dynamic rendering | A2UI v1.0 (`@a2ui/angular` + `@a2ui/web_core`) with RepoPilot's own catalog, generated from the Zod schemas | An open standard: the agent sends layout and data, never code; the app keeps its own components and design system |
| Agent ↔ UI transport | AG-UI v1.0 (`@ag-ui/client` `HttpAgent`, `@ag-ui/encoder` on the server) | One POST per run, answered by its event stream: text, reasoning, tool calls, steps, shared state, A2UI activities, interrupts for approvals, cancellation |
| Validation | Zod schemas shared by client and server | One source of truth for props and tool inputs |
| Backend | Node + TypeScript (Express or Fastify) | Same language end to end; easy to share `catalog.ts` and `tools.ts` |
| GitHub access | Octokit (REST + GraphQL) | GraphQL builds a health report in one request instead of about ten |
| Alternative tool source | Official GitHub MCP server | Saves writing every tool by hand; a strong MCP talking point |
| LLM (demo) | A fast cloud model with tool calling and JSON output, e.g. Gemini Flash | Low latency keeps the live demo smooth |
| LLM (local option) | Gemma via Ollama | Privacy and cost story; expect slower responses on a laptop |
| Charts | A lightweight chart library (e.g. ngx-echarts or Chart.js) | `ActivityChart` only needs bar and line |
| Diff rendering | `diff2html` or a custom renderer over the unified patch | Patch is rendered as text, never as HTML from the model |
| Auth | GitHub OAuth App or GitHub App, token kept server-side | Token never reaches the browser |
| Persistence | Postgres with Drizzle ORM for sessions, paused runs and audit log | Schema and queries in TypeScript, type-safe end to end, migrations with drizzle-kit; same stack as your Node + Postgres work |
| Testing | Jest/Vitest, Angular Testing Library, Playwright | Unit, component and end-to-end layers |
| Hosting | Frontend on Vercel/Netlify/Firebase; server on Render/Fly/Cloud Run | Free tiers are enough for a demo link |

## 6. Agent tools reference

RepoPilot exposes 19 tools in four groups. The risk tier, not the model, decides whether a tool runs immediately: `needsApproval(name)` returns true for anything that is not `read`. Source: `tools.ts`.

### Read tools (run immediately)

| Tool | Purpose | Key inputs | Renders as |
| --- | --- | --- | --- |
| `list_repos` | Repos the user can access, most recently pushed first | `limit` | `RepoList` |
| `get_repo_health` | One GraphQL call: 12-week commit activity, issues by label, stale PRs, top contributors | `owner`, `repo` | `Grid` of `StatCard`, `ActivityChart`, `IssueTable`, `ContributorList` |
| `list_pull_requests` | PRs with CI status, reviewers, age | `state`, `author` ("@me") | `PrList` |
| `get_pull_request` | One PR with changed files and unified diff | `number` | `PrCard` + `DiffViewer` |
| `list_issues` | Issues with filters, PRs excluded | `state`, `labels`, `olderThanDays` | `IssueTable` |
| `get_commit_history` | Commits on a branch since a date or tag | `branch`, `since`, `limit` | `CommitTimeline` |
| `get_file_content` | A file at a ref | `path`, `ref` | `CodeViewer` |
| `list_workflow_runs` | Recent Actions runs with status and duration | `branch`, `limit` | `WorkflowRunList` |

### Write tools (approval required)

| Tool | Purpose | Key inputs | Flow |
| --- | --- | --- | --- |
| `create_issue` | Create an issue | `title`, `body`, `labels`, `assignees` | `FormSurface` → `ApprovalCard` |
| `create_branch` | Branch from a ref | `name`, `from` | `ApprovalCard` |
| `create_pull_request` | Open a PR with a generated description | `head`, `base`, `title`, `body`, `draft` | `FormSurface` → `ApprovalCard` |
| `submit_pr_review` | Review with line comments | `number`, `event`, `summary`, `comments[]` | `DiffViewer` (inline comments) → `ApprovalCard` |
| `create_release` | Release with changelog from commits | `tag`, `name`, `notes`, `prerelease` | `ReleaseNotesEditor` → `ApprovalCard` |

### Destructive tools (approval + dry-run)

Each is called first with `dryRun: true`. The server returns exactly what would change, the UI shows it, and only an approval triggers the real call with `dryRun: false`.

| Tool | Purpose | Key inputs | Safety rule |
| --- | --- | --- | --- |
| `bulk_update_issues` | Close, reopen or relabel up to 100 issues | `issueNumbers[]`, `action`, `labels` | User can deselect items before approving |
| `merge_pull_request` | Merge a PR | `number`, `method` | Preview shows checks, method and target branch |
| `revert_via_pr` | Undo merged work | `commitSha` | Opens a revert PR; never force-pushes or rewrites history |

### Client tools (run in the browser)

| Tool | Purpose | Key inputs |
| --- | --- | --- |
| `navigate_to` | Move the app to a route | `route`, `params` |
| `highlight_lines` | Scroll to and highlight lines in `DiffViewer` or `CodeViewer` | `path`, `from`, `to` |
| `apply_table_filter` | Filter the visible `IssueTable` or `PrList` without refetching | `target`, `filters` |

### Writing good tool descriptions

- Say when to use the tool, not only what it does ("Use for health report or overview requests").
- Put safety rules in the description too ("ALWAYS call with dryRun=true first"), but enforce them in code. The prompt is a hint; `needsApproval()` is the guarantee.
- Keep inputs small and typed. Enums beat free text.

## 7. Component catalog

The agent can render only the 16 components below, and every props object is validated with Zod before it reaches Angular. Anything unknown or invalid renders `ErrorFallback`. Source: `catalog.ts`.

| Component | Group | Key props | Emits back to agent |
| --- | --- | --- | --- |
| `Grid` | Layout | `columns` (1–4), `children[]` | Children's events |
| `Section` | Layout | `title`, `children[]` | Children's events |
| `StatCard` | Data | `label`, `value`, `trend`, `tone` | None |
| `ActivityChart` | Data | `title`, `kind` (bar/line), `points[]` (max 52) | None |
| `PrCard` | Data | `number`, `title`, `author`, `state`, `ci`, `reviewers`, `ageDays`, `additions`, `deletions` | `open` |
| `PrList` | Data | `items: PrCard[]`, `emptyText` | `open`, `filter` |
| `IssueTable` | Data | `rows[]`, `selectable` | `select`, `filter` |
| `CommitTimeline` | Data | `commits[]` (40-char SHA) | `open` |
| `ContributorList` | Data | `items[]` (max 10) | None |
| `DiffViewer` | Data | `files[]` (unified `patch`), `inlineComments[]` | `comment-edit`, `comment-remove` |
| `CodeViewer` | Data | `path`, `language`, `content` | None |
| `ApprovalCard` | Agentic | `toolCallId`, `title`, `risk`, `summary`, `items[]`, `reversible`, `undoHint` | `approve`, `reject`, `select` |
| `FormSurface` | Agentic | `formId`, `title`, `fields[]`, `submitTool` | `field-change`, `submit` |
| `ReleaseNotesEditor` | Agentic | `tag`, `sections[]` | `entry-change`, `submit` |
| `StepTimeline` | Agentic | `steps[]` (pending/running/done/error) | None |
| `ErrorFallback` | Safety | `message`, `raw` | `retry` |

To do: `tools.ts` also refers to `RepoList` and `WorkflowRunList`. Add both to `catalog.ts` and the renderer registry, or render those results with `IssueTable`-style generic tables.

### The contract

1. The agent emits a node: `{ "component": "PrCard", "props": { … } }`.
2. `validateNode()` checks the name against the catalog, then parses props with that component's schema.
3. Valid → the registered Angular component renders with typed `props`. Invalid → `ErrorFallback` with the reason; the raw payload is shown as text, never as HTML.
4. `catalogPromptDoc` is injected into the system prompt so the model knows the allowed names and the rule that every write goes through `ApprovalCard`.

### Example payload: repo health report

```json
{
  "component": "Grid",
  "props": {
    "columns": 2,
    "children": [
      { "component": "StatCard", "props": { "label": "Open PRs", "value": 7, "tone": "neutral" } },
      { "component": "StatCard", "props": { "label": "Stale PRs", "value": 3, "tone": "warning" } },
      { "component": "ActivityChart", "props": { "title": "Commits per week", "kind": "bar", "points": [{ "label": "W1", "value": 12 }] } },
      { "component": "IssueTable", "props": { "rows": [], "selectable": false } }
    ]
  }
}
```

### Rules for adding a component

- Write the Zod schema first, then the Angular component with a single `props` input and an `emit` callback.
- Register it in both `catalog` and `REGISTRY`; the `Record<ComponentName, Type>` type makes a missing registration a compile error.
- Cap array sizes in the schema (`.max()`) so a runaway model cannot render 10,000 rows.

## 8. Angular frontend design

The frontend is three things: a session service that holds the conversation as signals, a renderer that turns validated nodes into components, and the catalog components themselves.

### Folder structure

```text
src/app/
  core/
    agent-session.service.ts   // SSE stream, signals state, sendAction()
    client-tools.service.ts    // navigate_to, highlight_lines, apply_table_filter
    audit-log.service.ts
    auth.service.ts
  genui/
    catalog.ts                 // shared with server (Zod schemas)
    genui-host.component.ts    // validate + render one node
    components/                // one standalone component per catalog entry
      stat-card.component.ts
      pr-list.component.ts
      approval-card.component.ts
      ...
  features/
    chat/                      // prompt box, message list, StepTimeline slot
    dashboard/
    pull-request/              // route target for navigate_to
    issues/
    audit/
  shared/
    ui/                        // buttons, badges, avatar, design tokens
```

Put `catalog.ts` and `tools.ts` in a shared workspace package (Nx, or an npm workspace) so the client and server import the same file.

### Session state with signals

```ts
@Injectable({ providedIn: 'root' })
export class AgentSessionService {
  readonly messages = signal<ChatMessage[]>([]);
  readonly surfaces = signal<Map<string, UiNode>>(new Map()); // id → latest node
  readonly steps = signal<Step[]>([]);
  readonly pendingApproval = signal<ApprovalRequest | null>(null);
  readonly status = signal<'idle' | 'streaming' | 'awaiting-approval' | 'error'>('idle');

  readonly isBusy = computed(() => this.status() !== 'idle');

  send(prompt: string) { /* HttpAgent.runAgent(): POST /api/agent, events stream back */ }
  decide(toolCallId: string, decision: 'approve' | 'reject') { /* runAgent({ resume: [...] }) */ }
}
```

- Each AG-UI event updates one signal; components read signals and never subscribe manually.
- `surfaces` is keyed by surface id, so the agent can update a component in place ("only show bugs") instead of appending a new one.
- `status` drives the UI: the prompt box disables while `awaiting-approval`, so the user resolves the pending card first.

### Renderer

Rendering is A2UI. `A2uiSurfaceView` (`<app-a2ui-surface>`) feeds a surface's A2UI messages to its own `A2uiRendererService`. The catalog is a standard A2UI catalog document generated from the shared Zod catalog, so A2UI validates every component and binding. Every entry renders through `A2uiNode`, which resolves the `{"@path"}` bindings, runs `validateNode()` on the result, and renders the matching component with `props` and an `emit` callback. `emit` dispatches an A2UI action. `Grid` and `Section` render their children as A2UI child references, so any layout the agent composes still uses only allowed components. Invalid data, or messages A2UI refuses, render `ErrorFallback` in place.

### Catalog component conventions

- Standalone, `ChangeDetectionStrategy.OnPush`, signal inputs: `props = input.required<StatCardProps>()`.
- No HTTP calls inside catalog components. Data comes from the agent; actions go out through `emit`.
- Every interactive component is keyboard accessible, with visible focus and ARIA labels. `ApprovalCard` focuses its primary button when it appears.
- Skeleton states while a node streams in, so the layout does not jump.

### Client tools

The browser declares its tools (`navigate_to`, `highlight_lines`, `apply_table_filter`) as AG-UI frontend tools in `RunAgentInput.tools`. The server validates each call, streams it as `TOOL_CALL_*` events and tells the model it was applied. The browser checks the arguments with the same schema and applies them with the Router or a component API. A table filter becomes an A2UI `updateDataModel` on the table's rows.

## 9. Backend agent loop

The server runs a standard tool-calling loop with one extra rule: any non-read tool call stops the loop, saves the run, and waits for the user's decision before continuing.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/agent` | AG-UI: one run per request (a prompt, a side question, or a `resume` answering an approval interrupt); the response is the run's event stream (SSE, or protobuf on request) |
| GET | `/api/agent/capabilities` | AG-UI capability discovery |
| GET | `/api/a2ui/catalog` | The A2UI catalog document |
| GET | `/audit` | Audit log entries for the signed-in user |
| POST | `/audit/:id/undo` | Run the inverse action for a reversible entry |

### Loop, step by step

1. Build the prompt: system prompt + `catalogPromptDoc` + tool definitions + conversation history.
2. Call the model. Stream text tokens out as `TEXT_MESSAGE` events.
3. For each tool call, validate its input with the tool's Zod schema. Invalid input goes back to the model as an error result.
4. If the tool is `read`: run it with Octokit, emit a `STEP` event, return the result to the model.
5. If the tool is `write` or `destructive`:
   1. For destructive tools, run it first with `dryRun: true` to get the exact effect.
   2. Stream the approval surface (A2UI), persist the run state, and end the run with an AG-UI interrupt.
6. When a run's `resume` entry answers the interrupt with `approve`, reload the run, apply the user's edits or deselections to the tool input, execute it, write an audit entry, and resume the loop from step 2.
7. On `reject`, return "user rejected" as the tool result so the model can explain or offer an alternative.
8. The model's final answer usually includes UI nodes (`{ component, props }`), validated server-side before they are streamed.

### Core loop sketch

```ts
async function runLoop(run: Run, emit: Emit) {
  while (true) {
    const reply = await llm.generate({ messages: run.messages, tools: allTools });
    if (!reply.toolCalls.length) return emit.done(reply);

    for (const call of reply.toolCalls) {
      const tool = getTool(call.name);
      const input = tool.input.parse(call.args);

      if (needsApproval(tool.name)) {
        const preview = tool.risk === 'destructive'
          ? await execute(tool, { ...input, dryRun: true })
          : input;
        emit.ui(approvalCard(call.id, tool, preview));
        await saveRun({ ...run, status: 'awaiting-approval', pending: call });
        return; // resume on POST /actions
      }

      emit.step(`Running ${tool.name}`);
      run.messages.push(toolResult(call.id, await execute(tool, input)));
    }
  }
}
```

### Audit log entry

| Field | Example |
| --- | --- |
| `id` | `aud_0192` |
| `tool` | `bulk_update_issues` |
| `input` | `{ issueNumbers: [12, 15], action: "close" }` |
| `approvedBy` | GitHub login of the user |
| `result` | GitHub response summary |
| `inverse` | `{ tool: "bulk_update_issues", input: { action: "reopen", … } }` or `null` |
| `createdAt` | ISO timestamp |

The `inverse` field powers Undo. Merges are undone through `revert_via_pr`, never by rewriting history.

## 9b. Sessions and chat history

Every conversation is a saved session: its messages and every component the agent rendered are stored in Postgres, so a session reopens instantly, a pending approval survives a reload, and each audit entry links back to the session that made it. The Ask chat can do everything; the side nav pages are shortcuts to the same components.

### What is stored

| Table | Key columns | Purpose |
| --- | --- | --- |
| `sessions` | `id`, `userId`, `repo`, `title`, `status`, `createdAt`, `updatedAt` | One row per conversation; `status` is `active`, `awaiting-approval` or `done` |
| `messages` | `id`, `sessionId`, `role`, `text`, `createdAt` | User prompts and agent text |
| `ui_surfaces` | `id`, `sessionId`, `messageId`, `surfaceId`, `node` (jsonb), `version` | Validated UI nodes; an update in place adds a new version |
| `runs` | `id`, `sessionId`, `status`, `pendingToolCall` (jsonb) | Paused agent runs waiting for approval |
| `audit_entries` | existing fields + `sessionId` | Links every change to its session |

### Drizzle schema sketch

```ts
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  repo: text('repo').notNull(),
  title: text('title').notNull(),
  status: text('status', { enum: ['active', 'awaiting-approval', 'done'] }).notNull().default('active'),
  summary: text('summary'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const uiSurfaces = pgTable('ui_surfaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }).notNull(),
  messageId: uuid('message_id').notNull(),
  surfaceId: text('surface_id').notNull(),
  node: jsonb('node').notNull(),
  version: integer('version').notNull().default(1),
});
```

### How it works

1. **New session.** The first prompt creates a `sessions` row; the agent writes a short title ("PR #42 review").
2. **While streaming.** Each message and each validated UI node is saved as it is emitted.
3. **Reopen.** The History page lists sessions; opening one loads messages and the latest version of each surface and re-renders them. No model call is made.
4. **Resume.** A session with `awaiting-approval` shows its ApprovalCard again; approving resumes the saved run.
5. **Context for the model.** Only the last 6 turns plus the session `summary` are sent, so long sessions stay cheap. The summary is refreshed every few turns.
6. **Stale data.** A reopened surface shows a "Captured at 16:12" note and a Refresh button that re-runs the read tool.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/sessions?q=&status=` | History list with search and filters |
| GET | `/sessions/:id` | Messages and surfaces for one session |
| PATCH | `/sessions/:id` | Rename or archive |
| DELETE | `/sessions/:id` | Delete a session and its surfaces (audit entries are kept) |

### In Angular

- `SessionStore` holds `sessions`, `activeSessionId` and `activeSession` as signals; the History page and the side nav read from it.
- Opening a session replays its stored AG-UI events, so the A2UI surfaces render exactly as they did live.
- The route is `/s/:sessionId`, so a session can be bookmarked or shared within the team.

Interview point: because the UI is data, it can be stored, replayed and tested like any other data.

## 10. Security, auth, rate limits and errors

The safety model has three layers: the token never leaves the server, the model can only render allowlisted components, and nothing changes the repo without a human approval.

### Auth

- Sign in with GitHub OAuth. The server exchanges the code for a token and stores it in an encrypted, httpOnly session; the browser only ever holds a session cookie.
- Request the least privilege needed. A GitHub App with fine-grained repository permissions (Issues, Pull requests, Contents, Actions: read; write only where tools need it) is better than a classic token with broad `repo` scope.
- The agent works only on the repository the user picked in the app; a name the model makes up (or that repository content suggests) is refused in code.

### Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Model output injects script (XSS) | Catalog allowlist + Zod validation; no `innerHTML`; diffs and code rendered as text |
| Prompt injection from repo content (an issue body says "close all issues") | Repo content is passed as data; write tools always need user approval; approval card shows the exact effect |
| Model skips the approval step | Enforced in server code by `needsApproval()`, not by the prompt |
| Runaway bulk action | `max(100)` on bulk inputs; dry-run preview; per-item deselection |
| Token leakage | Token server-side only; never logged; never sent to the model |
| Cross-site request forgery on `/actions` | SameSite cookies + CSRF token; actions bound to the run's owner |

### Rate limits and performance

- Authenticated REST requests are limited per hour (about 5,000 for a user token). Show the remaining quota in a dev panel.
- Cache GET responses with ETags and send conditional requests; a `304 Not Modified` does not count against the limit.
- Prefer GraphQL for aggregate views like the health report.
- Paginate lists and cap rows in schemas; virtualise long diffs and tables in Angular with the CDK virtual scroll.

### Error handling

| Failure | What the user sees |
| --- | --- |
| Invalid UI node from model | `ErrorFallback` with a Retry action; error fed back to the model |
| Invalid tool input | Model receives the Zod error and retries once; then a plain message |
| GitHub 403 / rate limit | Message with reset time; cached data shown if available |
| GitHub 404 / no access | "Repo not found or not shared with RepoPilot" |
| Network drop mid-stream | SSE reconnects with `Last-Event-ID`; run state is server-side so nothing is lost |
| Approved action fails | `ApprovalCard` turns into an error state; no audit entry marked as success |

## 11. Testing strategy

The model is the one non-deterministic part, so tests replace it with a mock agent that replays recorded event streams. Everything else is tested like a normal app.

| Layer | What to test | Tool |
| --- | --- | --- |
| Schemas | Every catalog schema accepts a valid fixture and rejects known-bad ones (missing fields, oversized arrays, unknown component) | Vitest/Jest |
| `validateNode()` | Unknown names and bad props always produce `ErrorFallback`, never throw | Vitest/Jest |
| Approval gate | `needsApproval()` is true for every write and destructive tool; the loop never calls Octokit for them before approval | Vitest/Jest + mocked Octokit |
| Catalog components | Render from fixtures; emit the right events; keyboard and ARIA checks | Angular Testing Library + axe |
| Session service | Feeding a recorded AG-UI event sequence produces the expected signal states | Vitest/Jest |
| End to end | Prompt → mock agent stream → components render → approve → mocked GitHub receives the expected call | Playwright |
| Model quality (manual) | A fixed list of 20 prompts checked against the real model before each demo | Script + checklist |

### Fixtures to record

- One event stream per feature in the Features table, saved as JSON.
- A malformed stream (invalid props, unknown component, cut-off JSON) to prove the fallback path.
- A rejected-approval stream to prove nothing reaches GitHub.

## 12. Build plan

Four one-week phases, each ending in a gate you can check. Do not start the next phase until its gate passes; a working week-2 app is a better demo than a half-built week-4 one.

&#91;embedded content: Build plan · 4 phases, 4 gates\]

Week 1 and week 2 already give a showable Generative UI demo; week 3 adds the agentic patterns that make it stand out.

### Stretch goals (after week 4)

- Swap the custom renderer for the A2UI Angular renderer and compare the two in a blog post.
- Use the official GitHub MCP server as the tool source instead of hand-written tools.
- Voice input for prompts.
- Publish the catalog and renderer as an npm package for other Angular apps.

## 13. Interview demo script and talking points

A 3-minute live demo shows three patterns; the talking points show the engineering judgement behind them. Always keep a recorded video as a backup in case the network or model fails.

### 3-minute demo

1. **(0:00–0:30) Setup.** "RepoPilot lets you manage GitHub in plain English. The agent answers with real Angular components, not text."
2. **(0:30–1:15) Declarative GenUI.** Type "Give me a health report of this repo". The step timeline runs, then a dashboard appears. Follow up with "only show bugs" and the table filters in place.
3. **(1:15–2:15) Human-in-the-loop.** Type "Close all wontfix issues older than 90 days". The approval card lists 12 issues; deselect one, approve, then open the audit log and click Undo.
4. **(2:15–3:00) Shared state + frontend tools.** Type "Review PR #42". Inline comments appear on the diff. Edit one comment, then ask "take me to the auth changes" and the app scrolls and highlights the lines.

### Questions to expect, and short answers

| Question | Answer |
| --- | --- |
| Why not let the model output HTML? | XSS risk, broken design system, untestable. A validated catalog is safe like data, consistent like our components. |
| How do you stop the agent doing something harmful? | Risk tiers enforced in code, dry-run previews, approval with deselection, audit log with undo. |
| How do you handle partial or broken JSON while streaming? | Skeletons while streaming; validate only complete nodes; invalid ones render `ErrorFallback` and the error goes back to the model. |
| Who owns the state, agent or UI? | The server owns the run; the UI mirrors it in signals; user edits are sent as actions and become the new truth. |
| How does this scale to many components? | Catalog is data-driven; adding one = schema + component + registry entry, checked at compile time. |
| Rate limits and cost? | ETag caching, GraphQL for aggregates, fast model for the demo, local model option. |
| How do you test something non-deterministic? | Mock agent replaying recorded event streams; the model is checked with a fixed prompt list. |
| Why A2UI or AG-UI? | Open standards: the same agent could drive a Flutter or React client; the transport is swappable. |

### Show the code, briefly

Have three files open in the editor: `catalog.ts` (the contract), `genui-host.component.ts` (signals + dynamic rendering), and the `needsApproval` check in the agent loop. Thirty seconds on each is enough.

### Link it to your experience

Mention the AI features you built in production for a hotel management system. RepoPilot shows the patterns; your job experience shows you have shipped AI to real users.
