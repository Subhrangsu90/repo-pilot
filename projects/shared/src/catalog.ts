/**
 * The component catalog: the contract between the agent and the UI.
 *
 * The agent may only render components listed here, and every props object is
 * parsed with that component's Zod schema before it reaches Angular. The same
 * file is imported by the agent server (to validate before streaming and to
 * build the system prompt) and by the Angular app (to validate again before
 * rendering).
 *
 * Adding a component: write its schema here, add it to `catalog`, then register
 * an Angular component in `projects/web/src/app/genui/registry.ts`. That registry is
 * typed `Record<ComponentName, ...>`, so forgetting the second step is a
 * compile error.
 */
import * as z from 'zod';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/**
 * One node as the agent emits it. Props stay `unknown` here: each node is
 * validated against its own component schema, and children are validated by
 * the nested host that renders them. A single bad child therefore shows an
 * error in its own slot instead of breaking the whole layout.
 */
export const UiNodeSchema = z.object({
  component: z.string().min(1).max(64),
  props: z.unknown(),
});
export type UiNode = z.infer<typeof UiNodeSchema>;

const children = z.array(UiNodeSchema).max(24);
const tone = z.enum(['neutral', 'good', 'warning', 'danger']);
// GitHub logins, plus app accounts such as "dependabot[bot]".
const githubLogin = z.string().regex(/^[A-Za-z0-9-]{1,39}(\[bot\])?$/, 'Not a valid GitHub login');

// ---------------------------------------------------------------------------
// Props schemas (unknown keys are stripped, so harmless extra fields from the
// model do not fail validation, but they never reach a component either)
// ---------------------------------------------------------------------------

export const GridProps = z.object({
  columns: z.number().int().min(1).max(4).default(2),
  children,
});

export const SectionProps = z.object({
  title: z.string().min(1).max(80),
  description: z.string().max(240).optional(),
  children,
});

export const StatCardProps = z.object({
  label: z.string().min(1).max(40),
  value: z.union([z.number(), z.string().max(24)]),
  tone: tone.default('neutral'),
  trend: z
    .object({
      direction: z.enum(['up', 'down', 'flat']),
      text: z.string().max(40),
    })
    .optional(),
  hint: z.string().max(80).optional(),
});

export const ActivityChartProps = z.object({
  title: z.string().min(1).max(80),
  kind: z.enum(['bar', 'line']).default('bar'),
  points: z
    .array(
      z.object({
        label: z.string().max(12),
        value: z.number().finite().nonnegative(),
      }),
    )
    .min(1)
    .max(52),
});

export const IssueRow = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1).max(256),
  state: z.enum(['open', 'closed']),
  labels: z.array(z.string().max(50)).max(10).default([]),
  author: githubLogin.optional(),
  // Shown in the table (design system: "labels, assignee and age").
  assignees: z.array(githubLogin).max(10).default([]),
  ageDays: z.number().int().nonnegative(),
});

export const IssueTableProps = z.object({
  title: z.string().max(80).optional(),
  rows: z.array(IssueRow).max(100),
  selectable: z.boolean().default(false),
  emptyText: z.string().max(80).default('No issues match.'),
});

export const ContributorListProps = z.object({
  title: z.string().max(80).default('Top contributors'),
  items: z
    .array(
      z.object({
        login: githubLogin,
        commits: z.number().int().nonnegative(),
        // Only GitHub's avatar CDN over https: the model cannot make the
        // browser load arbitrary URLs.
        avatarUrl: z
          .url({ protocol: /^https$/, hostname: /^avatars\.githubusercontent\.com$/ })
          .optional(),
      }),
    )
    .max(10),
});

export const ErrorFallbackProps = z.object({
  message: z.string().max(500),
  raw: z.string().max(4000).optional(),
});

export const PrCardProps = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1).max(256),
  author: githubLogin.optional(),
  // Head branch, shown as text. No whitespace or control characters.
  branch: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\s\x00-\x1f\x7f]+$/, 'Not a valid branch name')
    .optional(),
  state: z.enum(['open', 'draft', 'merged', 'closed']),
  ci: z.enum(['success', 'failure', 'pending', 'none']).default('none'),
  reviewers: z.array(githubLogin).max(10).default([]),
  labels: z.array(z.string().max(50)).max(10).default([]),
  ageDays: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  // Links only to github.com over https.
  url: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }).optional(),
});

export const PrListProps = z.object({
  title: z.string().max(80).optional(),
  items: z.array(PrCardProps).max(50),
  emptyText: z.string().max(80).default('No pull requests match.'),
});

