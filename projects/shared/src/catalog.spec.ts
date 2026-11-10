import { catalog, CatalogEntry, componentNames, validateNode } from './catalog';
import { buildCatalogPromptDoc } from './prompt';
import {
  fixtures,
  healthReport,
  invalidProps,
  issuePicker,
  partiallyBroken,
  unknownComponent,
} from './fixtures';

describe('validateNode', () => {
  it('accepts every valid fixture', () => {
    for (const node of [healthReport, issuePicker, partiallyBroken]) {
      expect(validateNode(node)).toMatchObject({ ok: true });
    }
  });

  it('applies schema defaults', () => {
    const result = validateNode({ component: 'StatCard', props: { label: 'PRs', value: 1 } });
    expect(result).toMatchObject({ ok: true, props: { tone: 'neutral' } });
  });

  it('strips unknown props instead of passing them to the component', () => {
    const result = validateNode({
      component: 'StatCard',
      props: { label: 'PRs', value: 1, onclick: 'alert(1)' },
    });
    expect(result.ok && 'onclick' in result.props).toBe(false);
  });

  it('rejects unknown components and keeps the payload as text', () => {
    const result = validateNode(unknownComponent);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Unknown component "ScriptInjector"');
      expect(result.raw).toContain('onerror');
    }
  });

  it('does not treat prototype keys as components', () => {
    for (const component of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(validateNode({ component, props: {} }).ok).toBe(false);
    }
  });

  it('rejects invalid props with a readable reason', () => {
    const result = validateNode(invalidProps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/StatCard[\s\S]*tone/);
  });

  it('rejects things that are not nodes', () => {
    for (const input of [null, 42, 'StatCard', [], { props: {} }, { component: '' }]) {
      expect(validateNode(input).ok).toBe(false);
    }
  });

  it('caps array sizes so a runaway model cannot flood the UI', () => {
    const points = Array.from({ length: 53 }, (_, i) => ({ label: `W${i}`, value: i }));
    expect(validateNode({ component: 'ActivityChart', props: { title: 't', points } }).ok).toBe(false);
  });

  it('only allows GitHub avatar URLs over https', () => {
    const node = (avatarUrl: string) => ({
      component: 'ContributorList',
      props: { items: [{ login: 'octocat', commits: 1, avatarUrl }] },
    });
    expect(validateNode(node('https://avatars.githubusercontent.com/u/583231')).ok).toBe(true);
    expect(validateNode(node('https://evil.example/track.gif')).ok).toBe(false);
    expect(validateNode(node('http://avatars.githubusercontent.com/u/1')).ok).toBe(false);
  });

  it('accepts PR branch names but not whitespace or control characters', () => {
    const pr = (branch: string) => ({ component: 'PrCard', props: { number: 1, title: 't', state: 'open', ageDays: 0, branch } });
    expect(validateNode(pr('feature/login-rate-limit')).ok).toBe(true);
    expect(validateNode(pr('fix the bug')).ok).toBe(false);
    expect(validateNode(pr('a\nb')).ok).toBe(false);
  });

  it('defaults issue assignees to none and only accepts GitHub logins', () => {
    const table = (row: object) => ({
      component: 'IssueTable',
      props: { rows: [{ number: 1, title: 't', state: 'open', ageDays: 0, ...row }] },
    });
    expect(validateNode(table({}))).toMatchObject({ ok: true, props: { rows: [{ assignees: [] }] } });
    expect(validateNode(table({ assignees: ['octocat'] })).ok).toBe(true);
    expect(validateNode(table({ assignees: ['<script>'] })).ok).toBe(false);
  });

  it('truncates huge raw payloads', () => {
    const result = validateNode({ component: 'Nope', props: { blob: 'x'.repeat(10_000) } });
    expect(!result.ok && result.raw.length).toBeLessThan(4100);
  });

  it('never throws on circular input', () => {
    const circular: Record<string, unknown> = { component: 'Nope' };
    circular['props'] = circular;
    expect(() => validateNode(circular)).not.toThrow();
  });
});

describe('fixtures', () => {
  it('have unique ids', () => {
    const ids = fixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('buildCatalogPromptDoc', () => {
  const doc = buildCatalogPromptDoc();

  const isInternal = (n: (typeof componentNames)[number]) => Boolean((catalog[n] as CatalogEntry).internal);

  it('lists every component the agent may emit', () => {
    for (const name of componentNames.filter((n) => !isInternal(n))) {
      expect(doc).toContain(`### ${name}`);
    }
  });

  it('does not offer app-only components to the model (ErrorFallback, StepTimeline, ApprovalCard)', () => {
    expect(componentNames.filter(isInternal)).toEqual(['ApprovalCard', 'StepTimeline', 'ErrorFallback']);
    for (const name of componentNames.filter(isInternal)) expect(doc).not.toContain(`### ${name}`);
  });

  it('includes JSON Schema for props', () => {
    expect(doc).toContain('"maxItems":52');
  });
});
