/**
 * A2UI v1.0: how RepoPilot's component catalog travels to the browser.
 *
 * The agent server turns every validated UI node tree into A2UI messages
 * (createSurface → updateComponents → updateDataModel). Components carry the
 * structure, each data prop is a `{ "@path" }` binding into the surface's data
 * model, and children are referenced by id. Later changes to a surface (an
 * approval card's status, a table the agent filtered) are `updateDataModel`
 * messages, not a new tree. The browser renders the messages with
 * `@a2ui/angular` against the catalog document below.
 *
 * The messages are carried over AG-UI the way the AG-UI A2UI middleware does:
 * an ACTIVITY_SNAPSHOT of type `a2ui-surface` whose content holds the
 * operations, then ACTIVITY_DELTA patches that append operations.
 *
 * Nothing here depends on an A2UI package: the server stays free of them, and
 * the shapes are checked by `@a2ui/web_core` in the browser and by tests.
 */
import * as z from 'zod';
import { catalog, componentNames, type ComponentName, type UiNode, validateNode } from './catalog';

export const A2UI_VERSION = '1.0' as const;
/** Our catalog's id (A2UI asks for a prefix you control; this one never resolves to a URL). */
export const REPOPILOT_CATALOG_ID = 'repopilot:catalog/v1';
/** AG-UI activity type and content key used by the AG-UI A2UI middleware. */
export const A2UI_ACTIVITY_TYPE = 'a2ui-surface';
export const A2UI_OPERATIONS_KEY = 'a2ui_operations';
/** The id of a surface's top component, as the protocol requires. */
export const ROOT_ID = 'root';

// ---------------------------------------------------------------------------
// Message shapes (the subset of agent_to_renderer.json RepoPilot sends)
// ---------------------------------------------------------------------------

export interface A2uiBinding {
  '@path': string;
}

export interface A2uiComponent {
  id: string;
  component: string;
  [prop: string]: unknown;
}

export type A2uiMessage =
  | { version: typeof A2UI_VERSION; createSurface: { surfaceId: string; catalogId: string; sendDataModel?: boolean } }
  | { version: typeof A2UI_VERSION; updateComponents: { surfaceId: string; components: A2uiComponent[] } }
  | { version: typeof A2UI_VERSION; updateDataModel: { surfaceId: string; path?: string; value: unknown } }
  | { version: typeof A2UI_VERSION; deleteSurface: { surfaceId: string } };

/** AG-UI activity content for one surface. */
export interface A2uiActivityContent {
  [A2UI_OPERATIONS_KEY]: A2uiMessage[];
}

/** AG-UI activity message id of a surface. */
export const activityIdOf = (surfaceId: string) => `a2ui-surface-${surfaceId}`;

/** Surfaces are capped like props arrays: a model cannot make the browser build huge trees. */
const MAX_COMPONENTS = 200;

// ---------------------------------------------------------------------------
// Node tree → A2UI messages
// ---------------------------------------------------------------------------

/**
 * The full message list for one surface. Every node is validated here (each
 * node on its own, so one bad child becomes an ErrorFallback in its slot and
 * its siblings still render). Props keep the defaults the schema applied.
 */
export function surfaceMessages(surfaceId: string, node: unknown): A2uiMessage[] {
  const components: A2uiComponent[] = [];
  const data: Record<string, unknown> = {};
  let truncated = false;

  const put = (id: string, component: string, props: Record<string, unknown>): A2uiComponent => {
    const entry: A2uiComponent = { id, component };
    components.push(entry);
    for (const key of Object.keys(props)) {
      if (props[key] === undefined) delete props[key];
      else entry[key] = bind(id, key);
    }
    data[id] = props;
    return entry;
  };

  /** Adds a node and its children; null once the surface is full (the rest is dropped). */
  const add = (input: unknown, id: string): string | null => {
    if (components.length >= MAX_COMPONENTS) {
      truncated = true;
      return null;
    }
    const check = validateNode(input);
    const component = check.ok ? check.component : 'ErrorFallback';
    const props: Record<string, unknown> = check.ok ? { ...(check.props as Record<string, unknown>) } : { message: check.error, raw: check.raw };
    const children = isContainer(component) ? (props['children'] as UiNode[]) : undefined;
    delete props['children'];
    const entry = put(id, component, props);
    if (children) entry['children'] = children.map((child, i) => add(child, `${id}_${i}`)).filter((c): c is string => c !== null);
    return id;
  };

  add(node, ROOT_ID);
  if (truncated) {
    // One note at the end of the top-level layout instead of the parts that did not fit.
    const root = components[0];
    put('root_more', 'ErrorFallback', { message: 'This view has too many parts; only the first ones are shown.' });
    if (Array.isArray(root['children'])) (root['children'] as string[]).push('root_more');
  }
  return [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: REPOPILOT_CATALOG_ID } },
    { version: A2UI_VERSION, updateComponents: { surfaceId, components } },
    { version: A2UI_VERSION, updateDataModel: { surfaceId, path: '/', value: data } },
  ];
}