export const StepTimelineProps = z.object({
  steps: z
    .array(
      z.object({
        id: z.string().max(64),
        label: z.string().max(120),
        status: z.enum(['pending', 'running', 'done', 'error']),
        detail: z.string().max(200).optional(),
      }),
    )
    .max(30),
});

/**
 * Human-in-the-loop: the preview of a write or destructive tool call. Built by
 * the server from a dry run, never by the model (the entry is internal and
 * render_ui refuses it). The same surface is re-sent with a new `status` as
 * the decision is carried out.
 */
export const ApprovalCardProps = z.object({
  toolCallId: z.string().min(1).max(100),
  tool: z.string().max(64),
  risk: z.enum(['write', 'destructive']),
  /** "close" + "issue" → title "Close 5 issues", button "Approve and close 5". */
  verb: z.string().min(1).max(24),
  noun: z.string().min(1).max(24),
  summary: z.string().max(400),
  /** The exact items the change applies to; the user may untick them. */
  items: z
    .array(
      z.object({
        id: z.number().int().positive(),
        title: z.string().max(256),
        meta: z.string().max(80).optional(),
      }),
    )
    .max(100)
    .default([]),
  /** Requested items the dry run found nothing to do for, with the reason. */
  skipped: z
    .array(z.object({ id: z.number().int().positive(), reason: z.string().max(80) }))
    .max(100)
    .default([]),
  effect: z.object({ from: z.string().max(40), to: z.string().max(40) }).optional(),
  details: z
    .array(z.object({ label: z.string().max(40), value: z.string().max(200), mono: z.boolean().default(false) }))
    .max(8)
    .default([]),
  /** One API request per selected item: shown as a live count ("5 PATCH requests"). */
  requestMethod: z.enum(['POST', 'PATCH', 'PUT', 'DELETE']).optional(),
  reversible: z.boolean(),
  undoHint: z.string().max(200).optional(),
  status: z.enum(['pending', 'running', 'approved', 'rejected', 'failed']).default('pending'),
  /** After a decision: the ids the user approved. */
  selected: z.array(z.number().int().positive()).max(100).optional(),
  /** After a decision: one line on what happened. */
  result: z.string().max(400).optional(),
});

/** One row of a unified diff. `new` is the line number in the changed file (what review comments point at). */
export const DiffLine = z.object({
  kind: z.enum(['hunk', 'add', 'del', 'ctx']),
  old: z.number().int().positive().optional(),
  new: z.number().int().positive().optional(),
  text: z.string().max(500),
});

export const ReviewComment = z.object({
  id: z.number().int().positive(),
  line: z.number().int().positive(),
  severity: z.enum(['issue', 'suggestion']),
  body: z.string().min(1).max(1000),
});

/** One file's diff, built by the server from the real patch (never typed by the model). */
export const DiffViewerProps = z.object({
  path: z.string().min(1).max(300),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  lines: z.array(DiffLine).max(400),
  comments: z.array(ReviewComment).max(20).default([]),
});

export const ReviewEvent = z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);

/**
 * An agent-drafted pull request review. Like ApprovalCard it is built by the
 * server from a dry run, and nothing reaches GitHub until the user submits.
 * The user may edit or remove comments, rewrite the summary and pick the verdict.
 */
export const PrReviewProps = z.object({
  toolCallId: z.string().min(1).max(100),
  tool: z.string().max(64),
  risk: z.enum(['write', 'destructive']),
  pr: z.object({
    number: z.number().int().positive(),
    title: z.string().min(1).max(256),
    url: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }),
    state: z.enum(['open', 'draft', 'merged', 'closed']),
    author: githubLogin.optional(),
    branch: z.string().max(255),
    base: z.string().max(255),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changedFiles: z.number().int().nonnegative(),
    checks: z.object({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).optional(),
  }),
  files: z
    .array(z.object({ path: z.string().max(300), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() }))
    .max(100),
  /** Files that carry comments first, then other changed files, up to 5. */
  diffs: z.array(DiffViewerProps).max(5),
  comments: z.array(ReviewComment.extend({ path: z.string().max(300) })).max(20),
  /** Comments the dry run dropped, e.g. a line that is not in the diff. */
  skipped: z.array(z.object({ id: z.number().int().positive(), reason: z.string().max(120) })).max(20).default([]),
  summary: z.string().max(2000),
  event: ReviewEvent,
  /** GitHub refuses Approve / Request changes on your own pull request. */
  allowedEvents: z.array(ReviewEvent).min(1).max(3),
  eventNote: z.string().max(200).optional(),
  /**
   * Set by the server when the PR description reads like a prompt injection: the
   * flagged sentence (untrusted text, shown as text). Never from the model.
   */
  injectionWarning: z.string().max(200).optional(),
  status: z.enum(['pending', 'running', 'approved', 'rejected', 'failed']).default('pending'),
  /** After a decision: the comment ids that were posted. */
  selected: z.array(z.number().int().positive()).max(20).optional(),
  result: z.string().max(400).optional(),
  reviewUrl: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }).optional(),
});

