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
const githubLogin = z.string().regex(/^[A-Za-z0-9-]{1,39}$/, 'Not a valid GitHub login');

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

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type CatalogGroup = 'layout' | 'data' | 'agentic' | 'safety';

export interface CatalogEntry {
  group: CatalogGroup;
  /** Told to the model: when to use this component. */
  description: string;
  props: z.ZodType;
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
  ErrorFallback: {
    group: 'safety',
    description: 'Shown by the client when a node is invalid. Do not emit it yourself.',
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