/** Replaces the props of one component (data only; the structure is unchanged). */
export function propsUpdate(surfaceId: string, componentId: string, props: Record<string, unknown>): A2uiMessage {
  const { children: _children, ...data } = props;
  return { version: A2UI_VERSION, updateDataModel: { surfaceId, path: `/${componentId}`, value: data } };
}

/** Replaces one prop of one component, e.g. a filtered table's rows. */
export function propUpdate(surfaceId: string, componentId: string, prop: string, value: unknown): A2uiMessage {
  return { version: A2UI_VERSION, updateDataModel: { surfaceId, path: `/${componentId}/${prop}`, value } };
}

const bind = (id: string, key: string): A2uiBinding => ({ '@path': `/${id}/${key}` });

/** Catalog components that hold child nodes (`children` in their props). */
export function isContainer(name: string): boolean {
  return name === 'Grid' || name === 'Section';
}

// ---------------------------------------------------------------------------
// Reading a message list (server: follow-ups, titles, replays; web: filters)
// ---------------------------------------------------------------------------

export interface SurfaceView {
  surfaceId: string;
  components: A2uiComponent[];
  /** The data model after every updateDataModel in order. */
  data: Record<string, unknown>;
}

/** Folds a surface's messages into its components and current data model. Never throws. */
export function readSurface(messages: readonly A2uiMessage[]): SurfaceView {
  let surfaceId = '';
  const byId = new Map<string, A2uiComponent>();
  let data: Record<string, unknown> = {};
  for (const m of messages) {
    if ('createSurface' in m) {
      surfaceId = m.createSurface.surfaceId;
      byId.clear();
      data = {};
    } else if ('updateComponents' in m) {
      for (const c of m.updateComponents.components) byId.set(c.id, c);
    } else if ('updateDataModel' in m) {
      data = setPointer(data, m.updateDataModel.path ?? '/', m.updateDataModel.value);
    } else if ('deleteSurface' in m) {
      byId.clear();
      data = {};
    }
  }
  return { surfaceId, components: [...byId.values()], data };
}

/** The props of one component with bindings resolved (what the browser renders). */
export function propsOf(view: SurfaceView, componentId: string): Record<string, unknown> {
  const own = view.data[componentId];
  return own && typeof own === 'object' ? { ...(own as Record<string, unknown>) } : {};
}

/** The root component's name, e.g. "ApprovalCard". */
export function rootComponent(view: SurfaceView): string | undefined {
  return view.components.find((c) => c.id === ROOT_ID)?.component;
}

/** Rebuilds the node tree (for the model's tool results, refresh and tests). */
export function toNode(view: SurfaceView, id = ROOT_ID, depth = 0): UiNode | null {
  const entry = view.components.find((c) => c.id === id);
  if (!entry || depth > 8) return null;
  const props = propsOf(view, id);
  if (Array.isArray(entry['children'])) {
    props['children'] = (entry['children'] as string[]).map((child) => toNode(view, child, depth + 1)).filter(Boolean);
  }
  return { component: entry.component, props };
}

function setPointer(root: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('/').filter(Boolean).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.length === 0) return value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value as Record<string, unknown>) : {};
  const next = structuredClone(root);
  let at: Record<string, unknown> = next;
  for (const part of parts.slice(0, -1)) {
    if (!at[part] || typeof at[part] !== 'object') at[part] = {};
    at = at[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (value === null) delete at[last];
  else at[last] = structuredClone(value);
  return next;
}

// ---------------------------------------------------------------------------
// The catalog document (A2UI catalog_definition, protocol 1.0)
// ---------------------------------------------------------------------------

const COMMON = 'common_types.json#/$defs';

/**
 * The A2UI catalog document for RepoPilot's components, built from the Zod
 * catalog so there is one source of truth. Every data prop also accepts a
 * `{ "@path" }` binding; `children` is a ChildList of component ids.
 * Internal components (approval surfaces, diffs) are in the document because
 * the server renders them; the model is still refused them by `render_ui`.
 */
export function catalogDocument(): Record<string, unknown> {
  const components: Record<string, unknown> = {};
  for (const name of componentNames) components[name] = componentDefinition(name);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://a2ui.org/specification/v1_0/catalogs/repopilot/catalog.json',
    protocolVersion: A2UI_VERSION,
    catalogId: REPOPILOT_CATALOG_ID,
    title: 'RepoPilot catalog',
    description: 'GitHub dashboards, tables, diffs and approval surfaces rendered by the RepoPilot agent.',
    components,
  };
}

function componentDefinition(name: ComponentName): Record<string, unknown> {
  const entry = catalog[name];
  const json = z.toJSONSchema(entry.props, { io: 'input', unrepresentable: 'any' }) as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const properties: Record<string, unknown> = { component: { const: name } };
  for (const [key, schema] of Object.entries(json.properties ?? {})) {
    properties[key] =
      key === 'children' && isContainer(name)
        ? { $ref: `${COMMON}/ChildList`, description: 'Child component ids.' }
        : { anyOf: [stripMeta(schema), { $ref: `${COMMON}/DataBinding` }] };
  }
  return {
    type: 'object',
    description: entry.description,
    properties,
    required: ['component', ...(json.required ?? [])],
  };
}

/** Drops JSON Schema keys a component definition must not carry. */
function stripMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, ...rest } = schema;
  return rest;
}