/** What the user changed in a PrReview before submitting (sent with the approval). */
export const PrReviewEdits = z.object({
  event: ReviewEvent,
  summary: z.string().trim().min(1).max(2000),
  comments: z.array(z.object({ id: z.number().int().positive(), body: z.string().trim().min(1).max(1000) })).max(20),
});
export type PrReviewEdits = z.infer<typeof PrReviewEdits>;

/** Release tags look like v1.2.0 or 1.2.0-rc.1. */
export const releaseTag = z
  .string()
  .regex(/^v?\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,20})?$/, 'Use a version tag such as v1.2.0');

const ReleaseEntry = z.object({
  text: z.string().trim().min(1).max(200),
  /** A merged pull request in this release. */
  pr: z.number().int().positive().optional(),
});
const ReleaseSections = z.object({
  features: z.array(ReleaseEntry).max(30).default([]),
  fixes: z.array(ReleaseEntry).max(30).default([]),
  breaking: z.array(ReleaseEntry).max(30).default([]),
});

/**
 * An agent-drafted release (design system FormSurface + the Screen Spec's live
 * preview). Shared state: the user edits any field; nothing is published until
 * they review and publish.
 */
export const ReleaseFormProps = z.object({
  toolCallId: z.string().min(1).max(100),
  tool: z.string().max(64),
  risk: z.enum(['write', 'destructive']),
  repo: z.string().max(140),
  /** Branch the new tag points at. */
  target: z.string().max(255),
  previousTag: z.string().max(60).optional(),
  stats: z.object({
    commits: z.number().int().nonnegative(),
    pullRequests: z.number().int().nonnegative(),
    contributors: z.number().int().nonnegative(),
  }),
  /** Merged PRs in the release, for linking entries. */
  pulls: z.array(z.object({ number: z.number().int().positive(), title: z.string().max(256) })).max(100),
  tag: releaseTag,
  name: z.string().trim().min(1).max(120),
  prerelease: z.boolean().default(false),
  sections: ReleaseSections,
  /** Entries the dry run changed, e.g. a PR link that is not part of this release. */
  notes: z.array(z.string().max(160)).max(20).default([]),
  status: z.enum(['pending', 'running', 'approved', 'rejected', 'failed']).default('pending'),
  selected: z.array(z.number().int().positive()).max(1).optional(),
  result: z.string().max(400).optional(),
  releaseUrl: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }).optional(),
});

/** What the user changed in a ReleaseForm before publishing. */
export const ReleaseEdits = z.object({
  tag: releaseTag,
  name: z.string().trim().min(1).max(120),
  prerelease: z.boolean(),
  sections: ReleaseSections,
});
export type ReleaseEdits = z.infer<typeof ReleaseEdits>;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type CatalogGroup = 'layout' | 'data' | 'agentic' | 'safety';

export interface CatalogEntry {
  group: CatalogGroup;
  /** Told to the model: when to use this component. */
  description: string;
  props: z.ZodType;
  /** Rendered by the client only; never offered to the model. */
  internal?: boolean;
  /** Events the component can send back to the agent. */
  events: readonly string[];
}

export const catalog = {
  Grid: {
    group: 'layout',
    description: 'Lays out child nodes in 1-4 equal columns. Use for dashboards and reports.',
    props: GridProps,
    events: [],
  },
  Section: {
    group: 'layout',
    description: 'A titled group of child nodes stacked vertically.',
    props: SectionProps,
    events: [],
  },
  StatCard: {
    group: 'data',
    description: 'One headline number with a label, optional trend and tone.',
    props: StatCardProps,
    events: [],
  },
  ActivityChart: {
    group: 'data',
    description: 'A bar or line chart of up to 52 labelled values, e.g. commits per week.',
    props: ActivityChartProps,
    events: [],
  },
  IssueTable: {
    group: 'data',
    description: 'A table of issues. Set selectable=true when the user must pick issues.',
    props: IssueTableProps,
    events: ['select'],
  },
  ContributorList: {
    group: 'data',
    description: 'Up to 10 contributors with commit counts.',
    props: ContributorListProps,
    events: [],
  },
  PrCard: {
    group: 'data',
    description: 'One pull request with state, CI status, reviewers, age and size.',
    props: PrCardProps,
    events: ['open'],
  },
  PrList: {
    group: 'data',
    description: 'A list of pull requests (PrCard props in items).',
    props: PrListProps,
    events: ['open'],
  },
  ApprovalCard: {
    group: 'agentic',
    description: 'Dry-run preview of a change, with approve / reject. Built by the server only.',
    internal: true,
    props: ApprovalCardProps,
    events: ['approve', 'reject', 'edit'],
  },
  DiffViewer: {
    group: 'data',
    description: 'A unified diff of one file with inline review comments. Built by the server from the real patch only.',
    internal: true,
    props: DiffViewerProps,
    events: ['comment-edit', 'comment-remove'],
  },
  PrReview: {
    group: 'agentic',
    description: 'An agent-drafted pull request review the user edits and submits. Built by the server only.',
    internal: true,
    props: PrReviewProps,
    events: ['approve', 'reject'],
  },
  ReleaseForm: {
    group: 'agentic',
    description: 'An agent-drafted release the user edits, previews and publishes. Built by the server only.',
    internal: true,
    props: ReleaseFormProps,
    events: ['approve', 'reject', 'rewrite'],
  },
  StepTimeline: {
    group: 'agentic',
    description: 'Progress of a multi-step task, rendered by the client from run events.',
    internal: true,
    props: StepTimelineProps,
    events: [],
  },
  ErrorFallback: {
    group: 'safety',
    description: 'Shown by the client when a node is invalid.',
    internal: true,
    props: ErrorFallbackProps,
    events: ['retry'],
  },
} as const satisfies Record<string, CatalogEntry>;

export type Catalog = typeof catalog;
export type ComponentName = keyof Catalog;
/** Props a component receives after validation (defaults applied). */
export type PropsOf<N extends ComponentName> = z.output<Catalog[N]['props']>;

export const componentNames = Object.keys(catalog) as ComponentName[];

/** Own-property check, so names like "constructor" or "__proto__" never match. */
export function isComponentName(name: string): name is ComponentName {
  return Object.hasOwn(catalog, name);
}

/**
 * The first client- or server-only component (ApprovalCard, StepTimeline,
 * ErrorFallback) anywhere in a node tree, including nested children. Used to
 * stop the model from composing them itself, e.g. a fake approval card.
 */
export function findInternalComponent(node: unknown, depth = 0): ComponentName | null {
  if (depth > 8 || !node || typeof node !== 'object') return null;
  const { component, props } = node as { component?: unknown; props?: unknown };
  if (typeof component === 'string' && isComponentName(component) && (catalog[component] as CatalogEntry).internal) {
    return component;
  }
  const children = (props as { children?: unknown } | null)?.children;
  if (!Array.isArray(children)) return null;
  for (const child of children) {
    const found = findInternalComponent(child, depth + 1);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidNode = {
  [N in ComponentName]: { ok: true; component: N; props: PropsOf<N> };
}[ComponentName];

export interface InvalidNode {
  ok: false;
  error: string;
  /** The offending payload as JSON text. Render it as text, never as HTML. */
  raw: string;
}

export type ValidationResult = ValidNode | InvalidNode;

const RAW_LIMIT = 4000;

/** Validate one untrusted node. Never throws. */
export function validateNode(input: unknown): ValidationResult {
  const shape = UiNodeSchema.safeParse(input);
  if (!shape.success) {
    return invalid('Not a UI node: expected { "component": string, "props": object }.', input);
  }

  const { component, props } = shape.data;
  if (!isComponentName(component)) {
    return invalid(`Unknown component "${component.slice(0, 64)}". It is not in the catalog.`, input);
  }

  const parsed = catalog[component].props.safeParse(props);
  if (!parsed.success) {
    return invalid(`Invalid props for ${component}:\n${z.prettifyError(parsed.error)}`, input);
  }

  return { ok: true, component, props: parsed.data } as ValidNode;
}

function invalid(error: string, input: unknown): InvalidNode {
  return { ok: false, error: error.slice(0, 500), raw: toRaw(input) };
}

function toRaw(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    text = String(input);
  }
  return text.length > RAW_LIMIT ? `${text.slice(0, RAW_LIMIT)}\n… (truncated)` : text;
}

